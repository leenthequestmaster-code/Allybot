import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { isJid, isSafeIdentifier } from '../platform/validation.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'

export const SCENE_FEATURE_ID = 'group.scene.core'
export const SCENE_VISIBILITIES = ['public', 'private'] as const
export const SCENE_STATUSES = ['open', 'paused', 'closed', 'expired'] as const
export const SCENE_MODES = ['ic', 'ooc'] as const
export const SCENE_CONSENT_ACTIONS = ['participate', 'share_context', 'receive_assistance'] as const
export type SceneVisibility = (typeof SCENE_VISIBILITIES)[number]
export type SceneStatus = (typeof SCENE_STATUSES)[number]
export type SceneMode = (typeof SCENE_MODES)[number]
export type SceneConsentAction = (typeof SCENE_CONSENT_ACTIONS)[number]
export type SceneParticipantStatus = 'active' | 'left'

export interface SceneRecord {
  readonly id: string
  readonly groupJid: string
  readonly creatorJid: string
  readonly title: string
  readonly visibility: SceneVisibility
  readonly status: SceneStatus
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt?: number
}

export interface SceneParticipantRecord {
  readonly sceneId: string
  readonly userJid: string
  readonly role: 'owner' | 'participant'
  readonly status: SceneParticipantStatus
  readonly mode: SceneMode
  readonly joinedAt: number
  readonly leftAt?: number
  readonly updatedAt: number
}

export interface SceneConsentRecord {
  readonly sceneId: string
  readonly userJid: string
  readonly action: SceneConsentAction
  readonly enabled: boolean
  readonly grantedAt: number
  readonly expiresAt?: number
  readonly updatedAt: number
}

export interface SceneView {
  readonly scene: SceneRecord
  readonly participant?: SceneParticipantRecord
  readonly participantCount: number
}

export interface SceneServiceOptions {
  readonly clock?: () => number
  readonly defaultTtlMinutes?: number
}

interface SceneRow {
  id: string
  group_jid: string
  creator_jid: string
  title: string
  visibility: SceneVisibility
  status: SceneStatus
  revision: number
  created_at: number
  updated_at: number
  expires_at: number | null
}

interface ParticipantRow {
  scene_id: string
  user_jid: string
  role: 'owner' | 'participant'
  status: SceneParticipantStatus
  mode: SceneMode
  joined_at: number
  left_at: number | null
  updated_at: number
}

interface ConsentRow {
  scene_id: string
  user_jid: string
  action: SceneConsentAction
  enabled: number
  granted_at: number
  expires_at: number | null
  updated_at: number
}

const MAX_TITLE_LENGTH = 120
const MAX_ACTION_LENGTH = 48
const MAX_TTL_MINUTES = 7 * 24 * 60
const DEFAULT_TTL_MINUTES = 24 * 60

function validateJid(value: string, field: string): void {
  if (value.length > 128 || !isJid(value)) throw new Error(`${field} must be a valid JID`)
}

function validateGroupJid(value: string): void {
  validateJid(value, 'groupJid')
  if (!value.endsWith('@g.us')) throw new Error('groupJid must be a valid group JID')
}

function validateSceneReference(value: string): string {
  const normalized = value.trim()
  if (!isSafeIdentifier(normalized) || normalized.length > 64) throw new Error('scene id must be a safe identifier')
  return normalized
}

function hashReference(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function normalizeTitle(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (!normalized) throw new Error('Scene title cannot be empty')
  if (normalized.length > MAX_TITLE_LENGTH) throw new Error(`Scene title exceeds ${MAX_TITLE_LENGTH} characters`)
  return normalized
}

function normalizeAction(value: string): SceneConsentAction {
  const normalized = value.trim().toLowerCase()
  if (normalized.length > MAX_ACTION_LENGTH || !SCENE_CONSENT_ACTIONS.includes(normalized as SceneConsentAction)) {
    throw new Error(`Consent action must be one of: ${SCENE_CONSENT_ACTIONS.join(', ')}`)
  }
  return normalized as SceneConsentAction
}

function normalizeTtlMinutes(value: number | undefined, defaultTtlMinutes: number): number {
  const ttl = value ?? defaultTtlMinutes
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MINUTES) throw new Error(`Scene TTL must be an integer between 1 and ${MAX_TTL_MINUTES} minutes`)
  return ttl
}

function toScene(row: SceneRow): SceneRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    creatorJid: row.creator_jid,
    title: row.title,
    visibility: row.visibility,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
  }
}

