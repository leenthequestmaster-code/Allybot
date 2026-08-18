import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { isJid } from '../platform/validation.js'
import { PlatformGuardrailService } from './platform-guardrail-service.js'

export const PERSONALIZATION_FEATURE_ID = 'group.personalization.core'
export const PERSONALIZATION_LANGUAGES = ['id', 'en'] as const
export const PERSONALIZATION_VERBOSITIES = ['brief', 'normal', 'detailed'] as const
export const PERSONALIZATION_FORMATS = ['plain', 'accessible'] as const
export type PersonalizationLanguage = (typeof PERSONALIZATION_LANGUAGES)[number]
export type PersonalizationVerbosity = (typeof PERSONALIZATION_VERBOSITIES)[number]
export type PersonalizationFormat = (typeof PERSONALIZATION_FORMATS)[number]

export interface QuietHours {
  readonly start: string
  readonly end: string
}

export interface PreferenceOverrides {
  readonly language?: PersonalizationLanguage
  readonly timezone?: string
  readonly quietHours?: QuietHours | null
  readonly notificationsEnabled?: boolean
  readonly verbosity?: PersonalizationVerbosity
  readonly format?: PersonalizationFormat
}

export interface UserPreferencesRecord extends PreferenceOverrides {
  readonly groupJid: string
  readonly userJid: string
  readonly updatedAt: number
}

export interface GroupPolicyRecord extends PreferenceOverrides {
  readonly groupJid: string
  readonly updatedBy: string
  readonly updatedAt: number
}

type PreferenceSource = 'user' | 'group' | 'default'

export interface ResolvedPreferences {
  readonly groupJid: string
  readonly userJid?: string
  readonly language: PersonalizationLanguage
  readonly timezone: string
  readonly quietHours?: QuietHours
  readonly notificationsEnabled: boolean
  readonly verbosity: PersonalizationVerbosity
  readonly format: PersonalizationFormat
  readonly sources: {
    readonly language: PreferenceSource
    readonly timezone: PreferenceSource
    readonly quietHours: PreferenceSource
    readonly notificationsEnabled: PreferenceSource
    readonly verbosity: PreferenceSource
    readonly format: PreferenceSource
  }
}

export type NotificationDecisionReason = 'allowed' | 'feature-off' | 'quiet-hours' | 'policy-disabled'

export interface NotificationDecision {
  readonly allowed: boolean
  readonly reason: NotificationDecisionReason
  readonly preferences: ResolvedPreferences
}

export interface PersonalizationOptions {
  readonly clock?: () => number
}

interface PreferenceRow {
  group_jid: string
  user_jid?: string
  language: PersonalizationLanguage | null
  timezone: string | null
  quiet_enabled: number | null
  quiet_start: string | null
  quiet_end: string | null
  notifications_enabled: number | null
  verbosity: PersonalizationVerbosity | null
  accessibility_format: PersonalizationFormat | null
  updated_by?: string
  updated_at: number
}

const DEFAULT_LANGUAGE: PersonalizationLanguage = 'id'
const DEFAULT_TIMEZONE = 'UTC'
const DEFAULT_NOTIFICATIONS_ENABLED = true
const DEFAULT_VERBOSITY: PersonalizationVerbosity = 'normal'
const DEFAULT_FORMAT: PersonalizationFormat = 'plain'
const MAX_TIMEZONE_LENGTH = 64
const MAX_GROUP_OR_USER_JID_LENGTH = 128
const QUIET_HOURS_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const SUPPORTED_TIME_ZONES = new Set(
  typeof Intl.supportedValuesOf === 'function'
    ? Intl.supportedValuesOf('timeZone').map((value) => value.toUpperCase())
    : [],
)

function validateJid(value: string, field: string): void {
  if (value.length > MAX_GROUP_OR_USER_JID_LENGTH || !isJid(value)) throw new Error(`${field} must be a valid JID`)
}

function validateGroupJid(value: string): void {
  validateJid(value, 'groupJid')
  if (!value.endsWith('@g.us')) throw new Error('groupJid must be a valid group JID')
}

