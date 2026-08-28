import { join, dirname } from 'node:path'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { initSqliteDatabase, normalizeBoundedText, positiveIntegerOption, type DatabaseInstance } from '../storage-helpers.js'

export type AfkRecord = {
  readonly userJid: string
  readonly reason: string
  readonly startedAt: number
  readonly lastSeenAt: number
  readonly searchCount: number
}

export type AfkMentionRecord = {
  readonly seekerJid: string
  readonly chatJid: string
  readonly groupName?: string
  readonly messageText?: string
  readonly quotedText?: string
  readonly mentionedAt: number
}

export type AfkEndSummary = {
  readonly record: AfkRecord
  readonly endedAt: number
  readonly durationMs: number
  readonly mentions: readonly AfkMentionRecord[]
}

export type AfkLeaderboardEntry = {
  readonly userJid: string
  readonly totalAfkCount: number
  readonly totalDurationMs: number
}

export const MAX_AFK_REASON_LENGTH = 500
export const MAX_AFK_CONTEXT_LENGTH = 2_000
export const MAX_AFK_MENTION_RETENTION = 100
export const AFK_MENTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
export const AFK_PRESENCE_WRITE_INTERVAL_MS = 60 * 1_000

export interface AfkServiceOptions {
  readonly presenceWriteIntervalMs?: number
  readonly mentionRetention?: number
  readonly mentionRetentionMs?: number
}

type AfkRow = {
  user_jid: string
  reason: string
  started_at: number
  last_seen_at: number
  search_count: number
}

type MentionRow = {
  seeker_jid: string
  chat_jid: string
  group_name: string
  message_text: string | null
  quoted_text: string | null
  mentioned_at: number
}

type LeaderboardRow = {
  user_jid: string
  total_afk_count: number
  total_duration_ms: number
}

function mapAfk(row: AfkRow): AfkRecord {
  return {
    userJid: row.user_jid,
    reason: row.reason,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    searchCount: row.search_count,
  }
}

export class AfkService implements Service {
  readonly name = 'afk'

  private db: DatabaseInstance | undefined

  constructor(
    coreDatabasePath: string,
    private readonly logger: Logger,
    options: AfkServiceOptions = {},
  ) {
    this.databasePath = join(dirname(coreDatabasePath), 'allybot-afk.sqlite')
    this.presenceWriteIntervalMs = positiveIntegerOption(options.presenceWriteIntervalMs, AFK_PRESENCE_WRITE_INTERVAL_MS, 'presenceWriteIntervalMs')
    this.mentionRetention = positiveIntegerOption(options.mentionRetention, MAX_AFK_MENTION_RETENTION, 'mentionRetention')
    this.mentionRetentionMs = positiveIntegerOption(options.mentionRetentionMs, AFK_MENTION_RETENTION_MS, 'mentionRetentionMs')
  }

  private readonly databasePath: string
  private readonly presenceWriteIntervalMs: number
  private readonly mentionRetention: number
  private readonly mentionRetentionMs: number

