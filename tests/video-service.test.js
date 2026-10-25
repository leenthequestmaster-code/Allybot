import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import pino from 'pino'
import {
  VideoService,
  MockVideoProvider,
} from '../dist/services/video-service.js'
import { createVideoPlugin } from '../dist/framework/plugins/video.js'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { ServiceRegistry } from '../dist/framework/service-registry.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

function fakeWhatsapp() {
  const sent = []
  const media = []
  const reactions = []
  return {
    sent,
    media,
    reactions,
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text) {
      sent.push({ remoteJid, text })
    },
    async sendMedia(remoteJid, payload) {
      media.push({ remoteJid, payload })
    },
    async sendReaction(remoteJid, key, emoji) {
      reactions.push({ remoteJid, key, emoji })
    },
    async downloadMedia(msg, source, limits) {
      const samplePath = '/root/flow-spike/final-test-video.mp4'
      const data = fs.existsSync(samplePath)
        ? fs.readFileSync(samplePath)
        : Buffer.from('00000018667479706d7034320000000069736f6d6d7034320000000866726565000000106d6461740000000000000000', 'hex')
      return {
        data,
        mimeType: 'video/mp4',
        fileName: 'sample.mp4',
        kind: 'video',
      }
    },
  }
}

function message(id, remoteJid, text, options = {}) {
  return {
    id,
    remoteJid,
    text,
    timestamp: Date.now(),
    fromMe: false,
    senderJid: options.senderJid ?? remoteJid,
    ...options,
  }
}

test('1. MockVideoProvider produces valid MP4 binary buffer without network', async () => {
  const provider = new MockVideoProvider()
  const result = await provider.generate({ prompt: 'pemandangan pantai' })

  assert.equal(provider.name, 'mock')
  assert.equal(result.mimeType, 'video/mp4')
  assert.equal(result.durationSeconds, 8)
  assert.ok(result.buffer.length > 0)
  assert.match(result.fileName, /\.mp4$/)
})

test('2. VideoService enforces FIFO queueing and commits usage with concise status', async () => {
  const service = new VideoService({
    provider: new MockVideoProvider(),
    cooldownMs: 1_000,
    dailyLimit: 5,
  })

  const p1 = service.enqueue('user1@s.whatsapp.net', { prompt: 'prompt 1' })
  const p2 = service.enqueue('user2@s.whatsapp.net', { prompt: 'prompt 2' })

  const [r1, r2] = await Promise.all([p1, p2])
  assert.ok(r1.buffer)
  assert.ok(r2.buffer)

  const quota = service.checkQuota('user1@s.whatsapp.net')
  assert.equal(quota.allowed, false)
  assert.match(quota.reason ?? '', /Status: Diproses/i)
  assert.match(quota.reason ?? '', /Tunggu \d+ detik/i)
})

test('3. VideoService daily quota decrement and exhaustion rejection', async () => {
  const service = new VideoService({
    provider: new MockVideoProvider(),
    cooldownMs: 0,
    dailyLimit: 2,
  })

  await service.enqueue('userA@s.whatsapp.net', { prompt: 'job 1' })
  const q1 = service.checkQuota('userA@s.whatsapp.net')
  assert.equal(q1.allowed, true)
  assert.equal(q1.remaining, 1)

  await service.enqueue('userA@s.whatsapp.net', { prompt: 'job 2' })
  const q2 = service.checkQuota('userA@s.whatsapp.net')
  assert.equal(q2.allowed, false)
  assert.equal(q2.remaining, 0)
  assert.match(q2.reason ?? '', /Status: Gagal/i)
  assert.match(q2.reason ?? '', /Batas harian 2 video telah tercapai/i)
})

