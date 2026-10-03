/**
 * Threads adapter via @zenaveline/scraper.
 * @module services/downloader/adapters/threads
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'

const MATCH = /threads\.net\/(?:@[\w.]+\/post|t)\/[\w]+/i

export const threadsAdapter: DownloaderAdapter = {
  name: 'threads',
  match: MATCH,

  async resolve(url: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    let mod: any
    try {
      // @ts-expect-error — @zenaveline/scraper has no type declarations
      mod = await import('@zenaveline/scraper')
    } catch (err) {
      throw new Error(`Gagal memuat scraper Threads: ${(err as Error)?.message || String(err)}`)
    }
    const scraper = mod.default || mod

    // Try common API patterns for this scraper
    const result = typeof scraper.threads === 'function'
      ? await scraper.threads(url)
      : typeof scraper.threadsDl === 'function'
        ? await scraper.threadsDl(url)
        : typeof scraper === 'function'
          ? await scraper(url)
          : null

    if (!result) throw new Error('Gagal resolve Threads post.')

    const items: MediaItem[] = []
    const mediaList = Array.isArray(result.media) ? result.media
      : Array.isArray(result.data) ? result.data
      : Array.isArray(result.result) ? result.result
      : result.url ? [{ url: result.url }]
      : []

    for (const m of mediaList) {
      const mediaUrl = typeof m === 'string' ? m : m?.url || m?.download
      if (!mediaUrl || typeof mediaUrl !== 'string' || !/^https?:/i.test(mediaUrl)) continue
      const isVideo = /\.mp4|video/i.test(mediaUrl)
      items.push({
        url: mediaUrl,
        mime: isVideo ? 'video/mp4' : 'image/jpeg',
        ext: isVideo ? 'mp4' : 'jpg',
        size: null,
      })
    }

    if (items.length === 0) throw new Error('Tidak ada media di Threads post.')

    const thumbnail = String(result.thumbnail || result.thumb || result.cover || items[0]?.url || '') || null

    return {
      type: items.length > 1 ? 'carousel' : (items[0].mime.startsWith('video') ? 'video' : 'image'),
      title: String(result.caption || result.title || 'Threads Post').slice(0, 100),
      author: String(result.username || result.author || ''),
      thumbnail,
      media: items,
      meta: { platform: 'threads' },
    }
  },
}
