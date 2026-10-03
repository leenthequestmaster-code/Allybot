/**
 * Twitter/X adapter.
 * Primary: @cedricdsst/twitter-video-downloader
 * Fallback: vxtwitter API
 * @module services/downloader/adapters/twitter
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'

const MATCH = /(?:twitter\.com|x\.com)\/[^\s]+\/status\/\d+/i
const VXTWITTER_HOST = 'api.vxtwitter.com'
const USER_AGENT = 'Allybot/1.0'
const FETCH_TIMEOUT_MS = 15_000

/** Only allow https URL, prevents SSRF/local file access via compromised API response */
function isSafeHttpUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw) return false
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

function truncateTitle(value: unknown, fallback: string): string {
  return String(value ?? fallback).slice(0, 100)
}

async function resolveViaVxtwitter(url: string): Promise<ResolveResult> {
  const vxUrl = url.replace(/(?:twitter\.com|x\.com)/i, VXTWITTER_HOST)
  const res = await fetch(vxUrl, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`vxtwitter ${res.status}`)
  const data = await res.json() as Record<string, unknown>

  const mediaList = Array.isArray(data.media_extended)
    ? data.media_extended as Array<Record<string, unknown>>
    : []

  const items: MediaItem[] = []
  for (const m of mediaList) {
    const mediaUrl = String(m.url || '')
    if (!mediaUrl || !isSafeHttpUrl(mediaUrl)) continue
    const isVideo = m.type === 'video' || /\.mp4/i.test(mediaUrl)
    items.push({
      url: mediaUrl,
      mime: isVideo ? 'video/mp4' : 'image/jpeg',
      ext: isVideo ? 'mp4' : 'jpg',
      size: null,
    })
  }

  if (items.length === 0) throw new Error('No media in tweet')

  return {
    type: items.length > 1 ? 'carousel' : (items[0].mime.startsWith('video') ? 'video' : 'image'),
    title: truncateTitle(data.text, 'Tweet'),
    author: String(data.user_screen_name || data.user_name || ''),
    thumbnail: null,
    media: items,
    meta: { platform: 'twitter' },
  }
}

export const twitterAdapter: DownloaderAdapter = {
  name: 'twitter',
  match: MATCH,

  async resolve(url: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    if (!url || typeof url !== 'string' || !MATCH.test(url)) {
      throw new Error('URL Twitter/X tidak valid.')
    }

    // Try primary package first (import cached lazily)
    try {
      const mod = await import('@cedricdsst/twitter-video-downloader')
      const result = await mod.resolveTwitterVideo(url)
      if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>
        const videoUrl = isSafeHttpUrl(r.url) ? r.url : isSafeHttpUrl(r.videoUrl) ? r.videoUrl : null
        if (videoUrl) {
          return {
            type: 'video',
            title: truncateTitle(r.text, 'Tweet'),
            author: String(r.username || ''),
            thumbnail: null,
            media: [{
              url: videoUrl,
              mime: 'video/mp4',
              ext: 'mp4',
              size: null,
            }],
            meta: { platform: 'twitter', source: 'cedricdsst' },
          }
        }
      }
    } catch {
      // Fall through to vxtwitter
    }

    // Fallback: vxtwitter API
    return resolveViaVxtwitter(url)
  },
}
