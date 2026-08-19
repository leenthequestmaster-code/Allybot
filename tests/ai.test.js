import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { createAiPlugin } from '../dist/framework/plugins/ai.js'
import { loadConfig } from '../dist/config.js'

function registeredCommand(chatGroq) {
  const commands = []
  createAiPlugin(chatGroq).load({
    commands: { register(command) { commands.push(command); return () => {} } },
  })
  return { command: commands.find((command) => command.name === 'ask'), commands }
}

function context({ args = [], enabled = true, prefix = '!', logs = [], replies = [] } = {}) {
  return {
    args,
    prefix,
    config: { aiCommandsEnabled: enabled },
    message: { remoteJid: 'chat@s.whatsapp.net', senderJid: 'sender@s.whatsapp.net' },
    logger: { warn(payload, message) { logs.push({ payload, message }) } },
    reply: async (text) => { replies.push(text) },
  }
}

test('AI command feature flag defaults off and parses explicit enablement', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test' }).AI_COMMANDS_ENABLED, false)
  assert.equal(loadConfig({ NODE_ENV: 'test', AI_COMMANDS_ENABLED: 'true' }).AI_COMMANDS_ENABLED, true)
})

test('AI command registers ask with ai alias and forwards a bounded prompt', async () => {
  const calls = []
  const { command } = registeredCommand(async (prompt, options) => {
    calls.push({ prompt, options })
    return 'Jawaban singkat.'
  })
  const replies = []
  await command.handler(context({ args: ['apa', 'kabar?'], replies }))

  assert.deepEqual(command.aliases, ['ai'])
  assert.deepEqual(calls, [{ prompt: 'apa kabar?', options: { timeoutMs: 15_000 } }])
  assert.match(replies[0], /^🤖 \*Allybot AI\*\n\nJawaban singkat\.$/)
})

test('AI command keeps the canonical command name for alias cooldown identity', () => {
  const { command } = registeredCommand(async () => 'ok')
  assert.equal(command.name, 'ask')
  assert.deepEqual(command.aliases, ['ai'])
})

test('AI command is fail-closed when the feature flag is absent or disabled', async () => {
  let calls = 0
  const { command } = registeredCommand(async () => { calls += 1; return 'unexpected' })
  const replies = []
  await command.handler(context({ enabled: false, args: ['hello'], replies }))

  assert.equal(calls, 0)
  assert.match(replies[0], /belum diaktifkan/)
})

test('AI command returns usage for an empty prompt without calling provider', async () => {
  let calls = 0
  const { command } = registeredCommand(async () => { calls += 1; return 'unexpected' })
  const replies = []
  await command.handler(context({ args: ['   '], replies }))

  assert.equal(calls, 0)
  assert.match(replies[0], /Cara menggunakan Allybot AI/)
  assert.match(replies[0], /!ask pertanyaan kamu/)
})

test('AI command rejects prompts over the configured character bound', async () => {
  let calls = 0
  const { command } = registeredCommand(async () => { calls += 1; return 'unexpected' })
  const replies = []
  await command.handler(context({ args: ['x'.repeat(1_201)], replies }))

  assert.equal(calls, 0)
  assert.match(replies[0], /maksimal 1200 karakter/)
})

test('AI command uses a custom command prefix in usage text', async () => {
  const { command } = registeredCommand(async () => 'unexpected')
  const replies = []
  await command.handler(context({ args: [], prefix: '.', replies }))

  assert.match(replies[0], /\.ask pertanyaan kamu/)
  assert.match(replies[0], /\.ai pertanyaan kamu/)
})

test('AI command returns a safe fallback and redacted log on provider failure', async () => {
  const logs = []
  const replies = []
  const { command } = registeredCommand(async () => {
    throw new Error('provider failed with token=secret-value')
  })
  await command.handler(context({ args: ['test', 'prompt'], logs, replies }))

  assert.match(replies[0], /sedang tidak tersedia/)
  assert.equal(replies[0].includes('secret-value'), false)
  assert.equal(JSON.stringify(logs).includes('secret-value'), false)
  assert.deepEqual(logs[0].payload, { errorName: 'Error', promptLength: 11 })
})

test('AI command bounds an unexpectedly long provider response before replying', async () => {
  const replies = []
  const { command } = registeredCommand(async () => 'a'.repeat(3_000))
  await command.handler(context({ args: ['hello'], replies }))

  assert.equal(replies[0].length, 2_000 + '🤖 *Allybot AI*\n\n'.length)
  assert.equal(replies[0].endsWith('…'), true)
})

test('AI command handles an empty provider response without exposing provider details', async () => {
  const logs = []
  const replies = []
  const { command } = registeredCommand(async () => '')
  await command.handler(context({ args: ['hello'], logs, replies }))

  assert.match(replies[0], /tidak menghasilkan jawaban/)
  assert.equal(logs.length, 0)
})

test('AI command normalizes whitespace before sending the prompt', async () => {
  let prompt
  const { command } = registeredCommand(async (value) => { prompt = value; return 'ok' })
  await command.handler(context({ args: ['  halo', 'dunia  '] }))

  assert.equal(prompt, 'halo dunia')
})

class FakeCore {
  isConnected = false
  sent = []
  messageListeners = new Set()
  connectionListeners = new Set()
  onMessage(listener) { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener) }
  onGroupParticipantUpdate() { return () => {} }
  onConnectionState(listener) { this.connectionListeners.add(listener); return () => this.connectionListeners.delete(listener) }
  async sendText(remoteJid, text) { this.sent.push({ remoteJid, text }) }
  async start() {
    this.isConnected = true
    await Promise.all([...this.connectionListeners].map((listener) => listener({ status: 'connected', at: Date.now() })))
  }
  async close() { this.isConnected = false }
  async emitMessage(message) {
    await Promise.all([...this.messageListeners].map((listener) => listener(message)))
  }
}

test('AI alias is dispatched through the framework command registry', async () => {
  const { ApplicationFramework } = await import('../dist/framework/application.js')
  const core = new FakeCore()
  const app = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, aiCommandsEnabled: true },
    pino({ level: 'silent' }),
    core,
  )
  app.registerPlugin(createAiPlugin(async () => 'alias works'))
  await app.start()
  await core.emitMessage({
    id: 'ai-alias',
    remoteJid: 'chat@s.whatsapp.net',
    senderJid: 'sender@s.whatsapp.net',
    text: '!ai test',
    timestamp: Date.now(),
    fromMe: false,
  })

  assert.match(core.sent[0].text, /alias works/)
  await app.stop()
})
