import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { initSqliteDatabase, sha256, type DatabaseInstance } from '../storage-helpers.js'

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

// DATA CONTRACT: 16-hex SHA-256 prefix. Digests are persisted in SQLite
// (owner_developer_audit.actor_hash/target_hash) — do NOT change the length.
const hashJid = (jid: string): string => sha256(jid, 16)

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

  private db: DatabaseInstance | undefined
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
    this.db = initSqliteDatabase(this.databasePath, { foreignKeys: true })
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
    db: DatabaseInstance,
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

  private database(): DatabaseInstance {
    if (!this.db?.open) throw new Error('Developer Mode service is not initialized')
    return this.db
  }

  public async inspectStorageMatrix(pgClient?: any, redisClient?: any): Promise<{
    sqlite: {
      path: string
      sizeKb: number
      walSizeKb: number
      pageSize: number
      pageCount: number
      quickCheck: string
      latencyMs: number
      groupsCount: number
      trialGuestsCount: number
      shadowbanCount: number
    }
    postgres?: {
      available: boolean
      latencyMs?: number
      characterCount?: number
      economyAccounts?: number
      economyTotalVela?: string
      error?: string
    }
    redis?: {
      available: boolean
      latencyMs?: number
      usedMemoryHuman?: string
      keysCount?: number
      error?: string
    }
  }> {
    const db = this.database()
    const startSqlite = performance.now()
    db.prepare('SELECT 1').get()
    const latencySqlite = performance.now() - startSqlite

    let sizeKb = 0
    let walSizeKb = 0
    try {
      if (this.databasePath !== ':memory:') {
        sizeKb = Math.round(statSync(this.databasePath).size / 1024)
        try {
          walSizeKb = Math.round(statSync(`${this.databasePath}-wal`).size / 1024)
        } catch {}
      }
    } catch {}

    const pageSize = (db.prepare('PRAGMA page_size').get() as { page_size: number })?.page_size ?? 0
    const pageCount = (db.prepare('PRAGMA page_count').get() as { page_count: number })?.page_count ?? 0
    const quickCheckRow = db.prepare('PRAGMA quick_check(1)').get() as Record<string, string> | undefined
    const quickCheck = quickCheckRow ? Object.values(quickCheckRow)[0] : 'unknown'

    let groupsCount = 0
    let trialGuestsCount = 0
    let shadowbanCount = 0
    try {
      groupsCount = (db.prepare('SELECT count(*) as count FROM community_groups').get() as { count: number })?.count ?? 0
    } catch {}
    try {
      trialGuestsCount = (db.prepare('SELECT count(*) as count FROM trial_guests').get() as { count: number })?.count ?? 0
    } catch {}
    try {
      shadowbanCount = (db.prepare('SELECT count(*) as count FROM shadowbanned_users').get() as { count: number })?.count ?? 0
    } catch {}

    const result: any = {
      sqlite: {
        path: this.databasePath,
        sizeKb,
        walSizeKb,
        pageSize,
        pageCount,
        quickCheck,
        latencyMs: Math.round(latencySqlite * 100) / 100,
        groupsCount,
        trialGuestsCount,
        shadowbanCount,
      },
    }

    if (pgClient) {
      try {
        const startPg = performance.now()
        await pgClient`SELECT 1`
        const latencyPg = performance.now() - startPg

        let characterCount = 0
        let economyAccounts = 0
        let economyTotalVela = '0'

        try {
          const charRows = await pgClient`SELECT count(*)::int as count FROM character_profiles`
          characterCount = charRows[0]?.count ?? 0
        } catch {}

        try {
          const econRows = await pgClient`SELECT count(*)::int as count, coalesce(sum(wallet_balance + safe_balance), 0)::text as total FROM economy_accounts`
          economyAccounts = econRows[0]?.count ?? 0
          economyTotalVela = econRows[0]?.total ?? '0'
        } catch {}

        result.postgres = {
          available: true,
          latencyMs: Math.round(latencyPg * 100) / 100,
          characterCount,
          economyAccounts,
          economyTotalVela,
        }
      } catch (err: any) {
        result.postgres = {
          available: false,
          error: err.message,
        }
      }
    }

    if (redisClient) {
      try {
        const startRedis = performance.now()
        await redisClient.ping()
        const latencyRedis = performance.now() - startRedis

        let usedMemoryHuman = 'unknown'
        let keysCount = 0

        try {
          const info = await redisClient.info('memory')
          const match = info.match(/used_memory_human:([^\r\n]+)/)
          if (match) usedMemoryHuman = match[1].trim()
        } catch {}

        try {
          keysCount = await redisClient.dbsize()
        } catch {}

        result.redis = {
          available: true,
          latencyMs: Math.round(latencyRedis * 100) / 100,
          usedMemoryHuman,
          keysCount,
        }
      } catch (err: any) {
        result.redis = {
          available: false,
          error: err.message,
        }
      }
    }

    return result
  }

  public async pingAiSidecar(
    url: string = 'http://127.0.0.1:20128/v1/models',
    timeoutMs: number = 4000,
  ): Promise<{
    reachable: boolean
    statusCode?: number
    latencyMs: number
    modelCount?: number
    error?: string
  }> {
    const start = performance.now()
    return new Promise((resolve) => {
      try {
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
          let data = ''
          res.on('data', (chunk) => {
            data += chunk
          })
          res.on('end', () => {
            const latencyMs = Math.round((performance.now() - start) * 100) / 100
            let modelCount: number | undefined
            try {
              const parsed = JSON.parse(data)
              if (Array.isArray(parsed.data)) {
                modelCount = parsed.data.length
              }
            } catch {}
            resolve({
              reachable: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 400,
              statusCode: res.statusCode,
              latencyMs,
              modelCount,
            })
          })
        })
        req.on('timeout', () => {
          req.destroy()
          resolve({
            reachable: false,
            latencyMs: Math.round((performance.now() - start) * 100) / 100,
            error: 'Connection timed out',
          })
        })
        req.on('error', (err) => {
          resolve({
            reachable: false,
            latencyMs: Math.round((performance.now() - start) * 100) / 100,
            error: err.message,
          })
        })
      } catch (err: any) {
        resolve({
          reachable: false,
          latencyMs: Math.round((performance.now() - start) * 100) / 100,
          error: err.message,
        })
      }
    })
  }

  public async collectLogs(lines: number = 10): Promise<string[]> {
    const clamped = Math.max(1, Math.min(30, lines))
    return new Promise((resolve) => {
      execFile(
        'journalctl',
        ['-u', 'allybot.service', '-p', 'warning..emerg', '-n', String(clamped), '--no-pager', '-o', 'short-iso'],
        { timeout: 3000 },
        (error, stdout) => {
          if (error || !stdout) {
            resolve(['[Tidak ada log warning/error dari journalctl]'])
            return
          }
          const rawLines = stdout.trim().split('\n').filter(Boolean)
          const redacted = rawLines.map((line) => LogRedactor.redact(line))
          resolve(redacted)
        },
      )
    })
  }

  public collectMemoryAndOptionalGc(runGc: boolean = false): {
    rssMb: number
    heapUsedMb: number
    heapTotalMb: number
    externalMb: number
    arrayBuffersMb: number
    gcExecuted: boolean
    freedHeapMb?: number
  } {
    const before = process.memoryUsage()
    let freedHeapMb: number | undefined
    let gcExecuted = false

    if (runGc && typeof (global as any).gc === 'function') {
      ;(global as any).gc()
      gcExecuted = true
      const after = process.memoryUsage()
      freedHeapMb = Math.round(((before.heapUsed - after.heapUsed) / (1024 * 1024)) * 100) / 100
    }

    const current = process.memoryUsage()
    return {
      rssMb: Math.round((current.rss / (1024 * 1024)) * 100) / 100,
      heapUsedMb: Math.round((current.heapUsed / (1024 * 1024)) * 100) / 100,
      heapTotalMb: Math.round((current.heapTotal / (1024 * 1024)) * 100) / 100,
      externalMb: Math.round((current.external / (1024 * 1024)) * 100) / 100,
      arrayBuffersMb: Math.round((current.arrayBuffers / (1024 * 1024)) * 100) / 100,
      gcExecuted,
      freedHeapMb,
    }
  }

  static redact(text: string): string {
    return LogRedactor.redact(text)
  }

}


export class LogRedactor {
  static redact(text: string): string {
    return text
      .replace(/Bearer\s+[A-Za-z0-9_.-]{20,}/gi, 'Bearer [REDACTED_TOKEN]')
      .replace(/(?:sk-|key-|gsk_|ai-|hf_)[A-Za-z0-9_.-]{16,}/gi, '[REDACTED_API_KEY]')
      .replace(/(?:postgres|postgresql|redis|mongodb):\/\/[^\s"']+/gi, '[REDACTED_DB_URI]')
      .replace(/\b\d{10,15}\b/g, '[REDACTED_PHONE]')
  }
}
