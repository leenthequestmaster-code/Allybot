/**
 * Instagram adapter via ultra-igdl.
 * @module services/downloader/adapters/instagram
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'

const MATCH = /instagram\.com\/(?:p|reel|reels|tv)\/[\w-]+/i
const STORY_MATCH = /instagram\.com\/stories\//i

export const instagramAdapter: DownloaderAdapter = {
  name: 'instagram',
  match: MATCH,

  async resolve(url: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    if (STORY_MATCH.test(url)) {
      throw new Error('IG story belum didukung.')
    }

    const { default: DownloaderCore } = await import('ultra-igdl')
    const downloader = new DownloaderCore()

    const response = await downloader.download(url)

    // Narrow the union: ErrorResponse has no 'media' field
    if (!('media' in response) || response.code !== 200) {
      throw new Error(('message' in response ? response.message : null) || 'Gagal resolve IG post.')
    }

    const items: MediaItem[] = response.media.map(m => ({
      url: m.url,
      mime: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
      ext: m.type === 'video' ? 'mp4' : 'jpg',
      size: null,
    }))

    if (items.length === 0) throw new Error('Tidak ada media ditemukan di post IG.')

    return {
      type: items.length > 1 ? 'carousel' : (items[0].mime.startsWith('video') ? 'video' : 'image'),
      title: response.caption ? response.caption.slice(0, 100) : 'Instagram Post',
      author: response.username || '',
      thumbnail: response.media[0]?.thumbnail || null,
      media: items,
      meta: { platform: 'instagram' },
    }
  },
}
