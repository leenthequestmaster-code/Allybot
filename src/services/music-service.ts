// @ts-ignore — gerdur-core ships CJS types in an ESM-first project; skipLibCheck covers this
import {
  initDeezerApi,
  searchMusic,
  getTrackInfo,
  downloadTrackBuffer,
  addTrackTags,
  getLyrics,
  DeezerError,
} from 'gerdur-core'
// @ts-ignore — lrclib-api types-only import fine; runtime is ESM
import { Client as LrclibClient } from 'lrclib-api'
import { existsSync, writeFileSync } from 'fs'
import { mkdirSync } from 'fs'
import type { Config } from './music-config.js'
import * as cache from './music-cache.js'
import * as circuit from './music-circuit.js'

// ─── Init ─────────────────────────────────────────────────────────────────────

let _initialized = false
const lrclib = new LrclibClient()

let _deezerReady = false

export async function initMusic(config: Config): Promise<void> {
  if (_initialized) return
  _initialized = true

  // Ensure dirs
  mkdirSync('/opt/Allybot/data/cache/audio', { recursive: true })

  // Restore cache metadata
  cache.restoreMeta()

  // Start hourly GC
  cache.startGCInterval(config)

  // Init Deezer session (best-effort — if ARL invalid, commands will lazy-retry)
  try {
    await initDeezerApi(config.deezer_arl)
    _deezerReady = true
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn('[music-service] initDeezerApi failed (plugin still loaded):', msg)
  }
}

async function ensureDeezerReady(config: Config): Promise<void> {
  if (_deezerReady) return
  await initDeezerApi(config.deezer_arl)
  _deezerReady = true
}

// ─── Error codes ──────────────────────────────────────────────────────────────

