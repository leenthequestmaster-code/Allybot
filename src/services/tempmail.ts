// Adapter inbox email sementara untuk mode auto !amprem.
// Chain: mail.tm -> mailboxtemp -> tempmail.lol (v2 API).
// Semua network call: timeout 15s + retry 1x untuk network error.

import { randomBytes } from 'crypto'

export interface TempInbox {
  email: string
  token: string
  provider: 'mail.tm' | 'mailboxtemp' | 'tempmail.lol'
  extra?: string
}

export interface FoundLink {
  link: string
  subject: string
}

export interface WaitOpts {
  timeoutMs?: number
  pollIntervalMs?: number
}

const FETCH_TIMEOUT_MS = 15000

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // non-JSON — biarin null
    }
    return { status: res.status, json: body }
  } finally {
    clearTimeout(timer)
  }
}

// Retry 1x untuk network error/timeout. HTTP 4xx/5xx return langsung.
async function fetchJsonRetry(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; json: unknown }> {
  try {
    return await fetchJson(url, init)
  } catch {
    return await fetchJson(url, init)
  }
}

// ── Ekstraksi link verifikasi ────────────────────────────────────────────────
// Urutan: link Firebase penuh dulu, lalu URL verify-ish, terakhir oobCode mentah
// (auth.code di am-reverse bisa parse raw code juga).

const FIREBASE_LINK_RE = /https:\/\/alight-creative\.firebaseapp\.com[^\s'"<>]+/
const VERIFY_URL_RE = /https?:\/\/\S*(?:verify|auth|confirm|activate|firebaseapp\.com)[^\s'"<>]*/i
const OOB_RE = /oobCode=([A-Za-z0-9_-]{10,})/

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
}

export function extractVerificationLink(
  ...parts: Array<string | null | undefined>
): string | null {
  const texts = parts.filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  )
  for (const t of texts) {
    const m = t.match(FIREBASE_LINK_RE)
    if (m) return decodeEntities(m[0])
  }
  for (const t of texts) {
    const m = t.match(VERIFY_URL_RE)
    if (m) return decodeEntities(m[0])
  }
  for (const t of texts) {
    const m = t.match(OOB_RE)
    if (m) return m[1]
  }
  return null
}

// ── Poll loop generik ────────────────────────────────────────────────────────

interface StepResult {
  done: FoundLink | null
  rateLimited: boolean
  stop: boolean
}

async function pollLoop(
  opts: WaitOpts,
  step: () => Promise<StepResult>,
): Promise<FoundLink | null> {
  const timeoutMs = opts.timeoutMs ?? 60000
  const base = opts.pollIntervalMs ?? 2000
  let interval = base
  const t0 = Date.now()

  while (Date.now() - t0 < timeoutMs) {
    let s: StepResult
    try {
      s = await step()
    } catch {
      s = { done: null, rateLimited: false, stop: false }
    }
    if (s.done) return s.done
    if (s.stop) return null
    interval = s.rateLimited ? Math.min(interval * 1.5, 15000) : base

    const remaining = timeoutMs - (Date.now() - t0)
    if (remaining <= 0) break
    await new Promise((r) => setTimeout(r, Math.min(interval, remaining)))
  }
  return null
}

// ── Provider 1: mail.tm ─────────────────────────────────────────────────────
// POST /accounts {address, password} -> POST /token -> Bearer JWT.
// Domain dibaca dari GET /domains (jangan hardcode).

