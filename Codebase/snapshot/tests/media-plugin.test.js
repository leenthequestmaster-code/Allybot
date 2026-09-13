import assert from 'node:assert/strict'
import { test } from 'node:test'
import pino from 'pino'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { createMediaPlugin } from '../dist/framework/plugins/media.js'
import { FfmpegMediaTransformer, MediaTransformError } from '../dist/media.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

function createHarness({ media = {}, transformer } = {}) {
  const sent = []
  const downloads = []
  const whatsapp = {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    sent,
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text) { sent.push({ type: 'text', remoteJid, text }) },
    async downloadMedia(message, source, limits) {
      downloads.push({ message, source, limits })
      return media
    },
    async sendMedia(remoteJid, payload) { sent.push({ type: 'media', remoteJid, payload }) },
    async start() {},
    async close() {},
  }
  const events = new EventBus(logger)
  const commands = new CommandRegistry(config, logger, whatsapp, { get() { throw new Error('service unavailable') } }, events)
  createMediaPlugin({ transformer: transformer ?? { async transform() { return new Uint8Array([1, 2, 3]) } } }).load?.({
    logger,
    config,
    events,
    commands,
    services: { get() { throw new Error('service unavailable') } },
  })
  return { commands, whatsapp, sent, downloads }
}

function message(text, senderJid, extra = {}) {
  return {
    id: `media-${senderJid}`,
    remoteJid: 'group@g.us',
    senderJid,
    text,
    timestamp: Date.now(),
    fromMe: false,
    ...extra,
  }
}

test('sticker transforms a direct image and sends server-selected WebP payload', async () => {
  const harness = createHarness({ media: { kind: 'image', mimeType: 'image/jpeg', data: new Uint8Array([9]) } })

  await harness.commands.dispatch(message('!sticker', 'alice@s.whatsapp.net', {
    media: { kind: 'image', mimeType: 'image/jpeg', sizeBytes: 100 },
  }))

  assert.equal(harness.downloads[0].source, 'direct')
  assert.equal(harness.downloads[0].limits.maxBytes, 3 * 1024 * 1024)
  assert.equal(harness.sent[0].type, 'media')
  assert.equal(harness.sent[0].payload.kind, 'sticker')
  assert.equal(harness.sent[0].payload.mimeType, 'image/webp')
})

test('toimg transforms quoted WebP sticker and sends PNG image payload', async () => {
  const harness = createHarness({ media: { kind: 'sticker', mimeType: 'image/webp', data: new Uint8Array([9]) } })

  await harness.commands.dispatch(message('!toimg', 'bob@s.whatsapp.net', {
    quotedMedia: { kind: 'sticker', mimeType: 'image/webp', quoted: true, sizeBytes: 100 },
  }))

  assert.equal(harness.downloads[0].source, 'quoted')
  assert.equal(harness.sent[0].payload.kind, 'image')
  assert.equal(harness.sent[0].payload.mimeType, 'image/png')
})

test('togif converts a short video to looping MP4 playback', async () => {
  const harness = createHarness({ media: { kind: 'video', mimeType: 'video/mp4', data: new Uint8Array([9]) } })

  await harness.commands.dispatch(message('!togif', 'gif-user@s.whatsapp.net', {
    media: { kind: 'video', mimeType: 'video/mp4', sizeBytes: 100, durationSeconds: 10 },
  }))

  assert.equal(harness.downloads[0].source, 'direct')
  assert.equal(harness.sent[0].payload.kind, 'video')
  assert.equal(harness.sent[0].payload.mimeType, 'video/mp4')
  assert.equal(harness.sent[0].payload.gifPlayback, true)
})

test('toaudio converts quoted video to bounded OGG audio', async () => {
  const harness = createHarness({ media: { kind: 'video', mimeType: 'video/mp4', data: new Uint8Array([9]) } })

  await harness.commands.dispatch(message('!audio', 'audio-user@s.whatsapp.net', {
    quotedMedia: { kind: 'video', mimeType: 'video/mp4', quoted: true, sizeBytes: 100, durationSeconds: 20 },
  }))

  assert.equal(harness.downloads[0].source, 'quoted')
  assert.equal(harness.sent[0].payload.kind, 'audio')
  assert.equal(harness.sent[0].payload.mimeType, 'audio/ogg; codecs=opus')
})

