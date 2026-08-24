import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { isJid } from '../platform/validation.js'
import { KnowledgeService } from './knowledge-service.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'

export const CANON_FEATURE_ID = 'group.canon.core'
export const CANON_STATUSES = ['draft', 'proposed', 'approved', 'superseded', 'retired'] as const
export type CanonStatus = (typeof CANON_STATUSES)[number]
export type CanonHistoryAction = 'created' | 'proposed' | 'rejected' | 'approved' | 'superseded' | 'retired'

export interface CanonRecord {
  readonly id: string
  readonly groupJid: string
  readonly creatorJid: string
  readonly title: string
  readonly content: string
  readonly contentHash: string
  readonly status: CanonStatus
  readonly revision: number
  readonly sourceId?: string
  readonly supersedesId?: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly approvedAt?: number
}

export interface CanonHistoryRecord {
  readonly id: number
  readonly canonId: string
  readonly groupJid: string
  readonly revision: number
  readonly action: CanonHistoryAction
  readonly actorJid: string
  readonly fromStatus?: CanonStatus
  readonly toStatus: CanonStatus
  readonly contentHash: string
  readonly sourceId?: string
  readonly createdAt: number
}

export interface CanonSearchResult {
  readonly records: readonly CanonRecord[]
  readonly uncertainty: 'none' | 'conflicting-approved-records'
}

export interface CanonServiceOptions {
  readonly clock?: () => number
  readonly maxSearchResults?: number
}

interface CanonRow {
  id: string
  group_jid: string
  creator_jid: string
  title: string
  content: string
  content_hash: string
  status: CanonStatus
  revision: number
  source_id: string | null
  supersedes_id: string | null
  created_at: number
  updated_at: number
  approved_at: number | null
}

interface HistoryRow {
  id: number
  canon_id: string
  group_jid: string
  revision: number
  action: CanonHistoryAction
  actor_jid: string
  from_status: CanonStatus | null
  to_status: CanonStatus
  content_hash: string
  source_id: string | null
  created_at: number
}

const MAX_TITLE_LENGTH = 120
const MAX_CONTENT_LENGTH = 4_000
const MAX_SEARCH_LENGTH = 120
const MAX_SEARCH_RESULTS = 50

function validateJid(value: string, field: string): void {
  if (value.length > 128 || !isJid(value)) throw new Error(`${field} must be a valid JID`)
}

function validateGroupJid(value: string): void {
  validateJid(value, 'groupJid')
  if (!value.endsWith('@g.us')) throw new Error('groupJid must be a valid group JID')
}

function normalizeText(value: string, maxLength: number, field: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) throw new Error(`${field} cannot be empty`)
  if (normalized.length > maxLength) throw new Error(`${field} exceeds ${maxLength} characters`)
  if (/bearer\s+[A-Za-z0-9._-]+/i.test(normalized) || /BEGIN (?:RSA|OPENSSH|PRIVATE)/i.test(normalized)) throw new Error(`${field} contains sensitive-looking content`)
  return normalized
}

function normalizeContent(value: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error('Canon content cannot be empty')
  if (normalized.length > MAX_CONTENT_LENGTH) throw new Error(`Canon content exceeds ${MAX_CONTENT_LENGTH} characters`)
  if (/bearer\s+[A-Za-z0-9._-]+/i.test(normalized) || /BEGIN (?:RSA|OPENSSH|PRIVATE)/i.test(normalized)) throw new Error('Canon content contains sensitive-looking content')
  return normalized
}

function normalizeReference(value: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 64 || !/^[a-f0-9-]+$/i.test(normalized)) throw new Error('canon id must be a valid reference')
  return normalized
}

function mapCanon(row: CanonRow): CanonRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    creatorJid: row.creator_jid,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    status: row.status,
    revision: row.revision,
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
    ...(row.supersedes_id === null ? {} : { supersedesId: row.supersedes_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.approved_at === null ? {} : { approvedAt: row.approved_at }),
  }
}

