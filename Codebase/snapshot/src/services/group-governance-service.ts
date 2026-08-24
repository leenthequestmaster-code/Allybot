import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type {
  Service,
  ServiceContext,
  WhatsAppGroupMetadata,
  WhatsAppGroupParticipantActionResult,
  WhatsAppPort,
} from '../framework/contracts.js'
import { runPlatformOperation, type OperationResult } from '../platform/operations.js'
import { isJid, isSafeIdentifier } from '../platform/validation.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'

export type GovernanceRetconStatus = 'draft' | 'proposed' | 'approved' | 'rejected'
export type GovernanceHandoffStatus = 'offered' | 'claimed' | 'declined' | 'expired' | 'closed'
export type GovernanceJoinRequestStatus = 'pending' | 'approving' | 'approved' | 'rejected'
export type GovernanceOperationType = 'join_approve' | 'join_reject' | 'invite_revoke'
export type GovernanceOperationStatus = 'planned' | 'running' | 'succeeded' | 'failed' | 'expired'
export type GovernanceOutcomeCode =
  | 'ok'
  | 'feature_disabled'
  | 'policy_denied'
  | 'rate_limited'
  | 'actor_not_admin'
  | 'bot_not_admin'
  | 'role_check_unavailable'
  | 'capability_unavailable'
  | 'transport_timeout'
  | 'transport_failed'
  | 'stale_request'
  | 'duplicate'
  | 'in_progress'
  | 'invalid_confirmation'
  | 'confirmation_expired'
  | 'recovery_required'

export interface GovernanceSettingsRecord {
  readonly groupJid: string
  readonly enabled: boolean
  readonly updatedByHash: string
  readonly updatedAt: number
}

export interface RetconRecord {
  readonly id: string
  readonly groupJid: string
  readonly target: string
  readonly replacement: string
  readonly rationale: string
  readonly sourceRefHash?: string
  readonly status: GovernanceRetconStatus
  readonly revision: number
  readonly createdByHash: string
  readonly decidedByHash?: string
  readonly createdAt: number
  readonly updatedAt: number
}

export interface RetconHistoryRecord {
  readonly retconId: string
  readonly groupJid: string
  readonly action: string
  readonly target: string
  readonly replacement: string
  readonly rationale: string
  readonly revision: number
  readonly actorHash: string
  readonly at: number
}

