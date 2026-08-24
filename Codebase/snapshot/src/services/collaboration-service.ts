import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Service, ServiceContext, WhatsAppPort } from '../framework/contracts.js'
import { runPlatformOperation } from '../platform/operations.js'
import { isJid } from '../platform/validation.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'
import { PersonalizationService } from './personalization-service.js'

export type CollaborationPollStatus = 'open' | 'closed' | 'expired'
export type CollaborationTransportStatus = 'text' | 'native-pending' | 'native-sent' | 'native-failed'
export type CollaborationReminderStatus = 'scheduled' | 'sent' | 'cancelled' | 'expired'
export type CollaborationTaskStatus = 'open' | 'done' | 'cancelled'

export interface CollaborationOptions {
  readonly clock?: () => number
  readonly maxTextLength?: number
  readonly maxListLimit?: number
  readonly maxReminderMinutes?: number
  readonly operationTimeoutMs?: number
}

export interface PollRecord {
  readonly id: string
  readonly groupJid: string
  readonly creatorJid: string
  readonly question: string
  readonly options: readonly string[]
  readonly selectableCount: number
  readonly status: CollaborationPollStatus
  readonly transportStatus: CollaborationTransportStatus
  readonly createdAt: number
  readonly expiresAt: number
  readonly closedAt?: number
  readonly revision: number
}

export interface PollVoteRecord {
  readonly pollId: string
  readonly voterJid: string
  readonly optionIndex: number
  readonly createdAt: number
}

export interface ReminderRecord {
  readonly id: string
  readonly groupJid: string
  readonly creatorJid: string
  readonly text: string
  readonly dueAt: number
  readonly status: CollaborationReminderStatus
  readonly createdAt: number
  readonly sentAt?: number
  readonly cancelledAt?: number
}

export interface TaskRecord {
  readonly id: string
  readonly groupJid: string
  readonly creatorJid: string
  readonly assigneeJid?: string
  readonly text: string
  readonly status: CollaborationTaskStatus
  readonly createdAt: number
  readonly completedAt?: number
  readonly completedBy?: string
}

export interface DecisionRecord {
  readonly id: string
  readonly groupJid: string
  readonly creatorJid: string
  readonly text: string
  readonly createdAt: number
}

interface PollRow {
  id: string
  group_jid: string
  creator_jid: string
  question: string
  options_json: string
  selectable_count: number
  status: CollaborationPollStatus
  transport_status: CollaborationTransportStatus
  created_at: number
  expires_at: number
  closed_at: number | null
  revision: number
}

interface ReminderRow {
  id: string
  group_jid: string
  creator_jid: string
  text: string
  due_at: number
  status: CollaborationReminderStatus
  created_at: number
  sent_at: number | null
  cancelled_at: number | null
}

interface TaskRow {
  id: string
  group_jid: string
  creator_jid: string
  assignee_jid: string | null
  text: string
  status: CollaborationTaskStatus
  created_at: number
  completed_at: number | null
  completed_by: string | null
}

interface DecisionRow {
  id: string
  group_jid: string
  creator_jid: string
  text: string
  created_at: number
}

interface VoteRow {
  poll_id: string
  voter_jid: string
  option_index: number
  created_at: number
}

const FEATURE_ID = 'group-collaboration'
const NATIVE_POLL_FEATURE_ID = 'group-collaboration-nativepoll'
const RATE_PROFILE_ID = 'group-collaboration.commands'
const DEFAULT_MAX_TEXT_LENGTH = 240
const DEFAULT_MAX_LIST_LIMIT = 25
const DEFAULT_MAX_REMINDER_MINUTES = 30 * 24 * 60
const POLL_TTL_MS = 24 * 60 * 60 * 1_000