test('media command rejects an overlong GIF before downloading', async () => {
  const harness = createHarness({ media: { kind: 'video', mimeType: 'video/mp4', data: new Uint8Array([9]) } })

  await harness.commands.dispatch(message('!togif', 'long-gif@s.whatsapp.net', {
    media: { kind: 'video', mimeType: 'video/mp4', sizeBytes: 100, durationSeconds: 16 },
  }))

  assert.equal(harness.downloads.length, 0)
  assert.match(harness.sent[0].text, /maksimal 15 detik/)
})

test('FfmpegMediaTransformer selects fixed targets and rejects unsupported conversions', async () => {
  const calls = []
  const transformer = new FfmpegMediaTransformer(async (args, input, maxOutputBytes, timeoutMs) => {
    calls.push({ args, input, maxOutputBytes, timeoutMs })
    return new Uint8Array([1])
  })

  await transformer.transform(new Uint8Array([1]), 'video/mp4', 'video', 'gif')
  await transformer.transform(new Uint8Array([1]), 'audio/ogg', 'audio', 'audio')
  await assert.rejects(() => transformer.transform(new Uint8Array([1]), 'image/jpeg', 'image', 'audio'), /not supported/)

  assert.equal(calls.length, 2)
  assert.ok(calls[0].args.includes('gifPlayback') === false)
  assert.ok(calls[0].args.includes('libx264'))
  assert.ok(calls[1].args.includes('libopus'))
  assert.equal(calls[0].maxOutputBytes, 2 * 1024 * 1024)
  assert.equal(calls[0].timeoutMs, 15_000)
})

test('media command rejects oversized descriptor before downloading', async () => {
  const harness = createHarness({ media: { kind: 'image', mimeType: 'image/jpeg', data: new Uint8Array([9]) } })

  await harness.commands.dispatch(message('!sticker', 'alice@s.whatsapp.net', {
    media: { kind: 'image', mimeType: 'image/jpeg', sizeBytes: 3 * 1024 * 1024 + 1 },
  }))

  assert.equal(harness.downloads.length, 0)
  assert.match(harness.sent[0].text, /File terlalu besar/)
})

test('media command fails closed when optional media capabilities are absent', async () => {
  const harness = createHarness({ media: undefined })
  delete harness.whatsapp.downloadMedia
  delete harness.whatsapp.sendMedia

  await harness.commands.dispatch(message('!sticker', 'alice@s.whatsapp.net', {
    media: { kind: 'image', mimeType: 'image/jpeg', sizeBytes: 100 },
  }))

  assert.match(harness.sent[0].text, /belum tersedia/)
})

test('media command does not send when transformer exceeds output cap', async () => {
  const harness = createHarness({
    media: { kind: 'image', mimeType: 'image/jpeg', data: new Uint8Array([9]) },
    transformer: { async transform() { return new Uint8Array(512 * 1024 + 1) } },
  })

  await harness.commands.dispatch(message('!stiker', 'alice@s.whatsapp.net', {
    media: { kind: 'image', mimeType: 'image/jpeg', sizeBytes: 100 },
  }))

  assert.equal(harness.sent.filter((item) => item.type === 'media').length, 0)
  assert.match(harness.sent[0].text, /terlalu besar atau kosong/)
})

test('media transform errors are converted to safe user-facing output', async () => {
  const harness = createHarness({
    media: { kind: 'image', mimeType: 'image/jpeg', data: new Uint8Array([9]) },
    transformer: { async transform() { throw new MediaTransformError('timeout', 'internal detail') } },
  })

  await harness.commands.dispatch(message('!sticker', 'alice@s.whatsapp.net', {
    media: { kind: 'image', mimeType: 'image/jpeg', sizeBytes: 100 },
  }))

  assert.match(harness.sent[0].text, /terlalu lama/)
  assert.equal(harness.sent[0].text.includes('internal detail'), false)
})
