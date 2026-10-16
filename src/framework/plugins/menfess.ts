import type { Plugin, WhatsAppPort, CoreMessage, WhatsAppMediaPayload } from '../contracts.js'
import { bareJid, normalizePhoneJid } from '../../permissions.js'
import { MenfessService } from '../../services/menfess-service.js'
import { isGroupJid } from '../validation.js'

export interface MenfessPluginOptions {
  readonly maxMediaBytes?: number
}

const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024 // 25 MB

export function parseTargetJid(raw: string): string | undefined {
  if (!raw) return undefined
  let cleaned = raw.trim().replace(/[@+\s-]/g, '')
  if (cleaned.endsWith('@s.whatsapp.net')) {
    cleaned = cleaned.replace('@s.whatsapp.net', '')
  }
  // Convert Indonesian leading 08xx to 628xx
  if (cleaned.startsWith('08')) {
    cleaned = '62' + cleaned.slice(1)
  }
  if (!/^\d{8,16}$/.test(cleaned)) {
    return undefined
  }
  return normalizePhoneJid(cleaned)
}

export function sanitizeMenfessText(raw: string): string {
  return raw
    .replace(/[\u200B-\u200D\uFEFF\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

export function formatRecipientNotice(threadId: string, text?: string): string {
  return [
    '💌 *Pesan Rahasia Diterima (Menfess)*',
    '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
    `ID Percakapan: \`#${threadId}\``,
    ...(text ? ['', `"${text}"`] : []),
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '💡 *Instruksi Balas:*',
    '↳ Balas langsung (teks, foto, video, suara/VN, stiker, dokumen) di chat ini.',
    '↳ Ketik `!stopmenfess` untuk mengakhiri sesi untuk kedua belah pihak.',
    '↳ Ketik `!blockmenfess` untuk memblokir pengirim ini jika mengganggu.',
  ].join('\n')
}

export async function relayMedia(
  whatsapp: WhatsAppPort,
  service: MenfessService,
  targetJid: string,
  downloaded: WhatsAppMediaPayload,
  roleLabel: string,
  threadId: string,
  userText?: string,
): Promise<void> {
  const cleanText = userText ? sanitizeMenfessText(userText) : ''

  switch (downloaded.kind) {
    case 'image': {
      const cleanBuffer = await service.sanitizeImage(Buffer.from(downloaded.data))
      const caption = [
        `📷 *Foto Anonim [${roleLabel}]* · \`#${threadId}\``,
        ...(cleanText ? ['', cleanText] : []),
      ].join('\n')
      await whatsapp.sendMedia?.(targetJid, {
        kind: 'image',
        data: cleanBuffer,
        mimeType: 'image/jpeg',
        caption,
      })
      break
    }
    case 'video': {
      const caption = [
        `🎥 *Video Anonim [${roleLabel}]* · \`#${threadId}\``,
        ...(cleanText ? ['', cleanText] : []),
      ].join('\n')
      await whatsapp.sendMedia?.(targetJid, {
        kind: 'video',
        data: downloaded.data,
        mimeType: downloaded.mimeType || 'video/mp4',
        caption,
        ...(downloaded.gifPlayback ? { gifPlayback: true } : {}),
      })
      break
    }
    case 'audio': {
      if (cleanText) {
        await whatsapp.sendText(
          targetJid,
          `🎙️ *Pesan Suara [${roleLabel}]* · \`#${threadId}\`\n\n${cleanText}`,
        )
      }
      await whatsapp.sendMedia?.(targetJid, {
        kind: 'audio',
        data: downloaded.data,
        mimeType: downloaded.mimeType || 'audio/ogg; codecs=opus',
        ptt: true,
      })
      break
    }
    case 'sticker': {
      if (cleanText) {
        await whatsapp.sendText(
          targetJid,
          `🏷️ *Stiker Anonim [${roleLabel}]* · \`#${threadId}\`\n\n${cleanText}`,
        )
      }
      await whatsapp.sendMedia?.(targetJid, {
        kind: 'sticker',
        data: downloaded.data,
        mimeType: 'image/webp',
        ...(downloaded.isAnimated ? { isAnimated: true } : {}),
      })
      break
    }
    case 'document': {
      const caption = [
        `📄 *Dokumen Anonim [${roleLabel}]* · \`#${threadId}\``,
        ...(cleanText ? ['', cleanText] : []),
      ].join('\n')
      await whatsapp.sendMedia?.(targetJid, {
        kind: 'document',
        data: downloaded.data,
        mimeType: downloaded.mimeType || 'application/octet-stream',
        fileName: downloaded.fileName || 'dokumen',
        caption,
      })
      break
    }
  }
}

export function createMenfessPlugin(
  whatsapp: WhatsAppPort,
  options: MenfessPluginOptions = {},
): Plugin {
  const maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES
  const closedNoticeCooldowns = new Map<string, number>()

  return {
    name: 'menfess',

    initialize(context): void {
      const getService = (): MenfessService => context.services.get<MenfessService>('menfess')

      // ==========================================
      // STICKY CONVERSATION RELAY (Private Chat)
      // ==========================================
      whatsapp.onMessage(async (message: CoreMessage) => {
        if (message.fromMe) return
        if (isGroupJid(message.remoteJid)) return // Menfess conversations are strictly private

        const text = message.text?.trim() ?? ''
        const prefix = context.config.commandPrefix
        // Ignore commands so they can be dispatched normally
        if (text.startsWith(prefix) || /^[/!#.]/.test(text)) {
          return
        }

        const currentJid = bareJid(message.senderJid ?? message.remoteJid)
        const service = getService()
        const session = await service.getActiveSession(currentJid)
        if (!session) {
          // Check if user recently had a closed thread and tries to send a message
          const recent = service.getRecentlyClosedThread(currentJid, 60 * 60 * 1000)
          if (recent) {
            const now = Date.now()
            const lastNotice = closedNoticeCooldowns.get(currentJid) ?? 0
            if (now - lastNotice > 5 * 60 * 1000) {
              closedNoticeCooldowns.set(currentJid, now)
              await whatsapp.sendText(
                message.remoteJid,
                `⚠️ Sesi Menfess \`#${recent.threadId}\` telah resmi diakhiri. Pesanmu tidak diteruskan ke siapapun.\n\nKetik \`!menfess <nomor> <pesan>\` jika ingin memulai percakapan baru.`,
              )
            }
          }
          return
        }

        const peerJid = await service.getPeerJid(session.threadId, currentJid)
        if (!peerJid) return

        const hasDirect = Boolean(message.media)
        const hasQuoted = Boolean(message.quotedMedia)

        if (hasDirect || hasQuoted) {
          try {
            const downloaded = await whatsapp.downloadMedia?.(
              message,
              hasDirect ? 'direct' : 'quoted',
              { maxBytes: maxMediaBytes, timeoutMs: 30_000 },
            )

            if (downloaded) {
              const roleLabel = session.role === 'sender' ? 'Pengirim' : 'Penerima'
              await relayMedia(
                whatsapp,
                service,
                peerJid,
                downloaded,
                roleLabel,
                session.threadId,
                text,
              )
            }
          } catch (err) {
            context.logger.warn({ err, threadId: session.threadId }, 'Failed to relay menfess media')
            return
          } finally {
            whatsapp.deleteStoredMessage?.(message.remoteJid, message.id)
          }
        } else if (text) {
          const clean = sanitizeMenfessText(text)
          if (!clean) return

          const roleLabel = session.role === 'sender' ? 'Pengirim' : 'Penerima'
          await whatsapp.sendText(
            peerJid,
            `📩 *[${roleLabel}]* · \`#${session.threadId}\`\n\n${clean}`,
          )
        } else {
          return
        }

        await service.recordMessage(session.threadId, currentJid, peerJid)

        try {
          await whatsapp.sendReaction?.(
            message.remoteJid,
            { id: message.id, remoteJid: message.remoteJid },
            '📨',
          )
        } catch (err) {
          context.logger.debug({ err, messageId: message.id }, 'Non-blocking reaction failed')
        }
      })

      // ==========================================
      // COMMAND: menfess (aliases: confess, fess, menfes)
      // ==========================================
      context.commands.register({
        name: 'menfess',
        aliases: ['confess', 'fess', 'menfes'],
        description: 'Kirim pesan rahasia anonim ke nomor WhatsApp manapun.',
        category: 'utility',
        scope: 'private',
        menuOrder: 16,
        handler: async (commandContext) => {
          const service = getService()
          const senderJid = bareJid(commandContext.message.senderJid ?? commandContext.message.remoteJid)

          // 1. Help / Status view if no args or first arg is 'help' or 'status'
          if (
            commandContext.args.length === 0 ||
            commandContext.args[0].toLowerCase() === 'help' ||
            commandContext.args[0].toLowerCase() === 'status'
          ) {
            const activeSession = await service.getActiveSession(senderJid)
            const rate = await service.checkRateLimit(senderJid)

            const lines = [
              '💌 *Layanan Menfess Anonim (Allybot)*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              'Kirim pesan rahasia ke nomor WhatsApp siapapun tanpa membocorkan identitasmu.',
              '',
              `*Status Sesi Kamu:* ${
                activeSession
                  ? `🟢 *Aktif* (\`#${activeSession.threadId}\` sebagai ${activeSession.role === 'sender' ? 'Pengirim' : 'Penerima'})`
                  : '⚪ *Tidak Ada Sesi Aktif*'
              }`,
              `*Sisa Kuota Harian:* *${rate.remaining} sesi*`,
              '',
              '*Cara Memulai:*',
              `↳ \`${commandContext.prefix}menfess <nomor_tujuan> <pesan>\``,
              `↳ Contoh: \`${commandContext.prefix}menfess 08123456789 Halo, semangat ya harimu!\``,
              '',
              '*Fitur & Keamanan:*',
              '⡇╌ *Zero-Knowledge:* Nomor tidak disimpan dalam teks biasa (AES-GCM + HMAC).',
              '⡇╌ *Dukungan Media Penuh:* Kirim teks, gambar/foto, video, audio/VN, stiker, hingga dokumen.',
              '⡇╌ *Privasi Foto:* EXIF GPS/metadata foto otomatis dilucuti.',
              '⡇╌ *Sticky Session:* Balas langsung chat tanpa perintah khusus selama 24 jam.',
              '⡇╌ Ketik `!stopmenfess` untuk mengakhiri sesi obrolan (salah satu berhenti, sesi tamat untuk keduanya).',
              '⡇╌ Ketik `!blockmenfess` jika kamu menerima pesan spam/gangguan.',
            ]

            await commandContext.reply(lines.join('\n'))
            return
          }

          // 2. Parse target JID
          const targetArg = commandContext.args[0]
          const targetJid = parseTargetJid(targetArg)
          if (!targetJid) {
            await commandContext.reply(
              '❌ Nomor tujuan tidak valid. Masukkan nomor WhatsApp yang valid (contoh: `08123456789` atau `628123456789`).',
            )
            return
          }

          if (senderJid === targetJid) {
            await commandContext.reply('❌ Kamu tidak dapat mengirim Menfess ke nomormu sendiri.')
            return
          }

          // 3. Extract message content
          const rawText = commandContext.args.slice(1).join(' ')
          const sanitizedText = sanitizeMenfessText(rawText)

          const hasDirect = Boolean(commandContext.message.media)
          const hasQuoted = Boolean(commandContext.message.quotedMedia)

          if (!sanitizedText && !hasDirect && !hasQuoted) {
            await commandContext.reply(
              '❌ Pesan Menfess tidak boleh kosong. Tulis pesan atau lampirkan media bersama perintah.',
            )
            return
          }

          // 4. Download media if attached
          let downloadedMedia: WhatsAppMediaPayload | undefined
          if (hasDirect || hasQuoted) {
            try {
              downloadedMedia = await whatsapp.downloadMedia?.(
                commandContext.message,
                hasDirect ? 'direct' : 'quoted',
                { maxBytes: maxMediaBytes, timeoutMs: 30_000 },
              )
            } catch (err) {
              commandContext.logger.warn({ err }, 'Failed to download menfess initial media')
            } finally {
              whatsapp.deleteStoredMessage?.(commandContext.message.remoteJid, commandContext.message.id)
            }
          }

          // 5. Create Thread in MenfessService
          const result = await service.createThread(senderJid, targetJid)
          if (!result.success || !result.thread) {
            switch (result.reason) {
              case 'RATE_LIMITED':
                await commandContext.reply(
                  '⏳ Kuota Menfess harian kamu telah habis (maksimal 5 sesi per 24 jam). Coba lagi besok!',
                )
                return
              case 'RECIPIENT_BLOCKED':
                await commandContext.reply('🚫 Kamu tidak dapat mengirimkan Menfess ke nomor ini.')
                return
              case 'SENDER_BUSY': {
                const active = await service.getActiveSession(senderJid)
                await commandContext.reply(
                  `⚠️ Kamu masih berada dalam sesi Menfess aktif (\`#${active?.threadId ?? ''}\`). Balas langsung di chat untuk melanjutkan, atau ketik \`!stopmenfess\` untuk menutup sesi sebelum memulai yang baru.`,
                )
                return
              }
              case 'RECIPIENT_BUSY':
                await commandContext.reply(
                  '⏳ Nomor tujuan saat ini sedang berada dalam sesi Menfess lain. Silakan coba beberapa saat lagi.',
                )
                return
              case 'SELF_TARGET':
                await commandContext.reply('❌ Kamu tidak dapat mengirim Menfess ke nomormu sendiri.')
                return
              default:
                await commandContext.reply('❌ Gagal membuat sesi Menfess. Silakan coba beberapa saat lagi.')
                return
            }
          }

          const thread = result.thread

          // 6. Deliver to recipient
          try {
            const recipientNotice = formatRecipientNotice(thread.threadId, sanitizedText)

            if (downloadedMedia) {
              if (downloadedMedia.kind === 'audio' || downloadedMedia.kind === 'sticker') {
                await whatsapp.sendText(targetJid, recipientNotice)
                await relayMedia(
                  whatsapp,
                  service,
                  targetJid,
                  downloadedMedia,
                  'Pengirim',
                  thread.threadId,
                  '',
                )
              } else {
                await relayMedia(
                  whatsapp,
                  service,
                  targetJid,
                  downloadedMedia,
                  'Pengirim',
                  thread.threadId,
                  sanitizedText ? `${sanitizedText}\n\n💡 Balas langsung di chat ini.` : '💡 Balas langsung di chat ini.',
                )
              }
            } else {
              await whatsapp.sendText(targetJid, recipientNotice)
            }

            // 7. Success confirmation to sender
            const confirmationLines = [
              '✅ *Menfess Berhasil Terkirim!*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              `ID Percakapan: \`#${thread.threadId}\``,
              `Sisa Kuota Harian: *${result.remainingDailyQuota ?? 0} sesi*`,
              '',
              '💡 *Sesi Terhubung:*',
              '↳ Kamu sekarang berada dalam sesi aktif.',
              '↳ Kirim chat langsung (teks, foto, video, suara/VN, stiker, dokumen) ke bot ini untuk meneruskan pesan ke penerima.',
              '↳ Ketik `!stopmenfess` jika ingin mengakhiri sesi (satu pihak berhenti, sesi selesai sepenuhnya).',
            ]

            await commandContext.reply(confirmationLines.join('\n'))
          } catch (err) {
            commandContext.logger.error({ err, threadId: thread.threadId }, 'Failed to send menfess message')
            await commandContext.reply('❌ Terjadi kendala saat meneruskan pesan ke nomor tujuan.')
          }
        },
      })

      // ==========================================
      // COMMAND: stopmenfess (aliases: endmenfess, stopmf)
      // ==========================================
      context.commands.register({
        name: 'stopmenfess',
        aliases: ['endmenfess', 'stopmf'],
        description: 'Akhiri sesi percakapan Menfess aktif saat ini.',
        category: 'utility',
        scope: 'private',
        menuOrder: 17,
        handler: async (commandContext) => {
          const service = getService()
          const currentJid = bareJid(commandContext.message.senderJid ?? commandContext.message.remoteJid)

          const res = await service.closeThread(currentJid)
          if (!res.closed) {
            const recent = service.getRecentlyClosedThread(currentJid, 2 * 60 * 60 * 1000)
            if (recent) {
              await commandContext.reply(`ℹ️ Sesi Menfess \`#${recent.threadId}\` sudah resmi ditutup sebelumnya.`)
              return
            }
            await commandContext.reply('⚠️ Kamu tidak memiliki sesi Menfess aktif yang sedang berjalan.')
            return
          }

          await commandContext.reply(
            `🛑 Sesi Menfess \`#${res.threadId}\` telah resmi diakhiri. Sesi ditutup sepenuhnya untuk kedua belah pihak.`,
          )
          if (res.peerJid) {
            try {
              await whatsapp.sendText(
                res.peerJid,
                `🛑 Teman bicaramu telah mengakhiri sesi Menfess \`#${res.threadId}\`. Percakapan ditutup sepenuhnya dan tidak ada lagi pesan yang dapat dikirimkan.`,
              )
            } catch (err) {
              commandContext.logger.warn({ err, peerJid: res.peerJid }, 'Failed to notify peer of session closure')
            }
          }
        },
      })

      // ==========================================
      // COMMAND: blockmenfess (aliases: blockmf)
      // ==========================================
      context.commands.register({
        name: 'blockmenfess',
        aliases: ['blockmf'],
        description: 'Blokir pengirim Menfess aktif agar tidak dapat mengirim pesan lagi.',
        category: 'utility',
        scope: 'private',
        menuOrder: 18,
        handler: async (commandContext) => {
          const service = getService()
          const currentJid = bareJid(commandContext.message.senderJid ?? commandContext.message.remoteJid)

          const res = await service.blockSender(currentJid)
          if (!res.blocked) {
            const recent = service.getRecentlyClosedThread(currentJid, 2 * 60 * 60 * 1000)
            if (recent && recent.isBlocked) {
              await commandContext.reply(`ℹ️ Pengirim Menfess \`#${recent.threadId}\` sudah diblokir sebelumnya.`)
              return
            }
            await commandContext.reply(
              '⚠️ Perintah blokir hanya dapat digunakan oleh penerima saat sedang berada dalam sesi Menfess aktif.',
            )
            return
          }

          await commandContext.reply(
            `🚫 Pengirim Menfess \`#${res.threadId}\` telah berhasil diblokir permanen. Sesi ditutup sepenuhnya untuk kedua belah pihak.`,
          )
          if (res.peerJid) {
            try {
              await whatsapp.sendText(
                res.peerJid,
                `🛑 Sesi Menfess \`#${res.threadId}\` telah ditutup oleh penerima.`,
              )
            } catch (err) {
              commandContext.logger.warn({ err, peerJid: res.peerJid }, 'Failed to notify peer of sender block')
            }
          }
        },
      })
    },
  }
}
