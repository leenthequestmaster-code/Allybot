import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Service, ServiceContext, WhatsAppGroupMetadata, WhatsAppPort } from '../framework/contracts.js'
import { isJid, isSafeIdentifier } from '../platform/validation.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'

export type OnboardingStatus = 'applied' | 'approved' | 'denied' | 'expired'
export type OnboardingReviewTarget = 'approved' | 'denied' | 'reopen'
export type OnboardingOutcomeCode =
  | 'ok'
  | 'feature_disabled'
  | 'policy_denied'
  | 'rate_limited'
  | 'actor_not_admin'
  | 'role_check_unavailable'
  | 'not_found'
  | 'duplicate'
  | 'stale_application'
  | 'invalid_state'
  | 'expired'

export interface OnboardingApplicationRecord {
  readonly id: string
  readonly groupJid: string
  readonly applicantRefHash: string
  readonly status: OnboardingStatus
  readonly applicationText?: string
  readonly revision: number
  readonly expiresAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly decidedByHash?: string
}

export type OnboardingMutationResult =
  | { readonly kind: 'completed'; readonly record: OnboardingApplicationRecord }
  | { readonly kind: 'denied'; readonly code: OnboardingOutcomeCode; readonly record?: OnboardingApplicationRecord }

interface OnboardingApplicationRow {
  id: string
  group_jid: string
  applicant_jid: string
  application_text: string
  status: OnboardingStatus
  revision: number
  expires_at: number
  created_at: number
  updated_at: number
  content_expires_at: number
  decided_by_hash: string | null
}

interface AuthorizationResult {
  readonly ok: boolean
  readonly code?: OnboardingOutcomeCode
}

export interface OnboardingServiceOptions {
  readonly clock?: () => number
  readonly applicationTtlMs?: number
  readonly maxApplicationTextLength?: number
  readonly contentRetentionMs?: number
  readonly maxListLimit?: number
}

const FEATURE_ID = 'community.onboarding.core'
const APPLY_POLICY_ID = 'community-onboarding.apply'
const REVIEW_POLICY_ID = 'community-onboarding.review'
const ADMIN_POLICY_ID = 'community-onboarding.admin'
const APPLY_ACTION_ID = 'community-onboarding.apply'
const REVIEW_ACTION_ID = 'community-onboarding.review'
const ADMIN_ACTION_ID = 'community-onboarding.admin'
const RATE_PROFILE_ID = 'community-onboarding.core'
const DEFAULT_APPLICATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_MAX_APPLICATION_TEXT_LENGTH = 500
const DEFAULT_CONTENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const DEFAULT_MAX_LIST_LIMIT = 25
const MAX_EXPIRY_BATCH = 100

