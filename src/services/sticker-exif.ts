/**
 * WhatsApp Sticker EXIF Metadata Injector
 * Formats custom sticker-pack-name and sticker-pack-publisher into standard WhatsApp EXIF chunks.
 */

function getWebpDimensions(chunkFourcc: string, chunkData: Buffer): { width: number; height: number } | null {
  if (chunkFourcc === 'VP8 ' && chunkData.length >= 10) {
    if (chunkData[3] === 0x9D && chunkData[4] === 0x01 && chunkData[5] === 0x2A) {
      const w = chunkData.readUInt16LE(6) & 0x3FFF
      const h = chunkData.readUInt16LE(8) & 0x3FFF
      return { width: w, height: h }
    }
  }
  if (chunkFourcc === 'VP8L' && chunkData.length >= 5) {
    if (chunkData[0] === 0x2F) {
      const b1 = chunkData[1] ?? 0
      const b2 = chunkData[2] ?? 0
      const b3 = chunkData[3] ?? 0
      const b4 = chunkData[4] ?? 0
      const w = 1 + (((b2 & 0x3F) << 8) | b1)
      const h = 1 + (((b4 & 0x0F) << 10) | (b3 << 2) | ((b2 & 0xC0) >> 6))
      return { width: w, height: h }
    }
  }
  return null
}

export function buildWaExif(pack = 'Allybot', author = 'Cyrus', emojis = ['🙂']): Buffer {
  const jsonStr = JSON.stringify({
    'sticker-pack-id': `com.allybot.${pack.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'stickers'}`,
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    'emojis': emojis,
  })
  const jsonBytes = Buffer.from(jsonStr, 'utf-8')
  const header = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x16, 0x00, 0x00, 0x00,
  ])
  header.writeUInt32LE(jsonBytes.length, 14)
  header.writeUInt32LE(0x16, 18)
  return Buffer.concat([header, jsonBytes])
}

export function setStickerExif(webpBuffer: Buffer, pack = 'Allybot', author = 'Cyrus'): Buffer {
  if (
    webpBuffer.length < 12 ||
    webpBuffer.subarray(0, 4).toString() !== 'RIFF' ||
    webpBuffer.subarray(8, 12).toString() !== 'WEBP'
  ) {
    return webpBuffer
  }

  const exifData = buildWaExif(pack, author)
  const chunks: { fourcc: string; data: Buffer }[] = []
  let idx = 12
  let vp8xBuffer: Buffer | null = null
  let hasAnim = false
  let hasAlpha = false
  let detectedDims = { width: 512, height: 512 }

  while (idx < webpBuffer.length) {
    const fourcc = webpBuffer.subarray(idx, idx + 4).toString()
    const size = webpBuffer.readUInt32LE(idx + 4)
    const chunkData = webpBuffer.subarray(idx + 8, idx + 8 + size)
    const paddedSize = size + (size % 2)
    idx += 8 + paddedSize

    if (fourcc === 'EXIF') {
      continue
    } else if (fourcc === 'VP8X') {
      vp8xBuffer = Buffer.from(chunkData)
    } else {
      if (fourcc === 'ANIM') hasAnim = true
      if (fourcc === 'ALPH') hasAlpha = true
      if (fourcc === 'VP8 ' || fourcc === 'VP8L') {
        const d = getWebpDimensions(fourcc, chunkData)
        if (d) detectedDims = d
      }
      chunks.push({ fourcc, data: Buffer.from(chunkData) })
    }
  }

  const exifChunkHeader = Buffer.alloc(8)
  exifChunkHeader.write('EXIF', 0)
  exifChunkHeader.writeUInt32LE(exifData.length, 4)
  const padByte = exifData.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0)
  const exifChunk = Buffer.concat([exifChunkHeader, exifData, padByte])

  const bodyParts: Buffer[] = []
  if (!vp8xBuffer) {
    // Construct VP8X chunk for extended WebP
    vp8xBuffer = Buffer.alloc(10)
    let flags = 0x08 // EXIF flag
    if (hasAnim) flags |= 0x02 // Animation flag
    if (hasAlpha) flags |= 0x10 // Alpha flag
    vp8xBuffer[0] = flags
    const wMinus1 = Math.max(0, detectedDims.width - 1)
    const hMinus1 = Math.max(0, detectedDims.height - 1)
    vp8xBuffer.writeUInt16LE(wMinus1 & 0xFFFF, 4)
    vp8xBuffer.writeUInt8((wMinus1 >> 16) & 0xFF, 6)
    vp8xBuffer.writeUInt16LE(hMinus1 & 0xFFFF, 7)
    vp8xBuffer.writeUInt8((hMinus1 >> 16) & 0xFF, 9)
  } else {
    vp8xBuffer[0] |= 0x08 // Set EXIF flag
  }

  const vp8xHeader = Buffer.alloc(8)
  vp8xHeader.write('VP8X', 0)
  vp8xHeader.writeUInt32LE(vp8xBuffer.length, 4)
  bodyParts.push(vp8xHeader, vp8xBuffer)

  for (const chunk of chunks) {
    const h = Buffer.alloc(8)
    h.write(chunk.fourcc, 0)
    h.writeUInt32LE(chunk.data.length, 4)
    bodyParts.push(h, chunk.data)
    if (chunk.data.length % 2 === 1) {
      bodyParts.push(Buffer.from([0]))
    }
  }
  bodyParts.push(exifChunk)

  const body = Buffer.concat(bodyParts)
  const totalLen = body.length + 4
  const header = Buffer.alloc(12)
  header.write('RIFF', 0)
  header.writeUInt32LE(totalLen, 4)
  header.write('WEBP', 8)

  return Buffer.concat([header, body])
}
