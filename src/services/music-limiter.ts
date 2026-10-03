import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import type { Config } from './music-config.js'
import type { Tier } from './music-tiers.js'

const LIMITS_PATH = resolve('/opt/Allybot/data/limits.json')

interface UserRecord {
  used: number
  date: string // YYYY-MM-DD in configured timezone
}

const state: Record<string, UserRecord> = {}
let dirty = false
let debounceTimer: NodeJS.Timeout | null = null

// ─── Timezone-aware date ──────────────────────────────────────────────────────

function todayString(tzOffset: number): string {
  const now = new Date()
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000
  const localMs = utcMs + tzOffset * 3600000
  const d = new Date(localMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function schedulePersist(): void {
  if (debounceTimer) return
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    if (!dirty) return
    try {
      writeFileSync(LIMITS_PATH, JSON.stringify(state, null, 2), 'utf8')
      dirty = false
    } catch {
      // best-effort
    }
  }, 500)
}

export function restoreLimits(): void {
  if (!existsSync(LIMITS_PATH)) return
  try {
    const data = JSON.parse(readFileSync(LIMITS_PATH, 'utf8')) as Record<string, UserRecord>
    Object.assign(state, data)
  } catch {
    // corrupted — start fresh
  }
}

// ─── Rollover ─────────────────────────────────────────────────────────────────

let _lastTzOffset = 7

function checkRollover(tzOffset: number): void {
  const today = todayString(tzOffset)
  for (const jid of Object.keys(state)) {
    if (state[jid]?.date !== today) {
      delete state[jid]
      dirty = true
    }
  }
  if (dirty) schedulePersist()
}

export function startRolloverInterval(config: Config): NodeJS.Timeout {
  _lastTzOffset = config.timezone_offset
  return setInterval(() => {
    checkRollover(config.timezone_offset)
  }, 60_000)
}

// ─── Quota logic ──────────────────────────────────────────────────────────────

function quotaFor(tier: Tier, config: Config): number {
  if (tier === 'owner') return Infinity
  if (tier === 'premium') return config.premium_quota
  return config.default_quota
}

export function checkQuota(
  userJid: string,
  tier: Tier,
  config: Config,
): { ok: boolean; used: number; quota: number; remaining: number } {
  const today = todayString(config.timezone_offset)
  const rec = state[userJid]

  let used = 0
  if (rec) {
    if (rec.date !== today) {
      // rolled over
      delete state[userJid]
      dirty = true
      schedulePersist()
    } else {
      used = rec.used
    }
  }

  const quota = quotaFor(tier, config)
  const remaining = quota === Infinity ? Infinity : Math.max(0, quota - used)
  const ok = used < quota

  return { ok, used, quota: quota === Infinity ? 999999 : quota, remaining: remaining === Infinity ? 999999 : remaining }
}

export function consumeQuota(userJid: string, config: Config): void {
  const today = todayString(config.timezone_offset)
  const rec = state[userJid]

  if (rec && rec.date === today) {
    rec.used += 1
  } else {
    state[userJid] = { used: 1, date: today }
  }

  dirty = true
  schedulePersist()
}
