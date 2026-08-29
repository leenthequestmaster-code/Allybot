import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import type {
  GroupModerationAction,
  GroupSettingValue,
  Service,
  ServiceContext,
  WhatsAppPort,
  WhatsAppGroupParticipantActionResult,
} from '../framework/contracts.js'
import { runPlatformOperation, type OperationResult } from '../platform/operations.js'
import type { PlatformEventSink } from '../platform/contracts.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'
import { initSqliteDatabase, sha256, validateJid, validateGroupJid as validateGroupJidCommon, type DatabaseInstance } from '../storage-helpers.js'

export type GroupModerationMode = 'dry-run' | 'live'
export type GroupModerationConfiguredMode = 'off' | GroupModerationMode
export type GroupModerationOperationStatus = 'planned' | 'running' | 'dry-run' | 'succeeded' | 'failed' | 'expired'
export type GroupModerationOperationOutcome =
  | 'planned'
  | 'duplicate'
  | 'in_progress'
  | 'feature_disabled'
  | 'policy_denied'
  | 'rate_limited'
  | 'actor_not_admin'
  | 'bot_not_admin'
  | 'role_check_unavailable'
  | 'capability_unavailable'
  | 'transport_timeout'
  | 'transport_failed'
  | 'partial'
  | 'ok'
  | 'recovery_required'

export interface GroupModerationActionRequest {
  readonly groupJid: string
  readonly actorJid: string
  readonly botJid: string
  readonly correlationId: string
  readonly mode: GroupModerationMode
  readonly action?: GroupModerationAction
  readonly targetJids?: readonly string[]
  readonly setting?: GroupSettingValue
}

export interface GroupModerationOperationRecord {
  readonly operationId: string
  readonly groupHash: string
  readonly actorHash: string
  readonly action?: GroupModerationAction
  readonly targetHash?: string
  readonly targetCount: number
  readonly setting?: GroupSettingValue
  readonly mode: GroupModerationMode
  readonly status: GroupModerationOperationStatus
  readonly correlationHash: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt: number
  readonly outcomeCode: GroupModerationOperationOutcome
}

export interface GroupModerationSettingsRecord {
  readonly groupJid: string
  readonly mode: GroupModerationConfiguredMode
  readonly updatedByHash: string
  readonly updatedAt: number
}

export type GroupModerationPlanResult =
  | { readonly kind: 'planned'; readonly record: GroupModerationOperationRecord }
  | { readonly kind: 'duplicate'; readonly record: GroupModerationOperationRecord }
  | { readonly kind: 'denied'; readonly code: GroupModerationOperationOutcome }

export type GroupModerationExecutionResult =
  | { readonly kind: 'completed'; readonly record: GroupModerationOperationRecord; readonly participantResults?: readonly WhatsAppGroupParticipantActionResult[] }
  | { readonly kind: 'denied'; readonly code: GroupModerationOperationOutcome; readonly record?: GroupModerationOperationRecord }

interface OperationRow {
  operation_id: string
  group_hash: string
  actor_hash: string
  action: GroupModerationAction | null
  target_hash: string | null
  target_count: number
  setting: GroupSettingValue | null
  mode: GroupModerationMode
  status: GroupModerationOperationStatus
  correlation_hash: string
  created_at: number
  updated_at: number
  expires_at: number
  outcome_code: GroupModerationOperationOutcome
}

interface PendingOperation {
  readonly groupJid: string
  readonly actorJid: string
  readonly botJid: string
  readonly targetJids: readonly string[]
  readonly action?: GroupModerationAction
  readonly setting?: GroupSettingValue
}

export interface GroupModerationServiceOptions {
  readonly clock?: () => number
  readonly operationTtlMs?: number
  readonly maxTargetCount?: number
  readonly maxListLimit?: number
  readonly events?: PlatformEventSink
}

