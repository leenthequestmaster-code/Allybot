// Adapter inbox email sementara untuk mode auto !amprem.
// Chain: mail.tm -> mailboxtemp -> tempmail.lol (v2 API).
// Semua network call: timeout 15s + retry 1x untuk network error.
// Polling tempmail.lol: baca penuh via ?token= (tanpa /auth/), list sering
// kosong walau pesan ada (eventual consistency di sisi provider).

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
  rawPreview?: string
}

export interface WaitOpts {
  timeoutMs?: number
  pollIntervalMs?: number
  onPoll?: (info: PollInfo) => void
}

export interface PollInfo {
  provider: string
  poll: number
  httpStatus: number
  count: number
  firstSubject: string
  firstFrom: string
  bodyHead: string
  matched: boolean
}

export interface InboxMessage {
  from: string
  subject: string
  body: string
  html: string
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
// Link Firebase: outer wrapper terpotong di %26 (encoded &), tapi inner URL
// tetap utuh — auth.code() di am-reverse bisa parse oobCode dari inner.
// Urutan: inner alightcreative.com/auth_action > outer firebaseapp >
// URL verify-ish lain > oobCode mentah.

const INNER_AUTH_RE = /https:\/\/alightcreative\.com\/auth_action\/[^\s'"<>]+/
const FIREBASE_LINK_RE = /https:\/\/alight-creative\.firebaseapp\.com[^\s'"<>]+/
const VERIFY_URL_RE =
  /https?:\/\/\S*(?:verify|auth|confirm|activate|login|firebaseapp\.com|continueUrl|oobCode)[^\s'"<>]*/i
const OOB_RE = /oobCode[%=_3D]+([A-Za-z0-9_-]{10,})/

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
}

export function extractVerificationLink(
  ...parts: Array<string | null | undefined>
): string | null {
  const texts = parts.filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  )
  // 1. Inner auth_action — URL verifikasi asli, param paling lengkap.
  const inners: string[] = []
  for (const t of texts) {
    const m = t.match(INNER_AUTH_RE)
    if (m) inners.push(decodeEntities(m[0]))
  }
  if (inners.length) {
    inners.sort((a, b) => b.length - a.length)
    return inners[0] as string
  }
  // 2. Outer Firebase wrapper.
  for (const t of texts) {
    const m = t.match(FIREBASE_LINK_RE)
    if (m) return decodeEntities(m[0])
  }
  // 3. URL verify-ish lain — ambil yang terpanjang.
  const cands: string[] = []
  for (const t of texts) {
    const all = t.match(
      new RegExp(VERIFY_URL_RE.source, VERIFY_URL_RE.flags + 'g'),
    )
    if (all) for (const u of all) cands.push(decodeEntities(u))
  }
  if (cands.length) {
    cands.sort((a, b) => b.length - a.length)
    return cands[0] as string
  }
  // 4. oobCode mentah (decode %3D/%26 dulu karena Firebase encode param).
  for (const t of texts) {
    const dec = t.replace(/%3D/gi, '=').replace(/%26/gi, '&')
    const m = dec.match(OOB_RE)
    if (m) return m[1] as string
  }
  return null
}

// ── Poll loop generik ────────────────────────────────────────────────────────

interface StepResult {
  done: FoundLink | null
  rateLimited: boolean
  stop: boolean
  httpStatus: number
  count: number
  firstSubject: string
  firstFrom: string
  bodyHead: string
  matched: boolean
}

async function pollLoop(
  provider: string,
  opts: WaitOpts,
  step: () => Promise<StepResult>,
): Promise<FoundLink | null> {
  const timeoutMs = opts.timeoutMs ?? 60000
  const base = opts.pollIntervalMs ?? 2000
  let interval = base
  let poll = 0
  const t0 = Date.now()

  while (Date.now() - t0 < timeoutMs) {
    poll++
    let s: StepResult
    try {
      s = await step()
    } catch {
      s = {
        done: null, rateLimited: false, stop: false,
        httpStatus: -1, count: -1, firstSubject: '', firstFrom: '',
        bodyHead: '', matched: false,
      }
    }
    if (opts.onPoll) {
      try {
        opts.onPoll({
          provider, poll,
          httpStatus: s.httpStatus, count: s.count,
          firstSubject: s.firstSubject, firstFrom: s.firstFrom,
          bodyHead: s.bodyHead.slice(0, 100), matched: s.matched,
        })
      } catch {
        // callback log jangan ganggu loop
      }
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

async function mailtmWait(
  token: string,
  opts: WaitOpts,
): Promise<FoundLink | null> {
  const auth = { Authorization: `Bearer ${token}` }
  return pollLoop('mail.tm', opts, async () => {
    const blank = {
      done: null, rateLimited: false, stop: false,
      httpStatus: -1, count: 0, firstSubject: '', firstFrom: '',
      bodyHead: '', matched: false,
    }
    const r = await fetchJsonRetry('https://api.mail.tm/messages', { headers: auth })
    blank.httpStatus = r.status
    if (r.status === 429) return { ...blank, rateLimited: true }
    const rec = r.json as { 'hydra:member'?: Array<{ id?: string }> } | null
    const members = rec?.['hydra:member'] ?? []
    blank.count = members.length
    for (const m of members) {
      if (!m?.id) continue
      const d = await fetchJsonRetry(`https://api.mail.tm/messages/${m.id}`, {
        headers: auth,
      })
      const msg = d.json as {
        from?: { address?: string }
        subject?: string
        text?: string
        html?: string[] | string
      } | null
      const from = msg?.from?.address ?? ''
      const subject = msg?.subject ?? ''
      const html = Array.isArray(msg?.html) ? msg.html.join('\n') : (msg?.html ?? '')
      const text = msg?.text ?? ''
      if (!blank.firstSubject) {
        blank.firstSubject = subject
        blank.firstFrom = from
        blank.bodyHead = text || html
      }
      const link = extractVerificationLink(subject, from, text, html)
      if (link) {
        return {
          ...blank, matched: true,
          done: { link, subject, rawPreview: (subject + '\n' + (text || html)).slice(0, 500) },
        }
      }
    }
    return blank
  })
}

export async function mailtmReadAll(token: string): Promise<InboxMessage[]> {
  const auth = { Authorization: `Bearer ${token}` }
  const out: InboxMessage[] = []
  const r = await fetchJsonRetry('https://api.mail.tm/messages', { headers: auth })
  const rec = r.json as { 'hydra:member'?: Array<{ id?: string }> } | null
  for (const m of rec?.['hydra:member'] ?? []) {
    if (!m?.id) continue
    const d = await fetchJsonRetry(`https://api.mail.tm/messages/${m.id}`, {
      headers: auth,
    })
    const msg = d.json as {
      from?: { address?: string }
      subject?: string
      text?: string
      html?: string[] | string
    } | null
    const html = Array.isArray(msg?.html) ? msg.html.join('\n') : (msg?.html ?? '')
    out.push({
      from: msg?.from?.address ?? '',
      subject: msg?.subject ?? '',
      body: msg?.text ?? '',
      html,
    })
  }
  return out
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

interface MbtEmail {
  id?: string
  subject?: string
  from?: string
  sender?: string
  body?: string
  text?: string
  html?: string
}

function mbtNormalize(e: Record<string, unknown>): MbtEmail {
  return {
    id: typeof e['id'] === 'string' ? (e['id'] as string) : undefined,
    subject: typeof e['subject'] === 'string' ? (e['subject'] as string) : '',
    from:
      typeof e['from'] === 'string'
        ? (e['from'] as string)
        : typeof e['sender'] === 'string'
          ? (e['sender'] as string)
          : '',
    body:
      typeof e['body'] === 'string'
        ? (e['body'] as string)
        : typeof e['text'] === 'string'
          ? (e['text'] as string)
          : '',
    html: typeof e['html'] === 'string' ? (e['html'] as string) : '',
  }
}

async function mbtWait(
  address: string,
  opts: WaitOpts,
): Promise<FoundLink | null> {
  const enc = encodeURIComponent(address)
  return pollLoop('mailboxtemp', opts, async () => {
    const blank = {
      done: null, rateLimited: false, stop: false,
      httpStatus: -1, count: 0, firstSubject: '', firstFrom: '',
      bodyHead: '', matched: false,
    }
    const r = await fetchJsonRetry(`https://mailboxtemp.com/api/inbox/${enc}/emails`)
    blank.httpStatus = r.status
    if (r.status === 429) return { ...blank, rateLimited: true }
    const rec = r.json as { emails?: Array<Record<string, unknown>> } | null
    const emails = (rec?.emails ?? []).map(mbtNormalize)
    blank.count = emails.length
    for (const e of emails) {
      let { subject, from, body, html } = e
      subject = subject ?? ''
      from = from ?? ''
      body = body ?? ''
      html = html ?? ''

      // List tidak bawa body — fetch detail per pesan.
      if (!body && !html && e.id) {
        const d = await fetchJsonRetry(
          `https://mailboxtemp.com/api/email/${enc}/${encodeURIComponent(e.id)}`,
        )
        const em = ((d.json as { email?: Record<string, unknown> } | null)?.email ??
          d.json ?? {}) as Record<string, unknown>
        const n = mbtNormalize(em)
        if (n.subject) subject = n.subject
        if (n.from) from = n.from
        if (n.body) body = n.body
        if (n.html) html = n.html
      }

      if (!blank.firstSubject) {
        blank.firstSubject = subject
        blank.firstFrom = from
        blank.bodyHead = body || html
      }
      const link = extractVerificationLink(subject, from, body, html)
      if (link) {
        return {
          ...blank, matched: true,
          done: { link, subject, rawPreview: (subject + '\n' + (body || html)).slice(0, 500) },
        }
      }
    }
    return blank
  })
}

export async function mbtReadAll(address: string): Promise<InboxMessage[]> {
  const enc = encodeURIComponent(address)
  const out: InboxMessage[] = []
  const r = await fetchJsonRetry(`https://mailboxtemp.com/api/inbox/${enc}/emails`)
  const rec = r.json as { emails?: Array<Record<string, unknown>> } | null
  for (const raw of rec?.emails ?? []) {
    const e = mbtNormalize(raw)
    let { subject, from, body, html } = e
    if (!body && !html && e.id) {
      const d = await fetchJsonRetry(
        `https://mailboxtemp.com/api/email/${enc}/${encodeURIComponent(e.id)}`,
      )
      const em = ((d.json as { email?: Record<string, unknown> } | null)?.email ??
        d.json ?? {}) as Record<string, unknown>
      const n = mbtNormalize(em)
      if (n.subject) subject = n.subject
      if (n.from) from = n.from
      if (n.body) body = n.body
      if (n.html) html = n.html
    }
    out.push({ from: from ?? '', subject: subject ?? '', body: body ?? '', html: html ?? '' })
  }
  return out
}

// ── Provider 3: tempmail.lol (v2) ───────────────────────────────────────────
// POST /v2/inbox/create {} -> {address, token}.
// Poll: GET /v2/inbox?token= (FULL read — list & auth endpoint beda data,
// list /auth/ sering kosong walau pesan sudah ada).

const TML_UA = { 'User-Agent': 'TempMailJS/4.4.0' }

interface TmlEmail {
  from?: string
  subject?: string
  body?: string
  html?: string
}

function tmlNormalize(e: Record<string, unknown>): TmlEmail {
  const from =
    typeof e['from'] === 'string'
      ? (e['from'] as string)
      : typeof (e['from'] as { address?: unknown } | null)?.address === 'string'
        ? ((e['from'] as { address: string }).address)
        : ''
  const html = Array.isArray(e['html'])
    ? (e['html'] as string[]).join('\n')
    : typeof e['html'] === 'string'
      ? (e['html'] as string)
      : ''
  return {
    from,
    subject: typeof e['subject'] === 'string' ? (e['subject'] as string) : '',
    body: typeof e['body'] === 'string' ? (e['body'] as string) : '',
    html,
  }
}

async function tmlCreate(): Promise<TempInbox> {
  const r = await fetchJsonRetry('https://api.tempmail.lol/v2/inbox/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...TML_UA },
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
  const url = `https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(token)}`
  return pollLoop('tempmail.lol', opts, async () => {
    const blank = {
      done: null, rateLimited: false, stop: false,
      httpStatus: -1, count: 0, firstSubject: '', firstFrom: '',
      bodyHead: '', matched: false,
    }
    const r = await fetchJsonRetry(url, { headers: TML_UA })
    blank.httpStatus = r.status
    if (r.status === 429) return { ...blank, rateLimited: true }
    const rec = r.json as {
      expired?: boolean
      emails?: Array<Record<string, unknown>>
    } | null
    if (rec?.expired) return { ...blank, stop: true }
    const emails = (rec?.emails ?? []).map(tmlNormalize)
    blank.count = emails.length
    for (const e of emails) {
      if (!blank.firstSubject) {
        blank.firstSubject = e.subject ?? ''
        blank.firstFrom = e.from ?? ''
        blank.bodyHead = e.body || e.html || ''
      }
      const link = extractVerificationLink(e.subject, e.from, e.body, e.html)
      if (link) {
        return {
          ...blank, matched: true,
          done: {
            link, subject: e.subject ?? '',
            rawPreview: ((e.subject ?? '') + '\n' + (e.body || e.html || '')).slice(0, 500),
          },
        }
      }
    }
    return blank
  })
}

export async function tmlReadAll(token: string): Promise<InboxMessage[]> {
  const r = await fetchJsonRetry(
    `https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(token)}`,
    { headers: TML_UA },
  )
  const rec = r.json as { emails?: Array<Record<string, unknown>> } | null
  return (rec?.emails ?? []).map((raw) => {
    const e = tmlNormalize(raw)
    return { from: e.from ?? '', subject: e.subject ?? '', body: e.body ?? '', html: e.html ?? '' }
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

// Baca ulang inbox terakhir (untuk !amprem last) + extract link.
// Return null kalau inbox kosong/expire.
export async function readLastLink(inbox: TempInbox): Promise<{
  link: string | null
  messages: InboxMessage[]
} | null> {
  let messages: InboxMessage[] = []
  try {
    if (inbox.provider === 'mail.tm') messages = await mailtmReadAll(inbox.token)
    else if (inbox.provider === 'mailboxtemp') messages = await mbtReadAll(inbox.token)
    else messages = await tmlReadAll(inbox.token)
  } catch {
    return null
  }
  if (!messages.length) return { link: null, messages }
  for (const m of messages) {
    const link = extractVerificationLink(m.subject, m.from, m.body, m.html)
    if (link) return { link, messages }
  }
  return { link: null, messages }
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
