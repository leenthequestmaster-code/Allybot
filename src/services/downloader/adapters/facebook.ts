/**
 * Facebook adapter via @renpwn/fb-downloader.
 * @module services/downloader/adapters/facebook
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult } from '../types.js'

const MATCH = /(?:facebook\.com|fb\.watch)\/[^\s]+/i

export const facebookAdapter: DownloaderAdapter = {
  name: 'facebook',
  match: MATCH,

  async resolve(url: string, opts?: ResolveOptions): Promise<ResolveResult> {
    const mod = await import('@renpwn/fb-downloader')
    const getVideoInfo = (mod as unknown as { default: (url: string, cookie?: string, ua?: string) => Promise<{ url: string; sd: string; hd: string; title: string; thumbnail: string }> }).default

    const info = await getVideoInfo(url)
    if (!info) throw new Error('Gagal resolve FB video.')

    const preferHd = opts?.quality !== 'sd'
    const videoUrl = (preferHd && info.hd) ? info.hd : info.sd
    if (!videoUrl) throw new Error('Tidak ada video URL dari FB.')

    return {
      type: 'video',
      title: info.title || 'Facebook Video',
      author: '',
      thumbnail: info.thumbnail || null,
      media: [{
        url: videoUrl,
        mime: 'video/mp4',
        ext: 'mp4',
        size: null,
      }],
      meta: { platform: 'facebook', hasHd: Boolean(info.hd) },
    }
  },
}
