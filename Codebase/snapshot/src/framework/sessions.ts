import type Database from 'better-sqlite3'
import type { PlatformClock } from './contracts.js'

export type InteractionSessionStatus = 'active' | 'completed' | 'cancelled' | 'expired'

export interface InteractionSession {
  readonly id: string
  readonly menuId: string
  readonly menuVersion: number
  readonly remoteJid: string
  readonly actorJid: string
  readonly createdAt: number
  readonly expiresAt?: number
  readonly status: InteractionSessionStatus
  readonly revision: number
  readonly operationKey?: string
  readonly selectedItemId?: string
  readonly rawInput?: string
  readonly updatedAt: number
}

export interface CreateInteractionSessionInput {
  readonly id: string
  readonly menuId: string
  readonly menuVersion: number
  readonly remoteJid: string
  readonly actorJid: string
  readonly createdAt: number
  readonly expiresAt?: number
}

export interface CompleteInteractionSessionInput {
  readonly id: string
  readonly actorJid: string
  readonly expectedRevision: number
  readonly operationKey: string
  readonly selectedItemId: string
  readonly rawInput: string
}

export interface CancelInteractionSessionInput {
  readonly id: string
  readonly actorJid: string
  readonly expectedRevision: number
}

export interface FindActiveInteractionSessionInput {
  readonly remoteJid: string
  readonly actorJid: string
  readonly menuId?: string
  readonly now: number
}

export interface InteractionSessionStore {
  create(input: CreateInteractionSessionInput): InteractionSession
  get(id: string): InteractionSession | undefined
  findActive(input: FindActiveInteractionSessionInput): InteractionSession | undefined
  complete(input: CompleteInteractionSessionInput): InteractionSession | undefined
  cancel(input: CancelInteractionSessionInput): InteractionSession | undefined
  expire(now: number): number
}

export interface InMemoryInteractionSessionStoreOptions {
  readonly clock?: PlatformClock
}

export class InMemoryInteractionSessionStore implements InteractionSessionStore {
  private readonly sessions = new Map<string, InteractionSession>()
  private readonly clock: PlatformClock

  constructor(options: InMemoryInteractionSessionStoreOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() }
  }

  create(input: CreateInteractionSessionInput): InteractionSession {
    validateCreateInput(input)
    if (this.sessions.has(input.id)) throw new Error(`Interaction session already exists: ${input.id}`)
    const session = createRecord(input, 0, 'active', input.createdAt)
    this.sessions.set(session.id, session)
    return session
  }

  get(id: string): InteractionSession | undefined {
    return this.sessions.get(id)
  }

  findActive(input: FindActiveInteractionSessionInput): InteractionSession | undefined {
    this.expire(input.now)
    return [...this.sessions.values()]
      .filter((session) => session.status === 'active')
      .filter((session) => session.remoteJid === input.remoteJid && session.actorJid === input.actorJid)
      .filter((session) => input.menuId === undefined || session.menuId === input.menuId)
      .sort((left, right) => right.createdAt - left.createdAt)[0]
  }

  complete(input: CompleteInteractionSessionInput): InteractionSession | undefined {
    const current = this.sessions.get(input.id)
    if (!current || current.actorJid !== input.actorJid) return undefined
    if (current.status === 'completed' && current.operationKey === input.operationKey) return current
    if (current.status !== 'active' || current.revision !== input.expectedRevision) return undefined
    const updated = { ...current, status: 'completed' as const, revision: current.revision + 1, operationKey: input.operationKey, selectedItemId: input.selectedItemId, rawInput: input.rawInput, updatedAt: this.clock.now() }
    this.sessions.set(updated.id, updated)
    return updated
  }

  cancel(input: CancelInteractionSessionInput): InteractionSession | undefined {
    const current = this.sessions.get(input.id)
    if (!current || current.actorJid !== input.actorJid || current.status !== 'active' || current.revision !== input.expectedRevision) return undefined
    const updated = { ...current, status: 'cancelled' as const, revision: current.revision + 1, updatedAt: this.clock.now() }
    this.sessions.set(updated.id, updated)
    return updated
  }

  expire(now: number): number {
    let count = 0
    for (const current of this.sessions.values()) {
      if (current.status !== 'active' || current.expiresAt === undefined || current.expiresAt > now) continue
      this.sessions.set(current.id, { ...current, status: 'expired', revision: current.revision + 1, updatedAt: now })
      count += 1
    }
    return count
  }
}

export interface SqliteInteractionSessionStoreOptions {
  readonly namespace?: string
  readonly clock?: PlatformClock
}

export class SqliteInteractionSessionStore implements InteractionSessionStore {
  private readonly namespace: string
  private readonly clock: PlatformClock

  constructor(private readonly db: Database.Database, options: SqliteInteractionSessionStoreOptions = {}) {
    this.namespace = options.namespace ?? 'allybot'
    this.clock = options.clock ?? { now: () => Date.now() }
    this.migrate()
  }

  create(input: CreateInteractionSessionInput): InteractionSession {
    validateCreateInput(input)
    const now = input.createdAt
    this.db.prepare(`
      INSERT INTO platform_interaction_sessions
        (namespace, session_id, menu_id, menu_version, remote_jid, actor_jid, created_at, expires_at, status, revision, updated_at)
      VALUES (@namespace, @session_id, @menu_id, @menu_version, @remote_jid, @actor_jid, @created_at, @expires_at, 'active', 0, @updated_at)
    `).run({ namespace: this.namespace, session_id: input.id, menu_id: input.menuId, menu_version: input.menuVersion, remote_jid: input.remoteJid, actor_jid: input.actorJid, created_at: input.createdAt, expires_at: input.expiresAt ?? null, updated_at: now })
    return this.get(input.id) as InteractionSession
  }

