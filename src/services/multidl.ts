import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface MediaResolveResult {
  readonly id?: string
  readonly title: string
  readonly author: string
  readonly playUrl?: string
  readonly musicUrl?: string
  readonly coverUrl?: string
  readonly duration?: number
  readonly platform: 'tiktok' | 'youtube' | 'instagram' | 'twitter' | 'facebook' | 'reddit' | 'unknown'
}

export const PLATFORM_PATTERNS: Record<string, RegExp> = {
  tiktok: /https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s]+/i,
  instagram: /https?:\/\/(?:www\.)?instagram\.com\/(?:p|reel|tv|stories)\/[^\s]+/i,
  youtube: /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)[^\s]+/i,
  twitter: /https?:\/\/(?:www\.)?(?:twitter\.com|x\.com)\/[^\s]+\/status\/[^\s]+/i,
  facebook: /https?:\/\/(?:www\.)?(?:facebook\.com|fb\.watch)\/[^\s]+/i,
  reddit: /https?:\/\/(?:www\.)?reddit\.com\/r\/[^\s]+/i,
}

export function detectPlatform(url: string): string | null {
  for (const [name, pat] of Object.entries(PLATFORM_PATTERNS)) {
    if (pat.test(url)) return name
  }
  return null
}

export function extractMediaUrl(text: string): { url: string; platform: string } | null {
  if (!text) return null
  for (const [name, pat] of Object.entries(PLATFORM_PATTERNS)) {
    const match = text.match(pat)
    if (match) {
      const cleanUrl = match[0].replace(/[.,;!?)"']+$/u, '')
      return { url: cleanUrl, platform: name }
    }
  }
  return null
}

// In-Memory Shared Resolve Cache: 30 minutes TTL, max 500 entries
const RESOLVE_CACHE_TTL_MS = 1800_000
const RESOLVE_CACHE_MAX = 500
const _resolveCache = new Map<string, { ts: number; data: MediaResolveResult }>()

function getCachedResolve(url: string): MediaResolveResult | null {
  const entry = _resolveCache.get(url)
  if (!entry) return null
  if (Date.now() - entry.ts > RESOLVE_CACHE_TTL_MS) {
    _resolveCache.delete(url)
    return null
  }
  return entry.data
}

function putCachedResolve(url: string, data: MediaResolveResult): void {
  if (_resolveCache.size >= RESOLVE_CACHE_MAX) {
    const oldestKey = _resolveCache.keys().next().value
    if (oldestKey) _resolveCache.delete(oldestKey)
  }
  _resolveCache.set(url, { ts: Date.now(), data })
}

export async function resolveTikWm(url: string): Promise<MediaResolveResult | null> {
  try {
    const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) return null
    const json = (await res.json()) as any
    if (json.code !== 0 || !json.data) return null

    const data = json.data
    const playUrl = data.hdplay || data.play
    const musicUrl = data.music
    const coverUrl = data.cover
    const title = String(data.title || data.music_info?.title || '').trim()
    const author = String(data.author?.nickname || data.author?.unique_id || '').trim()
    const id = data.id ? String(data.id) : undefined
    const duration = typeof data.duration === 'number' ? data.duration : undefined

    return {
      id,
      title,
      author,
      playUrl,
      musicUrl,
      coverUrl,
      duration,
      platform: 'tiktok',
    }
  } catch {
    return null
  }
}

export async function resolveYtDlp(url: string, platform = 'unknown'): Promise<MediaResolveResult | null> {
  const runDump = async (useProxy: boolean): Promise<string> => {
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--js-runtimes',
      'node',
      ...(useProxy ? ['--proxy', 'socks5://127.0.0.1:10808'] : []),
      url,
    ]
    const { stdout } = await execFileAsync('yt-dlp', args, { timeout: 30_000 })
    return stdout
  }

  try {
    let rawOutput = ''
    try {
      rawOutput = await runDump(true)
    } catch {
      rawOutput = await runDump(false)
    }

    const info = JSON.parse(rawOutput)
    if (!info) return null

    const target = info._type === 'playlist' && Array.isArray(info.entries) && info.entries.length > 0
      ? info.entries[0]
      : info

    const formats: any[] = Array.isArray(target.formats) ? target.formats : []
    const mp4Formats = formats.filter((f) => f.ext === 'mp4' && f.url)
    mp4Formats.sort((a, b) => (b.height || 0) - (a.height || 0))

    const playUrl = mp4Formats[0]?.url || target.url
    const title = String(target.title || '').trim()
    const author = String(target.uploader || target.channel || target.uploader_id || '').trim()
    const coverUrl = target.thumbnail
    const id = target.id ? String(target.id) : undefined
    const duration = typeof target.duration === 'number' ? target.duration : undefined

    return {
      id,
      title,
      author,
      playUrl,
      coverUrl,
      duration,
      platform: (platform as any) || 'unknown',
    }
  } catch {
    return null
  }
}

export async function resolveMedia(url: string, hintPlatform?: string): Promise<MediaResolveResult | null> {
  const cached = getCachedResolve(url)
  if (cached) return cached

  const platform = hintPlatform || detectPlatform(url) || 'unknown'
  let result: MediaResolveResult | null = null

  if (platform === 'tiktok') {
    result = await resolveTikWm(url)
    if (!result || !result.playUrl) {
      result = await resolveYtDlp(url, 'tiktok')
    }
  } else {
    result = await resolveYtDlp(url, platform)
  }

  if (result) {
    putCachedResolve(url, result)
  }

  return result
}

export async function fetchMediaBuffer(
  url: string,
  maxBytes = 25 * 1024 * 1024,
  timeoutMs = 30_000,
): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': url.includes('tiktok') ? 'https://www.tiktok.com/' : undefined as any,
      },
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!res.ok) return null
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10)
    if (contentLength > maxBytes) return null

    const arrayBuffer = await res.arrayBuffer()
    if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > maxBytes) return null

    return Buffer.from(arrayBuffer)
  } catch {
    return null
  }
}