export interface HandoffRecord {
  readonly id: string
  readonly groupJid: string
  readonly scope: string
  readonly status: GovernanceHandoffStatus
  readonly offeredByHash: string
  readonly claimantHash?: string
  readonly evidenceCount: number
  readonly revision: number
  readonly expiresAt: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface JoinRequestRecord {
  readonly id: string
  readonly groupJid: string
  readonly requesterRefHash: string
  readonly status: GovernanceJoinRequestStatus
  readonly revision: number
  readonly requestedAt: number
  readonly decidedByHash?: string
  readonly decidedAt?: number
}

export interface GovernanceOperationRecord {
  readonly operationId: string
  readonly groupHash: string
  readonly actorHash: string
  readonly operationType: GovernanceOperationType
  readonly targetHash: string
  readonly requestId?: string
  readonly status: GovernanceOperationStatus
  readonly correlationHash: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number
  readonly outcomeCode: GovernanceOutcomeCode
}

export type GovernanceMutationResult =
  | { readonly kind: 'completed'; readonly record: GovernanceOperationRecord; readonly participantResults?: readonly WhatsAppGroupParticipantActionResult[] }
  | { readonly kind: 'denied'; readonly code: GovernanceOutcomeCode; readonly record?: GovernanceOperationRecord }

interface RetconRow {
  id: string
  group_jid: string
  target: string
  replacement: string
  rationale: string
  source_ref_hash: string | null
  status: GovernanceRetconStatus
  revision: number
  created_by_hash: string
  decided_by_hash: string | null
  created_at: number
  updated_at: number
}

interface HandoffRow {
  id: string
  group_jid: string
  scope: string
  status: GovernanceHandoffStatus
  offered_by_hash: string
  claimant_hash: string | null
  evidence_count: number
  revision: number
  expires_at: number
  created_at: number
  updated_at: number
}

interface JoinRequestRow {
  id: string
  group_jid: string
  requester_jid: string
  status: GovernanceJoinRequestStatus
  revision: number
  requested_at: number
  decided_by_hash: string | null
  decided_at: number | null
}

interface OperationRow {
  operation_id: string
  group_hash: string
  actor_hash: string
  operation_type: GovernanceOperationType
  target_hash: string
  request_id: string | null
  status: GovernanceOperationStatus
  correlation_hash: string
  created_at: number
  updated_at: number
  expires_at: number
  outcome_code: GovernanceOutcomeCode
}

interface ConfirmationRow {
  confirmation_id: string
  group_hash: string
  actor_hash: string
  confirmation_hash: string
  status: 'pending' | 'used'
  expires_at: number
  created_at: number
}

interface PendingOperation {
  readonly groupJid: string
  readonly actorJid: string
  readonly botJid: string
  readonly operationType: GovernanceOperationType
  readonly requesterJid?: string
  readonly confirmationId?: string
}

interface AuthorizationResult {
  readonly ok: boolean
  readonly code?: GovernanceOutcomeCode
}

export interface GroupGovernanceServiceOptions {
  readonly clock?: () => number
  readonly operationTtlMs?: number
  readonly confirmationTtlMs?: number
  readonly maxListLimit?: number
  readonly maxTextLength?: number
}

const FEATURE_ID = 'group.governance.core'
const RETCON_POLICY_ID = 'group-governance.retcon'
const HANDOFF_POLICY_ID = 'group-governance.handoff'
const ACCESS_POLICY_ID = 'group-governance.access'
const RETCON_ACTION_ID = 'group-governance.retcon'
const HANDOFF_ACTION_ID = 'group-governance.handoff'
const ACCESS_ACTION_ID = 'group-governance.access'
const RATE_PROFILE_ID = 'group-governance.core'
const DEFAULT_OPERATION_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1_000
const DEFAULT_MAX_LIST_LIMIT = 25
const DEFAULT_MAX_TEXT_LENGTH = 500

export class GroupGovernanceService implements Service {
  readonly name = 'group-governance'
  readonly dependencies = ['platform-guardrails'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly operationTtlMs: number
  private readonly confirmationTtlMs: number
  private readonly maxListLimit: number
  private readonly maxTextLength: number
  private readonly logger: Logger
  private db: Database.Database | undefined
  private guardrails: PlatformGuardrailService | undefined
  private readonly pending = new Map<string, PendingOperation>()
  private unregisters: Array<() => void> = []

  constructor(databasePath: string, logger: Logger, options: GroupGovernanceServiceOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.operationTtlMs = options.operationTtlMs ?? DEFAULT_OPERATION_TTL_MS
    this.confirmationTtlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS
    this.maxListLimit = options.maxListLimit ?? DEFAULT_MAX_LIST_LIMIT
    this.maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH
    this.logger = logger.child({ component: 'group-governance' })
    if (!Number.isInteger(this.operationTtlMs) || this.operationTtlMs < 1) throw new Error('operationTtlMs must be a positive integer')
    if (!Number.isInteger(this.confirmationTtlMs) || this.confirmationTtlMs < 1) throw new Error('confirmationTtlMs must be a positive integer')
    if (!Number.isInteger(this.maxListLimit) || this.maxListLimit < 1) throw new Error('maxListLimit must be a positive integer')
    if (!Number.isInteger(this.maxTextLength) || this.maxTextLength < 32) throw new Error('maxTextLength must be at least 32')
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
      this.guardrails.registerPolicy({ id: RETCON_POLICY_ID, version: 1, action: RETCON_ACTION_ID, scope: 'group', description: 'R8 retcon review governance', featureId: FEATURE_ID, rateProfileId: RATE_PROFILE_ID }),
      this.guardrails.registerPolicy({ id: HANDOFF_POLICY_ID, version: 1, action: HANDOFF_ACTION_ID, scope: 'group', description: 'R8 moderator handoff governance', featureId: FEATURE_ID, rateProfileId: RATE_PROFILE_ID }),
      this.guardrails.registerPolicy({ id: ACCESS_POLICY_ID, version: 1, action: ACCESS_ACTION_ID, scope: 'group', description: 'R8 group access governance', featureId: FEATURE_ID, rateProfileId: RATE_PROFILE_ID }),
      this.guardrails.registerAction({ id: RETCON_ACTION_ID, version: 1, description: 'R8 retcon proposal/review', inputSchemaVersion: 1, risk: 'medium', requiredPermission: 'group.admin', featureId: FEATURE_ID }),
      this.guardrails.registerAction({ id: HANDOFF_ACTION_ID, version: 1, description: 'R8 moderator handoff', inputSchemaVersion: 1, risk: 'high', requiredPermission: 'group.admin', featureId: FEATURE_ID }),
      this.guardrails.registerAction({ id: ACCESS_ACTION_ID, version: 1, description: 'R8 join/invite access mutation', inputSchemaVersion: 1, risk: 'high', requiredPermission: 'group.admin', featureId: FEATURE_ID }),
      this.guardrails.registerRateProfile({ id: RATE_PROFILE_ID, maxRequests: 10, windowMs: 60_000 }),
    ]
    this.logger.info('group governance storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    for (const unregister of this.unregisters.splice(0)) unregister()
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
    this.pending.clear()
  }

  getSettings(groupJid: string): GovernanceSettingsRecord {
    validateGroupJid(groupJid)
    const row = this.database().prepare('SELECT group_jid, enabled, updated_by_hash, updated_at FROM group_governance_settings WHERE group_jid = ?').get(groupJid) as { group_jid: string; enabled: number; updated_by_hash: string; updated_at: number } | undefined
    return row ? { groupJid: row.group_jid, enabled: row.enabled === 1, updatedByHash: row.updated_by_hash, updatedAt: row.updated_at } : { groupJid, enabled: false, updatedByHash: '', updatedAt: 0 }
  }

  isFeatureEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().isFeatureEnabled(groupJid, FEATURE_ID)
  }

  setEnabled(groupJid: string, enabled: boolean, actorJid: string, now = this.clock()): GovernanceSettingsRecord {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'governance actor')
    this.guardrailService().setFeatureFlag(groupJid, FEATURE_ID, enabled, actorJid, `governance-feature-${now}`, now)
    return this.transaction(() => {
      this.database().prepare(`
        INSERT INTO group_governance_settings (group_jid, enabled, updated_by_hash, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(group_jid) DO UPDATE SET enabled = excluded.enabled, updated_by_hash = excluded.updated_by_hash, updated_at = excluded.updated_at
      `).run(groupJid, enabled ? 1 : 0, hashText(actorJid), now)
      this.audit('governance.feature.changed', actorJid, groupJid, 'changed', { enabled })
      return this.getSettings(groupJid)
    })
  }

