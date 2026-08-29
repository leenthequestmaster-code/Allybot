import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'
import { initSqliteDatabase, sha256, validateJid as validateJidShared, validateGroupJid as validateGroupJidShared, type DatabaseInstance } from '../storage-helpers.js'

export const KNOWLEDGE_FEATURE_ID = 'group.knowledge.core'
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_EXCERPT_LENGTH = 2_000
const MAX_TITLE_LENGTH = 120
const MAX_LIST_LIMIT = 50
const MAX_EXPORT_RECORDS = 50

type KnowledgeStatus = 'active' | 'retired' | 'deleted'
type KnowledgeVisibility = 'group' | 'private'

interface KnowledgeRow {
  id: string
  group_jid: string
  creator_jid: string
  visibility: KnowledgeVisibility
  title: string
  excerpt: string
  excerpt_hash: string
  source_message_hash: string | null
  source_sender_hash: string | null
  source_timestamp: number | null
  created_at: number
  retention_until: number
  status: KnowledgeStatus
  deleted_at: number | null
  deleted_by: string | null
}

export interface KnowledgeRecord {
  readonly id: string
  readonly groupJid: string
  readonly creatorJid: string
  readonly visibility: KnowledgeVisibility
  readonly title: string
  readonly excerpt: string
  readonly excerptHash: string
  readonly sourceMessageHash?: string
  readonly sourceSenderHash?: string
  readonly sourceTimestamp?: number
  readonly createdAt: number
  readonly retentionUntil: number
  readonly status: KnowledgeStatus
  readonly deletedAt?: number
  readonly deletedBy?: string
}

export interface KnowledgeOptions {
  readonly clock?: () => number
  readonly maxExcerptLength?: number
  readonly maxListLimit?: number
  readonly defaultRetentionMs?: number
}

const hashIdentifier = (value: string): string => sha256(value, 64)
const hashReference = (value: string): string => sha256(value, 16)

function validateJid(value: string, field: string): void {
  validateJidShared(value, field)
}

function validateGroupJid(value: string): void {
  try {
    validateGroupJidShared(value)
  } catch {
    throw new Error('groupJid must be a valid group JID')
  }
}

function normalizeText(value: string, maxLength: number, field: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.length > maxLength) throw new Error(`${field} is too long`)
  if (/bearer\s+[A-Za-z0-9._-]+/i.test(normalized) || /BEGIN (?:RSA|OPENSSH|PRIVATE)/i.test(normalized)) {
    throw new Error(`${field} contains sensitive-looking content`)
  }
  return normalized
}

function validateLimit(value: number, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error('Invalid list limit')
  return value
}

function mapRecord(row: KnowledgeRow): KnowledgeRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    creatorJid: row.creator_jid,
    visibility: row.visibility,
    title: row.title,
    excerpt: row.excerpt,
    excerptHash: row.excerpt_hash,
    ...(row.source_message_hash ? { sourceMessageHash: row.source_message_hash } : {}),
    ...(row.source_sender_hash ? { sourceSenderHash: row.source_sender_hash } : {}),
    ...(row.source_timestamp === null ? {} : { sourceTimestamp: row.source_timestamp }),
    createdAt: row.created_at,
    retentionUntil: row.retention_until,
    status: row.status,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
    ...(row.deleted_by === null ? {} : { deletedBy: row.deleted_by }),
  }
}

function isVisible(record: KnowledgeRecord, actorJid: string): boolean {
  return record.visibility === 'group' || record.creatorJid === actorJid
}

