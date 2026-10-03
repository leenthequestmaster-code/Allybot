import type { Plugin, PluginContext, CommandContext, CoreMessage, WhatsAppPort } from '../contracts.js'
import { sendLink, verifyLink } from '../../services/verify-api.js'
import { setSession, getSession, clearSession } from '../../services/verify-session.js'

const EMAIL_REGEX = /^\S+@\S+\.\S+$/
const URL_REGEX = /^https?:\/\/\S+$/

// Ekstrak nilai ?email= dari URL link verifikasi jika ada.
// Dipakai untuk deteksi mismatch session vs link.
function emailFromLink(link: string): string | null {
  try {
    const u = new URL(link)
    const e = u.searchParams.get('email')
    return e ? decodeURIComponent(e) : null
  } catch {
    return null
  }
}

export function createVerifyPlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'verify',
    version: '1.1.0',

    load(context: PluginContext): void {
      const logger = context.logger

      // ── !verify command ──────────────────────────────────────────────────
      context.commands.register({
        name: 'verify',
        description: 'Verifikasi email. Contoh: !verify email@domain.com',
        category: 'tools',

        handler: async (ctx: CommandContext) => {
          const email = ctx.args.join(' ').trim()

          if (!email) {
            await ctx.reply('Kirim email kamu. Contoh: !verify email@domain.com')
            return
          }

          if (!EMAIL_REGEX.test(email)) {
            await ctx.reply('Format email tidak valid.')
            return
          }

          const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid

          try {
            const result = await sendLink(email)

            if (result.status) {
              setSession(senderJid, email)

              // Kalau service return link di response, tampilkan sekalian.
              // Kalau tidak (produksi kirim via email), cukup minta user cek inbox.
              const data = result.data as Record<string, unknown> | null
              const link = typeof data?.link === 'string' ? data.link : null

              const reply = link
                ? `Email terkirim. Paste link ini ke chat:\n${link}`
                : 'Email terkirim. Cek inbox kamu, lalu paste link verifikasinya ke sini.'

              await ctx.reply(reply)
            } else {
              await ctx.reply(result.message)
            }
          } catch (err: unknown) {
            const code = (err as { code?: string }).code
            if (code === 'TIMEOUT') {
              await ctx.reply('Service tidak merespon, coba lagi.')
            } else {
              logger.error({ err }, 'verify sendLink error')
              await ctx.reply('Service sedang down, coba lagi nanti.')
            }
          }
        },
      })

      // ── URL interceptor via message.received event ───────────────────────
      context.events.on('message.received', async (message: CoreMessage) => {
        const text = message.text?.trim()
        if (!text) return
        if (!URL_REGEX.test(text)) return

        const senderJid = message.senderJid ?? message.remoteJid
        const sessionEmail = getSession(senderJid)

        if (sessionEmail === null) return

        // Deteksi mismatch: email di link vs email di session.
        // Kalau link punya ?email= param dan berbeda dari session → tolak.
        const linkEmail = emailFromLink(text)
        if (linkEmail !== null && linkEmail !== sessionEmail) {
          await whatsapp.sendText(
            message.remoteJid,
            'Link ini untuk email yang berbeda dari sesi aktifmu. Ulangi dengan !verify dan email yang benar.',
          )
          return
        }

        try {
          const result = await verifyLink(sessionEmail, text)
          clearSession(senderJid)
          await whatsapp.sendText(message.remoteJid, result.message)
        } catch (err: unknown) {
          const code = (err as { code?: string }).code
          clearSession(senderJid)
          if (code === 'TIMEOUT') {
            await whatsapp.sendText(message.remoteJid, 'Service tidak merespon, coba lagi.')
          } else {
            logger.error({ err }, 'verify verifyLink error')
            await whatsapp.sendText(message.remoteJid, 'Service sedang down, coba lagi nanti.')
          }
        }
      })
    },
  }
}
