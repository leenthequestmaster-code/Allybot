import type Database from 'better-sqlite3'
import type { PlatformClock } from './contracts.js'

export type MissionStatus = 'running' | 'completed' | 'cancelled' | 'failed' | 'expired'

export interface MissionResponse {
  readonly kind: 'text'
  readonly text: string
}

export interface MissionRecord<TData = unknown> {
  readonly id: string
  readonly definitionId: string
  readonly definitionVersion: number
  readonly remoteJid: string
  readonly actorJid: string
  readonly state: string
  readonly data: TData
  readonly status: MissionStatus
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly expiresAt?: number
  readonly lastOperationKey?: string
  readonly lastResponse?: MissionResponse
  readonly errorCode?: string
}

export interface MissionContext<TData = unknown> {
  readonly mission: MissionRecord<TData>
  readonly now: number
}

export type MissionTransition<TData = unknown> =
  | { readonly type: 'stay'; readonly data?: TData; readonly response?: MissionResponse }
  | { readonly type: 'transition'; readonly state: string; readonly data?: TData; readonly response?: MissionResponse }
  | { readonly type: 'complete'; readonly data?: TData; readonly response?: MissionResponse }
  | { readonly type: 'cancel'; readonly data?: TData; readonly response?: MissionResponse }
  | { readonly type: 'fail'; readonly errorCode: string; readonly data?: TData; readonly response?: MissionResponse }

export interface MissionStateDefinition<TData = unknown, TInput = unknown> {
  readonly onInput: (context: MissionContext<TData>, input: TInput) => Promise<MissionTransition<TData>> | MissionTransition<TData>
}

export interface MissionDefinition<TData = unknown, TInput = unknown> {
  readonly id: string
  readonly version: number
  readonly initialState: string
  readonly states: Readonly<Record<string, MissionStateDefinition<TData, TInput>>>
}

export interface StartMissionInput<TData> {
  readonly id: string
  readonly remoteJid: string
  readonly actorJid: string
  readonly data: TData
  readonly createdAt: number
  readonly expiresAt?: number
}

export interface MissionInput<TInput> {
  readonly id: string
  readonly actorJid: string
  readonly operationKey: string
  readonly value: TInput
}

export interface FindActiveMissionInput {
  readonly definitionId?: string
  readonly remoteJid: string
  readonly actorJid: string
  readonly now: number
}

export interface MissionExecutionResult<TData = unknown> {
  readonly record: MissionRecord<TData>
  readonly response?: MissionResponse
  readonly replayed?: boolean
}

export interface MissionStore {
  create<TData>(record: MissionRecord<TData>): MissionRecord<TData>
  get<TData>(id: string): MissionRecord<TData> | undefined
  findActive<TData>(input: FindActiveMissionInput): MissionRecord<TData> | undefined
  update<TData>(record: MissionRecord<TData>, expectedRevision: number): MissionRecord<TData> | undefined
  cancel<TData>(id: string, actorJid: string, expectedRevision: number, now: number): MissionRecord<TData> | undefined
  expire(now: number): number
}

export class InMemoryMissionStore implements MissionStore {
  private readonly records = new Map<string, MissionRecord>()

  create<TData>(record: MissionRecord<TData>): MissionRecord<TData> {
    if (this.records.has(record.id)) throw new Error(`Mission already exists: ${record.id}`)
    this.records.set(record.id, record)
    return record
  }

  get<TData>(id: string): MissionRecord<TData> | undefined {
    return this.records.get(id) as MissionRecord<TData> | undefined
  }

  findActive<TData>(input: FindActiveMissionInput): MissionRecord<TData> | undefined {
    this.expire(input.now)
    return [...this.records.values()]
      .filter((record) => record.status === 'running')
      .filter((record) => record.remoteJid === input.remoteJid && record.actorJid === input.actorJid)
      .filter((record) => input.definitionId === undefined || record.definitionId === input.definitionId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] as MissionRecord<TData> | undefined
  }

