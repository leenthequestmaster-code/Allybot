import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'

export const MAX_GROUP_RULES_LENGTH = 2000
export const MAX_GROUP_MESSAGE_LENGTH = 2000
export const MAX_GROUP_PREFIX_LENGTH = 4
export const SUPPORTED_GROUP_LANGUAGES = ['id', 'en'] as const
export type GroupLanguage = (typeof SUPPORTED_GROUP_LANGUAGES)[number]
export const DEFAULT_GROUP_LANGUAGE: GroupLanguage = 'id'
export const DEFAULT_GROUP_TIMEZONE = 'UTC'
export const MAX_GROUP_TIMEZONE_LENGTH = 64

export function isValidGroupTimezone(value: string): boolean {
  const normalized = value.trim()
  if (!normalized || normalized.length > MAX_GROUP_TIMEZONE_LENGTH || /\s/.test(normalized)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized }).format()
    return true
  } catch {
    return false
  }
}

export interface GroupRulesRecord {
  readonly groupJid: string
  readonly rules: string
  readonly updatedBy: string
  readonly updatedAt: number
}

export interface GroupMessageRecord {
  readonly groupJid: string
  readonly kind: 'welcome' | 'leave'
  readonly text: string
  readonly updatedBy: string
  readonly updatedAt: number
}

export interface GroupPrefixRecord {
  readonly groupJid: string
  readonly prefix: string
  readonly updatedBy: string
  readonly updatedAt: number
}

export interface GroupLanguageRecord {
  readonly groupJid: string
  readonly language: GroupLanguage
  readonly updatedBy: string
  readonly updatedAt: number
}

export interface GroupTimezoneRecord {
  readonly groupJid: string
  readonly timezone: string
  readonly updatedBy: string
  readonly updatedAt: number
}

export interface GroupRulesHistoryRecord {
  readonly id: number
  readonly groupJid: string
  readonly action: 'set' | 'clear'
  readonly rules?: string
  readonly updatedBy: string
  readonly updatedAt: number
}

export interface GroupConfigurationSnapshot {
  readonly rules?: GroupRulesRecord
  readonly welcome?: GroupMessageRecord
  readonly leave?: GroupMessageRecord
  readonly prefix?: GroupPrefixRecord
  readonly language?: GroupLanguageRecord
  readonly timezone?: GroupTimezoneRecord
}

type GroupRulesRow = {
  group_jid: string
  rules: string
  updated_by: string
  updated_at: number
}

type GroupMessagesRow = {
  group_jid: string
  welcome_text: string | null
  welcome_updated_by: string | null
  welcome_updated_at: number | null
  leave_text: string | null
  leave_updated_by: string | null
  leave_updated_at: number | null
}

type GroupPreferencesRow = {
  group_jid: string
  prefix: string | null
  prefix_updated_by: string | null
  prefix_updated_at: number | null
  language: GroupLanguage | null
  language_updated_by: string | null
  language_updated_at: number | null
  timezone: string | null
  timezone_updated_by: string | null
  timezone_updated_at: number | null
}

type GroupRulesHistoryRow = {
  id: number
  group_jid: string
  action: 'set' | 'clear'
  rules: string | null
  updated_by: string
  updated_at: number
}

function mapGroupRules(row: GroupRulesRow): GroupRulesRecord {
  return {
    groupJid: row.group_jid,
    rules: row.rules,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }
}

function mapGroupMessage(
  row: GroupMessagesRow,
  kind: 'welcome' | 'leave',
): GroupMessageRecord | undefined {
  const text = kind === 'welcome' ? row.welcome_text : row.leave_text
  const updatedBy = kind === 'welcome' ? row.welcome_updated_by : row.leave_updated_by
  const updatedAt = kind === 'welcome' ? row.welcome_updated_at : row.leave_updated_at
  if (text === null || updatedBy === null || updatedAt === null) return undefined
  return { groupJid: row.group_jid, kind, text, updatedBy, updatedAt }
}

