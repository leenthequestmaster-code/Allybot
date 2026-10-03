// Rate limit khusus auto !amprem — file terpisah dari limiter musik.
// Cooldown per user (bukan per group, auto spam-prone).
// Persist JSON agar survive restart bot.

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const AUTO_LIMITS_PATH = resolve('/opt/Allybot/data/amprem_auto_limits.json')

interface AutoRecord {
  used: number
  date: string // YYYY-MM-DD (WIB)
  lastRun: number // epoch ms
}

const state: Record<string, AutoRecord> = {}
let dirty = false
let debounceTimer: NodeJS.Timeout | null = null

function todayWIB(): string {
  const now = new Date()
  const ms = now.getTime() + now.getTimezoneOffset() * 60000 + 7 * 3600000
  const d = new Date(ms)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function schedulePersist(): void {
  if (debounceTimer) return
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (!dirty) return
    try {
      writeFileSync(AUTO_LIMITS_PATH, JSON.stringify(state, null, 2), 'utf8')
      dirty = false
    } catch {
      // best-effort
    }
  }, 500)
}

export function restoreAutoLimits(): void {
  if (!existsSync(AUTO_LIMITS_PATH)) return
  try {
    const data = JSON.parse(
      readFileSync(AUTO_LIMITS_PATH, 'utf8'),
    ) as Record<string, AutoRecord>
    Object.assign(state, data)
  } catch {
    // corrupt — mulai fresh
  }
}

export interface AutoLimitConfig {
  cooldownMs: number
  quotaDefault: number
  quotaPremium: number
}

// Owner selalu lolos. Premium/hal biasa dicek quota + cooldown.
export function checkAutoLimit(
  userJid: string,
  tier: 'owner' | 'premium' | 'free',
  cfg: AutoLimitConfig,
): { ok: boolean; reason?: 'COOLDOWN' | 'QUOTA'; waitMs?: number } {
  if (tier === 'owner') return { ok: true }

  const now = Date.now()
  const quota = tier === 'premium' ? cfg.quotaPremium : cfg.quotaDefault
  const rec = state[userJid]

  if (rec) {
    if (rec.date !== todayWIB()) {
      delete state[userJid]
      dirty = true
      schedulePersist()
    } else {
      const sinceLast = now - rec.lastRun
      if (sinceLast < cfg.cooldownMs) {
        return { ok: false, reason: 'COOLDOWN', waitMs: cfg.cooldownMs - sinceLast }
      }
      if (rec.used >= quota) return { ok: false, reason: 'QUOTA' }
    }
  }

  return { ok: true }
}

export function consumeAutoLimit(userJid: string): void {
  const today = todayWIB()
  const rec = state[userJid]
  if (rec && rec.date === today) {
    rec.used += 1
    rec.lastRun = Date.now()
  } else {
    state[userJid] = { used: 1, date: today, lastRun: Date.now() }
  }
  dirty = true
  schedulePersist()
}