  update<TData>(record: MissionRecord<TData>, expectedRevision: number): MissionRecord<TData> | undefined {
    const current = this.records.get(record.id)
    if (!current || current.revision !== expectedRevision || current.status !== 'running') return undefined
    this.records.set(record.id, record)
    return record
  }

  cancel<TData>(id: string, actorJid: string, expectedRevision: number, now: number): MissionRecord<TData> | undefined {
    const current = this.get<TData>(id)
    if (!current || current.actorJid !== actorJid || current.status !== 'running' || current.revision !== expectedRevision) return undefined
    const updated: MissionRecord<TData> = { ...current, status: 'cancelled', revision: current.revision + 1, updatedAt: now }
    this.records.set(id, updated)
    return updated
  }

  expire(now: number): number {
    let count = 0
    for (const current of this.records.values()) {
      if (current.status !== 'running' || current.expiresAt === undefined || current.expiresAt > now) continue
      this.records.set(current.id, { ...current, status: 'expired', revision: current.revision + 1, updatedAt: now })
      count += 1
    }
    return count
  }
}

export class SqliteMissionStore implements MissionStore {
  constructor(private readonly db: Database.Database, private readonly namespace = 'allybot') {
    this.migrate()
  }

  create<TData>(record: MissionRecord<TData>): MissionRecord<TData> {
    this.db.prepare(`
      INSERT INTO platform_missions
        (namespace, mission_id, definition_id, definition_version, remote_jid, actor_jid, state, data_json, status, revision, created_at, updated_at, expires_at, last_operation_key, last_response_json, error_code)
      VALUES (@namespace, @mission_id, @definition_id, @definition_version, @remote_jid, @actor_jid, @state, @data_json, @status, @revision, @created_at, @updated_at, @expires_at, @last_operation_key, @last_response_json, @error_code)
    `).run(toRow(this.namespace, record))
    return record
  }

  get<TData>(id: string): MissionRecord<TData> | undefined {
    const row = this.db.prepare(`SELECT * FROM platform_missions WHERE namespace = ? AND mission_id = ?`).get(this.namespace, id) as MissionRow | undefined
    return row ? fromRow<TData>(row) : undefined
  }

  findActive<TData>(input: FindActiveMissionInput): MissionRecord<TData> | undefined {
    this.expire(input.now)
    const row = this.db.prepare(`
      SELECT * FROM platform_missions
      WHERE namespace = ? AND remote_jid = ? AND actor_jid = ? AND status = 'running'
        AND (? IS NULL OR definition_id = ?)
      ORDER BY updated_at DESC LIMIT 1
    `).get(this.namespace, input.remoteJid, input.actorJid, input.definitionId ?? null, input.definitionId ?? null) as MissionRow | undefined
    return row ? fromRow<TData>(row) : undefined
  }

  update<TData>(record: MissionRecord<TData>, expectedRevision: number): MissionRecord<TData> | undefined {
    const result = this.db.prepare(`
      UPDATE platform_missions SET
        state = ?, data_json = ?, status = ?, revision = ?, updated_at = ?, expires_at = ?,
        last_operation_key = ?, last_response_json = ?, error_code = ?
      WHERE namespace = ? AND mission_id = ? AND status = 'running' AND revision = ?
    `).run(record.state, JSON.stringify(record.data), record.status, record.revision, record.updatedAt, record.expiresAt ?? null, record.lastOperationKey ?? null, record.lastResponse ? JSON.stringify(record.lastResponse) : null, record.errorCode ?? null, this.namespace, record.id, expectedRevision)
    return result.changes === 1 ? record : undefined
  }

  cancel<TData>(id: string, actorJid: string, expectedRevision: number, now: number): MissionRecord<TData> | undefined {
    const result = this.db.prepare(`
      UPDATE platform_missions SET status = 'cancelled', revision = revision + 1, updated_at = ?
      WHERE namespace = ? AND mission_id = ? AND actor_jid = ? AND status = 'running' AND revision = ?
    `).run(now, this.namespace, id, actorJid, expectedRevision)
    return result.changes === 1 ? this.get<TData>(id) : undefined
  }

