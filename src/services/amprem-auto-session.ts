// Session inbox auto terakhir per user — untuk recovery via !amprem last.
// Persist JSON (survive restart). TTL 30 menit.

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const SESSIONS_PATH = resolve('/opt/Allybot/data/amprem_sessions.json')
const TTL_MS = 30 * 60 * 1000

export interface AutoSession {
  email: string
  token: string
  provider: string
  extra?: string
  createdAt: number
  expiresAt: number
}

const state: Record<string, AutoSession> = {}
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

function prune(): void {
  const now = Date.now()
  for (const jid of Object.keys(state)) {
    const s = state[jid]
    if (!s || now > s.expiresAt) {
      delete state[jid]
      dirty = true
    }
  }
  if (dirty) schedulePersist()
}

export function restoreAutoSessions(): void {
  if (!existsSync(SESSIONS_PATH)) return
  try {
    const data = JSON.parse(
      readFileSync(SESSIONS_PATH, 'utf8'),
    ) as Record<string, AutoSession>
    Object.assign(state, data)
  } catch {
    // corrupt — mulai fresh
  }
  prune()
}

export function saveAutoSession(jid: string, s: Omit<AutoSession, 'createdAt' | 'expiresAt'>): void {
  const now = Date.now()
  state[jid] = { ...s, createdAt: now, expiresAt: now + TTL_MS }
  dirty = true
  schedulePersist()
}

export function getAutoSession(jid: string): AutoSession | null {
  const s = state[jid]
  if (!s) return null
  if (Date.now() > s.expiresAt) {
    delete state[jid]
    dirty = true
    schedulePersist()
    return null
  }
  return s
}

export function clearAutoSession(jid: string): void {
  if (state[jid]) {
    delete state[jid]
    dirty = true
    schedulePersist()
  }
}
