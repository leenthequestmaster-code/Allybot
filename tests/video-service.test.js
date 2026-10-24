import assert from 'node:assert/strict'
import test from 'node:test'
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
  const result = await provider.generate({ prompt: 'cinematic sunset on beach' })

  assert.equal(provider.name, 'mock')
  assert.equal(result.mimeType, 'video/mp4')
  assert.equal(result.durationSeconds, 8)
  assert.ok(result.buffer.length > 0)
  assert.equal(result.fileName, 'mock-video.mp4')
})

test('2. VideoService enforces FIFO queueing and commits usage', async () => {
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
  assert.match(quota.reason ?? '', /cooldown/i)
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
  assert.match(q2.reason ?? '', /batas harian/i)
})

test('4. VideoPlugin registers commands !vid, !vidstatus, and !vidmodels', async () => {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const whatsapp = fakeWhatsapp()
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  const videoService = new VideoService({ provider: new MockVideoProvider() })
  services.register(videoService)

  const plugin = createVideoPlugin(whatsapp, { videoService })
  plugin.load?.({ logger, config, events, commands: registry, services })

  assert.ok(registry.get('vid'))
  assert.ok(registry.get('vidstatus'))
  assert.ok(registry.get('vidmodels'))
})

test('5. !vid rejects empty or too short prompt with helpful instructions', async () => {
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
  assert.match(whatsapp.sent[0].text, /Chlona Video Studio/i)
  assert.match(whatsapp.sent[0].text, /Format:/i)
})

test('6. !vidstatus and !vidmodels deliver accurate status and catalog details', async () => {
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
  assert.match(whatsapp.sent[0].text, /Status Chlona Video Studio/i)
  assert.match(whatsapp.sent[0].text, /8 video hari ini/i)

  await registry.dispatch(message('m-3', 'user@s.whatsapp.net', '!vidmodels'))
  assert.equal(whatsapp.sent.length, 2)
  assert.match(whatsapp.sent[1].text, /Katalog Model Google Flow Studio/i)
  assert.match(whatsapp.sent[1].text, /Veo 3\.1 - Lite/i)
})

test('7. End-to-end !vid dispatch renders and delivers video media payload', async () => {
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
      '!vid seekor naga es terbang di atas puncak gunung bersalju',
    ),
  )

  // 1 immediate acknowledgement message sent
  assert.equal(whatsapp.sent.length, 1)
  assert.match(whatsapp.sent[0].text, /Permintaan videomu sudah masuk antrean/i)

  // Media delivered
  assert.equal(whatsapp.media.length, 1)
  assert.equal(whatsapp.media[0].payload.kind, 'video')
  assert.equal(whatsapp.media[0].payload.mimeType, 'video/mp4')
  assert.match(whatsapp.media[0].payload.caption, /Google Veo 3\.1/i)
})
