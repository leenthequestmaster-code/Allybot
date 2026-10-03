import type { Plugin, PluginContext, CommandContext, CoreMessage, WhatsAppPort } from '../contracts.js'
import { sendLink, verifyLink } from '../../services/verify-api.js'
import { setSession, getSession, clearSession } from '../../services/verify-session.js'

const EMAIL_REGEX = /^\S+@\S+\.\S+$/
const URL_REGEX = /^https?:\/\/\S+$/

export function createVerifyPlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'verify',
    version: '1.0.0',

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
              await ctx.reply('Email terkirim. Paste link verifikasi yang kamu terima ke chat ini.')
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
        const email = getSession(senderJid)

        if (email === null) {
          // No active session for this user — not our message
          return
        }

        try {
          const result = await verifyLink(email, text)
          clearSession(senderJid)
          await whatsapp.sendText(message.remoteJid, result.message)
        } catch (err: unknown) {
          const code = (err as { code?: string }).code
          if (code === 'TIMEOUT') {
            clearSession(senderJid)
            await whatsapp.sendText(
              message.remoteJid,
              'Service tidak merespon, coba lagi.',
            )
          } else {
            logger.error({ err }, 'verify verifyLink error')
            clearSession(senderJid)
            await whatsapp.sendText(message.remoteJid, 'Service sedang down, coba lagi nanti.')
          }
        }
      })
    },
  }
}
