/**
 * Videy.co adapter (native, no npm dependency).
 * Extracts video ID from URL, constructs CDN link, HEAD-verifies.
 * @module services/downloader/adapters/videy
 */

import type { DownloaderAdapter, ResolveResult, ResolveOptions } from '../types.js'

const VIDEY_REGEX = /videy\.co/i
const ID_REGEX = /videy\.co\/(?:watch\?v=|v\/|embed\/)?([a-zA-Z0-9]+)/i

export const videyAdapter: DownloaderAdapter = {
  name: 'videy',
  match: VIDEY_REGEX,

  async resolve(url: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const match = url.match(ID_REGEX)
    if (!match?.[1]) {
      throw new Error('URL Videy nggak valid.')
    }

    const videoId = match[1]
    const cdnUrl = `https://cdn.videy.co/${videoId}.mp4`

    // HEAD verify
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)

    try {
      const resp = await fetch(cdnUrl, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'Allybot/1.0' },
      })
      clearTimeout(timer)

      if (!resp.ok) {
        throw new Error('Video Videy nggak ditemukan atau expired.')
      }

      const contentLength = resp.headers.get('content-length')
      const size = contentLength ? parseInt(contentLength, 10) : null

      return {
        type: 'video',
        title: `videy-${videoId}`,
        author: '',
        thumbnail: null,
        media: [{
          url: cdnUrl,
          mime: 'video/mp4',
          ext: 'mp4',
          size,
        }],
        meta: { platform: 'videy', videoId },
      }
    } catch (err) {
      clearTimeout(timer)
      throw err
    }
  },
}
