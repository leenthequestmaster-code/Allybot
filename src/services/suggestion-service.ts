import { createHmac } from 'node:crypto'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { bareJid } from '../permissions.js'
import { initSqliteDatabase, type DatabaseInstance } from '../storage-helpers.js'

export interface SuggestionRecord {
  readonly id: number
  readonly token: string
  readonly text: string
  readonly status: 'queued' | 'sent' | 'failed'
  readonly createdAt: number
}

export interface SuggestionBoxConfig {
  readonly botJid: string
  readonly boxGroupJid: string
  readonly updatedAt: number
}

export interface SuggestionRateLimitResult {
  readonly allowed: boolean
  readonly reason?: string
  readonly retryAfterSeconds?: number
}

export interface SuggestionServiceOptions {
  readonly secret?: string
  readonly clock?: () => number
  readonly retentionDays?: number
  readonly cooldownMs?: number
  readonly maxPerDay?: number
}

interface SuggestionRow {
  id: number
  token: string
  text: string
  status: 'queued' | 'sent' | 'failed'
  created_at: number
}

interface ReplyMapRow {
  token: string
  sender_jid: string
  expires_at: number
}

interface BoxConfigRow {
  bot_jid: string
  box_group_jid: string
  updated_at: number
}

export const SUGGESTION_MIN_TEXT_LENGTH = 5
export const SUGGESTION_MAX_TEXT_LENGTH = 1_000
export const SUGGESTION_DEFAULT_COOLDOWN_MS = 60_000
export const SUGGESTION_DEFAULT_MAX_PER_DAY = 5
export const SUGGESTION_DEFAULT_RETENTION_DAYS = 30

export class SuggestionService implements Service {
  readonly name = 'suggestion'

  private db: DatabaseInstance | undefined
  private readonly databasePath: string
  private readonly secret: string
  private readonly clock: () => number
  private readonly retentionDays: number
  private readonly cooldownMs: number
  private readonly maxPerDay: number

  // In-memory rate limiting map keyed by token: keeps rate-limit state isolated from permanent disk storage
  private readonly rateLimits = new Map<string, { lastAt: number; timestamps: number[] }>()

  constructor(
    databasePath: string,
    private readonly logger: Logger,
    options: SuggestionServiceOptions = {},
  ) {
    this.databasePath = databasePath
    this.secret = options.secret ?? 'allybot-suggestion-secret-key-2026'
    this.clock = options.clock ?? (() => Date.now())
    this.retentionDays = options.retentionDays ?? SUGGESTION_DEFAULT_RETENTION_DAYS
    this.cooldownMs = options.cooldownMs ?? SUGGESTION_DEFAULT_COOLDOWN_MS
    this.maxPerDay = options.maxPerDay ?? SUGGESTION_DEFAULT_MAX_PER_DAY
  }

