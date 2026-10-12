import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeBilibili } from '../scrapr-core/bilibili.js'

const MATCH = /https?:\/\/(?:www\.)?(?:bilibili\.tv|bilibili\.com)\/[^\s]+/i

export const bilibiliAdapter: DownloaderAdapter = {
  name: 'bilibili',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan Bilibili link yang valid.')
    }

    const res = await scrapeBilibili(url)
    const items: MediaItem[] = res.downloads.map((d) => ({
      url: d.url,
      mime: 'video/mp4',
      ext: 'mp4',
      size: null,
    }))

    return {
      type: 'video',
      title: res.title,
      author: res.author?.name || 'Bilibili Creator',
      thumbnail: res.thumbnail || null,
      media: items,
      meta: { platform: 'bilibili' },
    }
  },
}
