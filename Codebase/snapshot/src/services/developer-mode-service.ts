import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'

export type DeveloperModeScope = 'observer' | 'operator'
export type DeveloperModeAuditOutcome = 'allowed' | 'denied' | 'created' | 'revoked' | 'expired' | 'disabled' | 'enabled'

export interface DeveloperModeActivation {
  readonly id: string
  readonly targetJid: string
  readonly scope: DeveloperModeScope
  readonly reason: string
  readonly ownerJid: string
  readonly activatedAt: number
  readonly expiresAt: number
  readonly revokedAt?: number
  readonly expiredAt?: number
}

export interface DeveloperModeDecision {
  readonly allowed: boolean
  readonly reason: string
  readonly activation?: DeveloperModeActivation
}

export interface DeveloperModeAuditRecord {
  readonly id: number
  readonly event: string
  readonly actorHash: string
  readonly targetHash?: string
  readonly activationId?: string
  readonly scope?: DeveloperModeScope
  readonly at: number
  readonly outcome: DeveloperModeAuditOutcome
}

export interface DeveloperModeServiceOptions {
  readonly clock?: () => number
  readonly maxActivations?: number
  readonly maxAuditRecords?: number
}

export const DEVELOPER_MODE_MIN_DURATION_MS = 60_000
export const DEVELOPER_MODE_MAX_DURATION_MS = 24 * 60 * 60 * 1_000
export const DEVELOPER_MODE_MAX_REASON_LENGTH = 240
export const DEVELOPER_MODE_MAX_ACTIVE_ACTIVATIONS = 20
export const DEVELOPER_MODE_MAX_AUDIT_RECORDS = 1_000

interface ActivationRow {
  id: string
  target_jid: string
  scope: DeveloperModeScope
  reason: string
  owner_jid: string
  activated_at: number
  expires_at: number
  revoked_at: number | null
  expired_at: number | null
}

interface AuditRow {
  id: number
  event: string
  actor_hash: string
  target_hash: string | null
  activation_id: string | null
  scope: DeveloperModeScope | null
  at: number
  outcome: DeveloperModeAuditOutcome
}

export function normalizeDeveloperJid(value: string): string {
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return `${trimmed}@s.whatsapp.net`
  return normalizeJid(trimmed)
}

function normalizeJid(value: string): string {
  const trimmed = value.trim()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) throw new Error('JID must contain a user and server')
  const user = trimmed.slice(0, at).split(':')[0]
  const server = trimmed.slice(at + 1).toLowerCase()
  if (!/^\d+$/.test(user) || server !== 's.whatsapp.net') {
    throw new Error('Developer Mode target must be a phone-number WhatsApp JID')
  }
  return `${user}@s.whatsapp.net`
}

function normalizeReason(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) throw new Error('Developer Mode reason cannot be empty')
  if (normalized.length > DEVELOPER_MODE_MAX_REASON_LENGTH) {
    return normalized.slice(0, DEVELOPER_MODE_MAX_REASON_LENGTH)
  }
  return normalized
}

function hashJid(jid: string): string {
  return createHash('sha256').update(jid).digest('hex').slice(0, 16)
}

function mapActivation(row: ActivationRow): DeveloperModeActivation {
  return {
    id: row.id,
    targetJid: row.target_jid,
    scope: row.scope,
    reason: row.reason,
    ownerJid: row.owner_jid,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    ...(row.expired_at === null ? {} : { expiredAt: row.expired_at }),
  }
}

function mapAudit(row: AuditRow): DeveloperModeAuditRecord {
  return {
    id: row.id,
    event: row.event,
    actorHash: row.actor_hash,
    ...(row.target_hash === null ? {} : { targetHash: row.target_hash }),
    ...(row.activation_id === null ? {} : { activationId: row.activation_id }),
    ...(row.scope === null ? {} : { scope: row.scope }),
    at: row.at,
    outcome: row.outcome,
  }
}

function scopeAllows(granted: DeveloperModeScope, requested: DeveloperModeScope): boolean {
  return granted === 'operator' || granted === requested
}

export class DeveloperModeService implements Service {
  readonly name = 'developer-mode'

  private db: Database.Database | undefined
  private readonly databasePath: string
  private readonly clock: () => number
  private readonly maxActivations: number
  private readonly maxAuditRecords: number

  constructor(
    coreDatabasePath: string,
    private readonly logger: Logger,
    options: DeveloperModeServiceOptions = {},
  ) {
    this.databasePath = coreDatabasePath
    this.clock = options.clock ?? (() => Date.now())
    this.maxActivations = options.maxActivations ?? DEVELOPER_MODE_MAX_ACTIVE_ACTIVATIONS
    this.maxAuditRecords = options.maxAuditRecords ?? DEVELOPER_MODE_MAX_AUDIT_RECORDS
    if (!Number.isInteger(this.maxActivations) || this.maxActivations < 1) {
      throw new Error('maxActivations must be a positive integer')
    }
    if (!Number.isInteger(this.maxAuditRecords) || this.maxAuditRecords < 1) {
      throw new Error('maxAuditRecords must be a positive integer')
    }
  }