const FEATURE_ID = 'group.moderation.actions'
const PARTICIPANT_POLICY_ID = 'group-moderation.participant'
const SETTING_POLICY_ID = 'group-moderation.setting'
const PARTICIPANT_ACTION_ID = 'group-moderation.participant'
const SETTING_ACTION_ID = 'group-moderation.setting'
const RATE_PROFILE_ID = 'group-moderation.actions'
const DEFAULT_OPERATION_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_TARGET_COUNT = 20
const DEFAULT_MAX_LIST_LIMIT = 25

export class GroupModerationService implements Service {
  readonly name = 'group-moderation'
  readonly dependencies = ['platform-guardrails'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly operationTtlMs: number
  private readonly maxTargetCount: number
  private readonly maxListLimit: number
  private readonly events?: PlatformEventSink
  private readonly logger: Logger
  private db: DatabaseInstance | undefined
  private guardrails: PlatformGuardrailService | undefined
  private readonly pending = new Map<string, PendingOperation>()
  private unregisters: Array<() => void> = []

  constructor(databasePath: string, logger: Logger, options: GroupModerationServiceOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.operationTtlMs = options.operationTtlMs ?? DEFAULT_OPERATION_TTL_MS
    this.maxTargetCount = options.maxTargetCount ?? DEFAULT_MAX_TARGET_COUNT
    this.maxListLimit = options.maxListLimit ?? DEFAULT_MAX_LIST_LIMIT
    this.logger = logger.child({ component: 'group-moderation' })
    this.events = options.events ?? {
      emit: async (event) => {
        const payload = event.payload
        this.logger.info({
          platformEvent: event.name,
          operationId: typeof payload.operationId === 'string' ? payload.operationId : undefined,
          attempts: typeof payload.attempts === 'number' ? payload.attempts : undefined,
          reason: typeof payload.reason === 'string' ? payload.reason : undefined,
          policy: typeof payload.policy === 'string' ? payload.policy : undefined,
          error: typeof payload.error === 'string' ? payload.error : undefined,
        }, 'group moderation operation telemetry')
      },
    }
    if (!Number.isInteger(this.operationTtlMs) || this.operationTtlMs < 1) throw new Error('operationTtlMs must be a positive integer')
    if (!Number.isInteger(this.maxTargetCount) || this.maxTargetCount < 1) throw new Error('maxTargetCount must be a positive integer')
    if (!Number.isInteger(this.maxListLimit) || this.maxListLimit < 1) throw new Error('maxListLimit must be a positive integer')
  }

  initialize(context: ServiceContext): void {
    this.guardrails = context.services.get<PlatformGuardrailService>('platform-guardrails')
    this.db = initSqliteDatabase(this.databasePath, { foreignKeys: true })
    this.migrate()
    this.unregisters = [
      this.guardrails.registerPolicy({
        id: PARTICIPANT_POLICY_ID,
        version: 1,
        action: PARTICIPANT_ACTION_ID,
        scope: 'group',
        description: 'R2 participant moderation action policy',
        featureId: FEATURE_ID,
        rateProfileId: RATE_PROFILE_ID,
      }),
      this.guardrails.registerPolicy({
        id: SETTING_POLICY_ID,
        version: 1,
        action: SETTING_ACTION_ID,
        scope: 'group',
        description: 'R2 group setting moderation policy',
        featureId: FEATURE_ID,
        rateProfileId: RATE_PROFILE_ID,
      }),
      this.guardrails.registerAction({
        id: PARTICIPANT_ACTION_ID,
        version: 1,
        description: 'R2 participant add/remove/promote/demote',
        inputSchemaVersion: 1,
        risk: 'high',
        requiredPermission: 'group.admin',
        featureId: FEATURE_ID,
      }),
      this.guardrails.registerAction({
        id: SETTING_ACTION_ID,
        version: 1,
        description: 'R2 group announcement/locked settings',
        inputSchemaVersion: 1,
        risk: 'high',
        requiredPermission: 'group.admin',
        featureId: FEATURE_ID,
      }),
      this.guardrails.registerRateProfile({ id: RATE_PROFILE_ID, maxRequests: 10, windowMs: 60_000 }),
    ]
    this.expireStaleOperations(this.clock())
    this.logger.info('group moderation storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    for (const unregister of this.unregisters.splice(0)) unregister()
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
    this.pending.clear()
  }

  getMode(groupJid: string): GroupModerationSettingsRecord {
    validateGroupJid(groupJid)
    const row = this.database().prepare(`SELECT group_jid, mode, updated_by_hash, updated_at FROM group_moderation_settings WHERE group_jid = ?`).get(groupJid) as { group_jid: string; mode: GroupModerationConfiguredMode; updated_by_hash: string; updated_at: number } | undefined
    return row
      ? { groupJid: row.group_jid, mode: row.mode, updatedByHash: row.updated_by_hash, updatedAt: row.updated_at }
      : { groupJid, mode: 'off', updatedByHash: '', updatedAt: 0 }
  }

  isFeatureEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().isFeatureEnabled(groupJid, FEATURE_ID)
  }

  setMode(groupJid: string, mode: GroupModerationConfiguredMode, actorJid: string, now = this.clock()): GroupModerationSettingsRecord {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'moderation mode actor')
    if (!['off', 'dry-run', 'live'].includes(mode)) throw new Error('Invalid moderation configured mode')
    this.guardrailService().setFeatureFlag(groupJid, FEATURE_ID, mode !== 'off', actorJid, `moderation-mode-${now}`, now)
    return this.transaction(() => {
      this.database().prepare(`
        INSERT INTO group_moderation_settings (group_jid, mode, updated_by_hash, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(group_jid) DO UPDATE SET mode = excluded.mode, updated_by_hash = excluded.updated_by_hash, updated_at = excluded.updated_at
      `).run(groupJid, mode, hashText(actorJid), now)
      return this.getMode(groupJid)
    })
  }

