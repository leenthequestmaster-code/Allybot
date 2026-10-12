/**
 * Instagram adapter via ultra-igdl (Main) with SnapSave fallback.
 * @module services/downloader/adapters/instagram
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem } from '../types.js'
import { scrapeSnapSave } from '../scrapr-core/snapsave.js'

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

    // --- TIER 1: ultra-igdl (Main) ---
    try {
      const DownloaderCore = await loadIGDownloader()
      const downloader = new DownloaderCore()
      const response = await withTimeout(downloader.download(url), TIMEOUT_MS, 'IG download timed out')

      if ('media' in response && response.code === 200 && Array.isArray(response.media) && response.media.length > 0) {
        const items: MediaItem[] = response.media.map((m: any) => ({
          url: m.url,
          mime: m.type === 'video' ? 'video/mp4' : 'image/jpeg',
          ext: m.type === 'video' ? 'mp4' : 'jpg',
          size: null,
        }))

        return {
          type: items.length > 1 ? 'carousel' : (items[0].mime.startsWith('video') ? 'video' : 'image'),
          title: response.caption ? String(response.caption).slice(0, 100) : 'Instagram Post',
          author: response.username ? String(response.username) : '',
          thumbnail: typeof response.media[0]?.thumbnail === 'string' ? response.media[0].thumbnail : null,
          media: items,
          meta: { platform: 'instagram', source: 'ultra-igdl' },
        }
      }
    } catch {
      // Fallback to Tier 2
    }

    // --- TIER 2: SnapSave (Fallback) ---
    try {
      const ssRes = await scrapeSnapSave(url)
      if (ssRes.downloads && ssRes.downloads.length > 0) {
        const items: MediaItem[] = ssRes.downloads.map((d) => ({
          url: d.url,
          mime: d.type === 'video' ? 'video/mp4' : 'image/jpeg',
          ext: d.type === 'video' ? 'mp4' : 'jpg',
          size: null,
        }))

        return {
          type: items.length > 1 ? 'carousel' : (items[0].mime.startsWith('video') ? 'video' : 'image'),
          title: ssRes.title || 'Instagram Post',
          author: 'Instagram User',
          thumbnail: ssRes.thumbnail || null,
          media: items,
          meta: { platform: 'instagram', source: 'snapsave-fallback' },
        }
      }
    } catch (ssErr) {
      const msg = ssErr instanceof Error ? ssErr.message : String(ssErr)
      throw new Error(`Gagal resolve post IG (ultra-igdl & snapsave gagal): ${msg}`)
    }

    throw new Error('Gagal resolve post IG.')
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
