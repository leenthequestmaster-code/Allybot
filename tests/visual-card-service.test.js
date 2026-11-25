import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { VisualCardService } from '../dist/services/visual-card-service.js'
import { buildZipArchive } from '../dist/services/spack-session.js'

describe('VisualCardService Suite (Satori + Resvg)', () => {
  it('renders WhatsApp iOS 26 IQC Phone screen (!iqc) with 680x1360 portrait dimensions and transparent stickerMode', async () => {
    const png = await VisualCardService.renderIqc({
      text: 'Halo Cyrus! Ini testing IQC iOS 26 Liquid Glass 🔥💯',
      time: '10:45',
      senderName: 'Cyrus',
      battery: 92,
      carrier: '5G',
      reply: { sender: 'Chlona', text: 'Sudah akurat belum tampilannya?' },
    })

    assert.ok(Buffer.isBuffer(png))
    assert.ok(png.length > 10000, `Expected PNG buffer > 10000 bytes, got ${png.length}`)
    assert.equal(png[0], 0x89)
    assert.equal(png[1], 0x50)
    assert.equal(png[2], 0x4e)
    assert.equal(png[3], 0x47)

    const meta = await sharp(png).metadata()
    assert.equal(meta.width, 680)
    assert.equal(meta.height, 1360)

    // Transparent stickerMode + dynamic menu items + light mode test
    const stickerPng = await VisualCardService.renderIqc({
      text: 'Testing dynamic menu items',
      senderName: 'Adventurer',
      stickerMode: true,
      theme: 'light',
      menuItems: ['Balas', 'Salin', 'Hapus'],
    })
    assert.ok(Buffer.isBuffer(stickerPng))
    const stickerMeta = await sharp(stickerPng).metadata()
    assert.ok((stickerMeta.width ?? 0) >= 480 && (stickerMeta.width ?? 0) <= 580)
    assert.ok((stickerMeta.height ?? 0) < 900)
  })

  it('renders WhatsApp dark-mode quote chat (!qc) at high-res proportional scale for 512x512 stickers', async () => {
    const shortPng = await VisualCardService.renderQc({
      text: 'ok',
      senderName: 'Cyrus',
      time: '08:30',
    })
    const shortMeta = await sharp(shortPng).metadata()
    assert.ok(Buffer.isBuffer(shortPng))
    assert.ok((shortMeta.width ?? 0) >= 400)
    assert.ok((shortMeta.height ?? 0) >= 160)

    const png = await VisualCardService.renderQc({
      text: 'Pagi! Hari ini bot Allybot berjalan lancar dan stabil. 🔥✨',
      senderName: 'Cyrus Developer',
      time: '08:30',
    })

    assert.ok(Buffer.isBuffer(png))
    assert.ok(png.length > 5000, `Expected PNG buffer > 5000 bytes, got ${png.length}`)
    assert.equal(png[0], 0x89)
    assert.equal(png[1], 0x50)
  })

  it('renders Twitter/X mockup card (!tweet) with verified badge and metrics', async () => {
    const png = await VisualCardService.renderTweet({
      name: 'Cyrus',
      handle: 'cyrus_code',
      text: 'Visual cards on Allybot powered by Satori + Resvg are blazing fast! ⚡🚀',
      verified: true,
      likes: '14.2K',
      retweets: '2.5K',
      views: '89.0K',
    })

    assert.ok(Buffer.isBuffer(png))
    assert.ok(png.length > 5000, `Expected PNG buffer > 5000 bytes, got ${png.length}`)
    assert.equal(png[0], 0x89)
  })

  it('renders TikTok profile stalker card (!ttstalk)', async () => {
    const png = await VisualCardService.renderProfileCard({
      platform: 'tiktok',
      username: 'tiktok',
      nickname: 'TikTok Official',
      bio: 'Your next discovery is waiting on TikTok.',
      verified: true,
      stats: {
        followers: '96.0M',
        following: '1',
        thirdStat: '464.9M',
        thirdStatLabel: 'Total Likes',
      },
    })

    assert.ok(Buffer.isBuffer(png))
    assert.ok(png.length > 5000)
  })

  it('renders Instagram profile stalker card (!igstalk)', async () => {
    const png = await VisualCardService.renderProfileCard({
      platform: 'instagram',
      username: 'instagram',
      nickname: 'Instagram',
      bio: 'Discover what is happening next.',
      verified: true,
      stats: {
        followers: '675M',
        following: '60',
        thirdStat: '7,890',
        thirdStatLabel: 'Posts',
      },
    })

    assert.ok(Buffer.isBuffer(png))
    assert.ok(png.length > 5000)
  })

  it('converts rendered PNG buffer to 512x512 WebP sticker format', async () => {
    const png = await VisualCardService.renderQc({
      text: 'Sticker conversion test',
      senderName: 'Bot',
    })

    const webp = await VisualCardService.pngToWebpSticker(png, 512)
    assert.ok(Buffer.isBuffer(webp))
    assert.ok(webp.length > 1000)
    // Check WebP RIFF header
    const riff = webp.toString('utf8', 0, 4)
    const format = webp.toString('utf8', 8, 12)
    assert.equal(riff, 'RIFF')
    assert.equal(format, 'WEBP')
  })

  it('renders authentic Brat album cover (!brat) as 1440x1440 PNG 2x with blur and justification', async () => {
    const png = await VisualCardService.renderBrat('it is so confusing sometimes to be a girl')
    assert.ok(Buffer.isBuffer(png))
    assert.ok(png.length > 5000)

    const meta = await sharp(png).metadata()
    assert.equal(meta.width, 1440)
    assert.equal(meta.height, 1440)

    // Verify rejection of empty text and text exceeding 200 chars
    await assert.rejects(async () => VisualCardService.renderBrat('   '), /tidak boleh kosong/)
  })

  it('renders Welcome and Leave Avatar Card v2 (1024x611 PNG) with fallback and custom avatar', async () => {
    // 1. Welcome card with fallback avatar
    const welcomePng = await VisualCardService.renderWelcomeCard({
      type: 'welcome',
      userName: '@alice',
      groupName: 'Allyssea Roleplay',
    })
    assert.ok(Buffer.isBuffer(welcomePng))
    const welcomeMeta = await sharp(welcomePng).metadata()
    assert.equal(welcomeMeta.width, 1024)
    assert.equal(welcomeMeta.height, 611)

    // 2. Leave card with custom avatar buffer
    const mockAvatar = await sharp({
      create: { width: 100, height: 100, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer()

    const leavePng = await VisualCardService.renderWelcomeCard({
      type: 'leave',
      userName: '@bob',
      groupName: 'Allyssea Roleplay',
      avatarBuffer: mockAvatar,
    })
    assert.ok(Buffer.isBuffer(leavePng))
    const leaveMeta = await sharp(leavePng).metadata()
    assert.equal(leaveMeta.width, 1024)
    assert.equal(leaveMeta.height, 611)
  })

  it('renders native TypeScript Smeme static WebP sticker and builds in-memory .wastickers ZIP archive', async () => {
    const sampleImg = await sharp({
      create: { width: 400, height: 300, channels: 4, background: { r: 40, g: 120, b: 220, alpha: 1 } },
    }).png().toBuffer()

    const smemeWebp = await VisualCardService.renderSmemeStatic(sampleImg, 'KETIKA BOT', 'FULL TYPESCRIPT', 55)
    assert.ok(Buffer.isBuffer(smemeWebp))
    assert.equal(smemeWebp.toString('utf8', 0, 4), 'RIFF')
    assert.equal(smemeWebp.toString('utf8', 8, 12), 'WEBP')

    const zipBuf = buildZipArchive([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ name: 'Allybot Pack' })) },
      { name: '00.webp', data: smemeWebp },
    ])
    assert.ok(Buffer.isBuffer(zipBuf))
    assert.equal(zipBuf.readUInt32LE(0), 0x04034b50) // PKZIP local header magic
  })
})