function mapGroupPrefix(row: GroupPreferencesRow): GroupPrefixRecord | undefined {
  if (row.prefix === null || row.prefix_updated_by === null || row.prefix_updated_at === null) return undefined
  return {
    groupJid: row.group_jid,
    prefix: row.prefix,
    updatedBy: row.prefix_updated_by,
    updatedAt: row.prefix_updated_at,
  }
}

function mapGroupLanguage(row: GroupPreferencesRow): GroupLanguageRecord | undefined {
  if (row.language === null || row.language_updated_by === null || row.language_updated_at === null) return undefined
  return {
    groupJid: row.group_jid,
    language: row.language,
    updatedBy: row.language_updated_by,
    updatedAt: row.language_updated_at,
  }
}

function mapGroupTimezone(row: GroupPreferencesRow): GroupTimezoneRecord | undefined {
  if (row.timezone === null || row.timezone_updated_by === null || row.timezone_updated_at === null) return undefined
  return {
    groupJid: row.group_jid,
    timezone: row.timezone,
    updatedBy: row.timezone_updated_by,
    updatedAt: row.timezone_updated_at,
  }
}

function mapGroupRulesHistory(row: GroupRulesHistoryRow): GroupRulesHistoryRecord {
  return {
    id: row.id,
    groupJid: row.group_jid,
    action: row.action,
    ...(row.rules === null ? {} : { rules: row.rules }),
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  }
}

export class GroupConfigurationService implements Service {
  readonly name = 'group-configuration'

  private db: Database.Database | undefined
  private readonly databasePath: string

  constructor(
    coreDatabasePath: string,
    private readonly logger: Logger,
  ) {
    this.databasePath = join(dirname(coreDatabasePath), 'allybot-group-config.sqlite')
  }

