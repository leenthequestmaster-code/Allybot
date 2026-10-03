const SESSION_TTL_MS = 10 * 60 * 1000 // 10 minutes

interface SessionEntry {
  email: string
  expiresAt: number
}

const store = new Map<string, SessionEntry>()

export function setSession(jid: string, email: string): void {
  store.set(jid, { email, expiresAt: Date.now() + SESSION_TTL_MS })
}

export function getSession(jid: string): string | null {
  const entry = store.get(jid)
  if (!entry) return null

  if (Date.now() > entry.expiresAt) {
    store.delete(jid)
    return null
  }

  return entry.email
}

export function clearSession(jid: string): void {
  store.delete(jid)
}
