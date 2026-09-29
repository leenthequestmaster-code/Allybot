import type { Plugin, WhatsAppPort } from '../contracts.js'
import { isSameJid, permissionNames } from '../../permissions.js'
import {
  SuggestionService,
  SUGGESTION_MIN_TEXT_LENGTH,
  SUGGESTION_MAX_TEXT_LENGTH,
} from '../../services/suggestion-service.js'
import { isGroupJid } from '../validation.js'

export interface SuggestPluginOptions {
  readonly jitterMs?: number
}

export function sanitizeSuggestionText(raw: string): string {
  return raw
    // Strip zero-width & invisible direction override characters
    .replace(/[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g, '')
    // Strip mention tags
    .replace(/@\d{5,16}/g, '')
    .replace(/@s\.whatsapp\.net/g, '')
    // Strip URLs & WhatsApp group invite links
    .replace(/https?:\/\/[^\s]+/gi, '')
    .replace(/chat\.whatsapp\.com\/[^\s]+/gi, '')
    .replace(/wa\.me\/[^\s]+/gi, '')
    // Normalize newlines and collapse redundant whitespace
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function createSuggestPlugin(
  whatsapp: WhatsAppPort,
  options: SuggestPluginOptions = {},
): Plugin {
  const jitterMs = options.jitterMs ?? 0

  return {
    name: 'suggest',

    initialize(context): void {
      const getService = (): SuggestionService =>
        context.services.get<SuggestionService>('suggestion')

      // ==========================================
      // COMMAND: suggest (alias: saran)
      // ==========================================
      context.commands.register({
        name: 'suggest',
        aliases: ['saran'],
        description: 'Kirim kritik atau saran secara anonim ke pengurus bot.',
        category: 'group',
        menuOrder: 15,
        handler: async (commandContext) => {
          const service = getService()
          const rawText = commandContext.args.join(' ')
          const sanitized = sanitizeSuggestionText(rawText)

          // 1. Length validation
          if (sanitized.length < SUGGESTION_MIN_TEXT_LENGTH) {
            await commandContext.reply([
              '𓏼 *Formulir Kotak Saran*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              'Sampaikan ide, kritik, atau saran perbaikan secara anonim.',
              '',
              '*Cara Pakai:*',
              `↳ \`${commandContext.prefix}suggest <isi saranmu>\``,
              `↳ Contoh: \`${commandContext.prefix}suggest Tambahkan fitur mini-game baru di bot.\``,
              '',
              '*Ketentuan:*',
              '⡇╌ Minimal 5 karakter, maksimal 1.000 karakter.',
              '⡇╌ Link dan tag mention otomatis dilucuti.',
              '⡇╌ Identitas pengirim 100% anonim dan terlindungi.',
            ].join('\n'))
            return
          }

          if (sanitized.length > SUGGESTION_MAX_TEXT_LENGTH) {
            await commandContext.reply('Teks saran terlalu panjang (maksimal 1.000 karakter).')
            return
          }

          // 2. Check box configuration
          const boxGroup = service.getBoxGroup(whatsapp.userJid)
          if (!boxGroup) {
            await commandContext.reply('Kotak saran belum diatur oleh Bot Owner.')
            return
          }

          // 3. Anonymity protection in groups
          const isGroup = isGroupJid(commandContext.message.remoteJid)
          if (isGroup) {
            let botIsAdmin = false
            try {
              const metadata = await whatsapp.getGroupMetadata(commandContext.message.remoteJid)
              const botMember = metadata.participants.find((p) => isSameJid(p.jid, whatsapp.userJid))
              botIsAdmin = botMember?.role === 'admin' || botMember?.role === 'superadmin'
            } catch (err) {
              commandContext.logger.warn({ err }, 'failed to check bot admin status in group for suggest')
            }

            if (!botIsAdmin) {
              await commandContext.reply([
                '⚠️ *Perhatian Privasi*',
                '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
                'Bot bukan admin di grup ini sehingga tidak dapat menghapus pesanmu secara otomatis.',
                'Demi menjaga kerahasiaan identitasmu, silakan kirimkan saran ini lewat *Chat Pribadi (PM)* bot!',
              ].join('\n'))
              return
            }

            // Bot is admin: auto-delete user command to prevent group members from seeing the suggestion
            try {
              await whatsapp.deleteMessage?.(commandContext.message.remoteJid, {
                id: commandContext.message.id,
                remoteJid: commandContext.message.remoteJid,
                participant: commandContext.message.senderJid,
              })
            } catch (delErr) {
              commandContext.logger.warn({ delErr }, 'failed to delete user suggest command in group')
            }
          }

          const senderJid = commandContext.message.senderJid ?? commandContext.message.remoteJid
          const token = service.generateToken(senderJid)

          // 4. Blacklist check
          if (service.isBlacklisted(token)) {
            await commandContext.reply('⛔ Tiket saran Anda telah diblokir dari sistem kotak saran.')
            return
          }

          // 5. Rate limit check (60s cooldown & 5 submissions / 24h)
          const limit = service.checkRateLimit(token)
          if (!limit.allowed) {
            await commandContext.reply(`⏳ ${limit.reason}`)
            return
          }

          // 6. Record suggestion in SQLite
          const record = service.recordSuggestion(token, sanitized, senderJid)

          // 7. Relay to Box Group
          const boxMessage = [
            '𓏼 *Kotak Saran Masuk*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `📩 *Saran #${record.id}* · Tiket: \`#${token}\``,
            '─͜──͜──͜─  · ✦ ·  ─͜──͜──͜─',
            sanitized,
            '━━━━━━━━━━━━━━━━━━━━',
            `_Balas saran ini: ${commandContext.prefix}replysaran #${token} <pesan>_`,
          ].join('\n')

          let sendSuccess = false
          try {
            if (jitterMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, jitterMs))
            }
            await whatsapp.sendText(boxGroup, boxMessage)
            sendSuccess = true
          } catch (err) {
            commandContext.logger.error({ err }, 'failed to send suggestion to box group')
          }

          service.updateSuggestionStatus(record.id, sendSuccess ? 'sent' : 'failed')

          // 8. Reply to sender (standalone, unquoted)
          if (sendSuccess) {
            await commandContext.reply([
              '✅ *Saranmu Berhasil Dikirim!*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              `Nomor Tiket: \`#${token}\``,
              'Saranmu telah diteruskan ke pengurus secara anonim. Terima kasih atas masukanmu!',
            ].join('\n'))
          } else {
            await commandContext.reply([
              '⚠️ *Kotak Saran Tidak Terjangkau*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              'Saranmu sudah dicatat ke sistem antrean, tapi bot gagal menjangkau grup kotak saran saat ini.',
              `Nomor Tiket: \`#${token}\``,
            ].join('\n'))
          }
        },
      })

      // ==========================================
      // COMMAND: setkotaksaran (alias: setsuggestionbox, setsaran)
      // ==========================================
      context.commands.register({
        name: 'setkotaksaran',
        aliases: ['setsuggestionbox', 'setsaran'],
        description: 'Atur grup ini sebagai kotak penampung saran (Owner).',
        category: 'moderation',
        permission: permissionNames.botOwner,
        menuOrder: 50,
        handler: async (commandContext) => {
          if (!isGroupJid(commandContext.message.remoteJid)) {
            await commandContext.reply('Perintah ini hanya bisa dijalankan di dalam grup yang ingin dijadikan kotak saran.')
            return
          }

          const service = getService()
          const botId = whatsapp.userJid ?? 'primary'
          service.setBoxGroup(botId, commandContext.message.remoteJid)

          await commandContext.reply([
            '𓏼 *Kotak Saran Dikonfigurasi*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            'Grup ini berhasil ditetapkan sebagai wadah penampung seluruh saran dan aspirasi masuk.',
          ].join('\n'))
        },
      })

      // ==========================================
      // COMMAND: replysaran (alias: balassaran)
      // ==========================================
      context.commands.register({
        name: 'replysaran',
        aliases: ['balassaran'],
        description: 'Balas saran masuk berdasarkan nomor tiket pengirim.',
        category: 'moderation',
        menuOrder: 51,
        handler: async (commandContext) => {
          const service = getService()
          const senderJid = commandContext.message.senderJid ?? commandContext.message.remoteJid
          const isOwner = Boolean(
            commandContext.config.botOwnerJid &&
            isSameJid(senderJid, commandContext.config.botOwnerJid),
          )

          const boxGroup = service.getBoxGroup(whatsapp.userJid)
          let isBoxAdmin = false

          if (boxGroup && isGroupJid(commandContext.message.remoteJid) && isSameJid(commandContext.message.remoteJid, boxGroup)) {
            try {
              const metadata = await whatsapp.getGroupMetadata(boxGroup)
              const caller = metadata.participants.find((p) => isSameJid(p.jid, senderJid))
              isBoxAdmin = caller?.role === 'admin' || caller?.role === 'superadmin'
            } catch (err) {
              commandContext.logger.warn({ err }, 'failed to verify box admin role for replysaran')
            }
          }

          if (!isOwner && !isBoxAdmin) {
            await commandContext.reply('Perintah ini hanya dapat digunakan oleh pengurus kotak saran atau Bot Owner.')
            return
          }

          const [rawToken, ...replyParts] = commandContext.args
          const token = rawToken?.replace(/^#/, '').trim().toUpperCase()
          const replyText = replyParts.join(' ').trim()

          if (!token || !replyText) {
            await commandContext.reply(`Format: ${commandContext.prefix}replysaran <#tiket> <pesan balasan>`)
            return
          }

          const targetJid = service.getReplyTarget(token)
          if (!targetJid) {
            await commandContext.reply(`Tiket saran \`#${token}\` tidak ditemukan atau masa aktifnya sudah kedaluwarsa (maks 30 hari).`)
            return
          }

          const responseText = [
            '𓏼 *Tanggapan Pengurus atas Saranmu*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `📩 *Tiket Saran*: \`#${token}\``,
            '─͜──͜──͜─  · ✦ ·  ─͜──͜──͜─',
            replyText,
            '━━━━━━━━━━━━━━━━━━━━',
            '*© Pengurus Allybot*',
          ].join('\n')

          try {
            await whatsapp.sendText(targetJid, responseText)
            await commandContext.reply(`✅ Tanggapan berhasil dikirimkan ke pengirim tiket \`#${token}\` secara pribadi.`)
          } catch (err) {
            commandContext.logger.error({ err }, 'failed to forward admin reply to suggestion author')
            await commandContext.reply(`⚠️ Gagal mengirimkan tanggapan ke pengirim tiket \`#${token}\`.`)
          }
        },
      })

      // ==========================================
      // COMMAND: blocksaran (alias: bloksaran)
      // ==========================================
      context.commands.register({
        name: 'blocksaran',
        aliases: ['bloksaran'],
        description: 'Blokir tiket saran pengirim yang menyalahgunakan kotak saran.',
        category: 'moderation',
        menuOrder: 52,
        handler: async (commandContext) => {
          const service = getService()
          const senderJid = commandContext.message.senderJid ?? commandContext.message.remoteJid
          const isOwner = Boolean(
            commandContext.config.botOwnerJid &&
            isSameJid(senderJid, commandContext.config.botOwnerJid),
          )

          const boxGroup = service.getBoxGroup(whatsapp.userJid)
          let isBoxAdmin = false

          if (boxGroup && isGroupJid(commandContext.message.remoteJid) && isSameJid(commandContext.message.remoteJid, boxGroup)) {
            try {
              const metadata = await whatsapp.getGroupMetadata(boxGroup)
              const caller = metadata.participants.find((p) => isSameJid(p.jid, senderJid))
              isBoxAdmin = caller?.role === 'admin' || caller?.role === 'superadmin'
            } catch (err) {
              commandContext.logger.warn({ err }, 'failed to verify box admin role for blocksaran')
            }
          }

          if (!isOwner && !isBoxAdmin) {
            await commandContext.reply('Perintah ini hanya dapat digunakan oleh pengurus kotak saran atau Bot Owner.')
            return
          }

          const [rawToken, ...reasonParts] = commandContext.args
          const token = rawToken?.replace(/^#/, '').trim().toUpperCase()
          const reason = reasonParts.join(' ').trim() || undefined

          if (!token) {
            await commandContext.reply(`Format: ${commandContext.prefix}blocksaran <#tiket> [alasan]`)
            return
          }

          service.blacklistToken(token, reason)
          await commandContext.reply(`⛔ Tiket \`#${token}\` berhasil diblokir dari sistem kotak saran.`)
        },
      })
    },
  }
}
