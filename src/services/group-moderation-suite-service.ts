import { createHash } from 'node:crypto'
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

export type BanStcMode = 'off' | 'on' | 'strict'

export interface GroupSecuritySettings {
  readonly banstc: BanStcMode
  readonly antiraid: boolean
}

export class GroupModerationSuiteService implements Service {
  readonly name = 'group-moderation-suite'
  private readonly db: DatabaseInstance
  private readonly logger: Logger
  private readonly spamHistory = new Map<string, number[]>()
  private readonly inviteLinkCache = new Map<string, { link: string; expiresAt: number }>()
  private readonly stickerStrikes = new Map<string, { count: number; expiresAt: number }>()
  private readonly raidJoinWindows = new Map<string, { timestamps: number[]; lastLockAt: number }>()
  private readonly newcomerQuarantine = new Map<string, { joinedAt: number; expiresAt: number }>()
  private readonly detailedSpamBuckets = new Map<string, {
    timestamps: number[]
    recentHashes: Array<{ hash: string; ts: number }>
    tier1WarnedAt: number | null
    lastWarnSentAt: number | null
    mutedUntil: number | null
    expiresAt: number
  }>()
  private readonly groupAdminsCache = new Map<string, { adminJids: Set<string>; expiresAt: number }>()
  private readonly gcTimer: NodeJS.Timeout