  initialize(_context: ServiceContext): void {
    this.db = initSqliteDatabase(this.databasePath, { foreignKeys: true })
    this.migrate()
    const pruned = this.pruneOld(this.retentionDays)
    this.logger.info(
      { component: 'suggestion', prunedSuggestions: pruned.suggestionsDeleted, prunedReplies: pruned.replyMapDeleted },
      'Suggestion service initialized',
    )
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) {
      this.db.close()
    }
    this.db = undefined
    this.rateLimits.clear()
  }

  private database(): DatabaseInstance {
    if (!this.db?.open) {
      throw new Error('Suggestion service is not initialized')
    }
    return this.db
  }

  private migrate(): void {
    const db = this.database()
    db.exec(`
      CREATE TABLE IF NOT EXISTS suggestion_box_config (
        bot_jid TEXT PRIMARY KEY,
        box_group_jid TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suggestion_reply_map (
        token TEXT PRIMARY KEY,
        sender_jid TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suggestion_blacklist (
        token TEXT PRIMARY KEY,
        blocked_at INTEGER NOT NULL,
        reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_suggestions_status
        ON suggestions (status);

      CREATE INDEX IF NOT EXISTS idx_suggestions_created
        ON suggestions (created_at);
    `)
  }

  generateToken(senderJid: string): string {
    const phone = bareJid(senderJid)
    return createHmac('sha256', this.secret)
      .update(phone)
      .digest('hex')
      .slice(0, 6)
      .toUpperCase()
  }

  setBoxGroup(botJid: string, boxGroupJid: string, now = this.clock()): void {
    this.database()
      .prepare(`
        INSERT INTO suggestion_box_config (bot_jid, box_group_jid, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT (bot_jid) DO UPDATE SET
          box_group_jid = excluded.box_group_jid,
          updated_at = excluded.updated_at
      `)
      .run(botJid, boxGroupJid, now)
  }

  getBoxGroup(botJid?: string): string | undefined {
    const db = this.database()
    if (botJid) {
      const row = db
        .prepare('SELECT box_group_jid FROM suggestion_box_config WHERE bot_jid = ?')
        .get(botJid) as BoxConfigRow | undefined
      if (row?.box_group_jid) return row.box_group_jid
    }
    const fallback = db
      .prepare('SELECT box_group_jid FROM suggestion_box_config ORDER BY updated_at DESC LIMIT 1')
      .get() as BoxConfigRow | undefined
    return fallback?.box_group_jid
  }

  isBlacklisted(token: string): boolean {
    const row = this.database()
      .prepare('SELECT token FROM suggestion_blacklist WHERE token = ?')
      .get(token.toUpperCase())
    return Boolean(row)
  }

  blacklistToken(token: string, reason?: string, now = this.clock()): void {
    this.database()
      .prepare(`
        INSERT INTO suggestion_blacklist (token, blocked_at, reason)
        VALUES (?, ?, ?)
        ON CONFLICT (token) DO UPDATE SET
          blocked_at = excluded.blocked_at,
          reason = excluded.reason
      `)
      .run(token.toUpperCase(), now, reason ?? null)
  }

  checkRateLimit(token: string, now = this.clock()): SuggestionRateLimitResult {
    const entry = this.rateLimits.get(token)
    if (!entry) {
      return { allowed: true }
    }

    const elapsed = now - entry.lastAt
    if (elapsed < this.cooldownMs) {
      const remainingSeconds = Math.ceil((this.cooldownMs - elapsed) / 1_000)
      return {
        allowed: false,
        reason: `Tunggu ${remainingSeconds} detik sebelum mengirim saran kembali.`,
        retryAfterSeconds: remainingSeconds,
      }
    }

    const oneDayAgo = now - 24 * 60 * 60 * 1_000
    const recentTimestamps = entry.timestamps.filter((ts) => ts > oneDayAgo)
    if (recentTimestamps.length >= this.maxPerDay) {
      return {
        allowed: false,
        reason: `Batas harian tercapai (maksimal ${this.maxPerDay} saran per 24 jam). Silakan coba lagi besok.`,
      }
    }

    return { allowed: true }
  }

  recordSuggestion(
    token: string,
    text: string,
    senderJid: string,
    now = this.clock(),
  ): SuggestionRecord {
    const db = this.database()
    const expiresAt = now + this.retentionDays * 24 * 60 * 60 * 1_000

    const record = db.transaction(() => {
      const result = db
        .prepare('INSERT INTO suggestions (token, text, status, created_at) VALUES (?, ?, ?, ?)')
        .run(token, text, 'queued', now)
      
      const newId = Number(result.lastInsertRowid)

      // Ephemeral reply map for admin response routing without raw JID leakage in suggestions table
      db.prepare(`
        INSERT INTO suggestion_reply_map (token, sender_jid, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT (token) DO UPDATE SET
          sender_jid = excluded.sender_jid,
          expires_at = excluded.expires_at
      `).run(token, senderJid, expiresAt)

      return {
        id: newId,
        token,
        text,
        status: 'queued' as const,
        createdAt: now,
      }
    })()

    // Update in-memory rate-limiter entry
    const entry = this.rateLimits.get(token) ?? { lastAt: 0, timestamps: [] }
    const oneDayAgo = now - 24 * 60 * 60 * 1_000
    const filteredTimestamps = entry.timestamps.filter((ts) => ts > oneDayAgo)
    filteredTimestamps.push(now)
    this.rateLimits.set(token, {
      lastAt: now,
      timestamps: filteredTimestamps,
    })

    return record
  }

  updateSuggestionStatus(id: number, status: 'sent' | 'failed'): void {
    this.database()
      .prepare('UPDATE suggestions SET status = ? WHERE id = ?')
      .run(status, id)
  }

  getSuggestion(id: number): SuggestionRecord | undefined {
    const row = this.database()
      .prepare('SELECT id, token, text, status, created_at FROM suggestions WHERE id = ?')
      .get(id) as SuggestionRow | undefined
    if (!row) return undefined
    return {
      id: row.id,
      token: row.token,
      text: row.text,
      status: row.status,
      createdAt: row.created_at,
    }
  }

  getReplyTarget(token: string, now = this.clock()): string | undefined {
    const row = this.database()
      .prepare('SELECT sender_jid, expires_at FROM suggestion_reply_map WHERE token = ?')
      .get(token.toUpperCase()) as ReplyMapRow | undefined
    if (!row) return undefined
    if (row.expires_at <= now) {
      this.database()
        .prepare('DELETE FROM suggestion_reply_map WHERE token = ?')
        .run(token.toUpperCase())
      return undefined
    }
    return row.sender_jid
  }

  pruneOld(days = this.retentionDays, now = this.clock()): { suggestionsDeleted: number; replyMapDeleted: number } {
    const db = this.database()
    const cutoff = now - days * 24 * 60 * 60 * 1_000
    const resSuggestions = db
      .prepare('DELETE FROM suggestions WHERE created_at < ?')
      .run(cutoff)
    const resReplyMap = db
      .prepare('DELETE FROM suggestion_reply_map WHERE expires_at < ?')
      .run(now)
    return {
      suggestionsDeleted: resSuggestions.changes,
      replyMapDeleted: resReplyMap.changes,
    }
  }
}
