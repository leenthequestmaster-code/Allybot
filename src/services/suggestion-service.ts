import { createHmac } from 'node:crypto'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { bareJid } from '../permissions.js'
import { initSqliteDatabase, type DatabaseInstance } from '../storage-helpers.js'

export type FeedbackType = 'suggest' | 'report'

export interface FeedbackTicketRecord {
  readonly id: number
  readonly type: FeedbackType
  readonly token: string
  readonly text: string
  readonly originGroupJid?: string
  readonly originGroupName?: string
  readonly targetJid?: string
  readonly hasMedia?: boolean
  readonly mediaKind?: string
  readonly status: 'queued' | 'sent' | 'failed'
  readonly createdAt: number
}

// Backward-compatible alias for existing suggestion tests
export type SuggestionRecord = FeedbackTicketRecord

export interface FeedbackBoxConfig {
  readonly type: FeedbackType
  readonly botJid: string
  readonly boxGroupJid: string
  readonly updatedAt: number
}

export interface FeedbackRateLimitResult {
  readonly allowed: boolean
  readonly reason?: string
  readonly retryAfterSeconds?: number
}

export type SuggestionRateLimitResult = FeedbackRateLimitResult

export interface ActiveEvidenceWindow {
  readonly ticketId: number
  readonly token: string
  readonly type: FeedbackType
  readonly originGroupJid?: string
  readonly originGroupName?: string
  readonly expiresAt: number
}

export interface SuggestionServiceOptions {
  readonly secret?: string
  readonly clock?: () => number
  readonly retentionDays?: number
  readonly cooldownMs?: number
  readonly maxPerDay?: number
  readonly evidenceWindowMs?: number
}

interface TicketRow {
  id: number
  type: FeedbackType
  token: string
  origin_group_jid: string | null
  origin_group_name: string | null
  target_jid: string | null
  text: string
  has_media: number
  media_kind: string | null
  status: 'queued' | 'sent' | 'failed'
  created_at: number
}

interface ReplyMapRow {
  token: string
  sender_jid: string
  expires_at: number
}

interface BoxConfigRow {
  type: string
  bot_jid: string
  box_group_jid: string
  updated_at: number
}

export const SUGGESTION_MIN_TEXT_LENGTH = 5
export const SUGGESTION_MAX_TEXT_LENGTH = 1_000
export const SUGGESTION_DEFAULT_COOLDOWN_MS = 60_000
export const SUGGESTION_DEFAULT_MAX_PER_DAY = 5
export const SUGGESTION_DEFAULT_RETENTION_DAYS = 30
export const EVIDENCE_WINDOW_DEFAULT_MS = 180_000 // 3 minutes

export class SuggestionService implements Service {
  readonly name = 'suggestion'

  private db: DatabaseInstance | undefined
  private readonly databasePath: string
  private readonly secret: string
  private readonly clock: () => number
  private readonly retentionDays: number
  private readonly cooldownMs: number
  private readonly maxPerDay: number
  private readonly evidenceWindowMs: number

  // In-memory rate limiting map keyed by `${type}:${token}`
  private readonly rateLimits = new Map<string, { lastAt: number; timestamps: number[] }>()