  initialize(_context: ServiceContext): void {
    this.db = initSqliteDatabase(this.databasePath)
    this.migrate()
    this.pruneMentions(Date.now())
    this.logger.info({ databasePath: this.databasePath }, 'AFK storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) this.db.close()
    this.db = undefined
  }

  getActive(userJid: string): AfkRecord | undefined {
    const row = this.database()
      .prepare(
        `SELECT user_jid, reason, started_at, last_seen_at, search_count
         FROM afk_active
         WHERE user_jid = ?`,
      )
      .get(userJid) as AfkRow | undefined
    return row ? mapAfk(row) : undefined
  }

  start(userJid: string, reason: string, startedAt: number): AfkRecord {
    const db = this.database()
    const normalizedReason = normalizeBoundedText(reason, MAX_AFK_REASON_LENGTH)
    if (!normalizedReason) throw new Error('AFK reason cannot be empty')
    const existing = this.getActive(userJid)
    if (existing) {
      db.prepare('UPDATE afk_active SET reason = ? WHERE user_jid = ?').run(normalizedReason, userJid)
      return { ...existing, reason: normalizedReason }
    }

    const presence = db
      .prepare('SELECT last_seen_at FROM afk_presence WHERE user_jid = ?')
      .get(userJid) as { last_seen_at: number } | undefined
    const lastSeenAt = presence?.last_seen_at ?? startedAt
    const startAfk = db.transaction(() => {
      db.prepare(
        `INSERT INTO afk_active (user_jid, reason, started_at, last_seen_at, search_count)
         VALUES (?, ?, ?, ?, 0)`,
      ).run(userJid, normalizedReason, startedAt, lastSeenAt)
      db.prepare(
        `INSERT INTO afk_stats (user_jid, total_afk_count, total_duration_ms, last_ended_at)
         VALUES (?, 1, 0, NULL)
         ON CONFLICT(user_jid) DO UPDATE SET
           total_afk_count = afk_stats.total_afk_count + 1`,
      ).run(userJid)
    })
    startAfk()

    return {
      userJid,
      reason: normalizedReason,
      startedAt,
      lastSeenAt,
      searchCount: 0,
    }
  }

  finish(userJid: string, endedAt: number): AfkEndSummary | undefined {
    const db = this.database()
    const record = this.getActive(userJid)
    if (!record) return undefined

    const mentions = this.getMentions(userJid)
    const durationMs = Math.max(0, endedAt - record.startedAt)
    const finish = db.transaction(() => {
      db.prepare('DELETE FROM afk_active WHERE user_jid = ?').run(userJid)
      db.prepare('DELETE FROM afk_mentions WHERE afk_user_jid = ?').run(userJid)
      db.prepare(
        `INSERT INTO afk_stats (user_jid, total_afk_count, total_duration_ms, last_ended_at)
         VALUES (?, 0, ?, ?)
         ON CONFLICT(user_jid) DO UPDATE SET
           total_duration_ms = afk_stats.total_duration_ms + excluded.total_duration_ms,
           last_ended_at = excluded.last_ended_at`,
      ).run(userJid, durationMs, endedAt)
    })
    finish()

    return { record, endedAt, durationMs, mentions }
  }

  touchPresence(userJid: string, at: number): void {
    const db = this.database()
    const existing = db
      .prepare('SELECT last_seen_at FROM afk_presence WHERE user_jid = ?')
      .get(userJid) as { last_seen_at: number } | undefined
    if (existing && (at <= existing.last_seen_at || at - existing.last_seen_at < this.presenceWriteIntervalMs)) return
    db.prepare(
      `INSERT INTO afk_presence (user_jid, last_seen_at)
       VALUES (?, ?)
       ON CONFLICT(user_jid) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    ).run(userJid, at)
  }

  recordMention(
    afkUserJid: string,
    seekerJid: string,
    chatJid: string,
    mentionedAt: number,
    groupName?: string,
    messageText?: string,
    quotedText?: string,
  ): boolean {
    return this.recordMentionWithResult(
      afkUserJid,
      seekerJid,
      chatJid,
      mentionedAt,
      groupName,
      messageText,
      quotedText,
    ) !== undefined
  }

  recordMentionWithResult(
    afkUserJid: string,
    seekerJid: string,
    chatJid: string,
    mentionedAt: number,
    groupName?: string,
    messageText?: string,
    quotedText?: string,
  ): AfkMentionRecord | undefined {
    const db = this.database()
    const normalizedGroupName = normalizeBoundedText(groupName, 200)
    const normalizedMessageText = normalizeBoundedText(messageText, MAX_AFK_CONTEXT_LENGTH)
    const normalizedQuotedText = normalizeBoundedText(quotedText, MAX_AFK_CONTEXT_LENGTH)
    const mention = {
      seekerJid,
      chatJid,
      ...(normalizedGroupName ? { groupName: normalizedGroupName } : {}),
      ...(normalizedMessageText ? { messageText: normalizedMessageText } : {}),
      ...(normalizedQuotedText ? { quotedText: normalizedQuotedText } : {}),
      mentionedAt,
    } satisfies AfkMentionRecord
    const insert = db.transaction(() => {
      const result = db.prepare(
        `INSERT INTO afk_mentions (
           afk_user_jid, seeker_jid, chat_jid, group_name, message_text, quoted_text, mentioned_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        afkUserJid,
        mention.seekerJid,
        mention.chatJid,
        mention.groupName ?? '',
        mention.messageText ?? null,
        mention.quotedText ?? null,
        mention.mentionedAt,
      )
      const updated = db.prepare('UPDATE afk_active SET search_count = search_count + 1 WHERE user_jid = ?').run(afkUserJid)
      if (updated.changes !== 1) {
        db.prepare('DELETE FROM afk_mentions WHERE id = ?').run(result.lastInsertRowid)
        return undefined
      }
      this.pruneMentions(Date.now())
      return mention
    })
    return insert()
  }

