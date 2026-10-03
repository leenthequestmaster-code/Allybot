import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { readdir } from 'fs/promises'
import { resolve } from 'path'
import type { Config } from './music-config.js'
// @ts-ignore — gerdur-core types are in internal subpath; we infer the type at usage
import type { getTrackInfo as _gti } from 'gerdur-core'
type trackType = Awaited<ReturnType<typeof _gti>>

// ─── Paths ────────────────────────────────────────────────────────────────────

const AUDIO_DIR = resolve('/opt/Allybot/data/cache/audio')
const META_PATH = resolve('/opt/Allybot/data/cache/meta.json')

mkdirSync(AUDIO_DIR, { recursive: true })

// ─── Types ────────────────────────────────────────────────────────────────────

interface TrackMeta {
  track: trackType
  lyrics?: string
  syncedLyrics?: string
  filePath: string
  cachedAt: number
}

interface QueryEntry {
  trackId: string
  cachedAt: number
}

interface MetaStore {
  queries: Record<string, QueryEntry>
  tracks: Record<string, TrackMeta>
  negative: Record<string, number>
}

// ─── In-memory state ──────────────────────────────────────────────────────────

const state: MetaStore = {
  queries: {},
  tracks: {},
  negative: {},
}

// ─── Normalization ────────────────────────────────────────────────────────────

export function normalizeQuery(q: string): string {
  return q
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
}

function tokenSort(s: string): string {
  return s
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ')
}

function fuzzyMatch(a: string, b: string): boolean {
  if (a === b) return true
  return tokenSort(a) === tokenSort(b)
}

// ─── Query → TrackId  (Layer A) ───────────────────────────────────────────────

export function getCachedTrack(
  rawQuery: string,
  config: Config,
): trackType | null {
  const key = normalizeQuery(rawQuery)
  const now = Date.now()

  // Exact match
  let entry = state.queries[key]

  // Fuzzy match fallback
  if (!entry) {
    for (const [k, v] of Object.entries(state.queries)) {
      if (fuzzyMatch(key, k)) {
        entry = v
        break
      }
    }
  }

  if (!entry) return null
  if (now - entry.cachedAt > config.cache_ttl_meta_ms) {
    delete state.queries[key]
    return null
  }

  const meta = state.tracks[entry.trackId]
  if (!meta) return null
  if (now - meta.cachedAt > config.cache_ttl_meta_ms) {
    delete state.tracks[entry.trackId]
    delete state.queries[key]
    return null
  }

  return meta.track
}

export function setCachedTrack(rawQuery: string, track: trackType): void {
  const key = normalizeQuery(rawQuery)
  const trackId = String(track.SNG_ID)
  state.queries[key] = { trackId, cachedAt: Date.now() }
}

// ─── TrackId → { meta, lyrics, filePath }  (Layer B) ─────────────────────────

export function getCachedById(
  trackId: string,
  config: Config,
): TrackMeta | null {
  const meta = state.tracks[trackId]
  if (!meta) return null
  if (Date.now() - meta.cachedAt > config.cache_ttl_meta_ms) {
    delete state.tracks[trackId]
    return null
  }
  return meta
}

export function setCachedById(
  trackId: string,
  data: {
    track: trackType
    lyrics?: string
    syncedLyrics?: string
    filePath: string
  },
): void {
  state.tracks[trackId] = { ...data, cachedAt: Date.now() }
}

// ─── Negative cache  (Layer C) ───────────────────────────────────────────────

export function isNegative(rawQuery: string, config: Config): boolean {
  const key = normalizeQuery(rawQuery)
  const ts = state.negative[key]
  if (!ts) return false
  if (Date.now() - ts > config.cache_ttl_neg_ms) {
    delete state.negative[key]
    return false
  }
  return true
}

export function setNegative(rawQuery: string): void {
  const key = normalizeQuery(rawQuery)
  state.negative[key] = Date.now()
}

// ─── Audio file path ──────────────────────────────────────────────────────────

export function audioPathFor(trackId: string): string {
  const hash = createHash('sha1').update(trackId).digest('hex').slice(0, 16)
  return resolve(AUDIO_DIR, `${hash}.mp3`)
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export function persistMeta(): void {
  try {
    writeFileSync(META_PATH, JSON.stringify(state, null, 2), 'utf8')
  } catch {
    // best-effort
  }
}

export function restoreMeta(): void {
  if (!existsSync(META_PATH)) return
  try {
    const data = JSON.parse(readFileSync(META_PATH, 'utf8')) as Partial<MetaStore>
    if (data.queries && typeof data.queries === 'object') {
      Object.assign(state.queries, data.queries)
    }
    if (data.tracks && typeof data.tracks === 'object') {
      Object.assign(state.tracks, data.tracks)
    }
    if (data.negative && typeof data.negative === 'object') {
      Object.assign(state.negative, data.negative)
    }
  } catch {
    // corrupted — start fresh
  }
}

// ─── Garbage Collection ───────────────────────────────────────────────────────

export async function runGC(config: Config): Promise<void> {
  const now = Date.now()

  // Evict expired negative entries
  for (const [k, ts] of Object.entries(state.negative)) {
    if (now - ts > config.cache_ttl_neg_ms) delete state.negative[k]
  }

  // Evict expired query entries
  for (const [k, v] of Object.entries(state.queries)) {
    if (now - v.cachedAt > config.cache_ttl_meta_ms) delete state.queries[k]
  }

  // Evict expired track meta
  for (const [k, v] of Object.entries(state.tracks)) {
    if (now - v.cachedAt > config.cache_ttl_meta_ms) delete state.tracks[k]
  }

  // Measure audio dir size
  let totalBytes = 0
  let files: Array<{ name: string; size: number; mtime: number }> = []

  try {
    const entries = await readdir(AUDIO_DIR)
    for (const name of entries) {
      const p = resolve(AUDIO_DIR, name)
      try {
        const st = statSync(p)
        if (st.isFile()) {
          files.push({ name, size: st.size, mtime: st.mtimeMs })
          totalBytes += st.size
        }
      } catch {
        // skip
      }
    }
  } catch {
    return
  }

  // Evict audio files past TTL
  for (const f of files) {
    if (now - f.mtime > config.cache_ttl_audio_ms) {
      try {
        unlinkSync(resolve(AUDIO_DIR, f.name))
        totalBytes -= f.size
      } catch {
        // skip
      }
    }
  }

  // If still over 80% of cap, evict oldest files
  const cap = config.cache_max_bytes * 0.8
  if (totalBytes > cap) {
    files = files
      .filter((f) => existsSync(resolve(AUDIO_DIR, f.name)))
      .sort((a, b) => a.mtime - b.mtime)

    for (const f of files) {
      if (totalBytes <= cap) break
      try {
        unlinkSync(resolve(AUDIO_DIR, f.name))
        totalBytes -= f.size
      } catch {
        // skip
      }
    }
  }

  persistMeta()
}

// ─── Hourly GC interval ───────────────────────────────────────────────────────

export function startGCInterval(config: Config): NodeJS.Timeout {
  return setInterval(() => {
    runGC(config).catch(() => {})
  }, 60 * 60 * 1000)
}