export class KnowledgeService implements Service {
  readonly name = 'knowledge'
  readonly dependencies = ['platform-guardrails'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly maxExcerptLength: number
  private readonly maxListLimit: number
  private readonly defaultRetentionMs: number
  private readonly logger: Logger
  private db: DatabaseInstance | undefined
  private guardrails: PlatformGuardrailService | undefined

  constructor(databasePath: string, logger: Logger, options: KnowledgeOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.maxExcerptLength = options.maxExcerptLength ?? MAX_EXCERPT_LENGTH
    this.maxListLimit = options.maxListLimit ?? MAX_LIST_LIMIT
    this.defaultRetentionMs = options.defaultRetentionMs ?? DEFAULT_RETENTION_MS
    this.logger = logger.child({ component: 'knowledge' })
    if (!Number.isInteger(this.maxExcerptLength) || this.maxExcerptLength < 1 || this.maxExcerptLength > MAX_EXCERPT_LENGTH) throw new Error('maxExcerptLength is invalid')
    if (!Number.isInteger(this.maxListLimit) || this.maxListLimit < 1 || this.maxListLimit > MAX_LIST_LIMIT) throw new Error('maxListLimit is invalid')
    if (!Number.isInteger(this.defaultRetentionMs) || this.defaultRetentionMs < 60_000 || this.defaultRetentionMs > 365 * 24 * 60 * 60 * 1_000) throw new Error('defaultRetentionMs is invalid')
  }

  initialize(context: ServiceContext): void {
    this.guardrails = context.services.get<PlatformGuardrailService>('platform-guardrails')
    this.db = initSqliteDatabase(this.databasePath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        creator_jid TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('group', 'private')),
        title TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        excerpt_hash TEXT NOT NULL,
        source_message_hash TEXT,
        source_sender_hash TEXT,
        source_timestamp INTEGER,
        created_at INTEGER NOT NULL,
        retention_until INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'retired', 'deleted')),
        deleted_at INTEGER,
        deleted_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_knowledge_group_status ON knowledge_sources(group_jid, status, retention_until, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_knowledge_creator ON knowledge_sources(group_jid, creator_jid, status, created_at DESC);
    `)
  }

  shutdown(): void {
    this.db?.close()
    this.db = undefined
  }

  isEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().isFeatureEnabled(groupJid, KNOWLEDGE_FEATURE_ID)
  }

  setEnabled(groupJid: string, enabled: boolean, actorJid: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'knowledge feature actor')
    this.guardrailService().setFeatureFlag(groupJid, KNOWLEDGE_FEATURE_ID, enabled, actorJid, `knowledge-${now}`, now)
    this.audit('knowledge.feature.changed', actorJid, groupJid, 'changed', { enabled })
    return enabled
  }

  createBookmark(input: {
    readonly groupJid: string
    readonly creatorJid: string
    readonly title?: string
    readonly excerpt: string
    readonly visibility?: KnowledgeVisibility
    readonly sourceMessageId?: string
    readonly sourceSenderJid?: string
    readonly sourceTimestamp?: number
    readonly retentionMs?: number
    readonly now?: number
  }): KnowledgeRecord {
    const now = input.now ?? this.clock()
    validateGroupJid(input.groupJid)
    this.requireEnabled(input.groupJid)
    validateJid(input.creatorJid, 'knowledge creator')
    const title = normalizeText(input.title ?? 'Untitled bookmark', MAX_TITLE_LENGTH, 'bookmark title')
    const excerpt = normalizeText(input.excerpt, this.maxExcerptLength, 'bookmark excerpt')
    const visibility = input.visibility ?? 'group'
    if (visibility !== 'group' && visibility !== 'private') throw new Error('Invalid bookmark visibility')
    if (input.sourceSenderJid) validateJid(input.sourceSenderJid, 'source sender')
    if (input.sourceTimestamp !== undefined && (!Number.isInteger(input.sourceTimestamp) || input.sourceTimestamp < 0)) throw new Error('Invalid source timestamp')
    const retentionMs = input.retentionMs ?? this.defaultRetentionMs
    if (!Number.isInteger(retentionMs) || retentionMs < 60_000 || retentionMs > 365 * 24 * 60 * 60 * 1_000) throw new Error('Invalid retention window')
    const id = randomUUID()
    const record = this.database().transaction(() => {
      this.database().prepare(`INSERT INTO knowledge_sources (id, group_jid, creator_jid, visibility, title, excerpt, excerpt_hash, source_message_hash, source_sender_hash, source_timestamp, created_at, retention_until, status, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL)`).run(
        id,
        input.groupJid,
        input.creatorJid,
        visibility,
        title,
        excerpt,
        hashIdentifier(excerpt),
        input.sourceMessageId ? hashIdentifier(input.sourceMessageId) : null,
        input.sourceSenderJid ? hashIdentifier(input.sourceSenderJid) : null,
        input.sourceTimestamp ?? null,
        now,
        now + retentionMs,
      )
      return this.getSource(id, now)
    })()
    if (!record) throw new Error('Failed to create knowledge bookmark')
    this.audit('knowledge.bookmark.created', input.creatorJid, input.groupJid, 'changed', { sourceRefHash: hashReference(id), visibility, excerptLength: excerpt.length, retentionMs })
    return record
  }

  getSource(id: string, now = this.clock()): KnowledgeRecord | undefined {
    const row = this.database().prepare(`SELECT * FROM knowledge_sources WHERE id = ?`).get(id) as KnowledgeRow | undefined
    if (!row) return undefined
    if (row.status === 'active' && row.retention_until <= now) {
      this.retireExpired(now, id)
      return this.getSource(id, now)
    }
    return mapRecord(row)
  }

  findSource(groupJid: string, idPrefix: string, actorJid: string, now = this.clock()): KnowledgeRecord | undefined {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'knowledge reader')
    if (!idPrefix || idPrefix.length < 4 || !/^[a-f0-9-]+$/i.test(idPrefix)) return undefined
    const rows = this.database().prepare(`SELECT * FROM knowledge_sources WHERE group_jid = ? AND id LIKE ? ORDER BY created_at DESC LIMIT 2`).all(groupJid, `${idPrefix}%`) as KnowledgeRow[]
    const record = rows.length === 1 ? this.getSource(rows[0].id, now) : undefined
    return record && record.status === 'active' && isVisible(record, actorJid) ? record : undefined
  }

  listSources(groupJid: string, actorJid: string, status: KnowledgeStatus = 'active', limit = this.maxListLimit, now = this.clock()): readonly KnowledgeRecord[] {
    validateGroupJid(groupJid)
    this.retireExpired(now)
    validateJid(actorJid, 'knowledge reader')
    if (!['active', 'retired', 'deleted'].includes(status)) throw new Error('Invalid knowledge status')
    const safeLimit = validateLimit(limit, this.maxListLimit)
    const rows = this.database().prepare(`SELECT * FROM knowledge_sources WHERE group_jid = ? AND status = ? ORDER BY created_at DESC LIMIT ?`).all(groupJid, status, safeLimit) as KnowledgeRow[]
    return rows.map(mapRecord).filter((record) => status !== 'active' || isVisible(record, actorJid)).filter((record) => status !== 'active' || record.retentionUntil > now)
  }

  deleteSource(groupJid: string, id: string, actorJid: string, now = this.clock()): KnowledgeRecord | undefined {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateJid(actorJid, 'knowledge deleter')
    const record = this.findOwnedSource(groupJid, id, actorJid, now)
    if (!record || record.status !== 'active') return undefined
    const result = this.database().prepare(`UPDATE knowledge_sources SET status = 'deleted', deleted_at = ?, deleted_by = ?, excerpt = '', excerpt_hash = '' WHERE id = ? AND group_jid = ? AND status = 'active'`).run(now, actorJid, record.id, groupJid)
    if (result.changes !== 1) return undefined
    const deleted = this.getSource(record.id, now)
    this.audit('knowledge.bookmark.deleted', actorJid, groupJid, 'changed', { sourceRefHash: hashReference(record.id) })
    return deleted
  }

  retireSource(groupJid: string, id: string, actorJid: string, now = this.clock()): KnowledgeRecord | undefined {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateJid(actorJid, 'knowledge retirer')
    const record = this.findOwnedSource(groupJid, id, actorJid, now)
    if (!record || record.status !== 'active') return undefined
    const result = this.database().prepare(`UPDATE knowledge_sources SET status = 'retired' WHERE id = ? AND group_jid = ? AND status = 'active'`).run(record.id, groupJid)
    if (result.changes !== 1) return undefined
    const retired = this.getSource(record.id, now)
    this.audit('knowledge.bookmark.retired', actorJid, groupJid, 'changed', { sourceRefHash: hashReference(record.id) })
    return retired
  }

  searchSources(groupJid: string, actorJid: string, query: string, limit = 10, now = this.clock()): readonly KnowledgeRecord[] {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    this.retireExpired(now)
    validateJid(actorJid, 'knowledge reader')
    const normalizedQuery = query.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!normalizedQuery || normalizedQuery.length > 80) throw new Error('Kata pencarian harus berisi 1-80 karakter')
    const safeLimit = validateLimit(limit, Math.min(this.maxListLimit, 25))
    const escaped = normalizedQuery.replace(/[\\%_]/g, '\\$&')
    const rows = this.database().prepare(`SELECT * FROM knowledge_sources WHERE group_jid = ? AND status = 'active' AND retention_until > ? AND (lower(title) LIKE lower(?) ESCAPE '\\' OR lower(excerpt) LIKE lower(?) ESCAPE '\\') ORDER BY created_at DESC LIMIT ?`).all(groupJid, now, `%${escaped}%`, `%${escaped}%`, safeLimit) as KnowledgeRow[]
    const records = rows.map(mapRecord).filter((record) => isVisible(record, actorJid))
    this.audit('knowledge.search', actorJid, groupJid, 'allowed', { queryLength: normalizedQuery.length, resultCount: records.length })
    return records
  }

  exportSources(groupJid: string, actorJid: string, now = this.clock()): readonly KnowledgeRecord[] {
    const records = this.listSources(groupJid, actorJid, 'active', MAX_EXPORT_RECORDS, now)
    this.audit('knowledge.export.created', actorJid, groupJid, 'allowed', { recordCount: records.length })
    return records
  }

  private findOwnedSource(groupJid: string, idPrefix: string, actorJid: string, now: number): KnowledgeRecord | undefined {
    const record = this.findSource(groupJid, idPrefix, actorJid, now)
    return record && record.creatorJid === actorJid ? record : undefined
  }

  private retireExpired(now: number, id?: string): void {
    const query = id ? `UPDATE knowledge_sources SET status = 'retired' WHERE id = ? AND status = 'active' AND retention_until <= ?` : `UPDATE knowledge_sources SET status = 'retired' WHERE status = 'active' AND retention_until <= ?`
    const result = id ? this.database().prepare(query).run(id, now) : this.database().prepare(query).run(now)
    if (result.changes > 0) this.logger.info({ expiredCount: result.changes }, 'knowledge retention applied')
  }

  private requireEnabled(groupJid: string): void {
    if (!this.isEnabled(groupJid)) throw new Error('Knowledge feature is disabled for this group')
  }

  private audit(eventType: string, actorJid: string, groupJid: string, outcomeCode: string, metadata: Record<string, unknown>): void {
    this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), actorJid, resourceJid: groupJid, outcome: outcomeCode as 'allowed' | 'denied' | 'changed' | 'failed' | 'limited' | 'opened' | 'closed', metadata })
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('KnowledgeService has not been initialized')
    return this.guardrails
  }

  private database(): DatabaseInstance {
    if (!this.db) throw new Error('KnowledgeService has not been initialized')
    return this.db
  }
}
