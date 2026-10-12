import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeBandcamp } from '../scrapr-core/bandcamp.js'

const MATCH = /https?:\/\/[a-zA-Z0-9-]+\.bandcamp\.com\/(?:track|album)\/[^\s]+/i

export const bandcampAdapter: DownloaderAdapter = {
  name: 'bandcamp',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan Bandcamp track/album link yang valid.')
    }

    const res = await scrapeBandcamp(url)
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
      meta: { platform: 'bandcamp' },
    }
  },
}
