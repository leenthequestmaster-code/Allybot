import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import {
  createGuardrailAuditRecord,
  FixedWindowRateLimiter,
  GuardrailPolicyRegistry,
  hashIdentifier,
  ProviderCircuitBreaker,
  SafeActionRegistry,
  type AuditRecordInput,
  type FixedWindowRateLimiterOptions,
  type GuardrailAuditRecord,
  type GuardrailDecision,
  type GuardrailPolicyDefinition,
  type GuardrailPolicyRequest,
  type ProviderCircuitBreakerOptions,
  type ProviderCircuitDecision,
  type RateLimitDecision,
  type RateLimitProfile,
  type SafeActionDefinition,
} from '../platform/guardrails.js'
import { isJid, isSafeIdentifier } from '../platform/validation.js'

export interface FeatureFlagRecord {
  readonly groupJid: string
  readonly featureId: string
  readonly enabled: boolean
  readonly version: number
  readonly updatedByHash: string
  readonly updatedAt: number
}

export interface PlatformGuardrailServiceOptions {
  readonly namespace?: string
  readonly clock?: () => number
  readonly maxHotAuditRecords?: number
  readonly rateLimiter?: FixedWindowRateLimiterOptions
}

export interface AuditListOptions {
  readonly includeArchive?: boolean
  readonly limit?: number
}

export interface GuardrailEvaluationAuditContext {
  readonly actorJid?: string
  readonly resourceJid?: string
  readonly correlationId?: string
  readonly metadata?: Record<string, unknown>
}

interface FeatureFlagRow {
  group_jid: string
  feature_id: string
  enabled: number
  version: number
  updated_by_hash: string
  updated_at: number
}

interface AuditRow {
  event_id: string
  event_type: string
  schema_version: number
  namespace: string
  occurred_at: number
  actor_hash: string | null
  resource_hash: string | null
  outcome: GuardrailAuditRecord['outcome']
  correlation_id: string | null
  metadata_json: string
}

const DEFAULT_MAX_HOT_AUDIT_RECORDS = 1_000
const DEFAULT_NAMESPACE = 'allybot'
const MAX_AUDIT_QUERY_LIMIT = 1_000

export class PlatformGuardrailService implements Service {
  readonly name = 'platform-guardrails'

  private readonly databasePath: string
  private readonly namespace: string
  private readonly clock: () => number
  private readonly maxHotAuditRecords: number
  private readonly logger: Logger
  private readonly policies = new GuardrailPolicyRegistry()
  private readonly actions = new SafeActionRegistry()
  private readonly rateLimiter: FixedWindowRateLimiter
  private readonly circuits = new Map<string, ProviderCircuitBreaker>()
  private db: Database.Database | undefined

