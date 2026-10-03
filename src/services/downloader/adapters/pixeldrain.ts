/**
 * Pixeldrain adapter (native, no npm dependency).
 * API: pixeldrain.com/api/file/{id}?download
 * @module services/downloader/adapters/pixeldrain
 */

import type { DownloaderAdapter, ResolveResult, ResolveOptions } from '../types.js'

const PD_REGEX = /pixeldrain\.com\/[ul]\/([\w]+)/i

export const pixeldrainAdapter: DownloaderAdapter = {
  name: 'pixeldrain',
  match: PD_REGEX,

  async resolve(url: string, _opts?: ResolveOptions): Promise<ResolveResult> {
    const match = url.match(PD_REGEX)
    if (!match?.[1]) {
      throw new Error('URL Pixeldrain nggak valid.')
    }

    const fileId = match[1]
    const isFolder = url.includes('/l/')

    if (isFolder) {
      // List API for folders
      const listUrl = `https://pixeldrain.com/api/list/${fileId}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 15_000)

      try {
        const resp = await fetch(listUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Allybot/1.0' },
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
            url: `https://pixeldrain.com/api/file/${f.id}?download`,
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
    const infoUrl = `https://pixeldrain.com/api/file/${fileId}/info`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)

    try {
      const resp = await fetch(infoUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Allybot/1.0' },
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
      const downloadUrl = `https://pixeldrain.com/api/file/${fileId}?download`
      const isVideo = info.mime_type.startsWith('video/')
      const isImage = info.mime_type.startsWith('image/')
      const isAudio = info.mime_type.startsWith('audio/')

      let type: 'video' | 'image' | 'audio' | 'carousel' | 'search' = 'video'
      if (isImage) type = 'image'
      else if (isAudio) type = 'audio'

      return {
        type,
        title: info.name,
        author: '',
        thumbnail: null,
        media: [{
          url: downloadUrl,
          mime: info.mime_type,
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
