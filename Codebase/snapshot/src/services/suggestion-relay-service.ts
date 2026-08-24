import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Service, ServiceContext, WhatsAppGroupMetadata, WhatsAppPort } from '../framework/contracts.js'
import { runPlatformOperation } from '../platform/operations.js'
import { isJid, isSafeIdentifier } from '../platform/validation.js'
import type { KnowledgeService } from './knowledge-service.js'
import type { SceneService } from './scene-service.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'

export const SUGGESTION_FEATURE_ID = 'community.suggestion.relay'
export const SUGGESTION_PROVIDER_ID = 'xkiro-suggestion'

export interface SuggestionContextItem {
  readonly sourceRefHash: string
  readonly title: string
  readonly excerpt: string
}

export interface SuggestionProviderInput {
  readonly requestText: string
  readonly context: readonly SuggestionContextItem[]
}

export type SuggestionProvider = (input: SuggestionProviderInput) => Promise<string>

export type SuggestionStatus = 'requested' | 'completed' | 'failed' | 'expired'
export type SuggestionOutcomeCode =
  | 'ok'
  | 'feature_disabled'
  | 'policy_denied'
  | 'rate_limited'
  | 'actor_not_admin'
  | 'role_check_unavailable'
  | 'consent_required'
  | 'scene_unavailable'
  | 'knowledge_unavailable'
  | 'source_not_found'
  | 'invalid_context'
  | 'provider_unavailable'
  | 'duplicate'
  | 'in_progress'
  | 'expired'
  | 'recovery_required'

export interface SuggestionRecord {
  readonly id: string
  readonly groupJid: string
  readonly actorRefHash: string
  readonly requestHash: string
  readonly contextFingerprint: string
  readonly contextCount: number
  readonly status: SuggestionStatus
  readonly suggestion?: string
  readonly outputHash: string
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number
  readonly contentExpiresAt: number
  readonly outcomeCode: string
}

export type SuggestionResult =
  | { readonly kind: 'completed'; readonly record: SuggestionRecord; readonly duplicate?: boolean }
  | { readonly kind: 'denied'; readonly code: SuggestionOutcomeCode; readonly record?: SuggestionRecord }

export interface SuggestionRelayServiceOptions {
  readonly clock?: () => number
  readonly provider?: SuggestionProvider
  readonly providerId?: string
  readonly requestTtlMs?: number
  readonly contentRetentionMs?: number
  readonly maxRequestLength?: number
  readonly maxContextSources?: number
  readonly maxOutputLength?: number
  readonly operationTimeoutMs?: number
}

interface SuggestionRow {
  id: string
  group_jid: string
  actor_jid: string
  request_hash: string
  context_fingerprint: string
  context_count: number
  status: SuggestionStatus
  suggestion_text: string
  output_hash: string
  revision: number
  created_at: number
  updated_at: number
  expires_at: number
  content_expires_at: number
  outcome_code: string
  correlation_hash: string
}

interface AuthorizationResult {
  readonly ok: boolean
  readonly code?: SuggestionOutcomeCode
}

const POLICY_ID = 'community-suggestion.request'
const ACTION_ID = 'community-suggestion.request'
const ADMIN_POLICY_ID = 'community-suggestion.admin'
const ADMIN_ACTION_ID = 'community-suggestion.admin'
const RATE_PROFILE_ID = 'community-suggestion.core'
const DEFAULT_REQUEST_TTL_MS = 10 * 60 * 1_000
const DEFAULT_CONTENT_RETENTION_MS = 30 * 60 * 1_000
const DEFAULT_MAX_REQUEST_LENGTH = 360
const DEFAULT_MAX_CONTEXT_SOURCES = 3
const DEFAULT_MAX_OUTPUT_LENGTH = 1_200
const DEFAULT_OPERATION_TIMEOUT_MS = 15_000
const MAX_SOURCE_EXCERPT_LENGTH = 180
const MAX_SOURCE_TITLE_LENGTH = 80
const MAX_EXPIRY_BATCH = 100