test('4. VideoPlugin registers commands !vid, !omnivid, and editing commands without model names', async () => {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const whatsapp = fakeWhatsapp()
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  const videoService = new VideoService({ provider: new MockVideoProvider() })
  services.register(videoService)

  const plugin = createVideoPlugin(whatsapp, { videoService })
  plugin.load?.({ logger, config, events, commands: registry, services })

  assert.ok(registry.get('vid'))
  assert.ok(registry.get('omnivid'))
  assert.ok(registry.get('vcompress'))
  assert.ok(registry.get('vtrim'))
  assert.ok(registry.get('vspeed'))
  assert.ok(registry.get('vmute'))
  assert.ok(registry.get('vvn'))
  assert.ok(registry.get('vidstatus'))
  assert.ok(registry.get('vidmodels'))

  // Verify description purity (zero AI model name leak)
  for (const cmdName of ['vid', 'omnivid', 'vcompress', 'vtrim', 'vspeed', 'vmute', 'vvn']) {
    const desc = registry.get(cmdName)?.description ?? ''
    assert.doesNotMatch(desc, /\b(veo|gemini|google|flow)\b/i)
  }
})

test('5. !vid rejects empty or too short prompt with standardized format', async () => {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const whatsapp = fakeWhatsapp()
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  const videoService = new VideoService({ provider: new MockVideoProvider() })
  services.register(videoService)

  const plugin = createVideoPlugin(whatsapp, { videoService })
  plugin.load?.({ logger, config, events, commands: registry, services })

  await registry.dispatch(message('m-1', 'user@s.whatsapp.net', '!vid'))
  assert.equal(whatsapp.sent.length, 1)
  assert.match(whatsapp.sent[0].text, /Status: Gagal/i)
  assert.match(whatsapp.sent[0].text, /Format perintah:\n!vid <deskripsi>/i)
  assert.doesNotMatch(whatsapp.sent[0].text, /veo|gemini|omni|google/i)
})

test('6. !vidstatus and !vidmodels deliver concise standardized status', async () => {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const whatsapp = fakeWhatsapp()
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  const videoService = new VideoService({ provider: new MockVideoProvider(), dailyLimit: 8 })
  services.register(videoService)

  const plugin = createVideoPlugin(whatsapp, { videoService })
  plugin.load?.({ logger, config, events, commands: registry, services })

  await registry.dispatch(message('m-2', 'user@s.whatsapp.net', '!vidstatus'))
  assert.equal(whatsapp.sent.length, 1)
  assert.match(whatsapp.sent[0].text, /Status: Berhasil/i)
  assert.match(whatsapp.sent[0].text, /Sisa kuota harian: 8 video/i)
  assert.doesNotMatch(whatsapp.sent[0].text, /veo|gemini|omni|google/i)

  await registry.dispatch(message('m-3', 'user@s.whatsapp.net', '!vidmodels'))
  assert.equal(whatsapp.sent.length, 2)
  assert.match(whatsapp.sent[1].text, /Status: Berhasil/i)
  assert.match(whatsapp.sent[1].text, /Daftar perintah video:/i)
  assert.doesNotMatch(whatsapp.sent[1].text, /\b(veo|gemini|google|flow)\b/i)
})

test('7. End-to-end !vid dispatch renders and delivers concise video caption', async () => {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const whatsapp = fakeWhatsapp()
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  const videoService = new VideoService({
    provider: new MockVideoProvider(),
    cooldownMs: 0,
    dailyLimit: 10,
  })
  services.register(videoService)

  const plugin = createVideoPlugin(whatsapp, { videoService })
  plugin.load?.({ logger, config, events, commands: registry, services })

  await registry.dispatch(
    message(
      'm-4',
      'user@s.whatsapp.net',
      '!vid pemandangan pegunungan saat fajar',
    ),
  )

  assert.equal(whatsapp.sent.length, 1)
  assert.match(whatsapp.sent[0].text, /Status: Diproses/i)
  assert.match(whatsapp.sent[0].text, /Video sedang dibuat/i)

  assert.equal(whatsapp.media.length, 1)
  assert.equal(whatsapp.media[0].payload.kind, 'video')
  assert.equal(whatsapp.media[0].payload.mimeType, 'video/mp4')
  assert.match(whatsapp.media[0].payload.caption, /Status: Berhasil/i)
  assert.match(whatsapp.media[0].payload.caption, /Video selesai dibuat/i)
  assert.doesNotMatch(whatsapp.media[0].payload.caption, /veo|gemini|omni|google/i)
})

