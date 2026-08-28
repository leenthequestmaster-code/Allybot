import { createHash } from 'node:crypto'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import { isGroupJid, isJid } from '../platform/validation.js'
import {
  createSupabaseReadWriteClient,
  readSupabaseReadWriteConfig,
  type SupabaseReadWriteConfig,
} from '../supabase-read-write.js'
import type { CharacterSheetPayload } from './character-sheet-parser.js'

export interface CharacterRpcClient {
  rpc(functionName: string, args: Record<string, string | number | boolean | null | object>): PromiseLike<{
    data: unknown
    error: { code?: unknown; message?: unknown } | null
  }>
}

export interface CharacterGuideServiceOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly createClient?: (config: SupabaseReadWriteConfig) => CharacterRpcClient
  readonly clock?: () => number
}

export interface CharacterRegistrationSession {
  readonly sessionId: string
  readonly referenceKey: string
  readonly code: string
  readonly expiresAt?: string
  readonly existing: boolean
}

export interface CharacterSaveResult {
  readonly characterId: string
  readonly deliveryId?: string
  readonly name: string
  readonly status: 'saved'
}

export interface CharacterActiveRecord {
  readonly characterId: string
  readonly name: string
  readonly gender: string
  readonly age: number
  readonly birthday: string
  readonly race: string
  readonly className: string
  readonly element: string
  readonly spirit?: string
  readonly crew?: string
  readonly rank: string
  readonly level: number
  readonly willOfPath: string
  readonly profession?: string
  readonly titles: readonly string[]
  readonly motto?: string
  readonly visual?: string
  readonly origin?: string
  readonly status: 'active'
  readonly revision: number
}

// Time RP System (PRD §5.1)
export const TIME_RP_DAYS = [
  'Solarys',
  'Lunaris',
  'Astryx',
  'Caelion',
  'Vireon',
  'Noctyra',
  'Elaris',
] as const

export const TIME_RP_MONTHS = [
  'Aurion',
  'Florentis',
  'Zephyra',
  'Emberfall',
  'Luminara',
  'Verdantia',
  'Solmora',
  'Astravia',
  'Umbralis',
  'Crystelle',
  'Nocturne',
  'Everglen',
] as const

export const TIME_RP_SEASONS = [
  { name: 'Bloomcrest', label: 'Musim Semi', startMonth: 1, endMonth: 3 },
  { name: 'Sunspire', label: 'Musim Panas', startMonth: 4, endMonth: 6 },
  { name: 'Goldleaf', label: 'Musim Gugur', startMonth: 7, endMonth: 8 },
  { name: 'Frostveil', label: 'Musim Dingin', startMonth: 9, endMonth: 10 },
  { name: 'Starfall', label: 'Musim Fenomena', startMonth: 11, endMonth: 12 },
] as const

export interface TimeRpResult {
  readonly rpTimestamp: number
  readonly rpDay: string
  readonly rpMonth: string
  readonly rpYear: number
  readonly rpSeason: string
  readonly rpSeasonLabel: string
  readonly rpHour: number
  readonly rpMinute: number
  readonly isDayTransition: boolean
  readonly nextTransitionAt: number
  readonly realTimestamp: number
}

const TIME_RP_EPOCH = new Date('2024-01-01T00:00:00+07:00').getTime() // Reference epoch in WIB
const TIME_RP_SCALE = 2 // 1 RL hour = 2 RP hours
const TIME_RP_DAY_TRANSITION_HOURS = [6, 18] // 06:00 and 18:00 WIB

function getWibOffset(): number {
  return 7 * 60 * 60 * 1000 // WIB = UTC+7
}

function getRpTimestamp(realMs: number): number {
  // RP time passes at 2x speed
  return TIME_RP_EPOCH + (realMs - TIME_RP_EPOCH) * TIME_RP_SCALE
}

