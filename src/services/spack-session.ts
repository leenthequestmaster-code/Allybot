/**
 * Spack Session Service
 * In-memory / filesystem session manager for collecting multiple images to create sticker packs.
 */

import { mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export interface SpackSession {
  readonly id: string
  readonly packName: string
  readonly remoteJid: string
  readonly actorJid: string
  readonly createdAt: number
  lastActivityAt: number
}

const SESSION_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_STICKERS = 30
const MIN_STICKERS = 3

const _sessions = new Map<string, SpackSession>()

function getSessionDir(remoteJid: string): string {
  const safeJid = remoteJid.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join('/tmp', `spack_${safeJid}`)
}

export function startSpackSession(remoteJid: string, actorJid: string, packName: string): SpackSession {
  const session: SpackSession = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    packName: packName.trim() || 'Allybot Pack',
    remoteJid,
    actorJid,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  }
  _sessions.set(remoteJid, session)
  return session
}

export function getSpackSession(remoteJid: string): SpackSession | null {
  const session = _sessions.get(remoteJid)
  if (!session) return null
  if (Date.now() - session.lastActivityAt > SESSION_TTL_MS) {
    cancelSpackSession(remoteJid)
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

  const dir = getSessionDir(remoteJid)
  await mkdir(dir, { recursive: true })

  const existingFiles = (await readdir(dir)).filter((f) => f.startsWith('img_'))
  if (existingFiles.length >= MAX_STICKERS) {
    return { error: 'full' }
  }

  const nextIdx = existingFiles.length + 1
  const filePath = join(dir, `img_${String(nextIdx).padStart(3, '0')}.png`)
  await writeFile(filePath, imageBuffer)

  session.lastActivityAt = Date.now()
  return { count: nextIdx, max: MAX_STICKERS }
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

  const dir = getSessionDir(remoteJid)
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith('img_')).sort()

  if (files.length < MIN_STICKERS) {
    return { error: `too_few:${files.length}:${MIN_STICKERS}` }
  }

  const filePaths = files.map((f) => join(dir, f))
  const outZipPath = join(dir, 'pack.wastickers')

  // Run python script to build .wastickers
  const scriptPath = join(process.cwd(), 'scripts', 'generate-spack.py')
  await new Promise<void>((resolve, reject) => {
    const py = spawn('python3', [scriptPath, outZipPath, session.packName, ...filePaths])
    let stderr = ''
    py.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    py.on('error', reject)
    py.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`generate-spack.py exited with code ${code}: ${stderr}`))
    })
  })

  const wastickersBuffer = await readFile(outZipPath)

  // Collect individual webp stickers for direct sending
  const stickerBuffers: Buffer[] = []
  const zipUnpackFiles = (await readdir(dir)).filter((f) => f.endsWith('.webp'))
  for (const sf of zipUnpackFiles.sort()) {
    try {
      stickerBuffers.push(await readFile(join(dir, sf)))
    } catch {
      // ignore
    }
  }

  // Cleanup session and temporary directory
  _sessions.delete(remoteJid)
  await rm(dir, { recursive: true, force: true }).catch(() => {})

  return {
    packName: session.packName,
    wastickersBuffer,
    stickerBuffers,
    count: files.length,
  }
}

export async function cancelSpackSession(remoteJid: string): Promise<boolean> {
  const existed = _sessions.delete(remoteJid)
  const dir = getSessionDir(remoteJid)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  return existed
}