test('8. Native editing commands reject safely with standardized error format', async () => {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const whatsapp = fakeWhatsapp()
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  const videoService = new VideoService({ provider: new MockVideoProvider() })
  services.register(videoService)

  const plugin = createVideoPlugin(whatsapp, { videoService })
  plugin.load?.({ logger, config, events, commands: registry, services })

  await registry.dispatch(message('m-5', 'user@s.whatsapp.net', '!vcompress'))
  assert.match(whatsapp.sent[0].text, /Status: Gagal/i)
  assert.match(whatsapp.sent[0].text, /Balas video dengan !vcompress/i)

  await registry.dispatch(message('m-6', 'user@s.whatsapp.net', '!vtrim'))
  assert.match(whatsapp.sent[1].text, /Status: Gagal/i)
  assert.match(whatsapp.sent[1].text, /Format perintah: !vtrim/i)

  await registry.dispatch(message('m-7', 'user@s.whatsapp.net', '!vspeed'))
  assert.match(whatsapp.sent[2].text, /Status: Gagal/i)
  assert.match(whatsapp.sent[2].text, /Format perintah: !vspeed/i)

  await registry.dispatch(message('m-8', 'user@s.whatsapp.net', '!vmute'))
  assert.match(whatsapp.sent[3].text, /Status: Gagal/i)
  assert.match(whatsapp.sent[3].text, /Balas video dengan !vmute/i)

  await registry.dispatch(message('m-9', 'user@s.whatsapp.net', '!vvn'))
  assert.match(whatsapp.sent[4].text, /Status: Gagal/i)
  assert.match(whatsapp.sent[4].text, /Balas video dengan !vvn/i)
})

test('9. Native FFmpeg video transformations execute cleanly on valid media', async () => {
  const samplePath = '/root/flow-spike/final-test-video.mp4'
  if (!fs.existsSync(samplePath)) return

  const inputBuffer = fs.readFileSync(samplePath)
  const service = new VideoService()

  const compressed = await service.compressVideo(inputBuffer)
  assert.ok(compressed.length > 0)
  assert.ok(compressed.length < inputBuffer.length)

  const muted = await service.muteVideo(inputBuffer)
  assert.ok(muted.length > 0)

  const vn = await service.extractVoiceNote(inputBuffer)
  assert.ok(vn.length > 0)
  assert.ok(vn.length < inputBuffer.length)

  const spedUp = await service.speedVideo(inputBuffer, 1.5)
  assert.ok(spedUp.length > 0)

  const trimmed = await service.trimVideo(inputBuffer, '00:00:01', '00:00:04')
  assert.ok(trimmed.length > 0)
})

test('10. !omnivid handles Image-to-Video animation from image media with standardized format', async () => {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const whatsapp = fakeWhatsapp()
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  const videoService = new VideoService({
    provider: new MockVideoProvider(),
    cooldownMs: 0,
    dailyLimit: 10,
  })
  services.register(videoService)

  const plugin = createVideoPlugin(whatsapp, { videoService })
  plugin.load?.({ logger, config, events, commands: registry, services })

  // 1. Rejects if no image is present
  await registry.dispatch(message('m-10', 'user-no-img@s.whatsapp.net', '!omnivid buat tersenyum'))
  assert.match(whatsapp.sent[0].text, /Status: Gagal/i)
  assert.match(whatsapp.sent[0].text, /Kirim gambar atau balas foto/i)
  assert.doesNotMatch(whatsapp.sent[0].text, /\b(veo|gemini|google|flow)\b/i)

  // 2. Succeeds when image is present
  const msgWithImage = message('m-11', 'user-with-img@s.whatsapp.net', '!omnivid buat tersenyum ramah', {
    media: { kind: 'image' }
  })
  await registry.dispatch(msgWithImage)

  assert.match(whatsapp.sent[1].text, /Status: Diproses/i)
  assert.match(whatsapp.sent[1].text, /Gambar sedang diunggah dan diproses/i)
  assert.equal(whatsapp.media.length, 1)
  assert.equal(whatsapp.media[0].payload.kind, 'video')
  assert.match(whatsapp.media[0].payload.caption, /Status: Berhasil/i)
  assert.match(whatsapp.media[0].payload.caption, /Video dari gambar berhasil dibuat/i)
  assert.doesNotMatch(whatsapp.media[0].payload.caption, /\b(veo|gemini|google|flow)\b/i)
})