function toParticipant(row: ParticipantRow): SceneParticipantRecord {
  return {
    sceneId: row.scene_id,
    userJid: row.user_jid,
    role: row.role,
    status: row.status,
    mode: row.mode,
    joinedAt: row.joined_at,
    ...(row.left_at === null ? {} : { leftAt: row.left_at }),
    updatedAt: row.updated_at,
  }
}

function toConsent(row: ConsentRow): SceneConsentRecord {
  return {
    sceneId: row.scene_id,
    userJid: row.user_jid,
    action: row.action,
    enabled: row.enabled === 1,
    grantedAt: row.granted_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    updatedAt: row.updated_at,
  }
}

export class SceneService implements Service {
  readonly name = 'scene'
  readonly dependencies = ['platform-guardrails'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly defaultTtlMinutes: number
  private readonly logger: Logger
  private db: Database.Database | undefined
  private guardrails: PlatformGuardrailService | undefined

  constructor(databasePath: string, logger: Logger, options: SceneServiceOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.defaultTtlMinutes = options.defaultTtlMinutes ?? DEFAULT_TTL_MINUTES
    normalizeTtlMinutes(this.defaultTtlMinutes, DEFAULT_TTL_MINUTES)
    this.logger = logger.child({ component: 'scene' })
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
    this.logger.info('scene storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
  }

  isEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().isFeatureEnabled(groupJid, SCENE_FEATURE_ID)
  }

  setEnabled(groupJid: string, enabled: boolean, actorJid: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'scene actor')
    this.guardrailService().setFeatureFlag(groupJid, SCENE_FEATURE_ID, enabled, actorJid, `scene-${now}`, now)
    this.audit('scene.feature.changed', actorJid, groupJid, 'changed', { enabled })
    return enabled
  }

  openScene(input: {
    readonly groupJid: string
    readonly creatorJid: string
    readonly title: string
    readonly visibility?: SceneVisibility
    readonly ttlMinutes?: number
    readonly now?: number
  }): SceneRecord {
    const groupJid = input.groupJid
    const creatorJid = input.creatorJid
    const now = input.now ?? this.clock()
    validateGroupJid(groupJid)
    validateJid(creatorJid, 'scene creator')
    this.requireEnabled(groupJid)
    const title = normalizeTitle(input.title)
    const visibility = input.visibility ?? 'public'
    if (!SCENE_VISIBILITIES.includes(visibility)) throw new Error('Scene visibility must be public or private')
    const ttlMinutes = normalizeTtlMinutes(input.ttlMinutes, this.defaultTtlMinutes)
    const scene: SceneRecord = {
      id: randomUUID(),
      groupJid,
      creatorJid,
      title,
      visibility,
      status: 'open',
      revision: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + ttlMinutes * 60_000,
    }
    const transaction = this.database().transaction(() => {
      this.database().prepare(`
        INSERT INTO scene_records (id, group_jid, creator_jid, title, visibility, status, revision, created_at, updated_at, expires_at)
        VALUES (@id, @group_jid, @creator_jid, @title, @visibility, @status, @revision, @created_at, @updated_at, @expires_at)
      `).run({
        id: scene.id,
        group_jid: groupJid,
        creator_jid: creatorJid,
        title,
        visibility,
        status: scene.status,
        revision: scene.revision,
        created_at: now,
        updated_at: now,
        expires_at: scene.expiresAt,
      })
      this.database().prepare(`
        INSERT INTO scene_participants (scene_id, user_jid, role, status, mode, joined_at, updated_at)
        VALUES (?, ?, 'owner', 'active', 'ooc', ?, ?)
      `).run(scene.id, creatorJid, now, now)
    })
    transaction()
    this.audit('scene.opened', creatorJid, groupJid, 'opened', { visibility, ttlMinutes })
    return scene
  }

