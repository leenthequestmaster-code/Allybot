import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { createAiPlugin } from '../dist/framework/plugins/ai.js'
import { mediaPlugin } from '../dist/framework/plugins/media.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

function createHarness() {
  const sent = []
  const prompts = []
  const whatsapp = {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    sent,
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text) { sent.push({ type: 'text', remoteJid, text }) },
    async sendImage(remoteJid, imageUrl, caption) { sent.push({ type: 'image', remoteJid, imageUrl, caption }) },
    async sendMedia(remoteJid, payload) { sent.push({ type: 'media', remoteJid, payload }) },
    async start() {},
    async close() {},
  }
  const events = new EventBus(logger)
  const commands = new CommandRegistry(config, logger, whatsapp, { get() { throw new Error('service unavailable') } }, events)

  createAiPlugin({
    transport: async (request) => {
      prompts.push(request)
      return { content: `AI response for: ${request.userMessage}` }
    },
  }).load?.({
    logger,
    config,
    events,
    commands,
    services: { get() { throw new Error('service unavailable') } },
  })

  mediaPlugin.load?.({
    logger,
    config,
    events,
    commands,
    services: { get() { throw new Error('service unavailable') } },
  })

  return { commands, whatsapp, sent, prompts }
}

function message(text, extra = {}) {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    remoteJid: 'group@g.us',
    senderJid: 'user@s.whatsapp.net',
    text,
    timestamp: Date.now(),
    fromMe: false,
    ...extra,
  }
}

test('Omni-AI handles empty prompt with usage guide', async () => {
  const harness = createHarness()
  await harness.commands.dispatch(message('!ai'))
  assert.match(harness.sent.at(-1)?.text ?? '', /Format: !ai <pertanyaan atau instruksi>/)
})

test('Omni-AI dispatches plain text prompt to AI handler', async () => {
  const harness = createHarness()
  await harness.commands.dispatch(message('!ai siapa penemu lampu?'))
  assert.equal(harness.prompts.length, 1)
  assert.equal(harness.prompts[0].userMessage, 'siapa penemu lampu?')
  assert.match(harness.sent.at(-1)?.text ?? '', /Allybot AI/)
})

test('Omni-AI merges quotedText into context when user provides instructions', async () => {
  const harness = createHarness()
  await harness.commands.dispatch(message('!ai terjemahkan ini ke jepang', {
    quotedText: 'Selamat pagi semua',
  }))
  assert.equal(harness.prompts.length, 1)
  assert.match(harness.prompts[0].userMessage, /Rujukan pesan yang dibalas:\s*"Selamat pagi semua"/)
  assert.match(harness.prompts[0].userMessage, /Instruksi pengguna:\s*terjemahkan ini ke jepang/)
})

test('Omni-AI summarizes quotedText when user calls !ai without additional args', async () => {
  const harness = createHarness()
  await harness.commands.dispatch(message('!ai', {
    quotedText: 'Pesan panjang ini perlu diringkas segera.',
  }))
  assert.equal(harness.prompts.length, 1)
  assert.match(harness.prompts[0].userMessage, /Ringkas dan jelaskan inti dari pesan berikut/)
  assert.match(harness.prompts[0].userMessage, /Pesan panjang ini perlu diringkas segera\./)
})

test('OCR command requires image attachment', async () => {
  const harness = createHarness()
  await harness.commands.dispatch(message('!ocr'))
  assert.match(harness.sent.at(-1)?.text ?? '', /Balas gambar lalu ketik !ocr/i)
})

test('In-process QR code command produces image media without network', async () => {
  const harness = createHarness()
  await harness.commands.dispatch(message('!qr https://allyssea.com'))
  const lastSent = harness.sent.at(-1)
  assert.equal(lastSent?.type, 'media')
  assert.equal(lastSent?.payload?.kind, 'image')
  assert.equal(lastSent?.payload?.mimeType, 'image/png')
  assert.ok(lastSent?.payload?.data?.length > 100)
})
