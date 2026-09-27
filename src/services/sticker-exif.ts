/**
 * WhatsApp Sticker EXIF Metadata Injector
 * Formats custom sticker-pack-name and sticker-pack-publisher into standard WhatsApp EXIF chunks.
 */

export function buildWaExif(pack = 'Allybot', author = 'Cyrus', emojis = ['🙂']): Buffer {
  const jsonStr = JSON.stringify({
    'sticker-pack-id': 'com.allybot.stickers',
    'sticker-pack-name': pack,
    'sticker-pack-publisher': author,
    'emojis': emojis,
  })
  const jsonBytes = Buffer.from(jsonStr, 'utf-8')
  const exifHeader = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00,
  ])
  const lenBytes = Buffer.alloc(4)
  lenBytes.writeUInt32LE(jsonBytes.length, 0)
  const offsetBytes = Buffer.alloc(4)
  offsetBytes.writeUInt32LE(0x16, 0)
  const pad = Buffer.alloc(4, 0)
  return Buffer.concat([exifHeader, lenBytes, offsetBytes, pad, jsonBytes])
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
      chunks.push({ fourcc, data: Buffer.from(chunkData) })
    }
  }

  const exifChunkHeader = Buffer.alloc(8)
  exifChunkHeader.write('EXIF', 0)
  exifChunkHeader.writeUInt32LE(exifData.length, 4)
  const padByte = exifData.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0)
  const exifChunk = Buffer.concat([exifChunkHeader, exifData, padByte])

  const bodyParts: Buffer[] = []
  if (vp8xBuffer) {
    vp8xBuffer[0] |= 0x08 // Set EXIF flag in VP8X
    const vp8xHeader = Buffer.alloc(8)
    vp8xHeader.write('VP8X', 0)
    vp8xHeader.writeUInt32LE(vp8xBuffer.length, 4)
    bodyParts.push(vp8xHeader, vp8xBuffer)
  }

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