function normalizeEnum<T extends string>(value: string, allowed: readonly T[], field: string): T {
  const normalized = value.trim().toLowerCase()
  if (!allowed.includes(normalized as T)) throw new Error(`Unsupported ${field}: ${normalized}`)
  return normalized as T
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

function normalizeClockTime(value: string, field: string): string {
  const normalized = value.trim()
  if (!QUIET_HOURS_PATTERN.test(normalized)) throw new Error(`${field} must use HH:mm format`)
  return normalized
}

function normalizeQuietHours(start: string, end: string): QuietHours {
  const normalizedStart = normalizeClockTime(start, 'Quiet-hours start')
  const normalizedEnd = normalizeClockTime(end, 'Quiet-hours end')
  if (normalizedStart === normalizedEnd) throw new Error('Quiet-hours start and end must differ')
  return { start: normalizedStart, end: normalizedEnd }
}

function mapOverrides(row: PreferenceRow): PreferenceOverrides {
  const overrides: {
    language?: PersonalizationLanguage
    timezone?: string
    quietHours?: QuietHours | null
    notificationsEnabled?: boolean
    verbosity?: PersonalizationVerbosity
    format?: PersonalizationFormat
  } = {}
  if (row.language !== null) overrides.language = row.language
  if (row.timezone !== null) overrides.timezone = row.timezone
  if (row.quiet_enabled !== null) {
    overrides.quietHours = row.quiet_enabled === 1
      ? row.quiet_start !== null && row.quiet_end !== null
        ? { start: row.quiet_start, end: row.quiet_end }
        : null
      : null
  }
  if (row.notifications_enabled !== null) overrides.notificationsEnabled = row.notifications_enabled === 1
  if (row.verbosity !== null) overrides.verbosity = row.verbosity
  if (row.accessibility_format !== null) overrides.format = row.accessibility_format
  return overrides
}

function mapUserPreferences(row: PreferenceRow): UserPreferencesRecord {
  return { groupJid: row.group_jid, userJid: row.user_jid as string, updatedAt: row.updated_at, ...mapOverrides(row) }
}

function mapGroupPolicy(row: PreferenceRow): GroupPolicyRecord {
  return { groupJid: row.group_jid, updatedBy: row.updated_by as string, updatedAt: row.updated_at, ...mapOverrides(row) }
}

function hasOwn<T extends object>(object: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key)
}

function minutesSinceMidnight(value: string): number {
  const [hours, minutes] = value.split(':').map(Number)
  return hours * 60 + minutes
}

function quietHoursActive(quietHours: QuietHours | undefined, timeZone: string, now: number): boolean {
  if (!quietHours) return false
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0')
  const current = hour * 60 + minute
  const start = minutesSinceMidnight(quietHours.start)
  const end = minutesSinceMidnight(quietHours.end)
  return start < end ? current >= start && current < end : current >= start || current < end
}

export class PersonalizationService implements Service {
  readonly name = 'personalization'
  readonly dependencies = ['platform-guardrails'] as const

  private readonly databasePath: string
  private readonly clock: () => number
  private readonly logger: Logger
  private db: Database.Database | undefined
  private guardrails: PlatformGuardrailService | undefined

  constructor(databasePath: string, logger: Logger, options: PersonalizationOptions = {}) {
    this.databasePath = databasePath
    this.clock = options.clock ?? (() => Date.now())
    this.logger = logger.child({ component: 'personalization' })
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
    this.logger.info('personalization storage initialized')
  }

  shutdown(_context: ServiceContext): void {
    if (this.db?.open) this.db.close()
    this.db = undefined
    this.guardrails = undefined
  }

  isEnabled(groupJid: string): boolean {
    validateGroupJid(groupJid)
    return this.guardrailService().isFeatureEnabled(groupJid, PERSONALIZATION_FEATURE_ID)
  }

  setEnabled(groupJid: string, enabled: boolean, actorJid: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    validateJid(actorJid, 'personalization actor')
    this.guardrailService().setFeatureFlag(groupJid, PERSONALIZATION_FEATURE_ID, enabled, actorJid, `personalization-${now}`, now)
    this.audit('personalization.feature.changed', actorJid, groupJid, 'changed', { enabled })
    return enabled
  }

  getUserPreferences(groupJid: string, userJid: string): UserPreferencesRecord | undefined {
    validateGroupJid(groupJid)
    validateJid(userJid, 'personalization user')
    const row = this.database().prepare(`SELECT * FROM user_preferences WHERE group_jid = ? AND user_jid = ?`).get(groupJid, userJid) as PreferenceRow | undefined
    return row ? mapUserPreferences(row) : undefined
  }

  getGroupPolicy(groupJid: string): GroupPolicyRecord | undefined {
    validateGroupJid(groupJid)
    const row = this.database().prepare(`SELECT * FROM group_policies WHERE group_jid = ?`).get(groupJid) as PreferenceRow | undefined
    return row ? mapGroupPolicy(row) : undefined
  }