function getRpDayOfYear(rpTimestamp: number): number {
  const rpDayMs = rpTimestamp - TIME_RP_EPOCH
  const rpDays = Math.floor(rpDayMs / (24 * 60 * 60 * 1000))
  return rpDays
}

function getRpYear(rpTimestamp: number): number {
  const rpDayOfYear = getRpDayOfYear(rpTimestamp)
  return 1 + Math.floor(rpDayOfYear / 360) // 360 RP days per year (12 months × 30 days)
}

function getRpMonth(rpTimestamp: number): { monthIndex: number; dayOfMonth: number } {
  const rpDayOfYear = getRpDayOfYear(rpTimestamp)
  const dayOfYear = rpDayOfYear % 360
  const monthIndex = Math.floor(dayOfYear / 30) // 0-11
  const dayOfMonth = (dayOfYear % 30) + 1 // 1-30
  return { monthIndex, dayOfMonth }
}

function getRpDayOfWeek(rpTimestamp: number): number {
  const rpDayOfYear = getRpDayOfYear(rpTimestamp)
  return rpDayOfYear % 7 // 0-6
}

function getRpHour(rpTimestamp: number): number {
  return Math.floor((rpTimestamp % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000))
}

function getRpMinute(rpTimestamp: number): number {
  return Math.floor((rpTimestamp % (60 * 60 * 1000)) / (60 * 1000))
}

function getRpSeason(monthIndex: number): { name: string; label: string } {
  const monthNumber = monthIndex + 1 // 1-12
  const season = TIME_RP_SEASONS.find(s => monthNumber >= s.startMonth && monthNumber <= s.endMonth)
  return season ? { name: season.name, label: season.label } : { name: 'Unknown', label: 'Unknown' }
}

function getNextDayTransition(realMs: number): number {
  const wibMs = realMs + getWibOffset()
  const wibDate = new Date(wibMs)
  const currentHour = wibDate.getUTCHours()

  let nextTransitionHour = 24
  for (const h of TIME_RP_DAY_TRANSITION_HOURS) {
    if (h > currentHour) {
      nextTransitionHour = h
      break
    }
  }

  const nextTransition = new Date(wibDate)
  nextTransition.setUTCHours(nextTransitionHour, 0, 0, 0)
  if (nextTransitionHour === 24) {
    nextTransition.setUTCDate(nextTransition.getUTCDate() + 1)
    nextTransition.setUTCHours(6, 0, 0, 0)
  }

  return nextTransition.getTime() - getWibOffset()
}

function isDayTransitionHour(realMs: number): boolean {
  const wibMs = realMs + getWibOffset()
  const wibDate = new Date(wibMs)
  const hour = wibDate.getUTCHours()
  return TIME_RP_DAY_TRANSITION_HOURS.includes(hour) && wibDate.getUTCMinutes() === 0
}

export function calculateTimeRp(realMs = Date.now()): TimeRpResult {
  const rpTimestamp = getRpTimestamp(realMs)
  const { monthIndex, dayOfMonth } = getRpMonth(rpTimestamp)
  const dayOfWeek = getRpDayOfWeek(rpTimestamp)
  const season = getRpSeason(monthIndex)
  const nextTransitionAt = getNextDayTransition(realMs)
  const isDayTransition = isDayTransitionHour(realMs)

  return {
    rpTimestamp,
    rpDay: TIME_RP_DAYS[dayOfWeek],
    rpMonth: TIME_RP_MONTHS[monthIndex],
    rpYear: getRpYear(rpTimestamp),
    rpSeason: season.name,
    rpSeasonLabel: season.label,
    rpHour: getRpHour(rpTimestamp),
    rpMinute: getRpMinute(rpTimestamp),
    isDayTransition,
    nextTransitionAt,
    realTimestamp: realMs,
  }
}

