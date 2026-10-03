import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

export interface Config {
  deezer_arl: string
  default_quota: number
  premium_quota: number
  cooldown_group_ms: number
  cooldown_dm_ms: number
  max_concurrent: number
  cache_ttl_meta_ms: number
  cache_ttl_neg_ms: number
  cache_ttl_audio_ms: number
  cache_max_bytes: number
  owners: string[]
  premium_users: string[]
  premium_groups: string[]
  timezone_offset: number
}

const DEFAULTS: Omit<Config, 'deezer_arl'> = {
  default_quota: 20,
  premium_quota: 200,
  cooldown_group_ms: 15000,
  cooldown_dm_ms: 5000,
  max_concurrent: 3,
  cache_ttl_meta_ms: 86400000,
  cache_ttl_neg_ms: 600000,
  cache_ttl_audio_ms: 172800000,
  cache_max_bytes: 5368709120,
  owners: [],
  premium_users: [],
  premium_groups: [],
  timezone_offset: 7,
}

const CONFIG_PATH = resolve('/opt/Allybot/data/config.json')

let _config: Config | null = null

export function loadConfig(): Config {
  if (_config) return _config

  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Music config not found at ${CONFIG_PATH}. Create it with a valid deezer_arl.`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (e) {
    throw new Error(`Failed to parse music config at ${CONFIG_PATH}: ${String(e)}`)
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Music config must be a JSON object')
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj['deezer_arl'] !== 'string' || obj['deezer_arl'].length === 0) {
    throw new Error('Music config missing required field: deezer_arl (string)')
  }

  _config = {
    deezer_arl: obj['deezer_arl'] as string,
    default_quota:
      typeof obj['default_quota'] === 'number' ? obj['default_quota'] : DEFAULTS.default_quota,
    premium_quota:
      typeof obj['premium_quota'] === 'number' ? obj['premium_quota'] : DEFAULTS.premium_quota,
    cooldown_group_ms:
      typeof obj['cooldown_group_ms'] === 'number'
        ? obj['cooldown_group_ms']
        : DEFAULTS.cooldown_group_ms,
    cooldown_dm_ms:
      typeof obj['cooldown_dm_ms'] === 'number' ? obj['cooldown_dm_ms'] : DEFAULTS.cooldown_dm_ms,
    max_concurrent:
      typeof obj['max_concurrent'] === 'number' ? obj['max_concurrent'] : DEFAULTS.max_concurrent,
    cache_ttl_meta_ms:
      typeof obj['cache_ttl_meta_ms'] === 'number'
        ? obj['cache_ttl_meta_ms']
        : DEFAULTS.cache_ttl_meta_ms,
    cache_ttl_neg_ms:
      typeof obj['cache_ttl_neg_ms'] === 'number'
        ? obj['cache_ttl_neg_ms']
        : DEFAULTS.cache_ttl_neg_ms,
    cache_ttl_audio_ms:
      typeof obj['cache_ttl_audio_ms'] === 'number'
        ? obj['cache_ttl_audio_ms']
        : DEFAULTS.cache_ttl_audio_ms,
    cache_max_bytes:
      typeof obj['cache_max_bytes'] === 'number' ? obj['cache_max_bytes'] : DEFAULTS.cache_max_bytes,
    owners: Array.isArray(obj['owners'])
      ? (obj['owners'] as string[]).filter((x) => typeof x === 'string')
      : DEFAULTS.owners,
    premium_users: Array.isArray(obj['premium_users'])
      ? (obj['premium_users'] as string[]).filter((x) => typeof x === 'string')
      : DEFAULTS.premium_users,
    premium_groups: Array.isArray(obj['premium_groups'])
      ? (obj['premium_groups'] as string[]).filter((x) => typeof x === 'string')
      : DEFAULTS.premium_groups,
    timezone_offset:
      typeof obj['timezone_offset'] === 'number'
        ? obj['timezone_offset']
        : DEFAULTS.timezone_offset,
  }

  return _config
}

/** Reset the singleton (for testing). */
export function _resetConfig(): void {
  _config = null
}