  expire(now: number): number {
    const result = this.db.prepare(`
      UPDATE platform_missions SET status = 'expired', revision = revision + 1, updated_at = ?
      WHERE namespace = ? AND status = 'running' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now, this.namespace, now)
    return result.changes
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_missions (
        namespace TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        definition_id TEXT NOT NULL,
        definition_version INTEGER NOT NULL,
        remote_jid TEXT NOT NULL,
        actor_jid TEXT NOT NULL,
        state TEXT NOT NULL,
        data_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed', 'expired')),
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_operation_key TEXT,
        last_response_json TEXT,
        error_code TEXT,
        PRIMARY KEY (namespace, mission_id)
      );
      CREATE INDEX IF NOT EXISTS idx_platform_missions_active_owner
        ON platform_missions (namespace, remote_jid, actor_jid, status, updated_at);
    `)
  }
}

export interface MissionEngineOptions {
  readonly clock?: PlatformClock
  readonly maxInputSize?: number
}

export class MissionEngine {
  private readonly clock: PlatformClock
  private readonly maxInputSize: number
  private readonly definitions = new Map<string, MissionDefinition>()

  constructor(private readonly store: MissionStore, options: MissionEngineOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() }
    this.maxInputSize = options.maxInputSize ?? 16_384
    if (!Number.isInteger(this.maxInputSize) || this.maxInputSize < 1) throw new Error('maxInputSize must be a positive integer')
  }

  register<TData, TInput>(definition: MissionDefinition<TData, TInput>): () => void {
    validateDefinition(definition)
    if (this.definitions.has(definition.id)) throw new Error(`Mission definition already registered: ${definition.id}`)
    this.definitions.set(definition.id, definition as MissionDefinition)
    return () => this.definitions.delete(definition.id)
  }

  start<TData, TInput>(definitionId: string, input: StartMissionInput<TData>): MissionRecord<TData> {
    const definition = this.getDefinition<TData, TInput>(definitionId)
    if (input.expiresAt !== undefined && input.expiresAt <= input.createdAt) throw new Error('Mission expiresAt must be after createdAt')
    const record: MissionRecord<TData> = {
      id: input.id,
      definitionId: definition.id,
      definitionVersion: definition.version,
      remoteJid: input.remoteJid,
      actorJid: input.actorJid,
      state: definition.initialState,
      data: input.data,
      status: 'running',
      revision: 0,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    }
    return this.store.create(record)
  }

  async handleInput<TData, TInput>(input: MissionInput<TInput>): Promise<MissionExecutionResult<TData> | undefined> {
    const current = this.store.get<TData>(input.id)
    if (!current || current.actorJid !== input.actorJid) return undefined
    if (current.lastOperationKey === input.operationKey) return { record: current, ...(current.lastResponse ? { response: current.lastResponse } : {}), replayed: true }
    if (current.status !== 'running') return undefined
    if (serializedSize(input.value) > this.maxInputSize) throw new Error('Mission input exceeds maximum size')
    if (current.expiresAt !== undefined && current.expiresAt <= this.clock.now()) {
      this.store.expire(this.clock.now())
      return undefined
    }

    const definition = this.getDefinition<TData, TInput>(current.definitionId)
    if (definition.version !== current.definitionVersion) throw new Error(`Mission definition version mismatch: ${current.definitionId}`)
    const state = definition.states[current.state]
    if (!state) throw new Error(`Mission state is not defined: ${current.state}`)
    const transition = await state.onInput({ mission: current, now: this.clock.now() }, input.value)
    const nextStatus: MissionStatus = transition.type === 'complete' ? 'completed' : transition.type === 'cancel' ? 'cancelled' : transition.type === 'fail' ? 'failed' : 'running'
    const nextState = transition.type === 'transition' ? transition.state : current.state
    if (!definition.states[nextState]) throw new Error(`Mission transition state is not defined: ${nextState}`)
    const updated: MissionRecord<TData> = {
      ...current,
      state: nextState,
      data: transition.data === undefined ? current.data : transition.data,
      status: nextStatus,
      revision: current.revision + 1,
      updatedAt: this.clock.now(),
      lastOperationKey: input.operationKey,
      ...(transition.response ? { lastResponse: transition.response } : {}),
      ...(transition.type === 'fail' ? { errorCode: transition.errorCode } : {}),
    }
    const saved = this.store.update(updated, current.revision)
    if (!saved) return undefined
    return { record: saved, ...(transition.response ? { response: transition.response } : {}) }
  }

  cancel<TData>(id: string, actorJid: string, expectedRevision: number): MissionRecord<TData> | undefined {
    return this.store.cancel(id, actorJid, expectedRevision, this.clock.now())
  }

  expire(): number {
    return this.store.expire(this.clock.now())
  }

  get<TData>(id: string): MissionRecord<TData> | undefined {
    return this.store.get<TData>(id)
  }

  findActive<TData>(input: FindActiveMissionInput): MissionRecord<TData> | undefined {
    return this.store.findActive<TData>(input)
  }

  private getDefinition<TData, TInput>(id: string): MissionDefinition<TData, TInput> {
    const definition = this.definitions.get(id) as MissionDefinition<TData, TInput> | undefined
    if (!definition) throw new Error(`Mission definition is not registered: ${id}`)
    return definition
  }
}

