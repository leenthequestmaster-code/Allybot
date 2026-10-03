/**
 * Videy.co adapter (native, no npm dependency).
 * Extracts video ID from URL, constructs CDN link, HEAD-verifies.
 * @module services/downloader/adapters/videy
 */

import type { DownloaderAdapter, ResolveResult, ResolveOptions } from '../types.js'

const VIDEY_REGEX = /videy\.co/i
const ID_REGEX = /videy\.co\/(?:watch\?v=|v\/|embed\/)?([a-zA-Z0-9]+)/i
const VIDEY_CDN_BASE = 'https://cdn.videy.co/'
const HEAD_TIMEOUT_MS = 10_000

export const videyAdapter: DownloaderAdapter = {
  name: 'videy',
  match: VIDEY_REGEX,

  async resolve(url: string, opts?: ResolveOptions): Promise<ResolveResult> {
    const match = url.match(ID_REGEX)
    if (!match?.[1]) {
      throw new Error('URL Videy nggak valid.')
    }

    const videoId = match[1]
    const cdnUrl = new URL(`${encodeURIComponent(videoId)}.mp4`, VIDEY_CDN_BASE).toString()

    // HEAD verify
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS)

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

      if (opts?.maxSizeMB && size !== null && size > opts.maxSizeMB * 1024 * 1024) {
        throw new Error(`Video melebihi batas ${opts.maxSizeMB} MB.`)
      }

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
