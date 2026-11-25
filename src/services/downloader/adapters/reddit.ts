import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeRapidSave } from '../scrapr-core/rapidsave.js'
import { resolveYtDlp } from '../../multidl.js'

const MATCH = /https?:\/\/(?:www\.)?reddit\.com\/r\/[^\s]+/i

export const redditAdapter: DownloaderAdapter = {
  name: 'reddit',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan link postingan Reddit yang valid.')
    }

    // Tier 1: RapidSave
    try {
      const res = await scrapeRapidSave(url)
      if (res.videoUrl) {
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
      }
    } catch {
      // Fallback ke Tier 2 yt-dlp
    }

    // Tier 2: yt-dlp fallback
    const ytRes = await resolveYtDlp(url, 'reddit')
    if (ytRes && ytRes.playUrl) {
      return {
        type: 'video',
        title: ytRes.title || 'Reddit Video',
        author: ytRes.author || 'Reddit User',
        thumbnail: ytRes.coverUrl || null,
        media: [
          {
            url: ytRes.playUrl,
            mime: 'video/mp4',
            ext: 'mp4',
            size: null,
          },
        ],
        meta: {
          platform: 'reddit',
          source: 'yt-dlp-fallback',
          ...(ytRes.musicUrl ? { audioUrl: ytRes.musicUrl } : {}),
        },
      }
    }

    throw new Error('Gagal mengekstrak video Reddit.')
  },
}
