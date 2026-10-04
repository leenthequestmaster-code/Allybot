/**
 * Instagram adapter via ultra-igdl.
 * @module services/downloader/adapters/instagram
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'

const MATCH = /instagram\.com\/(?:p|reel|reels|tv)\/[\w-]+/i
const STORY_MATCH = /instagram\.com\/stories\//i
const TIMEOUT_MS = 25_000

type DownloaderCoreType = { new (): { download(url: string): Promise<any> } }

let corePromise: Promise<DownloaderCoreType> | null = null

async function loadIGDownloader(): Promise<DownloaderCoreType> {
  if (!corePromise) {
    corePromise = import('ultra-igdl').then((mod) => {
      const Core = (mod as unknown as { default?: DownloaderCoreType }).default
      if (typeof Core !== 'function') throw new Error('ultra-igdl: invalid export')
      return Core
    })
  }
  return corePromise
}

export const instagramAdapter: DownloaderAdapter = {
  name: 'instagram',
  match: MATCH,

  async resolve(rawUrl: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const url = rawUrl?.trim() || ''
    if (!url || typeof url !== 'string' || !(MATCH.test(url) || STORY_MATCH.test(url))) {
      throw new Error('URL bukan Instagram post.')
    }
    if (STORY_MATCH.test(url)) {
      throw new Error('IG story belum didukung.')
    }

    let response: any
    try {
      const DownloaderCore = await loadIGDownloader()
      const downloader = new DownloaderCore()
      response = await withTimeout(downloader.download(url), TIMEOUT_MS, 'IG download timed out')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/timeout|abort/i.test(msg)) throw msg
      throw new Error(`Gagal memuat/download post IG: ${msg}`)
    }

    // Narrow the union: ErrorResponse has no 'media' field
    if (!('media' in response) || response.code !== 200) {
      throw new Error(('message' in response ? response.message : null) || 'Gagal resolve IG post.')
    }

    const items: MediaItem[] = response.media.map((m: any) => ({
      url: m.url,
      mime: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
      ext: m.type === 'video' ? 'mp4' : 'jpg',
      size: null,
    }))

    if (items.length === 0) throw new Error('Tidak ada media ditemukan di post IG.')

    return {
      type: items.length > 1 ? 'carousel' : (items[0].mime.startsWith('video') ? 'video' : 'image'),
      title: response.caption ? String(response.caption).slice(0, 100) : 'Instagram Post',
      author: response.username ? String(response.username) : '',
      thumbnail: typeof response.media[0]?.thumbnail === 'string' ? response.media[0].thumbnail : null,
      media: items,
      meta: { platform: 'instagram' },
    }
  },
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}
