import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { MessageGateRegistry } from '../dist/framework/message-gate.js'
import { createGroupContextPlugin } from '../dist/framework/plugins/group-context.js'

const logger = pino({ level: 'silent' })
const groupJid = '120363000000000000@g.us'
const memberJid = '628120000000@s.whatsapp.net'

function createHarness({ mode = 'ic', allowed = false, registered = [] } = {}) {
  const sent = []
  const commands = new Map(registered.map((name) => [name, { name, handler: async () => {} }]))
  const contextRecord = {
    groupKey: 'a'.repeat(64),
    mode,
    ...(mode === 'ic' ? { icSubtype: 'other' } : {}),
    oocPolicy: 'strict',
    revision: 1,
    enabled: true,
  }
  const service = {
    name: 'group-context',
    isEnabled: true,
    async get() { return contextRecord },
    async isOocAllowed() { return allowed },
    memberKeyForJid(value) { return `key:${value}` },
    async listAllowlist() { return [] },
    async set() { return contextRecord },
    async addAllowlist() {},
    async clearAllowlist() {},
    async removeAllowlist() {},
  }
  const context = {
    logger,
    config: {
      commandPrefix: '!',
      defaultCooldownMs: 0,
      groupContextOocCooldownMs: 30_000,
      groupContextOocWindowMs: 600_000,
      groupContextOocMaxPerWindow: 3,
    },
    services: {
      get(name) {
        if (name === 'group-context') return service
        throw new Error(`unexpected service ${name}`)
      },
      has(name) { return name === 'group-context' },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        for (const alias of definition.aliases ?? []) commands.set(alias, definition)
        return () => {}
      },
      get(name) { return commands.get(name) },
    },
    events: { on() { return () => {} } },
    messageGates: new MessageGateRegistry(),
  }
  const whatsapp = {
    userJid: 'bot@s.whatsapp.net',
    async sendText(remoteJid, text) { sent.push({ remoteJid, text }) },
    async getGroupMetadata() {
      return { jid: groupJid, subject: 'Test', participants: [{ jid: memberJid, role: 'member' }] }
    },
  }
  return { context, whatsapp, sent, commands, service }
}

function message(overrides = {}) {
  return {
    id: 'group-context-test',
    remoteJid: groupJid,
    senderJid: memberJid,
    timestamp: Date.now(),
    fromMe: false,
    ...overrides,
  }
}

async function loadHarness(options) {
  const harness = createHarness(options)
  await createGroupContextPlugin(harness.whatsapp).load(harness.context)
  return harness
}

test('strict IC gate allows registered commands and anchored narrative but cuts unknown/OOC text', async () => {
  const harness = await loadHarness({ registered: ['character'] })
  assert.equal((await harness.context.messageGates.evaluate(message({ text: '!character' }))).allowed, true)
  assert.equal((await harness.context.messageGates.evaluate(message({ text: '!not-a-command' }))).allowed, false)
  assert.equal((await harness.context.messageGates.evaluate(message({ text: '> *Aruna mengangkat pedang.*\n"Berhenti."' }))).allowed, true)
  assert.equal((await harness.context.messageGates.evaluate(message({ text: '(( izin off sebentar ))' }))).allowed, false)
  assert.equal(harness.sent.filter((item) => item.text === '*CUT OOC*').length, 1)
})

test('sticker and media are CUT OOC for normal users, while whitelist bypasses only the gate', async () => {
  const denied = await loadHarness({ allowed: false })
  assert.equal((await denied.context.messageGates.evaluate(message({ media: { kind: 'sticker' } }))).allowed, false)

  const allowed = await loadHarness({ allowed: true })
  assert.equal((await allowed.context.messageGates.evaluate(message({ text: 'percakapan OOC', media: { kind: 'image' } }))).allowed, true)
  assert.equal(allowed.sent.length, 0)
})

test('non-IC mode does not invoke CUT OOC classifier', async () => {
  const harness = await loadHarness({ mode: 'ooc' })
  assert.equal((await harness.context.messageGates.evaluate(message({ text: 'percakapan biasa' }))).allowed, true)
  assert.equal(harness.sent.length, 0)
})

test('valid !ooc is silent because the original WhatsApp message is already the OOC bubble', async () => {
  const harness = await loadHarness()
  const definition = harness.commands.get('ooc')
  const commandContext = {
    message: message({ text: '!ooc izin off sebentar', id: 'ooc-1' }),
    args: ['izin', 'off', 'sebentar'],
    commandName: 'ooc',
    prefix: '!',
    config: harness.context.config,
    logger,
    services: harness.context.services,
    whatsapp: harness.whatsapp,
    async reply(text) { harness.sent.push({ remoteJid: groupJid, text }) },
  }
  await definition.handler(commandContext)
  assert.deepEqual(harness.sent, [])
})
