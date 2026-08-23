import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { isGroupJid, isJid, isSafeIdentifier } from '../platform/validation.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'

export const CHARACTER_MAX_NAME_LENGTH = 60
export const CHARACTER_MAX_PROFILE_LENGTH = 500
export const CHARACTER_MAX_MOOD_LENGTH = 40
export const CHARACTER_MAX_ACTIVE_PER_OWNER = 3

export interface CharacterRecord {
  readonly id: string
  readonly groupJid: string
  readonly ownerJid: string
  readonly name: string
  readonly profile: string
  readonly mood?: string
  readonly status: 'active' | 'retired'
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
}

interface CharacterRow {
  id: string
  group_jid: string
  owner_jid: string
  name: string
  profile: string
  mood: string | null
  status: 'active' | 'retired'
  revision: number
  created_at: number
  updated_at: number
}

function validateJid(value: string, field: string): void {
  if (value.length > 128 || !isJid(value)) throw new Error(`${field} must be a valid JID`)
}

function validateGroupJid(value: string): void {
  if (!isGroupJid(value)) throw new Error('groupJid must be a valid group JID')
}

function boundedText(value: string, field: string, maxLength: number, required = true): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!normalized && !required) return ''
  if (!normalized) throw new Error(`${field} must not be empty`)
  if (normalized.length > maxLength) throw new Error(`${field} must be at most ${maxLength} characters`)
  return normalized
}

function validateReference(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (!isSafeIdentifier(normalized) || normalized.length > 64) throw new Error('character id must be a safe identifier')
  return normalized
}

