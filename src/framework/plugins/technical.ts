import type { CommandContext, Plugin } from '../contracts.js'
import { permissionNames } from '../../permissions.js'

function formatUptime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const remainingSeconds = totalSeconds % 60
  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours || days) parts.push(`${hours}h`)
  if (minutes || hours || days) parts.push(`${minutes}m`)
  parts.push(`${remainingSeconds}s`)
  return parts.join(' ')
}

function connectionStatus(context: CommandContext): string {
  return context.whatsapp.currentStatus ?? (context.whatsapp.isConnected ? 'connected' : 'idle')
}

function chatMode(context: CommandContext): 'private' | 'group' {
  return context.message.remoteJid.endsWith('@g.us') ? 'group' : 'private'
}

function formatLatency(context: CommandContext): number {
  const receivedAt = context.message.receivedAt ?? context.message.timestamp
  return Math.max(0, Date.now() - receivedAt)
}

function ownerProfileText(photoStatus: string): string {
  return [
    '👤 *Allybot Owner Profile*',
    '',
    '↳ Nama: Vallen',
    '↳ Status: Owner',
    '↳ Nomor HP: 083197859955',
    '↳ Control plane: protected',
    `↳ Foto profil: ${photoStatus}`,
    '',
    'Profile ini dipublikasikan sesuai otorisasi Owner. Credential, database, session, dan JID internal tetap tidak ditampilkan.',
  ].join('\n')
}

function profileText(context: CommandContext): string {
  return [
    '🤖 *Allybot Profile*',
    '',
    '↳ Name: Allybot',
    '↳ Role: WhatsApp automation assistant',
    `↳ Runtime: Node.js ${process.versions.node}`,
    `↳ Mode: ${chatMode(context)}`,
    `↳ Prefix: ${context.prefix}`,
    `↳ Connection: ${connectionStatus(context)}`,
    `↳ Uptime: ${formatUptime(process.uptime())}`,
    `↳ Native menu buttons: ${typeof context.whatsapp.sendNativeQuickReplies === 'function' ? 'available' : 'text fallback'}`,
    '',
    'Sensitive credentials, owner identity, database path, and session data are not exposed.',
  ].join('\n')
}

export const technicalPlugin: Plugin = {
  name: 'technical-commands',
  version: '0.1.0',
  load(context) {
    context.commands.register({
      name: 'ping',
      description: 'Check Allybot response latency and uptime',
      category: 'system',
      menuOrder: 1,
      cooldownMs: 3000,
      handler: async (commandContext) => {
        await commandContext.reply([
          '🏓 *Pong — Allybot aktif.*',
          '',
          `↳ Latency: ${formatLatency(commandContext)} ms`,
          `↳ Connection: ${connectionStatus(commandContext)}`,
          `↳ Uptime: ${formatUptime(process.uptime())}`,
        ].join('\n'))
      },
    })

    context.commands.register({
      name: 'owner',
      description: 'Show the safe public Owner profile and control-plane status',
      category: 'system',
      menuOrder: 5,
      cooldownMs: 3000,
      handler: async (commandContext) => {
        const ownerJid = commandContext.config.botOwnerJid
        const getProfilePictureUrl = commandContext.whatsapp.getProfilePictureUrl
        const sendImage = commandContext.whatsapp.sendImage
        if (ownerJid && getProfilePictureUrl && sendImage) {
          try {
            const imageUrl = await getProfilePictureUrl(ownerJid, 'image', 5_000)
            if (imageUrl) {
              await sendImage(commandContext.message.remoteJid, imageUrl, ownerProfileText('terlampir'))
              return
            }
          } catch (error) {
            commandContext.logger.debug({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'owner profile image delivery unavailable')
          }
        }
        await commandContext.reply(ownerProfileText('tidak tersedia; text fallback digunakan'))
      },
    })

    context.commands.register({
      name: 'botprofile',
      aliases: ['bprofile'],
      description: 'Show the safe public Allybot profile',
      category: 'system',
      menuOrder: 4,
      cooldownMs: 3000,
      handler: async (commandContext) => {
        await commandContext.reply(profileText(commandContext))
      },
    })

    context.commands.register({
      name: 'clearcache',
      aliases: ['cacheclear'],
      description: 'Clear ephemeral runtime caches without touching auth or databases',
      category: 'system',
      permission: permissionNames.botOwner,
      hidden: true,
      cooldownMs: 10_000,
      handler: async (commandContext) => {
        const result = commandContext.whatsapp.clearRuntimeCaches?.()
        if (!result) {
          await commandContext.reply('Runtime cache clear tidak tersedia pada adapter WhatsApp ini.')
          return
        }
        await commandContext.reply([
          '✅ *Runtime cache berhasil dibersihkan.*',
          '',
          `↳ Duplicate-message cache: ${result.duplicateMessages} entry`,
          `↳ Group-name cache: ${result.groupNames} entry`,
          `↳ Retry-counter cache: ${result.retryCounters} entry`,
          '↳ Auth/session/database: tidak disentuh',
        ].join('\n'))
      },
    })
  },
}
