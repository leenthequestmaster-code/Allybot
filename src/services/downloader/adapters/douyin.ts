import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeDouyin } from '../scrapr-core/douyin.js'

const MATCH = /https?:\/\/(?:www\.|v\.)?(?:douyin\.com|iesdouyin\.com)\/[^\s]+/i

export const douyinAdapter: DownloaderAdapter = {
  name: 'douyin',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan Douyin link yang valid.')
    }

    const res = await scrapeDouyin(url)
    const items: MediaItem[] = res.downloads.map((d) => ({
      url: d.url,
      mime: d.type === 'video' ? 'video/mp4' : (d.type === 'image' ? 'image/jpeg' : 'audio/mp4'),
      ext: d.type === 'video' ? 'mp4' : (d.type === 'image' ? 'jpg' : 'mp3'),
      size: null,
    }))

    return {
      type: res.type === 'image' ? 'carousel' : 'video',
      title: res.title,
      author: res.author,
      thumbnail: res.thumbnail || null,
      media: items,
      meta: { platform: 'douyin' },
    }
  },
}
