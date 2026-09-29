import type { Plugin, WhatsAppPort, CoreMessage } from '../contracts.js'
import { isSameJid, permissionNames } from '../../permissions.js'
import {
  SuggestionService,
  SUGGESTION_MIN_TEXT_LENGTH,
  SUGGESTION_MAX_TEXT_LENGTH,
} from '../../services/suggestion-service.js'
import { isGroupJid } from '../validation.js'
import type { GroupSafetyService } from '../../services/group-safety-service.js'

export interface SuggestPluginOptions {
  readonly jitterMs?: number
  readonly maxMediaBytes?: number
}

const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024 // 25 MB

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
  const maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES

  return {
    name: 'suggest',

    initialize(context): void {
      const getService = (): SuggestionService =>
        context.services.get<SuggestionService>('suggestion')

      // ==========================================
      // MULTI-EVIDENCE LISTENER (3-minute window)
      // ==========================================
      whatsapp.onMessage(async (message: CoreMessage) => {
        if (message.fromMe) return
        const hasMedia = Boolean(message.media || message.quotedMedia)
        if (!hasMedia) return

        const senderJid = message.senderJid ?? message.remoteJid
        const service = getService()
        const token = service.generateToken(senderJid)
        const window = service.getActiveEvidenceWindow(token)
        if (!window) return

        // If sent in a group, only accept if it's the same origin group
        if (isGroupJid(message.remoteJid) && window.originGroupJid && message.remoteJid !== window.originGroupJid) {
          return
        }

        // If in group, auto-delete to protect privacy
        if (isGroupJid(message.remoteJid)) {
          try {
            await whatsapp.deleteMessage?.(message.remoteJid, {
              id: message.id,
              remoteJid: message.remoteJid,
              participant: message.senderJid,
            })
          } catch {}
        }

        const boxGroup = service.getBoxGroup(window.type, whatsapp.userJid)
        if (!boxGroup) return

        const source = message.media ? 'direct' : 'quoted'
        try {
          const downloaded = await whatsapp.downloadMedia?.(message, source, {
            maxBytes: maxMediaBytes,
            timeoutMs: 30_000,
          })

          if (downloaded) {
            const caption = [
              '📎 *Lampiran Bukti Tambahan*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              `📩 *${window.type === 'report' ? 'Laporan' : 'Saran'} #${window.ticketId}* · Tiket: \`#${token}\``,
              ...(message.text ? ['─͜──͜──͜─  · ✦ ·  ─͜──͜──͜─', message.text] : []),
              '━━━━━━━━━━━━━━━━━━━━',
            ].join('\n')

            await whatsapp.sendMedia?.(boxGroup, {
              ...downloaded,
              caption,
            })

            // Feedback receipt to sender
            await whatsapp.sendText(message.remoteJid, `📎 *Bukti Tambahan Diterima* untuk Tiket \`#${token}\`.`)
          }
        } catch (err) {
          context.logger.warn({ err }, 'failed to relay multi-evidence attachment')
        } finally {
          whatsapp.deleteStoredMessage?.(message.remoteJid, message.id)
        }
      })

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
              '⡇╌ Dukung lampiran gambar/video (maks 25 MB).',
              '⡇╌ Identitas pengirim 100% anonim dan terlindungi.',
            ].join('\n'))
            return
          }

          if (sanitized.length > SUGGESTION_MAX_TEXT_LENGTH) {
            await commandContext.reply('Teks saran terlalu panjang (maksimal 1.000 karakter).')
            return
          }

          // 2. Check box configuration
          const boxGroup = service.getBoxGroup('suggest', whatsapp.userJid)
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

            // Bot is admin: auto-delete user command
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

          // 5. Rate limit check
          const limit = service.checkRateLimit('suggest', token)
          if (!limit.allowed) {
            await commandContext.reply(`⏳ ${limit.reason}`)
            return
          }

          // 6. Media download if available (direct or quoted)
          const hasDirect = Boolean(commandContext.message.media)
          const hasQuoted = Boolean(commandContext.message.quotedMedia)
          let downloadedMedia
          if (hasDirect || hasQuoted) {
            try {
              downloadedMedia = await whatsapp.downloadMedia?.(
                commandContext.message,
                hasDirect ? 'direct' : 'quoted',
                { maxBytes: maxMediaBytes, timeoutMs: 30_000 },
              )
            } catch (mediaErr) {
              commandContext.logger.warn({ mediaErr }, 'failed to download attached media for suggest')
            } finally {
              whatsapp.deleteStoredMessage?.(commandContext.message.remoteJid, commandContext.message.id)
            }
          }

          // 7. Record suggestion in SQLite
          const record = service.recordTicket('suggest', token, sanitized, senderJid, {
            hasMedia: Boolean(downloadedMedia),
            mediaKind: downloadedMedia?.kind,
          })

          // Open 3-minute multi-evidence window
          service.openEvidenceWindow(token, record.id, 'suggest', isGroup ? commandContext.message.remoteJid : undefined)

          // 8. Relay to Box Group
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
            if (downloadedMedia && whatsapp.sendMedia) {
              await whatsapp.sendMedia(boxGroup, {
                ...downloadedMedia,
                caption: boxMessage,
              })
            } else {
              await whatsapp.sendText(boxGroup, boxMessage)
            }
            sendSuccess = true
          } catch (err) {
            commandContext.logger.error({ err }, 'failed to send suggestion to box group')
          }

          service.updateTicketStatus(record.id, sendSuccess ? 'sent' : 'failed')

          // 9. Reply to sender
          if (sendSuccess) {
            await commandContext.reply([
              '✅ *Saranmu Berhasil Dikirim!*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              `Nomor Tiket: \`#${token}\``,
              'Saranmu telah diteruskan ke pengurus secara anonim. Terima kasih atas masukanmu!',
              '_(Kirim foto/video tambahan dalam 3 menit jika ingin melampirkan bukti pendukung)_',
            ].join('\n'))
          } else {
            await commandContext.reply([
              '⚠️ *Kotak Saran Tidak Terjangkau*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              'Saranmu sudah dicatat ke antrean, tapi bot gagal menjangkau grup kotak saran saat ini.',
              `Nomor Tiket: \`#${token}\``,
            ].join('\n'))
          }
        },
      })

      // ==========================================
      // COMMAND: report (alias: lapor)
      // ==========================================
      context.commands.register({
        name: 'report',
        aliases: ['lapor'],
        description: 'Laporkan pelanggaran ke pengurus secara aman dengan bukti.',
        category: 'group',
        menuOrder: 16,
        handler: async (commandContext) => {
          const service = getService()
          const rawText = commandContext.args.join(' ')
          const sanitized = sanitizeSuggestionText(rawText)

          // 1. Length validation
          if (sanitized.length < SUGGESTION_MIN_TEXT_LENGTH) {
            await commandContext.reply([
              '𓏼 *Formulir Laporan Pelanggaran*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              'Laporkan pelanggaran, pelecehan, atau penipuan secara aman.',
              '',
              '*Cara Pakai:*',
              `↳ \`${commandContext.prefix}report @member <alasan/kronologi>\``,
              `↳ Atau kirim/reply foto bukti dengan caption: \`${commandContext.prefix}report <kronologi>\``,
              '',
              '*Ketentuan:*',
              '⡇╌ Minimal 5 karakter, maksimal 1.000 karakter.',
              '⡇╌ Dukung lampiran foto, video, dan dokumen (maks 25 MB).',
              '⡇╌ Identitas pelapor dilindungi dengan nomor tiket rahasia.',
            ].join('\n'))
            return
          }

          if (sanitized.length > SUGGESTION_MAX_TEXT_LENGTH) {
            await commandContext.reply('Uraian laporan terlalu panjang (maksimal 1.000 karakter).')
            return
          }

          // 2. Check box configuration
          const boxGroup = service.getBoxGroup('report', whatsapp.userJid)
          if (!boxGroup) {
            await commandContext.reply('Kotak laporan belum diatur oleh Bot Owner.')
            return
          }

          // 3. Anonymity & group context
          const isGroup = isGroupJid(commandContext.message.remoteJid)
          let originGroupName = commandContext.message.groupName
          if (isGroup) {
            let botIsAdmin = false
            try {
              const metadata = await whatsapp.getGroupMetadata(commandContext.message.remoteJid)
              originGroupName = metadata.subject || originGroupName
              const botMember = metadata.participants.find((p) => isSameJid(p.jid, whatsapp.userJid))
              botIsAdmin = botMember?.role === 'admin' || botMember?.role === 'superadmin'
            } catch (err) {
              commandContext.logger.warn({ err }, 'failed to check bot admin status in group for report')
            }

            if (!botIsAdmin) {
              await commandContext.reply([
                '⚠️ *Perhatian Privasi*',
                '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
                'Bot bukan admin di grup ini sehingga tidak dapat menghapus pesanmu secara otomatis.',
                'Demi menjaga keselamatan dan privasimu, silakan kirimkan laporan ini lewat *Chat Pribadi (PM)* bot!',
              ].join('\n'))
              return
            }

            // Bot is admin: auto-delete user report command
            try {
              await whatsapp.deleteMessage?.(commandContext.message.remoteJid, {
                id: commandContext.message.id,
                remoteJid: commandContext.message.remoteJid,
                participant: commandContext.message.senderJid,
              })
            } catch (delErr) {
              commandContext.logger.warn({ delErr }, 'failed to delete user report command in group')
            }
          }

          const senderJid = commandContext.message.senderJid ?? commandContext.message.remoteJid
          const token = service.generateToken(senderJid)

          // 4. Blacklist check
          if (service.isBlacklisted(token)) {
            await commandContext.reply('⛔ Tiket laporan Anda telah diblokir dari sistem.')
            return
          }

          // 5. Rate limit check (separate bucket for report)
          const limit = service.checkRateLimit('report', token)
          if (!limit.allowed) {
            await commandContext.reply(`⏳ ${limit.reason}`)
            return
          }

          // Extract reported target JID if mentioned or replied
          const targetJid = commandContext.message.mentionedJids?.[0] ?? commandContext.message.quotedSenderJid

          // Register in group-safety service if available (so !cases in group lists it)
          const safetyService = commandContext.services.has('group-safety')
            ? commandContext.services.get<GroupSafetyService>('group-safety')
            : undefined
          if (safetyService && isGroup) {
            try {
              safetyService.reportCase(
                commandContext.message.remoteJid,
                senderJid,
                targetJid ?? senderJid,
                'member.report',
                sanitized,
                commandContext.message.id,
                commandContext.message.text ?? sanitized,
              )
            } catch {}
          }

          // 6. Media download if available (direct or quoted)
          const hasDirect = Boolean(commandContext.message.media)
          const hasQuoted = Boolean(commandContext.message.quotedMedia)
          let downloadedMedia
          if (hasDirect || hasQuoted) {
            try {
              downloadedMedia = await whatsapp.downloadMedia?.(
                commandContext.message,
                hasDirect ? 'direct' : 'quoted',
                { maxBytes: maxMediaBytes, timeoutMs: 30_000 },
              )
            } catch (mediaErr) {
              commandContext.logger.warn({ mediaErr }, 'failed to download attached media for report')
            } finally {
              whatsapp.deleteStoredMessage?.(commandContext.message.remoteJid, commandContext.message.id)
            }
          }

          // 7. Record ticket
          const record = service.recordTicket('report', token, sanitized, senderJid, {
            originGroupJid: isGroup ? commandContext.message.remoteJid : undefined,
            originGroupName: originGroupName ?? (isGroup ? 'Grup WhatsApp' : 'Chat Pribadi (PM)'),
            targetJid,
            hasMedia: Boolean(downloadedMedia),
            mediaKind: downloadedMedia?.kind,
          })

          // Open 3-minute multi-evidence window
          service.openEvidenceWindow(
            token,
            record.id,
            'report',
            isGroup ? commandContext.message.remoteJid : undefined,
            originGroupName,
          )

          // 8. Relay to Box Group
          const originLabel = originGroupName ?? (isGroup ? 'Grup WhatsApp' : 'Chat Pribadi (PM)')
          const targetDisplay = targetJid ? `@${targetJid.split('@')[0]}` : 'Tidak ditentukan'

          const boxMessage = [
            '𓏼 *Laporan Pelanggaran Masuk*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `🚨 *Laporan #${record.id}* · Tiket: \`#${token}\``,
            `⡇╌ *Asal*     : ${originLabel}`,
            `⡇╌ *Terlapor* : ${targetDisplay}`,
            '─͜──͜──͜─  · ✦ ·  ─͜──͜──͜─',
            sanitized,
            '━━━━━━━━━━━━━━━━━━━━',
            `_Balas laporan ini: ${commandContext.prefix}replyreport #${token} <pesan>_`,
          ].join('\n')

          let sendSuccess = false
          try {
            if (jitterMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, jitterMs))
            }
            if (downloadedMedia && whatsapp.sendMedia) {
              await whatsapp.sendMedia(boxGroup, {
                ...downloadedMedia,
                caption: boxMessage,
              })
            } else {
              await whatsapp.sendText(boxGroup, boxMessage)
            }
            sendSuccess = true
          } catch (err) {
            commandContext.logger.error({ err }, 'failed to send report to box group')
          }

          service.updateTicketStatus(record.id, sendSuccess ? 'sent' : 'failed')

          // 9. Reply to sender
          if (sendSuccess) {
            await commandContext.reply([
              '✅ *Laporan dibuat dan diteruskan ke pengurus secara rahasia.*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              `Nomor Tiket: \`#${token}\``,
              'Laporanmu telah masuk ke kotak investigasi pengurus.',
              '_(Kirim foto/video tambahan dalam 3 menit jika ingin melampirkan bukti pendukung)_',
            ].join('\n'))
          } else {
            await commandContext.reply([
              '⚠️ *Kotak Laporan Tidak Terjangkau*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              'Laporanmu sudah dicatat ke antrean, tapi bot gagal menjangkau grup investigasi saat ini.',
              `Nomor Tiket: \`#${token}\``,
            ].join('\n'))
          }
        },
      })

      // ==========================================
      // COMMAND: setkotaksaran
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
          service.setBoxGroup('suggest', botId, commandContext.message.remoteJid)

          await commandContext.reply([
            '𓏼 *Kotak Saran Dikonfigurasi*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            'Grup ini berhasil ditetapkan sebagai wadah penampung seluruh saran dan aspirasi masuk.',
          ].join('\n'))
        },
      })

      // ==========================================
      // COMMAND: setreportbox
      // ==========================================
      context.commands.register({
        name: 'setreportbox',
        aliases: ['setkotaklapor'],
        description: 'Atur grup ini sebagai kotak penampung laporan pelanggaran (Owner).',
        category: 'moderation',
        permission: permissionNames.botOwner,
        menuOrder: 51,
        handler: async (commandContext) => {
          if (!isGroupJid(commandContext.message.remoteJid)) {
            await commandContext.reply('Perintah ini hanya bisa dijalankan di dalam grup yang ingin dijadikan kotak laporan.')
            return
          }

          const service = getService()
          const botId = whatsapp.userJid ?? 'primary'
          service.setBoxGroup('report', botId, commandContext.message.remoteJid)

          await commandContext.reply([
            '𓏼 *Kotak Laporan Dikonfigurasi*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            'Grup ini berhasil ditetapkan sebagai wadah penampung seluruh laporan pelanggaran member.',
          ].join('\n'))
        },
      })

      // ==========================================
      // COMMAND: replysaran & replyreport
      // ==========================================
      const createReplyHandler = (type: 'suggest' | 'report') => async (commandContext: any) => {
        const service = getService()
        const senderJid = commandContext.message.senderJid ?? commandContext.message.remoteJid
        const isOwner = Boolean(
          commandContext.config.botOwnerJid &&
          isSameJid(senderJid, commandContext.config.botOwnerJid),
        )

        const boxGroup = service.getBoxGroup(type, whatsapp.userJid)
        let isBoxAdmin = false

        if (boxGroup && isGroupJid(commandContext.message.remoteJid) && isSameJid(commandContext.message.remoteJid, boxGroup)) {
          try {
            const metadata = await whatsapp.getGroupMetadata(boxGroup)
            const caller = metadata.participants.find((p) => isSameJid(p.jid, senderJid))
            isBoxAdmin = caller?.role === 'admin' || caller?.role === 'superadmin'
          } catch (err) {
            commandContext.logger.warn({ err }, 'failed to verify box admin role for reply')
          }
        }

        if (!isOwner && !isBoxAdmin) {
          await commandContext.reply('Perintah ini hanya dapat digunakan oleh pengurus kotak atau Bot Owner.')
          return
        }

        const [rawToken, ...replyParts] = commandContext.args
        const token = rawToken?.replace(/^#/, '').trim().toUpperCase()
        const replyText = replyParts.join(' ').trim()

        if (!token || !replyText) {
          await commandContext.reply(`Format: ${commandContext.prefix}reply${type} <#tiket> <pesan balasan>`)
          return
        }

        const targetJid = service.getReplyTarget(token)
        if (!targetJid) {
          await commandContext.reply(`Tiket \`#${token}\` tidak ditemukan atau masa aktifnya sudah kedaluwarsa (maks 30 hari).`)
          return
        }

        const responseText = [
          `𓏼 *Tanggapan Pengurus atas ${type === 'report' ? 'Laporan' : 'Saran'}mu*`,
          '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
          `📩 *Tiket*: \`#${token}\``,
          '─͜──͜──͜─  · ✦ ·  ─͜──͜──͜─',
          replyText,
          '━━━━━━━━━━━━━━━━━━━━',
          '*© Pengurus Allybot*',
        ].join('\n')

        try {
          await whatsapp.sendText(targetJid, responseText)
          await commandContext.reply(`✅ Tanggapan berhasil dikirimkan ke pengirim tiket \`#${token}\` secara pribadi.`)
        } catch (err) {
          commandContext.logger.error({ err }, 'failed to forward reply to ticket author')
          await commandContext.reply(`⚠️ Gagal mengirimkan tanggapan ke pengirim tiket \`#${token}\`.`)
        }
      }

      context.commands.register({
        name: 'replysaran',
        aliases: ['balassaran'],
        description: 'Balas saran masuk berdasarkan nomor tiket pengirim.',
        category: 'moderation',
        menuOrder: 52,
        handler: createReplyHandler('suggest'),
      })

      context.commands.register({
        name: 'replyreport',
        aliases: ['balaslapor'],
        description: 'Balas laporan masuk berdasarkan nomor tiket pelapor.',
        category: 'moderation',
        menuOrder: 53,
        handler: createReplyHandler('report'),
      })

      // ==========================================
      // COMMAND: blocksaran & blockreport
      // ==========================================
      const createBlockHandler = (type: 'suggest' | 'report') => async (commandContext: any) => {
        const service = getService()
        const senderJid = commandContext.message.senderJid ?? commandContext.message.remoteJid
        const isOwner = Boolean(
          commandContext.config.botOwnerJid &&
          isSameJid(senderJid, commandContext.config.botOwnerJid),
        )

        const boxGroup = service.getBoxGroup(type, whatsapp.userJid)
        let isBoxAdmin = false

        if (boxGroup && isGroupJid(commandContext.message.remoteJid) && isSameJid(commandContext.message.remoteJid, boxGroup)) {
          try {
            const metadata = await whatsapp.getGroupMetadata(boxGroup)
            const caller = metadata.participants.find((p) => isSameJid(p.jid, senderJid))
            isBoxAdmin = caller?.role === 'admin' || caller?.role === 'superadmin'
          } catch (err) {
            commandContext.logger.warn({ err }, 'failed to verify box admin role for block')
          }
        }

        if (!isOwner && !isBoxAdmin) {
          await commandContext.reply('Perintah ini hanya dapat digunakan oleh pengurus kotak atau Bot Owner.')
          return
        }

        const [rawToken, ...reasonParts] = commandContext.args
        const token = rawToken?.replace(/^#/, '').trim().toUpperCase()
        const reason = reasonParts.join(' ').trim() || undefined

        if (!token) {
          await commandContext.reply(`Format: ${commandContext.prefix}block${type} <#tiket> [alasan]`)
          return
        }

        service.blacklistToken(token, reason)
        await commandContext.reply(`⛔ Tiket \`#${token}\` berhasil diblokir dari sistem ${type === 'report' ? 'laporan' : 'kotak saran'}.`)
      }

      context.commands.register({
        name: 'blocksaran',
        aliases: ['bloksaran'],
        description: 'Blokir tiket pengirim yang menyalahgunakan kotak saran.',
        category: 'moderation',
        menuOrder: 54,
        handler: createBlockHandler('suggest'),
      })

      context.commands.register({
        name: 'blockreport',
        aliases: ['bloklapor'],
        description: 'Blokir tiket pengirim yang menyalahgunakan kotak laporan.',
        category: 'moderation',
        menuOrder: 55,
        handler: createBlockHandler('report'),
      })
    },
  }
}
