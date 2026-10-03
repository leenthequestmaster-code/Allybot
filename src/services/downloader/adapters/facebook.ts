/**
 * Facebook adapter via @renpwn/fb-downloader.
 * @module services/downloader/adapters/facebook
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult } from '../types.js'

const MATCH = /(?:facebook\.com|fb\.watch)\/[^\s]+/i

type FbInfo = { url: string; sd: string; hd: string; title: string; thumbnail: string }
type FbDownloaderFn = (url: string, cookie?: string, ua?: string) => Promise<FbInfo>

let fbModPromise: Promise<FbDownloaderFn> | null = null

async function loadFbDownloader(): Promise<FbDownloaderFn> {
  if (!fbModPromise) {
    fbModPromise = import('@renpwn/fb-downloader').then((mod) => {
      const fn = (mod as unknown as { default?: unknown }).default
      if (typeof fn !== 'function') throw new Error('FB downloader: invalid export')
      return fn as FbDownloaderFn
    })
  }
  return fbModPromise
}

export const facebookAdapter: DownloaderAdapter = {
  name: 'facebook',
  match: MATCH,

  async resolve(url: string, opts?: ResolveOptions): Promise<ResolveResult> {
    if (!url || typeof url !== 'string' || !MATCH.test(url)) {
      throw new Error('URL Facebook tidak valid.')
    }

    let info: FbInfo
    try {
      const getVideoInfo = await loadFbDownloader()
      info = await getVideoInfo(url, opts?.quality === 'sd' ? undefined : undefined, undefined)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Gagal resolve FB video: ${msg}`)
    }

    if (!info || !info.url) throw new Error('Gagal resolve FB video.')

    const preferHd = opts?.quality !== 'sd'
    const videoUrl = (preferHd && info.hd) ? info.hd : (info.sd || info.hd)
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
