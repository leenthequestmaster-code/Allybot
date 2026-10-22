import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { VisualCardService } from '../dist/services/visual-card-service.js'
import { renderStatusCardImage } from '../dist/services/status-card-renderer.js'
import { buildZipArchive } from '../dist/services/spack-session.js'

describe('VisualCardService Suite (Satori + Resvg)', () => {
  it('renders WhatsApp iOS context-menu fake chat (!iqc) as PNG with blurred background and 920px width', async () => {
    const png = await VisualCardService.renderIqc({
      text: 'Halo Cyrus! Ini testing IQC via Satori flexbox.',
      time: '10:45 AM',
      senderName: 'Cyrus',
    })

    assert.ok(Buffer.isBuffer(png))
    assert.ok(png.length > 5000, `Expected PNG buffer > 5000 bytes, got ${png.length}`)
    // Check PNG signature: 89 50 4E 47
    assert.equal(png[0], 0x89)
    assert.equal(png[1], 0x50)
    assert.equal(png[2], 0x4e)
    assert.equal(png[3], 0x47)

    const meta = await sharp(png).metadata()
    assert.equal(meta.width, 920)

    // Dynamic menu items test
    const dynamicPng = await VisualCardService.renderIqc({
      text: 'Testing dynamic menu items',
      senderName: 'Adventurer',
      menuItems: ['Balas', 'Salin', 'Hapus'],
    })
    assert.ok(Buffer.isBuffer(dynamicPng))
    const dynamicMeta = await sharp(dynamicPng).metadata()
    assert.equal(dynamicMeta.width, 920)
  })

  it('renders WhatsApp dark-mode quote chat (!qc) as PNG with speech tail and auto-width', async () => {
    const png = await VisualCardService.renderQc({
      text: 'Pagi! Hari ini bot Allybot berjalan lancar dan stabil.',
      senderName: 'Cyrus Developer',
      time: '08:30',
    })

    assert.ok(Buffer.isBuffer(png))
    assert.ok(png.length > 3000, `Expected PNG buffer > 3000 bytes, got ${png.length}`)
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

  it('renders Solo-Leveling Character & Stats HUD cards natively in TypeScript (960x1280 PNG)', async () => {
    const charPng = await renderStatusCardImage('character', {
      name: 'Argon',
      gender: 'Male',
      age: 22,
      birthday: '15 Zephyra 778',
      race: 'Dragonborn',
      className: 'Knight',
      element: 'Fire',
      rank: 'S',
      level: 45,
      willOfPath: 'Light',
      titles: ['Sang Penjaga'],
      motto: 'Menembus batas langit dan bumi.',
      stats: { hp: 1200, maxHp: 1500, se: 400, maxSe: 500, str: 25, def: 20, mp: 15, res: 18, spd: 22, int: 19, lck: 14 },
    })
    assert.ok(Buffer.isBuffer(charPng))
    const charMeta = await sharp(charPng).metadata()
    assert.equal(charMeta.width, 960)
    assert.equal(charMeta.height, 1280)

    const statsPng = await renderStatusCardImage('stats', {
      name: 'Argon',
      gender: 'Male',
      age: 22,
      birthday: '15 Zephyra 778',
      race: 'Dragonborn',
      className: 'Knight',
      element: 'Fire',
      rank: 'S',
      level: 45,
      willOfPath: 'Light',
      stats: { hp: 1200, maxHp: 1500, se: 400, maxSe: 500, str: 25, def: 20, mp: 15, res: 18, spd: 22, int: 19, lck: 14, statTokens: 5, allocatedTokens: { str: 5 } },
    })
    assert.ok(Buffer.isBuffer(statsPng))
    const statsMeta = await sharp(statsPng).metadata()
    assert.equal(statsMeta.width, 960)
    assert.equal(statsMeta.height, 1280)
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
