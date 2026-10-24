/**
 * @module qr-scanner
 * Fast in-memory QR Code scanner powered by sharp and jsQR.
 * Extracts text, URLs, and payloads directly from raw image buffers.
 */

import sharp from 'sharp'
import * as jsQRModule from 'jsqr'

const jsQR = ((jsQRModule as any).default || jsQRModule) as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: any,
) => { data: string } | null

export interface QrScanResult {
  readonly text: string
  readonly isUrl: boolean
  readonly width: number
  readonly height: number
}

/**
 * Scans and decodes a QR code from an arbitrary image buffer.
 * Performs multi-pass detection (original -> grayscale -> threshold) for high hit rates.
 */
export async function scanQrFromImage(imageBuffer: Buffer): Promise<QrScanResult | null> {
  if (!imageBuffer || imageBuffer.length < 100) return null

  try {
    // Pass 1: Standard RGBA decode
    const img = sharp(imageBuffer).rotate() // auto-orient based on EXIF
    const { data, info } = await img
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    let code = jsQR(new Uint8ClampedArray(data), info.width, info.height)

    // Pass 2: High-contrast binarization fallback if pass 1 fails
    if (!code) {
      const enhanced = await sharp(imageBuffer)
        .rotate()
        .grayscale()
        .normalize()
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })

      code = jsQR(new Uint8ClampedArray(enhanced.data), enhanced.info.width, enhanced.info.height)
    }

    if (!code || !code.data) return null

    const text = code.data.trim()
    const isUrl = /^https?:\/\//i.test(text)

    return {
      text,
      isUrl,
      width: info.width,
      height: info.height,
    }
  } catch {
    return null
  }
}