export class MusicError extends Error {
  constructor(
    public readonly code:
      | 'ARL_EXPIRED'
      | 'REGION_LOCKED'
      | 'NOT_FOUND'
      | 'DOWNLOAD_FAILED'
      | 'CIRCUIT_OPEN',
    message: string,
  ) {
    super(message)
    this.name = 'MusicError'
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function classifyDeezerError(e: unknown): MusicError {
  if (e instanceof DeezerError) {
    const keys = e.keys ?? []
    const msg = e.message ?? ''

    if (
      keys.some((k: string) =>
        ['VALID_TOKEN_REQUIRED', 'USER_TOKEN_EMPTY', 'INVALID_TOKEN'].includes(k),
      ) ||
      msg.toLowerCase().includes('token')
    ) {
      return new MusicError('ARL_EXPIRED', `Deezer ARL expired: ${msg}`)
    }

    if (
      keys.some((k: string) => ['GEOBLOCKED', 'GEO_BLOCKED'].includes(k)) ||
      msg.toLowerCase().includes('geo')
    ) {
      return new MusicError('REGION_LOCKED', `Track region-locked: ${msg}`)
    }
  }
  return new MusicError('DOWNLOAD_FAILED', String(e))
}

// ─── LRC helper ──────────────────────────────────────────────────────────────

async function fetchLrclibLyrics(
  artistName: string,
  trackName: string,
  albumName?: string,
): Promise<{ plainLyrics?: string; syncedLyrics?: string } | null> {
  try {
    const result = await lrclib.findLyrics({
      artist_name: artistName,
      track_name: trackName,
      ...(albumName ? { album_name: albumName } : {}),
    })
    if (!result) return null
    return {
      plainLyrics: result.plainLyrics ?? undefined,
      syncedLyrics: result.syncedLyrics ?? undefined,
    }
  } catch {
    return null
  }
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

export interface SearchResult {
  trackName: string
  artist: string
  album: string
  filePath: string
  lyrics?: string
  syncedLyrics?: string
  durationMs: number
}

export async function searchAndDownload(
  query: string,
  _tier: string,
  config: Config,
): Promise<SearchResult> {
  // Ensure Deezer session initialized (lazy init if ARL was invalid at startup)
  await ensureDeezerReady(config)

  // Circuit breaker check
  if (circuit.isOpen()) {
    throw new MusicError('CIRCUIT_OPEN', 'Deezer sementara tidak bisa dijangkau. Coba lagi dalam beberapa menit.')
  }

  // ── Layer A: Query cache ──────────────────────────────────────────────────
  const cachedTrack = cache.getCachedTrack(query, config)

  if (cachedTrack) {
    const trackId = String(cachedTrack.SNG_ID)
    const cached = cache.getCachedById(trackId, config)
    if (cached && existsSync(cached.filePath)) {
      return {
        trackName: cachedTrack.SNG_TITLE,
        artist: cachedTrack.ART_NAME,
        album: cachedTrack.ALB_TITLE,
        filePath: cached.filePath,
        lyrics: cached.lyrics,
        syncedLyrics: cached.syncedLyrics,
        durationMs: Number(cachedTrack.DURATION) * 1000,
      }
    }
  }

  // ── Search ────────────────────────────────────────────────────────────────
  let searchResult: Awaited<ReturnType<typeof searchMusic>>
  try {
    searchResult = await searchMusic(query, ['TRACK'], 5)
    circuit.probe()
  } catch (e) {
    circuit.trip()
    const me = classifyDeezerError(e)
    if (me.code === 'ARL_EXPIRED') {
      circuit.notifyOwner(config.owners, () => {})
    }
    throw me
  }

  const tracks = searchResult?.TRACK?.data
  if (!tracks || tracks.length === 0) {
    cache.setNegative(query)
    throw new MusicError('NOT_FOUND', `Lagu "${query}" tidak ditemukan di Deezer.`)
  }

  const topTrack = tracks[0]!
  const trackId = String(topTrack.SNG_ID)

  // Cache the query → track mapping
  cache.setCachedTrack(query, topTrack)

  // ── Check Layer B (cached audio already on disk) ───────────────────────────
  const existingMeta = cache.getCachedById(trackId, config)
  if (existingMeta && existsSync(existingMeta.filePath)) {
    return {
      trackName: topTrack.SNG_TITLE,
      artist: topTrack.ART_NAME,
      album: topTrack.ALB_TITLE,
      filePath: existingMeta.filePath,
      lyrics: existingMeta.lyrics,
      syncedLyrics: existingMeta.syncedLyrics,
      durationMs: Number(topTrack.DURATION) * 1000,
    }
  }

  // ── Get full track info ───────────────────────────────────────────────────
  let fullTrack: Awaited<ReturnType<typeof getTrackInfo>>
  try {
    fullTrack = await getTrackInfo(trackId)
    circuit.probe()
  } catch (e) {
    circuit.trip()
    throw classifyDeezerError(e)
  }

  // ── Download audio buffer ─────────────────────────────────────────────────
  // Try qualities in descending order; WrongLicense = skip to next, other errors = fatal
  let audioBuffer: Buffer | null = null
  let lastDownloadError: unknown = null
  for (const quality of [9, 3, 1]) {
    try {
      audioBuffer = await downloadTrackBuffer(fullTrack, quality)
      if (audioBuffer) {
        circuit.probe()
        break
      }
      // null return = unavailable at this quality, try next
    } catch (e) {
      const name = (e as Error)?.constructor?.name ?? ''
      // WrongLicense / GeoBlocked at this quality — try lower, don't trip circuit
      if (name === 'WrongLicense') {
        lastDownloadError = e
        continue
      }
      if (name === 'GeoBlocked') {
        throw new MusicError('REGION_LOCKED', 'Track tidak tersedia di region server.')
      }
      // Real Deezer/network error — trip circuit and bail
      circuit.trip()
      throw classifyDeezerError(e)
    }
  }

  if (!audioBuffer) {
    if (lastDownloadError && (lastDownloadError as Error)?.constructor?.name === 'WrongLicense') {
      throw new MusicError('DOWNLOAD_FAILED', 'Akun Deezer tidak memiliki lisensi stream untuk track ini.')
    }
    throw new MusicError('DOWNLOAD_FAILED', 'Tidak bisa download audio dari Deezer.')
  }

  // ── Tag the audio ─────────────────────────────────────────────────────────
  let taggedBuffer: Buffer
  try {
    const tagged = await addTrackTags(audioBuffer, fullTrack, {
      writeLyrics: true,
      embedCover: true,
      embedArtistImage: false,
    })
    taggedBuffer = tagged.buffer
  } catch {
    // If tagging fails, use raw buffer
    taggedBuffer = audioBuffer
  }

  // ── Write to cache file ───────────────────────────────────────────────────
  const filePath = cache.audioPathFor(trackId)
  writeFileSync(filePath, taggedBuffer)

  // ── Fetch lyrics ──────────────────────────────────────────────────────────
  let plainLyrics: string | undefined
  let syncedLyrics: string | undefined

  // Try Deezer lyrics first
  try {
    const deezerLyrics = await getLyrics(trackId)
    if (deezerLyrics?.LYRICS_TEXT) {
      plainLyrics = deezerLyrics.LYRICS_TEXT

      // Build LRC from sync data if available
      if (deezerLyrics.LYRICS_SYNC_JSON && deezerLyrics.LYRICS_SYNC_JSON.length > 0) {
        syncedLyrics = deezerLyrics.LYRICS_SYNC_JSON.map((l) => `${l.lrc_timestamp} ${l.line}`).join('\n')
      }
    }
  } catch {
    // fallback to lrclib
  }

  // Fallback to lrclib if no lyrics from Deezer
  if (!plainLyrics) {
    const lrcResult = await fetchLrclibLyrics(
      topTrack.ART_NAME,
      topTrack.SNG_TITLE,
      topTrack.ALB_TITLE,
    )
    if (lrcResult) {
      plainLyrics = lrcResult.plainLyrics
      syncedLyrics = lrcResult.syncedLyrics ?? undefined
    }
  }

  // ── Cache the result ──────────────────────────────────────────────────────
  cache.setCachedById(trackId, {
    track: topTrack,
    lyrics: plainLyrics,
    syncedLyrics,
    filePath,
  })
  cache.persistMeta()

  return {
    trackName: topTrack.SNG_TITLE,
    artist: topTrack.ART_NAME,
    album: topTrack.ALB_TITLE,
    filePath,
    lyrics: plainLyrics,
    syncedLyrics,
    durationMs: Number(topTrack.DURATION) * 1000,
  }
}
