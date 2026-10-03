/**
 * Twitter/X adapter.
 * Primary: @cedricdsst/twitter-video-downloader
 * Fallback: vxtwitter API
 * @module services/downloader/adapters/twitter
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'

const MATCH = /(?:twitter\.com|x\.com)\/[^\s]+\/status\/\d+/i

async function resolveViaVxtwitter(url: string): Promise<ResolveResult> {
  const vxUrl = url
    .replace(/(?:twitter\.com|x\.com)/i, 'api.vxtwitter.com')
  const res = await fetch(vxUrl, {
    headers: { 'User-Agent': 'Allybot/1.0' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`vxtwitter ${res.status}`)
  const data = await res.json() as Record<string, unknown>

  const mediaList = Array.isArray(data.media_extended)
    ? data.media_extended as Array<Record<string, unknown>>
    : []

  const items: MediaItem[] = []
  for (const m of mediaList) {
    const mediaUrl = String(m.url || '')
    if (!mediaUrl) continue
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
    title: String(data.text || 'Tweet').slice(0, 100),
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
    // Try primary package first
    try {
      const mod = await import('@cedricdsst/twitter-video-downloader')
      const result = await mod.resolveTwitterVideo(url)
      if (result && typeof result === 'object') {
        const videoUrl = (result as Record<string, unknown>).url || (result as Record<string, unknown>).videoUrl
        if (videoUrl && typeof videoUrl === 'string') {
          return {
            type: 'video',
            title: String((result as Record<string, unknown>).text || 'Tweet').slice(0, 100),
            author: String((result as Record<string, unknown>).username || ''),
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
