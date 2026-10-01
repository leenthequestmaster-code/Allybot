import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { VisualCardService } from '../dist/services/visual-card-service.js'

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
})