function toRecord(row: CharacterRow): CharacterRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    ownerJid: row.owner_jid,
    name: row.name,
    profile: row.profile,
    ...(row.mood ? { mood: row.mood } : {}),
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class CharacterService implements Service {
  readonly name = 'character'
  readonly dependencies = ['platform-guardrails'] as const

  private db: Database.Database | undefined
  private guardrails: PlatformGuardrailService | undefined
  private readonly databasePath: string
  private readonly clock: () => number

  constructor(coreDatabasePath: string, private readonly logger: Logger, options: { clock?: () => number } = {}) {
    this.databasePath = join(dirname(coreDatabasePath), 'allybot-character.sqlite')
    this.clock = options.clock ?? (() => Date.now())
  }

  initialize(context: ServiceContext): void {
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.guardrails = context.services.get<PlatformGuardrailService>('platform-guardrails')
    this.migrate()
    this.logger.info({ databasePath: this.databasePath }, 'character storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
  }

  create(groupJid: string, ownerJid: string, name: string, profile: string, now = this.clock()): CharacterRecord {
    validateGroupJid(groupJid)
    validateJid(ownerJid, 'character owner')
    const normalizedName = boundedText(name, 'character name', CHARACTER_MAX_NAME_LENGTH)
    const normalizedProfile = boundedText(profile, 'character profile', CHARACTER_MAX_PROFILE_LENGTH, false)
    const id = randomUUID().replaceAll('-', '')
    const insert = this.database().transaction(() => {
      const activeCount = this.database().prepare(`SELECT COUNT(*) AS count FROM character_profiles WHERE group_jid = ? AND owner_jid = ? AND status = 'active'`).get(groupJid, ownerJid) as { count: number }
      if (activeCount.count >= CHARACTER_MAX_ACTIVE_PER_OWNER) return false
      this.database().prepare(`INSERT INTO character_profiles (id, group_jid, owner_jid, name, profile, mood, status, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 'active', 1, ?, ?)`).run(id, groupJid, ownerJid, normalizedName, normalizedProfile, now, now)
      return true
    })
    if (!insert.immediate()) {
      this.audit('character.create.limited', ownerJid, groupJid, 'limited', { maxActive: CHARACTER_MAX_ACTIVE_PER_OWNER })
      throw new Error(`Kamu sudah memiliki maksimal ${CHARACTER_MAX_ACTIVE_PER_OWNER} character aktif di grup ini.`)
    }
    const record = this.requireById(groupJid, id)
    this.audit('character.created', ownerJid, groupJid, 'changed', { characterRefHash: this.hashReference(id), nameLength: normalizedName.length, profileLength: normalizedProfile.length })
    return record
  }

  getOwnActive(groupJid: string, ownerJid: string): CharacterRecord | undefined {
    validateGroupJid(groupJid)
    validateJid(ownerJid, 'character owner')
    const row = this.database().prepare(`SELECT * FROM character_profiles WHERE group_jid = ? AND owner_jid = ? AND status = 'active' ORDER BY updated_at DESC, id ASC LIMIT 1`).get(groupJid, ownerJid) as CharacterRow | undefined
    return row ? toRecord(row) : undefined
  }

  findVisible(groupJid: string, reference: string): CharacterRecord | undefined {
    validateGroupJid(groupJid)
    const normalized = validateReference(reference)
    const exact = this.database().prepare(`SELECT * FROM character_profiles WHERE group_jid = ? AND id = ? AND status = 'active'`).get(groupJid, normalized) as CharacterRow | undefined
    if (exact) return toRecord(exact)
    const rows = this.database().prepare(`SELECT * FROM character_profiles WHERE group_jid = ? AND id LIKE ? AND status = 'active' ORDER BY id ASC LIMIT 2`).all(groupJid, `${normalized}%`) as CharacterRow[]
    if (rows.length > 1) throw new Error('character id is ambiguous; use more characters')
    return rows[0] ? toRecord(rows[0]) : undefined
  }

  listVisible(groupJid: string, limit = 50): readonly CharacterRecord[] {
    validateGroupJid(groupJid)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('character list limit is out of range')
    const rows = this.database().prepare(`SELECT * FROM character_profiles WHERE group_jid = ? AND status = 'active' ORDER BY updated_at DESC, id ASC LIMIT ?`).all(groupJid, limit) as CharacterRow[]
    return rows.map(toRecord)
  }

  update(groupJid: string, ownerJid: string, reference: string, name: string, profile: string, now = this.clock()): CharacterRecord {
    validateGroupJid(groupJid)
    validateJid(ownerJid, 'character owner')
    const current = this.findVisible(groupJid, reference)
    if (!current) throw new Error('Character tidak ditemukan pada grup ini')
    if (current.ownerJid !== ownerJid) throw new Error('Hanya pemilik character yang boleh mengubahnya')
    const normalizedName = boundedText(name, 'character name', CHARACTER_MAX_NAME_LENGTH)
    const normalizedProfile = boundedText(profile, 'character profile', CHARACTER_MAX_PROFILE_LENGTH, false)
    const result = this.database().prepare(`UPDATE character_profiles SET name = ?, profile = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND group_jid = ? AND owner_jid = ? AND status = 'active' AND revision = ?`).run(normalizedName, normalizedProfile, now, current.id, groupJid, ownerJid, current.revision)
    if (result.changes !== 1) throw new Error('Character berubah; silakan coba lagi dengan ID terbaru')
    const updated = this.requireById(groupJid, current.id)
    this.audit('character.updated', ownerJid, groupJid, 'changed', { characterRefHash: this.hashReference(current.id), nameLength: normalizedName.length, profileLength: normalizedProfile.length, revision: updated.revision })
    return updated
  }

  retire(groupJid: string, ownerJid: string, reference: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(ownerJid, 'character owner')
    const current = this.findVisible(groupJid, reference)
    if (!current) throw new Error('Character tidak ditemukan pada grup ini')
    if (current.ownerJid !== ownerJid) throw new Error('Hanya pemilik character yang boleh menghapusnya')
    const result = this.database().prepare(`UPDATE character_profiles SET status = 'retired', revision = revision + 1, updated_at = ? WHERE id = ? AND group_jid = ? AND owner_jid = ? AND status = 'active' AND revision = ?`).run(now, current.id, groupJid, ownerJid, current.revision)
    if (result.changes !== 1) throw new Error('Character sudah berubah atau sudah dihapus')
    this.audit('character.retired', ownerJid, groupJid, 'closed', { characterRefHash: this.hashReference(current.id), revision: current.revision + 1 })
    return true
  }

  setMood(groupJid: string, ownerJid: string, mood: string | undefined, now = this.clock()): CharacterRecord {
    validateGroupJid(groupJid)
    validateJid(ownerJid, 'character owner')
    const current = this.getOwnActive(groupJid, ownerJid)
    if (!current) throw new Error('Buat character dulu dengan `!character create <nama> | <deskripsi>`.')
    const normalizedMood = mood && mood.toLowerCase() !== 'off' ? boundedText(mood, 'mood', CHARACTER_MAX_MOOD_LENGTH) : ''
    const result = this.database().prepare(`UPDATE character_profiles SET mood = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND group_jid = ? AND owner_jid = ? AND status = 'active' AND revision = ?`).run(normalizedMood || null, now, current.id, groupJid, ownerJid, current.revision)
    if (result.changes !== 1) throw new Error('Mood character berubah; silakan coba lagi')
    const updated = this.requireById(groupJid, current.id)
    this.audit('character.mood.changed', ownerJid, groupJid, 'changed', { characterRefHash: this.hashReference(current.id), moodLength: normalizedMood.length, revision: updated.revision })
    return updated
  }

  private requireById(groupJid: string, id: string): CharacterRecord {
    const row = this.database().prepare(`SELECT * FROM character_profiles WHERE group_jid = ? AND id = ?`).get(groupJid, id) as CharacterRow | undefined
    if (!row) throw new Error('Character menghilang dari storage')
    return toRecord(row)
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('Character service is not initialized')
    return this.db
  }

  private hashReference(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16)
  }

  private audit(eventType: string, actorJid: string, resourceJid: string, outcome: 'allowed' | 'changed' | 'failed' | 'limited' | 'closed', metadata: Record<string, unknown>): void {
    this.guardrails?.recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), actorJid, resourceJid, outcome, metadata })
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS character_profiles (
        id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        owner_jid TEXT NOT NULL,
        name TEXT NOT NULL,
        profile TEXT NOT NULL DEFAULT '',
        mood TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
        revision INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_character_profiles_group_status ON character_profiles (group_jid, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_character_profiles_owner_status ON character_profiles (group_jid, owner_jid, status, updated_at DESC);
    `)
  }
}