  listVisibleScenes(groupJid: string, userJid: string, now = this.clock()): SceneView[] {
    validateGroupJid(groupJid)
    validateJid(userJid, 'scene viewer')
    this.requireEnabled(groupJid)
    this.expireScenes(now)
    const rows = this.database().prepare(`
      SELECT s.*, p.scene_id AS p_scene_id, p.user_jid AS p_user_jid, p.role AS p_role,
             p.status AS p_status, p.mode AS p_mode, p.joined_at AS p_joined_at,
             p.left_at AS p_left_at, p.updated_at AS p_updated_at,
             (SELECT COUNT(*) FROM scene_participants active_p WHERE active_p.scene_id = s.id AND active_p.status = 'active') AS participant_count
      FROM scene_records s
      LEFT JOIN scene_participants p ON p.scene_id = s.id AND p.user_jid = ?
      WHERE s.group_jid = ? AND s.status IN ('open', 'paused')
        AND (s.visibility = 'public' OR s.creator_jid = ? OR (p.user_jid = ? AND p.status = 'active'))
      ORDER BY s.updated_at DESC, s.id ASC
    `).all(userJid, groupJid, userJid, userJid) as Array<SceneRow & { p_scene_id: string | null; p_user_jid: string | null; p_role: 'owner' | 'participant' | null; p_status: SceneParticipantStatus | null; p_mode: SceneMode | null; p_joined_at: number | null; p_left_at: number | null; p_updated_at: number | null; participant_count: number }>
    return rows.map((row) => ({
      scene: toScene(row),
      ...(row.p_scene_id === null ? {} : { participant: toParticipant({ scene_id: row.p_scene_id, user_jid: row.p_user_jid as string, role: row.p_role as 'owner' | 'participant', status: row.p_status as SceneParticipantStatus, mode: row.p_mode as SceneMode, joined_at: row.p_joined_at as number, left_at: row.p_left_at, updated_at: row.p_updated_at as number }) }),
      participantCount: row.participant_count,
    }))
  }

  getVisibleScene(groupJid: string, sceneReference: string, userJid: string, now = this.clock()): SceneView | undefined {
    validateGroupJid(groupJid)
    validateJid(userJid, 'scene viewer')
    this.requireEnabled(groupJid)
    this.expireScenes(now)
    const scene = this.findScene(groupJid, sceneReference)
    if (!scene || !this.canView(scene, groupJid, userJid)) return undefined
    const participant = this.getParticipant(scene.id, userJid)
    const participantCount = (this.database().prepare(`SELECT COUNT(*) AS count FROM scene_participants WHERE scene_id = ? AND status = 'active'`).get(scene.id) as { count: number }).count
    return { scene, ...(participant ? { participant } : {}), participantCount }
  }

  joinScene(groupJid: string, sceneReference: string, userJid: string, now = this.clock()): SceneParticipantRecord {
    validateGroupJid(groupJid)
    validateJid(userJid, 'scene participant')
    this.requireEnabled(groupJid)
    const scene = this.requireScene(groupJid, sceneReference)
    if (scene.visibility === 'private' && scene.creatorJid !== userJid) throw new Error('Private scene requires an explicit participant invitation')
    if (scene.status !== 'open') throw new Error('Only an open scene can be joined')
    const existing = this.getParticipant(scene.id, userJid)
    this.database().prepare(`
      INSERT INTO scene_participants (scene_id, user_jid, role, status, mode, joined_at, left_at, updated_at)
      VALUES (?, ?, 'participant', 'active', 'ooc', ?, NULL, ?)
      ON CONFLICT(scene_id, user_jid) DO UPDATE SET status = 'active', mode = 'ooc', left_at = NULL, updated_at = excluded.updated_at
    `).run(scene.id, userJid, existing?.joinedAt ?? now, now)
    this.database().prepare(`UPDATE scene_consents SET enabled = 0, expires_at = NULL, updated_at = ? WHERE scene_id = ? AND user_jid = ?`).run(now, scene.id, userJid)
    const participant = this.getParticipant(scene.id, userJid) as SceneParticipantRecord
    this.audit('scene.participant.joined', userJid, groupJid, 'changed', { sceneRefHash: hashReference(scene.id) })
    return participant
  }

  leaveScene(groupJid: string, sceneReference: string, userJid: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(userJid, 'scene participant')
    this.requireEnabled(groupJid)
    const scene = this.requireScene(groupJid, sceneReference)
    const participant = this.getParticipant(scene.id, userJid)
    if (!participant || participant.status !== 'active') return false
    if (participant.role === 'owner') throw new Error('Scene owner must close the scene instead of leaving it')
    const result = this.database().prepare(`UPDATE scene_participants SET status = 'left', mode = 'ooc', left_at = ?, updated_at = ? WHERE scene_id = ? AND user_jid = ? AND status = 'active'`).run(now, now, scene.id, userJid)
    if (result.changes === 1) {
      this.database().prepare(`UPDATE scene_consents SET enabled = 0, expires_at = NULL, updated_at = ? WHERE scene_id = ? AND user_jid = ?`).run(now, scene.id, userJid)
      this.audit('scene.participant.left', userJid, groupJid, 'changed', { sceneRefHash: hashReference(scene.id) })
    }
    return result.changes === 1
  }