  resolvePreferences(groupJid: string, userJid?: string): ResolvedPreferences {
    validateGroupJid(groupJid)
    if (userJid) validateJid(userJid, 'personalization user')
    const user = userJid ? this.getUserPreferences(groupJid, userJid) : undefined
    const group = this.getGroupPolicy(groupJid)
    const userOverrides: PreferenceOverrides = user ?? {}
    const groupOverrides: PreferenceOverrides = group ?? {}
    const choose = <T>(key: keyof PreferenceOverrides, fallback: T): { value: T; source: PreferenceSource } => {
      if (hasOwn(userOverrides, key)) return { value: userOverrides[key] as T, source: 'user' }
      if (hasOwn(groupOverrides, key)) return { value: groupOverrides[key] as T, source: 'group' }
      return { value: fallback, source: 'default' }
    }
    const quiet = choose<QuietHours | null | undefined>('quietHours', undefined)
    const language = choose<PersonalizationLanguage>('language', DEFAULT_LANGUAGE)
    const timezone = choose<string>('timezone', DEFAULT_TIMEZONE)
    const notificationsEnabled = choose<boolean>('notificationsEnabled', DEFAULT_NOTIFICATIONS_ENABLED)
    const verbosity = choose<PersonalizationVerbosity>('verbosity', DEFAULT_VERBOSITY)
    const format = choose<PersonalizationFormat>('format', DEFAULT_FORMAT)
    return {
      groupJid,
      ...(userJid ? { userJid } : {}),
      language: language.value,
      timezone: timezone.value,
      ...(quiet.value ? { quietHours: quiet.value } : {}),
      notificationsEnabled: notificationsEnabled.value,
      verbosity: verbosity.value,
      format: format.value,
      sources: {
        language: language.source,
        timezone: timezone.source,
        quietHours: quiet.source,
        notificationsEnabled: notificationsEnabled.source,
        verbosity: verbosity.source,
        format: format.source,
      },
    }
  }

  evaluateNotification(groupJid: string, userJid: string, now = this.clock()): NotificationDecision {
    validateGroupJid(groupJid)
    validateJid(userJid, 'personalization notification user')
    if (!this.isEnabled(groupJid)) {
      return { allowed: true, reason: 'feature-off', preferences: this.resolvePreferences(groupJid, userJid) }
    }
    const preferences = this.resolvePreferences(groupJid, userJid)
    if (!preferences.notificationsEnabled) return { allowed: false, reason: 'policy-disabled', preferences }
    if (quietHoursActive(preferences.quietHours, preferences.timezone, now)) return { allowed: false, reason: 'quiet-hours', preferences }
    return { allowed: true, reason: 'allowed', preferences }
  }

  evaluateGroupNotification(groupJid: string, now = this.clock()): NotificationDecision {
    validateGroupJid(groupJid)
    if (!this.isEnabled(groupJid)) {
      return { allowed: true, reason: 'feature-off', preferences: this.resolvePreferences(groupJid) }
    }
    const preferences = this.resolvePreferences(groupJid)
    if (!preferences.notificationsEnabled) return { allowed: false, reason: 'policy-disabled', preferences }
    if (quietHoursActive(preferences.quietHours, preferences.timezone, now)) return { allowed: false, reason: 'quiet-hours', preferences }
    return { allowed: true, reason: 'allowed', preferences }
  }

  setUserLanguage(groupJid: string, userJid: string, language: string, now = this.clock()): UserPreferencesRecord {
    return this.updateUserField(groupJid, userJid, 'language', normalizeEnum(language, PERSONALIZATION_LANGUAGES, 'language'), now)
  }

  setUserTimezone(groupJid: string, userJid: string, timezone: string, now = this.clock()): UserPreferencesRecord {
    return this.updateUserField(groupJid, userJid, 'timezone', normalizeTimezone(timezone), now)
  }

  setUserQuietHours(groupJid: string, userJid: string, quietHours: QuietHours | null, now = this.clock()): UserPreferencesRecord {
    const normalized = quietHours === null ? null : normalizeQuietHours(quietHours.start, quietHours.end)
    return this.updateUserField(groupJid, userJid, 'quietHours', normalized, now)
  }

  setUserNotifications(groupJid: string, userJid: string, enabled: boolean, now = this.clock()): UserPreferencesRecord {
    return this.updateUserField(groupJid, userJid, 'notificationsEnabled', enabled, now)
  }

