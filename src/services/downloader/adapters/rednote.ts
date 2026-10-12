import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeRedNote } from '../scrapr-core/rednote.js'

const MATCH = /https?:\/\/(?:www\.)?(?:xiaohongshu\.com|xhslink\.(?:com|cn)|rednote\.com)\/[^\s]+/i

export const rednoteAdapter: DownloaderAdapter = {
  name: 'rednote',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan RedNote / Xiaohongshu link yang valid.')
    }

    const res = await scrapeRedNote(url)
    const items: MediaItem[] = res.downloads.map((d) => ({
      url: d.url,
      mime: d.type === 'video' ? 'video/mp4' : 'image/jpeg',
      ext: d.type === 'video' ? 'mp4' : 'jpg',
      size: null,
    }))

    return {
      type: res.type === 'image' ? (items.length > 1 ? 'carousel' : 'image') : 'video',
      title: res.title,
      author: res.author?.name || 'RedNote Creator',
      thumbnail: res.thumbnail || null,
      media: items,
      meta: { platform: 'rednote' },
    }
  },
}