  initialize(_context: ServiceContext): void {
    if (this.databasePath !== ':memory:') {
      mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    }
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
    this.logger.info({ component: 'developer-mode' }, 'Developer Mode control plane initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) this.db.close()
    this.db = undefined
  }

  isGloballyEnabled(): boolean {
    const row = this.database()
      .prepare('SELECT value FROM owner_developer_settings WHERE key = ?')
      .get('global_enabled') as { value: string } | undefined
    return row?.value !== 'false'
  }

  activate(
    ownerJid: string,
    targetJid: string,
    scope: DeveloperModeScope,
    durationMs: number,
    reason: string,
    at = this.clock(),
  ): DeveloperModeActivation {
    const owner = normalizeDeveloperJid(ownerJid)
    const target = normalizeDeveloperJid(targetJid)
    if (scope !== 'observer' && scope !== 'operator') throw new Error('Unsupported Developer Mode scope')
    if (!Number.isInteger(durationMs) || durationMs < DEVELOPER_MODE_MIN_DURATION_MS || durationMs > DEVELOPER_MODE_MAX_DURATION_MS) {
      throw new Error('Developer Mode duration must be between 1 minute and 24 hours')
    }
    const normalizedReason = normalizeReason(reason)
    const db = this.database()
    this.expireDue(at)

    const create = db.transaction(() => {
      const existing = db
        .prepare('SELECT id FROM owner_developer_activations WHERE target_jid = ? AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > ?')
        .get(target, at) as { id: string } | undefined
      if (existing) throw new Error('Target already has an active Developer Mode activation')

      const activeCount = (db
        .prepare('SELECT COUNT(*) AS count FROM owner_developer_activations WHERE revoked_at IS NULL AND expired_at IS NULL AND expires_at > ?')
        .get(at) as { count: number }).count
      if (activeCount >= this.maxActivations) throw new Error('Developer Mode activation limit reached')

      const id = `dm_${randomUUID().replace(/-/g, '').slice(0, 20)}`
      const expiresAt = at + durationMs
      db.prepare(
        `INSERT INTO owner_developer_activations
          (id, target_jid, scope, reason, owner_jid, activated_at, expires_at, revoked_at, expired_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(id, target, scope, normalizedReason, owner, at, expiresAt)
      this.insertAudit(db, 'activation.created', owner, target, id, scope, at, 'created')
      return id
    })()

    return this.getActivation(create as string) as DeveloperModeActivation
  }

  evaluate(targetJid: string, requestedScope: DeveloperModeScope = 'observer', at = this.clock()): DeveloperModeDecision {
    const target = normalizeDeveloperJid(targetJid)
    if (!this.isGloballyEnabled()) {
      this.insertAudit(this.database(), 'access.denied', target, target, undefined, requestedScope, at, 'disabled')
      return { allowed: false, reason: 'Developer Mode is globally disabled' }
    }

    this.expireDue(at)
    const row = this.database()
      .prepare(
        `SELECT id, target_jid, scope, reason, owner_jid, activated_at, expires_at, revoked_at, expired_at
         FROM owner_developer_activations
         WHERE target_jid = ? AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > ?
         ORDER BY activated_at DESC LIMIT 1`,
      )
      .get(target, at) as ActivationRow | undefined
    if (!row) {
      this.insertAudit(this.database(), 'access.denied', target, target, undefined, requestedScope, at, 'denied')
      return { allowed: false, reason: 'No active Developer Mode activation' }
    }
    if (!scopeAllows(row.scope, requestedScope)) {
      this.insertAudit(this.database(), 'access.denied', target, target, row.id, requestedScope, at, 'denied')
      return { allowed: false, reason: 'Developer Mode scope does not allow this command', activation: mapActivation(row) }
    }
    this.insertAudit(this.database(), 'access.allowed', target, target, row.id, requestedScope, at, 'allowed')
    return { allowed: true, reason: 'Active Developer Mode activation', activation: mapActivation(row) }
  }

  revoke(ownerJid: string, activationId: string, at = this.clock()): boolean {
    const owner = normalizeDeveloperJid(ownerJid)
    const db = this.database()
    const revoke = db.transaction(() => {
      const row = db
        .prepare('SELECT target_jid, scope FROM owner_developer_activations WHERE id = ? AND revoked_at IS NULL AND expired_at IS NULL')
        .get(activationId) as { target_jid: string; scope: DeveloperModeScope } | undefined
      if (!row) return false
      db.prepare('UPDATE owner_developer_activations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL AND expired_at IS NULL').run(at, activationId)
      this.insertAudit(db, 'activation.revoked', owner, row.target_jid, activationId, row.scope, at, 'revoked')
      return true
    })()
    return Boolean(revoke)
  }

  setGlobalEnabled(ownerJid: string, enabled: boolean, at = this.clock()): void {
    const owner = normalizeDeveloperJid(ownerJid)
    const db = this.database()
    db.transaction(() => {
      db.prepare(
        `INSERT INTO owner_developer_settings (key, value, updated_at)
         VALUES ('global_enabled', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(enabled ? 'true' : 'false', at)
      this.insertAudit(db, enabled ? 'mode.resumed' : 'mode.killed', owner, undefined, undefined, undefined, at, enabled ? 'enabled' : 'disabled')
    })()
  }

  getActivation(activationId: string): DeveloperModeActivation | undefined {
    const row = this.database()
      .prepare(
        `SELECT id, target_jid, scope, reason, owner_jid, activated_at, expires_at, revoked_at, expired_at
         FROM owner_developer_activations WHERE id = ?`,
      )
      .get(activationId) as ActivationRow | undefined
    return row ? mapActivation(row) : undefined
  }

  listVisibleActivations(viewerJid: string, isOwner: boolean, at = this.clock()): readonly DeveloperModeActivation[] {
    const viewer = normalizeDeveloperJid(viewerJid)
    this.expireDue(at)
    const query = isOwner
      ? `SELECT id, target_jid, scope, reason, owner_jid, activated_at, expires_at, revoked_at, expired_at
         FROM owner_developer_activations WHERE revoked_at IS NULL AND expired_at IS NULL AND expires_at > ? ORDER BY activated_at DESC`
      : `SELECT id, target_jid, scope, reason, owner_jid, activated_at, expires_at, revoked_at, expired_at
         FROM owner_developer_activations WHERE target_jid = ? AND revoked_at IS NULL AND expired_at IS NULL AND expires_at > ? ORDER BY activated_at DESC`
    const rows = (isOwner
      ? this.database().prepare(query).all(at)
      : this.database().prepare(query).all(viewer, at)) as ActivationRow[]
    return rows.map(mapActivation)
  }

  recordBoundaryDenied(actorJid: string, reason: string, at = this.clock()): void {
    const actor = normalizeDeveloperJid(actorJid)
    const boundedReason = reason.trim().slice(0, 120) || 'Developer Mode request denied'
    this.insertAudit(this.database(), 'access.denied', actor, actor, undefined, 'observer', at, 'denied')
    this.logger.debug({ reason: boundedReason }, 'Developer Mode request denied by boundary')
  }

  listAudit(limit = 50): readonly DeveloperModeAuditRecord[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
    const rows = this.database()
      .prepare(
        `SELECT id, event, actor_hash, target_hash, activation_id, scope, at, outcome
         FROM owner_developer_audit ORDER BY id DESC LIMIT ?`,
      )
      .all(safeLimit) as AuditRow[]
    return rows.map(mapAudit)
  }

  private expireDue(at: number): void {
    const db = this.database()
    const rows = db
      .prepare('SELECT id, target_jid, scope FROM owner_developer_activations WHERE revoked_at IS NULL AND expired_at IS NULL AND expires_at <= ?')
      .all(at) as Array<{ id: string; target_jid: string; scope: DeveloperModeScope }>
    if (rows.length === 0) return
    db.transaction(() => {
      for (const row of rows) {
        const result = db
          .prepare('UPDATE owner_developer_activations SET expired_at = ? WHERE id = ? AND revoked_at IS NULL AND expired_at IS NULL')
          .run(at, row.id)
        if (result.changes > 0) this.insertAudit(db, 'activation.expired', row.target_jid, row.target_jid, row.id, row.scope, at, 'expired')
      }
    })()
  }

  private insertAudit(
    db: Database.Database,
    event: string,
    actorJid: string,
    targetJid: string | undefined,
    activationId: string | undefined,
    scope: DeveloperModeScope | undefined,
    at: number,
    outcome: DeveloperModeAuditOutcome,
  ): void {
    db.prepare(
      `INSERT INTO owner_developer_audit
        (event, actor_hash, target_hash, activation_id, scope, at, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(event, hashJid(actorJid), targetJid ? hashJid(targetJid) : null, activationId ?? null, scope ?? null, at, outcome)
    db.prepare(
      `DELETE FROM owner_developer_audit
       WHERE id NOT IN (SELECT id FROM owner_developer_audit ORDER BY id DESC LIMIT ?)`,
    ).run(this.maxAuditRecords)
  }

  private migrate(): void {
    const db = this.database()
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner_developer_activations (
        id TEXT PRIMARY KEY,
        target_jid TEXT NOT NULL,
        scope TEXT NOT NULL CHECK(scope IN ('observer', 'operator')),
        reason TEXT NOT NULL,
        owner_jid TEXT NOT NULL,
        activated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        revoked_at INTEGER,
        expired_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_owner_developer_active
        ON owner_developer_activations (target_jid, expires_at, revoked_at, expired_at);

      CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_developer_one_active_target
        ON owner_developer_activations (target_jid)
        WHERE revoked_at IS NULL AND expired_at IS NULL;

      CREATE TABLE IF NOT EXISTS owner_developer_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS owner_developer_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        actor_hash TEXT NOT NULL,
        target_hash TEXT,
        activation_id TEXT,
        scope TEXT,
        at INTEGER NOT NULL,
        outcome TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_owner_developer_audit_time
        ON owner_developer_audit (id DESC);

      INSERT OR IGNORE INTO owner_developer_settings (key, value, updated_at)
        VALUES ('global_enabled', 'true', ${this.clock()});
    `)
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('Developer Mode service is not initialized')
    return this.db
  }
}
