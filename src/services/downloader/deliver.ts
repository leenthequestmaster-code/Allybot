/**
 * Media delivery logic: size routing, carousel handling, concurrency cap.
 * @module services/downloader/deliver
 */

import type { Logger } from 'pino'
import type { ResolveResult, MediaItem } from './types.js'

/** Minimal WhatsApp port interface for delivery */
interface WhatsAppPort {
  sendMedia?(remoteJid: string, payload: {
    readonly kind: 'image' | 'video' | 'audio' | 'document' | 'sticker'
    readonly data: Uint8Array
    readonly mimeType: string
    readonly caption?: string
    readonly fileName?: string
    readonly isAnimated?: boolean
    readonly durationSeconds?: number
    readonly gifPlayback?: boolean
    readonly ptt?: boolean
  }): Promise<void>
}

const MAX_INLINE_VIDEO_BYTES = 16 * 1024 * 1024   // 16 MB → send as video
const MAX_DOCUMENT_BYTES     = 50 * 1024 * 1024   // 50 MB → send as document
const MAX_CAROUSEL_ITEMS     = 10
const CAROUSEL_DELAY_MS      = 1000
const DOWNLOAD_TIMEOUT_MS    = 60_000
const CONCURRENCY_CAP        = 3

/** Simple semaphore for concurrency control */
class Semaphore {
  private running = 0
  private queue: (() => void)[] = []

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++
      return
    }
    await new Promise<void>(resolve => this.queue.push(resolve))
  }

  release(): void {
    this.running--
    const next = this.queue.shift()
    if (next) {
      this.running++
      next()
    }
  }
}

const semaphore = new Semaphore(CONCURRENCY_CAP)

function buildCaption(result: ResolveResult): string {
  const platform = (result.meta['platform'] as string ?? '').toUpperCase()
  const parts: string[] = []
  if (platform) parts.push(`[${platform}]`)
  if (result.title) parts.push(result.title)
  if (result.author) parts.push(`@${result.author}`)
  return parts.join(' ') || ''
}

async function downloadBuffer(url: string, logger: Logger): Promise<Buffer | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Allybot/1.0' },
    })
    clearTimeout(timer)

    if (!response.ok) {
      logger.warn({ url, status: response.status }, 'dl-deliver: download failed')
      return null
    }

    const arrayBuf = await response.arrayBuffer()
    return Buffer.from(arrayBuf)
  } catch (err) {
    logger.warn({ err, url }, 'dl-deliver: download error')
    return null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function sendSingleMedia(
  whatsapp: WhatsAppPort,
  remoteJid: string,
  item: MediaItem,
  caption: string,
  logger: Logger,
): Promise<{ sent: boolean; fallbackLink?: string }> {
  if (!whatsapp.sendMedia) {
    return { sent: false, fallbackLink: item.url }
  }

  await semaphore.acquire()
  try {
    const buffer = item.buffer
      ? Buffer.from(item.buffer.buffer as ArrayBuffer, item.buffer.byteOffset, item.buffer.byteLength)
      : await downloadBuffer(item.url, logger)

    if (!buffer) {
      return { sent: false, fallbackLink: item.url }
    }

    const size = buffer.byteLength
    const mime = (item.mime || '').toLowerCase() || 'application/octet-stream'

    // Audio → send as audio (guard size; besar → document)
    if (mime.startsWith('audio/')) {
      if (size > MAX_INLINE_VIDEO_BYTES) {
        await whatsapp.sendMedia(remoteJid, {
          kind: 'document',
          data: new Uint8Array(buffer),
          mimeType: mime,
          caption,
          fileName: `download.${item.ext || 'mp3'}`,
        })
        return { sent: true }
      }
      await whatsapp.sendMedia(remoteJid, {
        kind: 'audio',
        data: new Uint8Array(buffer),
        mimeType: mime,
        caption,
        ptt: false,
      })
      return { sent: true }
    }

    // Image → size-aware: kecil inline, besar document
    if (mime.startsWith('image/')) {
      if (size > MAX_INLINE_VIDEO_BYTES) {
        await whatsapp.sendMedia(remoteJid, {
          kind: 'document',
          data: new Uint8Array(buffer),
          mimeType: mime,
          caption,
          fileName: `download.${item.ext || 'jpg'}`,
        })
        return { sent: true }
      }
      await whatsapp.sendMedia(remoteJid, {
        kind: 'image',
        data: new Uint8Array(buffer),
        mimeType: mime,
        caption,
      })
      return { sent: true }
    }

    // Video / other → size routing
    if (size <= MAX_INLINE_VIDEO_BYTES) {
      await whatsapp.sendMedia(remoteJid, {
        kind: 'video',
        data: new Uint8Array(buffer),
        mimeType: mime,
        caption,
      })
      return { sent: true }
    }

    if (size <= MAX_DOCUMENT_BYTES) {
      await whatsapp.sendMedia(remoteJid, {
        kind: 'document',
        data: new Uint8Array(buffer),
        mimeType: mime,
        caption,
        fileName: `download.${item.ext}`,
      })
      return { sent: true }
    }

    // > 50 MB → link only
    const sizeMB = Math.round(size / (1024 * 1024))
    return { sent: false, fallbackLink: `⚠️ File ${sizeMB}MB terlalu besar. Link: ${item.url}` }
  } finally {
    semaphore.release()
  }
}

export async function deliverMedia(
  whatsapp: WhatsAppPort,
  remoteJid: string,
  result: ResolveResult,
  logger: Logger,
): Promise<void> {
  const caption = buildCaption(result)

  if (result.type === 'carousel') {
    const items = result.media.slice(0, MAX_CAROUSEL_ITEMS)
    const skipped = result.media.length - items.length

    for (let i = 0; i < items.length; i++) {
      const itemCaption = i === 0 ? caption : ''
      const { sent, fallbackLink } = await sendSingleMedia(
        whatsapp, remoteJid, items[i], itemCaption, logger,
      )
      if (!sent && fallbackLink) {
        // Can't send via sendMedia, but we don't have a text reply here
        // Log it; the plugin handler will catch delivery issues
        logger.warn({ fallbackLink }, 'dl-deliver: carousel item fallback')
      }
      if (i < items.length - 1) {
        await delay(CAROUSEL_DELAY_MS)
      }
    }

    if (skipped > 0) {
      logger.info({ skipped }, 'dl-deliver: carousel limit reached')
    }
    return
  }

  // Single media
  if (result.media.length === 0) {
    logger.warn('dl-deliver: no media items to deliver')
    return
  }

  const { sent, fallbackLink } = await sendSingleMedia(
    whatsapp, remoteJid, result.media[0], caption, logger,
  )

  if (!sent && fallbackLink) {
    logger.warn({ fallbackLink }, 'dl-deliver: single media fallback')
    // The plugin handler should send fallbackLink as text
  }
}

export { downloadBuffer, MAX_CAROUSEL_ITEMS }
