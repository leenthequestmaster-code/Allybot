import assert from 'node:assert/strict'
import pino from 'pino'
import { test } from 'node:test'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createAiPlugin } from '../dist/framework/plugins/ai.js'
import {
  AiHandlerError,
  FALLBACK_MODEL,
  MAX_AI_INPUT_LENGTH,
  MAX_AI_OUTPUT_LENGTH,
  PRIMARY_MODEL,
  createAiHandler,
} from '../dist/ai-handler.js'
import { loadConfig } from '../dist/config.js'

const logger = pino({ level: 'silent' })

class FakeCore {
  isConnected = false
  userJid = 'bot@s.whatsapp.net'
  sent = []
  messages = new Set()
  groupParticipantListeners = new Set()
  connections = new Set()

  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener) }
  onGroupParticipantUpdate(listener) { this.groupParticipantListeners.add(listener); return () => this.groupParticipantListeners.delete(listener) }
  onConnectionState(listener) { this.connections.add(listener); return () => this.connections.delete(listener) }
  async sendText(remoteJid, text) { this.sent.push({ remoteJid, text }) }
  async start() {
    this.isConnected = true
    await Promise.all([...this.connections].map((listener) => listener({ status: 'connected', at: Date.now() })))
  }
  async close() {
    this.isConnected = false
    await Promise.all([...this.connections].map((listener) => listener({ status: 'idle', at: Date.now() })))
  }
  async emitMessage(message) {
    await Promise.all([...this.messages].map((listener) => listener(message)))
  }
}

function request(model, userMessage) {
  return { model, userMessage }
}

test('XKIRO handler uses the primary model first and returns bounded content', async () => {
  const calls = []
  const handler = createAiHandler({
    apiKey: 'test-only',
    transport: async (input) => {
      calls.push(input)
      return { content: 'jawaban primary' }
    },
  })

  assert.equal(await handler('  halo   Allybot  '), 'jawaban primary')
  assert.deepEqual(calls, [request(PRIMARY_MODEL, 'halo Allybot')])
})

test('XKIRO handler switches to fallback after primary failure', async () => {
  const calls = []
  const handler = createAiHandler({
    apiKey: 'test-only',
    transport: async (input) => {
      calls.push(input)
      if (input.model === PRIMARY_MODEL) throw Object.assign(new Error('provider secret must not be logged'), { status: 429 })
      return { content: 'jawaban fallback' }
    },
  })

  assert.equal(await handler('coba fallback'), 'jawaban fallback')
  assert.deepEqual(calls, [request(PRIMARY_MODEL, 'coba fallback'), request(FALLBACK_MODEL, 'coba fallback')])
})

test('XKIRO handler fails safely after both models fail and redacts raw error', async () => {
  const logs = []
  const secretError = 'provider-secret-not-for-logs'
  const handler = createAiHandler({
    apiKey: 'test-only',
    logger: { warn(metadata, message) { logs.push({ metadata, message }) } },
    transport: async () => { throw new Error(secretError) },
  })

  await assert.rejects(handler('double failure'), (error) => {
    assert.equal(error instanceof AiHandlerError, true)
    assert.equal(error.code, 'provider_unavailable')
    return true
  })
  assert.equal(JSON.stringify(logs).includes(secretError), false)
  assert.deepEqual(logs.map((entry) => entry.metadata.attempt), ['primary', 'fallback'])
})

test('XKIRO handler fails closed for missing key and invalid input', async () => {
  const missingKeyHandler = createAiHandler({ apiKey: '   ' })
  await assert.rejects(missingKeyHandler('halo'), (error) => error.code === 'missing_api_key')

  const handler = createAiHandler({ transport: async () => ({ content: 'unused' }) })
  await assert.rejects(handler('   '), (error) => error.code === 'invalid_input')
  await assert.rejects(handler('x'.repeat(MAX_AI_INPUT_LENGTH + 1)), (error) => error.code === 'invalid_input')
})

test('XKIRO handler bounds provider output', async () => {
  const handler = createAiHandler({ transport: async () => ({ content: 'x'.repeat(MAX_AI_OUTPUT_LENGTH + 100) }) })
  const output = await handler('bounded output')
  assert.equal(output.length, MAX_AI_OUTPUT_LENGTH)
  assert.equal(output.endsWith('…'), true)
})

test('XKIRO config is default-off and can be explicitly enabled', () => {
  assert.equal(loadConfig({}).XKIRO_AI_ENABLED, false)
  assert.equal(loadConfig({ XKIRO_AI_ENABLED: 'true' }).XKIRO_AI_ENABLED, true)
})

test('AI plugin dispatches !ai and !ally through the ApplicationFramework', async () => {
  const core = new FakeCore()
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0 }, logger, core)
  const calls = []
  app.registerPlugin(createAiPlugin({
    transport: async (input) => {
      calls.push(input)
      return { content: 'jawaban untuk WhatsApp' }
    },
  }))
  await app.start()

  await core.emitMessage({ id: 'ai', remoteJid: 'chat@s.whatsapp.net', senderJid: 'user@s.whatsapp.net', text: '!ai apa kabar?', timestamp: Date.now(), fromMe: false })
  assert.match(core.sent[0].text, /Allybot AI/)
  assert.match(core.sent[0].text, /jawaban untuk WhatsApp/)
  assert.equal(calls[0].model, PRIMARY_MODEL)

  await app.stop()

  const dotCore = new FakeCore()
  const dotApp = new ApplicationFramework({ commandPrefix: '.', defaultCooldownMs: 0 }, logger, dotCore)
  dotApp.registerPlugin(createAiPlugin({
    transport: async () => ({ content: 'jawaban prefix titik' }),
  }))
  await dotApp.start()
  await dotCore.emitMessage({ id: 'ally', remoteJid: 'chat@s.whatsapp.net', senderJid: 'user@s.whatsapp.net', text: '.ally halo', timestamp: Date.now(), fromMe: false })
  assert.match(dotCore.sent[0].text, /jawaban prefix titik/)
  await dotApp.stop()
})