  initialize(_context: ServiceContext): void {
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 })
    this.db = new Database(this.databasePath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    this.migrate()
    this.logger.info({ databasePath: this.databasePath }, 'group configuration storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) this.db.close()
    this.db = undefined
  }

  getRules(groupJid: string): GroupRulesRecord | undefined {
    const row = this.database()
      .prepare(
        `SELECT group_jid, rules, updated_by, updated_at
         FROM group_rules
         WHERE group_jid = ?`,
      )
      .get(groupJid) as GroupRulesRow | undefined
    return row ? mapGroupRules(row) : undefined
  }

  setRules(groupJid: string, rules: string, updatedBy: string, updatedAt = Date.now()): GroupRulesRecord {
    const normalizedRules = rules.trim()
    if (normalizedRules.length === 0) throw new Error('Group rules cannot be empty')
    if (normalizedRules.length > MAX_GROUP_RULES_LENGTH) {
      throw new Error(`Group rules exceed ${MAX_GROUP_RULES_LENGTH} characters`)
    }

    this.database()
      .prepare(
        `INSERT INTO group_rules (group_jid, rules, updated_by, updated_at)
         VALUES (@group_jid, @rules, @updated_by, @updated_at)
         ON CONFLICT(group_jid) DO UPDATE SET
           rules = excluded.rules,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run({
        group_jid: groupJid,
        rules: normalizedRules,
        updated_by: updatedBy,
        updated_at: updatedAt,
      })
    this.recordRulesHistory(groupJid, 'set', normalizedRules, updatedBy, updatedAt)

    return { groupJid, rules: normalizedRules, updatedBy, updatedAt }
  }

  getRulesHistory(groupJid: string, limit = 10): readonly GroupRulesHistoryRecord[] {
    const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 50)
    const rows = this.database()
      .prepare(
        `SELECT id, group_jid, action, rules, updated_by, updated_at
         FROM group_rules_history
         WHERE group_jid = ?
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(groupJid, safeLimit) as GroupRulesHistoryRow[]
    return rows.map(mapGroupRulesHistory)
  }

  clearRules(groupJid: string, updatedBy = 'unknown'): boolean {
    const existing = this.getRules(groupJid)
    if (!existing) return false
    const result = this.database()
      .prepare('DELETE FROM group_rules WHERE group_jid = ?')
      .run(groupJid)
    if (result.changes > 0) {
      this.recordRulesHistory(groupJid, 'clear', undefined, updatedBy, Date.now())
    }
    return result.changes > 0
  }

  getWelcome(groupJid: string): GroupMessageRecord | undefined {
    return this.getMessage(groupJid, 'welcome')
  }

  setWelcome(groupJid: string, text: string, updatedBy: string, updatedAt = Date.now()): GroupMessageRecord {
    return this.setMessage(groupJid, 'welcome', text, updatedBy, updatedAt)
  }

  clearWelcome(groupJid: string): boolean {
    return this.clearMessage(groupJid, 'welcome')
  }

  getLeave(groupJid: string): GroupMessageRecord | undefined {
    return this.getMessage(groupJid, 'leave')
  }

  setLeave(groupJid: string, text: string, updatedBy: string, updatedAt = Date.now()): GroupMessageRecord {
    return this.setMessage(groupJid, 'leave', text, updatedBy, updatedAt)
  }

  clearLeave(groupJid: string): boolean {
    return this.clearMessage(groupJid, 'leave')
  }

  getPrefix(groupJid: string): GroupPrefixRecord | undefined {
    return mapGroupPrefix(this.getPreferences(groupJid))
  }

  resolvePrefix(groupJid: string, fallback: string): string {
    return this.getPrefix(groupJid)?.prefix ?? fallback
  }

  setPrefix(groupJid: string, prefix: string, updatedBy: string, updatedAt = Date.now()): GroupPrefixRecord {
    const normalizedPrefix = prefix.trim()
    if (!/^[!#$%&*+./?@~_\-]{1,4}$/.test(normalizedPrefix)) {
      throw new Error('Group prefix must contain one to four supported symbols')
    }

    this.database()
      .prepare(
        `INSERT INTO group_preferences (group_jid, prefix, prefix_updated_by, prefix_updated_at)
         VALUES (@group_jid, @prefix, @updated_by, @updated_at)
         ON CONFLICT(group_jid) DO UPDATE SET
           prefix = excluded.prefix,
           prefix_updated_by = excluded.prefix_updated_by,
           prefix_updated_at = excluded.prefix_updated_at`,
      )
      .run({
        group_jid: groupJid,
        prefix: normalizedPrefix,
        updated_by: updatedBy,
        updated_at: updatedAt,
      })

    return { groupJid, prefix: normalizedPrefix, updatedBy, updatedAt }
  }

  clearPrefix(groupJid: string): boolean {
    const result = this.database()
      .prepare(
        `UPDATE group_preferences
         SET prefix = NULL, prefix_updated_by = NULL, prefix_updated_at = NULL
         WHERE group_jid = ? AND prefix IS NOT NULL`,
      )
      .run(groupJid)
    return result.changes > 0
  }

  getLanguage(groupJid: string): GroupLanguageRecord | undefined {
    return mapGroupLanguage(this.getPreferences(groupJid))
  }

  setLanguage(
    groupJid: string,
    language: string,
    updatedBy: string,
    updatedAt = Date.now(),
  ): GroupLanguageRecord {
    const normalizedLanguage = language.trim().toLowerCase()
    if (!SUPPORTED_GROUP_LANGUAGES.includes(normalizedLanguage as GroupLanguage)) {
      throw new Error(`Unsupported group language: ${normalizedLanguage}`)
    }
    const selectedLanguage = normalizedLanguage as GroupLanguage

    this.database()
      .prepare(
        `INSERT INTO group_preferences (group_jid, language, language_updated_by, language_updated_at)
         VALUES (@group_jid, @language, @updated_by, @updated_at)
         ON CONFLICT(group_jid) DO UPDATE SET
           language = excluded.language,
           language_updated_by = excluded.language_updated_by,
           language_updated_at = excluded.language_updated_at`,
      )
      .run({
        group_jid: groupJid,
        language: selectedLanguage,
        updated_by: updatedBy,
        updated_at: updatedAt,
      })

    return { groupJid, language: selectedLanguage, updatedBy, updatedAt }
  }

  resolveLanguage(groupJid: string): GroupLanguage {
    return this.getLanguage(groupJid)?.language ?? DEFAULT_GROUP_LANGUAGE
  }

  getTimezone(groupJid: string): GroupTimezoneRecord | undefined {
    return mapGroupTimezone(this.getPreferences(groupJid))
  }

  resolveTimezone(groupJid: string, fallback = DEFAULT_GROUP_TIMEZONE): string {
    return this.getTimezone(groupJid)?.timezone ?? fallback
  }

  setTimezone(
    groupJid: string,
    timezone: string,
    updatedBy: string,
    updatedAt = Date.now(),
  ): GroupTimezoneRecord {
    const normalizedTimezone = timezone.trim()
    if (!isValidGroupTimezone(normalizedTimezone)) {
      throw new Error(`Unsupported group timezone: ${normalizedTimezone}`)
    }

    this.database()
      .prepare(
        `INSERT INTO group_preferences (group_jid, timezone, timezone_updated_by, timezone_updated_at)
         VALUES (@group_jid, @timezone, @updated_by, @updated_at)
         ON CONFLICT(group_jid) DO UPDATE SET
           timezone = excluded.timezone,
           timezone_updated_by = excluded.timezone_updated_by,
           timezone_updated_at = excluded.timezone_updated_at`,
      )
      .run({
        group_jid: groupJid,
        timezone: normalizedTimezone,
        updated_by: updatedBy,
        updated_at: updatedAt,
      })

    return { groupJid, timezone: normalizedTimezone, updatedBy, updatedAt }
  }

  getSettings(groupJid: string): GroupConfigurationSnapshot {
    return {
      rules: this.getRules(groupJid),
      welcome: this.getWelcome(groupJid),
      leave: this.getLeave(groupJid),
      prefix: this.getPrefix(groupJid),
      language: this.getLanguage(groupJid),
      timezone: this.getTimezone(groupJid),
    }
  }

  private recordRulesHistory(
    groupJid: string,
    action: 'set' | 'clear',
    rules: string | undefined,
    updatedBy: string,
    updatedAt: number,
  ): void {
    this.database()
      .prepare(
        `INSERT INTO group_rules_history (group_jid, action, rules, updated_by, updated_at)
         VALUES (@group_jid, @action, @rules, @updated_by, @updated_at)`,
      )
      .run({
        group_jid: groupJid,
        action,
        rules: rules ?? null,
        updated_by: updatedBy,
        updated_at: updatedAt,
      })
  }

  private getPreferences(groupJid: string): GroupPreferencesRow {
    const row = this.database()
      .prepare(
        `SELECT group_jid, prefix, prefix_updated_by, prefix_updated_at,
                language, language_updated_by, language_updated_at,
                timezone, timezone_updated_by, timezone_updated_at
         FROM group_preferences
         WHERE group_jid = ?`,
      )
      .get(groupJid) as GroupPreferencesRow | undefined
    return row ?? {
      group_jid: groupJid,
      prefix: null,
      prefix_updated_by: null,
      prefix_updated_at: null,
      language: null,
      language_updated_by: null,
      language_updated_at: null,
      timezone: null,
      timezone_updated_by: null,
      timezone_updated_at: null,
    }
  }

  private getMessage(groupJid: string, kind: 'welcome' | 'leave'): GroupMessageRecord | undefined {
    const row = this.database()
      .prepare(
        `SELECT group_jid, welcome_text, welcome_updated_by, welcome_updated_at,
                leave_text, leave_updated_by, leave_updated_at
         FROM group_messages
         WHERE group_jid = ?`,
      )
      .get(groupJid) as GroupMessagesRow | undefined
    return row ? mapGroupMessage(row, kind) : undefined
  }

  private setMessage(
    groupJid: string,
    kind: 'welcome' | 'leave',
    text: string,
    updatedBy: string,
    updatedAt: number,
  ): GroupMessageRecord {
    const normalizedText = text.trim()
    if (normalizedText.length === 0) throw new Error('Group message cannot be empty')
    if (normalizedText.length > MAX_GROUP_MESSAGE_LENGTH) {
      throw new Error(`Group message exceeds ${MAX_GROUP_MESSAGE_LENGTH} characters`)
    }

    const column = kind === 'welcome' ? 'welcome' : 'leave'
    this.database()
      .prepare(
        `INSERT INTO group_messages (
           group_jid, ${column}_text, ${column}_updated_by, ${column}_updated_at
         ) VALUES (@group_jid, @text, @updated_by, @updated_at)
         ON CONFLICT(group_jid) DO UPDATE SET
           ${column}_text = excluded.${column}_text,
           ${column}_updated_by = excluded.${column}_updated_by,
           ${column}_updated_at = excluded.${column}_updated_at`,
      )
      .run({
        group_jid: groupJid,
        text: normalizedText,
        updated_by: updatedBy,
        updated_at: updatedAt,
      })

    return { groupJid, kind, text: normalizedText, updatedBy, updatedAt }
  }

  private clearMessage(groupJid: string, kind: 'welcome' | 'leave'): boolean {
    const column = kind === 'welcome' ? 'welcome' : 'leave'
    const result = this.database()
      .prepare(
        `UPDATE group_messages
         SET ${column}_text = NULL,
             ${column}_updated_by = NULL,
             ${column}_updated_at = NULL
         WHERE group_jid = ? AND ${column}_text IS NOT NULL`,
      )
      .run(groupJid)
    return result.changes > 0
  }

  private database(): Database.Database {
    if (!this.db) throw new Error('Group configuration storage is not initialized')
    return this.db
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_rules (
        group_jid TEXT PRIMARY KEY,
        rules TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_messages (
        group_jid TEXT PRIMARY KEY,
        welcome_text TEXT,
        welcome_updated_by TEXT,
        welcome_updated_at INTEGER,
        leave_text TEXT,
        leave_updated_by TEXT,
        leave_updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS group_preferences (
        group_jid TEXT PRIMARY KEY,
        prefix TEXT,
        prefix_updated_by TEXT,
        prefix_updated_at INTEGER,
        language TEXT,
        language_updated_by TEXT,
        language_updated_at INTEGER,
        timezone TEXT,
        timezone_updated_by TEXT,
        timezone_updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS group_rules_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_jid TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('set', 'clear')),
        rules TEXT,
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)

    const preferenceColumns = new Set(
      (this.database().prepare('PRAGMA table_info(group_preferences)').all() as Array<{ name: string }>)
        .map((column) => column.name),
    )
    for (const [name, type] of [
      ['timezone', 'TEXT'],
      ['timezone_updated_by', 'TEXT'],
      ['timezone_updated_at', 'INTEGER'],
    ] as const) {
      if (!preferenceColumns.has(name)) {
        this.database().exec(`ALTER TABLE group_preferences ADD COLUMN ${name} ${type}`)
      }
    }

    this.database()
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id, applied_at)
         VALUES (@id, @applied_at)`,
      )
      .run({ id: '0001_group_rules', applied_at: new Date().toISOString() })
    this.database()
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id, applied_at)
         VALUES (@id, @applied_at)`,
      )
      .run({ id: '0002_group_messages', applied_at: new Date().toISOString() })
    this.database()
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id, applied_at)
         VALUES (@id, @applied_at)`,
      )
      .run({ id: '0003_group_preferences', applied_at: new Date().toISOString() })
    this.database()
      .prepare(
        `INSERT OR IGNORE INTO schema_migrations (id, applied_at)
         VALUES (@id, @applied_at)`,
      )
      .run({ id: '0004_rules_history_timezone', applied_at: new Date().toISOString() })
  }
}
