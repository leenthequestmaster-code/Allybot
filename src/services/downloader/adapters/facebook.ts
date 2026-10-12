import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeSnapSave } from '../scrapr-core/snapsave.js'
import { resolveYtDlp } from '../../multidl.js'

const MATCH = /https?:\/\/(?:www\.|web\.|m\.)?(?:facebook\.com|fb\.watch)\/[^\s]+/i

export const facebookAdapter: DownloaderAdapter = {
  name: 'facebook',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan Facebook video link yang valid.')
    }

    // TIER 1: SnapSave (Cepat, direct CDN)
    try {
      const res = await scrapeSnapSave(url)
      if (res.downloads && res.downloads.length > 0) {
        const items: MediaItem[] = res.downloads.map((d) => ({
          url: d.url,
          mime: d.type === 'video' ? 'video/mp4' : 'image/jpeg',
          ext: d.type === 'video' ? 'mp4' : 'jpg',
          size: null,
        }))

        return {
          type: items.length > 1 ? 'carousel' : (items[0].mime.startsWith('video') ? 'video' : 'image'),
          title: res.title || 'Facebook Video',
          author: 'Facebook User',
          thumbnail: res.thumbnail || null,
          media: items,
          meta: { platform: 'facebook', source: 'snapsave' },
        }
      }
    } catch {
      // Fallback ke Tier 2 yt-dlp
    }

    // TIER 2: yt-dlp fallback (Bila SnapSave timeout atau link khusus)
    const ytRes = await resolveYtDlp(url, 'facebook')
    if (ytRes && ytRes.playUrl) {
      return {
        type: 'video',
        title: ytRes.title || 'Facebook Video',
        author: ytRes.author || 'Facebook',
        thumbnail: ytRes.coverUrl || null,
        media: [
          {
            url: ytRes.playUrl,
            mime: 'video/mp4',
            ext: 'mp4',
            size: null,
          },
        ],
        meta: { platform: 'facebook', source: 'yt-dlp-fallback' },
      }
    }

    throw new Error('Gagal mengekstrak video Facebook.')
  },
}
