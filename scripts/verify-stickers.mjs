import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { findEmojiMix, fetchEmojiMixBuffer, emojiToHex } from '../dist/services/emojimix.js'
import { FfmpegMediaTransformer } from '../dist/media.js'

async function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args)
    let stderr = ''
    p.stderr.on('data', (d) => { stderr += d.toString() })
    p.on('error', reject)
    p.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Command ${cmd} exited with ${code}: ${stderr}`))
    })
  })
}

async function verifyAll() {
  console.log('--- 1. Testing Emojimix Service ---')
  const hex1 = emojiToHex('😂')
  const hex2 = emojiToHex('😎')
  assert.equal(hex1, '1f602')
  assert.equal(hex2, '1f60e')

  const url = await findEmojiMix('😂', '😎')
  console.log('Emojimix URL:', url)
  assert.ok(url && url.includes('gstatic.com'), 'Expected gstatic.com URL')

  const pngBuf = await fetchEmojiMixBuffer(url)
  assert.ok(pngBuf && pngBuf.length > 1000, 'Expected non-empty PNG buffer')
  console.log(`Emojimix PNG fetched: ${pngBuf.length} bytes`)

  const transformer = new FfmpegMediaTransformer()
  const stickerWebp = await transformer.transform(new Uint8Array(pngBuf), 'image/png', 'image', 'sticker')
  assert.ok(stickerWebp && stickerWebp.length > 1000, 'Expected non-empty WebP sticker')
  console.log(`Emojimix WebP converted: ${stickerWebp.length} bytes`)

  console.log('--- 2. Testing Brat Generator (Themes & Authentic Blur) ---')
  const bratWebpPath = '/tmp/verify_brat_white.webp'
  const bratGreenPath = '/tmp/verify_brat_green.webp'

  await runCommand('python3', [join(process.cwd(), 'scripts', 'generate-brat.py'), bratWebpPath, 'aku', 'pengen', 'jadi', 'anime'])
  const whiteData = await readFile(bratWebpPath)
  assert.ok(whiteData.length > 500, 'Brat white sticker generated')
  console.log(`Brat white sticker size: ${whiteData.length} bytes`)
  await unlink(bratWebpPath).catch(() => {})

  await runCommand('python3', [join(process.cwd(), 'scripts', 'generate-brat.py'), bratGreenPath, '--green', 'brat', 'lime', 'edition'])
  const greenData = await readFile(bratGreenPath)
  assert.ok(greenData.length > 500, 'Brat green sticker generated')
  console.log(`Brat green sticker size: ${greenData.length} bytes`)
  await unlink(bratGreenPath).catch(() => {})

  console.log('--- 3. Testing Bratvid Video Generator ---')
  const bvidPath = '/tmp/verify_bvid.mp4'
  await runCommand('python3', [join(process.cwd(), 'scripts', 'generate-bratvid.py'), bvidPath, 'i', 'am', 'so', 'brat'])
  const vidData = await readFile(bvidPath)
  assert.ok(vidData.length > 1000, 'Bratvid MP4 generated')
  console.log(`Bratvid MP4 size: ${vidData.length} bytes`)
  await unlink(bvidPath).catch(() => {})

  console.log('All sticker generator verifications passed successfully! 🚀')
}

verifyAll().catch((err) => {
  console.error('Verification failed:', err)
  process.exit(1)
})
