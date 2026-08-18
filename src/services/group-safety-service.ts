import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { isJid } from '../platform/validation.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'

export type GroupSafetyMode = 'off' | 'dry-run'
export type WarningStatus = 'active' | 'revoked' | 'expired'
export type ModerationCaseStatus = 'open' | 'claimed' | 'resolved' | 'dismissed' | 'appealed'

export interface GroupSafetyOptions {
  readonly clock?: () => number
  readonly warningTtlMs?: number
  readonly maxReasonLength?: number
  readonly maxListLimit?: number
}

export interface SafetySettingsRecord {
  readonly groupJid: string
  readonly mode: GroupSafetyMode
  readonly updatedBy: string
  readonly updatedAt: number
}

export interface WarningRecord {
  readonly id: string
  readonly groupJid: string
  readonly targetJid: string
  readonly issuedBy: string
  readonly reason: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly status: WarningStatus
  readonly revokedAt?: number
  readonly revokedBy?: string
  readonly revision: number
}

export interface ModerationCaseRecord {
  readonly id: string
  readonly groupJid: string
  readonly reporterJid: string
  readonly targetJid: string
  readonly ruleId: string
  readonly evidenceMessageId?: string
  readonly evidenceHash?: string
  readonly reason: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly status: ModerationCaseStatus
  readonly assignedTo?: string
  readonly resolutionNote?: string
  readonly revision: number
}

export interface AppealRecord {
  readonly id: string
  readonly caseId: string
  readonly appellantJid: string
  readonly reason: string
  readonly createdAt: number
}

export interface CaseReportResult {
  readonly record: ModerationCaseRecord
  readonly created: boolean
}

interface SettingsRow {
  group_jid: string
  mode: GroupSafetyMode
  updated_by: string
  updated_at: number
}

interface WarningRow {
  id: string
  group_jid: string
  target_jid: string
  issued_by: string
  reason: string
  created_at: number
  expires_at: number
  status: 'active' | 'revoked'
  revoked_at: number | null
  revoked_by: string | null
  revision: number
}

interface CaseRow {
  id: string
  group_jid: string
  reporter_jid: string
  target_jid: string
  rule_id: string
  evidence_message_id: string | null
  evidence_hash: string | null
  reason: string
  created_at: number
  updated_at: number
  status: ModerationCaseStatus
  assigned_to: string | null
  resolution_note: string | null
  revision: number
}

interface AppealRow {
  id: string
  case_id: string
  appellant_jid: string
  reason: string
  created_at: number
}

