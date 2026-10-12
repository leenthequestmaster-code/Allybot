import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapePinterest } from '../scrapr-core/pinterest.js'

const MATCH = /https?:\/\/(?:[a-z0-9-]+\.)?pinterest\.(?:com|[a-z]{2,3}(?:\.[a-z]{2})?)\/pin\/[^\s]+/i

export const pinterestAdapter: DownloaderAdapter = {
  name: 'pinterest',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan Pinterest pin yang valid.')
    }

    const res = await scrapePinterest(url)
    if (!res.downloads || res.downloads.length === 0) {
      throw new Error('Gagal mengekstrak pin Pinterest.')
    }

    const items: MediaItem[] = res.downloads.map((d) => ({
      url: d.url,
      mime: d.type === 'video' ? 'video/mp4' : 'image/jpeg',
      ext: d.type === 'video' ? 'mp4' : 'jpg',
      size: null,
    }))

    return {
      type: items.length > 1 ? 'carousel' : (items[0].mime.startsWith('video') ? 'video' : 'image'),
      title: res.title || 'Pinterest Pin',
      author: 'Pinterest',
      thumbnail: res.thumbnail || null,
      media: items,
      meta: { platform: 'pinterest' },
    }
  },
}