  async planAction(request: GroupModerationActionRequest, whatsapp: WhatsAppPort, now = this.clock()): Promise<GroupModerationPlanResult> {
    validateRequest(request, this.maxTargetCount)
    const isParticipant = request.action !== undefined
    const policyId = isParticipant ? PARTICIPANT_POLICY_ID : SETTING_POLICY_ID
    const actionId = isParticipant ? PARTICIPANT_ACTION_ID : SETTING_ACTION_ID
    const correlationHash = hashText(request.correlationId)

    const configuredMode = this.getMode(request.groupJid).mode
    if (configuredMode === 'off' || !this.isFeatureEnabled(request.groupJid)) {
      this.audit('group.moderation.plan.denied', request.actorJid, request.groupJid, 'denied', { actionId, code: 'feature_disabled' }, request.correlationId)
      return { kind: 'denied', code: 'feature_disabled' }
    }
    if (configuredMode !== request.mode) {
      this.audit('group.moderation.plan.denied', request.actorJid, request.groupJid, 'denied', { actionId, code: 'policy_denied' }, request.correlationId)
      return { kind: 'denied', code: 'policy_denied' }
    }

    const policy = this.guardrailService().evaluatePolicy(
      { policyId, action: actionId, scope: 'group' },
      { actorJid: request.actorJid, resourceJid: request.groupJid, correlationId: request.correlationId, metadata: { actionId, mode: request.mode } },
    )
    if (!policy.allowed) {
      this.audit('group.moderation.plan.denied', request.actorJid, request.groupJid, 'denied', { actionId, code: 'policy_denied' }, request.correlationId)
      return { kind: 'denied', code: 'policy_denied' }
    }

    const rate = this.guardrailService().consumeRate(RATE_PROFILE_ID, hashText(request.groupJid), { actorJid: request.actorJid, resourceJid: request.groupJid, correlationId: request.correlationId }, now)
    if (!rate.allowed) {
      this.audit('group.moderation.plan.denied', request.actorJid, request.groupJid, 'limited', { actionId, code: 'rate_limited' }, request.correlationId)
      return { kind: 'denied', code: 'rate_limited' }
    }

    let metadata
    try {
      metadata = await whatsapp.getGroupMetadata(request.groupJid)
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'group moderation role check unavailable')
      this.audit('group.moderation.plan.denied', request.actorJid, request.groupJid, 'failed', { actionId, code: 'role_check_unavailable' }, request.correlationId)
      return { kind: 'denied', code: 'role_check_unavailable' }
    }
    if (!isAdmin(metadata, request.actorJid)) {
      this.audit('group.moderation.plan.denied', request.actorJid, request.groupJid, 'denied', { actionId, code: 'actor_not_admin' }, request.correlationId)
      return { kind: 'denied', code: 'actor_not_admin' }
    }
    if (!isAdmin(metadata, request.botJid)) {
      this.audit('group.moderation.plan.denied', request.actorJid, request.groupJid, 'denied', { actionId, code: 'bot_not_admin' }, request.correlationId)
      return { kind: 'denied', code: 'bot_not_admin' }
    }

