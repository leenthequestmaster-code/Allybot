import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeRapidSave } from '../scrapr-core/rapidsave.js'

const MATCH = /https?:\/\/(?:www\.)?reddit\.com\/r\/[^\s]+/i

export const redditAdapter: DownloaderAdapter = {
  name: 'reddit',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan link postingan Reddit yang valid.')
    }

    const res = await scrapeRapidSave(url)
    if (!res.videoUrl) {
      throw new Error('Gagal mengekstrak video Reddit.')
    }

    const items: MediaItem[] = [
      {
        url: res.videoUrl,
        mime: 'video/mp4',
        ext: 'mp4',
        size: null,
      },
    ]

    return {
      type: 'video',
      title: res.title || 'Reddit Video',
      author: 'Reddit User',
      thumbnail: res.thumbnail || null,
      media: items,
      meta: { platform: 'reddit', source: 'rapidsave', audioUrl: res.audioUrl },
    }
  },
}
