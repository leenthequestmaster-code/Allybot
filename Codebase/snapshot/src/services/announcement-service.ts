import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Service, ServiceContext, WhatsAppGroupMetadata, WhatsAppPort } from '../framework/contracts.js'
import { runPlatformOperation } from '../platform/operations.js'
import { isJid, isSafeIdentifier } from '../platform/validation.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'
import type { PersonalizationService } from './personalization-service.js'

export const ANNOUNCEMENT_FEATURE_ID = 'community.announcement.window'

export type AnnouncementStatus = 'planned' | 'queued' | 'sent' | 'partial' | 'failed' | 'cancelled' | 'expired' | 'limited'
export type AnnouncementTargetStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled'
export type AnnouncementOutcomeCode =
  | 'ok'
  | 'feature_disabled'
  | 'policy_denied'
  | 'rate_limited'
  | 'actor_not_admin'
  | 'role_check_unavailable'
  | 'not_found'
  | 'stale_operation'
  | 'invalid_state'
  | 'expired'
  | 'duplicate'
  | 'invalid_target_set'
  | 'quiet_hours'
  | 'policy_disabled'
  | 'transport_failed'
  | 'transport_timeout'
  | 'recovery_required'

export interface AnnouncementRecord {
  readonly id: string
  readonly groupJid: string
  readonly operatorRefHash: string
  readonly body?: string
  readonly bodyHash: string
  readonly targetCount: number
  readonly targetFingerprint: string
  readonly status: AnnouncementStatus
  readonly revision: number
  readonly expiresAt: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly contentExpiresAt: number
  readonly outcomeCode: string
}

export type AnnouncementMutationResult =
  | { readonly kind: 'completed'; readonly record: AnnouncementRecord }
  | { readonly kind: 'denied'; readonly code: AnnouncementOutcomeCode; readonly record?: AnnouncementRecord }

export interface AnnouncementServiceOptions {
  readonly clock?: () => number
  readonly previewTtlMs?: number
  readonly contentRetentionMs?: number
  readonly maxBodyLength?: number
  readonly maxTargets?: number
  readonly maxListLimit?: number
  readonly dispatcherIntervalMs?: number
  readonly operationTimeoutMs?: number
}

interface AnnouncementRow {
  id: string
  group_jid: string
  operator_jid: string
  body: string
  body_hash: string
  target_count: number
  target_fingerprint: string
  status: AnnouncementStatus
  revision: number
  expires_at: number
  created_at: number
  updated_at: number
  content_expires_at: number
  outcome_code: string
}

interface TargetRow {
  announcement_id: string
  target_jid: string
  target_hash: string
  status: AnnouncementTargetStatus
  updated_at: number
  sent_at: number | null
  failure_code: string | null
}

interface AuthorizationResult {
  readonly ok: boolean
  readonly code?: AnnouncementOutcomeCode
}

const POLICY_ID = 'community-announcement.operator'
const ACTION_ID = 'community-announcement.operator'
const RATE_PROFILE_ID = 'community-announcement.core'
const DEFAULT_PREVIEW_TTL_MS = 30 * 60 * 1_000
const DEFAULT_CONTENT_RETENTION_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_BODY_LENGTH = 600
const DEFAULT_MAX_TARGETS = 25
const DEFAULT_MAX_LIST_LIMIT = 25
const DEFAULT_DISPATCHER_INTERVAL_MS = 15_000
const DEFAULT_OPERATION_TIMEOUT_MS = 20_000
const MAX_EXPIRY_BATCH = 100
const MAX_DISPATCH_BATCH = 10