  // In-memory active multi-evidence window keyed by token
  private readonly evidenceWindows = new Map<string, ActiveEvidenceWindow>()

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
    this.evidenceWindowMs = options.evidenceWindowMs ?? EVIDENCE_WINDOW_DEFAULT_MS
  }

  initialize(_context: ServiceContext): void {
    this.db = initSqliteDatabase(this.databasePath, { foreignKeys: true })
    this.migrate()
    const pruned = this.pruneOld(this.retentionDays)
    this.logger.info(
      { component: 'suggestion', prunedTickets: pruned.ticketsDeleted, prunedReplies: pruned.replyMapDeleted },
      'Feedback and suggestion service initialized',
    )
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) {
      this.db.close()
    }
    this.db = undefined
    this.rateLimits.clear()
    this.evidenceWindows.clear()
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
      CREATE TABLE IF NOT EXISTS feedback_box_config (
        type TEXT NOT NULL,
        bot_jid TEXT NOT NULL,
        box_group_jid TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (type, bot_jid)
      );

      CREATE TABLE IF NOT EXISTS feedback_tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        token TEXT NOT NULL,
        origin_group_jid TEXT,
        origin_group_name TEXT,
        target_jid TEXT,
        text TEXT NOT NULL,
        has_media INTEGER NOT NULL DEFAULT 0,
        media_kind TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feedback_reply_map (
        token TEXT PRIMARY KEY,
        sender_jid TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS feedback_blacklist (
        token TEXT PRIMARY KEY,
        blocked_at INTEGER NOT NULL,
        reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_tickets_type_status
        ON feedback_tickets (type, status);

      CREATE INDEX IF NOT EXISTS idx_feedback_tickets_created
        ON feedback_tickets (created_at);
    `)

    // Compatibility check for older tables
    try {
      const oldBox = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suggestion_box_config'").get()
      if (oldBox) {
        db.exec(`
          INSERT OR IGNORE INTO feedback_box_config (type, bot_jid, box_group_jid, updated_at)
          SELECT 'suggest', bot_jid, box_group_jid, updated_at FROM suggestion_box_config;
        `)
      }
      const oldSuggestions = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suggestions'").get()
      if (oldSuggestions) {
        db.exec(`
          INSERT OR IGNORE INTO feedback_tickets (id, type, token, text, status, created_at)
          SELECT id, 'suggest', token, text, status, created_at FROM suggestions;
        `)
      }
      const oldBlacklist = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suggestion_blacklist'").get()
      if (oldBlacklist) {
        db.exec(`
          INSERT OR IGNORE INTO feedback_blacklist (token, blocked_at, reason)
          SELECT token, blocked_at, reason FROM suggestion_blacklist;
        `)
      }
      const oldReplyMap = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='suggestion_reply_map'").get()
      if (oldReplyMap) {
        db.exec(`
          INSERT OR IGNORE INTO feedback_reply_map (token, sender_jid, expires_at)
          SELECT token, sender_jid, expires_at FROM suggestion_reply_map;
        `)
      }
    } catch {}
  }

  generateToken(senderJid: string): string {
    const phone = bareJid(senderJid)
    return createHmac('sha256', this.secret)
      .update(phone)
      .digest('hex')
      .slice(0, 6)
      .toUpperCase()
  }

  setBoxGroup(
    arg1: FeedbackType | string,
    arg2: string,
    arg3?: string,
    now = this.clock(),
  ): void {
    let type: FeedbackType = 'suggest'
    let botJid = ''
    let boxGroupJid = ''

    if (arg1 === 'suggest' || arg1 === 'report') {
      type = arg1
      botJid = arg2
      boxGroupJid = arg3 ?? ''
    } else {
      botJid = arg1
      boxGroupJid = arg2
    }

    this.database()
      .prepare(`
        INSERT INTO feedback_box_config (type, bot_jid, box_group_jid, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (type, bot_jid) DO UPDATE SET
          box_group_jid = excluded.box_group_jid,
          updated_at = excluded.updated_at
      `)
      .run(type, botJid, boxGroupJid, now)
  }

  getBoxGroup(typeOrBotJid?: FeedbackType | string, maybeBotJid?: string): string | undefined {
    const db = this.database()
    let type: FeedbackType = 'suggest'
    let botJid: string | undefined

    if (typeOrBotJid === 'suggest' || typeOrBotJid === 'report') {
      type = typeOrBotJid
      botJid = maybeBotJid
    } else {
      botJid = typeOrBotJid
    }

    if (botJid) {
      const row = db
        .prepare('SELECT box_group_jid FROM feedback_box_config WHERE type = ? AND bot_jid = ?')
        .get(type, botJid) as BoxConfigRow | undefined
      if (row?.box_group_jid) return row.box_group_jid
    }

    // Try any configured box for this type
    const fallback = db
      .prepare('SELECT box_group_jid FROM feedback_box_config WHERE type = ? ORDER BY updated_at DESC LIMIT 1')
      .get(type) as BoxConfigRow | undefined
    if (fallback?.box_group_jid) return fallback.box_group_jid

    // If report box not configured, fallback to suggest box
    if (type === 'report') {
      const suggestFallback = db
        .prepare("SELECT box_group_jid FROM feedback_box_config WHERE type = 'suggest' ORDER BY updated_at DESC LIMIT 1")
        .get() as BoxConfigRow | undefined
      if (suggestFallback?.box_group_jid) return suggestFallback.box_group_jid
    }

    return undefined
  }

  isBlacklisted(token: string): boolean {
    const row = this.database()
      .prepare('SELECT token FROM feedback_blacklist WHERE token = ?')
      .get(token.toUpperCase())
    return Boolean(row)
  }

  blacklistToken(token: string, reason?: string, now = this.clock()): void {
    this.database()
      .prepare(`
        INSERT INTO feedback_blacklist (token, blocked_at, reason)
        VALUES (?, ?, ?)
        ON CONFLICT (token) DO UPDATE SET
          blocked_at = excluded.blocked_at,
          reason = excluded.reason
      `)
      .run(token.toUpperCase(), now, reason ?? null)
  }

  checkRateLimit(type: FeedbackType = 'suggest', token: string, now = this.clock()): FeedbackRateLimitResult {
    const key = `${type}:${token}`
    const entry = this.rateLimits.get(key)
    if (!entry) {
      return { allowed: true }
    }

    const elapsed = now - entry.lastAt
    if (elapsed < this.cooldownMs) {
      const remainingSeconds = Math.ceil((this.cooldownMs - elapsed) / 1_000)
      return {
        allowed: false,
        reason: `Tunggu ${remainingSeconds} detik sebelum mengirim ${type === 'report' ? 'laporan' : 'saran'} kembali.`,
        retryAfterSeconds: remainingSeconds,
      }
    }

    const oneDayAgo = now - 24 * 60 * 60 * 1_000
    const recentTimestamps = entry.timestamps.filter((ts) => ts > oneDayAgo)
    if (recentTimestamps.length >= this.maxPerDay) {
      return {
        allowed: false,
        reason: `Batas harian tercapai (maksimal ${this.maxPerDay} ${type === 'report' ? 'laporan' : 'saran'} per 24 jam). Silakan coba lagi besok.`,
      }
    }

    return { allowed: true }
  }

  recordTicket(
    type: FeedbackType,
    token: string,
    text: string,
    senderJid: string,
    options: {
      originGroupJid?: string
      originGroupName?: string
      targetJid?: string
      hasMedia?: boolean
      mediaKind?: string
    } = {},
    now = this.clock(),
  ): FeedbackTicketRecord {
    const db = this.database()
    const expiresAt = now + this.retentionDays * 24 * 60 * 60 * 1_000

    const record = db.transaction(() => {
      const result = db
        .prepare(`
          INSERT INTO feedback_tickets (
            type, token, origin_group_jid, origin_group_name, target_jid,
            text, has_media, media_kind, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          type,
          token,
          options.originGroupJid ?? null,
          options.originGroupName ?? null,
          options.targetJid ?? null,
          text,
          options.hasMedia ? 1 : 0,
          options.mediaKind ?? null,
          'queued',
          now,
        )

      const newId = Number(result.lastInsertRowid)

      db.prepare(`
        INSERT INTO feedback_reply_map (token, sender_jid, expires_at)
        VALUES (?, ?, ?)
        ON CONFLICT (token) DO UPDATE SET
          sender_jid = excluded.sender_jid,
          expires_at = excluded.expires_at
      `).run(token, senderJid, expiresAt)

      return {
        id: newId,
        type,
        token,
        text,
        originGroupJid: options.originGroupJid,
        originGroupName: options.originGroupName,
        targetJid: options.targetJid,
        hasMedia: options.hasMedia,
        mediaKind: options.mediaKind,
        status: 'queued' as const,
        createdAt: now,
      }
    })()

    // Update rate-limiting entry
    const key = `${type}:${token}`
    const entry = this.rateLimits.get(key) ?? { lastAt: 0, timestamps: [] }
    const oneDayAgo = now - 24 * 60 * 60 * 1_000
    const filtered = entry.timestamps.filter((ts) => ts > oneDayAgo)
    filtered.push(now)
    this.rateLimits.set(key, {
      lastAt: now,
      timestamps: filtered,
    })

    return record
  }

  // Legacy helper
  recordSuggestion(
    token: string,
    text: string,
    senderJid: string,
    now = this.clock(),
  ): SuggestionRecord {
    return this.recordTicket('suggest', token, text, senderJid, {}, now)
  }

  updateTicketStatus(id: number, status: 'sent' | 'failed'): void {
    this.database()
      .prepare('UPDATE feedback_tickets SET status = ? WHERE id = ?')
      .run(status, id)
  }

  // Legacy alias
  updateSuggestionStatus(id: number, status: 'sent' | 'failed'): void {
    this.updateTicketStatus(id, status)
  }

  getTicket(id: number): FeedbackTicketRecord | undefined {
    const row = this.database()
      .prepare(`
        SELECT id, type, token, origin_group_jid, origin_group_name, target_jid,
               text, has_media, media_kind, status, created_at
        FROM feedback_tickets WHERE id = ?
      `)
      .get(id) as TicketRow | undefined
    if (!row) return undefined
    return {
      id: row.id,
      type: row.type,
      token: row.token,
      text: row.text,
      originGroupJid: row.origin_group_jid ?? undefined,
      originGroupName: row.origin_group_name ?? undefined,
      targetJid: row.target_jid ?? undefined,
      hasMedia: Boolean(row.has_media),
      mediaKind: row.media_kind ?? undefined,
      status: row.status,
      createdAt: row.created_at,
    }
  }

  // Legacy alias
  getSuggestion(id: number): SuggestionRecord | undefined {
    return this.getTicket(id)
  }

  getReplyTarget(token: string, now = this.clock()): string | undefined {
    const row = this.database()
      .prepare('SELECT sender_jid, expires_at FROM feedback_reply_map WHERE token = ?')
      .get(token.toUpperCase()) as ReplyMapRow | undefined
    if (!row) return undefined
    if (row.expires_at <= now) {
      this.database()
        .prepare('DELETE FROM feedback_reply_map WHERE token = ?')
        .run(token.toUpperCase())
      return undefined
    }
    return row.sender_jid
  }

  // Multi-Evidence 3-minute window
  openEvidenceWindow(
    token: string,
    ticketId: number,
    type: FeedbackType,
    originGroupJid?: string,
    originGroupName?: string,
    durationMs = this.evidenceWindowMs,
    now = this.clock(),
  ): void {
    this.evidenceWindows.set(token, {
      ticketId,
      token,
      type,
      originGroupJid,
      originGroupName,
      expiresAt: now + durationMs,
    })
  }

  getActiveEvidenceWindow(token: string, now = this.clock()): ActiveEvidenceWindow | undefined {
    const window = this.evidenceWindows.get(token)
    if (!window) return undefined
    if (window.expiresAt <= now) {
      this.evidenceWindows.delete(token)
      return undefined
    }
    return window
  }

  closeEvidenceWindow(token: string): void {
    this.evidenceWindows.delete(token)
  }

  pruneOld(days = this.retentionDays, now = this.clock()): { ticketsDeleted: number; replyMapDeleted: number; suggestionsDeleted: number } {
    const db = this.database()
    const cutoff = now - days * 24 * 60 * 60 * 1_000
    const resTickets = db
      .prepare('DELETE FROM feedback_tickets WHERE created_at < ?')
      .run(cutoff)
    const resReplyMap = db
      .prepare('DELETE FROM feedback_reply_map WHERE expires_at < ?')
      .run(now)
    return {
      ticketsDeleted: resTickets.changes,
      replyMapDeleted: resReplyMap.changes,
      suggestionsDeleted: resTickets.changes,
    }
  }
}