  async createRetcon(input: { groupJid: string; actorJid: string; target: string; replacement: string; rationale: string; sourceRef?: string }, whatsapp: WhatsAppPort, now = this.clock()): Promise<RetconRecord | undefined> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'retcon actor')
    const target = normalizeText(input.target, this.maxTextLength, 'retcon target')
    const replacement = normalizeText(input.replacement, this.maxTextLength, 'retcon replacement')
    const rationale = normalizeText(input.rationale, this.maxTextLength, 'retcon rationale')
    const auth = await this.authorize(input.groupJid, input.actorJid, whatsapp, RETCON_POLICY_ID, RETCON_ACTION_ID, `retcon-create-${now}`)
    if (!auth.ok) return undefined
    const id = randomUUID()
    const record = this.transaction(() => {
      this.database().prepare(`INSERT INTO governance_retcons (id, group_jid, target, replacement, rationale, source_ref_hash, status, revision, created_by_hash, decided_by_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', 1, ?, NULL, ?, ?)`).run(id, input.groupJid, target, replacement, rationale, input.sourceRef ? hashText(input.sourceRef) : null, hashText(input.actorJid), now, now)
      this.appendRetconHistory(id, input.groupJid, 'created', target, replacement, rationale, 1, input.actorJid, now)
      return this.getRetcon(input.groupJid, id)
    })
    this.audit('governance.retcon.created', input.actorJid, input.groupJid, 'changed', { retconRefHash: hashText(id), targetHash: hashText(target) })
    return record
  }

  async transitionRetcon(input: { groupJid: string; actorJid: string; retconId: string; target: 'proposed' | 'approved' | 'rejected'; expectedRevision?: number }, whatsapp: WhatsAppPort, now = this.clock()): Promise<RetconRecord | undefined> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'retcon reviewer')
    validateIdentifier(input.retconId, 'retcon id')
    const auth = await this.authorize(input.groupJid, input.actorJid, whatsapp, RETCON_POLICY_ID, RETCON_ACTION_ID, `retcon-${input.target}-${now}`)
    if (!auth.ok) return undefined
    return this.transaction(() => {
      const current = this.getRetcon(input.groupJid, input.retconId)
      if (!current || (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)) return undefined
      const allowed = (current.status === 'draft' && input.target === 'proposed') || (current.status === 'proposed' && (input.target === 'approved' || input.target === 'rejected'))
      if (!allowed) return undefined
      const result = this.database().prepare(`UPDATE governance_retcons SET status = ?, revision = revision + 1, decided_by_hash = ?, updated_at = ? WHERE id = ? AND group_jid = ? AND status = ? AND revision = ?`).run(input.target, hashText(input.actorJid), now, input.retconId, input.groupJid, current.status, current.revision)
      if (result.changes !== 1) return undefined
      const updated = this.getRetcon(input.groupJid, input.retconId)
      if (!updated) return undefined
      this.appendRetconHistory(updated.id, input.groupJid, input.target, updated.target, updated.replacement, updated.rationale, updated.revision, input.actorJid, now)
      this.audit(`governance.retcon.${input.target}`, input.actorJid, input.groupJid, input.target === 'rejected' ? 'closed' : 'changed', { retconRefHash: hashText(input.retconId), revision: updated.revision })
      return updated
    })
  }

  getRetcon(groupJid: string, retconId: string): RetconRecord | undefined {
    validateGroupJid(groupJid)
    validateIdentifier(retconId, 'retcon id')
    const row = this.database().prepare('SELECT * FROM governance_retcons WHERE id = ? AND group_jid = ?').get(retconId, groupJid) as RetconRow | undefined
    return row ? mapRetcon(row) : undefined
  }

  listRetcons(groupJid: string, status?: GovernanceRetconStatus, limit = this.maxListLimit): readonly RetconRecord[] {
    validateGroupJid(groupJid)
    validateLimit(limit, this.maxListLimit)
    if (status && !['draft', 'proposed', 'approved', 'rejected'].includes(status)) throw new Error('Invalid retcon status')
    const rows = this.database().prepare('SELECT * FROM governance_retcons WHERE group_jid = ? AND (? IS NULL OR status = ?) ORDER BY updated_at DESC, id DESC LIMIT ?').all(groupJid, status ?? null, status ?? null, limit) as RetconRow[]
    return rows.map(mapRetcon)
  }

  listRetconHistory(groupJid: string, retconId: string, limit = this.maxListLimit): readonly RetconHistoryRecord[] {
    validateGroupJid(groupJid)
    validateIdentifier(retconId, 'retcon id')
    validateLimit(limit, this.maxListLimit)
    const rows = this.database().prepare('SELECT retcon_id, group_jid, action, target, replacement, rationale, revision, actor_hash, at FROM governance_retcon_history WHERE group_jid = ? AND retcon_id = ? ORDER BY revision DESC LIMIT ?').all(groupJid, retconId, limit) as Array<{ retcon_id: string; group_jid: string; action: string; target: string; replacement: string; rationale: string; revision: number; actor_hash: string; at: number }>
    return rows.map((row) => ({ retconId: row.retcon_id, groupJid: row.group_jid, action: row.action, target: row.target, replacement: row.replacement, rationale: row.rationale, revision: row.revision, actorHash: row.actor_hash, at: row.at }))
  }

  async createHandoff(input: { groupJid: string; actorJid: string; scope: string; evidenceCount?: number; expiresAt?: number }, whatsapp: WhatsAppPort, now = this.clock()): Promise<HandoffRecord | undefined> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'handoff actor')
    const scope = normalizeText(input.scope, this.maxTextLength, 'handoff scope')
    const evidenceCount = input.evidenceCount ?? 0
    if (!Number.isInteger(evidenceCount) || evidenceCount < 0 || evidenceCount > 5) throw new Error('handoff evidenceCount must be between 0 and 5')
    const expiresAt = input.expiresAt ?? now + 24 * 60 * 60 * 1_000
    if (!Number.isInteger(expiresAt) || expiresAt <= now) throw new Error('handoff expiresAt must be in the future')
    const auth = await this.authorize(input.groupJid, input.actorJid, whatsapp, HANDOFF_POLICY_ID, HANDOFF_ACTION_ID, `handoff-create-${now}`)
    if (!auth.ok) return undefined
    const id = randomUUID()
    const record = this.transaction(() => {
      this.database().prepare('INSERT INTO governance_handoffs (id, group_jid, scope, status, offered_by_hash, claimant_hash, evidence_count, revision, expires_at, created_at, updated_at) VALUES (?, ?, ?, \'offered\', ?, NULL, ?, 1, ?, ?, ?)').run(id, input.groupJid, scope, hashText(input.actorJid), evidenceCount, expiresAt, now, now)
      return this.getHandoff(input.groupJid, id)
    })
    this.audit('governance.handoff.opened', input.actorJid, input.groupJid, 'opened', { handoffRefHash: hashText(id), evidenceCount })
    return record
  }

  async transitionHandoff(input: { groupJid: string; actorJid: string; handoffId: string; target: 'claimed' | 'declined' | 'closed'; expectedRevision?: number }, whatsapp: WhatsAppPort, now = this.clock()): Promise<HandoffRecord | undefined> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'handoff actor')
    validateIdentifier(input.handoffId, 'handoff id')
    const auth = await this.authorize(input.groupJid, input.actorJid, whatsapp, HANDOFF_POLICY_ID, HANDOFF_ACTION_ID, `handoff-${input.target}-${now}`)
    if (!auth.ok) return undefined
    return this.transaction(() => {
      const current = this.getHandoff(input.groupJid, input.handoffId)
      if (!current || current.expiresAt <= now || current.status !== 'offered' || (input.expectedRevision !== undefined && current.revision !== input.expectedRevision)) return undefined
      const result = this.database().prepare('UPDATE governance_handoffs SET status = ?, claimant_hash = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND group_jid = ? AND status = \'offered\' AND revision = ?').run(input.target, input.target === 'claimed' ? hashText(input.actorJid) : null, now, input.handoffId, input.groupJid, current.revision)
      if (result.changes !== 1) return undefined
      const updated = this.getHandoff(input.groupJid, input.handoffId)
      if (updated) this.audit(`governance.handoff.${input.target}`, input.actorJid, input.groupJid, input.target === 'declined' || input.target === 'closed' ? 'closed' : 'changed', { handoffRefHash: hashText(input.handoffId), revision: updated.revision })
      return updated
    })
  }

  getHandoff(groupJid: string, handoffId: string): HandoffRecord | undefined {
    validateGroupJid(groupJid)
    validateIdentifier(handoffId, 'handoff id')
    this.expireStaleState(this.clock())
    const row = this.database().prepare('SELECT * FROM governance_handoffs WHERE id = ? AND group_jid = ?').get(handoffId, groupJid) as HandoffRow | undefined
    return row ? mapHandoff(row) : undefined
  }

  listHandoffs(groupJid: string, limit = this.maxListLimit): readonly HandoffRecord[] {
    validateGroupJid(groupJid)
    validateLimit(limit, this.maxListLimit)
    this.expireStaleState(this.clock())
    const rows = this.database().prepare('SELECT * FROM governance_handoffs WHERE group_jid = ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(groupJid, limit) as HandoffRow[]
    return rows.map(mapHandoff)
  }

  recordJoinRequest(input: { groupJid: string; requesterJid: string; requestId?: string; requestedAt?: number }): JoinRequestRecord | undefined {
    validateGroupJid(input.groupJid)
    validateJid(input.requesterJid, 'join requester')
    const id = input.requestId ?? randomUUID()
    validateIdentifier(id, 'join request id')
    const now = input.requestedAt ?? this.clock()
    if (!this.isFeatureEnabled(input.groupJid)) return undefined
    this.database().prepare('INSERT OR IGNORE INTO governance_join_requests (id, group_jid, requester_jid, status, revision, requested_at, decided_by_hash, decided_at) VALUES (?, ?, ?, \'pending\', 1, ?, NULL, NULL)').run(id, input.groupJid, input.requesterJid, now)
    const record = this.getJoinRequest(input.groupJid, id)
    if (record) this.audit('governance.join_request.opened', input.requesterJid, input.groupJid, 'opened', { requestRefHash: hashText(id) })
    return record
  }

  getJoinRequest(groupJid: string, requestId: string): JoinRequestRecord | undefined {
    validateGroupJid(groupJid)
    validateIdentifier(requestId, 'join request id')
    const row = this.database().prepare('SELECT * FROM governance_join_requests WHERE id = ? AND group_jid = ?').get(requestId, groupJid) as JoinRequestRow | undefined
    return row ? mapJoinRequest(row) : undefined
  }

  listJoinRequests(groupJid: string, status?: GovernanceJoinRequestStatus, limit = this.maxListLimit): readonly JoinRequestRecord[] {
    validateGroupJid(groupJid)
    validateLimit(limit, this.maxListLimit)
    if (status && !['pending', 'approving', 'approved', 'rejected'].includes(status)) throw new Error('Invalid join request status')
    const rows = this.database().prepare('SELECT * FROM governance_join_requests WHERE group_jid = ? AND (? IS NULL OR status = ?) ORDER BY requested_at DESC, id DESC LIMIT ?').all(groupJid, status ?? null, status ?? null, limit) as JoinRequestRow[]
    return rows.map(mapJoinRequest)
  }

  async approveJoinRequest(input: { groupJid: string; actorJid: string; botJid: string; requestId: string; correlationId: string; expectedRevision?: number }, whatsapp: WhatsAppPort, now = this.clock()): Promise<GovernanceMutationResult> {
    return this.planAndExecuteAccessOperation({ ...input, operationType: 'join_approve' }, whatsapp, now)
  }

  async rejectJoinRequest(input: { groupJid: string; actorJid: string; botJid: string; requestId: string; correlationId: string; expectedRevision?: number }, whatsapp: WhatsAppPort, now = this.clock()): Promise<GovernanceMutationResult> {
    return this.planAndExecuteAccessOperation({ ...input, operationType: 'join_reject' }, whatsapp, now)
  }

  async previewInviteRevoke(input: { groupJid: string; actorJid: string }, whatsapp: WhatsAppPort, now = this.clock()): Promise<{ readonly confirmationToken: string; readonly expiresAt: number } | undefined> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'invite actor')
    const auth = await this.authorize(input.groupJid, input.actorJid, whatsapp, ACCESS_POLICY_ID, ACCESS_ACTION_ID, `invite-preview-${now}`)
    if (!auth.ok) return undefined
    const token = randomUUID()
    const id = randomUUID()
    const expiresAt = now + this.confirmationTtlMs
    this.database().prepare('INSERT INTO governance_invite_confirmations (confirmation_id, group_hash, actor_hash, confirmation_hash, status, expires_at, created_at) VALUES (?, ?, ?, ?, \'pending\', ?, ?)').run(id, hashText(input.groupJid), hashText(input.actorJid), hashText(token), expiresAt, now)
    this.audit('governance.invite.revoke.preview', input.actorJid, input.groupJid, 'allowed', { confirmationRefHash: hashText(id), expiresAt })
    return { confirmationToken: token, expiresAt }
  }

  async confirmInviteRevoke(input: { groupJid: string; actorJid: string; botJid: string; confirmationToken: string; correlationId: string }, whatsapp: WhatsAppPort, now = this.clock()): Promise<GovernanceMutationResult> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'invite actor')
    validateJid(input.botJid, 'invite bot')
    validateText(input.confirmationToken, 128, 'confirmation token')
    const confirmation = this.database().prepare('SELECT * FROM governance_invite_confirmations WHERE group_hash = ? AND actor_hash = ? AND confirmation_hash = ? AND status = \'pending\' ORDER BY created_at DESC LIMIT 1').get(hashText(input.groupJid), hashText(input.actorJid), hashText(input.confirmationToken)) as ConfirmationRow | undefined
    if (!confirmation) return { kind: 'denied', code: 'invalid_confirmation' }
    if (confirmation.expires_at <= now) return { kind: 'denied', code: 'confirmation_expired' }
    return this.planAndExecuteAccessOperation({ ...input, operationType: 'invite_revoke', confirmationId: confirmation.confirmation_id }, whatsapp, now)
  }

  async getInviteLink(groupJid: string, actorJid: string, whatsapp: WhatsAppPort): Promise<string | undefined> {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'invite actor')
    const auth = await this.authorize(groupJid, actorJid, whatsapp, ACCESS_POLICY_ID, ACCESS_ACTION_ID, `invite-info-${this.clock()}`)
    if (!auth.ok) return undefined
    return whatsapp.getGroupInviteLink(groupJid)
  }

  continuityCheck(groupJid: string): { readonly pendingRetcons: number; readonly activeHandoffs: number; readonly pendingJoinRequests: number; readonly recoverableOperations: number } {
    validateGroupJid(groupJid)
    this.expireStaleState(this.clock())
    const groupHash = hashText(groupJid)
    const count = (sql: string, params: readonly unknown[]): number => Number((this.database().prepare(sql).get(...params) as { count: number }).count)
    return {
      pendingRetcons: count("SELECT COUNT(*) AS count FROM governance_retcons WHERE group_jid = ? AND status IN ('draft', 'proposed')", [groupJid]),
      activeHandoffs: count("SELECT COUNT(*) AS count FROM governance_handoffs WHERE group_jid = ? AND status = 'offered' AND expires_at > ?", [groupJid, this.clock()]),
      pendingJoinRequests: count("SELECT COUNT(*) AS count FROM governance_join_requests WHERE group_jid = ? AND status IN ('pending', 'approving')", [groupJid]),
      recoverableOperations: count("SELECT COUNT(*) AS count FROM governance_operations WHERE group_hash = ? AND status IN ('planned', 'running')", [groupHash]),
    }
  }

  getOperation(operationId: string): GovernanceOperationRecord | undefined {
    validateIdentifier(operationId, 'governance operation id')
    const row = this.database().prepare('SELECT * FROM governance_operations WHERE operation_id = ?').get(operationId) as OperationRow | undefined
    return row ? mapOperation(row) : undefined
  }

  private async planAndExecuteAccessOperation(input: { groupJid: string; actorJid: string; botJid: string; requestId?: string; correlationId: string; expectedRevision?: number; operationType: GovernanceOperationType; confirmationId?: string }, whatsapp: WhatsAppPort, now: number): Promise<GovernanceMutationResult> {
    validateGroupJid(input.groupJid)
    validateJid(input.actorJid, 'governance actor')
    validateJid(input.botJid, 'governance bot')
    validateText(input.correlationId, 128, 'correlation id')
    if (input.requestId) validateIdentifier(input.requestId, 'join request id')
    const auth = await this.authorize(input.groupJid, input.actorJid, whatsapp, ACCESS_POLICY_ID, ACCESS_ACTION_ID, input.correlationId)
    if (!auth.ok) return { kind: 'denied', code: auth.code ?? 'policy_denied' }

    let requesterJid: string | undefined
    if (input.operationType !== 'invite_revoke') {
      if (!input.requestId) return { kind: 'denied', code: 'stale_request' }
      const request = this.getJoinRequest(input.groupJid, input.requestId)
      if (!request) return { kind: 'denied', code: 'stale_request' }
      if (input.expectedRevision !== undefined && request.revision !== input.expectedRevision) return { kind: 'denied', code: 'stale_request' }
      if (request.status === 'approving') return { kind: 'denied', code: 'in_progress' }
      if (request.status !== 'pending') return { kind: 'denied', code: 'duplicate' }
      const raw = this.database().prepare('SELECT requester_jid FROM governance_join_requests WHERE id = ? AND group_jid = ?').get(input.requestId, input.groupJid) as { requester_jid: string } | undefined
      requesterJid = raw?.requester_jid
      if (!requesterJid) return { kind: 'denied', code: 'recovery_required' }
    }

    const correlationHash = hashText(input.correlationId)
    const planned = this.transaction(() => {
      const existing = this.database().prepare('SELECT * FROM governance_operations WHERE group_hash = ? AND correlation_hash = ?').get(hashText(input.groupJid), correlationHash) as OperationRow | undefined
      if (existing) return { kind: 'duplicate' as const, record: mapOperation(existing) }
      if (input.requestId) {
        const updated = this.database().prepare("UPDATE governance_join_requests SET status = 'approving', revision = revision + 1 WHERE id = ? AND group_jid = ? AND status = 'pending' AND (? IS NULL OR revision = ?)").run(input.requestId, input.groupJid, input.expectedRevision ?? null, input.expectedRevision ?? null)
        if (updated.changes !== 1) return { kind: 'denied' as const, code: 'stale_request' as const }
      }
      const operationId = randomUUID()
      this.database().prepare('INSERT INTO governance_operations (operation_id, group_hash, actor_hash, operation_type, target_hash, request_id, status, correlation_hash, created_at, updated_at, expires_at, outcome_code) VALUES (?, ?, ?, ?, ?, ?, \'planned\', ?, ?, ?, ?, \'ok\')').run(operationId, hashText(input.groupJid), hashText(input.actorJid), input.operationType, hashText(input.requestId ?? input.confirmationId ?? input.groupJid), input.requestId ?? null, correlationHash, now, now, now + this.operationTtlMs)
      return { kind: 'planned' as const, record: this.getOperation(operationId)! }
    })
    if (planned.kind !== 'planned') return planned.kind === 'duplicate' ? { kind: 'denied', code: 'duplicate', record: planned.record } : { kind: 'denied', code: planned.code }
    this.pending.set(planned.record.operationId, { groupJid: input.groupJid, actorJid: input.actorJid, botJid: input.botJid, operationType: input.operationType, ...(requesterJid ? { requesterJid } : {}), ...(input.confirmationId ? { confirmationId: input.confirmationId } : {}) })
    this.audit('governance.operation.planned', input.actorJid, input.groupJid, 'allowed', { operationRefHash: hashText(planned.record.operationId), operationType: input.operationType })
    return this.executeOperation(planned.record.operationId, whatsapp, now)
  }

  private async executeOperation(operationId: string, whatsapp: WhatsAppPort, now: number): Promise<GovernanceMutationResult> {
    const current = this.getOperation(operationId)
    if (!current) return { kind: 'denied', code: 'recovery_required' }
    if (current.status === 'succeeded') return { kind: 'completed', record: current }
    if (current.status === 'running') return { kind: 'denied', code: 'in_progress', record: current }
    if (current.status !== 'planned') return { kind: 'denied', code: current.outcomeCode, record: current }
    if (current.expiresAt <= now) {
      const expired = this.expireOperation(operationId, now)
      return { kind: 'denied', code: 'recovery_required', ...(expired ? { record: expired } : {}) }
    }
    const pending = this.pending.get(operationId)
    if (!pending) return { kind: 'denied', code: 'recovery_required', record: this.updateOperation(operationId, 'failed', 'recovery_required', now) }
    const claimed = this.claimOperation(operationId, now)
    if (!claimed) return { kind: 'denied', code: 'in_progress', record: this.getOperation(operationId) }

    const auth = await this.authorize(pending.groupJid, pending.actorJid, whatsapp, ACCESS_POLICY_ID, ACCESS_ACTION_ID, operationId)
    if (!auth.ok) {
      this.pending.delete(operationId)
      const failed = this.updateOperation(operationId, 'failed', auth.code ?? 'policy_denied', this.clock())
      return { kind: 'denied', code: auth.code ?? 'policy_denied', ...(failed ? { record: failed } : {}) }
    }

    let participantResults: readonly WhatsAppGroupParticipantActionResult[] | undefined
    if (pending.operationType === 'join_approve') {
      if (!whatsapp.groupParticipantsUpdate || !pending.requesterJid) return this.failOperation(operationId, pending, 'capability_unavailable')
      const result = await runPlatformOperation<readonly WhatsAppGroupParticipantActionResult[]>({ operationId: `governance-${operationId}`, timeoutMs: 20_000, retry: { maxAttempts: 1 }, execute: () => whatsapp.groupParticipantsUpdate!(pending.groupJid, [pending.requesterJid!], 'add') })
      if (!result.ok) return this.failOperation(operationId, pending, isTimeout(result.error) ? 'transport_timeout' : 'transport_failed')
      participantResults = result.value
    } else if (pending.operationType === 'invite_revoke') {
      if (!whatsapp.groupRevokeInvite) return this.failOperation(operationId, pending, 'capability_unavailable')
      const result = await runPlatformOperation<string | undefined>({ operationId: `governance-${operationId}`, timeoutMs: 20_000, retry: { maxAttempts: 1 }, execute: () => whatsapp.groupRevokeInvite!(pending.groupJid) })
      if (!result.ok) return this.failOperation(operationId, pending, isTimeout(result.error) ? 'transport_timeout' : 'transport_failed')
    }

    const completed = this.transaction(() => {
      if (pending.operationType === 'join_approve' || pending.operationType === 'join_reject') {
        const status = pending.operationType === 'join_approve' ? 'approved' : 'rejected'
        const changed = this.database().prepare('UPDATE governance_join_requests SET status = ?, decided_by_hash = ?, decided_at = ?, revision = revision + 1 WHERE id = ? AND group_jid = ? AND status = \'approving\'').run(status, hashText(pending.actorJid), this.clock(), this.findRequestId(operationId), pending.groupJid)
        if (changed.changes !== 1) return undefined
      }
      if (pending.operationType === 'invite_revoke' && pending.confirmationId) {
        const changed = this.database().prepare("UPDATE governance_invite_confirmations SET status = 'used' WHERE confirmation_id = ? AND status = 'pending' AND expires_at > ?").run(pending.confirmationId, this.clock())
        if (changed.changes !== 1) return undefined
      }
      return this.updateOperation(operationId, 'succeeded', 'ok', this.clock())
    })
    this.pending.delete(operationId)
    if (!completed) return { kind: 'denied', code: 'recovery_required', record: this.updateOperation(operationId, 'failed', 'recovery_required', this.clock()) }
    this.audit('governance.operation.completed', pending.actorJid, pending.groupJid, 'changed', { operationRefHash: hashText(operationId), operationType: pending.operationType })
    return { kind: 'completed', record: completed, ...(participantResults ? { participantResults } : {}) }
  }

  private findRequestId(operationId: string): string | undefined {
    const row = this.database().prepare('SELECT request_id FROM governance_operations WHERE operation_id = ?').get(operationId) as { request_id: string | null } | undefined
    return row?.request_id ?? undefined
  }

  private async authorize(groupJid: string, actorJid: string, whatsapp: WhatsAppPort, policyId: string, actionId: string, correlationId: string): Promise<AuthorizationResult> {
    if (!this.isFeatureEnabled(groupJid)) {
      this.audit('governance.authorization.denied', actorJid, groupJid, 'denied', { actionId, code: 'feature_disabled' }, correlationId)
      return { ok: false, code: 'feature_disabled' }
    }
    const policy = this.guardrailService().evaluatePolicy({ policyId, action: actionId, scope: 'group' }, { actorJid, resourceJid: groupJid, correlationId, metadata: { actionId } })
    if (!policy.allowed) {
      this.audit('governance.authorization.denied', actorJid, groupJid, 'denied', { actionId, code: 'policy_denied' }, correlationId)
      return { ok: false, code: 'policy_denied' }
    }
    const rate = this.guardrailService().consumeRate(RATE_PROFILE_ID, hashText(groupJid), { actorJid, resourceJid: groupJid, correlationId })
    if (!rate.allowed) {
      this.audit('governance.authorization.denied', actorJid, groupJid, 'limited', { actionId, code: 'rate_limited' }, correlationId)
      return { ok: false, code: 'rate_limited' }
    }
    let metadata: WhatsAppGroupMetadata
    try {
      metadata = await whatsapp.getGroupMetadata(groupJid)
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'governance role check unavailable')
      this.audit('governance.authorization.failed', actorJid, groupJid, 'failed', { actionId, code: 'role_check_unavailable' }, correlationId)
      return { ok: false, code: 'role_check_unavailable' }
    }
    if (!isAdmin(metadata, actorJid)) {
      this.audit('governance.authorization.denied', actorJid, groupJid, 'denied', { actionId, code: 'actor_not_admin' }, correlationId)
      return { ok: false, code: 'actor_not_admin' }
    }
    const botJid = whatsapp.userJid
    if (botJid && !isAdmin(metadata, botJid)) {
      this.audit('governance.authorization.denied', actorJid, groupJid, 'denied', { actionId, code: 'bot_not_admin' }, correlationId)
      return { ok: false, code: 'bot_not_admin' }
    }
    return { ok: true }
  }

  private failOperation(operationId: string, pending: PendingOperation, code: GovernanceOutcomeCode): GovernanceMutationResult {
    this.pending.delete(operationId)
    const failed = this.updateOperation(operationId, 'failed', code, this.clock())
    this.audit('governance.operation.failed', pending.actorJid, pending.groupJid, code === 'capability_unavailable' ? 'failed' : 'failed', { operationRefHash: hashText(operationId), operationType: pending.operationType, code })
    return { kind: 'denied', code, ...(failed ? { record: failed } : {}) }
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS group_governance_settings (
        group_jid TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        updated_by_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS governance_retcons (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        target TEXT NOT NULL,
        replacement TEXT NOT NULL,
        rationale TEXT NOT NULL,
        source_ref_hash TEXT,
        status TEXT NOT NULL CHECK (status IN ('draft', 'proposed', 'approved', 'rejected')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        created_by_hash TEXT NOT NULL,
        decided_by_hash TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_governance_retcons_group_time ON governance_retcons (group_jid, updated_at DESC);
      CREATE TABLE IF NOT EXISTS governance_retcon_history (
        history_id INTEGER PRIMARY KEY AUTOINCREMENT,
        retcon_id TEXT NOT NULL,
        group_jid TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        replacement TEXT NOT NULL,
        rationale TEXT NOT NULL,
        revision INTEGER NOT NULL,
        actor_hash TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_governance_retcon_history_lookup ON governance_retcon_history (group_jid, retcon_id, revision DESC);
      CREATE TABLE IF NOT EXISTS governance_handoffs (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        scope TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('offered', 'claimed', 'declined', 'expired', 'closed')),
        offered_by_hash TEXT NOT NULL,
        claimant_hash TEXT,
        evidence_count INTEGER NOT NULL CHECK (evidence_count BETWEEN 0 AND 5),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_governance_handoffs_group_time ON governance_handoffs (group_jid, updated_at DESC);
      CREATE TABLE IF NOT EXISTS governance_join_requests (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        requester_jid TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approving', 'approved', 'rejected')),
        revision INTEGER NOT NULL CHECK (revision >= 1),
        requested_at INTEGER NOT NULL,
        decided_by_hash TEXT,
        decided_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_governance_join_request_group_requester_pending ON governance_join_requests (group_jid, requester_jid, status);
      CREATE INDEX IF NOT EXISTS idx_governance_join_requests_group_time ON governance_join_requests (group_jid, requested_at DESC);
      CREATE TABLE IF NOT EXISTS governance_operations (
        operation_id TEXT PRIMARY KEY,
        group_hash TEXT NOT NULL,
        actor_hash TEXT NOT NULL,
        operation_type TEXT NOT NULL CHECK (operation_type IN ('join_approve', 'join_reject', 'invite_revoke')),
        target_hash TEXT NOT NULL,
        request_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'succeeded', 'failed', 'expired')),
        correlation_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        outcome_code TEXT NOT NULL,
        UNIQUE (group_hash, correlation_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_governance_operations_group_time ON governance_operations (group_hash, created_at DESC);
      CREATE TABLE IF NOT EXISTS governance_invite_confirmations (
        confirmation_id TEXT PRIMARY KEY,
        group_hash TEXT NOT NULL,
        actor_hash TEXT NOT NULL,
        confirmation_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'used')),
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_governance_invite_confirmations_lookup ON governance_invite_confirmations (group_hash, actor_hash, confirmation_hash, status);
    `)
  }

  private expireStaleState(now: number): void {
    this.database().prepare("UPDATE governance_handoffs SET status = 'expired', updated_at = ? WHERE status = 'offered' AND expires_at <= ?").run(now, now)
    this.database().prepare("UPDATE governance_operations SET status = 'expired', outcome_code = 'recovery_required', updated_at = ? WHERE status IN ('planned', 'running') AND expires_at <= ?").run(now, now)
    this.database().prepare("DELETE FROM governance_invite_confirmations WHERE status = 'pending' AND expires_at <= ?").run(now)
  }

  private claimOperation(operationId: string, now: number): GovernanceOperationRecord | undefined {
    const result = this.database().prepare("UPDATE governance_operations SET status = 'running', updated_at = ? WHERE operation_id = ? AND status = 'planned' AND expires_at > ?").run(now, operationId, now)
    return result.changes === 1 ? this.getOperation(operationId) : undefined
  }

  private updateOperation(operationId: string, status: GovernanceOperationStatus, outcomeCode: GovernanceOutcomeCode, now: number): GovernanceOperationRecord | undefined {
    this.database().prepare('UPDATE governance_operations SET status = ?, outcome_code = ?, updated_at = ? WHERE operation_id = ? AND status = \'running\'').run(status, outcomeCode, now, operationId)
    return this.getOperation(operationId)
  }

  private expireOperation(operationId: string, now: number): GovernanceOperationRecord | undefined {
    this.database().prepare("UPDATE governance_operations SET status = 'expired', outcome_code = 'recovery_required', updated_at = ? WHERE operation_id = ? AND status = 'planned'").run(now, operationId)
    return this.getOperation(operationId)
  }

  private appendRetconHistory(id: string, groupJid: string, action: string, target: string, replacement: string, rationale: string, revision: number, actorJid: string, at: number): void {
    this.database().prepare('INSERT INTO governance_retcon_history (retcon_id, group_jid, action, target, replacement, rationale, revision, actor_hash, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, groupJid, action, target, replacement, rationale, revision, hashText(actorJid), at)
  }

  private audit(eventType: string, actorJid: string, resourceJid: string, outcome: 'allowed' | 'denied' | 'changed' | 'failed' | 'limited' | 'opened' | 'closed', metadata: Record<string, string | number | boolean>, correlationId?: string): void {
    try {
      this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), actorJid, resourceJid, outcome, correlationId, metadata })
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'group governance audit unavailable')
    }
  }

  private transaction<T>(operation: () => T): T {
    return this.database().transaction(operation)()
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('Group governance service is not initialized')
    return this.db
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('Group governance guardrails are not initialized')
    return this.guardrails
  }
}

function mapRetcon(row: RetconRow): RetconRecord {
  return { id: row.id, groupJid: row.group_jid, target: row.target, replacement: row.replacement, rationale: row.rationale, ...(row.source_ref_hash ? { sourceRefHash: row.source_ref_hash } : {}), status: row.status, revision: row.revision, createdByHash: row.created_by_hash, ...(row.decided_by_hash ? { decidedByHash: row.decided_by_hash } : {}), createdAt: row.created_at, updatedAt: row.updated_at }
}

function mapHandoff(row: HandoffRow): HandoffRecord {
  return { id: row.id, groupJid: row.group_jid, scope: row.scope, status: row.status, offeredByHash: row.offered_by_hash, ...(row.claimant_hash ? { claimantHash: row.claimant_hash } : {}), evidenceCount: row.evidence_count, revision: row.revision, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at }
}

function mapJoinRequest(row: JoinRequestRow): JoinRequestRecord {
  return { id: row.id, groupJid: row.group_jid, requesterRefHash: hashText(row.requester_jid), status: row.status, revision: row.revision, requestedAt: row.requested_at, ...(row.decided_by_hash ? { decidedByHash: row.decided_by_hash } : {}), ...(row.decided_at !== null ? { decidedAt: row.decided_at } : {}) }
}

function mapOperation(row: OperationRow): GovernanceOperationRecord {
  return { operationId: row.operation_id, groupHash: row.group_hash, actorHash: row.actor_hash, operationType: row.operation_type, targetHash: row.target_hash, ...(row.request_id ? { requestId: row.request_id } : {}), status: row.status, correlationHash: row.correlation_hash, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at, outcomeCode: row.outcome_code }
}

function isAdmin(metadata: WhatsAppGroupMetadata, jid: string): boolean {
  return metadata.participants.some((participant) => participant.jid === jid && (participant.role === 'admin' || participant.role === 'superadmin'))
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

function validateText(value: string, maxLength: number, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) throw new Error(`${label} is invalid or exceeds the limit`)
}

function normalizeText(value: string, maxLength: number, label: string): string {
  validateText(value, maxLength, label)
  return value.trim().replace(/\s+/g, ' ')
}

function validateLimit(value: number, max: number): void {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`limit must be between 1 and ${max}`)
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}
