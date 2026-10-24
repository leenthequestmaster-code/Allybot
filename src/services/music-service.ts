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
import { resolve } from 'path'
import { createHash } from 'crypto'
import type { Config } from './music-config.js'
import * as cache from './music-cache.js'
import * as circuit from './music-circuit.js'
import { enrichAudioBuffer, fetchLyricsEnriched, resolveCanonicalMetadata } from './music-enricher.js'

// ─── Init ─────────────────────────────────────────────────────────────────────

let _initialized = false
const lrclib = new LrclibClient()

let _deezerReady = false

export async function initMusic(config: Config): Promise<void> {
  if (_initialized) return
  _initialized = true

  // Ensure dirs
  mkdirSync(resolve(process.cwd(), 'data/cache/audio'), { recursive: true })

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
  year?: string
  genre?: string
  coverUrl?: string
  filePath: string
  lyrics?: string
  syncedLyrics?: string
  durationMs: number
}

async function downloadSoundCloudFallback(
  query: string,
): Promise<{ buffer: Buffer; title: string; artist: string; durationMs: number } | null> {
  try {
    const { default: SoundCloud } = await import('@zibot/scdl')
    const sc = new SoundCloud()
    await sc.init()
    const tracks = await sc.search({ query, limit: 3, type: 'tracks' })
    if (!Array.isArray(tracks) || tracks.length === 0) return null

    const top: any = tracks.find((t: any) => t.streamable && t.permalink_url) ?? tracks[0]
    if (!top || !top.permalink_url) return null

    const stream = await sc.downloadTrack(top.permalink_url)
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const buffer = Buffer.concat(chunks)
    if (buffer.length < 1000) return null

    return {
      buffer,
      title: String(top.title || query),
      artist: String(top.user?.username || 'SoundCloud'),
      durationMs: typeof top.duration === 'number' ? top.duration : 180_000,
    }
  } catch {
    return null
  }
}

async function downloadYouTubeFallback(
  query: string,
): Promise<{ buffer: Buffer; title: string; artist: string; durationMs: number } | null> {
  try {
    const { searchYouTube } = await import('./downloader/adapters/youtube-search.js')
    const { defaultDownloadYouTubeMedia } = await import('../framework/plugins/media-common.js')
    const results = await searchYouTube(query)
    if (!Array.isArray(results) || results.length === 0 || !results[0]?.url) return null

    const top = results[0]
    const downloaded = await defaultDownloadYouTubeMedia(top.url, 'audio')
    if (!downloaded || downloaded.data.length < 1000) return null

    let durationMs = 180_000
    if (top.duration && typeof top.duration === 'string') {
      const parts = top.duration.split(':').map(Number)
      if (parts.length === 2 && !isNaN(parts[0]!) && !isNaN(parts[1]!)) {
        durationMs = (parts[0]! * 60 + parts[1]!) * 1000
      }
    }

    return {
      buffer: Buffer.from(downloaded.data),
      title: top.title,
      artist: top.channel || 'YouTube',
      durationMs,
    }
  } catch {
    return null
  }
}

export async function fallbackSecondaryAudio(
  query: string,
  _config: Config,
): Promise<SearchResult | null> {
  const q = query?.trim()
  if (!q) return null

  // 1. Resolve canonical metadata first for optimal search keywords
  const canonical = await resolveCanonicalMetadata(q)
  const searchQuery = canonical.isCanonical ? `${canonical.artist} - ${canonical.title}` : q

  // 2. Prioritize SoundCloud (fast in-process stream)
  let result = await downloadSoundCloudFallback(searchQuery)
  let source = 'SoundCloud'

  // 3. Fall back to YouTube (yt-dlp)
  if (!result) {
    result = await downloadYouTubeFallback(searchQuery)
    source = 'YouTube'
  }

  // If still not found and searchQuery !== q, try original query on YouTube
  if (!result && searchQuery !== q) {
    result = await downloadYouTubeFallback(q)
    source = 'YouTube'
  }

  if (!result) return null

  // 4. Enrich audio buffer: transcode to standard MP3, fetch cover art, fetch lyrics, inject ID3 tags
  const enriched = await enrichAudioBuffer({
    query: q,
    rawAudio: result.buffer,
    canonicalHint: {
      title: canonical.isCanonical ? canonical.title : result.title,
      artist: canonical.isCanonical ? canonical.artist : result.artist,
      album: canonical.isCanonical ? canonical.album : source,
      year: canonical.year,
      genre: canonical.genre,
      artworkUrl: canonical.artworkUrl,
      durationMs: canonical.durationMs ?? result.durationMs,
    },
  })

  const trackId = `fb_${createHash('sha1').update(`${source}:${enriched.title}`).digest('hex').slice(0, 12)}`
  const filePath = cache.audioPathFor(trackId)
  writeFileSync(filePath, enriched.buffer)

  const pseudoTrack: any = {
    SNG_ID: trackId,
    SNG_TITLE: enriched.title,
    ART_NAME: enriched.artist,
    ALB_TITLE: enriched.album,
    YEAR: enriched.year,
    GENRE: enriched.genre,
    COVER_URL: enriched.coverUrl,
    DURATION: String(Math.round(enriched.durationMs / 1000)),
  }

  cache.setCachedById(trackId, {
    track: pseudoTrack,
    lyrics: enriched.lyrics,
    syncedLyrics: enriched.syncedLyrics,
    filePath,
  })
  cache.setCachedTrack(query, pseudoTrack)
  cache.persistMeta()

  return {
    trackName: enriched.title,
    artist: enriched.artist,
    album: enriched.album,
    year: enriched.year,
    genre: enriched.genre,
    coverUrl: enriched.coverUrl,
    filePath,
    lyrics: enriched.lyrics,
    syncedLyrics: enriched.syncedLyrics,
    durationMs: enriched.durationMs,
  }
}