export class AnnouncementService implements Service {
  readonly name = 'announcement'
  readonly dependencies = ['platform-guardrails'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly previewTtlMs: number
  private readonly contentRetentionMs: number
  private readonly maxBodyLength: number
  private readonly maxTargets: number
  private readonly maxListLimit: number
  private readonly dispatcherIntervalMs: number
  private readonly operationTimeoutMs: number
  private readonly logger: Logger
  private db: Database.Database | undefined
  private guardrails: PlatformGuardrailService | undefined
  private personalization: PersonalizationService | undefined
  private unregisters: Array<() => void> = []
  private dispatcher: NodeJS.Timeout | undefined
  private dispatchPromise: Promise<number> | undefined
  private readonly policyAuditKeys = new Set<string>()

  constructor(databasePath: string, logger: Logger, options: AnnouncementServiceOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS
    this.contentRetentionMs = options.contentRetentionMs ?? DEFAULT_CONTENT_RETENTION_MS
    this.maxBodyLength = options.maxBodyLength ?? DEFAULT_MAX_BODY_LENGTH
    this.maxTargets = options.maxTargets ?? DEFAULT_MAX_TARGETS
    this.maxListLimit = options.maxListLimit ?? DEFAULT_MAX_LIST_LIMIT
    this.dispatcherIntervalMs = options.dispatcherIntervalMs ?? DEFAULT_DISPATCHER_INTERVAL_MS
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    this.logger = logger.child({ component: 'announcement' })
    if (!Number.isInteger(this.previewTtlMs) || this.previewTtlMs < 1) throw new Error('previewTtlMs must be a positive integer')
    if (!Number.isInteger(this.contentRetentionMs) || this.contentRetentionMs < this.previewTtlMs) throw new Error('contentRetentionMs must be at least previewTtlMs')
    if (!Number.isInteger(this.maxBodyLength) || this.maxBodyLength < 32 || this.maxBodyLength > 2_000) throw new Error('maxBodyLength must be between 32 and 2000')
    if (!Number.isInteger(this.maxTargets) || this.maxTargets < 1 || this.maxTargets > 100) throw new Error('maxTargets must be between 1 and 100')
    if (!Number.isInteger(this.maxListLimit) || this.maxListLimit < 1) throw new Error('maxListLimit must be positive')
    if (!Number.isInteger(this.dispatcherIntervalMs) || this.dispatcherIntervalMs < 1_000) throw new Error('dispatcherIntervalMs must be at least 1000')
    if (!Number.isInteger(this.operationTimeoutMs) || this.operationTimeoutMs < 1) throw new Error('operationTimeoutMs must be positive')
  }

  initialize(context: ServiceContext): void {
    this.guardrails = context.services.get<PlatformGuardrailService>('platform-guardrails')
    this.personalization = context.services.has('personalization') ? context.services.get<PersonalizationService>('personalization') : undefined
    if (this.databasePath !== ':memory:') mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
    this.expireStaleState(this.clock())
    this.unregisters = [
      this.guardrailService().registerPolicy({ id: POLICY_ID, version: 1, action: ACTION_ID, scope: 'group', description: 'R11 bounded explicit-target announcement operator', featureId: ANNOUNCEMENT_FEATURE_ID, rateProfileId: RATE_PROFILE_ID }),
      this.guardrailService().registerAction({ id: ACTION_ID, version: 1, description: 'Prepare, approve, cancel, or configure bounded announcement', inputSchemaVersion: 1, risk: 'medium', requiredPermission: 'group.admin', featureId: ANNOUNCEMENT_FEATURE_ID }),
      this.guardrailService().registerRateProfile({ id: RATE_PROFILE_ID, maxRequests: 10, windowMs: 60_000 }),
    ]
    this.logger.info('announcement storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    this.stopDispatcher()
    for (const unregister of this.unregisters.splice(0)) unregister()
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
    this.personalization = undefined
    this.policyAuditKeys.clear()
  }

  isFeatureEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().isFeatureEnabled(groupJid, ANNOUNCEMENT_FEATURE_ID)
  }

  async setEnabled(groupJid: string, actorJid: string, enabled: boolean, whatsapp: WhatsAppPort, now = this.clock()): Promise<{ enabled: boolean } | { code: AnnouncementOutcomeCode }> {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'announcement actor')
    if (typeof enabled !== 'boolean') throw new Error('announcement enabled must be boolean')
    const auth = await this.authorizeAdmin(groupJid, actorJid, whatsapp, `announcement-admin-${now}`, true)
    if (!auth.ok) return { code: auth.code ?? 'policy_denied' }
    this.guardrailService().setFeatureFlag(groupJid, ANNOUNCEMENT_FEATURE_ID, enabled, actorJid, `announcement-feature-${now}`, now)
    if (!enabled) {
      this.database().prepare("UPDATE announcement_operations SET status = 'cancelled', revision = revision + 1, updated_at = ?, outcome_code = 'feature_disabled' WHERE group_jid = ? AND status IN ('planned', 'queued')").run(now, groupJid)
      this.database().prepare("UPDATE announcement_targets SET status = 'cancelled', updated_at = ? WHERE announcement_id IN (SELECT id FROM announcement_operations WHERE group_jid = ?) AND status = 'pending'").run(now, groupJid)
    }
    this.audit('announcement.feature.changed', actorJid, groupJid, 'changed', { enabled })
    return { enabled }
  }