export class SuggestionRelayService implements Service {
  readonly name = 'suggestion-relay'
  readonly dependencies = ['platform-guardrails', 'scene', 'knowledge'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly provider?: SuggestionProvider
  private readonly providerId: string
  private readonly requestTtlMs: number
  private readonly contentRetentionMs: number
  private readonly maxRequestLength: number
  private readonly maxContextSources: number
  private readonly maxOutputLength: number
  private readonly operationTimeoutMs: number
  private readonly logger: Logger
  private db: Database.Database | undefined
  private guardrails: PlatformGuardrailService | undefined
  private scenes: SceneService | undefined
  private knowledge: KnowledgeService | undefined
  private unregisters: Array<() => void> = []

  constructor(databasePath: string, logger: Logger, options: SuggestionRelayServiceOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.provider = options.provider
    this.providerId = options.providerId ?? SUGGESTION_PROVIDER_ID
    this.requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS
    this.contentRetentionMs = options.contentRetentionMs ?? DEFAULT_CONTENT_RETENTION_MS
    this.maxRequestLength = options.maxRequestLength ?? DEFAULT_MAX_REQUEST_LENGTH
    this.maxContextSources = options.maxContextSources ?? DEFAULT_MAX_CONTEXT_SOURCES
    this.maxOutputLength = options.maxOutputLength ?? DEFAULT_MAX_OUTPUT_LENGTH
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    this.logger = logger.child({ component: 'suggestion-relay' })
    if (!Number.isInteger(this.requestTtlMs) || this.requestTtlMs < 1) throw new Error('requestTtlMs must be positive')
    if (!Number.isInteger(this.contentRetentionMs) || this.contentRetentionMs < this.requestTtlMs) throw new Error('contentRetentionMs must be at least requestTtlMs')
    if (!Number.isInteger(this.maxRequestLength) || this.maxRequestLength < 32 || this.maxRequestLength > 1_200) throw new Error('maxRequestLength is invalid')
    if (!Number.isInteger(this.maxContextSources) || this.maxContextSources < 1 || this.maxContextSources > 10) throw new Error('maxContextSources is invalid')
    if (!Number.isInteger(this.maxOutputLength) || this.maxOutputLength < 64 || this.maxOutputLength > 2_000) throw new Error('maxOutputLength is invalid')
    if (!Number.isInteger(this.operationTimeoutMs) || this.operationTimeoutMs < 1) throw new Error('operationTimeoutMs must be positive')
    validateIdentifier(this.providerId, 'provider id')
  }

  initialize(context: ServiceContext): void {
    this.guardrails = context.services.get<PlatformGuardrailService>('platform-guardrails')
    this.scenes = context.services.get<SceneService>('scene')
    this.knowledge = context.services.get<KnowledgeService>('knowledge')
    if (this.databasePath !== ':memory:') mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
    this.expireStaleState(this.clock())
    this.unregisters = [
      this.guardrailService().registerPolicy({ id: POLICY_ID, version: 1, action: ACTION_ID, scope: 'group', description: 'R11 approved-context suggestion request', featureId: SUGGESTION_FEATURE_ID, rateProfileId: RATE_PROFILE_ID }),
      this.guardrailService().registerPolicy({ id: ADMIN_POLICY_ID, version: 1, action: ADMIN_ACTION_ID, scope: 'group', description: 'R11 suggestion relay feature administration', featureId: SUGGESTION_FEATURE_ID, rateProfileId: RATE_PROFILE_ID }),
      this.guardrailService().registerAction({ id: ACTION_ID, version: 1, description: 'Generate bounded suggestion from approved context', inputSchemaVersion: 1, risk: 'medium', featureId: SUGGESTION_FEATURE_ID }),
      this.guardrailService().registerAction({ id: ADMIN_ACTION_ID, version: 1, description: 'Enable or disable bounded suggestion relay', inputSchemaVersion: 1, risk: 'medium', requiredPermission: 'group.admin', featureId: SUGGESTION_FEATURE_ID }),
      this.guardrailService().registerRateProfile({ id: RATE_PROFILE_ID, maxRequests: 5, windowMs: 60_000 }),
      this.guardrailService().registerProviderCircuit(this.providerId, { failureThreshold: 3, cooldownMs: 30_000, halfOpenMaxCalls: 1 }),
    ]
    this.logger.info({ providerConfigured: Boolean(this.provider) }, 'suggestion relay storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    for (const unregister of this.unregisters.splice(0)) unregister()
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
    this.scenes = undefined
    this.knowledge = undefined
  }

  isFeatureEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().isFeatureEnabled(groupJid, SUGGESTION_FEATURE_ID)
  }

  async setEnabled(groupJid: string, actorJid: string, enabled: boolean, whatsapp: WhatsAppPort, now = this.clock()): Promise<{ enabled: boolean } | { code: SuggestionOutcomeCode }> {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'suggestion admin')
    if (typeof enabled !== 'boolean') throw new Error('suggestion enabled must be boolean')
    const auth = await this.authorizeAdmin(groupJid, actorJid, whatsapp, `suggestion-admin-${now}`, true)
    if (!auth.ok) return { code: auth.code ?? 'policy_denied' }
    this.guardrailService().setFeatureFlag(groupJid, SUGGESTION_FEATURE_ID, enabled, actorJid, `suggestion-feature-${now}`, now)
    this.audit('suggestion.feature.changed', actorJid, groupJid, 'changed', { enabled })
    return { enabled }
  }