type MissionRow = {
  namespace: string
  mission_id: string
  definition_id: string
  definition_version: number
  remote_jid: string
  actor_jid: string
  state: string
  data_json: string
  status: MissionStatus
  revision: number
  created_at: number
  updated_at: number
  expires_at: number | null
  last_operation_key: string | null
  last_response_json: string | null
  error_code: string | null
}

function toRow(namespace: string, record: MissionRecord): Record<string, unknown> {
  return {
    namespace,
    mission_id: record.id,
    definition_id: record.definitionId,
    definition_version: record.definitionVersion,
    remote_jid: record.remoteJid,
    actor_jid: record.actorJid,
    state: record.state,
    data_json: JSON.stringify(record.data),
    status: record.status,
    revision: record.revision,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    expires_at: record.expiresAt ?? null,
    last_operation_key: record.lastOperationKey ?? null,
    last_response_json: record.lastResponse ? JSON.stringify(record.lastResponse) : null,
    error_code: record.errorCode ?? null,
  }
}

function fromRow<TData>(row: MissionRow): MissionRecord<TData> {
  return {
    id: row.mission_id,
    definitionId: row.definition_id,
    definitionVersion: row.definition_version,
    remoteJid: row.remote_jid,
    actorJid: row.actor_jid,
    state: row.state,
    data: JSON.parse(row.data_json) as TData,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.last_operation_key === null ? {} : { lastOperationKey: row.last_operation_key }),
    ...(row.last_response_json === null ? {} : { lastResponse: JSON.parse(row.last_response_json) as MissionResponse }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  }
}

function validateDefinition<TData, TInput>(definition: MissionDefinition<TData, TInput>): void {
  if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(definition.id)) throw new Error(`Invalid mission definition id: ${definition.id}`)
  if (!Number.isInteger(definition.version) || definition.version < 1) throw new Error(`Invalid mission definition version: ${definition.id}`)
  if (!definition.states[definition.initialState]) throw new Error(`Mission initial state is not defined: ${definition.initialState}`)
  for (const [state, definitionForState] of Object.entries(definition.states)) {
    if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(state) || typeof definitionForState.onInput !== 'function') throw new Error(`Invalid mission state: ${state}`)
  }
}

function serializedSize(value: unknown): number {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? 0 : Buffer.byteLength(serialized, 'utf8')
}
