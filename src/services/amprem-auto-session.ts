// Session akun auto !amprem — persist JSON (survive restart).
// Satu user bisa punya banyak akun: Record<jid, StoredAccount[]>.
// Temp (active:false, expiresAt 30 mnt) dipakai !am last untuk recovery.
// Verified (active:true, tanpa expiry) dipakai !am login/inbox/list.
// Migrasi otomatis dari format lama (single object per JID, v1.4).

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const SESSIONS_PATH = resolve('/opt/Allybot/data/amprem_sessions.json')
const TEMP_TTL_MS = 30 * 60 * 1000

export interface StoredAccount {
  email: string
  token: string
  provider: string
  extra?: string
  createdAt: number
  expiresAt?: number
  verifiedAt?: number
  active: boolean
}

// Alias legacy — !am last pakai shape ini.
export type AutoSession = StoredAccount

const state: Record<string, StoredAccount[]> = {}
let dirty = false
let debounceTimer: NodeJS.Timeout | null = null

function schedulePersist(): void {
  if (debounceTimer) return
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (!dirty) return
    try {
      writeFileSync(SESSIONS_PATH, JSON.stringify(state, null, 2), 'utf8')
      dirty = false
    } catch {
      // best-effort
    }
  }, 500)
}

function isValidAccount(a: unknown): a is StoredAccount {
  if (typeof a !== 'object' || a === null) return false
  const r = a as Record<string, unknown>
  return (
    typeof r['email'] === 'string' &&
    typeof r['token'] === 'string' &&
    typeof r['provider'] === 'string'
  )
}

// Hapus temp yang expired. Verified (active:true) permanen.
function prune(): void {
  const now = Date.now()
  for (const jid of Object.keys(state)) {
    const list = state[jid]
    if (!Array.isArray(list)) {
      delete state[jid]
      dirty = true
      continue
    }
    const kept = list.filter(
      (a) => a.active || !a.expiresAt || now <= a.expiresAt,
    )
    if (kept.length !== list.length) {
      dirty = true
      if (kept.length) state[jid] = kept
      else delete state[jid]
    }
  }
  if (dirty) schedulePersist()
}

export function restoreAutoSessions(): void {
  if (!existsSync(SESSIONS_PATH)) return
  try {
    const data = JSON.parse(readFileSync(SESSIONS_PATH, 'utf8')) as Record<
      string,
      unknown
    >
    for (const jid of Object.keys(data)) {
      const v = data[jid]
      if (Array.isArray(v)) {
        const valid = v.filter(isValidAccount).map((a) => ({
          ...a,
          active: a.active === true,
        }))
        if (valid.length) state[jid] = valid
      } else if (isValidAccount(v)) {
        // Migrasi format lama: single object → array, anggap temp.
        const now = Date.now()
        state[jid] = [
          {
            ...v,
            active: false,
            createdAt: typeof v.createdAt === 'number' ? v.createdAt : now,
            expiresAt:
              typeof v.expiresAt === 'number' ? v.expiresAt : now + TEMP_TTL_MS,
          },
        ]
      }
    }
  } catch {
    // corrupt — mulai fresh
  }
  prune()
}

// Simpan/update temp session untuk !am last. Upsert per email.
export function saveAutoSession(
  jid: string,
  s: { email: string; token: string; provider: string; extra?: string },
): void {
  const now = Date.now()
  const list = state[jid] ?? []
  const idx = list.findIndex(
    (a) => a.email.toLowerCase() === s.email.toLowerCase() && !a.active,
  )
  const entry: StoredAccount = {
    ...s,
    createdAt: now,
    expiresAt: now + TEMP_TTL_MS,
    active: false,
  }
  if (idx >= 0) list[idx] = entry
  else list.push(entry)
  state[jid] = list
  dirty = true
  schedulePersist()
}

// Session terbaru untuk !am last: temp non-expired, fallback ke verified.
export function getAutoSession(jid: string): AutoSession | null {
  const list = state[jid]
  if (!list || !list.length) return null
  const now = Date.now()
  const usable = list.filter((a) => a.active || !a.expiresAt || now <= a.expiresAt)
  if (!usable.length) {
    prune()
    return null
  }
  usable.sort((a, b) => b.createdAt - a.createdAt)
  return (usable[0] ?? null) as AutoSession | null
}

// Tandai verified — jadi permanen (hapus expiresAt).
export function markAccountVerified(jid: string, email: string): boolean {
  const list = state[jid]
  if (!list) return false
  const acc = list.find((a) => a.email.toLowerCase() === email.toLowerCase())
  if (!acc) return false
  acc.active = true
  acc.verifiedAt = Date.now()
  delete acc.expiresAt
  dirty = true
  schedulePersist()
  return true
}

// Hapus SATU temp entry (cleanup gagal/timeout). Verified tidak tersentuh.
export function removeTempSession(jid: string, email: string): void {
  const list = state[jid]
  if (!list) return
  const kept = list.filter(
    (a) => a.active || a.email.toLowerCase() !== email.toLowerCase(),
  )
  if (kept.length !== list.length) {
    dirty = true
    if (kept.length) state[jid] = kept
    else delete state[jid]
    schedulePersist()
  }
}

// Hapus semua temp milik user, verified tetap (legacy !am last cleanup).
export function clearAutoSession(jid: string): void {
  const list = state[jid]
  if (!list) return
  const kept = list.filter((a) => a.active)
  dirty = true
  if (kept.length) state[jid] = kept
  else delete state[jid]
  schedulePersist()
}

// Cari akun milik user (temp valid atau verified). Cross-user ditolak.
export function findAccount(jid: string, email: string): StoredAccount | null {
  const list = state[jid]
  if (!list) return null
  const now = Date.now()
  return (
    list.find(
      (a) =>
        a.email.toLowerCase() === email.toLowerCase() &&
        (a.active || !a.expiresAt || now <= a.expiresAt),
    ) ?? null
  )
}

export function listAccounts(jid: string): StoredAccount[] {
  const list = state[jid]
  if (!list) return []
  const now = Date.now()
  return list
    .filter((a) => a.active || !a.expiresAt || now <= a.expiresAt)
    .sort((a, b) => a.createdAt - b.createdAt)
}

// Hapus akun (temp maupun verified). Return true kalau ada yang dihapus.
export function removeAccount(jid: string, email: string): boolean {
  const list = state[jid]
  if (!list) return false
  const kept = list.filter((a) => a.email.toLowerCase() !== email.toLowerCase())
  if (kept.length === list.length) return false
  dirty = true
  if (kept.length) state[jid] = kept
  else delete state[jid]
  schedulePersist()
  return true
}