const DEFAULT_WARNING_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const DEFAULT_MAX_REASON_LENGTH = 240
const DEFAULT_MAX_LIST_LIMIT = 25
const MAX_ID_LENGTH = 64
const MAX_EVIDENCE_MESSAGE_ID_LENGTH = 160
const SECRET_LIKE_REASON = /(bearer\s+|^eyj[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+$|(?:api[_-]?key|token|password)\s*[:=])/i
const ANTI_SPAM_PROFILE_ID = 'group-safety.spam'
const FEATURE_ID = 'group-safety'

export class GroupSafetyService implements Service {
  readonly name = 'group-safety'
  readonly dependencies = ['platform-guardrails'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly warningTtlMs: number
  private readonly maxReasonLength: number
  private readonly maxListLimit: number
  private readonly logger: Logger
  private db: Database.Database | undefined
  private guardrails: PlatformGuardrailService | undefined
  private readonly dryRunCaseWindows = new Map<string, number>()

  constructor(databasePath: string, logger: Logger, options: GroupSafetyOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.warningTtlMs = options.warningTtlMs ?? DEFAULT_WARNING_TTL_MS
    this.maxReasonLength = options.maxReasonLength ?? DEFAULT_MAX_REASON_LENGTH
    this.maxListLimit = options.maxListLimit ?? DEFAULT_MAX_LIST_LIMIT
    this.logger = logger.child({ component: 'group-safety' })
    if (!Number.isInteger(this.warningTtlMs) || this.warningTtlMs < 1) throw new Error('warningTtlMs must be a positive integer')
    if (!Number.isInteger(this.maxReasonLength) || this.maxReasonLength < 1) throw new Error('maxReasonLength must be a positive integer')
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
    this.guardrails.registerRateProfile({ id: ANTI_SPAM_PROFILE_ID, maxRequests: 5, windowMs: 10_000 })
    this.logger.info('group safety storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
    this.dryRunCaseWindows.clear()
  }

  getMode(groupJid: string): SafetySettingsRecord {
    validateGroupJid(groupJid)
    const row = this.database().prepare(`SELECT group_jid, mode, updated_by, updated_at FROM group_safety_settings WHERE group_jid = ?`).get(groupJid) as SettingsRow | undefined
    return row ? mapSettings(row) : { groupJid, mode: 'off', updatedBy: '', updatedAt: 0 }
  }

  isDryRun(groupJid: string): boolean {
    return this.getMode(groupJid).mode === 'dry-run' && this.guardrailService().isFeatureEnabled(groupJid, FEATURE_ID)
  }

  setMode(groupJid: string, mode: GroupSafetyMode, actorJid: string, now = this.clock()): SafetySettingsRecord {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'safety actor')
    if (!['off', 'dry-run'].includes(mode)) throw new Error(`Unsupported group safety mode: ${mode}`)
    this.guardrailService().setFeatureFlag(groupJid, FEATURE_ID, mode === 'dry-run', actorJid, `safety-mode-${now}`, now)
    return this.transaction(() => {
      this.database().prepare(`
        INSERT INTO group_safety_settings (group_jid, mode, updated_by, updated_at)
        VALUES (@group_jid, @mode, @updated_by, @updated_at)
        ON CONFLICT(group_jid) DO UPDATE SET mode = excluded.mode, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run({ group_jid: groupJid, mode, updated_by: actorJid, updated_at: now })
      return this.getMode(groupJid)
    })
  }

  issueWarning(groupJid: string, targetJid: string, issuedBy: string, reason: string, now = this.clock()): WarningRecord {
    validateGroupJid(groupJid)
    validateJid(targetJid, 'warning target')
    validateJid(issuedBy, 'warning issuer')
    const normalizedReason = normalizeReason(reason, this.maxReasonLength)
    const id = randomUUID()
    const expiresAt = now + this.warningTtlMs
    this.audit('group.safety.warning.requested', issuedBy, targetJid, 'allowed', { reasonLength: normalizedReason.length })
    const record = this.transaction(() => {
      this.database().prepare(`
        INSERT INTO group_safety_warnings
          (id, group_jid, target_jid, issued_by, reason, created_at, expires_at, status, revision)
        VALUES (@id, @group_jid, @target_jid, @issued_by, @reason, @created_at, @expires_at, 'active', 0)
      `).run({ id, group_jid: groupJid, target_jid: targetJid, issued_by: issuedBy, reason: normalizedReason, created_at: now, expires_at: expiresAt })
      return this.getWarning(id, now) as WarningRecord
    })
    this.auditBestEffort('group.safety.warning.issued', issuedBy, targetJid, 'changed', { warningId: id })
    return record
  }

  getWarning(id: string, now = this.clock()): WarningRecord | undefined {
    validateId(id, 'warning id')
    const row = this.database().prepare(`SELECT * FROM group_safety_warnings WHERE id = ?`).get(id) as WarningRow | undefined
    return row ? mapWarning(row, now) : undefined
  }

  listWarnings(groupJid: string, targetJid?: string, limit = this.maxListLimit, now = this.clock()): readonly WarningRecord[] {
    validateGroupJid(groupJid)
    if (targetJid !== undefined) validateJid(targetJid, 'warning target')
    const safeLimit = validateLimit(limit, this.maxListLimit)
    const rows = this.database().prepare(`
      SELECT * FROM group_safety_warnings
      WHERE group_jid = ? AND (? IS NULL OR target_jid = ?)
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(groupJid, targetJid ?? null, targetJid ?? null, safeLimit) as WarningRow[]
    return rows.map((row) => mapWarning(row, now))
  }

  revokeWarning(groupJid: string, id: string, revokedBy: string, now = this.clock()): WarningRecord | undefined {
    validateGroupJid(groupJid)
    validateId(id, 'warning id')
    validateJid(revokedBy, 'warning revoker')
    const current = this.getWarning(id, now)
    if (!current || current.groupJid !== groupJid || current.status !== 'active') return undefined
    this.audit('group.safety.warning.revoke.requested', revokedBy, current.targetJid, 'allowed', { warningId: id })
    const result = this.database().prepare(`
      UPDATE group_safety_warnings
      SET status = 'revoked', revoked_at = ?, revoked_by = ?, revision = revision + 1
      WHERE id = ? AND group_jid = ? AND status = 'active' AND revision = ?
    `).run(now, revokedBy, id, groupJid, current.revision)
    if (result.changes !== 1) {
      this.auditBestEffort('group.safety.warning.revoke.failed', revokedBy, current.targetJid, 'failed', { warningId: id })
      return undefined
    }
    this.auditBestEffort('group.safety.warning.revoked', revokedBy, current.targetJid, 'changed', { warningId: id })
    return this.getWarning(id, now)
  }

  countActiveWarnings(groupJid: string, targetJid: string, now = this.clock()): number {
    validateGroupJid(groupJid)
    validateJid(targetJid, 'warning target')
    return (this.database().prepare(`SELECT COUNT(*) AS count FROM group_safety_warnings WHERE group_jid = ? AND target_jid = ? AND status = 'active' AND expires_at > ?`).get(groupJid, targetJid, now) as { count: number }).count
  }

  reportCase(groupJid: string, reporterJid: string, targetJid: string, ruleId: string, reason: string, evidenceMessageId?: string, evidenceText?: string, now = this.clock()): CaseReportResult {
    validateGroupJid(groupJid)
    validateJid(reporterJid, 'case reporter')
    validateJid(targetJid, 'case target')
    validateId(ruleId, 'case rule id')
    const normalizedReason = normalizeReason(reason, this.maxReasonLength)
    const normalizedMessageId = evidenceMessageId === undefined ? undefined : normalizeBounded(evidenceMessageId, MAX_EVIDENCE_MESSAGE_ID_LENGTH, 'evidence message id')
    if (normalizedMessageId !== undefined) {
      const existing = this.findCaseByMessage(groupJid, normalizedMessageId)
      if (existing) return { record: existing, created: false }
    }
    const id = randomUUID()
    this.audit('group.safety.case.report.requested', reporterJid, targetJid, 'allowed', { ruleId, evidence: normalizedMessageId !== undefined })
    const result = this.transaction(() => {
      const inserted = this.database().prepare(`
        INSERT OR IGNORE INTO group_safety_cases
          (id, group_jid, reporter_jid, target_jid, rule_id, evidence_message_id, evidence_hash, reason, created_at, updated_at, status, revision)
        VALUES (@id, @group_jid, @reporter_jid, @target_jid, @rule_id, @evidence_message_id, @evidence_hash, @reason, @created_at, @updated_at, 'open', 0)
      `).run({ id, group_jid: groupJid, reporter_jid: reporterJid, target_jid: targetJid, rule_id: ruleId, evidence_message_id: normalizedMessageId ?? null, evidence_hash: evidenceText === undefined ? null : hashText(evidenceText), reason: normalizedReason, created_at: now, updated_at: now })
      if (inserted.changes === 0 && normalizedMessageId !== undefined) {
        const existing = this.findCaseByMessage(groupJid, normalizedMessageId)
        if (existing) return { record: existing, created: false }
      }
      const record = this.getCase(id)
      if (!record) throw new Error('Case was not persisted')
      return { record, created: true }
    })
    if (result.created) this.auditBestEffort('group.safety.case.reported', reporterJid, targetJid, 'changed', { caseId: result.record.id, ruleId })
    return result
  }

  getCase(id: string): ModerationCaseRecord | undefined {
    validateId(id, 'case id')
    const row = this.database().prepare(`SELECT * FROM group_safety_cases WHERE id = ?`).get(id) as CaseRow | undefined
    return row ? mapCase(row) : undefined
  }

  listCases(groupJid: string, statuses?: readonly ModerationCaseStatus[], limit = this.maxListLimit): readonly ModerationCaseRecord[] {
    validateGroupJid(groupJid)
    const safeLimit = validateLimit(limit, this.maxListLimit)
    if (statuses?.some((status) => !isCaseStatus(status))) throw new Error('Invalid case status filter')
    const rows = this.database().prepare(`
      SELECT * FROM group_safety_cases
      WHERE group_jid = ? AND (? = 0 OR status IN (${statuses?.map(() => '?').join(',') || "''"}))
      ORDER BY updated_at DESC, id DESC LIMIT ?
    `).all(groupJid, statuses?.length ?? 0, ...(statuses ?? []), safeLimit) as CaseRow[]
    return rows.map(mapCase)
  }

  claimCase(groupJid: string, id: string, moderatorJid: string, expectedRevision: number, now = this.clock()): ModerationCaseRecord | undefined {
    validateGroupJid(groupJid)
    validateId(id, 'case id')
    validateJid(moderatorJid, 'case moderator')
    validateRevision(expectedRevision)
    const current = this.requireCase(groupJid, id)
    if (!['open', 'appealed'].includes(current.status)) return undefined
    this.audit('group.safety.case.claim.requested', moderatorJid, current.targetJid, 'allowed', { caseId: id })
    const result = this.database().prepare(`UPDATE group_safety_cases SET status = 'claimed', assigned_to = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND group_jid = ? AND revision = ? AND status IN ('open', 'appealed')`).run(moderatorJid, now, id, groupJid, expectedRevision)
    if (result.changes !== 1) {
      this.auditBestEffort('group.safety.case.claim.failed', moderatorJid, current.targetJid, 'failed', { caseId: id })
      return undefined
    }
    this.auditBestEffort('group.safety.case.claimed', moderatorJid, current.targetJid, 'changed', { caseId: id })
    return this.getCase(id)
  }

  resolveCase(groupJid: string, id: string, moderatorJid: string, note: string, expectedRevision: number, now = this.clock()): ModerationCaseRecord | undefined {
    return this.transitionCase(groupJid, id, moderatorJid, note, expectedRevision, 'resolved', now)
  }

  dismissCase(groupJid: string, id: string, moderatorJid: string, note: string, expectedRevision: number, now = this.clock()): ModerationCaseRecord | undefined {
    return this.transitionCase(groupJid, id, moderatorJid, note, expectedRevision, 'dismissed', now)
  }

  appealCase(groupJid: string, id: string, appellantJid: string, reason: string, now = this.clock()): { record: ModerationCaseRecord; appeal: AppealRecord; created: boolean } | undefined {
    validateGroupJid(groupJid)
    validateId(id, 'case id')
    validateJid(appellantJid, 'appeal appellant')
    const current = this.requireCase(groupJid, id)
    if (current.targetJid !== appellantJid) return undefined
    const existing = this.getAppeal(id, appellantJid)
    if (existing) return { record: current, appeal: existing, created: false }
    if (!['resolved', 'dismissed'].includes(current.status)) return undefined
    const normalizedReason = normalizeReason(reason, this.maxReasonLength)
    const appealId = randomUUID()
    this.audit('group.safety.case.appeal.requested', appellantJid, appellantJid, 'allowed', { caseId: id })
    const result = this.transaction(() => {
      this.database().prepare(`INSERT INTO group_safety_appeals (id, case_id, appellant_jid, reason, created_at) VALUES (?, ?, ?, ?, ?)`).run(appealId, id, appellantJid, normalizedReason, now)
      const updated = this.database().prepare(`UPDATE group_safety_cases SET status = 'appealed', updated_at = ?, revision = revision + 1 WHERE id = ? AND group_jid = ? AND revision = ? AND status IN ('resolved', 'dismissed')`).run(now, id, groupJid, current.revision)
      if (updated.changes !== 1) throw new Error('Case changed before appeal')
      return { record: this.getCase(id) as ModerationCaseRecord, appeal: this.getAppeal(id, appellantJid) as AppealRecord, created: true }
    })
    this.auditBestEffort('group.safety.case.appealed', appellantJid, appellantJid, 'changed', { caseId: id })
    return result
  }

  getAppeal(caseId: string, appellantJid: string): AppealRecord | undefined {
    validateId(caseId, 'case id')
    validateJid(appellantJid, 'appeal appellant')
    const row = this.database().prepare(`SELECT * FROM group_safety_appeals WHERE case_id = ? AND appellant_jid = ?`).get(caseId, appellantJid) as AppealRow | undefined
    return row ? mapAppeal(row) : undefined
  }

  consumeAntiSpam(groupJid: string, senderJid: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(senderJid, 'spam sender')
    return this.guardrailService().consumeRate(ANTI_SPAM_PROFILE_ID, hashText(`${groupJid}:${senderJid}`), { actorJid: senderJid, resourceJid: groupJid }, now).allowed
  }

  shouldCreateDryRunCase(groupJid: string, targetJid: string, ruleId: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(targetJid, 'dry-run target')
    validateId(ruleId, 'dry-run rule id')
    const key = hashText(`${groupJid}:${targetJid}:${ruleId}`)
    const last = this.dryRunCaseWindows.get(key)
    if (last !== undefined && now - last < 10_000) return false
    if (this.dryRunCaseWindows.size >= 1_024) {
      const oldest = this.dryRunCaseWindows.keys().next().value
      if (oldest) this.dryRunCaseWindows.delete(oldest)
    }
    this.dryRunCaseWindows.set(key, now)
    return true
  }

  private transitionCase(groupJid: string, id: string, moderatorJid: string, note: string, expectedRevision: number, status: 'resolved' | 'dismissed', now: number): ModerationCaseRecord | undefined {
    validateGroupJid(groupJid)
    validateId(id, 'case id')
    validateJid(moderatorJid, 'case moderator')
    validateRevision(expectedRevision)
    const normalizedNote = normalizeReason(note, this.maxReasonLength)
    const current = this.requireCase(groupJid, id)
    if (!['open', 'claimed', 'appealed'].includes(current.status)) return undefined
    this.audit(`group.safety.case.${status}.requested`, moderatorJid, current.targetJid, 'allowed', { caseId: id })
    const result = this.database().prepare(`UPDATE group_safety_cases SET status = ?, assigned_to = COALESCE(assigned_to, ?), resolution_note = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND group_jid = ? AND revision = ? AND status IN ('open', 'claimed', 'appealed')`).run(status, moderatorJid, normalizedNote, now, id, groupJid, expectedRevision)
    if (result.changes !== 1) {
      this.auditBestEffort(`group.safety.case.${status}.failed`, moderatorJid, current.targetJid, 'failed', { caseId: id })
      return undefined
    }
    this.auditBestEffort(`group.safety.case.${status}`, moderatorJid, current.targetJid, 'changed', { caseId: id })
    return this.getCase(id)
  }

  private requireCase(groupJid: string, id: string): ModerationCaseRecord {
    const record = this.getCase(id)
    if (!record || record.groupJid !== groupJid) throw new Error('Moderation case not found in group')
    return record
  }

  private findCaseByMessage(groupJid: string, messageId: string): ModerationCaseRecord | undefined {
    const row = this.database().prepare(`SELECT * FROM group_safety_cases WHERE group_jid = ? AND evidence_message_id = ?`).get(groupJid, messageId) as CaseRow | undefined
    return row ? mapCase(row) : undefined
  }

  private audit(eventType: string, actorJid: string, resourceJid: string, outcome: 'changed' | 'failed' | 'allowed' | 'denied', metadata: Record<string, unknown>): void {
    this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), actorJid, resourceJid, outcome, metadata })
  }

  private auditBestEffort(eventType: string, actorJid: string, resourceJid: string, outcome: 'changed' | 'failed', metadata: Record<string, unknown>): void {
    try {
      this.audit(eventType, actorJid, resourceJid, outcome, metadata)
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError', eventType }, 'group safety completion audit unavailable')
    }
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS group_safety_settings (
        group_jid TEXT PRIMARY KEY,
        mode TEXT NOT NULL CHECK (mode IN ('off', 'dry-run')),
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS group_safety_warnings (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        target_jid TEXT NOT NULL,
        issued_by TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        revoked_at INTEGER,
        revoked_by TEXT,
        revision INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_group_safety_warnings_group_target_time ON group_safety_warnings (group_jid, target_jid, created_at);
      CREATE TABLE IF NOT EXISTS group_safety_cases (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        reporter_jid TEXT NOT NULL,
        target_jid TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        evidence_message_id TEXT,
        evidence_hash TEXT,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'claimed', 'resolved', 'dismissed', 'appealed')),
        assigned_to TEXT,
        resolution_note TEXT,
        revision INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_group_safety_cases_message ON group_safety_cases (group_jid, evidence_message_id) WHERE evidence_message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_group_safety_cases_group_status ON group_safety_cases (group_jid, status, updated_at);
      CREATE TABLE IF NOT EXISTS group_safety_appeals (
        id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL REFERENCES group_safety_cases(id),
        appellant_jid TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (case_id, appellant_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_group_safety_appeals_case ON group_safety_appeals (case_id, created_at);
    `)
  }

  private transaction<T>(operation: () => T): T {
    return this.database().transaction(operation)()
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('Group safety service is not initialized')
    return this.db
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('Platform guardrails service is not initialized')
    return this.guardrails
  }
}

function mapSettings(row: SettingsRow): SafetySettingsRecord {
  return { groupJid: row.group_jid, mode: row.mode, updatedBy: row.updated_by, updatedAt: row.updated_at }
}

function mapWarning(row: WarningRow, now: number): WarningRecord {
  const status: WarningStatus = row.status === 'active' && row.expires_at <= now ? 'expired' : row.status
  return {
    id: row.id,
    groupJid: row.group_jid,
    targetJid: row.target_jid,
    issuedBy: row.issued_by,
    reason: row.reason,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
    ...(row.revoked_by === null ? {} : { revokedBy: row.revoked_by }),
    revision: row.revision,
  }
}

function mapCase(row: CaseRow): ModerationCaseRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    reporterJid: row.reporter_jid,
    targetJid: row.target_jid,
    ruleId: row.rule_id,
    ...(row.evidence_message_id === null ? {} : { evidenceMessageId: row.evidence_message_id }),
    ...(row.evidence_hash === null ? {} : { evidenceHash: row.evidence_hash }),
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    ...(row.assigned_to === null ? {} : { assignedTo: row.assigned_to }),
    ...(row.resolution_note === null ? {} : { resolutionNote: row.resolution_note }),
    revision: row.revision,
  }
}

function mapAppeal(row: AppealRow): AppealRecord {
  return { id: row.id, caseId: row.case_id, appellantJid: row.appellant_jid, reason: row.reason, createdAt: row.created_at }
}

function validateGroupJid(value: string): void {
  if (!isJid(value) || !value.endsWith('@g.us')) throw new Error('Group safety requires a group JID')
}

function validateJid(value: string, field: string): void {
  if (!isJid(value)) throw new Error(`${field} must be a valid JID`)
}

function validateId(value: string, field: string): void {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(value)) throw new Error(`Invalid ${field}`)
}

function validateRevision(value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new Error('Case revision must be a non-negative integer')
}

function validateLimit(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`List limit must be between 1 and ${max}`)
  return value
}

function normalizeReason(value: string, maxLength: number): string {
  return normalizeBounded(value, maxLength, 'reason').replace(/\s+/g, ' ')
}

function normalizeBounded(value: string, maxLength: number, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.length > maxLength) throw new Error(`${field} is too long`)
  if (SECRET_LIKE_REASON.test(normalized)) throw new Error(`${field} contains sensitive-looking data`)
  return normalized
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function isCaseStatus(value: string): value is ModerationCaseStatus {
  return ['open', 'claimed', 'resolved', 'dismissed', 'appealed'].includes(value)
}
