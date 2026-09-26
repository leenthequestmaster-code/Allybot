import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { initSqliteDatabase, type DatabaseInstance } from '../storage-helpers.js'

export interface BannedRecord {
  readonly groupJid: string
  readonly targetJid: string
  readonly bannedBy: string
  readonly reason: string
  readonly bannedAt: number
}

export interface MutedRecord {
  readonly groupJid: string
  readonly targetJid: string
  readonly mutedBy: string
  readonly expiresAt: number
  readonly mutedAt: number
}

export interface AutomodSettings {
  readonly antilink: boolean
  readonly antispam: boolean
  readonly antitoxic: boolean
}

export class GroupModerationSuiteService implements Service {
  readonly name = 'group-moderation-suite'
  private readonly db: DatabaseInstance
  private readonly logger: Logger
  private readonly spamHistory = new Map<string, number[]>()

  constructor(databasePath: string, logger: Logger) {
    this.db = initSqliteDatabase(databasePath)
    this.logger = logger.child({ service: 'group-moderation-suite' })
    this.migrate()
  }

  initialize(_context: ServiceContext): void {
    this.logger.info('group moderation suite initialized')
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS group_blacklist (
        group_jid TEXT NOT NULL,
        target_jid TEXT NOT NULL,
        banned_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        banned_at INTEGER NOT NULL,
        PRIMARY KEY (group_jid, target_jid)
      );

      CREATE TABLE IF NOT EXISTS group_mutes (
        group_jid TEXT NOT NULL,
        target_jid TEXT NOT NULL,
        muted_by TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        muted_at INTEGER NOT NULL,
        PRIMARY KEY (group_jid, target_jid)
      );

      CREATE TABLE IF NOT EXISTS group_warn_limits (
        group_jid TEXT PRIMARY KEY,
        limit_count INTEGER NOT NULL DEFAULT 3,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_automod_settings (
        group_jid TEXT PRIMARY KEY,
        antilink INTEGER NOT NULL DEFAULT 0,
        antispam INTEGER NOT NULL DEFAULT 0,
        antitoxic INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_welcome_leave_toggle (
        group_jid TEXT PRIMARY KEY,
        welcome_enabled INTEGER NOT NULL DEFAULT 1,
        leave_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  // --- Blacklist / Ban ---
  ban(groupJid: string, targetJid: string, bannedBy: string, reason: string): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO group_blacklist (group_jid, target_jid, banned_by, reason, banned_at)
         VALUES (@groupJid, @targetJid, @bannedBy, @reason, @bannedAt)
         ON CONFLICT(group_jid, target_jid) DO UPDATE SET
           banned_by = excluded.banned_by,
           reason = excluded.reason,
           banned_at = excluded.banned_at`,
      )
      .run({
        groupJid,
        targetJid,
        bannedBy,
        reason: reason.trim() || 'Melanggar aturan grup',
        bannedAt: now,
      })
  }

  unban(groupJid: string, targetJidOrPhone: string): boolean {
    const normalized = targetJidOrPhone.replace(/[^0-9]/g, '')
    const row = this.db
      .prepare('SELECT target_jid FROM group_blacklist WHERE group_jid = ? AND (target_jid = ? OR target_jid LIKE ?)')
      .get(groupJid, targetJidOrPhone, `%${normalized}%`) as { target_jid: string } | undefined

    if (!row) return false
    const result = this.db
      .prepare('DELETE FROM group_blacklist WHERE group_jid = ? AND target_jid = ?')
      .run(groupJid, row.target_jid)
    return result.changes > 0
  }

  isBanned(groupJid: string, targetJid: string): boolean {
    const normalized = targetJid.split(':')[0]
    const row = this.db
      .prepare('SELECT 1 FROM group_blacklist WHERE group_jid = ? AND (target_jid = ? OR target_jid LIKE ?)')
      .get(groupJid, targetJid, `${normalized}%`)
    return Boolean(row)
  }

  listBanned(groupJid: string): BannedRecord[] {
    const rows = this.db
      .prepare('SELECT group_jid, target_jid, banned_by, reason, banned_at FROM group_blacklist WHERE group_jid = ? ORDER BY banned_at DESC')
      .all(groupJid) as Array<{
        group_jid: string
        target_jid: string
        banned_by: string
        reason: string
        banned_at: number
      }>
    return rows.map((r) => ({
      groupJid: r.group_jid,
      targetJid: r.target_jid,
      bannedBy: r.banned_by,
      reason: r.reason,
      bannedAt: r.banned_at,
    }))
  }

  // --- Mute ---
  mute(groupJid: string, targetJid: string, mutedBy: string, durationMs: number): number {
    const now = Date.now()
    const expiresAt = now + durationMs
    this.db
      .prepare(
        `INSERT INTO group_mutes (group_jid, target_jid, muted_by, expires_at, muted_at)
         VALUES (@groupJid, @targetJid, @mutedBy, @expiresAt, @mutedAt)
         ON CONFLICT(group_jid, target_jid) DO UPDATE SET
           muted_by = excluded.muted_by,
           expires_at = excluded.expires_at,
           muted_at = excluded.muted_at`,
      )
      .run({
        groupJid,
        targetJid,
        mutedBy,
        expiresAt,
        mutedAt: now,
      })
    return expiresAt
  }

  unmute(groupJid: string, targetJid: string): boolean {
    const normalized = targetJid.split(':')[0]
    const row = this.db
      .prepare('SELECT target_jid FROM group_mutes WHERE group_jid = ? AND (target_jid = ? OR target_jid LIKE ?)')
      .get(groupJid, targetJid, `${normalized}%`) as { target_jid: string } | undefined

    if (!row) return false
    const result = this.db
      .prepare('DELETE FROM group_mutes WHERE group_jid = ? AND target_jid = ?')
      .run(groupJid, row.target_jid)
    return result.changes > 0
  }

  isMuted(groupJid: string, targetJid: string, now = Date.now()): boolean {
    const normalized = targetJid.split(':')[0]
    const row = this.db
      .prepare('SELECT expires_at FROM group_mutes WHERE group_jid = ? AND (target_jid = ? OR target_jid LIKE ?)')
      .get(groupJid, targetJid, `${normalized}%`) as { expires_at: number } | undefined

    if (!row) return false
    if (now >= row.expires_at) {
      this.unmute(groupJid, targetJid)
      return false
    }
    return true
  }

  getMute(groupJid: string, targetJid: string): MutedRecord | undefined {
    const normalized = targetJid.split(':')[0]
    const row = this.db
      .prepare('SELECT group_jid, target_jid, muted_by, expires_at, muted_at FROM group_mutes WHERE group_jid = ? AND (target_jid = ? OR target_jid LIKE ?)')
      .get(groupJid, targetJid, `${normalized}%`) as {
        group_jid: string
        target_jid: string
        muted_by: string
        expires_at: number
        muted_at: number
      } | undefined

    if (!row) return undefined
    return {
      groupJid: row.group_jid,
      targetJid: row.target_jid,
      mutedBy: row.muted_by,
      expiresAt: row.expires_at,
      mutedAt: row.muted_at,
    }
  }

  // --- Warn Limit ---
  setWarnLimit(groupJid: string, limit: number): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO group_warn_limits (group_jid, limit_count, updated_at)
         VALUES (@groupJid, @limit, @now)
         ON CONFLICT(group_jid) DO UPDATE SET
           limit_count = excluded.limit_count,
           updated_at = excluded.updated_at`,
      )
      .run({ groupJid, limit, now })
  }

  getWarnLimit(groupJid: string): number {
    const row = this.db
      .prepare('SELECT limit_count FROM group_warn_limits WHERE group_jid = ?')
      .get(groupJid) as { limit_count: number } | undefined
    return row?.limit_count ?? 3
  }

  // --- Auto Mod Filters ---
  setAutomod(groupJid: string, filter: 'antilink' | 'antispam' | 'antitoxic', enabled: boolean): void {
    const now = Date.now()
    const current = this.getAutomod(groupJid)
    const antilink = filter === 'antilink' ? (enabled ? 1 : 0) : (current.antilink ? 1 : 0)
    const antispam = filter === 'antispam' ? (enabled ? 1 : 0) : (current.antispam ? 1 : 0)
    const antitoxic = filter === 'antitoxic' ? (enabled ? 1 : 0) : (current.antitoxic ? 1 : 0)

    this.db
      .prepare(
        `INSERT INTO group_automod_settings (group_jid, antilink, antispam, antitoxic, updated_at)
         VALUES (@groupJid, @antilink, @antispam, @antitoxic, @now)
         ON CONFLICT(group_jid) DO UPDATE SET
           antilink = excluded.antilink,
           antispam = excluded.antispam,
           antitoxic = excluded.antitoxic,
           updated_at = excluded.updated_at`,
      )
      .run({ groupJid, antilink, antispam, antitoxic, now })
  }

  getAutomod(groupJid: string): AutomodSettings {
    const row = this.db
      .prepare('SELECT antilink, antispam, antitoxic FROM group_automod_settings WHERE group_jid = ?')
      .get(groupJid) as { antilink: number; antispam: number; antitoxic: number } | undefined

    return {
      antilink: Boolean(row?.antilink),
      antispam: Boolean(row?.antispam),
      antitoxic: Boolean(row?.antitoxic),
    }
  }

  // --- Welcome / Leave Toggle ---
  setWelcomeToggle(groupJid: string, enabled: boolean): void {
    const now = Date.now()
    const leaveEnabled = this.isLeaveEnabled(groupJid) ? 1 : 0
    this.db
      .prepare(
        `INSERT INTO group_welcome_leave_toggle (group_jid, welcome_enabled, leave_enabled, updated_at)
         VALUES (@groupJid, @enabled, @leaveEnabled, @now)
         ON CONFLICT(group_jid) DO UPDATE SET
           welcome_enabled = excluded.welcome_enabled,
           updated_at = excluded.updated_at`,
      )
      .run({ groupJid, enabled: enabled ? 1 : 0, leaveEnabled, now })
  }

  setLeaveToggle(groupJid: string, enabled: boolean): void {
    const now = Date.now()
    const welcomeEnabled = this.isWelcomeEnabled(groupJid) ? 1 : 0
    this.db
      .prepare(
        `INSERT INTO group_welcome_leave_toggle (group_jid, welcome_enabled, leave_enabled, updated_at)
         VALUES (@groupJid, @welcomeEnabled, @enabled, @now)
         ON CONFLICT(group_jid) DO UPDATE SET
           leave_enabled = excluded.leave_enabled,
           updated_at = excluded.updated_at`,
      )
      .run({ groupJid, welcomeEnabled, enabled: enabled ? 1 : 0, now })
  }

  isWelcomeEnabled(groupJid: string): boolean {
    const row = this.db
      .prepare('SELECT welcome_enabled FROM group_welcome_leave_toggle WHERE group_jid = ?')
      .get(groupJid) as { welcome_enabled: number } | undefined
    return row ? Boolean(row.welcome_enabled) : true
  }

  isLeaveEnabled(groupJid: string): boolean {
    const row = this.db
      .prepare('SELECT leave_enabled FROM group_welcome_leave_toggle WHERE group_jid = ?')
      .get(groupJid) as { leave_enabled: number } | undefined
    return row ? Boolean(row.leave_enabled) : true
  }

  // --- In-Memory Sliding Window Antispam ---
  checkAndRecordSpam(groupJid: string, senderJid: string, maxMessages = 5, windowMs = 5000, now = Date.now()): boolean {
    const key = `${groupJid}:${senderJid.split(':')[0]}`
    const timestamps = (this.spamHistory.get(key) ?? []).filter((t) => now - t <= windowMs)
    timestamps.push(now)
    this.spamHistory.set(key, timestamps)
    return timestamps.length > maxMessages
  }
}