  constructor(databasePath: string, logger: Logger, options: PlatformGuardrailServiceOptions = {}) {
    this.databasePath = databasePath
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE
    this.clock = options.clock ?? (() => Date.now())
    this.maxHotAuditRecords = options.maxHotAuditRecords ?? DEFAULT_MAX_HOT_AUDIT_RECORDS
    this.logger = logger.child({ component: 'platform-guardrails' })
    this.rateLimiter = new FixedWindowRateLimiter({ ...options.rateLimiter, clock: this.clock })
    if (!this.namespace || !isSafeIdentifier(this.namespace)) throw new Error(`Invalid guardrail namespace: ${this.namespace}`)
    if (!Number.isInteger(this.maxHotAuditRecords) || this.maxHotAuditRecords < 1) throw new Error('maxHotAuditRecords must be a positive integer')
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
    this.logger.info({ namespace: this.namespace }, 'platform guardrails initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.rateLimiter.clear()
    this.circuits.clear()
  }

  registerPolicy(policy: GuardrailPolicyDefinition): () => void {
    return this.policies.register(policy)
  }

  listPolicies(): readonly GuardrailPolicyDefinition[] {
    return this.policies.list()
  }

  evaluatePolicy(request: GuardrailPolicyRequest, audit: GuardrailEvaluationAuditContext = {}): GuardrailDecision {
    const decision = this.policies.evaluate(request)
    try {
      this.recordAudit({
        eventType: 'policy.evaluated',
        namespace: this.namespace,
        occurredAt: this.clock(),
        outcome: decision.allowed ? 'allowed' : 'denied',
        actorJid: audit.actorJid,
        resourceJid: audit.resourceJid,
        correlationId: audit.correlationId,
        metadata: { policyId: request.policyId, action: request.action, scope: request.scope, reason: decision.reason, ...audit.metadata },
      })
      return decision
    } catch (error) {
      this.logSafeError('policy audit failed closed', error)
      return { ...decision, allowed: false, reason: 'Guardrail audit unavailable' }
    }
  }

  registerAction(action: SafeActionDefinition): () => void {
    return this.actions.register(action)
  }

  getSafeAction(id: string): SafeActionDefinition | undefined {
    return this.actions.get(id)
  }

  listSafeActions(): readonly SafeActionDefinition[] {
    return this.actions.list()
  }

  registerRateProfile(profile: RateLimitProfile): () => void {
    return this.rateLimiter.registerProfile(profile)
  }

  consumeRate(profileId: string, key: string, audit: { readonly actorJid?: string; readonly resourceJid?: string; readonly correlationId?: string } = {}, now = this.clock()): RateLimitDecision {
    const decision = this.rateLimiter.consume(profileId, key, now)
    if (!decision.allowed) {
      try {
        this.recordAudit({
          eventType: 'rate.limited',
          namespace: this.namespace,
          occurredAt: now,
          outcome: 'limited',
          actorJid: audit.actorJid,
          resourceJid: audit.resourceJid,
          correlationId: audit.correlationId,
          metadata: { profileId, reason: decision.reason, count: decision.count, limit: decision.limit },
        })
      } catch (error) {
        this.logSafeError('rate limit audit failed', error)
      }
    }
    return decision
  }

  registerProviderCircuit(providerId: string, options: ProviderCircuitBreakerOptions = {}): () => void {
    validateIdentifier(providerId, 'provider id')
    if (this.circuits.has(providerId)) throw new Error(`Provider circuit already registered: ${providerId}`)
    this.circuits.set(providerId, new ProviderCircuitBreaker({ ...options, clock: this.clock }))
    return () => this.circuits.delete(providerId)
  }

  checkProvider(providerId: string, now = this.clock()): ProviderCircuitDecision {
    const circuit = this.circuits.get(providerId)
    if (!circuit) return { allowed: false, reason: 'Unknown provider circuit', state: 'open' }
    const decision = circuit.allow(now)
    if (!decision.allowed) {
      try {
        this.recordAudit({ eventType: 'provider.circuit_denied', namespace: this.namespace, occurredAt: now, outcome: 'denied', metadata: { providerId, reason: decision.reason, state: decision.state } })
      } catch (error) {
        this.logSafeError('provider circuit audit failed', error)
      }
    }
    return decision
  }

  recordProviderSuccess(providerId: string, now = this.clock()): void {
    const circuit = this.requireCircuit(providerId)
    const previous = circuit.state
    circuit.recordSuccess(now)
    if (previous !== 'closed') this.recordAudit({ eventType: 'provider.circuit_closed', namespace: this.namespace, occurredAt: now, outcome: 'closed', metadata: { providerId, previousState: previous } })
  }

  recordProviderFailure(providerId: string, now = this.clock()): void {
    const circuit = this.requireCircuit(providerId)
    const previous = circuit.state
    circuit.recordFailure(now)
    if (previous !== circuit.state && circuit.state === 'open') this.recordAudit({ eventType: 'provider.circuit_opened', namespace: this.namespace, occurredAt: now, outcome: 'opened', metadata: { providerId, previousState: previous } })
  }

  getFeatureFlag(groupJid: string, featureId: string): FeatureFlagRecord | undefined {
    this.validateGroupAndFeature(groupJid, featureId)
    const row = this.database().prepare(`
      SELECT group_jid, feature_id, enabled, version, updated_by_hash, updated_at
      FROM platform_guardrail_feature_flags
      WHERE group_jid = ? AND feature_id = ?
    `).get(groupJid, featureId) as FeatureFlagRow | undefined
    return row ? mapFeatureFlag(row) : undefined
  }

  isFeatureEnabled(groupJid: string, featureId: string): boolean {
    return this.getFeatureFlag(groupJid, featureId)?.enabled === true
  }

  setFeatureFlag(groupJid: string, featureId: string, enabled: boolean, actorJid: string, correlationId?: string, now = this.clock()): FeatureFlagRecord {
    this.validateGroupAndFeature(groupJid, featureId)
    if (typeof enabled !== 'boolean') throw new Error('Feature flag enabled must be boolean')
    if (!isJid(actorJid)) throw new Error('Feature flag actorJid must be a valid JID')
    const audit = createGuardrailAuditRecord({
      eventType: 'feature.flag.changed',
      namespace: this.namespace,
      occurredAt: now,
      actorJid,
      resourceJid: groupJid,
      outcome: 'changed',
      correlationId,
      metadata: { featureId, enabled },
    })
    return this.transaction(() => {
      const current = this.getFeatureFlag(groupJid, featureId)
      const version = current ? current.version + (current.enabled === enabled ? 0 : 1) : 1
      this.database().prepare(`
        INSERT INTO platform_guardrail_feature_flags
          (group_jid, feature_id, enabled, version, updated_by_hash, updated_at)
        VALUES (@group_jid, @feature_id, @enabled, @version, @updated_by_hash, @updated_at)
        ON CONFLICT(group_jid, feature_id) DO UPDATE SET
          enabled = excluded.enabled,
          version = excluded.version,
          updated_by_hash = excluded.updated_by_hash,
          updated_at = excluded.updated_at
      `).run({ group_jid: groupJid, feature_id: featureId, enabled: enabled ? 1 : 0, version, updated_by_hash: hashIdentifier(actorJid), updated_at: now })
      this.insertAuditInTransaction(audit)
      return this.getFeatureFlag(groupJid, featureId) as FeatureFlagRecord
    })
  }

  recordAudit(input: AuditRecordInput): GuardrailAuditRecord {
    if (input.namespace !== this.namespace) throw new Error(`Audit namespace mismatch: ${input.namespace}`)
    const record = createGuardrailAuditRecord(input)
    return this.transaction(() => {
      const existing = this.findAuditInTransaction(record.eventId)
      if (existing) return existing
      this.insertAuditInTransaction(record)
      return record
    })
  }

  listAudit(options: AuditListOptions = {}): readonly GuardrailAuditRecord[] {
    const limit = options.limit ?? 100
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_AUDIT_QUERY_LIMIT) throw new Error(`Audit query limit must be between 1 and ${MAX_AUDIT_QUERY_LIMIT}`)
    const hot = this.database().prepare(`SELECT * FROM platform_guardrail_audit_hot WHERE namespace = ? ORDER BY occurred_at DESC, event_id DESC LIMIT ?`).all(this.namespace, limit) as AuditRow[]
    if (!options.includeArchive) return hot.map(mapAuditRow)
    const archive = this.database().prepare(`SELECT * FROM platform_guardrail_audit_archive WHERE namespace = ? ORDER BY occurred_at DESC, event_id DESC LIMIT ?`).all(this.namespace, limit) as AuditRow[]
    return [...hot, ...archive].sort((left, right) => right.occurred_at - left.occurred_at || right.event_id.localeCompare(left.event_id)).slice(0, limit).map(mapAuditRow)
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS platform_guardrail_feature_flags (
        group_jid TEXT NOT NULL,
        feature_id TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        version INTEGER NOT NULL,
        updated_by_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_jid, feature_id)
      );
      CREATE INDEX IF NOT EXISTS idx_guardrail_feature_flags_feature
        ON platform_guardrail_feature_flags (feature_id, enabled);
      CREATE TABLE IF NOT EXISTS platform_guardrail_audit_hot (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        namespace TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        actor_hash TEXT,
        resource_hash TEXT,
        outcome TEXT NOT NULL,
        correlation_id TEXT,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_guardrail_audit_hot_time
        ON platform_guardrail_audit_hot (namespace, occurred_at, event_id);
      CREATE TABLE IF NOT EXISTS platform_guardrail_audit_archive (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        namespace TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        actor_hash TEXT,
        resource_hash TEXT,
        outcome TEXT NOT NULL,
        correlation_id TEXT,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_guardrail_audit_archive_time
        ON platform_guardrail_audit_archive (namespace, occurred_at, event_id);
      CREATE TABLE IF NOT EXISTS platform_guardrail_archive_meta (
        namespace TEXT PRIMARY KEY,
        archive_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    this.database().prepare(`INSERT OR IGNORE INTO platform_guardrail_archive_meta (namespace, archive_version, created_at) VALUES (?, 1, ?)`).run(this.namespace, this.clock())
  }

  private insertAuditInTransaction(record: GuardrailAuditRecord): void {
    this.database().prepare(`
      INSERT INTO platform_guardrail_audit_hot
        (event_id, event_type, schema_version, namespace, occurred_at, actor_hash, resource_hash, outcome, correlation_id, metadata_json)
      VALUES (@event_id, @event_type, @schema_version, @namespace, @occurred_at, @actor_hash, @resource_hash, @outcome, @correlation_id, @metadata_json)
    `).run({
      event_id: record.eventId,
      event_type: record.eventType,
      schema_version: record.schemaVersion,
      namespace: record.namespace,
      occurred_at: record.occurredAt,
      actor_hash: record.actorHash ?? null,
      resource_hash: record.resourceHash ?? null,
      outcome: record.outcome,
      correlation_id: record.correlationId ?? null,
      metadata_json: JSON.stringify(record.metadata),
    })
    this.archiveOverflowInTransaction()
  }

  private archiveOverflowInTransaction(): void {
    const count = (this.database().prepare(`SELECT COUNT(*) AS count FROM platform_guardrail_audit_hot WHERE namespace = ?`).get(this.namespace) as { count: number }).count
    const overflow = count - this.maxHotAuditRecords
    if (overflow <= 0) return
    const rows = this.database().prepare(`SELECT * FROM platform_guardrail_audit_hot WHERE namespace = ? ORDER BY occurred_at ASC, event_id ASC LIMIT ?`).all(this.namespace, overflow) as AuditRow[]
    const archive = this.database().prepare(`
      INSERT OR IGNORE INTO platform_guardrail_audit_archive
        (event_id, event_type, schema_version, namespace, occurred_at, actor_hash, resource_hash, outcome, correlation_id, metadata_json)
      VALUES (@event_id, @event_type, @schema_version, @namespace, @occurred_at, @actor_hash, @resource_hash, @outcome, @correlation_id, @metadata_json)
    `)
    const remove = this.database().prepare(`DELETE FROM platform_guardrail_audit_hot WHERE event_id = ? AND namespace = ?`)
    for (const row of rows) {
      archive.run(row)
      remove.run(row.event_id, this.namespace)
    }
  }

  private findAuditInTransaction(eventId: string): GuardrailAuditRecord | undefined {
    const hot = this.database().prepare(`SELECT * FROM platform_guardrail_audit_hot WHERE event_id = ? AND namespace = ?`).get(eventId, this.namespace) as AuditRow | undefined
    if (hot) return mapAuditRow(hot)
    const archive = this.database().prepare(`SELECT * FROM platform_guardrail_audit_archive WHERE event_id = ? AND namespace = ?`).get(eventId, this.namespace) as AuditRow | undefined
    return archive ? mapAuditRow(archive) : undefined
  }

  private transaction<T>(operation: () => T): T {
    return this.database().transaction(operation)()
  }

  private requireCircuit(providerId: string): ProviderCircuitBreaker {
    validateIdentifier(providerId, 'provider id')
    const circuit = this.circuits.get(providerId)
    if (!circuit) throw new Error(`Unknown provider circuit: ${providerId}`)
    return circuit
  }

  private validateGroupAndFeature(groupJid: string, featureId: string): void {
    if (!isJid(groupJid) || !groupJid.endsWith('@g.us')) throw new Error('Feature flag groupJid must be a group JID')
    validateFeatureIdentifier(featureId, 'feature id')
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('Platform guardrails service is not initialized')
    return this.db
  }

  private logSafeError(message: string, error: unknown): void {
    this.logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, message)
  }
}

function mapFeatureFlag(row: FeatureFlagRow): FeatureFlagRecord {
  return {
    groupJid: row.group_jid,
    featureId: row.feature_id,
    enabled: row.enabled === 1,
    version: row.version,
    updatedByHash: row.updated_by_hash,
    updatedAt: row.updated_at,
  }
}

function mapAuditRow(row: AuditRow): GuardrailAuditRecord {
  let metadata: Record<string, string | number | boolean | null>
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('audit metadata is not an object')
    metadata = parsed as Record<string, string | number | boolean | null>
  } catch {
    metadata = { parseError: true }
  }
  return {
    eventId: row.event_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    namespace: row.namespace,
    occurredAt: row.occurred_at,
    ...(row.actor_hash === null ? {} : { actorHash: row.actor_hash }),
    ...(row.resource_hash === null ? {} : { resourceHash: row.resource_hash }),
    outcome: row.outcome,
    ...(row.correlation_id === null ? {} : { correlationId: row.correlation_id }),
    metadata,
  }
}

function validateIdentifier(value: string, field: string): void {
  if (!isSafeIdentifier(value)) throw new Error(`Invalid ${field}: ${value}`)
}

function validateFeatureIdentifier(value: string, field: string): void {
  if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(value)) throw new Error(`Invalid ${field}: ${value}`)
}