  get(id: string): InteractionSession | undefined {
    const row = this.db.prepare(`SELECT * FROM platform_interaction_sessions WHERE namespace = ? AND session_id = ?`).get(this.namespace, id) as SessionRow | undefined
    return row ? toSession(row) : undefined
  }

  findActive(input: FindActiveInteractionSessionInput): InteractionSession | undefined {
    this.expire(input.now)
    const row = this.db.prepare(`
      SELECT * FROM platform_interaction_sessions
      WHERE namespace = ? AND remote_jid = ? AND actor_jid = ? AND status = 'active'
        AND (? IS NULL OR menu_id = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(this.namespace, input.remoteJid, input.actorJid, input.menuId ?? null, input.menuId ?? null) as SessionRow | undefined
    return row ? toSession(row) : undefined
  }

  complete(input: CompleteInteractionSessionInput): InteractionSession | undefined {
    const current = this.get(input.id)
    if (!current || current.actorJid !== input.actorJid) return undefined
    if (current.status === 'completed' && current.operationKey === input.operationKey) return current
    if (current.status !== 'active' || current.revision !== input.expectedRevision) return undefined
    const result = this.db.prepare(`
      UPDATE platform_interaction_sessions
      SET status = 'completed', revision = revision + 1, operation_key = ?, selected_item_id = ?, raw_input = ?, updated_at = ?
      WHERE namespace = ? AND session_id = ? AND actor_jid = ? AND status = 'active' AND revision = ?
    `).run(input.operationKey, input.selectedItemId, input.rawInput, this.clock.now(), this.namespace, input.id, input.actorJid, input.expectedRevision)
    if (result.changes === 1) return this.get(input.id)
    const afterRace = this.get(input.id)
    return afterRace?.status === 'completed' && afterRace.operationKey === input.operationKey ? afterRace : undefined
  }

  cancel(input: CancelInteractionSessionInput): InteractionSession | undefined {
    const result = this.db.prepare(`
      UPDATE platform_interaction_sessions
      SET status = 'cancelled', revision = revision + 1, updated_at = ?
      WHERE namespace = ? AND session_id = ? AND actor_jid = ? AND status = 'active' AND revision = ?
    `).run(this.clock.now(), this.namespace, input.id, input.actorJid, input.expectedRevision)
    return result.changes === 1 ? this.get(input.id) : undefined
  }

  expire(now: number): number {
    const result = this.db.prepare(`
      UPDATE platform_interaction_sessions
      SET status = 'expired', revision = revision + 1, updated_at = ?
      WHERE namespace = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now, this.namespace, now)
    return result.changes
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_interaction_sessions (
        namespace TEXT NOT NULL,
        session_id TEXT NOT NULL,
        menu_id TEXT NOT NULL,
        menu_version INTEGER NOT NULL,
        remote_jid TEXT NOT NULL,
        actor_jid TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled', 'expired')),
        revision INTEGER NOT NULL,
        operation_key TEXT,
        selected_item_id TEXT,
        raw_input TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_platform_sessions_active_owner
        ON platform_interaction_sessions (namespace, remote_jid, actor_jid, status, created_at);
    `)
  }
}

type SessionRow = {
  namespace: string
  session_id: string
  menu_id: string
  menu_version: number
  remote_jid: string
  actor_jid: string
  created_at: number
  expires_at: number | null
  status: InteractionSessionStatus
  revision: number
  operation_key: string | null
  selected_item_id: string | null
  raw_input: string | null
  updated_at: number
}

function createRecord(input: CreateInteractionSessionInput, revision: number, status: InteractionSessionStatus, updatedAt: number): InteractionSession {
  return {
    id: input.id,
    menuId: input.menuId,
    menuVersion: input.menuVersion,
    remoteJid: input.remoteJid,
    actorJid: input.actorJid,
    createdAt: input.createdAt,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    status,
    revision,
    updatedAt,
  }
}

function toSession(row: SessionRow): InteractionSession {
  return {
    id: row.session_id,
    menuId: row.menu_id,
    menuVersion: row.menu_version,
    remoteJid: row.remote_jid,
    actorJid: row.actor_jid,
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    status: row.status,
    revision: row.revision,
    ...(row.operation_key === null ? {} : { operationKey: row.operation_key }),
    ...(row.selected_item_id === null ? {} : { selectedItemId: row.selected_item_id }),
    ...(row.raw_input === null ? {} : { rawInput: row.raw_input }),
    updatedAt: row.updated_at,
  }
}

function validateCreateInput(input: CreateInteractionSessionInput): void {
  for (const [field, value] of Object.entries(input)) {
    if (field === 'expiresAt') continue
    if (typeof value === 'string' && !value.trim()) throw new Error(`Interaction session ${field} must not be empty`)
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) throw new Error('Interaction session createdAt must be a valid epoch')
  if (!Number.isInteger(input.menuVersion) || input.menuVersion < 1) throw new Error('Interaction session menuVersion must be positive')
  if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.createdAt)) throw new Error('Interaction session expiresAt must be after createdAt')
}
