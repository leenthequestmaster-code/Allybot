/**
 * YouTube Search adapter via youtube-sr.
 * Search only — no download.
 * @module services/downloader/adapters/youtube-search
 */

import type { SearchResult } from '../types.js'
import YouTube from 'youtube-sr'

export async function searchYouTube(query: string): Promise<SearchResult[]> {
  const results = await YouTube.default.search(query, { limit: 5, type: 'video' })

  return results.slice(0, 5).map(v => ({
    title: v.title || 'Untitled',
    channel: v.channel?.name || undefined,
    duration: v.durationFormatted || undefined,
    url: v.url || '',
    thumbnail: v.thumbnail?.url || undefined,
  }))
}