    const duplicate = this.findByCorrelation(request.groupJid, correlationHash)
    if (duplicate) {
      this.audit('group.moderation.plan.duplicate', request.actorJid, request.groupJid, 'denied', { actionId, code: 'duplicate' }, request.correlationId)
      return { kind: 'duplicate', record: duplicate }
    }

    const operationId = randomUUID()
    const record = this.transaction(() => {
      this.database().prepare(`
        INSERT OR IGNORE INTO group_moderation_operations
          (operation_id, group_hash, actor_hash, action, target_hash, target_count, setting, mode, status, correlation_hash, created_at, updated_at, expires_at, outcome_code)
        VALUES (@operation_id, @group_hash, @actor_hash, @action, @target_hash, @target_count, @setting, @mode, 'planned', @correlation_hash, @created_at, @updated_at, @expires_at, 'planned')
      `).run({
        operation_id: operationId,
        group_hash: hashText(request.groupJid),
        actor_hash: hashText(request.actorJid),
        action: request.action ?? null,
        target_hash: request.targetJids ? hashText(request.targetJids.join('|')) : null,
        target_count: request.targetJids?.length ?? 0,
        setting: request.setting ?? null,
        mode: request.mode,
        correlation_hash: correlationHash,
        created_at: now,
        updated_at: now,
        expires_at: now + this.operationTtlMs,
      })
      const inserted = this.getOperation(operationId)
      if (inserted) return inserted
      return this.findByCorrelation(request.groupJid, correlationHash)
    })