  setMode(groupJid: string, sceneReference: string, userJid: string, mode: SceneMode, now = this.clock()): SceneParticipantRecord {
    validateGroupJid(groupJid)
    validateJid(userJid, 'scene participant')
    this.requireEnabled(groupJid)
    if (!SCENE_MODES.includes(mode)) throw new Error('Scene mode must be ic or ooc')
    const scene = this.requireScene(groupJid, sceneReference)
    if (scene.status !== 'open' && scene.status !== 'paused') throw new Error('Scene is not active')
    const participant = this.getParticipant(scene.id, userJid)
    if (!participant || participant.status !== 'active') throw new Error('An active scene participant must join before changing IC/OOC mode')
    this.database().prepare(`UPDATE scene_participants SET mode = ?, updated_at = ? WHERE scene_id = ? AND user_jid = ? AND status = 'active'`).run(mode, now, scene.id, userJid)
    this.audit('scene.mode.changed', userJid, groupJid, 'changed', { mode })
    return this.getParticipant(scene.id, userJid) as SceneParticipantRecord
  }

  pauseScene(groupJid: string, sceneReference: string, actorJid: string, expectedRevision?: number, now = this.clock()): SceneRecord {
    return this.transitionScene(groupJid, sceneReference, actorJid, 'paused', 'scene.paused', 'changed', expectedRevision, now)
  }

  resumeScene(groupJid: string, sceneReference: string, actorJid: string, expectedRevision?: number, now = this.clock()): SceneRecord {
    return this.transitionScene(groupJid, sceneReference, actorJid, 'open', 'scene.resumed', 'changed', expectedRevision, now)
  }

  closeScene(groupJid: string, sceneReference: string, actorJid: string, expectedRevision?: number, now = this.clock()): SceneRecord {
    return this.transitionScene(groupJid, sceneReference, actorJid, 'closed', 'scene.closed', 'closed', expectedRevision, now)
  }

  setConsent(input: {
    readonly groupJid: string
    readonly sceneReference: string
    readonly userJid: string
    readonly action: string
    readonly enabled: boolean
    readonly ttlMinutes?: number
    readonly now?: number
  }): SceneConsentRecord {
    const now = input.now ?? this.clock()
    validateGroupJid(input.groupJid)
    validateJid(input.userJid, 'scene consent user')
    this.requireEnabled(input.groupJid)
    const action = normalizeAction(input.action)
    const scene = this.requireScene(input.groupJid, input.sceneReference)
    if (scene.status !== 'open' && scene.status !== 'paused') throw new Error('Scene is not active')
    const participant = this.getParticipant(scene.id, input.userJid)
    if (!participant || participant.status !== 'active') throw new Error('Consent requires an active scene participant')
    const expiresAt = input.enabled ? now + normalizeTtlMinutes(input.ttlMinutes, 60) * 60_000 : null
    this.database().prepare(`
      INSERT INTO scene_consents (scene_id, user_jid, action, enabled, granted_at, expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scene_id, user_jid, action) DO UPDATE SET enabled = excluded.enabled, granted_at = excluded.granted_at, expires_at = excluded.expires_at, updated_at = excluded.updated_at
    `).run(scene.id, input.userJid, action, input.enabled ? 1 : 0, now, expiresAt, now)
    this.audit('scene.consent.changed', input.userJid, input.groupJid, 'changed', { action, enabled: input.enabled })
    return this.getConsent(scene.id, input.userJid, action) as SceneConsentRecord
  }

  hasConsent(groupJid: string, sceneReference: string, userJid: string, action: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(userJid, 'scene consent user')
    this.requireEnabled(groupJid)
    const scene = this.requireScene(groupJid, sceneReference)
    if (scene.status !== 'open' && scene.status !== 'paused') return false
    const participant = this.getParticipant(scene.id, userJid)
    if (!participant || participant.status !== 'active') return false
    const normalizedAction = normalizeAction(action)
    const consent = this.getConsent(scene.id, userJid, normalizedAction)
    return Boolean(consent?.enabled && (consent.expiresAt === undefined || consent.expiresAt > now))
  }

  expireScenes(now = this.clock()): number {
    const result = this.database().prepare(`UPDATE scene_records SET status = 'expired', revision = revision + 1, updated_at = ? WHERE status IN ('open', 'paused') AND expires_at IS NOT NULL AND expires_at <= ?`).run(now, now)
    if (result.changes > 0) this.audit('scene.expired', undefined, undefined, 'closed', { count: result.changes })
    return result.changes
  }

