import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { toolsSearchPlugin } from '../dist/framework/plugins/tools-search.js'
import { createAiPlugin } from '../dist/framework/plugins/ai.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

function createHarness() {
  const sent = []
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

  toolsSearchPlugin.load?.({
    logger,
    config,
    events,
    commands,
    services: { get() { throw new Error('service unavailable') } },
  })

  createAiPlugin({
    transport: async (request) => ({ content: `AI response for: ${request.userMessage}` }),
  }).load?.({
    logger,
    config,
    events,
    commands,
    services: { get() { throw new Error('service unavailable') } },
  })

  return { commands, whatsapp, sent }
}

function message(text, senderJid = 'user@s.whatsapp.net', extra = {}) {
  return {
    id: `msg-${Date.now()}`,
    remoteJid: 'group@g.us',
    senderJid,
    text,
    timestamp: Date.now(),
    fromMe: false,
    ...extra,
  }
}

test('Search Tools: google, image, lirik, wiki, and cuaca commands', async () => {
  const harness = createHarness()

  // 1. Google usage
  await harness.commands.dispatch(message('!google'))
  assert.match(harness.sent.at(-1)?.text ?? '', /Format: !google/)

  // 2. Image usage
  await harness.commands.dispatch(message('!image'))
  assert.match(harness.sent.at(-1)?.text ?? '', /Format: !image/)

  // 3. Lyrics usage
  await harness.commands.dispatch(message('!lirik'))
  assert.match(harness.sent.at(-1)?.text ?? '', /Format: !lirik/)

  // 4. Wikipedia usage
  await harness.commands.dispatch(message('!wiki'))
  assert.match(harness.sent.at(-1)?.text ?? '', /Format: !wiki/)

  // 5. Cuaca usage
  await harness.commands.dispatch(message('!cuaca'))
  assert.match(harness.sent.at(-1)?.text ?? '', /Format: !cuaca/)
})

test('AI Tools: tts, text2img, and img2text commands', async () => {
  const harness = createHarness()

  // 1. TTS usage
  await harness.commands.dispatch(message('!tts'))
  assert.match(harness.sent.at(-1)?.text ?? '', /Format: !tts/)

  // 2. text2img usage
  await harness.commands.dispatch(message('!text2img'))
  assert.match(harness.sent.at(-1)?.text ?? '', /Format: !text2img/)

  // 3. img2text requires media
  await harness.commands.dispatch(message('!img2text'))
  assert.match(harness.sent.at(-1)?.text ?? '', /Balas gambar lalu ketik/)
})
