/**
 * SoundCloud adapter via @zibot/scdl.
 * Dual mode: URL → download, query → search.
 * @module services/downloader/adapters/soundcloud
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult, SearchResult } from '../types.js'
import SoundCloud from '@zibot/scdl'

const MATCH = /soundcloud\.com\//i

let scInstance: SoundCloud | null = null

async function getSc(): Promise<SoundCloud> {
  if (scInstance) return scInstance
  scInstance = new SoundCloud()
  await scInstance.init()
  return scInstance
}

export async function searchSoundCloud(query: string): Promise<SearchResult[]> {
  const sc = await getSc()
  const results = await sc.search({ query, limit: 5, type: 'tracks' })
  return results.slice(0, 5).map((t: any) => ({
    title: String(t.title || 'Untitled'),
    channel: t.user?.username || undefined,
    duration: typeof t.duration === 'number'
      ? `${Math.floor(t.duration / 60000)}:${String(Math.floor((t.duration % 60000) / 1000)).padStart(2, '0')}`
      : undefined,
    url: t.permalink_url || '',
    thumbnail: t.artwork_url || undefined,
  }))
}

export const soundcloudAdapter: DownloaderAdapter = {
  name: 'soundcloud',
  match: MATCH,

  async resolve(url: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const sc = await getSc()
    const details = await sc.getTrackDetails(url)
    if (!details) throw new Error('Gagal resolve SoundCloud track.')

    // downloadTrack returns a Readable stream — we'll buffer it in deliver.ts
    // For now, the media URL is the original URL; deliver.ts will use downloadTrack
    return {
      type: 'audio',
      title: String(details.title || 'SoundCloud Track'),
      author: details.user?.username || '',
      thumbnail: details.artwork_url || null,
      media: [{
        url: url, // deliver.ts will stream via scdl downloadTrack
        mime: 'audio/mpeg',
        ext: 'mp3',
        size: null,
      }],
      meta: { platform: 'soundcloud', _scStream: true },
    }
  },
}
