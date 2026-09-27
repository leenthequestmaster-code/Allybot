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

  console.log('--- 3. Testing Bratvid Generator (Sticker WebP & MP4) ---')
  const bvidStickerPath = '/tmp/verify_bvid.webp'
  await runCommand('python3', [join(process.cwd(), 'scripts', 'generate-bratvid.py'), bvidStickerPath, 'i', 'am', 'so', 'brat'])
  const stickerData = await readFile(bvidStickerPath)
  assert.ok(stickerData.length > 1000, 'Bratvid animated sticker generated')
  console.log(`Bratvid animated sticker size: ${stickerData.length} bytes`)
  await unlink(bvidStickerPath).catch(() => {})

  const bvidMp4Path = '/tmp/verify_bvid.mp4'
  await runCommand('python3', [join(process.cwd(), 'scripts', 'generate-bratvid.py'), bvidMp4Path, 'i', 'am', 'so', 'brat'])
  const vidData = await readFile(bvidMp4Path)
  assert.ok(vidData.length > 1000, 'Bratvid MP4 generated')
  console.log(`Bratvid MP4 size: ${vidData.length} bytes`)
  await unlink(bvidMp4Path).catch(() => {})

  console.log('--- 4. Testing Quote Chat (QC) Generator ---')
  const qcOutPath = '/tmp/verify_qc.webp'
  await runCommand('python3', [
    join(process.cwd(), 'scripts', 'generate-qc.py'),
    qcOutPath,
    'Cyrus',
    '20:45',
    'none',
    'Keren banget stiker bubble chat WA dengan emoji 🚀🔥',
  ])
  const qcData = await readFile(qcOutPath)
  assert.ok(qcData.length > 1000, 'QC WebP generated')
  console.log(`QC sticker size: ${qcData.length} bytes`)
  await unlink(qcOutPath).catch(() => {})

  console.log('--- 5. Testing WhatsApp Sticker EXIF Injector ---')
  const { setStickerExif } = await import('../dist/services/sticker-exif.js')
  const dummyWebp = Buffer.from(stickerWebp)
  const exifInjected = setStickerExif(dummyWebp, 'MyCustomPack', 'MyCustomAuthor')
  assert.ok(exifInjected.includes('EXIF'), 'EXIF chunk present in WebP')
  assert.ok(exifInjected.includes('MyCustomAuthor'), 'Custom author present in EXIF')
  console.log(`EXIF successfully injected! WebP size: ${exifInjected.length} bytes`)

  console.log('--- 6. Testing Sticker Pack Generator (spack) ---')
  const dummyImg1 = '/tmp/dummy_sp1.png'
  const dummyImg2 = '/tmp/dummy_sp2.png'
  const dummyImg3 = '/tmp/dummy_sp3.png'
  const dummyOutZip = '/tmp/verify_pack.wastickers'

  const { writeFile } = await import('node:fs/promises')
  await writeFile(dummyImg1, pngBuf)
  await writeFile(dummyImg2, pngBuf)
  await writeFile(dummyImg3, pngBuf)

  await runCommand('python3', [
    join(process.cwd(), 'scripts', 'generate-spack.py'),
    dummyOutZip,
    'VerifyPack',
    dummyImg1,
    dummyImg2,
    dummyImg3,
  ])

  const zipData = await readFile(dummyOutZip)
  assert.ok(zipData.length > 1000, 'Wastickers zip generated')
  console.log(`Wastickers pack zip size: ${zipData.length} bytes`)
  await unlink(dummyImg1).catch(() => {})
  await unlink(dummyImg2).catch(() => {})
  await unlink(dummyImg3).catch(() => {})
  await unlink(dummyOutZip).catch(() => {})

  console.log('All sticker generator verifications passed successfully! 🚀')
}

verifyAll().catch((err) => {
  console.error('Verification failed:', err)
  process.exit(1)
})