  async preview(input: { readonly groupJid: string; readonly actorJid: string; readonly body: string; readonly targetJids: readonly string[]; readonly correlationId: string }, whatsapp: WhatsAppPort, now = this.clock()): Promise<AnnouncementMutationResult> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'announcement operator')
    validateIdentifier(input.correlationId, 'announcement correlation id')
    const body = normalizeBody(input.body, this.maxBodyLength)
    const targets = normalizeTargets(input.targetJids, this.maxTargets)
    const auth = await this.authorizeAdmin(input.groupJid, input.actorJid, whatsapp, input.correlationId)
    if (!auth.ok) return { kind: 'denied', code: auth.code ?? 'policy_denied' }
    this.expireStaleState(now)
    const groupHash = hashText(input.groupJid)
    const correlationHash = hashText(input.correlationId)
    const targetFingerprint = fingerprintTargets(targets)
    const bodyHash = hashText(body)
    const result = this.transaction(() => {
      const existing = this.database().prepare('SELECT * FROM announcement_operations WHERE group_jid = ? AND correlation_hash = ?').get(input.groupJid, correlationHash) as AnnouncementRow | undefined
      if (existing) return { kind: 'denied' as const, code: 'duplicate' as const, record: mapAnnouncement(existing, true) }
      const id = randomUUID()
      this.database().prepare(`INSERT INTO announcement_operations (id, group_jid, operator_jid, body, body_hash, target_count, target_fingerprint, status, revision, expires_at, created_at, updated_at, content_expires_at, outcome_code, group_hash, correlation_hash) VALUES (?, ?, ?, ?, ?, ?, ?, 'planned', 1, ?, ?, ?, ?, 'planned', ?, ?)`).run(id, input.groupJid, input.actorJid, body, bodyHash, targets.length, targetFingerprint, now + this.previewTtlMs, now, now, now + this.contentRetentionMs, groupHash, correlationHash)
      const insertTarget = this.database().prepare('INSERT INTO announcement_targets (announcement_id, target_jid, target_hash, status, updated_at, sent_at, failure_code) VALUES (?, ?, ?, \'pending\', ?, NULL, NULL)')
      for (const target of targets) insertTarget.run(id, target, hashText(target), now)
      const record = this.getAnnouncement(id, true)
      if (!record) throw new Error('announcement preview disappeared after insert')
      return { kind: 'completed' as const, record }
    })
    if (result.kind === 'completed') this.audit('announcement.preview.created', input.actorJid, input.groupJid, 'opened', { operationRefHash: hashText(result.record.id), audienceCount: result.record.targetCount, bodyLength: body.length, previewFingerprint: targetFingerprint, expiresAt: result.record.expiresAt }, input.correlationId)
    return result
  }

  async approve(input: { readonly groupJid: string; readonly actorJid: string; readonly announcementId: string; readonly expectedRevision: number; readonly correlationId: string }, whatsapp: WhatsAppPort, now = this.clock()): Promise<AnnouncementMutationResult> {
    return this.transitionApproved(input, whatsapp, now)
  }

  async cancel(input: { readonly groupJid: string; readonly actorJid: string; readonly announcementId: string; readonly expectedRevision: number; readonly correlationId: string }, whatsapp: WhatsAppPort, now = this.clock()): Promise<AnnouncementMutationResult> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'announcement canceller')
    validateIdentifier(input.announcementId, 'announcement id')
    validateIdentifier(input.correlationId, 'announcement correlation id')
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('announcement expectedRevision must be positive')
    const auth = await this.authorizeAdmin(input.groupJid, input.actorJid, whatsapp, input.correlationId)
    if (!auth.ok) return { kind: 'denied', code: auth.code ?? 'policy_denied' }
    const current = this.findAnnouncement(input.groupJid, input.announcementId)
    if (!current) return { kind: 'denied', code: 'not_found' }
    if (current.expires_at <= now && ['planned', 'queued'].includes(current.status)) {
      this.expireStaleState(now)
      const expired = this.findAnnouncement(input.groupJid, input.announcementId)
      return { kind: 'denied', code: 'expired', ...(expired ? { record: mapAnnouncement(expired, false) } : {}) }
    }
    if (current.revision !== input.expectedRevision) return { kind: 'denied', code: 'stale_operation', record: mapAnnouncement(current, false) }
    if (!['planned', 'queued'].includes(current.status)) return { kind: 'denied', code: 'invalid_state', record: mapAnnouncement(current, false) }
    const changed = this.transaction(() => {
      const result = this.database().prepare("UPDATE announcement_operations SET status = 'cancelled', revision = revision + 1, updated_at = ?, outcome_code = 'cancelled' WHERE id = ? AND group_jid = ? AND status IN ('planned', 'queued') AND revision = ?").run(now, current.id, input.groupJid, current.revision)
      if (result.changes !== 1) return false
      this.database().prepare("UPDATE announcement_targets SET status = 'cancelled', updated_at = ? WHERE announcement_id = ? AND status = 'pending'").run(now, current.id)
      return true
    })
    if (!changed) {
      const latest = this.findAnnouncement(input.groupJid, current.id)
      return { kind: 'denied', code: 'stale_operation', ...(latest ? { record: mapAnnouncement(latest, false) } : {}) }
    }
    this.audit('announcement.cancelled', input.actorJid, input.groupJid, 'closed', { operationRefHash: hashText(current.id), revision: current.revision + 1 }, input.correlationId)
    const cancelled = this.getAnnouncement(current.id, false)
    if (!cancelled) throw new Error('announcement disappeared after cancellation')
    return { kind: 'completed', record: cancelled }
  }

  async getForReview(groupJid: string, actorJid: string, announcementId: string, whatsapp: WhatsAppPort, now = this.clock()): Promise<AnnouncementMutationResult> {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'announcement reviewer')
    validateIdentifier(announcementId, 'announcement id')
    const auth = await this.authorizeAdmin(groupJid, actorJid, whatsapp, `announcement-status-${announcementId}-${now}`)
    if (!auth.ok) return { kind: 'denied', code: auth.code ?? 'policy_denied' }
    const record = this.findAnnouncement(groupJid, announcementId)
    return record ? { kind: 'completed', record: mapAnnouncement(record, true) } : { kind: 'denied', code: 'not_found' }
  }

  async listForReview(groupJid: string, actorJid: string, whatsapp: WhatsAppPort, limit = this.maxListLimit, now = this.clock()): Promise<{ kind: 'completed'; records: readonly AnnouncementRecord[] } | { kind: 'denied'; code: AnnouncementOutcomeCode }> {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'announcement reviewer')
    validateLimit(limit, this.maxListLimit)
    const auth = await this.authorizeAdmin(groupJid, actorJid, whatsapp, `announcement-list-${now}`)
    if (!auth.ok) return { kind: 'denied', code: auth.code ?? 'policy_denied' }
    this.expireStaleState(now)
    const rows = this.database().prepare('SELECT * FROM announcement_operations WHERE group_jid = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(groupJid, limit) as AnnouncementRow[]
    return { kind: 'completed', records: rows.map((row) => mapAnnouncement(row, false)) }
  }

  startDispatcher(whatsapp: WhatsAppPort, intervalMs = this.dispatcherIntervalMs): void {
    if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new Error('announcement dispatcher interval must be at least 1000ms')
    this.stopDispatcher()
    const run = (label: string): void => {
      if (this.dispatchPromise || !whatsapp.isConnected) return
      const promise = this.dispatchDueAnnouncements(whatsapp)
      this.dispatchPromise = promise
      void promise.catch((error: unknown) => this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, `announcement ${label} failed`)).finally(() => {
        if (this.dispatchPromise === promise) this.dispatchPromise = undefined
      })
    }
    this.dispatcher = setInterval(() => run('dispatcher tick'), intervalMs)
    this.dispatcher.unref?.()
    run('startup recovery')
  }

  stopDispatcher(): void {
    if (this.dispatcher) clearInterval(this.dispatcher)
    this.dispatcher = undefined
  }

  async dispatchDueAnnouncements(whatsapp: WhatsAppPort, now = this.clock()): Promise<number> {
    if (this.dispatchPromise) return 0
    this.expireStaleState(now)
    if (!whatsapp.isConnected) return 0
    const rows = this.database().prepare("SELECT * FROM announcement_operations WHERE status = 'queued' AND expires_at > ? ORDER BY created_at ASC, id ASC LIMIT ?").all(now, MAX_DISPATCH_BATCH) as AnnouncementRow[]
    let changed = 0
    for (const row of rows) {
      if (!this.isFeatureEnabled(row.group_jid)) continue
      const policy = this.personalization?.evaluateGroupNotification(row.group_jid, now)
      if (policy && !policy.allowed) {
        this.handlePolicyDeferral(row, policy.reason, now)
        continue
      }
      if (!row.body) {
        this.failAnnouncement(row, 'recovery_required', now)
        continue
      }
      const targets = this.database().prepare("SELECT * FROM announcement_targets WHERE announcement_id = ? AND status = 'pending' ORDER BY target_hash ASC LIMIT ?").all(row.id, this.maxTargets) as TargetRow[]
      for (const target of targets) {
        const claimed = this.database().prepare("UPDATE announcement_targets SET status = 'sending', updated_at = ? WHERE announcement_id = ? AND target_jid = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM announcement_operations WHERE id = ? AND status = 'queued' AND expires_at > ?)").run(now, row.id, target.target_jid, row.id, now)
        if (claimed.changes !== 1) continue
        const result = await runPlatformOperation({ operationId: `announcement-${row.id}-${target.target_hash}`, timeoutMs: this.operationTimeoutMs, retry: { maxAttempts: 1 }, execute: () => whatsapp.sendText(target.target_jid, row.body) })
        if (result.ok) {
          this.database().prepare("UPDATE announcement_targets SET status = 'sent', sent_at = ?, updated_at = ?, failure_code = NULL WHERE announcement_id = ? AND target_jid = ? AND status = 'sending'").run(now, now, row.id, target.target_jid)
          this.audit('announcement.target.sent', row.operator_jid, row.group_jid, 'changed', { operationRefHash: hashText(row.id), memberRefHash: target.target_hash }, `announcement-send-${row.id}-${target.target_hash}`)
        } else {
          const failureCode = isTimeout(result.error) ? 'transport_timeout' : 'transport_failed'
          this.database().prepare("UPDATE announcement_targets SET status = 'failed', updated_at = ?, failure_code = ? WHERE announcement_id = ? AND target_jid = ? AND status = 'sending'").run(now, failureCode, row.id, target.target_jid)
          this.audit('announcement.target.failed', row.operator_jid, row.group_jid, 'failed', { operationRefHash: hashText(row.id), memberRefHash: target.target_hash, reasonCode: failureCode }, `announcement-fail-${row.id}-${target.target_hash}`)
        }
        changed += 1
      }
      this.finalizeIfComplete(row.id, now)
    }
    return changed
  }

  getAnnouncement(id: string, includeBody = false): AnnouncementRecord | undefined {
    validateIdentifier(id, 'announcement id')
    const row = this.database().prepare('SELECT * FROM announcement_operations WHERE id = ?').get(id) as AnnouncementRow | undefined
    return row ? mapAnnouncement(row, includeBody) : undefined
  }

  private async transitionApproved(input: { readonly groupJid: string; readonly actorJid: string; readonly announcementId: string; readonly expectedRevision: number; readonly correlationId: string }, whatsapp: WhatsAppPort, now: number): Promise<AnnouncementMutationResult> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'announcement approver')
    validateIdentifier(input.announcementId, 'announcement id')
    validateIdentifier(input.correlationId, 'announcement correlation id')
    if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error('announcement expectedRevision must be positive')
    const auth = await this.authorizeAdmin(input.groupJid, input.actorJid, whatsapp, input.correlationId)
    if (!auth.ok) return { kind: 'denied', code: auth.code ?? 'policy_denied' }
    const current = this.findAnnouncement(input.groupJid, input.announcementId)
    if (!current) return { kind: 'denied', code: 'not_found' }
    if (current.revision !== input.expectedRevision) return { kind: 'denied', code: 'stale_operation', record: mapAnnouncement(current, false) }
    if (current.expires_at <= now) {
      this.expireStaleState(now)
      const expired = this.findAnnouncement(input.groupJid, current.id)
      return { kind: 'denied', code: 'expired', ...(expired ? { record: mapAnnouncement(expired, false) } : {}) }
    }
    if (current.status !== 'planned') return { kind: 'denied', code: current.status === 'queued' ? 'duplicate' : 'invalid_state', record: mapAnnouncement(current, false) }
    const changed = this.database().prepare("UPDATE announcement_operations SET status = 'queued', revision = revision + 1, updated_at = ?, outcome_code = 'queued' WHERE id = ? AND group_jid = ? AND status = 'planned' AND revision = ? AND expires_at > ?").run(now, current.id, input.groupJid, current.revision, now)
    if (changed.changes !== 1) {
      const latest = this.findAnnouncement(input.groupJid, current.id)
      return { kind: 'denied', code: 'stale_operation', ...(latest ? { record: mapAnnouncement(latest, false) } : {}) }
    }
    this.audit('announcement.approved', input.actorJid, input.groupJid, 'allowed', { operationRefHash: hashText(current.id), audienceCount: current.target_count, previewFingerprint: current.target_fingerprint, revision: current.revision + 1 }, input.correlationId)
    const approved = this.getAnnouncement(current.id, false)
    if (!approved) throw new Error('announcement disappeared after approval')
    return { kind: 'completed', record: approved }
  }

  private handlePolicyDeferral(row: AnnouncementRow, reason: 'feature-off' | 'policy-disabled' | 'quiet-hours' | 'allowed', now: number): void {
    const key = `${row.id}:${reason}`
    if (reason === 'quiet-hours') {
      if (!this.policyAuditKeys.has(key)) {
        this.policyAuditKeys.add(key)
        this.audit('announcement.deferred', row.operator_jid, row.group_jid, 'limited', { operationRefHash: hashText(row.id), reasonCode: 'quiet_hours' }, `announcement-defer-${row.id}-quiet`)
      }
      return
    }
    if (reason === 'policy-disabled') {
      const changed = this.database().prepare("UPDATE announcement_operations SET status = 'limited', revision = revision + 1, updated_at = ?, outcome_code = 'policy_disabled' WHERE id = ? AND status = 'queued'").run(now, row.id)
      this.database().prepare("UPDATE announcement_targets SET status = 'cancelled', updated_at = ? WHERE announcement_id = ? AND status = 'pending'").run(now, row.id)
      if (changed.changes === 1) this.audit('announcement.limited', row.operator_jid, row.group_jid, 'limited', { operationRefHash: hashText(row.id), reasonCode: 'policy_disabled' }, `announcement-limit-${row.id}`)
    }
  }

  private failAnnouncement(row: AnnouncementRow, code: 'recovery_required' | 'transport_failed' | 'transport_timeout', now: number): void {
    const changed = this.database().prepare("UPDATE announcement_operations SET status = 'failed', revision = revision + 1, updated_at = ?, outcome_code = ? WHERE id = ? AND status = 'queued'").run(now, code, row.id)
    this.database().prepare("UPDATE announcement_targets SET status = 'failed', updated_at = ?, failure_code = ? WHERE announcement_id = ? AND status IN ('pending', 'sending')").run(now, code, row.id)
    if (changed.changes === 1) this.audit('announcement.failed', row.operator_jid, row.group_jid, 'failed', { operationRefHash: hashText(row.id), reasonCode: code }, `announcement-failed-${row.id}`)
  }

  private finalizeIfComplete(id: string, now: number): void {
    const row = this.database().prepare('SELECT * FROM announcement_operations WHERE id = ?').get(id) as AnnouncementRow | undefined
    if (!row || row.status !== 'queued') return
    const counts = this.database().prepare("SELECT status, COUNT(*) AS count FROM announcement_targets WHERE announcement_id = ? GROUP BY status").all(id) as Array<{ status: AnnouncementTargetStatus; count: number }>
    const count = new Map(counts.map((item) => [item.status, item.count]))
    if ((count.get('pending') ?? 0) > 0 || (count.get('sending') ?? 0) > 0) return
    const sent = count.get('sent') ?? 0
    const failed = count.get('failed') ?? 0
    const status: AnnouncementStatus = failed === 0 ? 'sent' : sent > 0 ? 'partial' : 'failed'
    const outcomeCode = status === 'sent' ? 'ok' : status
    const changed = this.database().prepare('UPDATE announcement_operations SET status = ?, revision = revision + 1, updated_at = ?, outcome_code = ? WHERE id = ? AND status = \'queued\'').run(status, now, outcomeCode, id)
    if (changed.changes === 1) this.audit(`announcement.${status}`, row.operator_jid, row.group_jid, status === 'sent' ? 'changed' : status === 'partial' ? 'limited' : 'failed', { operationRefHash: hashText(id), sentCount: sent, failedCount: failed }, `announcement-final-${id}`)
  }

  private expireStaleState(now: number): void {
    const rows = this.database().prepare("SELECT * FROM announcement_operations WHERE status IN ('planned', 'queued') AND expires_at <= ? ORDER BY expires_at ASC, id ASC LIMIT ?").all(now, MAX_EXPIRY_BATCH) as AnnouncementRow[]
    const expired: AnnouncementRow[] = []
    this.transaction(() => {
      for (const row of rows) {
        const updated = this.database().prepare("UPDATE announcement_operations SET status = 'expired', revision = revision + 1, updated_at = ?, outcome_code = 'expired' WHERE id = ? AND status IN ('planned', 'queued') AND revision = ?").run(now, row.id, row.revision)
        if (updated.changes !== 1) continue
        this.database().prepare("UPDATE announcement_targets SET status = 'cancelled', updated_at = ? WHERE announcement_id = ? AND status = 'pending'").run(now, row.id)
        expired.push(row)
      }
      this.database().prepare("UPDATE announcement_targets SET status = 'failed', failure_code = 'recovery_required', updated_at = ? WHERE status = 'sending' AND updated_at <= ?").run(now, now - this.operationTimeoutMs)
      const completed = this.database().prepare('SELECT id FROM announcement_operations WHERE content_expires_at <= ? AND body <> \'\' ORDER BY content_expires_at ASC, id ASC LIMIT ?').all(now, MAX_EXPIRY_BATCH) as Array<{ id: string }>
      for (const item of completed) this.database().prepare("UPDATE announcement_operations SET body = '' WHERE id = ? AND content_expires_at <= ? AND body <> ''").run(item.id, now)
    })
    for (const row of expired) this.audit('announcement.expired', row.operator_jid, row.group_jid, 'closed', { operationRefHash: hashText(row.id), audienceCount: row.target_count }, `announcement-expired-${row.id}-${row.revision + 1}`)
  }

  private async authorizeAdmin(groupJid: string, actorJid: string, whatsapp: WhatsAppPort, correlationId: string, allowWhenFeatureDisabled = false): Promise<AuthorizationResult> {
    if (!allowWhenFeatureDisabled && !this.isFeatureEnabled(groupJid)) {
      this.audit('announcement.authorization.denied', actorJid, groupJid, 'denied', { reasonCode: 'feature_disabled' }, correlationId)
      return { ok: false, code: 'feature_disabled' }
    }
    const policy = this.guardrailService().evaluatePolicy({ policyId: POLICY_ID, action: ACTION_ID, scope: 'group' }, { actorJid, resourceJid: groupJid, correlationId, metadata: { actionClass: 'operator' } })
    if (!policy.allowed) {
      this.audit('announcement.authorization.denied', actorJid, groupJid, 'denied', { reasonCode: 'policy_denied' }, correlationId)
      return { ok: false, code: 'policy_denied' }
    }
    const rate = this.guardrailService().consumeRate(RATE_PROFILE_ID, hashText(`${groupJid}:${actorJid}`), { actorJid, resourceJid: groupJid, correlationId })
    if (!rate.allowed) {
      this.audit('announcement.authorization.denied', actorJid, groupJid, 'limited', { reasonCode: 'rate_limited' }, correlationId)
      return { ok: false, code: 'rate_limited' }
    }
    let metadata: WhatsAppGroupMetadata
    try {
      metadata = await whatsapp.getGroupMetadata(groupJid)
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'announcement role check unavailable')
      this.audit('announcement.authorization.failed', actorJid, groupJid, 'failed', { reasonCode: 'role_check_unavailable' }, correlationId)
      return { ok: false, code: 'role_check_unavailable' }
    }
    if (metadata.jid !== groupJid || !isAdmin(metadata, actorJid)) {
      this.audit('announcement.authorization.denied', actorJid, groupJid, 'denied', { reasonCode: 'actor_not_admin' }, correlationId)
      return { ok: false, code: 'actor_not_admin' }
    }
    return { ok: true }
  }

  private findAnnouncement(groupJid: string, reference: string): AnnouncementRow | undefined {
    validateGroupJid(groupJid)
    validateIdentifier(reference, 'announcement id')
    const exact = this.database().prepare('SELECT * FROM announcement_operations WHERE id = ? AND group_jid = ?').get(reference, groupJid) as AnnouncementRow | undefined
    if (exact) return exact
    if (reference.length < 4) return undefined
    const rows = this.database().prepare('SELECT * FROM announcement_operations WHERE group_jid = ? AND id LIKE ? ORDER BY id ASC LIMIT 2').all(groupJid, `${reference}%`) as AnnouncementRow[]
    if (rows.length > 1) throw new Error('Announcement id prefix is ambiguous')
    return rows[0]
  }

  private audit(eventType: string, actorJid: string | undefined, groupJid: string | undefined, outcome: 'allowed' | 'denied' | 'changed' | 'failed' | 'limited' | 'opened' | 'closed', metadata: Record<string, unknown>, correlationId?: string): void {
    try {
      this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), ...(actorJid ? { actorJid } : {}), ...(groupJid ? { resourceJid: groupJid } : {}), outcome, correlationId, metadata })
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'announcement audit unavailable')
    }
  }

  private transaction<T>(operation: () => T): T {
    return this.database().transaction(operation)()
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS announcement_operations (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        operator_jid TEXT NOT NULL,
        body TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        target_count INTEGER NOT NULL CHECK (target_count > 0),
        target_fingerprint TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('planned', 'queued', 'sent', 'partial', 'failed', 'cancelled', 'expired', 'limited')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        content_expires_at INTEGER NOT NULL,
        outcome_code TEXT NOT NULL,
        group_hash TEXT NOT NULL,
        correlation_hash TEXT NOT NULL,
        UNIQUE(group_hash, correlation_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_announcement_group_status ON announcement_operations (group_jid, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS announcement_targets (
        announcement_id TEXT NOT NULL REFERENCES announcement_operations(id) ON DELETE CASCADE,
        target_jid TEXT NOT NULL,
        target_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
        updated_at INTEGER NOT NULL,
        sent_at INTEGER,
        failure_code TEXT,
        PRIMARY KEY (announcement_id, target_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_announcement_targets_claim ON announcement_targets (announcement_id, status, target_hash);
    `)
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('AnnouncementService is not initialized')
    return this.db
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('Announcement guardrails are not initialized')
    return this.guardrails
  }
}

function mapAnnouncement(row: AnnouncementRow, includeBody: boolean): AnnouncementRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    operatorRefHash: hashText(row.operator_jid),
    ...(includeBody && row.body ? { body: row.body } : {}),
    bodyHash: row.body_hash,
    targetCount: row.target_count,
    targetFingerprint: row.target_fingerprint,
    status: row.status,
    revision: row.revision,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contentExpiresAt: row.content_expires_at,
    outcomeCode: row.outcome_code,
  }
}

function normalizeBody(value: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error('Announcement body must be text')
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized || normalized.length > maxLength) throw new Error('Announcement body is empty or exceeds the limit')
  if (/(?:bearer\s+|password\s*[:=]|api[_-]?key\s*[:=]|-----begin)/i.test(normalized)) throw new Error('Announcement body contains sensitive-looking content')
  return normalized
}

function normalizeTargets(values: readonly string[], maxTargets: number): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > maxTargets) throw new Error(`Announcement requires 1-${maxTargets} explicit targets`)
  const normalized = [...new Set(values.map((value) => value.trim()))].sort()
  if (normalized.length !== values.length) throw new Error('Announcement targets must be unique')
  for (const value of normalized) {
    if (!isJid(value) || value.endsWith('@g.us')) throw new Error('Announcement targets must be user JIDs')
  }
  return normalized
}

function fingerprintTargets(targets: readonly string[]): string {
  return hashText(targets.join('\n'))
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

function validateLimit(value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`limit must be between 1 and ${max}`)
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isAdmin(metadata: WhatsAppGroupMetadata, actorJid: string): boolean {
  return metadata.participants.some((participant) => participant.jid === actorJid && (participant.role === 'admin' || participant.role === 'superadmin'))
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out|abort/i.test(error.name) || error instanceof Error && /timeout|timed out|abort/i.test(error.message)
}