export function formatTimeRp(result: TimeRpResult): string {
  const lines = [
    '⏰ *Time RP Allyssea*',
    '',
    `📅 *Hari* : ${result.rpDay}, ${result.rpMonth} ${result.rpYear} KAR`,
    `🌸 *Musim* : ${result.rpSeasonLabel} (${result.rpSeason})`,
    `🕐 *Waktu* : ${String(result.rpHour).padStart(2, '0')}:${String(result.rpMinute).padStart(2, '0')} RP`,
    '',
    `🔄 Pergantian hari RP: 06:00 & 18:00 WIB`,
    `📊 Skala: 1 Jam RL = 2 Jam RP`,
    `⏭️ Transisi berikutnya: <t:${Math.floor(result.nextTransitionAt / 1000)}:R>`,
    '',
    '*© Allyssea Roleplay Community*',
  ]
  return lines.join('\n')
}

export class CharacterGuideUnavailableError extends Error {
  constructor() {
    super('Character Guide sedang tidak tersedia. Coba lagi nanti.')
    this.name = 'CharacterGuideUnavailableError'
  }
}

export class CharacterGuideValidationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CharacterGuideValidationError'
    this.code = code
  }
}

function canonicalJid(value: string): string {
  return value.trim().toLowerCase().replace(/:\d+(?=@)/u, '')
}

function hashIdentity(value: string): string {
  return createHash('sha256').update(canonicalJid(value)).digest('hex')
}

const CHARACTER_WORLD_SCOPE = 'character-world:allyssea:v1'

function hashReference(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
}

function worldScopeKey(): string {
  return hashIdentity(CHARACTER_WORLD_SCOPE)
}