  setUserVerbosity(groupJid: string, userJid: string, verbosity: string, now = this.clock()): UserPreferencesRecord {
    return this.updateUserField(groupJid, userJid, 'verbosity', normalizeEnum(verbosity, PERSONALIZATION_VERBOSITIES, 'verbosity'), now)
  }

  setUserFormat(groupJid: string, userJid: string, format: string, now = this.clock()): UserPreferencesRecord {
    return this.updateUserField(groupJid, userJid, 'format', normalizeEnum(format, PERSONALIZATION_FORMATS, 'format'), now)
  }

  setGroupLanguage(groupJid: string, updatedBy: string, language: string, now = this.clock()): GroupPolicyRecord {
    return this.updateGroupField(groupJid, updatedBy, 'language', normalizeEnum(language, PERSONALIZATION_LANGUAGES, 'language'), now)
  }

  setGroupTimezone(groupJid: string, updatedBy: string, timezone: string, now = this.clock()): GroupPolicyRecord {
    return this.updateGroupField(groupJid, updatedBy, 'timezone', normalizeTimezone(timezone), now)
  }

  setGroupQuietHours(groupJid: string, updatedBy: string, quietHours: QuietHours | null, now = this.clock()): GroupPolicyRecord {
    const normalized = quietHours === null ? null : normalizeQuietHours(quietHours.start, quietHours.end)
    return this.updateGroupField(groupJid, updatedBy, 'quietHours', normalized, now)
  }

  setGroupNotifications(groupJid: string, updatedBy: string, enabled: boolean, now = this.clock()): GroupPolicyRecord {
    return this.updateGroupField(groupJid, updatedBy, 'notificationsEnabled', enabled, now)
  }

  setGroupVerbosity(groupJid: string, updatedBy: string, verbosity: string, now = this.clock()): GroupPolicyRecord {
    return this.updateGroupField(groupJid, updatedBy, 'verbosity', normalizeEnum(verbosity, PERSONALIZATION_VERBOSITIES, 'verbosity'), now)
  }

  setGroupFormat(groupJid: string, updatedBy: string, format: string, now = this.clock()): GroupPolicyRecord {
    return this.updateGroupField(groupJid, updatedBy, 'format', normalizeEnum(format, PERSONALIZATION_FORMATS, 'format'), now)
  }

  deleteUserPreferences(groupJid: string, userJid: string, now = this.clock()): boolean {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateJid(userJid, 'personalization user')
    const result = this.database().prepare(`DELETE FROM user_preferences WHERE group_jid = ? AND user_jid = ?`).run(groupJid, userJid)
    if (result.changes > 0) this.audit('personalization.user.deleted', userJid, groupJid, 'changed', { fieldCount: 6 })
    return result.changes > 0
  }

  exportUserPreferences(groupJid: string, userJid: string): UserPreferencesRecord | undefined {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateJid(userJid, 'personalization user')
    const record = this.getUserPreferences(groupJid, userJid)
    this.audit('personalization.user.exported', userJid, groupJid, 'allowed', { present: Boolean(record) })
    return record
  }

  private updateUserField(
    groupJid: string,
    userJid: string,
    field: 'language' | 'timezone' | 'quietHours' | 'notificationsEnabled' | 'verbosity' | 'format',
    value: string | QuietHours | null | boolean,
    now: number,
  ): UserPreferencesRecord {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateJid(userJid, 'personalization user')
    const params = field === 'quietHours'
      ? { enabled: value === null ? 0 : 1, start: value === null ? null : (value as QuietHours).start, end: value === null ? null : (value as QuietHours).end }
      : { value: typeof value === 'boolean' ? (value ? 1 : 0) : value }
    if (field === 'quietHours') {
      this.database().prepare(`
        INSERT INTO user_preferences (group_jid, user_jid, quiet_enabled, quiet_start, quiet_end, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_jid, user_jid) DO UPDATE SET quiet_enabled = excluded.quiet_enabled, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, updated_at = excluded.updated_at
      `).run(groupJid, userJid, params.enabled, params.start, params.end, now)
    } else {
      const column = userColumn(field)
      this.database().prepare(`
        INSERT INTO user_preferences (group_jid, user_jid, ${column}, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(group_jid, user_jid) DO UPDATE SET ${column} = excluded.${column}, updated_at = excluded.updated_at
      `).run(groupJid, userJid, params.value, now)
    }
    this.audit('personalization.user.updated', userJid, groupJid, 'changed', { field })
    return this.getUserPreferences(groupJid, userJid) as UserPreferencesRecord
  }