async function mailtmCreate(): Promise<TempInbox> {
  const d = await fetchJsonRetry('https://api.mail.tm/domains')
  const rec = d.json as { 'hydra:member'?: Array<{ isActive?: boolean; domain?: string }> }
  const active = (rec?.['hydra:member'] ?? []).find((x) => x?.isActive && x?.domain)
  if (!active?.domain) throw new Error('mail.tm: no active domain')

  const email = `am${randomBytes(6).toString('hex')}@${active.domain}`
  const password = randomBytes(12).toString('hex')
  const payload = JSON.stringify({ address: email, password })

  const acc = await fetchJsonRetry('https://api.mail.tm/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  })
  if (acc.status !== 200 && acc.status !== 201) {
    throw new Error(`mail.tm create account: ${acc.status}`)
  }

  const tok = await fetchJsonRetry('https://api.mail.tm/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  })
  const tokRec = tok.json as { token?: string } | null
  if (!tokRec?.token) throw new Error('mail.tm: no token')

  const accRec = acc.json as { id?: string } | null
  return { email, token: tokRec.token, provider: 'mail.tm', extra: accRec?.id }
}

async function mailtmWait(token: string, opts: WaitOpts): Promise<FoundLink | null> {
  const auth = { Authorization: `Bearer ${token}` }
  return pollLoop(opts, async () => {
    const r = await fetchJsonRetry('https://api.mail.tm/messages', { headers: auth })
    if (r.status === 429) return { done: null, rateLimited: true, stop: false }
    const rec = r.json as { 'hydra:member'?: Array<{ id?: string }> } | null
    const members = rec?.['hydra:member'] ?? []
    for (const m of members) {
      if (!m?.id) continue
      const d = await fetchJsonRetry(`https://api.mail.tm/messages/${m.id}`, {
        headers: auth,
      })
      const msg = d.json as {
        subject?: string
        text?: string
        html?: string[] | string
      } | null
      const html = Array.isArray(msg?.html) ? msg.html.join('\n') : (msg?.html ?? '')
      const link = extractVerificationLink(msg?.text, html)
      if (link) return { done: { link, subject: msg?.subject ?? '' }, rateLimited: false, stop: false }
    }
    return { done: null, rateLimited: false, stop: false }
  })
}

// ── Provider 2: mailboxtemp ─────────────────────────────────────────────────
// POST /api/inbox/generate {tier:free} -> {address}.
// Poll: GET /api/inbox/{address}/emails. Inbox expire otomatis (+10 mnt).

async function mbtCreate(): Promise<TempInbox> {
  const r = await fetchJsonRetry('https://mailboxtemp.com/api/inbox/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tier: 'free' }),
  })
  const rec = r.json as { ok?: boolean; address?: string } | null
  if (!rec?.ok || !rec?.address) throw new Error(`mailboxtemp create: ${r.status}`)
  return { email: rec.address, token: rec.address, provider: 'mailboxtemp' }
}

async function mbtWait(address: string, opts: WaitOpts): Promise<FoundLink | null> {
  const enc = encodeURIComponent(address)
  return pollLoop(opts, async () => {
    const r = await fetchJsonRetry(`https://mailboxtemp.com/api/inbox/${enc}/emails`)
    if (r.status === 429) return { done: null, rateLimited: true, stop: false }
    const rec = r.json as { emails?: Array<Record<string, unknown>> } | null
    const emails = rec?.emails ?? []
    for (const e of emails) {
      let subject = typeof e['subject'] === 'string' ? (e['subject'] as string) : ''
      let body =
        typeof e['body'] === 'string'
          ? (e['body'] as string)
          : typeof e['text'] === 'string'
            ? (e['text'] as string)
            : ''
      let html = typeof e['html'] === 'string' ? (e['html'] as string) : ''

      // List tidak bawa body — fetch detail per pesan.
      if (!body && !html && typeof e['id'] === 'string') {
        const d = await fetchJsonRetry(
          `https://mailboxtemp.com/api/email/${enc}/${encodeURIComponent(e['id'] as string)}`,
        )
        const em = ((d.json as { email?: Record<string, unknown> } | null)?.email ??
          d.json ?? {}) as Record<string, unknown>
        if (typeof em['subject'] === 'string') subject = em['subject'] as string
        if (typeof em['body'] === 'string') body = em['body'] as string
        else if (typeof em['text'] === 'string') body = em['text'] as string
        const h = em['html']
        html = Array.isArray(h) ? h.join('\n') : typeof h === 'string' ? h : ''
      }

      const link = extractVerificationLink(subject, body, html)
      if (link) return { done: { link, subject }, rateLimited: false, stop: false }
    }
    return { done: null, rateLimited: false, stop: false }
  })
}

// ── Provider 3: tempmail.lol (v2) ───────────────────────────────────────────
// POST /v2/inbox/create {} -> {address, token}.
// Poll: GET /v2/inbox?token= -> {emails: [{subject, body, html}]}.

async function tmlCreate(): Promise<TempInbox> {
  const r = await fetchJsonRetry('https://api.tempmail.lol/v2/inbox/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'TempMailJS/4.4.0' },
    body: JSON.stringify({}),
  })
  if (r.status !== 200 && r.status !== 201) {
    throw new Error(`tempmail.lol create: ${r.status}`)
  }
  const rec = r.json as { address?: string; token?: string } | null
  if (!rec?.address || !rec?.token) throw new Error('tempmail.lol: bad create response')
  return { email: rec.address, token: rec.token, provider: 'tempmail.lol' }
}

async function tmlWait(token: string, opts: WaitOpts): Promise<FoundLink | null> {
  return pollLoop(opts, async () => {
    const r = await fetchJsonRetry(
      `https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(token)}`,
      { headers: { 'User-Agent': 'TempMailJS/4.4.0' } },
    )
    if (r.status === 429) return { done: null, rateLimited: true, stop: false }
    const rec = r.json as {
      expired?: boolean
      emails?: Array<{ subject?: string; body?: string; html?: string }>
    } | null
    if (rec?.expired) return { done: null, rateLimited: false, stop: true }
    for (const e of rec?.emails ?? []) {
      const link = extractVerificationLink(e?.subject, e?.body, e?.html)
      if (link) return { done: { link, subject: e?.subject ?? '' }, rateLimited: false, stop: false }
    }
    return { done: null, rateLimited: false, stop: false }
  })
}

// ── API publik ───────────────────────────────────────────────────────────────

export async function createTempInbox(preferred?: string[]): Promise<TempInbox> {
  const order =
    preferred && preferred.length ? preferred : ['mail.tm', 'mailboxtemp', 'tempmail.lol']
  const creators: Record<string, () => Promise<TempInbox>> = {
    'mail.tm': mailtmCreate,
    mailboxtemp: mbtCreate,
    'tempmail.lol': tmlCreate,
  }

  let lastErr: unknown = null
  for (const name of order) {
    const fn = creators[name]
    if (!fn) continue
    try {
      return await fn()
    } catch (err) {
      lastErr = err
    }
  }
  throw Object.assign(
    new Error('Semua penyedia email sementara sedang tidak tersedia.'),
    { code: 'TEMPMAIL_ALL_DOWN', cause: lastErr },
  )
}

export async function waitForVerificationLink(
  inbox: TempInbox,
  opts?: WaitOpts,
): Promise<FoundLink | null> {
  const o = opts ?? {}
  if (inbox.provider === 'mail.tm') return mailtmWait(inbox.token, o)
  if (inbox.provider === 'mailboxtemp') return mbtWait(inbox.token, o)
  return tmlWait(inbox.token, o)
}

// Best-effort. mailboxtemp + tempmail.lol expire otomatis (no-op).
export async function deleteTempInbox(inbox: TempInbox): Promise<void> {
  try {
    if (inbox.provider === 'mail.tm' && inbox.extra) {
      await fetchJson(`https://api.mail.tm/accounts/${inbox.extra}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${inbox.token}` },
      })
    }
  } catch {
    // abaikan — inbox expire sendiri
  }
}