function safeOperationKey(prefix: string, value: string): string {
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 32)
  return `${prefix}:${digest}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function responseError(result: unknown, fallback: string): never {
  const raw = asRecord(result)
  const code = typeof raw?.code === 'string' ? raw.code : 'unknown'
  throw new CharacterGuideValidationError(code, characterErrorMessage(code) ?? fallback)
}

function characterErrorMessage(code: string): string | undefined {
  switch (code) {
    case 'name_required': return 'Name wajib diisi.'
    case 'gender_invalid': return 'Gender harus Male, Female, atau Non-Binary.'
    case 'age_invalid': return 'Age harus berupa angka 5 sampai 500.'
    case 'birthday_invalid': return 'Birthday tidak valid atau tidak sesuai dengan Age.'
    case 'race_invalid': return 'Race tidak tersedia dalam daftar Character Sheet.'
    case 'element_invalid_or_locked': return 'Element tidak valid atau terkunci untuk Race tersebut.'
    case 'class_invalid': return 'Class tidak tersedia dalam daftar Character Sheet.'
    case 'will_of_path_invalid': return 'Will Of Path harus Light, Dark, atau Neutral.'
    case 'active_character_exists': return 'Kamu masih memiliki Character aktif. Hapus atau selesaikan lifecycle Character lama terlebih dahulu.'
    case 'wrong_registration_session': return 'Reply tidak cocok dengan session pendaftaranmu.'
    case 'session_expired': return 'Session pendaftaran sudah kedaluwarsa. Mulai lagi dengan !daftar.'
    case 'session_completed': return 'Character Sheet pada session ini sudah pernah disimpan.'
    case 'concurrent_registration': return 'Pendaftaran sedang diproses bersamaan. Periksa status Character lalu coba lagi.'
    case 'character_not_found': return 'Character aktif tidak ditemukan.'
    case 'character_not_active': return 'Character tersebut sudah tidak aktif.'
    case 'invalid_request': return 'Data pendaftaran tidak dapat diproses.'
    case 'invalid_identity': return 'Identitas pendaftaran tidak valid.'
    default: return undefined
  }
}

export class CharacterGuideService implements Service {
  readonly name = 'character-guide'

  private readonly env: NodeJS.ProcessEnv
  private readonly createClient: (config: SupabaseReadWriteConfig) => CharacterRpcClient
  private readonly clock: () => number
  private enabled = false
  private client: CharacterRpcClient | undefined

  constructor(
    private readonly logger: Logger,
    options: CharacterGuideServiceOptions = {},
  ) {
    this.env = options.env ?? process.env
    this.createClient = options.createClient ?? ((config) => createSupabaseReadWriteClient(config))
    this.clock = options.clock ?? (() => Date.now())
  }

  initialize(_context: ServiceContext): void {
    this.enabled = this.env.CHARACTER_GUIDE_ENABLED?.trim().toLowerCase() === 'true'
    if (!this.enabled) return
    const config = readSupabaseReadWriteConfig(this.env)
    if (!config) throw new Error('Character Guide requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
    this.client = this.createClient(config)
    this.logger.info('Supabase Character Guide service initialized')
  }

  shutdown(_context: ServiceContext): void {
    this.client = undefined
  }

  get isEnabled(): boolean {
    return this.enabled
  }

  get isReady(): boolean {
    return this.enabled && this.client !== undefined
  }

  createCardReference(groupJid: string, ownerJid: string, cardCode: string): string {
    this.assertGroup(groupJid)
    this.assertJid(ownerJid, 'owner')
    if (!/^[A-Za-z0-9_-]{8,32}$/u.test(cardCode)) throw new Error('cardCode must be bounded and safe')
    return hashReference([hashIdentity(groupJid), hashIdentity(ownerJid), cardCode])
  }

  async startRegistration(groupJid: string, ownerJid: string, referenceKey: string, ttlSeconds = 1800): Promise<CharacterRegistrationSession> {
    this.assertGroup(groupJid)
    this.assertJid(ownerJid, 'owner')
    if (!this.client) throw new CharacterGuideUnavailableError()
    const result = await this.call('character_registration_start', {
      p_guide_key: worldScopeKey(),
      p_owner_key: hashIdentity(ownerJid),
      p_quoted_reference_key: referenceKey,
      p_ttl_seconds: ttlSeconds,
    })
    const raw = asRecord(result)
    if (raw?.ok !== true) responseError(result, 'Session pendaftaran tidak dapat dimulai.')
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined
    const storedReference = typeof raw.quoted_reference_key === 'string' ? raw.quoted_reference_key : undefined
    if (!sessionId || !storedReference) throw new CharacterGuideUnavailableError()
    return {
      sessionId,
      referenceKey: storedReference,
      code: typeof raw.code === 'string' ? raw.code : 'created',
      ...(typeof raw.expires_at === 'string' ? { expiresAt: raw.expires_at } : {}),
      existing: raw.code === 'existing',
    }
  }

  async getRegistration(groupJid: string, ownerJid: string): Promise<CharacterRegistrationSession | undefined> {
    this.assertGroup(groupJid)
    this.assertJid(ownerJid, 'owner')
    if (!this.client) throw new CharacterGuideUnavailableError()
    const result = await this.call('character_registration_get', {
      p_guide_key: worldScopeKey(),
      p_owner_key: hashIdentity(ownerJid),
    })
    const raw = asRecord(result)
    if (raw?.ok !== true || raw.code !== 'found') return undefined
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined
    const referenceKey = typeof raw.quoted_reference_key === 'string' ? raw.quoted_reference_key : undefined
    if (!sessionId || !referenceKey) return undefined
    return {
      sessionId,
      referenceKey,
      code: 'existing',
      ...(typeof raw.expires_at === 'string' ? { expiresAt: raw.expires_at } : {}),
      existing: true,
    }
  }

  async cancelRegistration(groupJid: string, ownerJid: string, sessionId: string): Promise<void> {
    this.assertGroup(groupJid)
    this.assertJid(ownerJid, 'owner')
    if (!/^[0-9a-f-]{20,64}$/iu.test(sessionId)) throw new CharacterGuideValidationError('invalid_session_id', 'Session pendaftaran tidak valid.')
    if (!this.client) throw new CharacterGuideUnavailableError()
    const result = await this.call('character_registration_cancel', {
      p_session_id: sessionId,
      p_guide_key: worldScopeKey(),
      p_owner_key: hashIdentity(ownerJid),
    })
    if (asRecord(result)?.ok !== true) responseError(result, 'Session pendaftaran belum dapat dibatalkan.')
  }

  async pendingDelivery(groupJid: string, ownerJid: string): Promise<string | undefined> {
    this.assertGroup(groupJid)
    return this.pendingDeliveryForOwner(ownerJid)
  }

  async pendingDeliveryForOwner(ownerJid: string): Promise<string | undefined> {
    this.assertJid(ownerJid, 'owner')
    if (!this.client) throw new CharacterGuideUnavailableError()
    const result = await this.call('character_delivery_pending', {
      p_guide_key: worldScopeKey(),
      p_owner_key: hashIdentity(ownerJid),
    })
    const raw = asRecord(result)
    return raw?.ok === true && raw.code === 'found' && typeof raw.delivery_id === 'string' ? raw.delivery_id : undefined
  }

  async save(
    groupJid: string,
    ownerJid: string,
    sessionId: string,
    referenceKey: string,
    payload: CharacterSheetPayload,
    sourceMessageId: string,
  ): Promise<CharacterSaveResult> {
    this.assertGroup(groupJid)
    this.assertJid(ownerJid, 'owner')
    if (!this.client) throw new CharacterGuideUnavailableError()
    const operationKey = safeOperationKey('character-save', sourceMessageId)
    const requestPayload = {
      name: payload.name,
      gender: payload.gender,
      age: String(payload.age),
      birthday_day: String(payload.birthdayDay),
      birthday_month: payload.birthdayMonth,
      birthday_year: String(payload.birthdayYear),
      race: payload.race,
      class_name: payload.className,
      element: payload.element,
      will_of_path: payload.willOfPath,
      ...(payload.spirit ? { spirit: payload.spirit } : {}),
      ...(payload.crew ? { crew: payload.crew } : {}),
      ...(payload.profession ? { profession: payload.profession } : {}),
      ...(payload.motto ? { motto: payload.motto } : {}),
      ...(payload.visual ? { visual: payload.visual } : {}),
      ...(payload.origin ? { origin: payload.origin } : {}),
    }
    const requestHash = hashReference([operationKey, JSON.stringify(requestPayload), referenceKey])
    const result = await this.call('character_save', {
      p_session_id: sessionId,
      p_guide_key: worldScopeKey(),
      p_owner_key: hashIdentity(ownerJid),
      p_quoted_reference_key: referenceKey,
      p_operation_key: operationKey,
      p_request_hash: requestHash,
      p_payload: requestPayload,
    })
    const raw = asRecord(result)
    if (raw?.ok !== true || raw.code !== 'saved') responseError(result, 'Character Sheet belum dapat disimpan.')
    const characterId = typeof raw.character_id === 'string' ? raw.character_id : undefined
    if (!characterId) throw new CharacterGuideUnavailableError()
    return {
      characterId,
      ...(typeof raw.delivery_id === 'string' ? { deliveryId: raw.delivery_id } : {}),
      name: payload.name,
      status: 'saved',
    }
  }

  async getActive(groupJid: string, ownerJid: string): Promise<CharacterActiveRecord | undefined> {
    this.assertGroup(groupJid)
    return this.getActiveForOwner(ownerJid)
  }

  async getActiveForOwner(ownerJid: string): Promise<CharacterActiveRecord | undefined> {
    this.assertJid(ownerJid, 'owner')
    if (!this.client) throw new CharacterGuideUnavailableError()
    const result = await this.call('character_get_active', {
      p_guide_key: worldScopeKey(),
      p_owner_key: hashIdentity(ownerJid),
    })
    const raw = asRecord(result)
    if (raw?.ok !== true || raw.code === 'not_found') return undefined
    const id = typeof raw.character_id === 'string' ? raw.character_id : undefined
    const titles = Array.isArray(raw.titles) ? raw.titles.filter((value): value is string => typeof value === 'string') : []
    if (!id) throw new CharacterGuideUnavailableError()
    return {
      characterId: id,
      name: String(raw.name ?? ''),
      gender: String(raw.gender ?? ''),
      age: Number(raw.age ?? 0),
      birthday: `${String(raw.birthday_day ?? '')} ${String(raw.birthday_month ?? '')} ${String(raw.birthday_year ?? '')} KAR`,
      race: String(raw.race ?? ''),
      className: String(raw.class_name ?? ''),
      element: String(raw.element ?? ''),
      ...(typeof raw.spirit === 'string' ? { spirit: raw.spirit } : {}),
      ...(typeof raw.crew === 'string' ? { crew: raw.crew } : {}),
      rank: String(raw.rank ?? 'F-'),
      level: Number(raw.level ?? 1),
      willOfPath: String(raw.will_of_path ?? ''),
      ...(typeof raw.profession === 'string' ? { profession: raw.profession } : {}),
      titles,
      ...(typeof raw.motto === 'string' ? { motto: raw.motto } : {}),
      ...(typeof raw.visual === 'string' ? { visual: raw.visual } : {}),
      ...(typeof raw.origin === 'string' ? { origin: raw.origin } : {}),
      status: 'active',
      revision: Number(raw.revision ?? 1),
    }
  }

  async retire(groupJid: string, ownerJid: string, characterId: string, reasonCode = 'owner_requested', sourceMessageId = ''): Promise<void> {
    this.assertGroup(groupJid)
    this.assertJid(ownerJid, 'owner')
    if (!/^[0-9a-f-]{20,64}$/iu.test(characterId)) throw new CharacterGuideValidationError('invalid_character_id', 'ID Character tidak valid.')
    if (!this.client) throw new CharacterGuideUnavailableError()
    const operationKey = safeOperationKey('character-retire', sourceMessageId || `${ownerJid}:${characterId}`)
    const result = await this.call('character_retire', {
      p_guide_key: worldScopeKey(),
      p_owner_key: hashIdentity(ownerJid),
      p_character_id: characterId,
      p_to_status: 'off',
      p_operation_key: operationKey,
      p_request_hash: hashReference([operationKey, characterId, reasonCode]),
      p_reason_code: reasonCode,
    })
    if (asRecord(result)?.ok !== true) responseError(result, 'Character tidak dapat dihapus.')
  }

  async markDelivery(deliveryId: string, status: 'sent' | 'failed' | 'pending', errorCode?: string): Promise<void> {
    if (!this.client || !/^[0-9a-f-]{20,64}$/iu.test(deliveryId)) return
    await this.call('character_delivery_mark', {
      p_delivery_id: deliveryId,
      p_status: status,
      p_error_code: errorCode ?? null,
    })
  }

  private async call(functionName: string, args: Record<string, string | number | boolean | null | object>): Promise<unknown> {
    if (!this.client) throw new CharacterGuideUnavailableError()
    const { data, error } = await this.client.rpc(functionName, args)
    if (error) {
      this.logger.warn({ functionName, code: typeof error.code === 'string' ? error.code : undefined }, 'character guide RPC failed')
      throw new CharacterGuideUnavailableError()
    }
    return data
  }

  private assertGroup(value: string): void {
    if (!isGroupJid(value)) throw new CharacterGuideValidationError('invalid_group', 'Command ini hanya dapat digunakan di dalam grup.')
  }

  private assertJid(value: string, field: string): void {
    if (!isJid(value)) throw new CharacterGuideValidationError('invalid_jid', `Identitas ${field} tidak valid.`)
  }
}