  private updateGroupField(
    groupJid: string,
    updatedBy: string,
    field: 'language' | 'timezone' | 'quietHours' | 'notificationsEnabled' | 'verbosity' | 'format',
    value: string | QuietHours | null | boolean,
    now: number,
  ): GroupPolicyRecord {
    validateGroupJid(groupJid)
    this.requireEnabled(groupJid)
    validateJid(updatedBy, 'personalization policy actor')
    if (field === 'quietHours') {
      const quiet = value as QuietHours | null
      this.database().prepare(`
        INSERT INTO group_policies (group_jid, quiet_enabled, quiet_start, quiet_end, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(group_jid) DO UPDATE SET quiet_enabled = excluded.quiet_enabled, quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run(groupJid, quiet === null ? 0 : 1, quiet?.start ?? null, quiet?.end ?? null, updatedBy, now)
    } else {
      const column = groupColumn(field)
      this.database().prepare(`
        INSERT INTO group_policies (group_jid, ${column}, updated_by, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(group_jid) DO UPDATE SET ${column} = excluded.${column}, updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run(groupJid, typeof value === 'boolean' ? (value ? 1 : 0) : value, updatedBy, now)
    }
    this.audit('personalization.group.updated', updatedBy, groupJid, 'changed', { field })
    return this.getGroupPolicy(groupJid) as GroupPolicyRecord
  }

  private requireEnabled(groupJid: string): void {
    if (!this.isEnabled(groupJid)) throw new Error('Personalization feature is disabled for this group')
  }

  private audit(eventType: string, actorJid: string, groupJid: string, outcome: 'allowed' | 'changed' | 'limited' | 'failed', metadata: Record<string, unknown>): void {
    this.guardrailService().recordAudit({ eventType, namespace: 'allybot', occurredAt: this.clock(), actorJid, resourceJid: groupJid, outcome, metadata })
  }

  private migrate(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        group_jid TEXT NOT NULL,
        user_jid TEXT NOT NULL,
        language TEXT CHECK (language IS NULL OR language IN ('id', 'en')),
        timezone TEXT,
        quiet_enabled INTEGER CHECK (quiet_enabled IS NULL OR quiet_enabled IN (0, 1)),
        quiet_start TEXT,
        quiet_end TEXT,
        notifications_enabled INTEGER CHECK (notifications_enabled IS NULL OR notifications_enabled IN (0, 1)),
        verbosity TEXT CHECK (verbosity IS NULL OR verbosity IN ('brief', 'normal', 'detailed')),
        accessibility_format TEXT CHECK (accessibility_format IS NULL OR accessibility_format IN ('plain', 'accessible')),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (group_jid, user_jid)
      );
      CREATE INDEX IF NOT EXISTS idx_user_preferences_group ON user_preferences (group_jid, updated_at DESC);
      CREATE TABLE IF NOT EXISTS group_policies (
        group_jid TEXT PRIMARY KEY,
        language TEXT CHECK (language IS NULL OR language IN ('id', 'en')),
        timezone TEXT,
        quiet_enabled INTEGER CHECK (quiet_enabled IS NULL OR quiet_enabled IN (0, 1)),
        quiet_start TEXT,
        quiet_end TEXT,
        notifications_enabled INTEGER CHECK (notifications_enabled IS NULL OR notifications_enabled IN (0, 1)),
        verbosity TEXT CHECK (verbosity IS NULL OR verbosity IN ('brief', 'normal', 'detailed')),
        accessibility_format TEXT CHECK (accessibility_format IS NULL OR accessibility_format IN ('plain', 'accessible')),
        updated_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_group_policies_updated ON group_policies (updated_at DESC);
    `)
  }

  private database(): Database.Database {
    if (!this.db?.open) throw new Error('Personalization service is not initialized')
    return this.db
  }

  private guardrailService(): PlatformGuardrailService {
    if (!this.guardrails) throw new Error('Personalization guardrails service is not initialized')
    return this.guardrails
  }
}

function userColumn(field: 'language' | 'timezone' | 'notificationsEnabled' | 'verbosity' | 'format'): string {
  return {
    language: 'language',
    timezone: 'timezone',
    notificationsEnabled: 'notifications_enabled',
    verbosity: 'verbosity',
    format: 'accessibility_format',
  }[field]
}

function groupColumn(field: 'language' | 'timezone' | 'notificationsEnabled' | 'verbosity' | 'format'): string {
  return userColumn(field)
}
