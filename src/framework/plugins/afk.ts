import { jidNormalizedUser } from '@whiskeysockets/baileys'
import type { CoreMessage, Plugin, WhatsAppPort, WhatsAppSendOptions } from '../contracts.js'
import type {
  AfkEndSummary,
  AfkLeaderboardEntry,
  AfkMentionRecord,
  AfkRecord,
} from '../../services/afk-service.js'
import { GroupConfigurationService } from '../../services/group-configuration-service.js'
import { AfkService } from '../../services/afk-service.js'

const DEFAULT_REASON = 'Tidak ada alasan.'

function userLabel(jid: string): string {
  const user = jid.split('@')[0]?.split(':')[0] ?? jid
  return `@${user}`
}

function durationText(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  const parts: string[] = []
  if (days) parts.push(`${days} hari`)
  if (hours || days) parts.push(`${hours} jam`)
  parts.push(`${minutes} menit`, `${seconds} detik`)
  return parts.join(' ')
}

function mentionOptions(jids: readonly string[]): WhatsAppSendOptions | undefined {
  const mentions = [...new Set(jids.map((jid) => jidNormalizedUser(jid)))]
  return mentions.length > 0 ? { mentions } : undefined
}

function relativeTime(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (minutes < 1) return 'baru saja'
  if (minutes < 60) return `${minutes} menit lalu`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} jam lalu`
  return `${Math.floor(hours / 24)} hari lalu`
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat('id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Jakarta',
  }).format(new Date(timestamp))
}

function messageSnippet(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > 500 ? `${normalized.slice(0, 497)}...` : normalized
}

function mentionSourceLines(mention: AfkMentionRecord): string[] {
  const lines = [
    `↳ *Grup* : ${mention.groupName || (mention.chatJid.endsWith('@g.us') ? mention.chatJid : 'Personal')}`,
  ]
  if (mention.messageText) lines.push(`↳ *Pesan* : ${messageSnippet(mention.messageText)}`)
  if (mention.quotedText) lines.push(`↳ *Reply* : ${messageSnippet(mention.quotedText)}`)
  return lines
}

function statusBlock(record: AfkRecord): string[] {
  return [
    '😴`𝐒𝘁𝗮𝘁𝘂𝘀 𝐀𝗙𝗞`',
    '▬▬▬▬▬▬▬',
    `↳ *Sejak* : ${formatDateTime(record.startedAt)}`,
    `↳ *Alasan* : ${record.reason}`,
    `↳ *Terakhir Online* : ${formatDateTime(record.lastSeenAt)}`,
    `↳ *Mention Terlewat* : ${record.searchCount}`,
    '┈┈┈┈┈┈┈┈┈┈┈┈',
  ]
}

function formatAfkEnabled(record: AfkRecord): string {
  return [
    '😴 ⑅【 𝐀𝗙𝗞 𝐀𝗸𝘁𝗶𝗳 】',
    '⏜ׄ꤮᷼⌒︵',
    `𖥻ׁׅ 🌙𓏳ᩙ :: ${userLabel(record.userJid)} sekarang AFK.`,
    `↳ *Alasan* : ${record.reason}`,
    '↳ Kirim pesan apa pun untuk kembali aktif secara otomatis.',
    '━━━━━━━━━━━━━━━━━━━━',
    '*© Allyssea Roleplay Community*',
  ].join('\n')
}

function formatMentionNotice(record: AfkRecord, now: number): string {
  return [
    '😴 ⑅【 𝐔𝘀𝗲𝗿 𝐀𝗙𝗞 】',
    '⏜ׄ꤮᷼⌒︵',
    `↳ ${userLabel(record.userJid)} sedang AFK ${relativeTime(record.startedAt, now)}.`,
    `↳ *Alasan* : ${record.reason}`,
    '↳ Mention kamu sudah diteruskan ke PC pengguna tersebut.',
    '━━━━━━━━━━━━━━━━━━━━',
    '*© Allyssea Roleplay Community*',
  ].join('\n')
}

function formatMentionForward(record: AfkRecord, seekerJid: string, mention: AfkMentionRecord): string {
  return [
    '🔔 ⑅【 𝐌𝗲𝗻𝘁𝗶𝗼𝗻 𝐒𝗮𝗮𝘁 𝐀𝗙𝗞 】',
    '⏜ׄ꤮᷼⌒︵',
    `↳ ${userLabel(seekerJid)} menyebutmu ketika kamu AFK.`,
    `↳ *Waktu* : ${formatDateTime(mention.mentionedAt)}`,
    ...mentionSourceLines(mention),
    `↳ *Alasan AFK* : ${record.reason}`,
    '━━━━━━━━━━━━━━━━━━━━',
    '*© Allyssea Roleplay Community*',
  ].join('\n')
}

function formatWelcomeBack(summary: AfkEndSummary): string {
  return [
    `Selamat datang kembali, ${userLabel(summary.record.userJid)}!`,
    `Kamu AFK selama ${durationText(summary.durationMs)} dan ada ${summary.mentions.length} mention yang terlewat.`,
  ].join('\n')
}

function formatLeaderboard(entries: readonly AfkLeaderboardEntry[], totalRecorded: number): string[] {
  const medals = ['🥇', '🥈', '🥉']
  const lines = [
    '`𝐋𝗲𝗮𝗱𝗲𝗿𝗯𝗼𝗮𝗿𝗱 𝐀𝗙𝗞`',
    '_Daftar sosok yang paling sering menghilang~_',
    '╌╌╌╌╌╌╌╌╌╌╌╌',
  ]

  if (entries.length === 0) {
    lines.push('Belum ada data AFK tercatat.')
  } else {
    for (const [index, entry] of entries.entries()) {
      lines.push(`${medals[index] ?? '🏅'} ${userLabel(entry.userJid)} — ${durationText(entry.totalDurationMs)}`)
    }
  }

  lines.push('', `- *Total AFK Tercatat* : ${totalRecorded} kali`)
  return lines
}

function formatActiveList(records: readonly AfkRecord[], now: number): string[] {
  const lines = [
    '😴 ⑅【 𝐋𝗶𝘀𝘁 𝐀𝗙𝗞 】',
    '⏜ׄ꤮᷼⌒︵',
    '- 𖥻ׁׅ 🌙𓏳ᩙ ::',
  ]

  if (records.length === 0) {
    lines.push('Belum ada yang sedang AFK.')
  } else {
    for (const [index, record] of records.entries()) {
      lines.push(`${index + 1}. ${userLabel(record.userJid)} — ${relativeTime(record.startedAt, now)}`)
    }
  }

  lines.push(`- *Total AFK* : ${records.length} orang`)
  return lines
}

function formatPrivateStatus(record: AfkRecord, mentions: readonly AfkMentionRecord[], now: number): string {
  const lines = statusBlock(record)
  lines.push('', '`𝐑𝗶𝘄𝗮𝘆𝗮𝘁 𝐌𝗲𝗻𝘁𝗶𝗼𝗻 𝐏𝗿𝗶𝗯𝗮𝗱𝗶`')

  if (mentions.length === 0) {
    lines.push('Belum ada yang mencari kamu saat AFK.')
  } else {
    for (const [index, mention] of mentions.slice(0, 10).entries()) {
      lines.push(`${index + 1}. ${userLabel(mention.seekerJid)} — ${relativeTime(mention.mentionedAt, now)}`)
    }
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━', '*© Allyssea Roleplay Community*')
  return lines.join('\n')
}

function isAfkCommand(message: CoreMessage, prefix: string, fallbackPrefix: string): boolean {
  const text = message.text?.trim().toLowerCase()
  if (!text) return false
  return text.startsWith(`${prefix}afk`) || (prefix !== fallbackPrefix && text.startsWith(`${fallbackPrefix}afk`))
}

export function createAfkPlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'afk',
    version: '0.1.0',
    dependencies: ['menu'],
    load(context) {
      const afk = context.services.get<AfkService>('afk')
      const groupConfiguration = context.services.get<GroupConfigurationService>('group-configuration')

      context.commands.register({
        name: 'afk',
        aliases: ['away'],
        description: 'Set status AFK or view your private AFK status',
        category: 'general',
        menuOrder: 2,
        cooldownMs: 3000,
        handler: async ({ args, message, reply }) => {
          const userJid = message.senderJid ? jidNormalizedUser(message.senderJid) : undefined
          if (!userJid) return

          const mode = args[0]?.toLowerCase()
          if (mode === 'list') {
            const now = Date.now()
            const activeRecords = afk.listActive()
            const leaderboard = afk.listLeaderboard()
            await reply([
              ...formatActiveList(activeRecords, now),
              '',
              ...formatLeaderboard(leaderboard, afk.totalRecorded()),
              '━━━━━━━━━━━━━━━━━━━━',
              '*© Allyssea Roleplay Community*',
            ].join('\n'), mentionOptions([
              ...activeRecords.map((record) => record.userJid),
              ...leaderboard.map((entry) => entry.userJid),
            ]))
            return
          }

          if (mode === 'top' || mode === 'leaderboard') {
            const leaderboard = afk.listLeaderboard()
            await reply([
              ...formatLeaderboard(leaderboard, afk.totalRecorded()),
              '━━━━━━━━━━━━━━━━━━━━',
              '*© Allyssea Roleplay Community*',
            ].join('\n'), mentionOptions(leaderboard.map((entry) => entry.userJid)))
            return
          }

          if (mode === 'status' || mode === 'me') {
            const record = afk.getActive(userJid)
            if (!record) {
              await whatsapp.sendText(userJid, 'Kamu tidak sedang AFK.')
              return
            }
            const mentions = afk.getMentions(userJid)
            await whatsapp.sendText(
              userJid,
              formatPrivateStatus(record, mentions, Date.now()),
              mentionOptions(mentions.map((mention) => mention.seekerJid)),
            )
            return
          }

          const reason = args.join(' ').trim() || DEFAULT_REASON
          const record = afk.start(userJid, reason, Date.now())
          await reply(formatAfkEnabled(record), mentionOptions([record.userJid]))
        },
      })

      context.events.on('message.received', async (message) => {
        if (message.fromMe || !message.senderJid) return
        const senderJid = jidNormalizedUser(message.senderJid)
        const now = message.timestamp || Date.now()
        const ownAfk = afk.getActive(senderJid)

        const prefix = message.remoteJid.endsWith('@g.us')
          ? groupConfiguration.resolvePrefix(message.remoteJid, context.config.commandPrefix)
          : context.config.commandPrefix

        if (ownAfk && !isAfkCommand(message, prefix, context.config.commandPrefix)) {
          const summary = afk.finish(senderJid, now)
          if (summary) {
            await whatsapp.sendText(
              message.remoteJid,
              formatWelcomeBack(summary),
              mentionOptions([summary.record.userJid]),
            )
          }
        } else {
          afk.touchPresence(senderJid, now)
        }

        const referencedJids = [
          ...(message.mentionedJids ?? []),
          ...(message.quotedSenderJid ? [message.quotedSenderJid] : []),
        ]
        const targets = [...new Set(referencedJids.map((jid) => jidNormalizedUser(jid)))]
          .filter((targetJid) => targetJid !== senderJid)
          .map((targetJid) => ({ targetJid, record: afk.getActive(targetJid) }))
          .filter((target): target is { targetJid: string; record: AfkRecord } => Boolean(target.record))

        await Promise.allSettled(targets.map(async ({ targetJid, record }) => {
          afk.recordMention(
            targetJid,
            senderJid,
            message.remoteJid,
            now,
            message.groupName,
            message.text,
            message.quotedText,
          )
          const mention = afk.getMentions(targetJid)[0]
          await whatsapp.sendText(
            message.remoteJid,
            formatMentionNotice(record, now),
            mentionOptions([targetJid]),
          )
          if (mention) {
            await whatsapp.sendText(
              targetJid,
              formatMentionForward(record, senderJid, mention),
              mentionOptions([senderJid]),
            )
          }
        }))
      })
    },
  }
}
