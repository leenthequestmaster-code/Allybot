import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Service, ServiceContext, WhatsAppPort } from '../framework/contracts.js'
import { runPlatformOperation } from '../platform/operations.js'
import { isJid, isSafeIdentifier, normalizeText } from '../platform/validation.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'
import type { CollaborationService } from './collaboration-service.js'
import type { PersonalizationService } from './personalization-service.js'

export const EVENT_FEATURE_ID = 'group.event.core'

type AuditOutcome = 'allowed' | 'denied' | 'changed' | 'failed' | 'limited' | 'opened' | 'closed'
export type EventStatus = 'draft' | 'published' | 'active' | 'paused' | 'closed'
export type EventPhaseStatus = 'scheduled' | 'active' | 'completed' | 'skipped'
export type EventOperationStatus = 'planned' | 'running' | 'succeeded' | 'failed'
export type EventOperationType = 'event_activate' | 'phase_start' | 'phase_complete' | 'event_close' | 'manual_transition'

export interface EventPhaseInput {
  readonly order: number
  readonly title: string
  readonly description?: string
  readonly startAt: number
  readonly endAt?: number
}

export interface EventPhaseRecord {
  readonly id: string
  readonly eventId: string
  readonly order: number
  readonly title: string
  readonly description: string
  readonly startAt: number
  readonly endAt?: number
  readonly status: EventPhaseStatus
  readonly revision: number
}

export interface EventRecord {
  readonly id: string
  readonly groupJid: string
  readonly creatorJid: string
  readonly title: string
  readonly description: string
  readonly timezone: string
  readonly startAt: number
  readonly endAt?: number
  readonly status: EventStatus
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly locationLabel?: string
  readonly locationLatitude?: number
  readonly locationLongitude?: number
  readonly pollId?: string
  readonly phases: readonly EventPhaseRecord[]
  readonly participantCount: number
}

export interface EventOperationRecord {
  readonly operationId: string
  readonly eventId: string
  readonly groupJid: string
  readonly operationType: EventOperationType
  readonly phaseId?: string
  readonly status: EventOperationStatus
  readonly correlationHash: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly outcomeCode: string
}

export interface EventServiceOptions {
  readonly clock?: () => number
  readonly maxTextLength?: number
  readonly maxListLimit?: number
  readonly maxPhases?: number
  readonly maxParticipants?: number
  readonly dispatcherIntervalMs?: number
  readonly operationTimeoutMs?: number
}

interface EventRow {
  id: string
  group_jid: string
  creator_jid: string
  title: string
  description: string
  timezone: string
  start_at: number
  end_at: number | null
  status: EventStatus
  revision: number
  created_at: number
  updated_at: number
  location_label: string | null
  location_latitude: number | null
  location_longitude: number | null
  poll_id: string | null
}

interface PhaseRow {
  id: string
  event_id: string
  phase_order: number
  title: string
  description: string
  start_at: number
  end_at: number | null
  status: EventPhaseStatus
  revision: number
}

interface EventOperationRow {
  operation_id: string
  event_id: string
  group_jid: string
  operation_type: EventOperationType
  phase_id: string | null
  status: EventOperationStatus
  correlation_hash: string
  created_at: number
  updated_at: number
  outcome_code: string
}

interface CollaborationPollService {
  isEnabled(groupJid: string): boolean
  createPoll(groupJid: string, creatorJid: string, question: string, options: readonly string[], selectableCount?: number, now?: number): { id: string }
}

const DEFAULT_MAX_TEXT_LENGTH = 500
const DEFAULT_MAX_LIST_LIMIT = 25
const DEFAULT_MAX_PHASES = 12
const DEFAULT_MAX_PARTICIPANTS = 100
const DEFAULT_DISPATCHER_INTERVAL_MS = 15_000
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000
const MAX_TIMEZONE_LENGTH = 64
const SUPPORTED_TIME_ZONES = new Set(
  Intl.supportedValuesOf('timeZone').map((value) => value.toUpperCase()),
)

function validateGroupJid(value: string): void {
  if (!isJid(value) || !value.endsWith('@g.us')) throw new Error('groupJid must be a valid group JID')
}

function validateJid(value: string, field: string): void {
  if (!isJid(value)) throw new Error(`${field} must be a valid JID`)
}

function validateId(value: string, field: string): void {
  if (!isSafeIdentifier(value) || value.length > 80) throw new Error(`${field} must be a safe identifier`)
}

function validateTimestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative epoch milliseconds value`)
}

function normalizeTimezone(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_TIMEZONE_LENGTH || /\s/.test(normalized)) throw new Error('Timezone must be a valid IANA identifier')
  if (normalized !== 'UTC' && !SUPPORTED_TIME_ZONES.has(normalized.toUpperCase())) throw new Error('Timezone must be a valid IANA identifier')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format()
  } catch {
    throw new Error('Timezone must be supported by the runtime')
  }
  return normalized
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeRequiredText(value: string | undefined, maxLength: number, field: string): string {
  const normalized = normalizeText(value)
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.length > maxLength) throw new Error(`${field} exceeds maximum length`)
  return normalized
}

function mapPhase(row: PhaseRow): EventPhaseRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    order: row.phase_order,
    title: row.title,
    description: row.description,
    startAt: row.start_at,
    ...(row.end_at === null ? {} : { endAt: row.end_at }),
    status: row.status,
    revision: row.revision,
  }
}

export class EventService implements Service {
  readonly name = 'event'
  readonly dependencies = ['platform-guardrails'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly maxTextLength: number
  private readonly maxListLimit: number
  private readonly maxPhases: number
  private readonly maxParticipants: number
  private readonly dispatcherIntervalMs: number
  private readonly operationTimeoutMs: number
  private readonly logger: Logger
  private db: Database.Database | undefined
  private guardrails: PlatformGuardrailService | undefined
  private personalization: PersonalizationService | undefined
  private collaboration: CollaborationPollService | undefined
  private dispatcher: NodeJS.Timeout | undefined
  private dispatchPromise: Promise<number> | undefined
  private dispatchInFlight = false
  private readonly policyAuditKeys = new Set<string>()

  constructor(databasePath: string, logger: Logger, options: EventServiceOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH
    this.maxListLimit = options.maxListLimit ?? DEFAULT_MAX_LIST_LIMIT
    this.maxPhases = options.maxPhases ?? DEFAULT_MAX_PHASES
    this.maxParticipants = options.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS
    this.dispatcherIntervalMs = options.dispatcherIntervalMs ?? DEFAULT_DISPATCHER_INTERVAL_MS
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    this.logger = logger.child({ component: 'event' })
    if (!Number.isInteger(this.maxTextLength) || this.maxTextLength < 32) throw new Error('maxTextLength must be at least 32')
    if (!Number.isInteger(this.maxListLimit) || this.maxListLimit < 1) throw new Error('maxListLimit must be positive')
    if (!Number.isInteger(this.maxPhases) || this.maxPhases < 1) throw new Error('maxPhases must be positive')
    if (!Number.isInteger(this.maxParticipants) || this.maxParticipants < 1) throw new Error('maxParticipants must be positive')
    if (!Number.isInteger(this.dispatcherIntervalMs) || this.dispatcherIntervalMs < 1) throw new Error('dispatcherIntervalMs must be positive')
    if (!Number.isInteger(this.operationTimeoutMs) || this.operationTimeoutMs < 1) throw new Error('operationTimeoutMs must be positive')
  }

  initialize(context: ServiceContext): void {
    this.guardrails = context.services.get<PlatformGuardrailService>('platform-guardrails')
    this.personalization = context.services.has('personalization') ? context.services.get<PersonalizationService>('personalization') : undefined
    this.collaboration = context.services.has('collaboration') ? context.services.get<CollaborationService>('collaboration') : undefined
    if (this.databasePath !== ':memory:') mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
    this.logger.info('event storage initialized')
  }

  async shutdown(): Promise<void> {
    this.stopEventDispatcher()
    if (this.dispatchPromise) await this.dispatchPromise.catch(() => undefined)
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
    this.personalization = undefined
    this.collaboration = undefined
  }

  isEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().getFeatureFlag(groupJid, EVENT_FEATURE_ID)?.enabled ?? false
  }

  setEnabled(groupJid: string, enabled: boolean, actorJid: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'event actor')
    this.guardrailService().setFeatureFlag(groupJid, EVENT_FEATURE_ID, enabled, actorJid, `event-${now}`, now)
    this.audit('event.feature.changed', actorJid, groupJid, 'changed', { enabled })
    return enabled
  }

  createEvent(groupJid: string, creatorJid: string, title: string, description: string, timezone: string, startAt: number, endAt: number | undefined, phases: readonly EventPhaseInput[], now = this.clock()): EventRecord {
    this.requireEnabled(groupJid)
    validateJid(creatorJid, 'event creator')
    validateTimestamp(startAt, 'startAt')
    if (endAt !== undefined) {
      validateTimestamp(endAt, 'endAt')
      if (endAt <= startAt) throw new Error('endAt must be after startAt')
    }
    const normalizedTitle = normalizeRequiredText(title, 160, 'event title')
    const normalizedDescription = normalizeRequiredText(description, this.maxTextLength, 'event description')
    const normalizedTimezone = normalizeTimezone(timezone)
    const normalizedPhases = this.normalizePhases(phases, startAt, endAt)
    const id = randomUUID()
    this.transaction(() => {
      this.database().prepare(`
        INSERT INTO events (id, group_jid, creator_jid, title, description, timezone, start_at, end_at, status, revision, created_at, updated_at, location_label, location_latitude, location_longitude, poll_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?, NULL, NULL, NULL, NULL)
      `).run(id, groupJid, creatorJid, normalizedTitle, normalizedDescription, normalizedTimezone, startAt, endAt ?? null, now, now)
      const insertPhase = this.database().prepare(`
        INSERT INTO event_phases (id, event_id, phase_order, title, description, start_at, end_at, status, revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', 0)
      `)
      for (const phase of normalizedPhases) insertPhase.run(randomUUID(), id, phase.order, phase.title, phase.description, phase.startAt, phase.endAt ?? null)
    })
    this.audit('event.created', creatorJid, groupJid, 'changed', { phaseCount: normalizedPhases.length, titleLength: normalizedTitle.length, hasEndAt: endAt !== undefined })
    return this.getEvent(groupJid, id, now) as EventRecord
  }

  publishEvent(groupJid: string, eventId: string, actorJid: string, now = this.clock()): EventRecord | undefined {
    return this.transitionLifecycle(groupJid, eventId, actorJid, 'published', now)
  }

  pauseEvent(groupJid: string, eventId: string, actorJid: string, now = this.clock()): EventRecord | undefined {
    return this.transitionLifecycle(groupJid, eventId, actorJid, 'paused', now)
  }

  resumeEvent(groupJid: string, eventId: string, actorJid: string, now = this.clock()): EventRecord | undefined {
    return this.transitionLifecycle(groupJid, eventId, actorJid, 'active', now)
  }

  closeEvent(groupJid: string, eventId: string, actorJid: string, now = this.clock()): EventRecord | undefined {
    return this.transitionLifecycle(groupJid, eventId, actorJid, 'closed', now)
  }

  setPhase(groupJid: string, eventId: string, actorJid: string, phaseOrder: number, now = this.clock()): EventRecord | undefined {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'event phase actor')
    if (!Number.isInteger(phaseOrder) || phaseOrder < 1 || phaseOrder > this.maxPhases) throw new Error('Invalid phase order')
    const event = this.requireEvent(groupJid, eventId, now)
    this.requireCreator(event, actorJid)
    if (event.status === 'closed' || event.status === 'draft') throw new Error('Event is not phase-editable')
    const eventRow = this.database().prepare(`SELECT * FROM events WHERE id = ? AND group_jid = ?`).get(event.id, groupJid) as EventRow | undefined
    if (!eventRow) throw new Error('Event changed concurrently; retry')
    const phase = this.database().prepare(`SELECT * FROM event_phases WHERE event_id = ? AND phase_order = ?`).get(event.id, phaseOrder) as PhaseRow | undefined
    if (!phase) throw new Error('Phase not found')
    const operationId = this.operationId(event.id, 'manual_transition', phase.id, String(phaseOrder))
    const claimed = this.claimOperation(operationId, eventRow, 'manual_transition', phase.id, now)
    if (!claimed) return this.getEvent(groupJid, event.id, now)
    const changed = this.transaction(() => {
      const eventUpdate = this.database().prepare(`UPDATE events SET status = CASE WHEN status = 'published' THEN 'active' ELSE status END, revision = revision + 1, updated_at = ? WHERE id = ? AND group_jid = ? AND status IN ('published', 'active', 'paused') AND revision = ?`).run(now, event.id, groupJid, eventRow.revision)
      if (eventUpdate.changes !== 1) return false
      const update = this.database().prepare(`
        UPDATE event_phases SET status = CASE WHEN phase_order < ? THEN 'completed' WHEN phase_order = ? THEN 'active' ELSE 'scheduled' END, revision = revision + 1
        WHERE event_id = ? AND revision = revision
      `).run(phaseOrder, phaseOrder, event.id)
      if (update.changes === 0) throw new Error('Phase update failed')
      return true
    })
    this.finishOperation(operationId, changed ? 'succeeded' : 'failed', changed ? 'changed' : 'stale', now)
    this.audit(changed ? 'event.phase.changed' : 'event.phase.stale', actorJid, groupJid, changed ? 'changed' : 'failed', { phaseOrder })
    return this.getEvent(groupJid, event.id, now)
  }

  joinEvent(groupJid: string, eventId: string, participantJid: string, now = this.clock()): boolean {
    this.requireEnabled(groupJid)
    validateJid(participantJid, 'event participant')
    const event = this.requireEvent(groupJid, eventId, now)
    if (!['published', 'active', 'paused'].includes(event.status)) throw new Error('Event is not accepting participants')
    const existing = this.database().prepare(`SELECT status FROM event_participants WHERE event_id = ? AND user_jid = ?`).get(event.id, participantJid) as { status: string } | undefined
    if (!existing) {
      const count = this.database().prepare(`SELECT COUNT(*) AS count FROM event_participants WHERE event_id = ? AND status = 'joined'`).get(event.id) as { count: number }
      if (count.count >= this.maxParticipants) {
        this.audit('event.participant.limited', participantJid, groupJid, 'limited', { limit: this.maxParticipants })
        throw new Error('Event participant limit reached')
      }
      this.database().prepare(`INSERT INTO event_participants (event_id, user_jid, status, joined_at, left_at, revision) VALUES (?, ?, 'joined', ?, NULL, 0)`).run(event.id, participantJid, now)
      this.audit('event.participant.joined', participantJid, groupJid, 'changed', { participantCount: count.count + 1 })
      return true
    }
    if (existing.status === 'joined') {
      this.audit('event.participant.join_duplicate', participantJid, groupJid, 'allowed', {})
      return false
    }
    this.database().prepare(`UPDATE event_participants SET status = 'joined', joined_at = ?, left_at = NULL, revision = revision + 1 WHERE event_id = ? AND user_jid = ? AND status = 'left'`).run(now, event.id, participantJid)
    this.audit('event.participant.rejoined', participantJid, groupJid, 'changed', {})
    return true
  }

  leaveEvent(groupJid: string, eventId: string, participantJid: string, now = this.clock()): boolean {
    this.requireEnabled(groupJid)
    validateJid(participantJid, 'event participant')
    const event = this.requireEvent(groupJid, eventId, now)
    if (event.status === 'closed') throw new Error('Event is closed')
    const result = this.database().prepare(`UPDATE event_participants SET status = 'left', left_at = ?, revision = revision + 1 WHERE event_id = ? AND user_jid = ? AND status = 'joined'`).run(now, event.id, participantJid)
    if (result.changes === 1) this.audit('event.participant.left', participantJid, groupJid, 'changed', {})
    else this.audit('event.participant.leave_duplicate', participantJid, groupJid, 'allowed', {})
    return result.changes === 1
  }

  setLocation(groupJid: string, eventId: string, actorJid: string, label: string, latitude: number, longitude: number, now = this.clock()): EventRecord | undefined {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'event location actor')
    const event = this.requireEvent(groupJid, eventId, now)
    this.requireCreator(event, actorJid)
    const normalizedLabel = normalizeRequiredText(label, 160, 'location label')
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new Error('Invalid latitude')
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new Error('Invalid longitude')
    const result = this.database().prepare(`UPDATE events SET location_label = ?, location_latitude = ?, location_longitude = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND group_jid = ? AND revision = ?`).run(normalizedLabel, latitude, longitude, now, event.id, groupJid, event.revision)
    if (result.changes !== 1) throw new Error('Event changed concurrently; retry')
    this.audit('event.location.changed', actorJid, groupJid, 'changed', { labelLength: normalizedLabel.length, latitudeSet: true, longitudeSet: true })
    return this.getEvent(groupJid, event.id, now)
  }

  linkPoll(groupJid: string, eventId: string, actorJid: string, question: string, options: readonly string[], now = this.clock()): EventRecord | undefined {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'event poll actor')
    const event = this.requireEvent(groupJid, eventId, now)
    this.requireCreator(event, actorJid)
    if (!this.collaboration || !this.collaboration.isEnabled(groupJid)) throw new Error('Collaboration poll is unavailable for this group')
    if (event.pollId) return event
    const poll = this.collaboration.createPoll(groupJid, actorJid, question, options, 1, now)
    const result = this.database().prepare(`UPDATE events SET poll_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND group_jid = ? AND poll_id IS NULL AND revision = ?`).run(poll.id, now, event.id, groupJid, event.revision)
    if (result.changes !== 1) return this.getEvent(groupJid, event.id, now)
    this.audit('event.poll.linked', actorJid, groupJid, 'changed', { optionCount: options.length })
    return this.getEvent(groupJid, event.id, now)
  }

  getEvent(groupJid: string, eventId: string, now = this.clock()): EventRecord | undefined {
    validateGroupJid(groupJid)
    const id = this.resolveEventId(groupJid, eventId)
    if (!id) return undefined
    const row = this.database().prepare(`SELECT * FROM events WHERE id = ? AND group_jid = ?`).get(id, groupJid) as EventRow | undefined
    return row ? this.mapEvent(row, now) : undefined
  }

  listEvents(groupJid: string, limit = this.maxListLimit, now = this.clock()): readonly EventRecord[] {
    validateGroupJid(groupJid)
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxListLimit) throw new Error('Invalid event list limit')
    const rows = this.database().prepare(`SELECT * FROM events WHERE group_jid = ? AND status <> 'closed' ORDER BY start_at ASC, id ASC LIMIT ?`).all(groupJid, limit) as EventRow[]
    return rows.map((row) => this.mapEvent(row, now))
  }

  getParticipants(groupJid: string, eventId: string, limit = this.maxListLimit, now = this.clock()): readonly { participantRef: string; joinedAt: number }[] {
    validateGroupJid(groupJid)
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxListLimit) throw new Error('Invalid participant list limit')
    const event = this.requireEvent(groupJid, eventId, now)
    const rows = this.database().prepare(`SELECT user_jid, joined_at FROM event_participants WHERE event_id = ? AND status = 'joined' ORDER BY joined_at ASC LIMIT ?`).all(event.id, limit) as { user_jid: string; joined_at: number }[]
    return rows.map((row) => ({ participantRef: hash(row.user_jid).slice(0, 12), joinedAt: row.joined_at }))
  }

  async dispatchDueEvents(whatsapp: WhatsAppPort, now = this.clock()): Promise<number> {
    if (this.dispatchInFlight) return 0
    this.dispatchInFlight = true
    try {
      const rows = this.database().prepare(`SELECT * FROM events WHERE status IN ('published', 'active') AND (start_at <= ? OR end_at IS NOT NULL AND end_at <= ?) ORDER BY start_at ASC, id ASC LIMIT ?`).all(now, now, this.maxListLimit) as EventRow[]
      let changed = 0
      for (const row of rows) {
        if (!this.isEnabled(row.group_jid)) continue
        changed += await this.dispatchEvent(row, whatsapp, now)
      }
      return changed
    } finally {
      this.dispatchInFlight = false
    }
  }

  startEventDispatcher(whatsapp: WhatsAppPort, intervalMs = this.dispatcherIntervalMs): void {
    if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new Error('intervalMs must be positive')
    this.stopEventDispatcher()
    const run = (label: string): void => {
      if (this.dispatchPromise) return
      const promise = this.dispatchDueEvents(whatsapp)
      this.dispatchPromise = promise
      void promise.catch((error) => this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, `event ${label} failed`)).finally(() => {
        if (this.dispatchPromise === promise) this.dispatchPromise = undefined
      })
    }
    run('startup recovery')
    this.dispatcher = setInterval(() => run('dispatcher tick'), intervalMs)
    this.dispatcher.unref()
  }

  stopEventDispatcher(): void {
    if (this.dispatcher) clearInterval(this.dispatcher)
    this.dispatcher = undefined
  }

  private async dispatchEvent(row: EventRow, whatsapp: WhatsAppPort, now: number): Promise<number> {
    let changed = 0
    if (row.status === 'published' && row.start_at <= now) {
      if (this.applyAutomaticEventTransition(row, 'active', 'event_activate', now)) {
        changed += 1
                  await this.notifyTransition(whatsapp, row.group_jid, row.creator_jid, `📅 Event *${row.title}* dimulai.`)

      }
    }
    const current = this.database().prepare(`SELECT * FROM events WHERE id = ?`).get(row.id) as EventRow | undefined
    if (!current || current.status !== 'active') return changed
    const phases = this.database().prepare(`SELECT * FROM event_phases WHERE event_id = ? AND status IN ('scheduled', 'active') ORDER BY phase_order ASC LIMIT ?`).all(current.id, this.maxPhases) as PhaseRow[]
    for (const phase of phases) {
      if (phase.status === 'scheduled' && phase.start_at <= now) {
        if (this.applyAutomaticPhaseTransition(current, phase, 'active', 'phase_start', now)) {
          changed += 1
          await this.notifyTransition(whatsapp, current.group_jid, current.creator_jid, `▶️ Fase *${phase.phase_order}. ${phase.title}* dimulai.`)
        }
      }
      if (phase.status === 'active' && phase.end_at !== null && phase.end_at <= now) {
        if (this.applyAutomaticPhaseTransition(current, phase, 'completed', 'phase_complete', now)) {
          changed += 1
          await this.notifyTransition(whatsapp, current.group_jid, current.creator_jid, `✅ Fase *${phase.phase_order}. ${phase.title}* selesai.`)
        }
      }
    }
    const latest = this.database().prepare(`SELECT * FROM events WHERE id = ?`).get(current.id) as EventRow | undefined
    if (latest && latest.end_at !== null && latest.end_at <= now && latest.status === 'active' && this.applyAutomaticEventTransition(latest, 'closed', 'event_close', now)) {
      changed += 1
      await this.notifyTransition(whatsapp, latest.group_jid, latest.creator_jid, `⏹️ Event *${latest.title}* ditutup otomatis.`)
    }
    return changed
  }

  private applyAutomaticEventTransition(row: EventRow, target: EventStatus, operationType: EventOperationType, now: number): boolean {
    const operationId = this.operationId(row.id, operationType)
    if (!this.claimOperation(operationId, row, operationType, undefined, now)) return false
    const result = this.database().prepare(`UPDATE events SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND status = ? AND revision = ?`).run(target, now, row.id, row.status, row.revision)
    const changed = result.changes === 1
    this.finishOperation(operationId, changed ? 'succeeded' : 'failed', changed ? 'changed' : 'stale', now)
    if (changed) this.audit(`event.${operationType}`, row.creator_jid, row.group_jid, target === 'closed' ? 'closed' : 'changed', { transition: target })
    return changed
  }

  private applyAutomaticPhaseTransition(event: EventRow, phase: PhaseRow, target: EventPhaseStatus, operationType: EventOperationType, now: number): boolean {
    const operationId = this.operationId(event.id, operationType, phase.id)
    if (!this.claimOperation(operationId, event, operationType, phase.id, now)) return false
    const result = this.database().prepare(`UPDATE event_phases SET status = ?, revision = revision + 1 WHERE id = ? AND event_id = ? AND status = ? AND revision = ?`).run(target, phase.id, event.id, phase.status, phase.revision)
    const changed = result.changes === 1
    this.finishOperation(operationId, changed ? 'succeeded' : 'failed', changed ? 'changed' : 'stale', now)
    if (changed) this.audit(`event.${operationType}`, event.creator_jid, event.group_jid, target === 'completed' ? 'closed' : 'changed', { phaseOrder: phase.phase_order })
    return changed
  }

  private transitionLifecycle(groupJid: string, eventId: string, actorJid: string, target: EventStatus, now: number): EventRecord | undefined {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'event lifecycle actor')
    const event = this.requireEvent(groupJid, eventId, now)
    this.requireCreator(event, actorJid)
    const eventRow = this.database().prepare(`SELECT * FROM events WHERE id = ? AND group_jid = ?`).get(event.id, groupJid) as EventRow | undefined
    if (!eventRow) throw new Error('Event changed concurrently; retry')
    const valid = (event.status === 'draft' && target === 'published') || (['published', 'active'].includes(event.status) && target === 'paused') || (event.status === 'paused' && target === 'active') || (event.status !== 'closed' && target === 'closed')
    if (!valid) {
      this.audit('event.lifecycle.denied', actorJid, groupJid, 'denied', { target })
      throw new Error(`Invalid event transition: ${event.status} -> ${target}`)
    }
    const operationType: EventOperationType = target === 'closed' ? 'event_close' : 'manual_transition'
    const operationId = this.operationId(event.id, operationType, undefined, target)
    if (!this.claimOperation(operationId, eventRow, operationType, undefined, now)) return this.getEvent(groupJid, event.id, now)
    const result = this.database().prepare(`UPDATE events SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND group_jid = ? AND status = ? AND revision = ?`).run(target, now, event.id, groupJid, event.status, event.revision)
    const changed = result.changes === 1
    this.finishOperation(operationId, changed ? 'succeeded' : 'failed', changed ? 'changed' : 'stale', now)
    this.audit(changed ? 'event.lifecycle.changed' : 'event.lifecycle.stale', actorJid, groupJid, changed ? (target === 'closed' ? 'closed' : 'changed') : 'failed', { target })
    return this.getEvent(groupJid, event.id, now)
  }

  private claimOperation(operationId: string, event: EventRow, operationType: EventOperationType, phaseId: string | undefined, now: number): boolean {
    const result = this.database().prepare(`
      INSERT OR IGNORE INTO event_operations (operation_id, event_id, group_jid, operation_type, phase_id, status, correlation_hash, created_at, updated_at, outcome_code)
      VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?, 'planned')
    `).run(operationId, event.id, event.group_jid, operationType, phaseId ?? null, hash(`${event.group_jid}:${event.id}:${operationType}:${phaseId ?? ''}`), now, now)
    if (result.changes === 0) {
      const existing = this.database().prepare(`SELECT status FROM event_operations WHERE operation_id = ?`).get(operationId) as { status: EventOperationStatus } | undefined
      if (existing?.status === 'succeeded') return false
    }
    const claimed = this.database().prepare(`UPDATE event_operations SET status = 'running', updated_at = ?, outcome_code = 'running' WHERE operation_id = ? AND (status = 'planned' OR status = 'failed' OR (status = 'running' AND updated_at <= ?))`).run(now, operationId, now - Math.max(this.dispatcherIntervalMs * 2, 30_000))
    return claimed.changes === 1
  }

  private finishOperation(operationId: string, status: EventOperationStatus, outcomeCode: string, now: number): void {
    this.database().prepare(`UPDATE event_operations SET status = ?, updated_at = ?, outcome_code = ? WHERE operation_id = ? AND status = 'running'`).run(status, now, outcomeCode, operationId)
  }

  private async notifyTransition(whatsapp: WhatsAppPort, groupJid: string, actorJid: string, text: string): Promise<void> {
    const policy = this.personalization?.evaluateGroupNotification(groupJid, this.clock())
    if (policy && !policy.allowed) {
      const key = `${groupJid}:${policy.reason}`
      if (!this.policyAuditKeys.has(key)) {
        this.policyAuditKeys.add(key)
        this.audit('event.notification.limited', actorJid, groupJid, 'limited', { reason: policy.reason })
      }
      return
    }
    this.policyAuditKeys.delete(`${groupJid}:quiet-hours`)
    this.policyAuditKeys.delete(`${groupJid}:policy-disabled`)
    const operation = await runPlatformOperation({
      operationId: `event-notify-${hash(`${groupJid}:${text}`)}`,
      timeoutMs: this.operationTimeoutMs,
      retry: { maxAttempts: 1 },
      execute: async () => whatsapp.sendText(groupJid, text),
    })
    if (!operation.ok) {
      this.audit('event.notification.failed', actorJid, groupJid, 'failed', { errorClass: operation.error instanceof Error ? operation.error.name : 'UnknownError' })
      return
    }
    this.audit('event.notification.sent', actorJid, groupJid, 'changed', { textLength: text.length })
  }

  private requireEvent(groupJid: string, eventId: string, now: number): EventRecord {
    validateId(eventId, 'event id')
    const resolved = this.resolveEventId(groupJid, eventId)
    const row = resolved ? this.database().prepare(`SELECT * FROM events WHERE id = ? AND group_jid = ?`).get(resolved, groupJid) as EventRow | undefined : undefined
    if (!row) throw new Error('Event not found in group')
    return this.mapEvent(row, now)
  }

  private resolveEventId(groupJid: string, eventId: string): string | undefined {
    validateId(eventId, 'event id')
    const exact = this.database().prepare(`SELECT id FROM events WHERE id = ? AND group_jid = ?`).get(eventId, groupJid) as { id: string } | undefined
    if (exact) return exact.id
    if (eventId.length < 4) return undefined
    const matches = this.database().prepare(`SELECT id FROM events WHERE id LIKE ? AND group_jid = ? ORDER BY id ASC LIMIT 2`).all(`${eventId}%`, groupJid) as { id: string }[]
    if (matches.length > 1) throw new Error('Event id prefix is ambiguous')
    return matches[0]?.id
  }

  private requireCreator(event: EventRecord, actorJid: string): void {
    if (event.creatorJid !== actorJid) throw new Error('Only the event creator can author this event')
  }

  private normalizePhases(phases: readonly EventPhaseInput[], eventStartAt: number, eventEndAt: number | undefined): readonly EventPhaseInput[] {
    if (!Array.isArray(phases) || phases.length < 1 || phases.length > this.maxPhases) throw new Error(`Event requires 1-${this.maxPhases} phases`)
    const sorted = [...phases].sort((left, right) => left.order - right.order)
    const orders = new Set<number>()
    return sorted.map((phase, index) => {
      if (!Number.isInteger(phase.order) || phase.order !== index + 1 || orders.has(phase.order)) throw new Error('Phase orders must be contiguous starting at 1')
      orders.add(phase.order)
      validateTimestamp(phase.startAt, 'phase startAt')
      if (phase.startAt < eventStartAt) throw new Error('Phase cannot start before event')
      if (phase.endAt !== undefined) {
        validateTimestamp(phase.endAt, 'phase endAt')
        if (phase.endAt <= phase.startAt) throw new Error('Phase endAt must be after phase startAt')
        if (eventEndAt !== undefined && phase.endAt > eventEndAt) throw new Error('Phase cannot end after event')
      }
      return {
        order: phase.order,
        title: normalizeRequiredText(phase.title, 120, 'phase title'),
        description: normalizeRequiredText(phase.description ?? phase.title, this.maxTextLength, 'phase description'),
        startAt: phase.startAt,
        ...(phase.endAt === undefined ? {} : { endAt: phase.endAt }),
      }
    })
  }

  private mapEvent(row: EventRow, _now: number): EventRecord {
    const phases = this.database().prepare(`SELECT * FROM event_phases WHERE event_id = ? ORDER BY phase_order ASC LIMIT ?`).all(row.id, this.maxPhases) as PhaseRow[]
    const count = this.database().prepare(`SELECT COUNT(*) AS count FROM event_participants WHERE event_id = ? AND status = 'joined'`).get(row.id) as { count: number }
    return {
      id: row.id,
      groupJid: row.group_jid,
      creatorJid: row.creator_jid,
      title: row.title,
      description: row.description,
      timezone: row.timezone,
      startAt: row.start_at,
      ...(row.end_at === null ? {} : { endAt: row.end_at }),
      status: row.status,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.location_label === null ? {} : { locationLabel: row.location_label }),
      ...(row.location_latitude === null ? {} : { locationLatitude: row.location_latitude }),
      ...(row.location_longitude === null ? {} : { locationLongitude: row.location_longitude }),
      ...(row.poll_id === null ? {} : { pollId: row.poll_id }),
      phases: phases.map(mapPhase),
      participantCount: count.count,
    }
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        creator_jid TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        timezone TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'active', 'paused', 'closed')),
        revision INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        location_label TEXT,
        location_latitude REAL,
        location_longitude REAL,
        poll_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_group_start ON events(group_jid, start_at, id);
      CREATE INDEX IF NOT EXISTS idx_events_dispatch ON events(status, start_at, end_at);
      CREATE TABLE IF NOT EXISTS event_phases (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        phase_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'active', 'completed', 'skipped')),
        revision INTEGER NOT NULL DEFAULT 0,
        UNIQUE(event_id, phase_order)
      );
      CREATE INDEX IF NOT EXISTS idx_event_phases_due ON event_phases(event_id, status, start_at, end_at);
      CREATE TABLE IF NOT EXISTS event_participants (
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        user_jid TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('joined', 'left')),
        joined_at INTEGER NOT NULL,
        left_at INTEGER,
        revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(event_id, user_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_event_participants_active ON event_participants(event_id, status, joined_at);
      CREATE TABLE IF NOT EXISTS event_operations (
        operation_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        group_jid TEXT NOT NULL,
        operation_type TEXT NOT NULL,
        phase_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'succeeded', 'failed')),
        correlation_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        outcome_code TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_event_operations_event ON event_operations(event_id, created_at);
    `)
  }

  private operationId(eventId: string, operationType: EventOperationType, phaseId?: string, target?: string): string {
    return hash(`${eventId}:${operationType}:${phaseId ?? ''}:${target ?? ''}`)
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('Event service is not initialized')
    return this.db
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('Event service has not been initialized')
    return this.guardrails
  }

  private requireEnabled(groupJid: string): void {
    validateGroupJid(groupJid)
    if (!this.isEnabled(groupJid)) throw new Error('Event feature is disabled for this group')
  }

  private audit(eventType: string, actorJid: string, resourceJid: string, outcome: AuditOutcome, metadata: Record<string, unknown>): void {
    try {
      this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), actorJid, resourceJid, outcome, metadata })
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError', eventType }, 'event audit unavailable')
    }
  }

  private transaction<T>(operation: () => T): T {
    return this.database().transaction(operation)()
  }
}
