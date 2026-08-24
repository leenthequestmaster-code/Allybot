import { jidNormalizedUser } from '@whiskeysockets/baileys'
import type {
  CoreGroupParticipantUpdate,
  Plugin,
  WhatsAppPort,
  WhatsAppSendOptions,
} from '../contracts.js'
import { GroupConfigurationService } from '../../services/group-configuration-service.js'

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
    .replaceAll('{{group}}', event.groupName ?? event.groupJid)
    .replaceAll('{{count}}', String(event.participantJids.length))
}

export function createWelcomeLeavePlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'welcome-leave',
    version: '0.2.0',
    dependencies: ['menu'],
    load(context) {
      const configuration = context.services.get<GroupConfigurationService>('group-configuration')
      context.events.on('group.participants.changed', async (event) => {
        if (event.action !== 'add' && event.action !== 'remove') return
        const custom = event.action === 'add'
          ? configuration.getWelcome(event.groupJid)
          : configuration.getLeave(event.groupJid)
        const text = custom
          ? formatCustomMessage(custom.text, event)
          : event.action === 'add'
            ? formatWelcome(event)
            : formatLeave(event)
        await whatsapp.sendText(event.groupJid, text, mentionOptions(event.participantJids))
      })
    },
  }
}
