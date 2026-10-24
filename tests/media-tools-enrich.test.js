import assert from 'node:assert/strict'
import test from 'node:test'
import QRCode from 'qrcode'
import { scanQrFromImage } from '../dist/services/qr-scanner.js'
import { generateWaveform } from '../dist/services/waveform-generator.js'
import { parseOpenGraphHtml } from '../dist/services/opengraph-extractor.js'

test('1. scanQrFromImage decodes generated QR code images accurately', async () => {
  const secret = 'https://allyssea.com/rules'
  const qrBuffer = await QRCode.toBuffer(secret, { width: 400, margin: 2 })

  const res = await scanQrFromImage(qrBuffer)
  assert.ok(res)
  assert.equal(res.text, secret)
  assert.equal(res.isUrl, true)

  // Non-QR image returns null safely
  const blankBuf = Buffer.alloc(1000, 255)
  const emptyRes = await scanQrFromImage(blankBuf)
  assert.equal(emptyRes, null)
})

test('2. generateWaveform produces 64 normalized samples (0..100)', async () => {
  // Synthetic PCM WAV buffer
  const pcm = Buffer.alloc(8000, 128)
  for (let i = 0; i < 8000; i++) {
    pcm[i] = Math.round(128 + 90 * Math.sin(i / 15))
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(44 + 8000 - 8, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(8000, 24)
  header.writeUInt32LE(8000, 28)
  header.writeUInt16LE(1, 32)
  header.writeUInt16LE(8, 34)
  header.write('data', 36)
  header.writeUInt32LE(8000, 40)

  const wav = Buffer.concat([header, pcm])
  const samples = await generateWaveform(wav)

  assert.equal(samples.length, 64)
  assert.ok(samples[0] >= 0 && samples[0] <= 100)
  assert.ok(samples.some((s) => s > 0))
})

test('3. parseOpenGraphHtml extracts og tags, twitter cards, and favicons with cheerio', () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Allyssea Community</title>
        <meta property="og:title" content="Allyssea Roleplay - Official World">
        <meta property="og:description" content="Bergabunglah dengan dunia fantasi Allyssea.">
        <meta property="og:image" content="/assets/cover.png">
        <meta property="og:site_name" content="Allyssea Portal">
        <link rel="icon" href="/favicon.ico">
      </head>
      <body></body>
    </html>
  `

  const og = parseOpenGraphHtml(html, 'https://allyssea.com')
  assert.equal(og.title, 'Allyssea Roleplay - Official World')
  assert.equal(og.description, 'Bergabunglah dengan dunia fantasi Allyssea.')
  assert.equal(og.image, 'https://allyssea.com/assets/cover.png')
  assert.equal(og.siteName, 'Allyssea Portal')
  assert.equal(og.favicon, 'https://allyssea.com/favicon.ico')
})
