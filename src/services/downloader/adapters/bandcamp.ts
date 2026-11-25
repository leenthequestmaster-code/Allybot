import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeBandcamp } from '../scrapr-core/bandcamp.js'
import { resolveYtDlp } from '../../multidl.js'

const MATCH = /https?:\/\/[a-zA-Z0-9-]+\.bandcamp\.com\/(?:track|album)\/[^\s]+/i

export const bandcampAdapter: DownloaderAdapter = {
  name: 'bandcamp',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan Bandcamp track/album link yang valid.')
    }

    // Tier 1: Direct Bandcamp scraper
    try {
      const res = await scrapeBandcamp(url)
      if (res.downloads && res.downloads.length > 0) {
        const items: MediaItem[] = res.downloads.map((d) => ({
          url: d.url,
          mime: d.type === 'audio' ? 'audio/mp4' : 'image/jpeg',
          ext: d.type === 'audio' ? 'mp3' : 'jpg',
          size: null,
        }))

        return {
          type: 'audio',
          title: res.title,
          author: res.artist,
          thumbnail: res.cover || null,
          media: items,
          meta: { platform: 'bandcamp', source: 'scraper' },
        }
      }
    } catch {
      // Fallback ke Tier 2 yt-dlp
    }

    // Tier 2: yt-dlp fallback
    const ytRes = await resolveYtDlp(url, 'bandcamp')
    const audioUrl = ytRes?.musicUrl || ytRes?.playUrl
    if (ytRes && audioUrl) {
      const items: MediaItem[] = [
        {
          url: audioUrl,
          mime: 'audio/mpeg',
          ext: 'mp3',
          size: null,
        },
      ]
      if (ytRes.coverUrl) {
        items.push({
          url: ytRes.coverUrl,
          mime: 'image/jpeg',
          ext: 'jpg',
          size: null,
        })
      }

      return {
        type: 'audio',
        title: ytRes.title || 'Bandcamp Track',
        author: ytRes.author || 'Bandcamp Artist',
        thumbnail: ytRes.coverUrl || null,
        media: items,
        meta: { platform: 'bandcamp', source: 'yt-dlp-fallback' },
      }
    }

    throw new Error('Gagal mengekstrak audio Bandcamp.')
  },
}
