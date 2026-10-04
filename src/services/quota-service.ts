import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { initSqliteDatabase, type DatabaseInstance } from '../storage-helpers.js'
import { bareJid, isSameJid } from '../permissions.js'

export type QuotaTier = 'free' | 'donator' | 'owner'

export interface QuotaReservation {
  readonly ok: boolean
  readonly remaining: number
  readonly limit: number
  readonly used: number
  readonly tier: QuotaTier
}

export interface QuotaServiceOptions {
  readonly botOwnerJid?: string
  readonly timezoneOffsetHours?: number
  readonly limits?: Record<string, { free: number; donator: number }>
}

const DEFAULT_LIMITS: Record<string, { free: number; donator: number }> = {
  downloader: { free: 5, donator: 50 },
  music: { free: 5, donator: 50 },
}

function getTodayString(tzOffsetHours = 7): string {
  const now = new Date()
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000
  const localMs = utcMs + tzOffsetHours * 3_600_000
  const d = new Date(localMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function canonicalUserKey(jid: string): string {
  if (!jid) return ''
  const trimmed = jid.trim().toLowerCase()
  return bareJid(trimmed)
}

export class QuotaService implements Service {
  readonly name = 'quota'

  private db: DatabaseInstance | undefined
  private readonly databasePath: string
  private readonly botOwnerJid?: string
  private readonly tzOffset: number
  private readonly limits: Record<string, { free: number; donator: number }>

  constructor(
    databasePath: string,
    private readonly logger: Logger,
    options: QuotaServiceOptions = {},
  ) {
    this.databasePath = databasePath
    this.botOwnerJid = options.botOwnerJid
    this.tzOffset = options.timezoneOffsetHours ?? 7
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  }

  initialize(_context?: ServiceContext): void {
    this.db = initSqliteDatabase(this.databasePath, { foreignKeys: true })
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_donations (
        user_jid TEXT PRIMARY KEY,
        tier TEXT NOT NULL DEFAULT 'donator',
        notes TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_quotas (
        user_jid TEXT NOT NULL,
        quota_key TEXT NOT NULL,
        usage_date TEXT NOT NULL,
        used_count INTEGER NOT NULL DEFAULT 0,
        reserved_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_jid, quota_key, usage_date)
      );
    `)
    this.logger.info('Quota & Donation service initialized')
  }

  private requireDb(): DatabaseInstance {
    if (!this.db) {
      this.initialize()
    }
    return this.db!
  }

  isOwner(jid: string): boolean {
    if (!jid || !this.botOwnerJid) return false
    return isSameJid(jid, this.botOwnerJid)
  }

  isDonator(jid: string): boolean {
    if (!jid) return false
    if (this.isOwner(jid)) return true
    const db = this.requireDb()
    const key = canonicalUserKey(jid)
    const row = db.prepare('SELECT tier FROM user_donations WHERE user_jid = ?').get(key) as { tier?: string } | undefined
    return Boolean(row && row.tier === 'donator')
  }

  getTier(jid: string): QuotaTier {
    if (this.isOwner(jid)) return 'owner'
    if (this.isDonator(jid)) return 'donator'
    return 'free'
  }

  setDonator(jid: string, enabled: boolean, notes?: string): void {
    const db = this.requireDb()
    const key = canonicalUserKey(jid)
    if (enabled) {
      db.prepare(`
        INSERT INTO user_donations (user_jid, tier, notes, created_at)
        VALUES (?, 'donator', ?, ?)
        ON CONFLICT(user_jid) DO UPDATE SET
          tier = 'donator',
          notes = excluded.notes
      `).run(key, notes ?? 'Donator seumur hidup', Date.now())
    } else {
      db.prepare('DELETE FROM user_donations WHERE user_jid = ?').run(key)
    }
  }

  listDonators(): readonly { userJid: string; tier: string; notes?: string; createdAt: number }[] {
    const db = this.requireDb()
    const rows = db.prepare('SELECT user_jid, tier, notes, created_at FROM user_donations ORDER BY created_at DESC').all() as any[]
    return rows.map((r) => ({
      userJid: r.user_jid,
      tier: r.tier,
      notes: r.notes ?? undefined,
      createdAt: r.created_at,
    }))
  }

  getLimit(tier: QuotaTier, quotaKey: string): number {
    if (tier === 'owner') return Infinity
    const keyLimits = this.limits[quotaKey] ?? { free: 5, donator: 50 }
    return tier === 'donator' ? keyLimits.donator : keyLimits.free
  }

  checkQuota(jid: string, quotaKey: string): { limit: number; used: number; remaining: number; tier: QuotaTier } {
    const tier = this.getTier(jid)
    if (tier === 'owner') {
      return { limit: 999999, used: 0, remaining: 999999, tier }
    }
    const db = this.requireDb()
    const key = canonicalUserKey(jid)
    const today = getTodayString(this.tzOffset)
    const row = db.prepare(`
      SELECT used_count, reserved_count
      FROM daily_quotas
      WHERE user_jid = ? AND quota_key = ? AND usage_date = ?
    `).get(key, quotaKey, today) as { used_count: number; reserved_count: number } | undefined

    const used = row ? row.used_count : 0
    const reserved = row ? row.reserved_count : 0
    const limit = this.getLimit(tier, quotaKey)
    const effectiveUsed = used + reserved
    const remaining = Math.max(0, limit - effectiveUsed)

    return { limit, used, remaining, tier }
  }

  reserveQuota(jid: string, quotaKey: string): QuotaReservation {
    const tier = this.getTier(jid)
    if (tier === 'owner') {
      return { ok: true, remaining: 999999, limit: 999999, used: 0, tier }
    }

    const db = this.requireDb()
    const key = canonicalUserKey(jid)
    const today = getTodayString(this.tzOffset)
    const limit = this.getLimit(tier, quotaKey)

    const tx = db.transaction(() => {
      const row = db.prepare(`
        SELECT used_count, reserved_count
        FROM daily_quotas
        WHERE user_jid = ? AND quota_key = ? AND usage_date = ?
      `).get(key, quotaKey, today) as { used_count: number; reserved_count: number } | undefined

      const used = row ? row.used_count : 0
      const reserved = row ? row.reserved_count : 0
      const effectiveUsed = used + reserved

      if (effectiveUsed >= limit) {
        return { ok: false, remaining: 0, limit, used, tier }
      }

      db.prepare(`
        INSERT INTO daily_quotas (user_jid, quota_key, usage_date, used_count, reserved_count)
        VALUES (?, ?, ?, 0, 1)
        ON CONFLICT(user_jid, quota_key, usage_date) DO UPDATE SET
          reserved_count = reserved_count + 1
      `).run(key, quotaKey, today)

      return {
        ok: true,
        remaining: Math.max(0, limit - (effectiveUsed + 1)),
        limit,
        used,
        tier,
      }
    })

    return tx()
  }

  commitQuota(jid: string, quotaKey: string): void {
    if (this.isOwner(jid)) return
    const db = this.requireDb()
    const key = canonicalUserKey(jid)
    const today = getTodayString(this.tzOffset)

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE daily_quotas
        SET reserved_count = MAX(0, reserved_count - 1),
            used_count = used_count + 1
        WHERE user_jid = ? AND quota_key = ? AND usage_date = ?
      `).run(key, quotaKey, today)
    })

    tx()
  }

  refundQuota(jid: string, quotaKey: string): void {
    if (this.isOwner(jid)) return
    const db = this.requireDb()
    const key = canonicalUserKey(jid)
    const today = getTodayString(this.tzOffset)

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE daily_quotas
        SET reserved_count = MAX(0, reserved_count - 1)
        WHERE user_jid = ? AND quota_key = ? AND usage_date = ?
      `).run(key, quotaKey, today)
    })

    tx()
  }

  shutdown(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch {}
      this.db = undefined
    }
  }
}
