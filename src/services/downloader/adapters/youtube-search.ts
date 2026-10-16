/**
 * YouTube Search adapter via youtube-sr.
 * Search only — no download.
 * @module services/downloader/adapters/youtube-search
 */

import type { SearchResult } from '../types.js'
import YouTube from 'youtube-sr'

export async function searchYouTube(query: string): Promise<SearchResult[]> {
  const yt: any = (YouTube as any).YouTube || (YouTube as any).default?.YouTube || (YouTube as any).default?.default || (YouTube as any).default || YouTube
  const searchFn = typeof yt?.search === 'function' ? yt.search.bind(yt) : typeof (YouTube as any).search === 'function' ? (YouTube as any).search.bind(YouTube) : undefined
  if (!searchFn) {
    throw new Error('youtube-sr search function not found')
  }
  const results = await searchFn(query, { limit: 5, type: 'video' })

  return results.slice(0, 5).map((v: any) => ({
    title: v.title || 'Untitled',
    channel: v.channel?.name || undefined,
    duration: v.durationFormatted || undefined,
    url: v.url || '',
    thumbnail: v.thumbnail?.url || undefined,
  }))
}
