/**
 * Pixeldrain adapter (native, no npm dependency).
 * API: pixeldrain.com/api/file/{id}?download
 * @module services/downloader/adapters/pixeldrain
 */

import type { DownloaderAdapter, ResolveResult, ResolveOptions } from '../types.js'

const PD_REGEX = /pixeldrain\.com\/([ul])\/([A-Za-z0-9_-]+)/i
const PIXELDRAIN_API = 'https://pixeldrain.com/api/'
const PD_TIMEOUT_MS = 15_000
const PD_USER_AGENT = 'Allybot/1.0'

export const pixeldrainAdapter: DownloaderAdapter = {
  name: 'pixeldrain',
  match: PD_REGEX,

  async resolve(url: string, opts?: ResolveOptions): Promise<ResolveResult> {
    const match = url.match(PD_REGEX)
    if (!match?.[2]) {
      throw new Error('URL Pixeldrain nggak valid.')
    }

    const fileId = match[2]
    const isFolder = match[1] === 'l'

    if (isFolder) {
      // List API for folders
      const listUrl = `${PIXELDRAIN_API}list/${fileId}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), PD_TIMEOUT_MS)

      try {
        const resp = await fetch(listUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': PD_USER_AGENT },
        })
        clearTimeout(timer)

        if (!resp.ok) {
          if (resp.status === 404) throw new Error('File Pixeldrain nggak ada atau expired.')
          throw new Error(`Pixeldrain API error ${resp.status}`)
        }

        const data = await resp.json() as {
          title?: string
          files?: Array<{ id: string; name: string; size: number; mime_type: string }>
        }

        if (!data.files || data.files.length === 0) {
          throw new Error('Folder Pixeldrain kosong.')
        }

        const media = data.files.map(f => {
          const ext = f.name.split('.').pop() ?? 'bin'
          return {
            url: `${PIXELDRAIN_API}file/${f.id}?download`,
            mime: f.mime_type,
            ext,
            size: f.size,
          }
        })

        return {
          type: 'carousel',
          title: data.title ?? `pixeldrain-${fileId}`,
          author: '',
          thumbnail: null,
          media,
          meta: { platform: 'pixeldrain', fileId, isFolder: true },
        }
      } catch (err) {
        clearTimeout(timer)
        throw err
      }
    }

    // Single file
    const infoUrl = `${PIXELDRAIN_API}file/${fileId}/info`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PD_TIMEOUT_MS)

    try {
      const resp = await fetch(infoUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': PD_USER_AGENT },
      })
      clearTimeout(timer)

      if (!resp.ok) {
        if (resp.status === 404) throw new Error('File Pixeldrain nggak ada atau expired.')
        throw new Error(`Pixeldrain API error ${resp.status}`)
      }

      const info = await resp.json() as {
        id: string
        name: string
        size: number
        mime_type: string
      }

      const ext = info.name.split('.').pop() ?? 'bin'
      const downloadUrl = `${PIXELDRAIN_API}file/${fileId}?download`
      const mime = info.mime_type || 'application/octet-stream'
      const isVideo = mime.startsWith('video/')
      const isImage = mime.startsWith('image/')
      const isAudio = mime.startsWith('audio/')

      if (opts?.maxSizeMB && info.size > opts.maxSizeMB * 1024 * 1024) {
        throw new Error(`File melebihi batas ${opts.maxSizeMB} MB.`)
      }

      let type: 'video' | 'image' | 'audio' | 'carousel' | 'search'
      if (isImage) type = 'image'
      else if (isVideo) type = 'video'
      else if (isAudio) type = 'audio'
      else type = 'video' // fallback untuk binary lain (document via video kind)

      return {
        type,
        title: info.name,
        author: '',
        thumbnail: null,
        media: [{
          url: downloadUrl,
          mime,
          ext,
          size: info.size,
        }],
        meta: { platform: 'pixeldrain', fileId },
      }
    } catch (err) {
      clearTimeout(timer)
      throw err
    }
  },
}
