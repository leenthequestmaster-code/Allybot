/**
 * SoundCloud adapter via @zibot/scdl.
 * Dual mode: URL → download, query → search.
 * @module services/downloader/adapters/soundcloud
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult, SearchResult } from '../types.js'
import SoundCloud from '@zibot/scdl'

const MATCH = /^https?:\/\/(?:www\.)?soundcloud\.com\/.+/i

let scInstance: SoundCloud | null = null

async function getSc(): Promise<SoundCloud> {
  if (scInstance) return scInstance
  scInstance = new SoundCloud()
  await scInstance.init()
  return scInstance
}

export async function searchSoundCloud(query: string): Promise<SearchResult[]> {
  const q = query?.trim()
  if (!q) throw new Error('Query pencarian SoundCloud tidak boleh kosong.')

  const sc = await getSc()
  const results = await sc.search({ query: q, limit: 5, type: 'tracks' })
  if (!Array.isArray(results)) return []

  return results
    .slice(0, 5)
    .map((t: any) => ({
      title: String(t.title || 'Untitled'),
      channel: t.user?.username || undefined,
      duration: typeof t.duration === 'number'
        ? `${Math.floor(t.duration / 60000)}:${String(Math.floor((t.duration % 60000) / 1000)).padStart(2, '0')}`
        : undefined,
      url: t.permalink_url || '',
      thumbnail: t.artwork_url || undefined,
    }))
    .filter((r) => Boolean(r.url)) // jangan kirim SearchResult tanpa URL
}

export const soundcloudAdapter: DownloaderAdapter = {
  name: 'soundcloud',
  match: MATCH,

  async resolve(url: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const u = url?.trim()
    if (!u || typeof u !== 'string' || !MATCH.test(u)) {
      throw new Error('URL SoundCloud tidak valid.')
    }

    let details: any
    try {
      const sc = await getSc()
      details = await sc.getTrackDetails(u)
      if (!details) throw new Error('Gagal resolve SoundCloud track.')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Gagal resolve SoundCloud track.'
      throw new Error(msg)
    }

    return {
      type: 'audio',
      title: String(details.title || 'SoundCloud Track'),
      author: details.user?.username || '',
      thumbnail: details.artwork_url || null,
      media: [{
        url: u, // deliver.ts akan stream via scdl downloadTrack
        mime: 'audio/mpeg',
        ext: 'mp3',
        size: null,
      }],
      meta: { platform: 'soundcloud', _scStream: true },
    }
  },
}