    if (!record) throw new Error('Moderation operation insert failed')
    if (record.operationId !== operationId) return { kind: 'duplicate', record }
    this.pending.set(operationId, {
      groupJid: request.groupJid,
      actorJid: request.actorJid,
      botJid: request.botJid,
      targetJids: [...(request.targetJids ?? [])],
      ...(request.action ? { action: request.action } : {}),
      ...(request.setting ? { setting: request.setting } : {}),
    })
    this.audit('group.moderation.plan.created', request.actorJid, request.groupJid, 'allowed', { actionId, mode: request.mode, operationId, targetCount: record.targetCount }, request.correlationId)
    return { kind: 'planned', record }
  }

  async executeAction(operationId: string, whatsapp: WhatsAppPort, now = this.clock()): Promise<GroupModerationExecutionResult> {
    validateOperationId(operationId)
    const current = this.getOperation(operationId)
    if (!current) return { kind: 'denied', code: 'recovery_required' }
    if (current.status === 'succeeded' || current.status === 'dry-run') return { kind: 'completed', record: current }
    if (current.status === 'running') return { kind: 'denied', code: 'in_progress', record: current }
    if (current.status !== 'planned') return { kind: 'denied', code: current.outcomeCode, record: current }
    if (current.expiresAt <= now) {
      const expired = this.expireOperation(operationId, now)
      return { kind: 'denied', code: 'recovery_required', ...(expired ? { record: expired } : {}) }
    }

    const pending = this.pending.get(operationId)
    if (!pending) {
      const recovered = this.updateOperation(operationId, 'failed', 'recovery_required', now)
      return { kind: 'denied', code: 'recovery_required', ...(recovered ? { record: recovered } : {}) }
    }

    const running = this.claimOperation(operationId, now)
    if (!running) {
      const latest = this.getOperation(operationId)
      if (latest?.status === 'running') return { kind: 'denied', code: 'in_progress', record: latest }
      if (latest?.status === 'succeeded' || latest?.status === 'dry-run') return { kind: 'completed', record: latest }
      return { kind: 'denied', code: latest?.outcomeCode ?? 'recovery_required', ...(latest ? { record: latest } : {}) }
    }
    if (running.mode === 'dry-run') {
      const dryRun = this.updateOperation(operationId, 'dry-run', 'planned', now)
      this.pending.delete(operationId)
      this.audit('group.moderation.dry_run', pending.actorJid, pending.groupJid, 'changed', { operationId, action: pending.action ?? 'setting', targetCount: pending.targetJids.length }, operationId)
      return { kind: 'completed', record: dryRun ?? running }
    }

    let metadata
    try {
      metadata = await whatsapp.getGroupMetadata(pending.groupJid)
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'group moderation execution role check unavailable')
      const failed = this.updateOperation(operationId, 'failed', 'role_check_unavailable', this.clock())
      this.pending.delete(operationId)
      return { kind: 'denied', code: 'role_check_unavailable', ...(failed ? { record: failed } : {}) }
    }
    if (!isAdmin(metadata, pending.actorJid)) {
      const failed = this.updateOperation(operationId, 'failed', 'actor_not_admin', this.clock())
      this.pending.delete(operationId)
      return { kind: 'denied', code: 'actor_not_admin', ...(failed ? { record: failed } : {}) }
    }
    if (!isAdmin(metadata, pending.botJid)) {
      const failed = this.updateOperation(operationId, 'failed', 'bot_not_admin', this.clock())
      this.pending.delete(operationId)
      return { kind: 'denied', code: 'bot_not_admin', ...(failed ? { record: failed } : {}) }
    }

    const capability = pending.action ? whatsapp.groupParticipantsUpdate : whatsapp.groupSettingUpdate
    if (!capability) {
      const failed = this.updateOperation(operationId, 'failed', 'capability_unavailable', now)
      this.pending.delete(operationId)
      this.audit('group.moderation.execute.failed', pending.actorJid, pending.groupJid, 'failed', { operationId, code: 'capability_unavailable' }, operationId)
      return { kind: 'denied', code: 'capability_unavailable', ...(failed ? { record: failed } : {}) }
    }

    let result: OperationResult<readonly WhatsAppGroupParticipantActionResult[] | void>
    if (pending.action) {
      result = await runPlatformOperation<readonly WhatsAppGroupParticipantActionResult[]>({
        operationId: `group-moderation-${operationId}`,
        timeoutMs: 20_000,
        events: this.events,
        retry: { maxAttempts: 1 },
        execute: () => whatsapp.groupParticipantsUpdate!(pending.groupJid, pending.targetJids, pending.action!),
      })
    } else {
      result = await runPlatformOperation<void>({
        operationId: `group-moderation-${operationId}`,
        timeoutMs: 20_000,
        events: this.events,
        retry: { maxAttempts: 1 },
        execute: () => whatsapp.groupSettingUpdate!(pending.groupJid, pending.setting!),
      })
    }
    this.pending.delete(operationId)

    if (!result.ok) {
      const code: GroupModerationOperationOutcome = isTimeout(result.error) ? 'transport_timeout' : 'transport_failed'
      const failed = this.updateOperation(operationId, 'failed', code, this.clock())
      this.audit('group.moderation.execute.failed', pending.actorJid, pending.groupJid, 'failed', { operationId, code }, operationId)
      return { kind: 'denied', code, ...(failed ? { record: failed } : {}) }
    }

    const participantResults = pending.action ? result.value as readonly WhatsAppGroupParticipantActionResult[] : undefined
    const outcomeCode: GroupModerationOperationOutcome = participantResults && participantResults.some((item) => item.status !== 'ok')
      ? participantResults.some((item) => item.status === 'ok') ? 'partial' : 'transport_failed'
      : 'ok'
    const status: GroupModerationOperationStatus = outcomeCode === 'ok' ? 'succeeded' : 'failed'
    const completed = this.updateOperation(operationId, status, outcomeCode, this.clock())
    this.audit('group.moderation.execute.completed', pending.actorJid, pending.groupJid, status === 'succeeded' ? 'changed' : 'failed', { operationId, code: outcomeCode, targetCount: pending.targetJids.length }, operationId)
    if (!completed) return { kind: 'denied', code: 'recovery_required' }
    if (status === 'failed') return { kind: 'denied', code: outcomeCode, record: completed }
    return { kind: 'completed', record: completed, ...(participantResults ? { participantResults } : {}) }
  }

  getOperation(operationId: string): GroupModerationOperationRecord | undefined {
    validateOperationId(operationId)
    const row = this.database().prepare(`SELECT * FROM group_moderation_operations WHERE operation_id = ?`).get(operationId) as OperationRow | undefined
    return row ? mapOperation(row) : undefined
  }

  listOperations(groupJid: string, status?: GroupModerationOperationStatus, limit = this.maxListLimit): readonly GroupModerationOperationRecord[] {
    validateGroupJid(groupJid)
    if (status !== undefined && !isOperationStatus(status)) throw new Error('Invalid moderation operation status')
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxListLimit) throw new Error(`List limit must be between 1 and ${this.maxListLimit}`)
    const rows = this.database().prepare(`
      SELECT * FROM group_moderation_operations
      WHERE group_hash = ? AND (? IS NULL OR status = ?)
      ORDER BY created_at DESC, operation_id DESC LIMIT ?
    `).all(hashText(groupJid), status ?? null, status ?? null, limit) as OperationRow[]
    return rows.map(mapOperation)
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS group_moderation_settings (
        group_jid TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('off', 'dry-run', 'live')),
        updated_by_hash TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_moderation_operations (
        operation_id TEXT PRIMARY KEY,
        group_hash TEXT NOT NULL,
        actor_hash TEXT NOT NULL,
        action TEXT,
        target_hash TEXT,
        target_count INTEGER NOT NULL CHECK (target_count >= 0 AND target_count <= 20),
        setting TEXT,
        mode TEXT NOT NULL CHECK (mode IN ('dry-run', 'live')),
        status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'dry-run', 'succeeded', 'failed', 'expired')),
        correlation_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        outcome_code TEXT NOT NULL,
        UNIQUE (group_hash, correlation_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_group_moderation_operations_group_time
        ON group_moderation_operations (group_hash, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_group_moderation_operations_status
        ON group_moderation_operations (group_hash, status, created_at DESC);
    `)
  }

  private expireStaleOperations(now: number): void {
    this.database().prepare(`UPDATE group_moderation_operations SET status = 'expired', outcome_code = 'recovery_required', updated_at = ? WHERE status IN ('planned', 'running') AND expires_at <= ?`).run(now, now)
  }

  private claimOperation(operationId: string, now: number): GroupModerationOperationRecord | undefined {
    const result = this.database().prepare(`UPDATE group_moderation_operations SET status = 'running', outcome_code = 'planned', updated_at = ? WHERE operation_id = ? AND status = 'planned' AND expires_at > ?`).run(now, operationId, now)
    return result.changes === 1 ? this.getOperation(operationId) : undefined
  }

  private updateOperation(operationId: string, status: GroupModerationOperationStatus, outcomeCode: GroupModerationOperationOutcome, now: number): GroupModerationOperationRecord | undefined {
    this.database().prepare(`UPDATE group_moderation_operations SET status = ?, outcome_code = ?, updated_at = ? WHERE operation_id = ? AND status = 'running'`).run(status, outcomeCode, now, operationId)
    return this.getOperation(operationId)
  }

  private expireOperation(operationId: string, now: number): GroupModerationOperationRecord | undefined {
    this.database().prepare(`UPDATE group_moderation_operations SET status = 'expired', outcome_code = 'recovery_required', updated_at = ? WHERE operation_id = ? AND status = 'planned'`).run(now, operationId)
    return this.getOperation(operationId)
  }

  private findByCorrelation(groupJid: string, correlationHash: string): GroupModerationOperationRecord | undefined {
    const row = this.database().prepare(`SELECT * FROM group_moderation_operations WHERE group_hash = ? AND correlation_hash = ?`).get(hashText(groupJid), correlationHash) as OperationRow | undefined
    return row ? mapOperation(row) : undefined
  }

  private audit(eventType: string, actorJid: string, resourceJid: string, outcome: 'allowed' | 'denied' | 'changed' | 'failed' | 'limited', metadata: Record<string, string | number | boolean>, correlationId?: string): void {
    try {
      this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), actorJid, resourceJid, outcome, correlationId, metadata })
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'group moderation audit unavailable')
    }
  }

  private transaction<T>(operation: () => T): T {
    return this.database().transaction(operation)()
  }

  private database(): DatabaseInstance {
    if (!this.db?.open) throw new Error('Group moderation service is not initialized')
    return this.db
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('Platform guardrails service is not initialized')
    return this.guardrails
  }
}

function mapOperation(row: OperationRow): GroupModerationOperationRecord {
  return {
    operationId: row.operation_id,
    groupHash: row.group_hash,
    actorHash: row.actor_hash,
    ...(row.action ? { action: row.action } : {}),
    ...(row.target_hash ? { targetHash: row.target_hash } : {}),
    targetCount: row.target_count,
    ...(row.setting ? { setting: row.setting } : {}),
    mode: row.mode,
    status: row.status,
    correlationHash: row.correlation_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    outcomeCode: row.outcome_code,
  }
}

function validateRequest(request: GroupModerationActionRequest, maxTargetCount: number): void {
  validateGroupJid(request.groupJid)
  validateJid(request.actorJid, 'moderation actor')
  validateJid(request.botJid, 'moderation bot')
  validateCorrelationId(request.correlationId)
  if (!['dry-run', 'live'].includes(request.mode)) throw new Error('Invalid moderation mode')
  const hasAction = request.action !== undefined
  const hasSetting = request.setting !== undefined
  if (hasAction === hasSetting) throw new Error('Moderation request must contain exactly one action or setting')
  if (hasAction) {
    if (!['add', 'remove', 'promote', 'demote'].includes(request.action)) throw new Error('Invalid moderation action')
    if (!request.targetJids || request.targetJids.length < 1 || request.targetJids.length > maxTargetCount) throw new Error('Moderation target count is out of bounds')
    const unique = new Set(request.targetJids)
    if (unique.size !== request.targetJids.length) throw new Error('Moderation targets must be unique')
    for (const target of request.targetJids) validateJid(target, 'moderation target')
  } else if (request.targetJids && request.targetJids.length > 0) {
    throw new Error('Group setting request cannot contain targets')
  }
  if (hasSetting && !['announcement', 'not_announcement', 'locked', 'unlocked'].includes(request.setting)) throw new Error('Invalid group setting')
}

function validateGroupJid(value: string): void {
  try {
    validateGroupJidCommon(value)
  } catch {
    throw new Error('Group moderation requires a group JID')
  }
}

function validateCorrelationId(value: string): void {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(value)) throw new Error('Invalid moderation correlation id')
}

function validateOperationId(value: string): void {
  if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error('Invalid moderation operation id')
}

function isOperationStatus(value: string): value is GroupModerationOperationStatus {
  return ['planned', 'running', 'dry-run', 'succeeded', 'failed', 'expired'].includes(value)
}

const hashText = (value: string): string => sha256(value, 32)

function isAdmin(metadata: { readonly participants: readonly { readonly jid: string; readonly role: string }[] }, jid: string): boolean {
  const bare = jid.split(':')[0]
  return metadata.participants.some((participant) => participant.jid.split(':')[0] === bare && (participant.role === 'admin' || participant.role === 'superadmin'))
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message)
}