export class CollaborationService implements Service {
  readonly name = 'collaboration'
  readonly dependencies = ['platform-guardrails'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly maxTextLength: number
  private readonly maxListLimit: number
  private readonly maxReminderMinutes: number
  private readonly operationTimeoutMs: number
  private readonly logger: Logger
  private db: Database.Database | undefined
  private guardrails: PlatformGuardrailService | undefined
  private personalization: PersonalizationService | undefined
  private readonly reminderPolicyAuditKeys = new Set<string>()
  private reminderTimer: NodeJS.Timeout | undefined
  private reminderTransport: WhatsAppPort | undefined

  constructor(databasePath: string, logger: Logger, options: CollaborationOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH
    this.maxListLimit = options.maxListLimit ?? DEFAULT_MAX_LIST_LIMIT
    this.maxReminderMinutes = options.maxReminderMinutes ?? DEFAULT_MAX_REMINDER_MINUTES
    this.operationTimeoutMs = options.operationTimeoutMs ?? 20_000
    this.logger = logger.child({ component: 'collaboration' })
    if (!Number.isInteger(this.maxTextLength) || this.maxTextLength < 1) throw new Error('maxTextLength must be a positive integer')
    if (!Number.isInteger(this.maxListLimit) || this.maxListLimit < 1) throw new Error('maxListLimit must be a positive integer')
    if (!Number.isInteger(this.maxReminderMinutes) || this.maxReminderMinutes < 1) throw new Error('maxReminderMinutes must be a positive integer')
    if (!Number.isInteger(this.operationTimeoutMs) || this.operationTimeoutMs < 1) throw new Error('operationTimeoutMs must be a positive integer')
  }

  initialize(context: ServiceContext): void {
    this.guardrails = context.services.get<PlatformGuardrailService>('platform-guardrails')
    this.personalization = typeof context.services.has === 'function' && context.services.has('personalization')
      ? context.services.get<PersonalizationService>('personalization')
      : undefined
    if (this.databasePath !== ':memory:') mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
    this.guardrailService().registerRateProfile({ id: RATE_PROFILE_ID, maxRequests: 30, windowMs: 10_000 })
    this.logger.info('collaboration storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.reminderTimer) clearInterval(this.reminderTimer)
    this.reminderTimer = undefined
    this.reminderTransport = undefined
    this.personalization = undefined
    this.reminderPolicyAuditKeys.clear()
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
  }

  startReminderDispatcher(whatsapp: WhatsAppPort, intervalMs = 15_000): void {
    if (!Number.isInteger(intervalMs) || intervalMs < 1_000) throw new Error('Reminder dispatcher interval must be at least 1000ms')
    this.reminderTransport = whatsapp
    if (this.reminderTimer) clearInterval(this.reminderTimer)
    this.reminderTimer = setInterval(() => {
      void this.dispatchDueReminders(whatsapp).catch((error: unknown) => {
        this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'reminder dispatch cycle failed')
      })
    }, intervalMs)
    this.reminderTimer.unref?.()
  }

  isEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().isFeatureEnabled(groupJid, FEATURE_ID)
  }

  isNativePollEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().isFeatureEnabled(groupJid, NATIVE_POLL_FEATURE_ID)
  }

  setEnabled(groupJid: string, enabled: boolean, actorJid: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'collaboration actor')
    this.guardrailService().setFeatureFlag(groupJid, FEATURE_ID, enabled, actorJid, `collaboration-${now}`, now)
    this.audit('collaboration.feature.changed', actorJid, groupJid, 'changed', { enabled })
    return enabled
  }

  setNativePollEnabled(groupJid: string, enabled: boolean, actorJid: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'native poll actor')
    this.guardrailService().setFeatureFlag(groupJid, NATIVE_POLL_FEATURE_ID, enabled, actorJid, `nativepoll-${now}`, now)
    this.audit('collaboration.nativepoll.changed', actorJid, groupJid, 'changed', { enabled })
    return enabled
  }

  createPoll(groupJid: string, creatorJid: string, question: string, options: readonly string[], selectableCount = 1, now = this.clock(), originKey?: string): PollRecord {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateJid(creatorJid, 'poll creator')
    const normalizedQuestion = normalizeText(question, this.maxTextLength, 'poll question')
    const normalizedOptions = options.map((option) => normalizeText(option, 100, 'poll option'))
    if (normalizedOptions.length < 2 || normalizedOptions.length > 12) throw new Error('Poll requires between 2 and 12 options')
    if (new Set(normalizedOptions.map((option) => option.toLowerCase())).size !== normalizedOptions.length) throw new Error('Poll options must be unique')
    if (!Number.isInteger(selectableCount) || selectableCount < 1 || selectableCount > normalizedOptions.length) throw new Error('Invalid poll selectableCount')
    if (originKey !== undefined) validateCorrelation(originKey)
    const existing = originKey
      ? this.database().prepare('SELECT * FROM collaboration_polls WHERE origin_key = ?').get(originKey) as (PollRow & { origin_key: string | null }) | undefined
      : undefined
    if (existing) {
      if (existing.group_jid !== groupJid) throw new Error('Poll idempotency key belongs to another group')
      if (existing.creator_jid !== creatorJid || existing.question !== normalizedQuestion || existing.options_json !== JSON.stringify(normalizedOptions) || existing.selectable_count !== selectableCount) {
        throw new Error('Poll idempotency key maps to a different request')
      }
      if (existing.status !== 'open') throw new Error('Poll idempotency record is no longer open')
      return mapPoll(existing)
    }
    this.consumeRate(groupJid, creatorJid, now)
    const id = randomUUID()
    this.audit('collaboration.poll.requested', creatorJid, groupJid, 'allowed', { pollId: id, optionCount: normalizedOptions.length, questionLength: normalizedQuestion.length })
    const record = this.transaction(() => {
      const inserted = this.database().prepare(`
        INSERT INTO collaboration_polls
          (id, group_jid, creator_jid, question, options_json, selectable_count, status, transport_status, created_at, expires_at, revision, origin_key)
        VALUES (@id, @group_jid, @creator_jid, @question, @options_json, @selectable_count, 'open', 'text', @created_at, @expires_at, 0, @origin_key)
        ON CONFLICT(origin_key) DO NOTHING
      `).run({ id, group_jid: groupJid, creator_jid: creatorJid, question: normalizedQuestion, options_json: JSON.stringify(normalizedOptions), selectable_count: selectableCount, created_at: now, expires_at: now + POLL_TTL_MS, origin_key: originKey ?? null })
      if (inserted.changes !== 1 && originKey !== undefined) {
        const raced = this.database().prepare('SELECT * FROM collaboration_polls WHERE origin_key = ?').get(originKey) as (PollRow & { origin_key: string | null }) | undefined
        if (!raced) throw new Error('Poll idempotency record was not persisted')
        if (raced.group_jid !== groupJid || raced.creator_jid !== creatorJid || raced.question !== normalizedQuestion || raced.options_json !== JSON.stringify(normalizedOptions) || raced.selectable_count !== selectableCount) throw new Error('Poll idempotency key maps to a different request')
        if (raced.status !== 'open') throw new Error('Poll idempotency record is no longer open')
        return mapPoll(raced)
      }
      return this.getPoll(id, now) as PollRecord
    })
    this.audit('collaboration.poll.created', creatorJid, groupJid, 'changed', { pollId: id, optionCount: normalizedOptions.length })
    return record
  }

  markPollNativePending(groupJid: string, pollId: string, actorJid: string, now = this.clock()): PollRecord | undefined {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateId(pollId, 'poll id')
    validateJid(actorJid, 'poll actor')
    const current = this.requirePollInGroup(groupJid, pollId, now)
    const result = this.database().prepare(`UPDATE collaboration_polls SET transport_status = 'native-pending', revision = revision + 1 WHERE id = ? AND group_jid = ? AND status = 'open' AND revision = ?`).run(pollId, groupJid, current.revision)
    return result.changes === 1 ? this.getPoll(pollId, now) : undefined
  }

  markPollNativeSent(groupJid: string, pollId: string, actorJid: string, now = this.clock()): PollRecord | undefined {
    return this.updatePollTransport(groupJid, pollId, actorJid, 'native-sent', now)
  }

  markPollNativeFailed(groupJid: string, pollId: string, actorJid: string, now = this.clock()): PollRecord | undefined {
    return this.updatePollTransport(groupJid, pollId, actorJid, 'native-failed', now)
  }

  vote(groupJid: string, pollId: string, voterJid: string, optionIndex: number, correlationKey: string, now = this.clock()): { poll: PollRecord; vote: PollVoteRecord; duplicate: boolean } {
    validateGroupJid(groupJid)
    validateId(pollId, 'poll id')
    validateJid(voterJid, 'poll voter')
    validateCorrelation(correlationKey)
    if (!Number.isInteger(optionIndex) || optionIndex < 0) throw new Error('Invalid poll option')
    const poll = this.requirePollInGroup(groupJid, pollId, now)
    if (poll.status !== 'open') throw new Error('Poll is not open')
    if (optionIndex >= poll.options.length) throw new Error('Poll option does not exist')
    const existing = this.database().prepare(`SELECT poll_id, voter_jid, option_index, created_at FROM collaboration_poll_votes WHERE poll_id = ? AND voter_jid = ?`).get(pollId, voterJid) as VoteRow | undefined
    if (existing) return { poll, vote: mapVote(existing), duplicate: true }
    const result = this.transaction(() => {
      const inserted = this.database().prepare(`INSERT OR IGNORE INTO collaboration_poll_votes (poll_id, voter_jid, option_index, created_at, correlation_key) VALUES (?, ?, ?, ?, ?)`).run(pollId, voterJid, optionIndex, now, hashText(correlationKey))
      if (inserted.changes !== 1) {
        const current = this.database().prepare(`SELECT poll_id, voter_jid, option_index, created_at FROM collaboration_poll_votes WHERE poll_id = ? AND voter_jid = ?`).get(pollId, voterJid) as VoteRow | undefined
        if (!current) throw new Error('Poll vote was not persisted')
        return { poll: this.getPoll(pollId, now) as PollRecord, vote: mapVote(current), duplicate: true }
      }
      const created = this.database().prepare(`SELECT poll_id, voter_jid, option_index, created_at FROM collaboration_poll_votes WHERE poll_id = ? AND voter_jid = ?`).get(pollId, voterJid) as VoteRow
      return { poll: this.getPoll(pollId, now) as PollRecord, vote: mapVote(created), duplicate: false }
    })
    this.audit(result.duplicate ? 'collaboration.poll.vote_duplicate' : 'collaboration.poll.voted', voterJid, groupJid, result.duplicate ? 'allowed' : 'changed', { pollId })
    return result
  }

  listPolls(groupJid: string, status?: CollaborationPollStatus, limit = this.maxListLimit, now = this.clock()): readonly PollRecord[] {
    validateGroupJid(groupJid)
    const safeLimit = validateLimit(limit, this.maxListLimit)
    this.expirePolls(now)
    if (status && !isPollStatus(status)) throw new Error('Invalid poll status')
    const rows = this.database().prepare(`SELECT * FROM collaboration_polls WHERE group_jid = ? AND (? IS NULL OR status = ?) ORDER BY created_at DESC, id DESC LIMIT ?`).all(groupJid, status ?? null, status ?? null, safeLimit) as PollRow[]
    return rows.map(mapPoll)
  }

  getPoll(id: string, now = this.clock()): PollRecord | undefined {
    validateId(id, 'poll id')
    this.expirePolls(now)
    const row = this.database().prepare(`SELECT * FROM collaboration_polls WHERE id = ?`).get(id) as PollRow | undefined
    return row ? mapPoll(row) : undefined
  }

  closePoll(groupJid: string, pollId: string, actorJid: string, now = this.clock()): PollRecord | undefined {
    validateGroupJid(groupJid)
    validateId(pollId, 'poll id')
    validateJid(actorJid, 'poll closer')
    const current = this.requirePollInGroup(groupJid, pollId, now)
    if (current.status !== 'open') return current
    const result = this.database().prepare(`UPDATE collaboration_polls SET status = 'closed', closed_at = ?, revision = revision + 1 WHERE id = ? AND group_jid = ? AND status = 'open' AND revision = ?`).run(now, pollId, groupJid, current.revision)
    if (result.changes !== 1) return this.getPoll(pollId, now)
    this.audit('collaboration.poll.closed', actorJid, groupJid, 'changed', { pollId })
    return this.getPoll(pollId, now)
  }

  getPollResults(groupJid: string, pollId: string, now = this.clock()): readonly { optionIndex: number; option: string; votes: number }[] {
    const poll = this.requirePollInGroup(groupJid, pollId, now)
    const rows = this.database().prepare(`SELECT option_index, COUNT(*) AS votes FROM collaboration_poll_votes WHERE poll_id = ? GROUP BY option_index ORDER BY option_index`).all(pollId) as { option_index: number; votes: number }[]
    const counts = new Map(rows.map((row) => [row.option_index, row.votes]))
    return poll.options.map((option, optionIndex) => ({ optionIndex, option, votes: counts.get(optionIndex) ?? 0 }))
  }

  createReminder(groupJid: string, creatorJid: string, text: string, dueAt: number, now = this.clock()): ReminderRecord {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateJid(creatorJid, 'reminder creator')
    const normalizedText = normalizeText(text, this.maxTextLength, 'reminder text')
    if (!Number.isInteger(dueAt) || dueAt <= now || dueAt > now + this.maxReminderMinutes * 60_000) throw new Error('Reminder due time is outside the allowed window')
    this.consumeRate(groupJid, creatorJid, now)
    const id = randomUUID()
    this.database().prepare(`INSERT INTO collaboration_reminders (id, group_jid, creator_jid, text, due_at, status, created_at) VALUES (?, ?, ?, ?, ?, 'scheduled', ?)`).run(id, groupJid, creatorJid, normalizedText, dueAt, now)
    this.audit('collaboration.reminder.created', creatorJid, groupJid, 'changed', { reminderId: id, textLength: normalizedText.length })
    return this.getReminder(id, now) as ReminderRecord
  }

  listReminders(groupJid: string, status?: CollaborationReminderStatus, limit = this.maxListLimit, now = this.clock()): readonly ReminderRecord[] {
    validateGroupJid(groupJid)
    const safeLimit = validateLimit(limit, this.maxListLimit)
    if (status && !isReminderStatus(status)) throw new Error('Invalid reminder status')
    const rows = this.database().prepare(`SELECT * FROM collaboration_reminders WHERE group_jid = ? AND (? IS NULL OR status = ?) ORDER BY due_at ASC, id ASC LIMIT ?`).all(groupJid, status ?? null, status ?? null, safeLimit) as ReminderRow[]
    return rows.map(mapReminder)
  }

  getReminder(id: string, now = this.clock()): ReminderRecord | undefined {
    validateId(id, 'reminder id')
    const row = this.database().prepare(`SELECT * FROM collaboration_reminders WHERE id = ?`).get(id) as ReminderRow | undefined
    return row ? mapReminder(row) : undefined
  }

  cancelReminder(groupJid: string, id: string, actorJid: string, now = this.clock()): ReminderRecord | undefined {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateId(id, 'reminder id')
    validateJid(actorJid, 'reminder canceller')
    const result = this.database().prepare(`UPDATE collaboration_reminders SET status = 'cancelled', cancelled_at = ?, cancelled_by = ? WHERE id = ? AND group_jid = ? AND status = 'scheduled'`).run(now, actorJid, id, groupJid)
    if (result.changes !== 1) return this.getReminder(id, now)
    this.audit('collaboration.reminder.cancelled', actorJid, groupJid, 'changed', { reminderId: id })
    return this.getReminder(id, now)
  }

  createTask(groupJid: string, creatorJid: string, text: string, assigneeJid?: string, now = this.clock()): TaskRecord {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateJid(creatorJid, 'task creator')
    if (assigneeJid) validateJid(assigneeJid, 'task assignee')
    const normalizedText = normalizeText(text, this.maxTextLength, 'task text')
    const id = randomUUID()
    this.database().prepare(`INSERT INTO collaboration_tasks (id, group_jid, creator_jid, assignee_jid, text, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`).run(id, groupJid, creatorJid, assigneeJid ?? null, normalizedText, now)
    this.audit('collaboration.task.created', creatorJid, groupJid, 'changed', { taskId: id, assigned: Boolean(assigneeJid) })
    return this.getTask(id) as TaskRecord
  }

  listTasks(groupJid: string, status?: CollaborationTaskStatus, limit = this.maxListLimit): readonly TaskRecord[] {
    validateGroupJid(groupJid)
    const safeLimit = validateLimit(limit, this.maxListLimit)
    if (status && !isTaskStatus(status)) throw new Error('Invalid task status')
    const rows = this.database().prepare(`SELECT * FROM collaboration_tasks WHERE group_jid = ? AND (? IS NULL OR status = ?) ORDER BY created_at DESC, id DESC LIMIT ?`).all(groupJid, status ?? null, status ?? null, safeLimit) as TaskRow[]
    return rows.map(mapTask)
  }

  completeTask(groupJid: string, id: string, actorJid: string, now = this.clock()): TaskRecord | undefined {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateId(id, 'task id')
    validateJid(actorJid, 'task actor')
    const result = this.database().prepare(`UPDATE collaboration_tasks SET status = 'done', completed_at = ?, completed_by = ? WHERE id = ? AND group_jid = ? AND status = 'open' AND (creator_jid = ? OR assignee_jid = ?)`).run(now, actorJid, id, groupJid, actorJid, actorJid)
    if (result.changes !== 1) return undefined
    this.audit('collaboration.task.completed', actorJid, groupJid, 'changed', { taskId: id })
    return this.getTask(id)
  }

  createDecision(groupJid: string, creatorJid: string, text: string, now = this.clock()): DecisionRecord {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateJid(creatorJid, 'decision creator')
    const normalizedText = normalizeText(text, this.maxTextLength, 'decision text')
    const id = randomUUID()
    this.database().prepare(`INSERT INTO collaboration_decisions (id, group_jid, creator_jid, text, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, groupJid, creatorJid, normalizedText, now)
    this.audit('collaboration.decision.created', creatorJid, groupJid, 'changed', { decisionId: id, textLength: normalizedText.length })
    return this.getDecision(id) as DecisionRecord
  }

  listDecisions(groupJid: string, limit = this.maxListLimit): readonly DecisionRecord[] {
    validateGroupJid(groupJid)
    const safeLimit = validateLimit(limit, this.maxListLimit)
    const rows = this.database().prepare(`SELECT * FROM collaboration_decisions WHERE group_jid = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(groupJid, safeLimit) as DecisionRow[]
    return rows.map(mapDecision)
  }

  async dispatchDueReminders(whatsapp: WhatsAppPort, now = this.clock()): Promise<number> {
    const rows = this.database().prepare(`SELECT * FROM collaboration_reminders WHERE status = 'scheduled' AND due_at <= ? ORDER BY due_at ASC, id ASC LIMIT 25`).all(now) as ReminderRow[]
    let sent = 0
    for (const row of rows) {
      if (!this.isEnabled(row.group_jid)) continue
      const notification = this.personalization?.evaluateGroupNotification(row.group_jid, now)
      if (notification && !notification.allowed) {
        const auditKey = `${row.id}:${notification.reason}`
        if (!this.reminderPolicyAuditKeys.has(auditKey)) {
          this.reminderPolicyAuditKeys.add(auditKey)
          this.audit('collaboration.reminder.limited', row.creator_jid, row.group_jid, 'limited', { reminderId: row.id, reason: notification.reason })
        }
        continue
      }
      this.reminderPolicyAuditKeys.delete(`${row.id}:quiet-hours`)
      this.reminderPolicyAuditKeys.delete(`${row.id}:policy-disabled`)
      const claimed = this.database().prepare(`UPDATE collaboration_reminders SET status = 'sent', sent_at = ? WHERE id = ? AND status = 'scheduled'`).run(now, row.id)
      if (claimed.changes !== 1) continue
      const operation = await runPlatformOperation({
        operationId: `reminder-${row.id}`,
        timeoutMs: this.operationTimeoutMs,
        retry: { maxAttempts: 1 },
        execute: async () => whatsapp.sendText(row.group_jid, `⏰ *Reminder*\n${row.text}`),
      })
      if (!operation.ok) {
        this.database().prepare(`UPDATE collaboration_reminders SET status = 'expired', sent_at = NULL WHERE id = ? AND status = 'sent'`).run(row.id)
        this.audit('collaboration.reminder.failed', row.creator_jid, row.group_jid, 'failed', { reminderId: row.id, errorName: operation.error instanceof Error ? operation.error.name : 'UnknownError' })
        continue
      }
      this.audit('collaboration.reminder.sent', row.creator_jid, row.group_jid, 'changed', { reminderId: row.id })
      sent += 1
    }
    return sent
  }

  private expirePolls(now: number): void {
    this.database().prepare(`UPDATE collaboration_polls SET status = 'expired', revision = revision + 1 WHERE status = 'open' AND expires_at <= ?`).run(now)
  }

  private expireReminders(now: number): void {
    this.database().prepare(`UPDATE collaboration_reminders SET status = 'expired' WHERE status = 'scheduled' AND due_at <= ?`).run(now - 1)
  }

  private updatePollTransport(groupJid: string, pollId: string, actorJid: string, status: 'native-sent' | 'native-failed', now: number): PollRecord | undefined {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateId(pollId, 'poll id')
    validateJid(actorJid, 'poll actor')
    const current = this.requirePollInGroup(groupJid, pollId, now)
    this.database().prepare(`UPDATE collaboration_polls SET transport_status = ?, revision = revision + 1 WHERE id = ? AND group_jid = ? AND status = 'open' AND revision = ?`).run(status, pollId, groupJid, current.revision)
    this.audit(`collaboration.poll.${status}`, actorJid, groupJid, status === 'native-sent' ? 'changed' : 'failed', { pollId })
    return this.getPoll(pollId, now)
  }

  private requirePollInGroup(groupJid: string, pollId: string, now: number): PollRecord {
    const poll = this.getPoll(pollId, now)
    if (!poll || poll.groupJid !== groupJid) throw new Error('Poll not found in group')
    return poll
  }

  private getTask(id: string): TaskRecord | undefined {
    validateId(id, 'task id')
    const row = this.database().prepare(`SELECT * FROM collaboration_tasks WHERE id = ?`).get(id) as TaskRow | undefined
    return row ? mapTask(row) : undefined
  }

  private getDecision(id: string): DecisionRecord | undefined {
    validateId(id, 'decision id')
    const row = this.database().prepare(`SELECT * FROM collaboration_decisions WHERE id = ?`).get(id) as DecisionRow | undefined
    return row ? mapDecision(row) : undefined
  }

  private requireEnabled(groupJid: string): void {
    if (!this.isEnabled(groupJid)) throw new Error('Collaboration feature is disabled for this group')
  }

  private consumeRate(groupJid: string, actorJid: string, now: number): void {
    const decision = this.guardrailService().consumeRate(RATE_PROFILE_ID, hashText(`${groupJid}:${actorJid}`), { actorJid, resourceJid: groupJid }, now)
    if (!decision.allowed) throw new Error('Collaboration rate limit exceeded')
  }

  private audit(eventType: string, actorJid: string, resourceJid: string, outcome: 'changed' | 'failed' | 'allowed' | 'limited', metadata: Record<string, unknown>): void {
    this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), actorJid, resourceJid, outcome, metadata })
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS collaboration_polls (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        creator_jid TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT NOT NULL,
        selectable_count INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'expired')),
        transport_status TEXT NOT NULL CHECK (transport_status IN ('text', 'native-pending', 'native-sent', 'native-failed')),
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        closed_at INTEGER,
        revision INTEGER NOT NULL,
        origin_key TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_collaboration_polls_group_status ON collaboration_polls (group_jid, status, created_at);
      CREATE TABLE IF NOT EXISTS collaboration_poll_votes (
        poll_id TEXT NOT NULL REFERENCES collaboration_polls(id),
        voter_jid TEXT NOT NULL,
        option_index INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        correlation_key TEXT NOT NULL,
        PRIMARY KEY (poll_id, voter_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_collaboration_poll_votes_poll ON collaboration_poll_votes (poll_id, option_index);
      CREATE TABLE IF NOT EXISTS collaboration_reminders (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        creator_jid TEXT NOT NULL,
        text TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'sent', 'cancelled', 'expired')),
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        cancelled_at INTEGER,
        cancelled_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_collaboration_reminders_due ON collaboration_reminders (status, due_at);
      CREATE TABLE IF NOT EXISTS collaboration_tasks (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        creator_jid TEXT NOT NULL,
        assignee_jid TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'done', 'cancelled')),
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        completed_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_collaboration_tasks_group_status ON collaboration_tasks (group_jid, status, created_at);
      CREATE TABLE IF NOT EXISTS collaboration_decisions (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        creator_jid TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_collaboration_decisions_group_time ON collaboration_decisions (group_jid, created_at);
        `)
    try {
      this.database().exec('ALTER TABLE collaboration_polls ADD COLUMN origin_key TEXT')
    } catch (error) {
      if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error
    }
    this.database().exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_collaboration_polls_origin_key ON collaboration_polls (origin_key)')
  }
  private transaction<T>(operation: () => T): T {
    return this.database().transaction(operation)()
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('Collaboration service is not initialized')
    return this.db
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('Platform guardrails service is not initialized')
    return this.guardrails
  }
}

function mapPoll(row: PollRow): PollRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    creatorJid: row.creator_jid,
    question: row.question,
    options: JSON.parse(row.options_json) as string[],
    selectableCount: row.selectable_count,
    status: row.status,
    transportStatus: row.transport_status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
    revision: row.revision,
  }
}

function mapVote(row: VoteRow): PollVoteRecord {
  return { pollId: row.poll_id, voterJid: row.voter_jid, optionIndex: row.option_index, createdAt: row.created_at }
}

function mapReminder(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    creatorJid: row.creator_jid,
    text: row.text,
    dueAt: row.due_at,
    status: row.status,
    createdAt: row.created_at,
    ...(row.sent_at === null ? {} : { sentAt: row.sent_at }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at }),
  }
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    creatorJid: row.creator_jid,
    ...(row.assignee_jid === null ? {} : { assigneeJid: row.assignee_jid }),
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.completed_by === null ? {} : { completedBy: row.completed_by }),
  }
}

function mapDecision(row: DecisionRow): DecisionRecord {
  return { id: row.id, groupJid: row.group_jid, creatorJid: row.creator_jid, text: row.text, createdAt: row.created_at }
}

function validateGroupJid(value: string): void {
  if (!isJid(value) || !value.endsWith('@g.us')) throw new Error('Collaboration requires a group JID')
}

function validateJid(value: string, field: string): void {
  if (!isJid(value)) throw new Error(`${field} must be a valid JID`)
}

function validateId(value: string, field: string): void {
  if (!/^[a-f0-9-]{8,64}$/i.test(value)) throw new Error(`Invalid ${field}`)
}

function validateCorrelation(value: string): void {
  if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) throw new Error('Invalid correlation key')
}

function validateLimit(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`List limit must be between 1 and ${max}`)
  return value
}

function normalizeText(value: string, maxLength: number, field: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.length > maxLength) throw new Error(`${field} is too long`)
  if (/(?:bearer\s+|password\s*[:=]|api[_-]?key\s*[:=])/i.test(normalized)) throw new Error(`${field} contains sensitive-looking data`)
  return normalized
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function isPollStatus(value: string): value is CollaborationPollStatus {
  return ['open', 'closed', 'expired'].includes(value)
}

function isReminderStatus(value: string): value is CollaborationReminderStatus {
  return ['scheduled', 'sent', 'cancelled', 'expired'].includes(value)
}

function isTaskStatus(value: string): value is CollaborationTaskStatus {
  return ['open', 'done', 'cancelled'].includes(value)
}