  private transitionScene(
    groupJid: string,
    sceneReference: string,
    actorJid: string,
    target: 'open' | 'paused' | 'closed',
    eventType: string,
    outcome: 'changed' | 'closed',
    expectedRevision: number | undefined,
    now: number,
  ): SceneRecord {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'scene actor')
    this.requireEnabled(groupJid)
    const scene = this.requireScene(groupJid, sceneReference)
    if (scene.creatorJid !== actorJid) throw new Error('Only the scene creator can change scene lifecycle')
    const allowed = target === 'paused' ? scene.status === 'open' : target === 'open' ? scene.status === 'paused' : scene.status === 'open' || scene.status === 'paused'
    if (!allowed) throw new Error(`Scene cannot transition from ${scene.status} to ${target}`)
    if (expectedRevision !== undefined && expectedRevision !== scene.revision) throw new Error('Scene revision is stale')
    const result = this.database().prepare(`UPDATE scene_records SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND group_jid = ? AND status = ? AND revision = ?`).run(target, now, scene.id, groupJid, scene.status, scene.revision)
    if (result.changes !== 1) throw new Error('Scene revision is stale')
    const updated = this.requireScene(groupJid, scene.id)
    this.audit(eventType, actorJid, groupJid, outcome, { sceneRefHash: hashReference(scene.id) })
    return updated
  }

  private canView(scene: SceneRecord, groupJid: string, userJid: string): boolean {
    if (scene.groupJid !== groupJid || scene.status === 'closed' || scene.status === 'expired') return false
    if (scene.visibility === 'public') return true
    if (scene.creatorJid === userJid) return true
    return this.getParticipant(scene.id, userJid)?.status === 'active'
  }

  private findScene(groupJid: string, reference: string): SceneRecord | undefined {
    const normalized = validateSceneReference(reference)
    const exact = this.database().prepare(`SELECT * FROM scene_records WHERE group_jid = ? AND id = ?`).get(groupJid, normalized) as SceneRow | undefined
    if (exact) return toScene(exact)
    const rows = this.database().prepare(`SELECT * FROM scene_records WHERE group_jid = ? AND id LIKE ? ORDER BY id ASC LIMIT 2`).all(groupJid, `${normalized}%`) as SceneRow[]
    if (rows.length > 1) throw new Error('Scene reference is ambiguous; use more characters')
    return rows[0] ? toScene(rows[0]) : undefined
  }

  private requireScene(groupJid: string, reference: string): SceneRecord {
    const scene = this.findScene(groupJid, reference)
    if (!scene) throw new Error('Scene tidak ditemukan pada grup ini')
    return scene
  }

  private getParticipant(sceneId: string, userJid: string): SceneParticipantRecord | undefined {
    const row = this.database().prepare(`SELECT * FROM scene_participants WHERE scene_id = ? AND user_jid = ?`).get(sceneId, userJid) as ParticipantRow | undefined
    return row ? toParticipant(row) : undefined
  }

  private getConsent(sceneId: string, userJid: string, action: SceneConsentAction): SceneConsentRecord | undefined {
    const row = this.database().prepare(`SELECT * FROM scene_consents WHERE scene_id = ? AND user_jid = ? AND action = ?`).get(sceneId, userJid, action) as ConsentRow | undefined
    return row ? toConsent(row) : undefined
  }

  private requireEnabled(groupJid: string): void {
    if (!this.isEnabled(groupJid)) throw new Error('Scene feature is disabled for this group')
  }

  private audit(eventType: string, actorJid: string | undefined, resourceJid: string | undefined, outcome: 'allowed' | 'denied' | 'changed' | 'failed' | 'limited' | 'opened' | 'closed', metadata: Record<string, unknown>): void {
    this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), ...(actorJid ? { actorJid } : {}), ...(resourceJid ? { resourceJid } : {}), outcome, metadata })
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('Scene service is not initialized')
    return this.db
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('Scene guardrails service is not initialized')
    return this.guardrails
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS scene_records (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        creator_jid TEXT NOT NULL,
        title TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
        status TEXT NOT NULL CHECK (status IN ('open', 'paused', 'closed', 'expired')),
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_scene_records_group_status ON scene_records (group_jid, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS scene_participants (
        scene_id TEXT NOT NULL,
        user_jid TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'participant')),
        status TEXT NOT NULL CHECK (status IN ('active', 'left')),
        mode TEXT NOT NULL CHECK (mode IN ('ic', 'ooc')),
        joined_at INTEGER NOT NULL,
        left_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scene_id, user_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_scene_participants_user ON scene_participants (user_jid, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS scene_consents (
        scene_id TEXT NOT NULL,
        user_jid TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('participate', 'share_context', 'receive_assistance')),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        granted_at INTEGER NOT NULL,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (scene_id, user_jid, action)
      );
      CREATE INDEX IF NOT EXISTS idx_scene_consents_expiry ON scene_consents (scene_id, user_jid, enabled, expires_at);
    `)
  }
}
