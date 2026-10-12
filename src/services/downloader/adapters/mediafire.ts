import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeMediaFire } from '../scrapr-core/mediafire.js'

const MATCH = /https?:\/\/(?:www\.)?mediafire\.com\/(?:file|download)\/[^\s]+/i

export const mediafireAdapter: DownloaderAdapter = {
  name: 'mediafire',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan MediaFire file link yang valid.')
    }

    const res = await scrapeMediaFire(url)
    if (!res.url) {
      throw new Error('Gagal mengekstrak direct link MediaFire.')
    }

    const extMatch = res.filename.match(/\.([a-zA-Z0-9]+)$/)
    const ext = extMatch ? extMatch[1].toLowerCase() : 'bin'
    const isVideo = ['mp4', 'mkv', 'avi', 'mov'].includes(ext)
    const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)
    const isAudio = ['mp3', 'm4a', 'wav', 'flac', 'ogg'].includes(ext)

    let type: ResolveResult['type'] = 'video'
    let mime = 'application/octet-stream'

    if (isVideo) {
      type = 'video'
      mime = 'video/mp4'
    } else if (isImage) {
      type = 'image'
      mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`
    } else if (isAudio) {
      type = 'audio'
      mime = 'audio/mpeg'
    }

    const items: MediaItem[] = [
      {
        url: res.url,
        mime,
        ext,
        size: null,
      },
    ]

    return {
      type,
      title: `${res.filename} (${res.size})`,
      author: 'MediaFire',
      thumbnail: null,
      media: items,
      meta: { platform: 'mediafire', filename: res.filename, size: res.size },
    }
  },
}
