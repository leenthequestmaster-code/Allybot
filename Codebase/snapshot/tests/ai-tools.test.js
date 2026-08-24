import assert from 'node:assert/strict'
import { test } from 'node:test'
import pino from 'pino'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { createAiPlugin } from '../dist/framework/plugins/ai.js'
import { createFakeWhatsapp } from './helpers/fake-whatsapp.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

function createHarness() {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const commands = new CommandRegistry(config, logger, whatsapp, { get() { throw new Error('service unavailable') } }, events)
  const prompts = []
  createAiPlugin({
    transport: async (request) => {
      prompts.push(request)
      return { content: 'hasil aman' }
    },
  }).load?.({ logger, config, events, commands, services: { get() { throw new Error('service unavailable') } } })
  return { commands, whatsapp, prompts }
}

function message(text, senderJid) {
  return { id: `ai-${senderJid}`, remoteJid: 'group@g.us', senderJid, text, timestamp: Date.now(), fromMe: false }
}

test('AI tools translate and summarize use bounded explicit input and Indonesian aliases', async () => {
  const harness = createHarness()

  await harness.commands.dispatch(message('!translate Inggris | Selamat datang', 'alice@s.whatsapp.net'))
  await harness.commands.dispatch(message('!ringkas Ini adalah teks yang perlu diringkas', 'bob@s.whatsapp.net'))

  assert.equal(harness.whatsapp.sent.length, 2)
  assert.match(harness.whatsapp.sent[0].text, /Terjemahan/) 
  assert.match(harness.whatsapp.sent[1].text, /Ringkasan/)
  assert.match(harness.prompts[0].userMessage, /bahasa Inggris/)
  assert.match(harness.prompts[0].userMessage, /Selamat datang/)
  assert.match(harness.prompts[1].userMessage, /Jangan menambahkan fakta baru/)
})

test('AI translate rejects missing separator without contacting provider', async () => {
  const harness = createHarness()

  await harness.commands.dispatch(message('!terjemah Inggris tanpa pemisah', 'alice@s.whatsapp.net'))

  assert.equal(harness.prompts.length, 0)
  assert.match(harness.whatsapp.sent[0].text, /Format: !translate <bahasa> \| <teks>/)
})

test('AI summarize rejects oversized explicit text before provider call', async () => {
  const harness = createHarness()

  await harness.commands.dispatch(message(`!summarize ${'x'.repeat(1_201)}`, 'alice@s.whatsapp.net'))

  assert.equal(harness.prompts.length, 0)
  assert.match(harness.whatsapp.sent[0].text, /Format: !summarize <teks>/)
})