export class OnboardingService implements Service {
  readonly name = 'onboarding'
  readonly dependencies = ['platform-guardrails'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly applicationTtlMs: number
  private readonly maxApplicationTextLength: number
  private readonly contentRetentionMs: number
  private readonly maxListLimit: number
  private readonly logger: Logger
  private db: Database.Database | undefined
  private guardrails: PlatformGuardrailService | undefined
  private unregisters: Array<() => void> = []

  constructor(databasePath: string, logger: Logger, options: OnboardingServiceOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.applicationTtlMs = options.applicationTtlMs ?? DEFAULT_APPLICATION_TTL_MS
    this.maxApplicationTextLength = options.maxApplicationTextLength ?? DEFAULT_MAX_APPLICATION_TEXT_LENGTH
    this.contentRetentionMs = options.contentRetentionMs ?? DEFAULT_CONTENT_RETENTION_MS
    this.maxListLimit = options.maxListLimit ?? DEFAULT_MAX_LIST_LIMIT
    this.logger = logger.child({ component: 'onboarding' })
    if (!Number.isInteger(this.applicationTtlMs) || this.applicationTtlMs < 1) throw new Error('applicationTtlMs must be a positive integer')
    if (!Number.isInteger(this.maxApplicationTextLength) || this.maxApplicationTextLength < 32) throw new Error('maxApplicationTextLength must be at least 32')
    if (!Number.isInteger(this.contentRetentionMs) || this.contentRetentionMs < 1) throw new Error('contentRetentionMs must be a positive integer')
    if (!Number.isInteger(this.maxListLimit) || this.maxListLimit < 1) throw new Error('maxListLimit must be a positive integer')
  }

  initialize(context: ServiceContext): void {
    this.guardrails = context.services.get<PlatformGuardrailService>('platform-guardrails')
    if (this.databasePath !== ':memory:') mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
    this.expireStaleState(this.clock())
    this.unregisters = [
      this.guardrails.registerPolicy({ id: APPLY_POLICY_ID, version: 1, action: APPLY_ACTION_ID, scope: 'group', description: 'R10 bounded group onboarding application', featureId: FEATURE_ID, rateProfileId: RATE_PROFILE_ID }),
      this.guardrails.registerPolicy({ id: REVIEW_POLICY_ID, version: 1, action: REVIEW_ACTION_ID, scope: 'group', description: 'R10 group-scoped onboarding review', featureId: FEATURE_ID, rateProfileId: RATE_PROFILE_ID }),
      this.guardrails.registerPolicy({ id: ADMIN_POLICY_ID, version: 1, action: ADMIN_ACTION_ID, scope: 'group', description: 'R10 onboarding feature administration', featureId: FEATURE_ID, rateProfileId: RATE_PROFILE_ID }),
      this.guardrails.registerAction({ id: APPLY_ACTION_ID, version: 1, description: 'Create bounded onboarding application', inputSchemaVersion: 1, risk: 'low', featureId: FEATURE_ID }),
      this.guardrails.registerAction({ id: REVIEW_ACTION_ID, version: 1, description: 'Review bounded onboarding application', inputSchemaVersion: 1, risk: 'medium', requiredPermission: 'group.admin', featureId: FEATURE_ID }),
      this.guardrails.registerAction({ id: ADMIN_ACTION_ID, version: 1, description: 'Enable or disable onboarding per group', inputSchemaVersion: 1, risk: 'medium', requiredPermission: 'group.admin', featureId: FEATURE_ID }),
      this.guardrails.registerRateProfile({ id: RATE_PROFILE_ID, maxRequests: 10, windowMs: 60_000 }),
    ]
    this.logger.info('onboarding storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    for (const unregister of this.unregisters.splice(0)) unregister()
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
  }

  isFeatureEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().isFeatureEnabled(groupJid, FEATURE_ID)
  }

  async setEnabled(groupJid: string, actorJid: string, enabled: boolean, whatsapp: WhatsAppPort, now = this.clock()): Promise<{ enabled: boolean } | { code: OnboardingOutcomeCode }> {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'onboarding actor')
    if (typeof enabled !== 'boolean') throw new Error('onboarding enabled must be boolean')
    const authorization = await this.authorizeAdmin(groupJid, actorJid, whatsapp, ADMIN_POLICY_ID, ADMIN_ACTION_ID, `onboarding-admin-${now}`, true)
    if (!authorization.ok) return { code: authorization.code ?? 'policy_denied' }
    this.guardrailService().setFeatureFlag(groupJid, FEATURE_ID, enabled, actorJid, `onboarding-feature-${now}`, now)
    return { enabled }
  }

  apply(input: { groupJid: string; actorJid: string; applicationText: string; correlationId: string }, now = this.clock()): OnboardingMutationResult {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'onboarding applicant')
    validateIdentifier(input.correlationId, 'onboarding correlation id')
    const applicationText = normalizeText(input.applicationText, this.maxApplicationTextLength, 'onboarding application')
    this.expireStaleState(now)
    const authorization = this.authorizeFeature(input.groupJid, input.actorJid, APPLY_POLICY_ID, APPLY_ACTION_ID, input.correlationId)
    if (!authorization.ok) return { kind: 'denied', code: authorization.code ?? 'policy_denied' }

    const rate = this.guardrailService().consumeRate(RATE_PROFILE_ID, hashText(`${input.groupJid}:${input.actorJid}`), { actorJid: input.actorJid, resourceJid: input.groupJid, correlationId: input.correlationId })
    if (!rate.allowed) {
      this.audit('onboarding.application.denied', input.actorJid, input.groupJid, 'limited', { reasonCode: 'rate_limited' }, input.correlationId)
      return { kind: 'denied', code: 'rate_limited' }
    }

