/**
 * Spack Session Service (Pure In-Memory TypeScript + Sharp + Native ZIP Builder)
 * Collects multiple images in memory and builds .wastickers packs without Python or disk I/O.
 */

import { deflateRawSync } from 'node:zlib'
import sharp from 'sharp'

export interface SpackSession {
  readonly id: string
  readonly packName: string
  readonly remoteJid: string
  readonly actorJid: string
  readonly createdAt: number
  lastActivityAt: number
  readonly images: Buffer[]
}

const SESSION_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_STICKERS = 30
const MIN_STICKERS = 3

const _sessions = new Map<string, SpackSession>()

// Pre-computed CRC32 lookup table for ZIP archive assembly
const CRC32_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC32_TABLE[i] = c >>> 0
}

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Pure TypeScript PKZIP builder (ZIP_DEFLATED) — zero external dependencies, 100% in-memory
 */
export function buildZipArchive(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const uncompressed = entry.data
    const compressed = deflateRawSync(uncompressed)
    const useDeflate = compressed.length < uncompressed.length
    const payload = useDeflate ? compressed : uncompressed
    const method = useDeflate ? 8 : 0
    const crc = crc32(uncompressed)

    const localHeader = Buffer.alloc(30 + nameBuf.length)
    localHeader.writeUInt32LE(0x04034b50, 0) // Local file header signature
    localHeader.writeUInt16LE(20, 4) // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0, 6) // General purpose bit flag
    localHeader.writeUInt16LE(method, 8) // Compression method (8 = deflate, 0 = store)
    localHeader.writeUInt16LE(0, 10) // Last mod file time
    localHeader.writeUInt16LE(0x21, 12) // Last mod file date
    localHeader.writeUInt32LE(crc, 14) // CRC-32
    localHeader.writeUInt32LE(payload.length, 18) // Compressed size
    localHeader.writeUInt32LE(uncompressed.length, 22) // Uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26) // File name length
    localHeader.writeUInt16LE(0, 28) // Extra field length
    nameBuf.copy(localHeader, 30)

    localParts.push(localHeader, payload)

    const centralHeader = Buffer.alloc(46 + nameBuf.length)
    centralHeader.writeUInt32LE(0x02014b50, 0) // Central file header signature
    centralHeader.writeUInt16LE(20, 4) // Version made by
    centralHeader.writeUInt16LE(20, 6) // Version needed to extract
    centralHeader.writeUInt16LE(0, 8) // General purpose bit flag
    centralHeader.writeUInt16LE(method, 10) // Compression method
    centralHeader.writeUInt16LE(0, 12) // Last mod file time
    centralHeader.writeUInt16LE(0x21, 14) // Last mod file date
    centralHeader.writeUInt32LE(crc, 16) // CRC-32
    centralHeader.writeUInt32LE(payload.length, 20) // Compressed size
    centralHeader.writeUInt32LE(uncompressed.length, 24) // Uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28) // File name length
    centralHeader.writeUInt16LE(0, 30) // Extra field length
    centralHeader.writeUInt16LE(0, 32) // File comment length
    centralHeader.writeUInt16LE(0, 34) // Disk number start
    centralHeader.writeUInt16LE(0, 36) // Internal file attributes
    centralHeader.writeUInt32LE(0, 38) // External file attributes
    centralHeader.writeUInt32LE(offset, 42) // Relative offset of local header
    nameBuf.copy(centralHeader, 46)

    centralParts.push(centralHeader)
    offset += localHeader.length + payload.length
  }

  const centralDirSize = centralParts.reduce((acc, b) => acc + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // End of central dir signature
  eocd.writeUInt16LE(0, 4) // Number of this disk
  eocd.writeUInt16LE(0, 6) // Disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8) // Total entries on this disk
  eocd.writeUInt16LE(entries.length, 10) // Total entries in central directory
  eocd.writeUInt32LE(centralDirSize, 12) // Size of central directory
  eocd.writeUInt32LE(offset, 16) // Offset of start of central directory
  eocd.writeUInt16LE(0, 20) // ZIP file comment length

  return Buffer.concat([...localParts, ...centralParts, eocd])
}

