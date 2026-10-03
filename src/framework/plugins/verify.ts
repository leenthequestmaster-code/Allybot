import { readFileSync } from 'fs'
import { resolve } from 'path'
import type { Plugin, PluginContext, CommandContext, CoreMessage, WhatsAppPort } from '../contracts.js'
import { sendLink, verifyLink } from '../../services/verify-api.js'
import { setSession, getSession, clearSession } from '../../services/verify-session.js'
import {
  createTempInbox,
  waitForVerificationLink,
  deleteTempInbox,
  readLastLink,
  readInboxWithRetry,
  extractAllLinks,
  getCachedLinks,
  setCachedLinks,
} from '../../services/tempmail.js'
import type { TempInbox, PollInfo } from '../../services/tempmail.js'
import {
  restoreAutoLimits,
  checkAutoLimit,
  consumeAutoLimit,
} from '../../services/amprem-auto-limiter.js'
import {
  restoreAutoSessions,
  saveAutoSession,
  getAutoSession,
  clearAutoSession,
  markAccountVerified,
  removeTempSession,
  findAccount,
  listAccounts,
  removeAccount,
  getLoginSent,
  markLoginSent,
} from '../../services/amprem-auto-session.js'

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
    version: '1.6.0',

    load(context: PluginContext): void {
      const logger = context.logger
      restoreAutoLimits()
      restoreAutoSessions()

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

          if (first === 'last') {
            await handleLast(ctx)
            return
          }

          if (first === 'login') {
            await handleLogin(ctx)
            return
          }

          if (first === 'inbox') {
            await handleInbox(ctx)
            return
          }

          if (first === 'list') {
            await handleList(ctx)
            return
          }

          if (first === 'forget') {
            await handleForget(ctx)
            return
          }

          if (first === 'raw') {
            await handleRaw(ctx)
            return
          }

          if (first === 'status') {
            await handleStatus(ctx)
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

      // ── Mode 2 auto ───────────────────────────────────────────────────────
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
        let inbox: TempInbox | null = null
        let timedOut = false
        let verifiedOk = false

        try {
          await ctx.reply('Membuat email sementara...')

          try {
            inbox = await createTempInbox(cfg.tempmail_providers)
          } catch {
            await ctx.reply('Semua penyedia email sementara sedang tidak tersedia. Pakai !am <email> manual.')
            return
          }
          const box = inbox

          // Simpan session untuk recovery via !amprem last.
          saveAutoSession(senderJid, {
            email: box.email,
            token: box.token,
            provider: box.provider,
            extra: box.extra,
          })

          await ctx.reply(`${box.email}\nMengirim ke service...`)

          const sent = await sendLink(box.email)
          if (!sent.status) {
            await ctx.reply(sent.message)
            return
          }

          await ctx.reply('Menunggu email verifikasi...')

          const onPoll = (p: PollInfo): void => {
            // Log per poll — tanpa token, tanpa body penuh.
            logger.info(
              {
                provider: p.provider, poll: p.poll, http: p.httpStatus,
                count: p.count, subj: p.firstSubject.slice(0, 80),
                from: p.firstFrom.slice(0, 60), head: p.bodyHead.slice(0, 100),
                matched: p.matched,
              } as unknown as Record<string, unknown>,
              'amprem poll',
            )
          }

          const found = await waitForVerificationLink(box, {
            timeoutMs: cfg.tempmail_timeout_ms,
            pollIntervalMs: cfg.tempmail_poll_interval_ms,
            onPoll,
          })

          if (!found) {
            timedOut = true
            await ctx.reply(
              'Email verifikasi tidak masuk dalam 60 detik. Coba !am last untuk ambil manual, atau pakai mode manual.',
            )
            return
          }

          const verified = await verifyLink(box.email, found.link)
          consumeAutoLimit(senderJid)
          logger.info(
            { provider: box.provider, waitMs: Date.now() - t0, ok: verified.status },
            'amprem auto run',
          )
          if (verified.status) {
            verifiedOk = true
            markAccountVerified(senderJid, box.email)
            await ctx.reply(
              `${verified.message}\nEmail akun: ${box.email}\nUntuk login ke aplikasi nanti, jalankan:\n!am login ${box.email}`,
            )
          } else {
            await ctx.reply(verified.message)
          }
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
          // Sukses → inbox DISIMPAN permanen untuk !am login (verified).
          // Timeout → temp dipertahankan untuk !am last, mail.tm dihapus fisik.
          // Gagal lain → temp dihapus.
          if (!inbox) {
            // inbox tidak pernah dibuat — tidak ada yang dibersihkan
          } else if (verifiedOk) {
            markAccountVerified(senderJid, inbox.email)
          } else if (timedOut) {
            if (inbox.provider === 'mail.tm') await deleteTempInbox(inbox)
          } else {
            await deleteTempInbox(inbox)
            removeTempSession(senderJid, inbox.email)
          }
        }
      }

      // ── Mode 3 last (recovery manual) ─────────────────────────────────────
      async function handleLast(ctx: CommandContext): Promise<void> {
        const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid

        if (autoRunning.has(senderJid)) {
          await ctx.reply('Tunggu auto yang sedang jalan selesai dulu.')
          return
        }

        const sess = getAutoSession(senderJid)
        if (!sess) {
          await ctx.reply('Inbox terakhir sudah expire atau kosong. Jalankan !am auto lagi.')
          return
        }

        await ctx.reply(`Cek inbox ${sess.email}...`)

        const inbox: TempInbox = {
          email: sess.email,
          token: sess.token,
          provider: (['mail.tm', 'mailboxtemp', 'tempmail.lol'] as string[]).includes(sess.provider)
            ? (sess.provider as TempInbox['provider'])
            : 'tempmail.lol',
          extra: sess.extra,
        }

        const res = await readLastLink(inbox)
        if (!res || !res.messages.length) {
          await ctx.reply('Inbox terakhir sudah expire atau kosong. Jalankan !am auto lagi.')
          return
        }

        if (res.link) {
          try {
            const verified = await verifyLink(inbox.email, res.link)
            consumeAutoLimit(senderJid)
            if (verified.status) markAccountVerified(senderJid, inbox.email)
            logger.info(
              { provider: inbox.provider, via: 'last', ok: verified.status },
              'amprem last run',
            )
            await ctx.reply(verified.message)
          } catch (err: unknown) {
            const code = (err as { code?: string }).code
            if (code === 'TIMEOUT') {
              await ctx.reply('Service tidak merespon, coba lagi.')
            } else {
              logger.error({ err }, 'amprem last verify error')
              await ctx.reply('Service sedang down, coba lagi nanti.')
            }
          }
          return
        }

        // Ada pesan tapi matcher gagal — kirim mentah biar user bisa lihat manual.
        const m = res.messages[res.messages.length - 1]
        if (!m) {
          await ctx.reply('Inbox terakhir sudah expire atau kosong. Jalankan !am auto lagi.')
          return
        }
        const raw = `Dari: ${m.from}\nSubjek: ${m.subject}\n\n${(m.body || m.html).slice(0, 500)}`
        await ctx.reply(`Link tidak terdeteksi otomatis. Isi pesan terakhir:\n\n${raw}`)
      }

      // ── !am login <email> [wait] — hanya pesan BARU, bukan burned ─────────
      // Verification email dari !am auto sudah burned (dipakai am-reverse).
      // Login link valid hanya datang dari pesan BARU setelah user Sign In
      // di app. Filter by timestamp + subject, jangan pernah kirim link lama.

      function loginSubjectOk(subject: string): boolean {
        const s = subject.toLowerCase()
        if (/verify|verification|activate/.test(s)) return false
        return /sign\s*in|login|masuk/.test(s)
      }

      function filterLoginMessages(
        messages: import('../../services/tempmail.js').InboxMessage[],
        t0: number,
      ): import('../../services/tempmail.js').InboxMessage[] {
        const lo = t0 - 30000
        return messages
          .filter((m) => (m.ts || 0) >= lo && loginSubjectOk(m.subject))
          .sort((a, b) => b.ts - a.ts)
      }

      async function doLoginFetch(
        ctx: CommandContext,
        senderJid: string,
        email: string,
        acc: { email: string; token: string; provider: string; extra?: string },
        t0: number,
      ): Promise<boolean> {
        const inbox: TempInbox = {
          email: acc.email,
          token: acc.token,
          provider: acc.provider as TempInbox['provider'],
          extra: acc.extra,
        }

        const res = await readInboxWithRetry(inbox)
        if (!res) {
          await ctx.reply('Service sedang down, coba lagi nanti.')
          return true
        }
        if (res.expired) {
          await ctx.reply('Inbox sudah tidak tersedia. Jalankan !am auto untuk akun baru.')
          return true
        }

        console.log(
          `[login] user=${senderJid} email=${email} t0=${t0} | messages in inbox: ${res.messages.length} | extract network calls: 0`,
        )
        const fresh = filterLoginMessages(res.messages, t0)
        console.log(`[login] filtered (after t0-30s, subject match): ${fresh.length}`)
        if (fresh.length) {
          const top = fresh.slice(0, 3).map((m) => `${m.msgId}@${m.ts}`).join(',')
          console.log(`[login] selected messageId: ${top}`)
        }

        if (!fresh.length) {
          await ctx.reply(
            `Belum ada email login baru untuk ${email}. Buka app Alight Motion, pilih Sign In dengan email, masukkan ${email}. Tunggu email masuk (biasanya <5 detik), lalu jalankan !am login ${email} lagi.`,
          )
          return true
        }

        // Anti re-extract: pesan yang link-nya sudah dikirim <5 mnt di-skip.
        const unsent = fresh.filter((m) => {
          const s = getLoginSent(senderJid, email)
          if (!s) return true
          if (s.messageId !== m.msgId) return true
          return Date.now() - s.sentAt >= 5 * 60 * 1000
        })

        if (!unsent.length) {
          await ctx.reply(
            `Link login terakhir untuk ${email} sudah dikirim di atas. Kalau expired, buka app AM lagi untuk trigger email baru.`,
          )
          return true
        }

        const links: string[] = []
        let usedId = ''
        for (const m of unsent.slice(0, 3)) {
          const msgKey = `${m.from}|${m.subject}|${m.date ?? ''}`
          const cached = getCachedLinks(msgKey)
          const found = cached ?? extractAllLinks(m.subject, m.from, m.body, m.html)
          if (cached === null && found.length) setCachedLinks(msgKey, found)
          if (found.length && !usedId) usedId = m.msgId
          for (const u of found) if (!links.includes(u)) links.push(u)
          if (links.length >= 5) break
        }

        if (!links.length) {
          await ctx.reply('Link tidak terdeteksi. Coba !am raw untuk lihat manual.')
          return true
        }

        if (!markLoginSent(senderJid, email, usedId || 'unknown')) {
          await ctx.reply(
            `Link login terakhir untuk ${email} sudah dikirim di atas. Kalau expired, buka app AM lagi untuk trigger email baru.`,
          )
          return true
        }

        logger.info(
          { provider: acc.provider, n: links.length, via: 'login' },
          'amprem login run',
        )
        await ctx.reply(
          `Link login Alight Motion:\n${links.join('\n\n')}\n\nBuka link ini di device yang mau login.`,
        )
        return true
      }

      async function handleLogin(ctx: CommandContext): Promise<void> {
        const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const rest = ctx.args.slice(1).join(' ').trim().split(/\s+/)
        const email = (rest[0] ?? '').toLowerCase()
        const wantWait = (rest[1] ?? '').toLowerCase() === 'wait'

        if (!email || !EMAIL_REGEX.test(email)) {
          await ctx.reply('Contoh: !am login email@domain.com')
          return
        }

        const acc = findAccount(senderJid, email)
        if (!acc) {
          await ctx.reply('Email tidak ditemukan di akun kamu.')
          return
        }

        if (!wantWait) {
          await doLoginFetch(ctx, senderJid, email, acc, Date.now())
          return
        }

        // Mode wait: poll 60 detik tiap 2 detik.
        const t0 = Date.now()
        const deadline = t0 + 60000
        let elapsed = 0
        await ctx.reply('Menunggu email login... (60s)')
        while (Date.now() < deadline) {
          const ok = await doLoginFetchOnce(ctx, senderJid, email, acc, t0, true)
          if (ok) return
          const left = deadline - Date.now()
          if (left <= 0) break
          await new Promise((r) => setTimeout(r, Math.min(2000, left)))
          elapsed = Math.floor((Date.now() - t0) / 1000)
          if (elapsed >= 10 && (elapsed % 10 === 0 || left < 3000)) {
            await ctx.reply(`Menunggu email login... (${elapsed}s)`)
          }
        }
        await ctx.reply(
          `Belum ada email login masuk dalam 60 detik. Pastikan kamu sudah masukkan ${email} di layar Sign In AM.`,
        )
      }

      // Versi sekali-fetch untuk mode wait. Return true kalau sudah selesai
      // (link terkirim / expired / error fatal), false kalau lanjut poll.
      async function doLoginFetchOnce(
        ctx: CommandContext,
        senderJid: string,
        email: string,
        acc: { email: string; token: string; provider: string; extra?: string },
        t0: number,
        quietEmpty: boolean,
      ): Promise<boolean> {
        const inbox: TempInbox = {
          email: acc.email,
          token: acc.token,
          provider: acc.provider as TempInbox['provider'],
          extra: acc.extra,
        }

        const res = await readInboxWithRetry(inbox)
        if (!res) {
          await ctx.reply('Service sedang down, coba lagi nanti.')
          return true
        }
        if (res.expired) {
          await ctx.reply('Inbox sudah tidak tersedia. Jalankan !am auto untuk akun baru.')
          return true
        }

        const fresh = filterLoginMessages(res.messages, t0)
        if (!fresh.length) return false

        const unsent = fresh.filter((m) => {
          const s = getLoginSent(senderJid, email)
          if (!s) return true
          if (s.messageId !== m.msgId) return true
          return Date.now() - s.sentAt >= 5 * 60 * 1000
        })
        if (!unsent.length) {
          await ctx.reply(
            `Link login terakhir untuk ${email} sudah dikirim di atas. Kalau expired, buka app AM lagi untuk trigger email baru.`,
          )
          return true
        }

        const links: string[] = []
        let usedId = ''
        for (const m of unsent.slice(0, 3)) {
          const found = extractAllLinks(m.subject, m.from, m.body, m.html)
          if (found.length && !usedId) usedId = m.msgId
          for (const u of found) if (!links.includes(u)) links.push(u)
          if (links.length >= 5) break
        }

        if (!links.length) {
          await ctx.reply('Link tidak terdeteksi. Coba !am raw untuk lihat manual.')
          return true
        }

        if (!markLoginSent(senderJid, email, usedId || 'unknown')) return true
        logger.info(
          { provider: acc.provider, n: links.length, via: 'login-wait' },
          'amprem login run',
        )
        await ctx.reply(
          `Link login Alight Motion:\n${links.join('\n\n')}\n\nBuka link ini di device yang mau login.`,
        )
        return true
      }

      // ── !am status <email> — preview tanpa extract ─────────────────────────
      async function handleStatus(ctx: CommandContext): Promise<void> {
        const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const email = ctx.args.slice(1).join(' ').trim().toLowerCase()

        if (!email || !EMAIL_REGEX.test(email)) {
          await ctx.reply('Contoh: !am status email@domain.com')
          return
        }

        const acc = findAccount(senderJid, email)
        if (!acc) {
          await ctx.reply('Email tidak ditemukan di akun kamu.')
          return
        }

        const inbox: TempInbox = {
          email: acc.email,
          token: acc.token,
          provider: acc.provider as TempInbox['provider'],
          extra: acc.extra,
        }

        const res = await readInboxWithRetry(inbox)
        if (!res) {
          await ctx.reply('Service sedang down, coba lagi nanti.')
          return
        }
        if (res.expired || !res.messages.length) {
          await ctx.reply(`Inbox: ${acc.email}\n\nBelum ada pesan.`)
          return
        }

        const sent = getLoginSent(senderJid, email)
        const latest = [...res.messages].sort((a, b) => b.ts - a.ts).slice(0, 5)
        const lines = [`Inbox: ${acc.email}`, '']
        for (const m of latest) {
          let when = m.date ?? ''
          try {
            if (when) when = new Date(when).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
          } catch {
            // tampilkan mentah
          }
          const isSent = sent?.messageId === m.msgId
          lines.push(
            `- ${when} — ${m.subject}`,
            `  Status: ${isSent ? 'SUDAH DIKIRIM' : 'BELUM DIKIRIM'}`,
          )
        }
        lines.push('', 'Aksi: jalankan !am login <email> untuk extract')
        await ctx.reply(lines.join('\n'))
      }

      // ── !am inbox <email> — 5 pesan terbaru, plain ─────────────────────────
      async function handleInbox(ctx: CommandContext): Promise<void> {
        const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const email = ctx.args.slice(1).join(' ').trim().toLowerCase()

        if (!email || !EMAIL_REGEX.test(email)) {
          await ctx.reply('Contoh: !am inbox email@domain.com')
          return
        }

        const acc = findAccount(senderJid, email)
        if (!acc) {
          await ctx.reply('Email tidak ditemukan di akun kamu.')
          return
        }

        const inbox: TempInbox = {
          email: acc.email,
          token: acc.token,
          provider: acc.provider as TempInbox['provider'],
          extra: acc.extra,
        }

        const res = await readInboxWithRetry(inbox)
        if (!res) {
          await ctx.reply('Service sedang down, coba lagi nanti.')
          return
        }
        if (res.expired) {
          await ctx.reply('Inbox sudah tidak tersedia di provider. Akun ini tidak bisa login lagi.')
          return
        }
        if (!res.messages.length) {
          await ctx.reply('Belum ada email baru, coba login dari app dulu.')
          return
        }

        const latest = res.messages.slice(-5).reverse()
        const lines = [`Inbox: ${acc.email}`, '']
        latest.forEach((m, i) => {
          let when = m.date ?? ''
          try {
            if (when) {
              const d = new Date(when)
              when = d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
            }
          } catch {
            // tampilkan mentah
          }
          lines.push(
            `[${i + 1}] ${when}`,
            `From: ${m.from}`,
            `Subject: ${m.subject}`,
            `Body: ${(m.body || '(kosong)').slice(0, 500)}`,
            '',
          )
        })
        await ctx.reply(lines.join('\n').slice(0, 3000))
      }

      // ── !am list — semua akun user ─────────────────────────────────────────
      async function handleList(ctx: CommandContext): Promise<void> {
        const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const accs = listAccounts(senderJid)
        if (!accs.length) {
          await ctx.reply('Belum ada akun. Buat dengan !am auto.')
          return
        }
        const lines = ['Daftar akun kamu:', '']
        accs.forEach((a, i) => {
          lines.push(`${i + 1}. ${a.email} (${a.provider}) — ${a.active ? 'aktif' : 'sementara'}`)
        })
        await ctx.reply(lines.join('\n'))
      }

      // ── !am forget <email> — hapus session ─────────────────────────────────
      async function handleForget(ctx: CommandContext): Promise<void> {
        const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const email = ctx.args.slice(1).join(' ').trim().toLowerCase()

        if (!email) {
          await ctx.reply('Contoh: !am forget email@domain.com')
          return
        }

        const sess = findAccount(senderJid, email)
        if (!removeAccount(senderJid, email)) {
          await ctx.reply('Email tidak ditemukan di akun kamu.')
          return
        }
        // Hapus fisik kalau masih temp (verified dibiarkan di provider).
        if (sess && !sess.active) {
          await deleteTempInbox({
            email: sess.email,
            token: sess.token,
            provider: sess.provider as TempInbox['provider'],
            extra: sess.extra,
          })
        }
        await ctx.reply(`Session ${email} dihapus.`)
      }

      // ── !am raw <email> — body mentah, tanpa parse ──────────────────────────
      async function handleRaw(ctx: CommandContext): Promise<void> {
        const senderJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const email = ctx.args.slice(1).join(' ').trim().toLowerCase()

        if (!email || !EMAIL_REGEX.test(email)) {
          await ctx.reply('Contoh: !am raw email@domain.com')
          return
        }

        const acc = findAccount(senderJid, email)
        if (!acc) {
          await ctx.reply('Email tidak ditemukan di akun kamu.')
          return
        }

        const inbox: TempInbox = {
          email: acc.email,
          token: acc.token,
          provider: acc.provider as TempInbox['provider'],
          extra: acc.extra,
        }

        const res = await readInboxWithRetry(inbox)
        if (!res) {
          await ctx.reply('Service sedang down, coba lagi nanti.')
          return
        }
        if (res.expired || !res.messages.length) {
          await ctx.reply('Inbox terakhir sudah expire atau kosong. Jalankan !am auto lagi.')
          return
        }

        const m = res.messages[res.messages.length - 1]
        if (!m) {
          await ctx.reply('Inbox terakhir sudah expire atau kosong. Jalankan !am auto lagi.')
          return
        }
        // Mentah apa adanya — tidak di-parse, tidak di-decode.
        const raw = `From: ${m.from}\nSubject: ${m.subject}\n\n${m.body || m.html || '(kosong)'}`
        await ctx.reply(`Raw message:\n\n${raw}`.slice(0, 3000))
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