  constructor(databasePath: string, logger: Logger) {
    this.db = initSqliteDatabase(databasePath)
    this.logger = logger.child({ service: 'group-moderation-suite' })
    this.migrate()
    this.gcTimer = setInterval(() => this.pruneExpiredSecurity(), 30_000)
    this.gcTimer.unref()
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

      CREATE TABLE IF NOT EXISTS user_identities (
        phone_jid TEXT NOT NULL,
        lid TEXT NOT NULL,
        last_seen INTEGER NOT NULL,
        PRIMARY KEY (phone_jid, lid)
      );

      CREATE INDEX IF NOT EXISTS idx_user_identities_phone ON user_identities (phone_jid);
      CREATE INDEX IF NOT EXISTS idx_user_identities_lid ON user_identities (lid);

      CREATE TABLE IF NOT EXISTS moderation_audit_chain (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_jid TEXT NOT NULL,
        actor_jid TEXT NOT NULL,
        action TEXT NOT NULL,
        target_jid TEXT,
        payload TEXT,
        created_at INTEGER NOT NULL,
        prev_hash TEXT NOT NULL,
        current_hash TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_chain_group ON moderation_audit_chain (group_jid);

      CREATE TABLE IF NOT EXISTS group_security_settings (
        group_jid TEXT PRIMARY KEY,
        banstc_mode TEXT NOT NULL DEFAULT 'off',
        antiraid_enabled INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      );
    `)
  }

  // --- User Identities (JID <-> LID Mapping) ---
  recordIdentity(phoneJid: string, lid: string): void {
    if (!phoneJid || !lid) return
    const cleanPhone = phoneJid.split(':')[0]
    const cleanLid = lid.split(':')[0]
    const now = Date.now()
    try {
      this.db
        .prepare(
          `INSERT INTO user_identities (phone_jid, lid, last_seen)
           VALUES (@cleanPhone, @cleanLid, @now)
           ON CONFLICT(phone_jid, lid) DO UPDATE SET last_seen = excluded.last_seen`,
        )
        .run({ cleanPhone, cleanLid, now })
    } catch (err) {
      this.logger.warn({ err, phoneJid, lid }, 'failed to record user identity')
    }
  }

  resolveAliases(identifier: string): string[] {
    const raw = identifier.trim()
    const clean = raw.split(':')[0]
    const aliases = new Set<string>([raw, clean])

    try {
      if (clean.endsWith('@lid')) {
        const rows = this.db
          .prepare('SELECT phone_jid FROM user_identities WHERE lid = ?')
          .all(clean) as Array<{ phone_jid: string }>
        for (const row of rows) {
          aliases.add(row.phone_jid)
          aliases.add(row.phone_jid.replace('@s.whatsapp.net', ''))
        }
      } else {
        const phone = clean.includes('@') ? clean : `${clean}@s.whatsapp.net`
        aliases.add(phone)
        const rows = this.db
          .prepare('SELECT lid FROM user_identities WHERE phone_jid = ?')
          .all(phone) as Array<{ lid: string }>
        for (const row of rows) {
          aliases.add(row.lid)
        }
      }
    } catch {
      // Fallback
    }

    return Array.from(aliases)
  }

  // --- Append-Only Audit Hash Chain ---
  recordAudit(groupJid: string, actorJid: string, action: string, targetJid?: string, payload?: string): string {
    const now = Date.now()
    const lastRow = this.db
      .prepare('SELECT current_hash FROM moderation_audit_chain WHERE group_jid = ? ORDER BY id DESC LIMIT 1')
      .get(groupJid) as { current_hash: string } | undefined

    const prevHash = lastRow?.current_hash ?? '0000000000000000000000000000000000000000000000000000000000000000'
    const targetStr = targetJid ?? ''
    const payloadStr = payload ?? ''

    const currentHash = createHash('sha256')
      .update(`${prevHash}:${groupJid}:${actorJid}:${action}:${targetStr}:${now}:${payloadStr}`)
      .digest('hex')

    try {
      this.db
        .prepare(
          `INSERT INTO moderation_audit_chain (group_jid, actor_jid, action, target_jid, payload, created_at, prev_hash, current_hash)
           VALUES (@groupJid, @actorJid, @action, @targetJid, @payload, @now, @prevHash, @currentHash)`,
        )
        .run({
          groupJid,
          actorJid,
          action,
          targetJid: targetStr,
          payload: payloadStr,
          now,
          prevHash,
          currentHash,
        })
    } catch (err) {
      this.logger.error({ err, action, groupJid }, 'failed to write audit chain record')
    }

    return currentHash
  }

  verifyAuditChain(groupJid?: string): { valid: boolean; totalEvents: number; brokenAt?: number } {
    const rows = groupJid
      ? (this.db
          .prepare('SELECT id, group_jid, actor_jid, action, target_jid, payload, created_at, prev_hash, current_hash FROM moderation_audit_chain WHERE group_jid = ? ORDER BY id ASC')
          .all(groupJid) as Array<{
            id: number
            group_jid: string
            actor_jid: string
            action: string
            target_jid: string
            payload: string
            created_at: number
            prev_hash: string
            current_hash: string
          }>)
      : (this.db
          .prepare('SELECT id, group_jid, actor_jid, action, target_jid, payload, created_at, prev_hash, current_hash FROM moderation_audit_chain ORDER BY id ASC')
          .all() as Array<{
            id: number
            group_jid: string
            actor_jid: string
            action: string
            target_jid: string
            payload: string
            created_at: number
            prev_hash: string
            current_hash: string
          }>)

    let expectedPrevHash = '0000000000000000000000000000000000000000000000000000000000000000'
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row.prev_hash !== expectedPrevHash) {
        return { valid: false, totalEvents: rows.length, brokenAt: row.id }
      }
      const calculatedHash = createHash('sha256')
        .update(`${row.prev_hash}:${row.group_jid}:${row.actor_jid}:${row.action}:${row.target_jid}:${row.created_at}:${row.payload}`)
        .digest('hex')

      if (row.current_hash !== calculatedHash) {
        return { valid: false, totalEvents: rows.length, brokenAt: row.id }
      }
      expectedPrevHash = row.current_hash
    }

    return { valid: true, totalEvents: rows.length }
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
    const trimmed = targetJidOrPhone.trim()
    if (!trimmed) return false
    const aliases = this.resolveAliases(trimmed)
    const placeholders = aliases.map(() => '?').join(',')
    const normalized = trimmed.replace(/[^0-9]/g, '')
    
    let row: { target_jid: string } | undefined
    if (normalized.length >= 7) {
      row = this.db
        .prepare(`SELECT target_jid FROM group_blacklist WHERE group_jid = ? AND (target_jid IN (${placeholders}) OR target_jid LIKE ?) LIMIT 1`)
        .get(groupJid, ...aliases, `%${normalized}%`) as { target_jid: string } | undefined
    } else {
      row = this.db
        .prepare(`SELECT target_jid FROM group_blacklist WHERE group_jid = ? AND target_jid IN (${placeholders}) LIMIT 1`)
        .get(groupJid, ...aliases) as { target_jid: string } | undefined
    }

    if (!row) return false
    const result = this.db
      .prepare('DELETE FROM group_blacklist WHERE group_jid = ? AND target_jid = ?')
      .run(groupJid, row.target_jid)
    return result.changes > 0
  }

  isBanned(groupJid: string, targetJid: string): boolean {
    const aliases = this.resolveAliases(targetJid)
    const placeholders = aliases.map(() => '?').join(',')
    const bare = targetJid.split('@')[0]?.split(':')[0]?.replace(/[^0-9]/g, '') ?? ''
    
    let row: unknown
    if (bare.length >= 7) {
      row = this.db
        .prepare(`SELECT 1 FROM group_blacklist WHERE group_jid = ? AND (target_jid IN (${placeholders}) OR target_jid LIKE ?) LIMIT 1`)
        .get(groupJid, ...aliases, `%${bare}%`)
    } else {
      row = this.db
        .prepare(`SELECT 1 FROM group_blacklist WHERE group_jid = ? AND target_jid IN (${placeholders}) LIMIT 1`)
        .get(groupJid, ...aliases)
    }
    return Boolean(row)
  }

  getRecentGroupMessageIds(groupJid: string, limit: number): string[] {
    const rows = this.db
      .prepare('SELECT message_id FROM messages WHERE remote_jid = ? ORDER BY timestamp DESC LIMIT ?')
      .all(groupJid, limit) as Array<{ message_id: string }>
    return rows.map((r) => r.message_id)
  }

  shutdown(): void {
    try {
      this.db.close()
    } catch {}
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
    const aliases = this.resolveAliases(targetJid)
    const placeholders = aliases.map(() => '?').join(',')
    const normalized = targetJid.split(':')[0]
    const row = this.db
      .prepare(`SELECT target_jid FROM group_mutes WHERE group_jid = ? AND (target_jid IN (${placeholders}) OR target_jid LIKE ?) LIMIT 1`)
      .get(groupJid, ...aliases, `${normalized}%`) as { target_jid: string } | undefined

    if (!row) return false
    const result = this.db
      .prepare('DELETE FROM group_mutes WHERE group_jid = ? AND target_jid = ?')
      .run(groupJid, row.target_jid)
    return result.changes > 0
  }

  isMuted(groupJid: string, targetJid: string, now = Date.now()): boolean {
    const aliases = this.resolveAliases(targetJid)
    const placeholders = aliases.map(() => '?').join(',')
    const normalized = targetJid.split(':')[0]
    const row = this.db
      .prepare(`SELECT target_jid, expires_at FROM group_mutes WHERE group_jid = ? AND (target_jid IN (${placeholders}) OR target_jid LIKE ?) LIMIT 1`)
      .get(groupJid, ...aliases, `${normalized}%`) as { target_jid: string; expires_at: number } | undefined

    if (!row) return false
    if (now >= row.expires_at) {
      this.unmute(groupJid, row.target_jid)
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

    // Memory protection: prune stale users if map exceeds 1000 items
    if (this.spamHistory.size > 1000) {
      for (const [k, ts] of this.spamHistory.entries()) {
        if (ts.every((t) => now - t > windowMs)) {
          this.spamHistory.delete(k)
        }
      }
    }

    return timestamps.length > maxMessages
  }

  // --- Invite Link In-Memory Cache (TTL 30 min) ---
  async getCachedGroupInviteLink(
    groupJid: string,
    fetcher: () => Promise<string | undefined>,
    ttlMs = 30 * 60 * 1000,
  ): Promise<string | undefined> {
    const cached = this.inviteLinkCache.get(groupJid)
    if (cached && Date.now() < cached.expiresAt) {
      return cached.link
    }
    try {
      const link = await fetcher()
      if (link) {
        this.inviteLinkCache.set(groupJid, { link, expiresAt: Date.now() + ttlMs })
      }
      return link
    } catch {
      return undefined
    }
  }

  invalidateGroupInviteLink(groupJid: string): void {
    this.inviteLinkCache.delete(groupJid)
  }

  // --- Group Security Settings (banstc, antiraid) ---
  getSecuritySettings(groupJid: string): GroupSecuritySettings {
    const row = this.db
      .prepare('SELECT banstc_mode, antiraid_enabled FROM group_security_settings WHERE group_jid = ?')
      .get(groupJid) as { banstc_mode: string; antiraid_enabled: number } | undefined

    return {
      banstc: (row?.banstc_mode as BanStcMode) || 'off',
      antiraid: row ? Boolean(row.antiraid_enabled) : true,
    }
  }

  setBanstc(groupJid: string, mode: BanStcMode): void {
    const now = Date.now()
    const current = this.getSecuritySettings(groupJid)
    this.db
      .prepare(
        `INSERT INTO group_security_settings (group_jid, banstc_mode, antiraid_enabled, updated_at)
         VALUES (@groupJid, @mode, @antiraid, @now)
         ON CONFLICT(group_jid) DO UPDATE SET
           banstc_mode = excluded.banstc_mode,
           updated_at = excluded.updated_at`,
      )
      .run({ groupJid, mode, antiraid: current.antiraid ? 1 : 0, now })
  }

  setAntiraid(groupJid: string, enabled: boolean): void {
    const now = Date.now()
    const current = this.getSecuritySettings(groupJid)
    this.db
      .prepare(
        `INSERT INTO group_security_settings (group_jid, banstc_mode, antiraid_enabled, updated_at)
         VALUES (@groupJid, @mode, @enabled, @now)
         ON CONFLICT(group_jid) DO UPDATE SET
           antiraid_enabled = excluded.antiraid_enabled,
           updated_at = excluded.updated_at`,
      )
      .run({ groupJid, mode: current.banstc, enabled: enabled ? 1 : 0, now })
  }

  // --- Sticker Strikes (1h TTL) ---
  addStickerStrike(groupJid: string, senderJid: string, ttlMs = 3_600_000, now = Date.now()): number {
    const clean = senderJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
    const key = `${groupJid}:${clean}`
    const cur = this.stickerStrikes.get(key)
    const count = cur && cur.expiresAt > now ? cur.count + 1 : 1
    const expiresAt = now + ttlMs
    this.stickerStrikes.set(key, { count, expiresAt })
    return count
  }

  clearStickerStrikes(groupJid: string, senderJid: string): void {
    const clean = senderJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
    this.stickerStrikes.delete(`${groupJid}:${clean}`)
  }

  // --- Join Velocity Guard & Newcomer Media Quarantine (24h Window) ---
  recordGroupJoins(
    groupJid: string,
    participants: readonly string[],
    windowMs = 10_000,
    limit = 3,
    quarantineMs = 86_400_000,
    now = Date.now(),
  ): { recentJoins: number; triggerRaidLock: boolean } {
    const cutoff = now - windowMs
    const win = this.raidJoinWindows.get(groupJid) ?? { timestamps: [], lastLockAt: 0 }
    win.timestamps = win.timestamps.filter((t) => t > cutoff)

    for (const jid of participants) {
      const clean = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
      if (!clean) continue
      win.timestamps.push(now)
      const qKey = `${groupJid}:${clean}`
      this.newcomerQuarantine.set(qKey, { joinedAt: now, expiresAt: now + quarantineMs })
    }

    const triggerRaidLock = win.timestamps.length >= limit && now - win.lastLockAt >= 60_000
    if (triggerRaidLock) win.lastLockAt = now
    this.raidJoinWindows.set(groupJid, win)

    return { recentJoins: win.timestamps.length, triggerRaidLock }
  }

  isQuarantined(groupJid: string, senderJid: string, now = Date.now()): boolean {
    const clean = senderJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
    const key = `${groupJid}:${clean}`
    const q = this.newcomerQuarantine.get(key)
    if (!q) return false
    if (q.expiresAt <= now) {
      this.newcomerQuarantine.delete(key)
      return false
    }
    return true
  }

  removeQuarantine(groupJid: string, senderJid: string): void {
    const clean = senderJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
    this.newcomerQuarantine.delete(`${groupJid}:${clean}`)
  }

  // --- Sliding-Window + Duplicate Text Hash Anti-Spam ---
  evaluateDetailedSpam(
    groupJid: string,
    senderJid: string,
    text: string,
    config = {
      maxMessages: 5,
      rateWindowMs: 3_000,
      duplicateLimit: 3,
      duplicateWindowMs: 5_000,
      warningCooldownMs: 15_000,
      muteDurationMs: 300_000,
    },
    now = Date.now(),
  ): {
    violated: boolean
    tier: 0 | 1 | 2
    shouldWarn: boolean
    reason?: 'rate_limit' | 'duplicate_hash'
  } {
    const clean = senderJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
    const key = `${groupJid}:${clean}`
    const ttl = Math.max(config.muteDurationMs, config.warningCooldownMs * 2, 30_000)

    let b = this.detailedSpamBuckets.get(key)
    if (!b || b.expiresAt <= now) {
      b = {
        timestamps: [],
        recentHashes: [],
        tier1WarnedAt: null,
        lastWarnSentAt: null,
        mutedUntil: null,
        expiresAt: now + ttl,
      }
    }

    if (b.mutedUntil && b.mutedUntil > now) {
      this.detailedSpamBuckets.set(key, b)
      return { violated: true, tier: 2, shouldWarn: false, reason: 'rate_limit' }
    }

    b.timestamps = b.timestamps.filter((t) => t > now - config.rateWindowMs)
    b.timestamps.push(now)
    const rateExceeded = b.timestamps.length > config.maxMessages

    let dupExceeded = false
    if (text && text.trim().length > 0) {
      b.recentHashes = b.recentHashes.filter((h) => h.ts > now - config.duplicateWindowMs)
      const digest = createHash('sha256')
        .update(text.trim().replace(/\s+/g, ' ').toLowerCase())
        .digest('hex')
      b.recentHashes.push({ hash: digest, ts: now })
      if (b.recentHashes.length > 10) b.recentHashes = b.recentHashes.slice(-10)
      const sameCount = b.recentHashes.filter((h) => h.hash === digest).length
      if (sameCount >= config.duplicateLimit) dupExceeded = true
    }

    b.expiresAt = now + ttl
    if (!rateExceeded && !dupExceeded) {
      this.detailedSpamBuckets.set(key, b)
      return { violated: false, tier: 0, shouldWarn: false }
    }

    const reason = dupExceeded ? 'duplicate_hash' : 'rate_limit'
    const recentlyWarned = b.tier1WarnedAt !== null && now - b.tier1WarnedAt <= 30_000

    if (!recentlyWarned) {
      b.tier1WarnedAt = now
      const shouldWarn = !b.lastWarnSentAt || now - b.lastWarnSentAt >= config.warningCooldownMs
      if (shouldWarn) b.lastWarnSentAt = now
      this.detailedSpamBuckets.set(key, b)
      return { violated: true, tier: 1, shouldWarn, reason }
    }

    b.mutedUntil = now + config.muteDurationMs
    b.expiresAt = Math.max(b.expiresAt, b.mutedUntil)
    this.detailedSpamBuckets.set(key, b)
    this.mute(groupJid, senderJid, 'system', config.muteDurationMs)
    return { violated: true, tier: 2, shouldWarn: false, reason }
  }

  // --- In-Memory Group Admin Cache (15m TTL) ---
  isSenderAdminCached(groupJid: string, senderJid: string): boolean | undefined {
    const cached = this.groupAdminsCache.get(groupJid)
    if (cached && cached.expiresAt > Date.now()) {
      const clean = senderJid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
      return cached.adminJids.has(clean)
    }
    return undefined
  }

  cacheGroupAdmins(groupJid: string, adminJids: readonly string[], ttlMs = 15 * 60 * 1000): void {
    const set = new Set<string>()
    for (const jid of adminJids) {
      const clean = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
      if (clean) set.add(clean)
    }
    this.groupAdminsCache.set(groupJid, { adminJids: set, expiresAt: Date.now() + ttlMs })
  }

  invalidateGroupAdmins(groupJid: string): void {
    this.groupAdminsCache.delete(groupJid)
  }

  private pruneExpiredSecurity(now = Date.now()): void {
    for (const [k, v] of this.stickerStrikes) if (v.expiresAt <= now) this.stickerStrikes.delete(k)
    for (const [k, v] of this.newcomerQuarantine) if (v.expiresAt <= now) this.newcomerQuarantine.delete(k)
    for (const [k, v] of this.detailedSpamBuckets) if (v.expiresAt <= now) this.detailedSpamBuckets.delete(k)
    for (const [k, v] of this.groupAdminsCache) if (v.expiresAt <= now) this.groupAdminsCache.delete(k)
  }
}