async function toStaticWebpUnder100Kb(imageBuffer: Buffer): Promise<Buffer> {
  let quality = 82
  let buf = await sharp(imageBuffer)
    .resize(512, 512, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .webp({ quality, effort: 4 })
    .toBuffer()

  while (buf.length > 100 * 1024 && quality > 30) {
    quality -= 12
    buf = await sharp(imageBuffer)
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .webp({ quality, effort: 4 })
      .toBuffer()
  }
  return buf
}

export function startSpackSession(remoteJid: string, actorJid: string, packName: string): SpackSession {
  const session: SpackSession = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    packName: packName.trim() || 'Allybot Pack',
    remoteJid,
    actorJid,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    images: [],
  }
  _sessions.set(remoteJid, session)
  return session
}

export function getSpackSession(remoteJid: string): SpackSession | null {
  const session = _sessions.get(remoteJid)
  if (!session) return null
  if (Date.now() - session.lastActivityAt > SESSION_TTL_MS) {
    _sessions.delete(remoteJid)
    return null
  }
  return session
}

export async function addImageToSpack(
  remoteJid: string,
  imageBuffer: Buffer,
): Promise<{ count: number; max: number } | { error: string }> {
  const session = getSpackSession(remoteJid)
  if (!session) return { error: 'no_session' }

  if (session.images.length >= MAX_STICKERS) {
    return { error: 'full' }
  }

  session.images.push(Buffer.from(imageBuffer))
  session.lastActivityAt = Date.now()
  return { count: session.images.length, max: MAX_STICKERS }
}

export async function finishSpackSession(
  remoteJid: string,
): Promise<
  | {
      packName: string
      wastickersBuffer: Buffer
      stickerBuffers: Buffer[]
      count: number
    }
  | { error: string }
> {
  const session = getSpackSession(remoteJid)
  if (!session) return { error: 'no_session' }

  if (session.images.length < MIN_STICKERS) {
    return { error: `too_few:${session.images.length}:${MIN_STICKERS}` }
  }

  // Convert all images in parallel using sharp in-memory
  const settled = await Promise.allSettled(session.images.map((buf) => toStaticWebpUnder100Kb(buf)))
  const stickerBuffers = settled
    .filter((r): r is PromiseFulfilledResult<Buffer> => r.status === 'fulfilled')
    .map((r) => r.value)

  if (stickerBuffers.length === 0) {
    _sessions.delete(remoteJid)
    return { error: 'conversion_failed' }
  }

  const safeId = session.packName.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'pack'
  const manifest = {
    android_play_store_link: '',
    ios_app_store_link: '',
    publisher_email: 'admin@allyssea.org',
    publisher_website: 'https://allyssea.org',
    privacy_policy_website: 'https://allyssea.org/privacy',
    license_agreement_website: 'https://allyssea.org/license',
    image_data_version: '1',
    avoid_cache: false,
    animated_sticker_pack: false,
    identifier: `com.allybot.${safeId}`,
    name: session.packName,
    publisher: 'Allybot',
    tray_image_file: 'icon.png',
    stickers: stickerBuffers.map((_, i) => ({
      image_file: `${String(i).padStart(2, '0')}.webp`,
      emojis: ['🙂'],
    })),
  }

  const iconBuffer = await sharp(stickerBuffers[0]!)
    .resize(96, 96, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()

  const zipEntries: { name: string; data: Buffer }[] = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: 'icon.png', data: iconBuffer },
    ...stickerBuffers.map((data, idx) => ({
      name: `${String(idx).padStart(2, '0')}.webp`,
      data,
    })),
  ]

  const wastickersBuffer = buildZipArchive(zipEntries)
  _sessions.delete(remoteJid)

  return {
    packName: session.packName,
    wastickersBuffer,
    stickerBuffers,
    count: stickerBuffers.length,
  }
}

export async function cancelSpackSession(remoteJid: string): Promise<boolean> {
  return _sessions.delete(remoteJid)
}
