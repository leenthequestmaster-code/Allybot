import { jidNormalizedUser } from '@whiskeysockets/baileys'
import type {
  CoreGroupParticipantUpdate,
  Plugin,
  WhatsAppPort,
  WhatsAppSendOptions,
} from '../contracts.js'
import { GroupConfigurationService } from '../../services/group-configuration-service.js'
import { GroupContextService } from '../../services/group-context-service.js'

function userLabel(jid: string): string {
  const user = jidNormalizedUser(jid).split('@')[0]?.split(':')[0] ?? jid
  return `@${user}`
}

function mentionOptions(jids: readonly string[]): WhatsAppSendOptions | undefined {
  const mentions = [...new Set(jids.map((jid) => jidNormalizedUser(jid)))]
  return mentions.length > 0 ? { mentions } : undefined
}

function participantLines(jids: readonly string[]): string[] {
  return jids.map((jid) => `𖥻ׁׅ 🌸𓏳ᩙ :: ${userLabel(jid)}`)
}

function formatWelcome(event: CoreGroupParticipantUpdate): string {
  return [
    '🌸 ⑅【 𝐖𝗲𝗹𝗰𝗼𝗺𝗲 𝐭𝗼 𝐀𝗹𝗹𝘆𝗯𝗼𝘁 】',
    '⏜ׄ꤮᷼⌒︵',
    ...participantLines(event.participantJids),
    '',
    `↳ *Grup* : ${event.groupName ?? event.groupJid}`,
    '↳ Selamat datang di keluarga Allyssea Roleplay Community.',
    '↳ Jangan lupa membaca rules dan bersenang-senang bersama~',
    '━━━━━━━━━━━━━━━━━━━━',
    '*© Allyssea Roleplay Community*',
  ].join('\n')
}

function formatLeave(event: CoreGroupParticipantUpdate): string {
  return [
    '🍂 ⑅【 𝐆𝗼𝗼𝗱𝗯𝘆𝗲 𝐟𝗿𝗼𝗺 𝐀𝗹𝗹𝘆𝗯𝗼𝘁 】',
    '⏜ׄ꤮᷼⌒︵',
    ...participantLines(event.participantJids),
    '',
    `↳ *Grup* : ${event.groupName ?? event.groupJid}`,
    '↳ Terima kasih sudah menjadi bagian dari keluarga Allyssea.',
    '↳ Semoga perjalananmu berikutnya berjalan menyenangkan~',
    '━━━━━━━━━━━━━━━━━━━━',
    '*© Allyssea Roleplay Community*',
  ].join('\n')
}

function formatCustomMessage(template: string, event: CoreGroupParticipantUpdate): string {
  return template
    .replaceAll('{{user}}', event.participantJids.map(userLabel).join(', '))
    .replaceAll('{user}', event.participantJids.map(userLabel).join(', '))
    .replaceAll('{{group}}', event.groupName ?? event.groupJid)
    .replaceAll('{group}', event.groupName ?? event.groupJid)
    .replaceAll('{{count}}', String(event.participantJids.length))
    .replaceAll('{count}', String(event.participantJids.length))
}

class AsyncSemaphore {
  private active = 0
  private waiters: (() => void)[] = []
  constructor(private readonly maxConcurrent: number = 2) {}

  async acquire(timeoutMs = 8_000): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active++
      let released = false
      return () => {
        if (!released) {
          released = true
          this.active--
          const next = this.waiters.shift()
          if (next) next()
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          const idx = this.waiters.indexOf(onSlot)
          if (idx !== -1) this.waiters.splice(idx, 1)
          reject(new Error(`Render semaphore timeout (${timeoutMs}ms)`))
        }
      }, timeoutMs)
      const onSlot = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve()
        }
      }
      this.waiters.push(onSlot)
    })
    this.active++
    let released = false
    return () => {
      if (!released) {
        released = true
        this.active--
        const next = this.waiters.shift()
        if (next) next()
      }
    }
  }
}

const welcomeRenderSemaphore = new AsyncSemaphore(2)

export function createWelcomeLeavePlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'welcome-leave',
    version: '0.2.0',
    dependencies: ['menu', 'group-context'],
    load(context) {
      const configuration = context.services.get<GroupConfigurationService>('group-configuration')
      const groupContext = context.services.get<GroupContextService>('group-context')
      context.events.on('group.participants.changed', async (event) => {
        if (event.action !== 'add' && event.action !== 'remove') return

        // Jangan terpicu untuk bot sendiri saat join/leave
        if (whatsapp.userJid) {
          const botBare = jidNormalizedUser(whatsapp.userJid)
          if (event.participantJids.some((jid) => jidNormalizedUser(jid) === botBare)) return
        }

        // Cek toggle enable/disable dari GroupModerationSuiteService
        try {
          const suite = context.services.get<{ readonly name: string; isWelcomeEnabled(jid: string): boolean; isLeaveEnabled(jid: string): boolean }>('group-moderation-suite')
          if (suite) {
            if (event.action === 'add' && !suite.isWelcomeEnabled(event.groupJid)) return
            if (event.action === 'remove' && !suite.isLeaveEnabled(event.groupJid)) return
          }
        } catch {}

        if (groupContext.isEnabled && (await groupContext.get(event.groupJid)).mode !== 'ooc') return
        const custom = event.action === 'add'
          ? configuration.getWelcome(event.groupJid)
          : configuration.getLeave(event.groupJid)
        const text = custom
          ? formatCustomMessage(custom.text, event)
          : event.action === 'add'
            ? formatWelcome(event)
            : formatLeave(event)

        if (whatsapp.sendMedia) {
          try {
            const { VisualCardService } = await import('../../services/visual-card-service.js')
            let avatarBuffer: Buffer | undefined
            const firstJid = event.participantJids[0]
            if (firstJid && whatsapp.getProfilePictureUrl) {
              try {
                const url = await Promise.race([
                  whatsapp.getProfilePictureUrl(firstJid, 'image', 2000),
                  new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
                ])
                if (url) {
                  const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
                  if (res.ok) {
                    avatarBuffer = Buffer.from(await res.arrayBuffer())
                  }
                }
              } catch {
                avatarBuffer = undefined
              }
            }

            const primaryName = firstJid ? userLabel(firstJid) : (event.action === 'add' ? 'New Adventurer' : 'Adventurer')
            const releaseRender = await welcomeRenderSemaphore.acquire(8000)
            let cardBuffer: Buffer
            try {
              cardBuffer = await VisualCardService.renderWelcomeCard({
                type: event.action === 'add' ? 'welcome' : 'leave',
                userName: primaryName,
                groupName: event.groupName ?? 'Allyssea Roleplay Community',
                avatarBuffer,
              })
            } finally {
              releaseRender()
            }

            await whatsapp.sendMedia(event.groupJid, {
              kind: 'image',
              data: new Uint8Array(cardBuffer),
              mimeType: 'image/png',
              caption: text,
            })
            return
          } catch (renderError) {
            context.logger?.warn?.({ err: renderError }, 'welcome card render failed, falling back to text')
          }
        }

        await whatsapp.sendText(event.groupJid, text, mentionOptions(event.participantJids))
      })
    },
  }
}
