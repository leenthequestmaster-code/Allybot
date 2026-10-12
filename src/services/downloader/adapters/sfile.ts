import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeSfile } from '../scrapr-core/sfile.js'

const MATCH = /https?:\/\/(?:www\.)?sfile\.(?:co|mobi)\/[^\s]+/i

export const sfileAdapter: DownloaderAdapter = {
  name: 'sfile',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan Sfile link yang valid.')
    }

    const res = await scrapeSfile(url)
    if (!res.url) {
      throw new Error('Gagal mengekstrak direct link Sfile.')
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
      author: 'Sfile.mobi',
      thumbnail: null,
      media: items,
      meta: { platform: 'sfile', filename: res.filename, size: res.size },
    }
  },
}
