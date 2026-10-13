import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { initSqliteDatabase, requireDatabase, type DatabaseInstance } from '../storage-helpers.js'
import { isGroupJid } from '../framework/validation.js'

export interface OfficialGroupRecord {
  readonly jid: string
  readonly name: string
  readonly addedAt: number
  readonly addedBy: string
}

export interface CommunityBlacklistRecord {
  readonly jid: string
  readonly reason: string
  readonly bannedAt: number
  readonly bannedBy: string
}

export class CommunityService implements Service {
  readonly name = 'community'
  private db?: DatabaseInstance

  constructor(
    private readonly databasePath: string,
    private readonly logger: Logger,
  ) {}

  initialize(_context: ServiceContext): void {
    this.db = initSqliteDatabase(this.databasePath, { foreignKeys: true })
    this.migrate()
    this.logger.info({ component: 'community' }, 'CommunityService initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) {
      this.db.close()
    }
    this.db = undefined
  }

  private database(): DatabaseInstance {
    return requireDatabase(this.db, 'community')
  }

  private migrate(): void {
    const db = this.database()
    db.exec(`
      CREATE TABLE IF NOT EXISTS community_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        added_at INTEGER NOT NULL,
        added_by TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS community_blacklist (
        jid TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        banned_at INTEGER NOT NULL,
        banned_by TEXT NOT NULL
      );
    `)
  }

  registerGroup(jid: string, name: string, addedBy: string): void {
    if (!isGroupJid(jid)) throw new Error('JID must be a valid WhatsApp group JID (@g.us)')
    const db = this.database()
    db.prepare(`
      INSERT INTO community_groups (jid, name, added_at, added_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        added_at = excluded.added_at,
        added_by = excluded.added_by
    `).run(jid, name, Date.now(), addedBy)
  }

  removeGroup(jid: string): boolean {
    const db = this.database()
    const result = db.prepare('DELETE FROM community_groups WHERE jid = ?').run(jid)
    return result.changes > 0
  }

  listGroups(): OfficialGroupRecord[] {
    const db = this.database()
    const rows = db.prepare('SELECT jid, name, added_at, added_by FROM community_groups ORDER BY added_at ASC').all() as Array<{
      jid: string
      name: string
      added_at: number
      added_by: string
    }>
    return rows.map((r) => ({
      jid: r.jid,
      name: r.name,
      addedAt: r.added_at,
      addedBy: r.added_by,
    }))
  }

  isOfficialGroup(jid: string): boolean {
    const db = this.database()
    const row = db.prepare('SELECT 1 FROM community_groups WHERE jid = ?').get(jid)
    return Boolean(row)
  }

  banUser(jid: string, reason: string, bannedBy: string): void {
    const bare = jid.split(':')[0]
    const db = this.database()
    db.prepare(`
      INSERT INTO community_blacklist (jid, reason, banned_at, banned_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        reason = excluded.reason,
        banned_at = excluded.banned_at,
        banned_by = excluded.banned_by
    `).run(bare, reason, Date.now(), bannedBy)
  }

  unbanUser(jid: string): boolean {
    const bare = jid.split(':')[0]
    const db = this.database()
    const result = db.prepare('DELETE FROM community_blacklist WHERE jid = ?').run(bare)
    return result.changes > 0
  }

  isBlacklisted(jid: string): boolean {
    const bare = jid.split(':')[0]
    const db = this.database()
    const row = db.prepare('SELECT 1 FROM community_blacklist WHERE jid = ?').get(bare)
    return Boolean(row)
  }

  listBlacklist(): CommunityBlacklistRecord[] {
    const db = this.database()
    const rows = db.prepare('SELECT jid, reason, banned_at, banned_by FROM community_blacklist ORDER BY banned_at DESC').all() as Array<{
      jid: string
      reason: string
      banned_at: number
      banned_by: string
    }>
    return rows.map((r) => ({
      jid: r.jid,
      reason: r.reason,
      bannedAt: r.banned_at,
      bannedBy: r.banned_by,
    }))
  }
}