function mapHistory(row: HistoryRow): CanonHistoryRecord {
  return {
    id: row.id,
    canonId: row.canon_id,
    groupJid: row.group_jid,
    revision: row.revision,
    action: row.action,
    actorJid: row.actor_jid,
    ...(row.from_status === null ? {} : { fromStatus: row.from_status }),
    toStatus: row.to_status,
    contentHash: row.content_hash,
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
    createdAt: row.created_at,
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class CanonService implements Service {
  readonly name = 'canon'
  readonly dependencies = ['platform-guardrails', 'knowledge'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly maxSearchResults: number
  private readonly logger: Logger
  private db: Database.Database | undefined
  private guardrails: PlatformGuardrailService | undefined
  private knowledge: KnowledgeService | undefined

  constructor(databasePath: string, logger: Logger, options: CanonServiceOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.maxSearchResults = options.maxSearchResults ?? MAX_SEARCH_RESULTS
    if (!Number.isInteger(this.maxSearchResults) || this.maxSearchResults < 1 || this.maxSearchResults > MAX_SEARCH_RESULTS) throw new Error('maxSearchResults is invalid')
    this.logger = logger.child({ component: 'canon' })
  }

  initialize(context: ServiceContext): void {
    this.guardrails = context.services.get<PlatformGuardrailService>('platform-guardrails')
    this.knowledge = context.services.get<KnowledgeService>('knowledge')
    if (this.databasePath !== ':memory:') mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
    this.logger.info('canon storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
    this.knowledge = undefined
  }

  isEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().isFeatureEnabled(groupJid, CANON_FEATURE_ID)
  }

  setEnabled(groupJid: string, enabled: boolean, actorJid: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'canon feature actor')
    this.guardrailService().setFeatureFlag(groupJid, CANON_FEATURE_ID, enabled, actorJid, `canon-${now}`, now)
    this.audit('canon.feature.changed', actorJid, groupJid, 'changed', { enabled })
    return enabled
  }

  addCanon(input: {
    readonly groupJid: string
    readonly creatorJid: string
    readonly title: string
    readonly content: string
    readonly sourceId?: string
    readonly now?: number
  }): CanonRecord {
    const now = input.now ?? this.clock()
    validateGroupJid(input.groupJid)
    validateJid(input.creatorJid, 'canon creator')
    this.requireEnabled(input.groupJid)
    const title = normalizeText(input.title, MAX_TITLE_LENGTH, 'Canon title')
    const content = normalizeContent(input.content)
    const sourceId = input.sourceId ? this.validateSource(input.groupJid, input.sourceId, input.creatorJid, now) : undefined
    const id = randomUUID()
    const record: CanonRecord = {
      id,
      groupJid: input.groupJid,
      creatorJid: input.creatorJid,
      title,
      content,
      contentHash: hashText(content),
      status: 'draft',
      revision: 0,
      ...(sourceId ? { sourceId } : {}),
      createdAt: now,
      updatedAt: now,
    }
    const transaction = this.database().transaction(() => {
      this.database().prepare(`INSERT INTO canon_entries (id, group_jid, creator_jid, title, content, content_hash, status, revision, source_id, supersedes_id, created_at, updated_at, approved_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', 0, ?, NULL, ?, ?, NULL)`).run(id, input.groupJid, input.creatorJid, title, content, record.contentHash, sourceId ?? null, now, now)
      this.appendHistory(id, input.groupJid, 0, 'created', input.creatorJid, null, 'draft', record.contentHash, sourceId, now)
    })
    transaction()
    this.audit('canon.created', input.creatorJid, input.groupJid, 'changed', { status: 'draft', contentLength: content.length, hasSource: Boolean(sourceId) })
    return record
  }

  getVisible(groupJid: string, reference: string, actorJid: string): CanonRecord | undefined {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'canon reader')
    this.requireEnabled(groupJid)
    const record = this.findCanon(groupJid, reference)
    if (!record) return undefined
    if (record.status === 'approved') return record
    return record.creatorJid === actorJid ? record : undefined
  }

  listVisible(groupJid: string, actorJid: string, limit = this.maxSearchResults): readonly CanonRecord[] {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'canon reader')
    this.requireEnabled(groupJid)
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxSearchResults) throw new Error('Invalid canon list limit')
    const rows = this.database().prepare(`SELECT * FROM canon_entries WHERE group_jid = ? AND (status = 'approved' OR creator_jid = ?) ORDER BY updated_at DESC LIMIT ?`).all(groupJid, actorJid, limit) as CanonRow[]
    return rows.map(mapCanon)
  }

  propose(groupJid: string, reference: string, actorJid: string, expectedRevision?: number, now = this.clock()): CanonRecord {
    return this.transition(groupJid, reference, actorJid, 'proposed', 'proposed', 'changed', expectedRevision, now, (record) => {
      if (record.creatorJid !== actorJid) throw new Error('Only the canon creator can propose this entry')
      if (record.status !== 'draft') throw new Error('Only a draft canon entry can be proposed')
    })
  }

  reject(groupJid: string, reference: string, actorJid: string, expectedRevision?: number, now = this.clock()): CanonRecord {
    return this.transition(groupJid, reference, actorJid, 'draft', 'rejected', 'changed', expectedRevision, now, (record) => {
      if (record.status !== 'proposed') throw new Error('Only a proposed canon entry can be rejected')
    })
  }

  approve(groupJid: string, reference: string, actorJid: string, expectedRevision?: number, now = this.clock()): CanonRecord {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'canon approver')
    this.requireEnabled(groupJid)
    const current = this.requireCanon(groupJid, reference)
    if (current.status !== 'proposed') throw new Error('Only a proposed canon entry can be approved')
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error('Canon revision is stale')
    const transaction = this.database().transaction(() => {
      const result = this.database().prepare(`UPDATE canon_entries SET status = 'approved', revision = revision + 1, updated_at = ?, approved_at = ? WHERE id = ? AND group_jid = ? AND status = 'proposed' AND revision = ?`).run(now, now, current.id, groupJid, current.revision)
      if (result.changes !== 1) throw new Error('Canon revision is stale')
      this.appendHistory(current.id, groupJid, current.revision + 1, 'approved', actorJid, 'proposed', 'approved', current.contentHash, current.sourceId, now)
      const previous = this.database().prepare(`SELECT * FROM canon_entries WHERE group_jid = ? AND title = ? AND status = 'approved' AND id <> ? ORDER BY approved_at DESC LIMIT 1`).get(groupJid, current.title, current.id) as CanonRow | undefined
      if (previous) {
        const supersedeResult = this.database().prepare(`UPDATE canon_entries SET status = 'superseded', revision = revision + 1, updated_at = ?, supersedes_id = ? WHERE id = ? AND group_jid = ? AND status = 'approved'`).run(now, current.id, previous.id, groupJid)
        if (supersedeResult.changes === 1) this.appendHistory(previous.id, groupJid, previous.revision + 1, 'superseded', actorJid, 'approved', 'superseded', previous.content_hash, previous.source_id ?? undefined, now)
      }
    })
    transaction()
    const approved = this.requireCanon(groupJid, current.id)
    this.audit('canon.approved', actorJid, groupJid, 'changed', { status: 'approved', revision: approved.revision, hasSource: Boolean(approved.sourceId) })
    return approved
  }

  retire(groupJid: string, reference: string, actorJid: string, expectedRevision?: number, now = this.clock()): CanonRecord {
    return this.transition(groupJid, reference, actorJid, 'retired', 'retired', 'closed', expectedRevision, now, (record) => {
      if (record.status !== 'approved' && record.status !== 'superseded') throw new Error('Only approved or superseded canon can be retired')
    })
  }

  search(groupJid: string, actorJid: string, query: string, limit = this.maxSearchResults): CanonSearchResult {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'canon searcher')
    this.requireEnabled(groupJid)
    const normalizedQuery = normalizeText(query, MAX_SEARCH_LENGTH, 'Canon search')
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxSearchResults) throw new Error('Invalid canon search limit')
    const pattern = `%${normalizedQuery.replace(/[\\%_]/g, '\\$&')}%`
    const rows = this.database().prepare(`SELECT * FROM canon_entries WHERE group_jid = ? AND status = 'approved' AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') ORDER BY approved_at DESC, id ASC LIMIT ?`).all(groupJid, pattern, pattern, limit) as CanonRow[]
    const records = rows.map(mapCanon)
    const grouped = new Map<string, Set<string>>()
    for (const record of records) {
      const key = record.title.toLowerCase()
      const hashes = grouped.get(key) ?? new Set<string>()
      hashes.add(record.contentHash)
      grouped.set(key, hashes)
    }
    const uncertainty = [...grouped.values()].some((hashes) => hashes.size > 1) ? 'conflicting-approved-records' : 'none'
    this.audit('canon.search', actorJid, groupJid, 'allowed', { matchCount: records.length, uncertainty })
    return { records, uncertainty }
  }

  history(groupJid: string, reference: string, actorJid: string): readonly CanonHistoryRecord[] {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'canon history reader')
    this.requireEnabled(groupJid)
    const record = this.getVisible(groupJid, reference, actorJid)
    if (!record) return []
    const rows = this.database().prepare(`SELECT * FROM canon_history WHERE group_jid = ? AND canon_id = ? ORDER BY revision ASC, id ASC LIMIT 100`).all(groupJid, record.id) as HistoryRow[]
    this.audit('canon.history.read', actorJid, groupJid, 'allowed', { recordCount: rows.length })
    return rows.map(mapHistory)
  }

  private transition(
    groupJid: string,
    reference: string,
    actorJid: string,
    target: CanonStatus,
    action: CanonHistoryAction,
    outcome: 'changed' | 'closed',
    expectedRevision: number | undefined,
    now: number,
    guard: (record: CanonRecord) => void,
  ): CanonRecord {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'canon actor')
    this.requireEnabled(groupJid)
    const current = this.requireCanon(groupJid, reference)
    guard(current)
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error('Canon revision is stale')
    const transaction = this.database().transaction(() => {
      const result = this.database().prepare(`UPDATE canon_entries SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND group_jid = ? AND status = ? AND revision = ?`).run(target, now, current.id, groupJid, current.status, current.revision)
      if (result.changes !== 1) throw new Error('Canon revision is stale')
      this.appendHistory(current.id, groupJid, current.revision + 1, action, actorJid, current.status, target, current.contentHash, current.sourceId, now)
    })
    transaction()
    const updated = this.requireCanon(groupJid, current.id)
    this.audit(`canon.${action}`, actorJid, groupJid, outcome, { status: target, revision: updated.revision })
    return updated
  }

  private findCanon(groupJid: string, reference: string): CanonRecord | undefined {
    const normalized = normalizeReference(reference)
    const exact = this.database().prepare(`SELECT * FROM canon_entries WHERE group_jid = ? AND id = ?`).get(groupJid, normalized) as CanonRow | undefined
    if (exact) return mapCanon(exact)
    const rows = this.database().prepare(`SELECT * FROM canon_entries WHERE group_jid = ? AND id LIKE ? ORDER BY id ASC LIMIT 2`).all(groupJid, `${normalized}%`) as CanonRow[]
    if (rows.length > 1) throw new Error('Canon reference is ambiguous; use more characters')
    return rows[0] ? mapCanon(rows[0]) : undefined
  }

  private requireCanon(groupJid: string, reference: string): CanonRecord {
    const record = this.findCanon(groupJid, reference)
    if (!record) throw new Error('Canon entry tidak ditemukan pada grup ini')
    return record
  }

  private validateSource(groupJid: string, sourceId: string, actorJid: string, now: number): string {
    const normalized = normalizeReference(sourceId)
    const source = this.knowledgeService().findSource(groupJid, normalized, actorJid, now)
    if (!source || source.status !== 'active') throw new Error('Source reference tidak ditemukan atau tidak terlihat')
    return source.id
  }

  private appendHistory(canonId: string, groupJid: string, revision: number, action: CanonHistoryAction, actorJid: string, fromStatus: CanonStatus | null, toStatus: CanonStatus, contentHash: string, sourceId: string | undefined, now: number): void {
    this.database().prepare(`INSERT INTO canon_history (canon_id, group_jid, revision, action, actor_jid, from_status, to_status, content_hash, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(canonId, groupJid, revision, action, actorJid, fromStatus, toStatus, contentHash, sourceId ?? null, now)
  }

  private requireEnabled(groupJid: string): void {
    if (!this.isEnabled(groupJid)) throw new Error('Canon feature is disabled for this group')
  }

  private audit(eventType: string, actorJid: string, groupJid: string, outcome: 'allowed' | 'denied' | 'changed' | 'failed' | 'limited' | 'opened' | 'closed', metadata: Record<string, unknown>): void {
    this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), actorJid, resourceJid: groupJid, outcome, metadata })
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('CanonService has not been initialized')
    return this.guardrails
  }

  private knowledgeService(): KnowledgeService {
    if (!this.knowledge) throw new Error('KnowledgeService has not been initialized')
    return this.knowledge
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('CanonService has not been initialized')
    return this.db
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS canon_entries (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        creator_jid TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'proposed', 'approved', 'superseded', 'retired')),
        revision INTEGER NOT NULL,
        source_id TEXT,
        supersedes_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        approved_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_canon_entries_group_status ON canon_entries (group_jid, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_canon_entries_group_title ON canon_entries (group_jid, title, status, approved_at DESC);
      CREATE TABLE IF NOT EXISTS canon_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        canon_id TEXT NOT NULL,
        group_jid TEXT NOT NULL,
        revision INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('created', 'proposed', 'rejected', 'approved', 'superseded', 'retired')),
        actor_jid TEXT NOT NULL,
        from_status TEXT CHECK (from_status IS NULL OR from_status IN ('draft', 'proposed', 'approved', 'superseded', 'retired')),
        to_status TEXT NOT NULL CHECK (to_status IN ('draft', 'proposed', 'approved', 'superseded', 'retired')),
        content_hash TEXT NOT NULL,
        source_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_canon_history_scope ON canon_history (group_jid, canon_id, revision, id);
    `)
  }
}