    const result = this.transaction(() => {
      const existing = this.database().prepare(`SELECT * FROM onboarding_applications WHERE group_jid = ? AND applicant_jid = ? AND status = 'applied' ORDER BY updated_at DESC LIMIT 1`).get(input.groupJid, input.actorJid) as OnboardingApplicationRow | undefined
      if (existing) return { kind: 'denied' as const, code: 'duplicate' as const, record: mapApplication(existing, false) }
      const id = randomUUID()
      const expiresAt = now + this.applicationTtlMs
      try {
        this.database().prepare(`INSERT INTO onboarding_applications (id, group_jid, applicant_jid, application_text, status, revision, expires_at, created_at, updated_at, content_expires_at, decided_by_hash) VALUES (?, ?, ?, ?, 'applied', 1, ?, ?, ?, ?, NULL)`).run(id, input.groupJid, input.actorJid, applicationText, expiresAt, now, now, now + this.contentRetentionMs)
      } catch (error) {
        if (isConstraintError(error)) return { kind: 'denied' as const, code: 'duplicate' as const }
        throw error
      }
      this.database().prepare('INSERT INTO onboarding_history (application_id, group_jid, action, revision, actor_hash, at) VALUES (?, ?, ?, ?, ?, ?)').run(id, input.groupJid, 'applied', 1, hashText(input.actorJid), now)
      const record = this.getApplication(input.groupJid, id, true)
      if (!record) throw new Error('onboarding application disappeared after insert')
      return { kind: 'completed' as const, record }
    })
    if (result.kind === 'completed') this.audit('onboarding.application.opened', input.actorJid, input.groupJid, 'opened', { applicationRefHash: hashText(result.record.id), revision: result.record.revision, expiresAt: result.record.expiresAt }, input.correlationId)
    return result
  }

  getOwnApplication(groupJid: string, actorJid: string, now = this.clock()): OnboardingApplicationRecord | undefined {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'onboarding applicant')
    this.expireStaleState(now)
    if (!this.isFeatureEnabled(groupJid)) return undefined
    const row = this.database().prepare('SELECT * FROM onboarding_applications WHERE group_jid = ? AND applicant_jid = ? ORDER BY updated_at DESC, id DESC LIMIT 1').get(groupJid, actorJid) as OnboardingApplicationRow | undefined
    return row ? mapApplication(row, false) : undefined
  }

  async listForReview(input: { groupJid: string; actorJid: string; status?: OnboardingStatus; limit?: number; correlationId: string }, whatsapp: WhatsAppPort, now = this.clock()): Promise<{ kind: 'completed'; records: readonly OnboardingApplicationRecord[] } | { kind: 'denied'; code: OnboardingOutcomeCode }> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'onboarding reviewer')
    validateIdentifier(input.correlationId, 'onboarding correlation id')
    const limit = input.limit ?? this.maxListLimit
    validateLimit(limit, this.maxListLimit)
    if (input.status && !isOnboardingStatus(input.status)) throw new Error('Invalid onboarding status')
    this.expireStaleState(now)
    const authorization = await this.authorizeAdmin(input.groupJid, input.actorJid, whatsapp, REVIEW_POLICY_ID, REVIEW_ACTION_ID, input.correlationId)
    if (!authorization.ok) return { kind: 'denied', code: authorization.code ?? 'policy_denied' }
    const rows = this.database().prepare(`SELECT * FROM onboarding_applications WHERE group_jid = ? AND (? IS NULL OR status = ?) ORDER BY updated_at DESC, id DESC LIMIT ?`).all(input.groupJid, input.status ?? null, input.status ?? null, limit) as OnboardingApplicationRow[]
    return { kind: 'completed', records: rows.map((row) => mapApplication(row, true)) }
  }

  async review(input: { groupJid: string; actorJid: string; applicationId: string; target: OnboardingReviewTarget; expectedRevision?: number; correlationId: string }, whatsapp: WhatsAppPort, now = this.clock()): Promise<OnboardingMutationResult> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'onboarding reviewer')
    validateIdentifier(input.applicationId, 'onboarding application id')
    validateIdentifier(input.correlationId, 'onboarding correlation id')
    if (!['approved', 'denied', 'reopen'].includes(input.target)) throw new Error('Invalid onboarding review target')
    this.expireStaleState(now)
    const authorization = await this.authorizeAdmin(input.groupJid, input.actorJid, whatsapp, REVIEW_POLICY_ID, REVIEW_ACTION_ID, input.correlationId)
    if (!authorization.ok) return { kind: 'denied', code: authorization.code ?? 'policy_denied' }

    const result = this.transaction(() => {
      const current = this.database().prepare('SELECT * FROM onboarding_applications WHERE id = ? AND group_jid = ?').get(input.applicationId, input.groupJid) as OnboardingApplicationRow | undefined
      if (!current) return { kind: 'denied' as const, code: 'not_found' as const }
      if (current.status === 'expired' || (current.expires_at <= now && current.status === 'applied')) return { kind: 'denied' as const, code: 'expired' as const, record: mapApplication({ ...current, status: 'expired' }, false) }
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) return { kind: 'denied' as const, code: 'stale_application' as const, record: mapApplication(current, false) }
      const nextStatus: OnboardingStatus = input.target === 'reopen' ? 'applied' : input.target
      const allowed = input.target === 'reopen' ? current.status === 'denied' : current.status === 'applied'
      if (!allowed) return { kind: 'denied' as const, code: 'invalid_state' as const, record: mapApplication(current, false) }
      const nextExpiry = nextStatus === 'applied' ? now + this.applicationTtlMs : current.expires_at
      const nextContentExpiry = input.target === 'reopen' ? now + this.contentRetentionMs : current.content_expires_at
      const updated = this.database().prepare(`UPDATE onboarding_applications SET status = ?, revision = revision + 1, expires_at = ?, updated_at = ?, content_expires_at = ?, decided_by_hash = ? WHERE id = ? AND group_jid = ? AND status = ? AND revision = ?`).run(nextStatus, nextExpiry, now, nextContentExpiry, hashText(input.actorJid), input.applicationId, input.groupJid, current.status, current.revision)
      if (updated.changes !== 1) return { kind: 'denied' as const, code: 'stale_application' as const, record: this.getApplication(input.groupJid, input.applicationId, false) }
      const action = input.target === 'reopen' ? 'reopened' : input.target
      this.database().prepare('INSERT INTO onboarding_history (application_id, group_jid, action, revision, actor_hash, at) VALUES (?, ?, ?, ?, ?, ?)').run(input.applicationId, input.groupJid, action, current.revision + 1, hashText(input.actorJid), now)
      const record = this.getApplication(input.groupJid, input.applicationId, false)
      if (!record) throw new Error('onboarding application disappeared after review')
      return { kind: 'completed' as const, record, action }
    })
    if (result.kind === 'completed') this.audit(`onboarding.application.${result.action}`, input.actorJid, input.groupJid, result.action === 'denied' ? 'closed' : 'changed', { applicationRefHash: hashText(input.applicationId), revision: result.record.revision, status: result.record.status }, input.correlationId)
    return result
  }

  private authorizeFeature(groupJid: string, actorJid: string, policyId: string, actionId: string, correlationId: string): AuthorizationResult {
    if (!this.isFeatureEnabled(groupJid)) {
      this.audit('onboarding.authorization.denied', actorJid, groupJid, 'denied', { actionId, reasonCode: 'feature_disabled' }, correlationId)
      return { ok: false, code: 'feature_disabled' }
    }
    const policy = this.guardrailService().evaluatePolicy({ policyId, action: actionId, scope: 'group' }, { actorJid, resourceJid: groupJid, correlationId, metadata: { actionId } })
    if (!policy.allowed) {
      this.audit('onboarding.authorization.denied', actorJid, groupJid, 'denied', { actionId, reasonCode: 'policy_denied' }, correlationId)
      return { ok: false, code: 'policy_denied' }
    }
    return { ok: true }
  }

  private async authorizeAdmin(groupJid: string, actorJid: string, whatsapp: WhatsAppPort, policyId: string, actionId: string, correlationId: string, allowWhenFeatureDisabled = false): Promise<AuthorizationResult> {
    if (!allowWhenFeatureDisabled && !this.isFeatureEnabled(groupJid)) {
      this.audit('onboarding.authorization.denied', actorJid, groupJid, 'denied', { actionId, reasonCode: 'feature_disabled' }, correlationId)
      return { ok: false, code: 'feature_disabled' }
    }
    const policy = this.guardrailService().evaluatePolicy({ policyId, action: actionId, scope: 'group' }, { actorJid, resourceJid: groupJid, correlationId, metadata: { actionId } })
    if (!policy.allowed) {
      this.audit('onboarding.authorization.denied', actorJid, groupJid, 'denied', { actionId, reasonCode: 'policy_denied' }, correlationId)
      return { ok: false, code: 'policy_denied' }
    }
    const rate = this.guardrailService().consumeRate(RATE_PROFILE_ID, hashText(`${groupJid}:${actorJid}`), { actorJid, resourceJid: groupJid, correlationId })
    if (!rate.allowed) {
      this.audit('onboarding.authorization.denied', actorJid, groupJid, 'limited', { actionId, reasonCode: 'rate_limited' }, correlationId)
      return { ok: false, code: 'rate_limited' }
    }
    let metadata: WhatsAppGroupMetadata
    try {
      metadata = await whatsapp.getGroupMetadata(groupJid)
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'onboarding role check unavailable')
      this.audit('onboarding.authorization.failed', actorJid, groupJid, 'failed', { actionId, reasonCode: 'role_check_unavailable' }, correlationId)
      return { ok: false, code: 'role_check_unavailable' }
    }
    if (metadata.jid !== groupJid) {
      this.audit('onboarding.authorization.failed', actorJid, groupJid, 'failed', { actionId, reasonCode: 'role_check_unavailable' }, correlationId)
      return { ok: false, code: 'role_check_unavailable' }
    }
    if (!isAdmin(metadata, actorJid)) {
      this.audit('onboarding.authorization.denied', actorJid, groupJid, 'denied', { actionId, reasonCode: 'actor_not_admin' }, correlationId)
      return { ok: false, code: 'actor_not_admin' }
    }
    return { ok: true }
  }

  private expireStaleState(now: number): void {
    const rows = this.database().prepare(`SELECT * FROM onboarding_applications WHERE status = 'applied' AND expires_at <= ? ORDER BY expires_at ASC, id ASC LIMIT ?`).all(now, MAX_EXPIRY_BATCH) as OnboardingApplicationRow[]
    const expired: Array<{ readonly id: string; readonly groupJid: string; readonly revision: number }> = []
    const redacted: Array<{ readonly id: string; readonly groupJid: string; readonly revision: number }> = []
    this.transaction(() => {
      for (const row of rows) {
        const result = this.database().prepare(`UPDATE onboarding_applications SET status = 'expired', revision = revision + 1, updated_at = ? WHERE id = ? AND group_jid = ? AND status = 'applied' AND revision = ?`).run(now, row.id, row.group_jid, row.revision)
        if (result.changes !== 1) continue
        this.database().prepare('INSERT INTO onboarding_history (application_id, group_jid, action, revision, actor_hash, at) VALUES (?, ?, ?, ?, ?, ?)').run(row.id, row.group_jid, 'expired', row.revision + 1, hashText('system'), now)
        expired.push({ id: row.id, groupJid: row.group_jid, revision: row.revision + 1 })
      }
      const retentionRows = this.database().prepare(`SELECT id, group_jid, revision FROM onboarding_applications WHERE content_expires_at <= ? AND application_text <> '' ORDER BY content_expires_at ASC, id ASC LIMIT ?`).all(now, MAX_EXPIRY_BATCH) as Array<{ id: string; group_jid: string; revision: number }>
      const redact = this.database().prepare(`UPDATE onboarding_applications SET application_text = '' WHERE id = ? AND content_expires_at <= ? AND application_text <> ''`)
      for (const row of retentionRows) {
        if (redact.run(row.id, now).changes !== 1) continue
        this.database().prepare('INSERT INTO onboarding_history (application_id, group_jid, action, revision, actor_hash, at) VALUES (?, ?, ?, ?, ?, ?)').run(row.id, row.group_jid, 'content_redacted', row.revision, hashText('system'), now)
        redacted.push({ id: row.id, groupJid: row.group_jid, revision: row.revision })
      }
    })
    for (const item of expired) this.audit('onboarding.application.expired', 'system@allybot.invalid', item.groupJid, 'closed', { applicationRefHash: hashText(item.id), revision: item.revision }, `onboarding-expire-${item.id}-${item.revision}`)
    for (const item of redacted) this.audit('onboarding.application.content_redacted', 'system@allybot.invalid', item.groupJid, 'changed', { applicationRefHash: hashText(item.id), revision: item.revision }, `onboarding-redact-${item.id}-${item.revision}`)
  }

  private getApplication(groupJid: string, applicationId: string, includeText: boolean): OnboardingApplicationRecord | undefined {
    const row = this.database().prepare('SELECT * FROM onboarding_applications WHERE id = ? AND group_jid = ?').get(applicationId, groupJid) as OnboardingApplicationRow | undefined
    return row ? mapApplication(row, includeText) : undefined
  }

  private audit(eventType: string, actorJid: string, resourceJid: string, outcome: 'allowed' | 'denied' | 'changed' | 'failed' | 'limited' | 'opened' | 'closed', metadata: Record<string, string | number | boolean>, correlationId?: string): void {
    try {
      this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), actorJid, resourceJid, outcome, correlationId, metadata })
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'onboarding audit unavailable')
    }
  }

  private transaction<T>(operation: () => T): T {
    return this.database().transaction(operation)()
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS onboarding_applications (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        applicant_jid TEXT NOT NULL,
        application_text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('applied', 'approved', 'denied', 'expired')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        content_expires_at INTEGER NOT NULL,
        decided_by_hash TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_active_applicant
        ON onboarding_applications (group_jid, applicant_jid)
        WHERE status = 'applied';
      CREATE INDEX IF NOT EXISTS idx_onboarding_group_time
        ON onboarding_applications (group_jid, updated_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS onboarding_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        application_id TEXT NOT NULL,
        group_jid TEXT NOT NULL,
        action TEXT NOT NULL,
        revision INTEGER NOT NULL,
        actor_hash TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_onboarding_history_lookup
        ON onboarding_history (group_jid, application_id, revision DESC);
    `)
    const columns = this.database().prepare('PRAGMA table_info(onboarding_applications)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'content_expires_at')) {
      this.database().exec('ALTER TABLE onboarding_applications ADD COLUMN content_expires_at INTEGER NOT NULL DEFAULT 0')
      this.database().prepare('UPDATE onboarding_applications SET content_expires_at = updated_at + ? WHERE content_expires_at = 0').run(this.contentRetentionMs)
    }
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('Onboarding service is not initialized')
    return this.db
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('Onboarding guardrails are not initialized')
    return this.guardrails
  }
}

function mapApplication(row: OnboardingApplicationRow, includeText: boolean): OnboardingApplicationRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    applicantRefHash: hashText(row.applicant_jid),
    status: row.status,
    ...(includeText && row.application_text ? { applicationText: row.application_text } : {}),
    revision: row.revision,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.decided_by_hash ? { decidedByHash: row.decided_by_hash } : {}),
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message)
}

function isAdmin(metadata: WhatsAppGroupMetadata, jid: string): boolean {
  return metadata.participants.some((participant) => participant.jid === jid && (participant.role === 'admin' || participant.role === 'superadmin'))
}

function isOnboardingStatus(value: string): value is OnboardingStatus {
  return ['applied', 'approved', 'denied', 'expired'].includes(value)
}

function validateGroupJid(value: string): void {
  validateJid(value, 'group jid')
  if (!value.endsWith('@g.us')) throw new Error('group jid must be a WhatsApp group')
}

function validateJid(value: string, label: string): void {
  if (!isJid(value)) throw new Error(`${label} must be a valid JID`)
}

function validateIdentifier(value: string, label: string): void {
  if (!isSafeIdentifier(value)) throw new Error(`${label} must be a safe identifier`)
}

function normalizeText(value: string, maxLength: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) throw new Error(`${label} is empty or exceeds the limit`)
  return normalized
}

function validateLimit(value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`limit must be between 1 and ${max}`)
}