  async request(input: { readonly groupJid: string; readonly actorJid: string; readonly sceneReference: string; readonly requestText: string; readonly sourceReferences: readonly string[]; readonly correlationId: string }, now = this.clock()): Promise<SuggestionResult> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'suggestion requester')
    validateIdentifier(input.sceneReference, 'scene reference')
    validateIdentifier(input.correlationId, 'suggestion correlation id')
    const requestText = normalizeRequest(input.requestText, this.maxRequestLength)
    const sourceReferences = normalizeSourceReferences(input.sourceReferences, this.maxContextSources)
    this.expireStaleState(now)
    const auth = this.authorizeRequest(input.groupJid, input.actorJid, input.correlationId)
    if (!auth.ok) return { kind: 'denied', code: auth.code ?? 'policy_denied' }
    const dependencies = this.requireDependencies()
    if (!dependencies.scenes.isEnabled(input.groupJid)) return { kind: 'denied', code: 'scene_unavailable' }
    if (!dependencies.knowledge.isEnabled(input.groupJid)) return { kind: 'denied', code: 'knowledge_unavailable' }
    try {
      if (!dependencies.scenes.hasConsent(input.groupJid, input.sceneReference, input.actorJid, 'receive_assistance', now)) {
        this.audit('suggestion.consent.denied', input.actorJid, input.groupJid, 'denied', { reasonCode: 'consent_required' }, input.correlationId)
        return { kind: 'denied', code: 'consent_required' }
      }
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'suggestion scene consent unavailable')
      this.audit('suggestion.consent.failed', input.actorJid, input.groupJid, 'failed', { reasonCode: 'scene_unavailable' }, input.correlationId)
      return { kind: 'denied', code: 'scene_unavailable' }
    }

    const context = [] as SuggestionContextItem[]
    for (const reference of sourceReferences) {
      const source = dependencies.knowledge.findSource(input.groupJid, reference, input.actorJid, now)
      if (!source || source.status !== 'active') return { kind: 'denied', code: 'source_not_found' }
      try {
        if (!dependencies.scenes.hasConsent(input.groupJid, input.sceneReference, source.creatorJid, 'share_context', now)) {
          this.audit('suggestion.source.denied', input.actorJid, input.groupJid, 'denied', { sourceRefHash: hashText(source.id), reasonCode: 'consent_required' }, input.correlationId)
          return { kind: 'denied', code: 'consent_required' }
        }
      } catch (error) {
        this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'suggestion source consent unavailable')
        return { kind: 'denied', code: 'scene_unavailable' }
      }
      context.push({ sourceRefHash: hashText(source.id).slice(0, 16), title: source.title.slice(0, MAX_SOURCE_TITLE_LENGTH), excerpt: source.excerpt.slice(0, MAX_SOURCE_EXCERPT_LENGTH) })
    }
    const contextFingerprint = fingerprintContext(context)
    const requestHash = hashText(requestText)
    const correlationHash = hashText(input.correlationId)
    const existing = this.database().prepare('SELECT * FROM suggestion_requests WHERE group_jid = ? AND correlation_hash = ?').get(input.groupJid, correlationHash) as SuggestionRow | undefined
    if (existing) {
      const record = mapSuggestion(existing, true)
      if (existing.status === 'completed') return { kind: 'completed', record, duplicate: true }
      if (existing.status === 'requested') return { kind: 'denied', code: 'in_progress', record }
      if (existing.status === 'expired') return { kind: 'denied', code: 'expired', record }
      return { kind: 'denied', code: 'duplicate', record }
    }
    const providerDecision = this.guardrailService().checkProvider(this.providerId, now)
    if (!providerDecision.allowed || !this.provider) {
      this.audit('suggestion.provider.denied', input.actorJid, input.groupJid, 'denied', { reasonCode: 'provider_unavailable', contextCount: context.length }, input.correlationId)
      return { kind: 'denied', code: 'provider_unavailable' }
    }

    const id = randomUUID()
    this.database().prepare(`INSERT INTO suggestion_requests (id, group_jid, actor_jid, request_hash, context_fingerprint, context_count, status, suggestion_text, output_hash, revision, created_at, updated_at, expires_at, content_expires_at, outcome_code, correlation_hash) VALUES (?, ?, ?, ?, ?, ?, 'requested', '', '', 1, ?, ?, ?, ?, 'requested', ?)`).run(id, input.groupJid, input.actorJid, requestHash, contextFingerprint, context.length, now, now, now + this.requestTtlMs, now + this.contentRetentionMs, correlationHash)
    const operation = await runPlatformOperation<string>({ operationId: `suggestion-${id}`, timeoutMs: this.operationTimeoutMs, retry: { maxAttempts: 1 }, execute: () => this.provider!( { requestText, context } ) })
    if (!operation.ok) {
      this.guardrailService().recordProviderFailure(this.providerId, now)
      this.failRequest(id, isTimeout(operation.error) ? 'provider_unavailable' : 'provider_unavailable', now)
      this.audit('suggestion.provider.failed', input.actorJid, input.groupJid, 'failed', { requestRefHash: hashText(id), reasonCode: 'provider_unavailable' }, input.correlationId)
      return { kind: 'denied', code: 'provider_unavailable', record: this.getRequest(id) }
    }
    const suggestion = normalizeSuggestion(operation.value, this.maxOutputLength)
    if (!suggestion) {
      this.guardrailService().recordProviderFailure(this.providerId, now)
      this.failRequest(id, 'provider_unavailable', now)
      this.audit('suggestion.provider.failed', input.actorJid, input.groupJid, 'failed', { requestRefHash: hashText(id), reasonCode: 'provider_unavailable' }, input.correlationId)
      return { kind: 'denied', code: 'provider_unavailable', record: this.getRequest(id) }
    }
    this.guardrailService().recordProviderSuccess(this.providerId, now)
    const changed = this.database().prepare("UPDATE suggestion_requests SET status = 'completed', suggestion_text = ?, output_hash = ?, revision = revision + 1, updated_at = ?, outcome_code = 'ok' WHERE id = ? AND status = 'requested' AND expires_at > ?").run(suggestion, hashText(suggestion), now, id, now)
    if (changed.changes !== 1) {
      this.failRequest(id, 'recovery_required', now)
      return { kind: 'denied', code: 'recovery_required', record: this.getRequest(id) }
    }
    this.audit('suggestion.completed', input.actorJid, input.groupJid, 'changed', { requestRefHash: hashText(id), contextCount: context.length, outputLength: suggestion.length }, input.correlationId)
    return { kind: 'completed', record: this.getRequest(id, true) as SuggestionRecord }
  }

  getRequest(id: string, includeSuggestion = false): SuggestionRecord | undefined {
    validateIdentifier(id, 'suggestion request id')
    const row = this.database().prepare('SELECT * FROM suggestion_requests WHERE id = ?').get(id) as SuggestionRow | undefined
    return row ? mapSuggestion(row, includeSuggestion) : undefined
  }

  private authorizeRequest(groupJid: string, actorJid: string, correlationId: string): AuthorizationResult {
    if (!this.isFeatureEnabled(groupJid)) {
      this.audit('suggestion.authorization.denied', actorJid, groupJid, 'denied', { reasonCode: 'feature_disabled' }, correlationId)
      return { ok: false, code: 'feature_disabled' }
    }
    const policy = this.guardrailService().evaluatePolicy({ policyId: POLICY_ID, action: ACTION_ID, scope: 'group' }, { actorJid, resourceJid: groupJid, correlationId, metadata: { actionClass: 'request' } })
    if (!policy.allowed) return { ok: false, code: 'policy_denied' }
    const rate = this.guardrailService().consumeRate(RATE_PROFILE_ID, hashText(`${groupJid}:${actorJid}`), { actorJid, resourceJid: groupJid, correlationId })
    if (!rate.allowed) return { ok: false, code: 'rate_limited' }
    return { ok: true }
  }

  private async authorizeAdmin(groupJid: string, actorJid: string, whatsapp: WhatsAppPort, correlationId: string, allowWhenFeatureDisabled = false): Promise<AuthorizationResult> {
    if (!allowWhenFeatureDisabled && !this.isFeatureEnabled(groupJid)) return { ok: false, code: 'feature_disabled' }
    const policy = this.guardrailService().evaluatePolicy({ policyId: ADMIN_POLICY_ID, action: ADMIN_ACTION_ID, scope: 'group' }, { actorJid, resourceJid: groupJid, correlationId, metadata: { actionClass: 'admin' } })
    if (!policy.allowed) return { ok: false, code: 'policy_denied' }
    const rate = this.guardrailService().consumeRate(RATE_PROFILE_ID, hashText(`${groupJid}:${actorJid}`), { actorJid, resourceJid: groupJid, correlationId })
    if (!rate.allowed) return { ok: false, code: 'rate_limited' }
    try {
      const metadata = await whatsapp.getGroupMetadata(groupJid)
      if (metadata.jid !== groupJid) return { ok: false, code: 'role_check_unavailable' }
      if (!isAdmin(metadata, actorJid)) return { ok: false, code: 'actor_not_admin' }
      return { ok: true }
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'suggestion role check unavailable')
      return { ok: false, code: 'role_check_unavailable' }
    }
  }

  private requireDependencies(): { scenes: SceneService; knowledge: KnowledgeService } {
    if (!this.scenes || !this.knowledge) throw new Error('Suggestion relay dependencies are not initialized')
    return { scenes: this.scenes, knowledge: this.knowledge }
  }

  private failRequest(id: string, code: SuggestionOutcomeCode, now: number): void {
    this.database().prepare("UPDATE suggestion_requests SET status = 'failed', revision = revision + 1, updated_at = ?, outcome_code = ? WHERE id = ? AND status = 'requested'").run(now, code, id)
  }

  private expireStaleState(now: number): void {
    const rows = this.database().prepare("SELECT * FROM suggestion_requests WHERE status = 'requested' AND expires_at <= ? ORDER BY expires_at ASC, id ASC LIMIT ?").all(now, MAX_EXPIRY_BATCH) as SuggestionRow[]
    for (const row of rows) {
      const changed = this.database().prepare("UPDATE suggestion_requests SET status = 'expired', revision = revision + 1, updated_at = ?, outcome_code = 'expired' WHERE id = ? AND status = 'requested' AND revision = ?").run(now, row.id, row.revision)
      if (changed.changes === 1) this.audit('suggestion.expired', row.actor_jid, row.group_jid, 'closed', { requestRefHash: hashText(row.id) }, `suggestion-expired-${row.id}-${row.revision + 1}`)
    }
    const completed = this.database().prepare("SELECT id FROM suggestion_requests WHERE content_expires_at <= ? AND suggestion_text <> '' ORDER BY content_expires_at ASC, id ASC LIMIT ?").all(now, MAX_EXPIRY_BATCH) as Array<{ id: string }>
    const redact = this.database().prepare("UPDATE suggestion_requests SET suggestion_text = '' WHERE id = ? AND content_expires_at <= ? AND suggestion_text <> ''")
    for (const item of completed) redact.run(item.id, now)
  }

  private audit(eventType: string, actorJid: string | undefined, groupJid: string | undefined, outcome: 'allowed' | 'denied' | 'changed' | 'failed' | 'limited' | 'opened' | 'closed', metadata: Record<string, unknown>, correlationId?: string): void {
    try {
      this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), ...(actorJid ? { actorJid } : {}), ...(groupJid ? { resourceJid: groupJid } : {}), outcome, correlationId, metadata })
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'suggestion audit unavailable')
    }
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS suggestion_requests (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        actor_jid TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        context_fingerprint TEXT NOT NULL,
        context_count INTEGER NOT NULL CHECK (context_count > 0),
        status TEXT NOT NULL CHECK (status IN ('requested', 'completed', 'failed', 'expired')),
        suggestion_text TEXT NOT NULL,
        output_hash TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        content_expires_at INTEGER NOT NULL,
        outcome_code TEXT NOT NULL,
        correlation_hash TEXT NOT NULL,
        UNIQUE(group_jid, correlation_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_suggestion_group_time ON suggestion_requests (group_jid, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_suggestion_expiry ON suggestion_requests (status, expires_at, content_expires_at);
    `)
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('SuggestionRelayService is not initialized')
    return this.db
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('Suggestion relay guardrails are not initialized')
    return this.guardrails
  }
}

function mapSuggestion(row: SuggestionRow, includeSuggestion: boolean): SuggestionRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    actorRefHash: hashText(row.actor_jid).slice(0, 16),
    requestHash: row.request_hash,
    contextFingerprint: row.context_fingerprint,
    contextCount: row.context_count,
    status: row.status,
    ...(includeSuggestion && row.suggestion_text ? { suggestion: row.suggestion_text } : {}),
    outputHash: row.output_hash,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    contentExpiresAt: row.content_expires_at,
    outcomeCode: row.outcome_code,
  }
}

function normalizeRequest(value: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error('Suggestion request must be text')
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maxLength) throw new Error('Suggestion request is empty or exceeds the limit')
  if (/(?:bearer\s+|password\s*[:=]|api[_-]?key\s*[:=]|-----begin)/i.test(normalized)) throw new Error('Suggestion request contains sensitive-looking content')
  return normalized
}

function normalizeSourceReferences(values: readonly string[], maxSources: number): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > maxSources) throw new Error(`Suggestion requires 1-${maxSources} approved sources`)
  const normalized = [...new Set(values.map((value) => value.trim()))]
  if (normalized.length !== values.length) throw new Error('Suggestion sources must be unique')
  for (const value of normalized) {
    if (!isSafeIdentifier(value) || value.length > 128) throw new Error('Invalid suggestion source reference')
  }
  return normalized
}

function normalizeSuggestion(value: string, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) return undefined
  if (/(?:-----begin|bearer\s+|api[_-]?key\s*[:=]|password\s*[:=])/i.test(normalized)) return undefined
  return normalized
}

function fingerprintContext(context: readonly SuggestionContextItem[]): string {
  return hashText(context.map((item) => `${item.sourceRefHash}:${hashText(item.title)}:${hashText(item.excerpt)}`).join('|'))
}

function validateGroupJid(value: string): void {
  validateJid(value, 'groupJid')
  if (!value.endsWith('@g.us')) throw new Error('groupJid must be a WhatsApp group')
}

function validateJid(value: string, field: string): void {
  if (value.length > 128 || !isJid(value)) throw new Error(`${field} must be a valid JID`)
}

function validateIdentifier(value: string, field: string): void {
  if (!isSafeIdentifier(value) || value.length > 128) throw new Error(`${field} must be a safe identifier`)
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isAdmin(metadata: WhatsAppGroupMetadata, actorJid: string): boolean {
  return metadata.participants.some((participant) => participant.jid === actorJid && (participant.role === 'admin' || participant.role === 'superadmin'))
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (/timeout|timed out|abort/i.test(error.name) || /timeout|timed out|abort/i.test(error.message))
}
