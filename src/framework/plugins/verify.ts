import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { Plugin, PluginContext, CommandContext, CoreMessage, WhatsAppPort } from '../contracts.js'
import { sendLink, verifyLink } from '../../services/verify-api.js'
import { setSession, getSession, clearSession } from '../../services/verify-session.js'

const EMAIL_REGEX = /^\S+@\S+\.\S+$/
const URL_REGEX = /^https?:\/\/\S+$/
const CONFIG_PATH = resolve('/opt/Allybot/data/config.json')

function getOwners(): string[] {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return Array.isArray(raw.owners) ? raw.owners : []
  } catch {
    return []
  }
}

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
    name: 'amprem',
    version: '1.2.0',

    load(context: PluginContext): void {
      const logger = context.logger

      // ── !amprem / !am ─────────────────────────────────────────────────────
      context.commands.register({
        name: 'amprem',
        aliases: ['am'],
        description: 'Alight Motion premium activator.',
        category: 'tools',
        hidden: true,

        handler: async (ctx: CommandContext) => {
          const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid

          // Beta lock — hanya owner
          if (!getOwners().includes(senderJid)) {
            await ctx.reply('Fitur ini belum tersedia.')
            return
          }

          const email = ctx.args.join(' ').trim()

          if (!email) {
            await ctx.reply('Kirim email AlightMotion kamu. Contoh: !am email@gmail.com')
            return
          }

          if (!EMAIL_REGEX.test(email)) {
            await ctx.reply('Format email tidak valid.')
            return
          }

          try {
            const result = await sendLink(email)

            if (result.status) {
              setSession(senderJid, email)
              const data = result.data as Record<string, unknown> | null
              const link = typeof data?.link === 'string' && data.link.trim() ? data.link.trim() : null
              const reply = link
                ? `Magic link terkirim. Paste link ini ke chat:\n${link}`
                : 'Magic link terkirim. Cek inbox / spam, lalu paste link-nya ke sini.'
              await ctx.reply(reply)
            } else {
              await ctx.reply(result.message)
            }
          } catch (err: unknown) {
            const code = (err as { code?: string }).code
            if (code === 'TIMEOUT') {
              await ctx.reply('Service tidak merespon, coba lagi.')
            } else {
              logger.error({ err }, 'amprem sendLink error')
              await ctx.reply('Service sedang down, coba lagi nanti.')
            }
          }
        },
      })

      // ── URL interceptor ───────────────────────────────────────────────────
      context.events.on('message.received', async (message: CoreMessage) => {
        const text = message.text?.trim()
        if (!text) return
        if (!URL_REGEX.test(text)) return

        const senderJid = message.senderJid ?? message.remoteJid

        // Hanya proses jika senderJid adalah owner dan punya sesi aktif
        if (!getOwners().includes(senderJid)) return

        const sessionEmail = getSession(senderJid)
        if (sessionEmail === null) return

        const linkEmail = emailFromLink(text)
        if (linkEmail !== null && linkEmail !== sessionEmail) {
          await whatsapp.sendText(
            message.remoteJid,
            'Link ini untuk email yang berbeda dari sesi aktifmu. Ulangi dengan !am <email>.',
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
            logger.error({ err }, 'amprem verifyLink error')
            await whatsapp.sendText(message.remoteJid, 'Service sedang down, coba lagi nanti.')
          }
        }
      })
    },
  }
}