export async function searchAndDownload(
  query: string,
  _tier: string,
  config: Config,
): Promise<SearchResult> {
  // Ensure Deezer session initialized (lazy init if ARL was invalid at startup)
  try {
    await ensureDeezerReady(config)
  } catch {
    // If Deezer init fails, fallback will handle it
  }

  // Circuit breaker check
  if (circuit.isOpen()) {
    const fallback = await fallbackSecondaryAudio(query, config)
    if (fallback) return fallback
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
        year: (cachedTrack as any).YEAR,
        genre: (cachedTrack as any).GENRE,
        coverUrl: (cachedTrack as any).COVER_URL,
        filePath: cached.filePath,
        lyrics: cached.lyrics,
        syncedLyrics: cached.syncedLyrics,
        durationMs: Number(cachedTrack.DURATION) * 1000,
      }
    }
  }

  // ── Search ────────────────────────────────────────────────────────────────
  let searchResult: Awaited<ReturnType<typeof searchMusic>> | undefined
  try {
    searchResult = await searchMusic(query, ['TRACK'], 5)
    circuit.probe()
  } catch (e) {
    circuit.trip()
    const me = classifyDeezerError(e)
    if (me.code === 'ARL_EXPIRED') {
      circuit.notifyOwner(config.owners, () => {})
    }
    const fallback = await fallbackSecondaryAudio(query, config)
    if (fallback) return fallback
    throw me
  }

  let tracks = searchResult?.TRACK?.data
  if (!tracks || tracks.length === 0) {
    // Secondary fallback: strip parentheses and hyphens for broader search
    const cleanFallback = query.replace(/[()[\]{}"'\\/-]/g, ' ').replace(/\s+/g, ' ').trim()
    if (cleanFallback && cleanFallback !== query) {
      try {
        const fallbackRes = await searchMusic(cleanFallback, ['TRACK'], 5)
        tracks = fallbackRes?.TRACK?.data
      } catch {
        // best-effort fallback
      }
    }
  }

  if (!tracks || tracks.length === 0) {
    const fallback = await fallbackSecondaryAudio(query, config)
    if (fallback) return fallback
    cache.setNegative(query)
    throw new MusicError('NOT_FOUND', `Lagu "${query}" tidak ditemukan di Deezer maupun fallback.`)
  }

  // Iterate through top candidate tracks (up to 3) in case the first has licensing/regional blocks
  let chosenTrack: (typeof tracks)[0] | null = null
  let fullTrack: Awaited<ReturnType<typeof getTrackInfo>> | null = null
  let audioBuffer: Buffer | null = null
  let lastDownloadError: unknown = null

  const isDjRequested = /\b(dj|remix|jedag|jedug)\b/i.test(query)
  for (const candidate of tracks.slice(0, 3)) {
    const candidateId = String(candidate.SNG_ID)
    const isCandidateRemix = /\b(dj|remix|jedag|jedug|koplo|slowed)\b/i.test(candidate.SNG_TITLE) || /\b(dj)\b/i.test(candidate.ART_NAME)
    if (!isDjRequested && isCandidateRemix) {
      continue
    }

    // Check if candidate is already cached on disk
    const existing = cache.getCachedById(candidateId, config)
    if (existing && existsSync(existing.filePath)) {
      cache.setCachedTrack(query, candidate)
      return {
        trackName: candidate.SNG_TITLE,
        artist: candidate.ART_NAME,
        album: candidate.ALB_TITLE,
        filePath: existing.filePath,
        lyrics: existing.lyrics,
        syncedLyrics: existing.syncedLyrics,
        durationMs: Number(candidate.DURATION) * 1000,
      }
    }

    try {
      const info = await getTrackInfo(candidateId)
      circuit.probe()

      let buf: Buffer | null = null
      for (const quality of [9, 3, 1]) {
        try {
          buf = await downloadTrackBuffer(info, quality)
          if (buf) {
            circuit.probe()
            break
          }
        } catch (e) {
          const name = (e as Error)?.name || (e as Error)?.constructor?.name || ''
          const msg = String(e)
          if (name === 'WrongLicense' || msg.includes('WrongLicense') || msg.includes('stream')) {
            lastDownloadError = e
            continue
          }
          if (name === 'GeoBlocked' || msg.includes('GeoBlocked')) {
            lastDownloadError = e
            continue
          }
          lastDownloadError = e
        }
      }

      if (buf) {
        audioBuffer = buf
        fullTrack = info
        chosenTrack = candidate
        break
      }
    } catch (e) {
      lastDownloadError = e
    }
  }

  if (!audioBuffer || !fullTrack || !chosenTrack) {
    const fallback = await fallbackSecondaryAudio(query, config)
    if (fallback) return fallback
    if (lastDownloadError && String(lastDownloadError).includes('WrongLicense')) {
      throw new MusicError('DOWNLOAD_FAILED', 'Akun Deezer tidak memiliki lisensi stream untuk track ini. Coba judul/versi lain.')
    }
    throw new MusicError('DOWNLOAD_FAILED', 'Tidak bisa download audio dari Deezer maupun fallback.')
  }

  const trackId = String(chosenTrack.SNG_ID)

  // Cache the query → track mapping
  cache.setCachedTrack(query, chosenTrack)

  // ── Fetch lyrics first (Deezer -> LRCLIB clean search) ────────────────────
  let plainLyrics: string | undefined
  let syncedLyrics: string | undefined

  // Try Deezer lyrics first
  try {
    const deezerLyrics = await getLyrics(trackId)
    if (deezerLyrics?.LYRICS_TEXT) {
      plainLyrics = deezerLyrics.LYRICS_TEXT

      if (deezerLyrics.LYRICS_SYNC_JSON && deezerLyrics.LYRICS_SYNC_JSON.length > 0) {
        syncedLyrics = deezerLyrics.LYRICS_SYNC_JSON.map((l) => `${l.lrc_timestamp} ${l.line}`).join('\n')
      }
    }
  } catch {}

  // Fallback to enriched LRCLIB if Deezer lyrics not available
  if (!plainLyrics) {
    const lrcResult = await fetchLyricsEnriched(
      chosenTrack.ART_NAME,
      chosenTrack.SNG_TITLE,
      chosenTrack.ALB_TITLE,
    )
    if (lrcResult.plainLyrics) {
      plainLyrics = lrcResult.plainLyrics
      syncedLyrics = lrcResult.syncedLyrics
    }
  }

  // ── Tag and Enrich Audio with ID3v2 Tags & Cover Art ───────────────────────
  const enriched = await enrichAudioBuffer({
    query: `${chosenTrack.ART_NAME} - ${chosenTrack.SNG_TITLE}`,
    rawAudio: audioBuffer,
    canonicalHint: {
      title: chosenTrack.SNG_TITLE,
      artist: chosenTrack.ART_NAME,
      album: chosenTrack.ALB_TITLE,
      durationMs: Number(chosenTrack.DURATION) * 1000,
    },
    explicitLyrics: plainLyrics,
  })

  // ── Write to cache file ───────────────────────────────────────────────────
  const filePath = cache.audioPathFor(trackId)
  writeFileSync(filePath, enriched.buffer)

  const cachedTrackMeta: any = {
    ...chosenTrack,
    YEAR: enriched.year,
    GENRE: enriched.genre,
    COVER_URL: enriched.coverUrl,
  }

  // ── Cache the result ──────────────────────────────────────────────────────
  cache.setCachedById(trackId, {
    track: cachedTrackMeta,
    lyrics: enriched.lyrics || plainLyrics,
    syncedLyrics: enriched.syncedLyrics || syncedLyrics,
    filePath,
  })
  cache.persistMeta()

  return {
    trackName: enriched.title,
    artist: enriched.artist,
    album: enriched.album,
    year: enriched.year,
    genre: enriched.genre,
    coverUrl: enriched.coverUrl,
    filePath,
    lyrics: enriched.lyrics || plainLyrics,
    syncedLyrics: enriched.syncedLyrics || syncedLyrics,
    durationMs: enriched.durationMs,
  }
}
