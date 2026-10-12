import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeTeraBox } from '../scrapr-core/terabox.js'

const MATCH = /https?:\/\/(?:www\.)?(?:terabox\.app|terabox\.com|1024tera\.com|freeterabox\.com|4shared\.com\/s)\/[^\s]+/i

export const teraboxAdapter: DownloaderAdapter = {
  name: 'terabox',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || !MATCH.test(url)) {
      throw new Error('URL bukan TeraBox link yang valid.')
    }

    const res = await scrapeTeraBox(url)
    if (!res.downloads || res.downloads.length === 0) {
      throw new Error('Tidak ada file yang dapat diunduh dari TeraBox.')
    }

    const items: MediaItem[] = res.downloads.map((d) => ({
      url: d.url,
      mime: d.type === 'video' ? 'video/mp4' : 'application/octet-stream',
      ext: d.type === 'video' ? 'mp4' : 'bin',
      size: null,
    }))

    return {
      type: items[0].mime.startsWith('video') ? 'video' : 'image',
      title: res.title,
      author: 'TeraBox',
      thumbnail: res.thumbnail || null,
      media: items,
      meta: { platform: 'terabox' },
    }
  },
}