  getMentions(userJid: string): readonly AfkMentionRecord[] {
    const rows = this.database()
      .prepare(
        `SELECT seeker_jid, chat_jid, group_name, message_text, quoted_text, mentioned_at
         FROM afk_mentions
         WHERE afk_user_jid = ?
         ORDER BY mentioned_at DESC
         LIMIT ?`,
      )
      .all(userJid, this.mentionRetention) as MentionRow[]
    return rows.map((row) => ({
      seekerJid: row.seeker_jid,
      chatJid: row.chat_jid,
      ...(row.group_name ? { groupName: row.group_name } : {}),
      ...(row.message_text ? { messageText: row.message_text } : {}),
      ...(row.quoted_text ? { quotedText: row.quoted_text } : {}),
      mentionedAt: row.mentioned_at,
    }))
  }

  listActive(limit = 50): readonly AfkRecord[] {
    const rows = this.database()
      .prepare(
        `SELECT user_jid, reason, started_at, last_seen_at, search_count
         FROM afk_active
         ORDER BY started_at ASC
         LIMIT ?`,
      )
      .all(limit) as AfkRow[]
    return rows.map(mapAfk)
  }

  listLeaderboard(limit = 3): readonly AfkLeaderboardEntry[] {
    const rows = this.database()
      .prepare(
        `SELECT user_jid, total_afk_count, total_duration_ms
         FROM afk_stats
         ORDER BY total_afk_count DESC, total_duration_ms DESC
         LIMIT ?`,
      )
      .all(limit) as LeaderboardRow[]
    return rows.map((row) => ({
      userJid: row.user_jid,
      totalAfkCount: row.total_afk_count,
      totalDurationMs: row.total_duration_ms,
    }))
  }

  totalRecorded(): number {
    const row = this.database()
      .prepare('SELECT COALESCE(SUM(total_afk_count), 0) AS total FROM afk_stats')
      .get() as { total: number }
    return row.total
  }

  private database(): DatabaseInstance {
    if (!this.db) throw new Error('AFK storage is not initialized')
    return this.db
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS afk_active (
        user_jid TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        search_count INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS afk_presence (
        user_jid TEXT PRIMARY KEY,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS afk_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        afk_user_jid TEXT NOT NULL,
        seeker_jid TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        group_name TEXT NOT NULL DEFAULT '',
        message_text TEXT,
        quoted_text TEXT,
        mentioned_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_afk_mentions_owner_time
        ON afk_mentions (afk_user_jid, mentioned_at DESC);
      CREATE INDEX IF NOT EXISTS idx_afk_mentions_time
        ON afk_mentions (mentioned_at);

      CREATE TABLE IF NOT EXISTS afk_stats (
        user_jid TEXT PRIMARY KEY,
        total_afk_count INTEGER NOT NULL DEFAULT 0,
        total_duration_ms INTEGER NOT NULL DEFAULT 0,
        last_ended_at INTEGER
      );
    `)

    const columns = new Set(
      (this.database().prepare('PRAGMA table_info(afk_mentions)').all() as Array<{ name: string }>).map((column) => column.name),
    )
    if (!columns.has('group_name')) this.database().exec("ALTER TABLE afk_mentions ADD COLUMN group_name TEXT NOT NULL DEFAULT ''")
    if (!columns.has('message_text')) this.database().exec('ALTER TABLE afk_mentions ADD COLUMN message_text TEXT')
    if (!columns.has('quoted_text')) this.database().exec('ALTER TABLE afk_mentions ADD COLUMN quoted_text TEXT')
    this.database().exec(
      'UPDATE afk_mentions SET mentioned_at = mentioned_at * 1000 WHERE mentioned_at > 0 AND mentioned_at < 10000000000',
    )
  }

  private pruneMentions(now: number): void {
    const cutoff = now - this.mentionRetentionMs
    this.database().prepare('DELETE FROM afk_mentions WHERE mentioned_at < ?').run(cutoff)
    this.database().prepare(`
      DELETE FROM afk_mentions
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY afk_user_jid
                   ORDER BY mentioned_at DESC, id DESC
                 ) AS rank
          FROM afk_mentions
        )
        WHERE rank > ?
      )
    `).run(this.mentionRetention)
  }
}


