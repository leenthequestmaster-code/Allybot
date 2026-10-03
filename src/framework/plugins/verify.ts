import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { Plugin, PluginContext, CommandContext, CoreMessage, WhatsAppPort } from '../contracts.js'
import { sendLink, verifyLink } from '../../services/verify-api.js'
import { setSession, getSession, clearSession } from '../../services/verify-session.js'
import {
  createTempInbox,
  waitForVerificationLink,
  deleteTempInbox,
} from '../../services/tempmail.js'
import {
  restoreAutoLimits,
  checkAutoLimit,
  consumeAutoLimit,
} from '../../services/amprem-auto-limiter.js'

const EMAIL_REGEX = /^\S+@\S+\.\S+$/
const URL_REGEX = /^https?:\/\/\S+$/
const CONFIG_PATH = resolve('/opt/Allybot/data/config.json')

interface BotConfig {
  owners: string[]
  premium_users: string[]
  premium_groups: string[]
  tempmail_providers: string[]
  tempmail_poll_interval_ms: number
  tempmail_timeout_ms: number
  amprem_auto_cooldown_ms: number
  amprem_auto_quota_default: number
  amprem_auto_quota_premium: number
}

function loadConfig(): BotConfig {
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
  } catch {
    // default semua
  }
  const strArr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])
  const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)
  return {
    owners: strArr(raw['owners']),
    premium_users: strArr(raw['premium_users']),
    premium_groups: strArr(raw['premium_groups']),
    tempmail_providers: strArr(raw['tempmail_providers']).length
      ? strArr(raw['tempmail_providers'])
      : ['mail.tm', 'mailboxtemp', 'tempmail.lol'],
    tempmail_poll_interval_ms: num(raw['tempmail_poll_interval_ms'], 2000),
    tempmail_timeout_ms: num(raw['tempmail_timeout_ms'], 60000),
    amprem_auto_cooldown_ms: num(raw['amprem_auto_cooldown_ms'], 300000),
    amprem_auto_quota_default: num(raw['amprem_auto_quota_default'], 3),
    amprem_auto_quota_premium: num(raw['amprem_auto_quota_premium'], 20),
  }
}

function tierOf(jid: string, cfg: BotConfig): 'owner' | 'premium' | 'free' {
  if (cfg.owners.includes(jid)) return 'owner'
  if (cfg.premium_users.includes(jid)) return 'premium'
  return 'free'
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
  // Lock per user JID untuk auto run yang sedang jalan.
  const autoRunning = new Set<string>()

  return {
    name: 'amprem',
    version: '1.3.0',

    load(context: PluginContext): void {
      const logger = context.logger
      restoreAutoLimits()

      context.commands.register({
        name: 'amprem',
        aliases: ['am'],
        description: 'Alight Motion premium activator.',
        category: 'tools',
        hidden: true,

        handler: async (ctx: CommandContext) => {
          const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid

          // Beta lock — hanya owner
          const cfg = loadConfig()
          if (!cfg.owners.includes(senderJid)) {
            await ctx.reply('Fitur ini belum tersedia.')
            return
          }

          // ── Dispatch ─────────────────────────────────────────────────────
          const first = (ctx.args[0] ?? '').toLowerCase()

          if (ctx.args.length === 0) {
            await ctx.reply('Kirim email AlightMotion kamu. Contoh: !am email@gmail.com')
            return
          }

          if (first === 'auto') {
            await handleAuto(ctx)
            return
          }

          await handleManual(ctx)
        },
      })

      // ── Mode 1 manual (existing, tidak diubah) ────────────────────────────
      async function handleManual(ctx: CommandContext): Promise<void> {
        const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid
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
            const link =
              typeof data?.link === 'string' && data.link.trim() ? data.link.trim() : null
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
      }

      // ── Mode 2 auto (baru) ───────────────────────────────────────────────
      async function handleAuto(ctx: CommandContext): Promise<void> {
        const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const cfg = loadConfig()
        const tier = tierOf(senderJid, cfg)

        if (autoRunning.has(senderJid)) {
          await ctx.reply('Kamu sedang menjalankan verifikasi lain. Tunggu selesai.')
          return
        }

        const limit = checkAutoLimit(senderJid, tier, {
          cooldownMs: cfg.amprem_auto_cooldown_ms,
          quotaDefault: cfg.amprem_auto_quota_default,
          quotaPremium: cfg.amprem_auto_quota_premium,
        })
        if (!limit.ok) {
          if (limit.reason === 'COOLDOWN') {
            const mins = Math.ceil((limit.waitMs ?? 0) / 60000)
            await ctx.reply(`Tunggu ${mins} menit sebelum auto lagi.`)
          } else {
            await ctx.reply('Jatah auto hari ini habis (3x). Pakai !am <email> manual.')
          }
          return
        }

        autoRunning.add(senderJid)
        const t0 = Date.now()
        let inbox: import('../../services/tempmail.js').TempInbox | null = null

        try {
          await ctx.reply('Membuat email sementara...')

          try {
            inbox = await createTempInbox(cfg.tempmail_providers)
          } catch {
            await ctx.reply('Semua penyedia email sementara sedang tidak tersedia. Pakai !am <email> manual.')
            return
          }
          const box = inbox

          await ctx.reply(`${box.email}\nMengirim ke service...`)

          const sent = await sendLink(box.email)
          if (!sent.status) {
            await ctx.reply(sent.message)
            return
          }

          await ctx.reply('Menunggu email verifikasi...')

          const found = await waitForVerificationLink(box, {
            timeoutMs: cfg.tempmail_timeout_ms,
            pollIntervalMs: cfg.tempmail_poll_interval_ms,
          })

          if (!found) {
            await ctx.reply(
              'Email verifikasi tidak masuk dalam 60 detik. Coba lagi atau pakai mode manual.',
            )
            return
          }

          const verified = await verifyLink(box.email, found.link)
          consumeAutoLimit(senderJid)
          logger.info(
            { provider: box.provider, waitMs: Date.now() - t0, ok: verified.status },
            'amprem auto run',
          )
          await ctx.reply(verified.message)
        } catch (err: unknown) {
          const code = (err as { code?: string }).code
          if (code === 'TIMEOUT') {
            await ctx.reply('Service tidak merespon, coba lagi.')
          } else {
            logger.error({ err }, 'amprem auto error')
            await ctx.reply('Service sedang down, coba lagi nanti.')
          }
        } finally {
          autoRunning.delete(senderJid)
          if (inbox) await deleteTempInbox(inbox)
        }
      }

      // ── URL interceptor (existing, tidak diubah) ──────────────────────────
      context.events.on('message.received', async (message: CoreMessage) => {
        const text = message.text?.trim()
        if (!text) return
        if (!URL_REGEX.test(text)) return

        const senderJid = message.senderJid ?? message.remoteJid
        const cfg = loadConfig()

        if (!cfg.owners.includes(senderJid)) return

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
