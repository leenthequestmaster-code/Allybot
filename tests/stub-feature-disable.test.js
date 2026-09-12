import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { ServiceRegistry } from '../dist/framework/service-registry.js'
import { MessageGateRegistry } from '../dist/framework/message-gate.js'
import { menuPlugin } from '../dist/framework/plugins/menu.js'
import { EconomyService } from '../dist/services/economy-service.js'
import { economyPlugin } from '../dist/framework/plugins/economy.js'
import { GroupContextService } from '../dist/services/group-context-service.js'
import { createGroupContextPlugin } from '../dist/framework/plugins/group-context.js'
import { CharacterGuideService } from '../dist/services/character-guide-service.js'
import { createCharacterGuidePlugin } from '../dist/framework/plugins/character-guide.js'

// Behavioral contract for the three backend-stub features (economy, group-context,
// character-guide): with no RPC backend wired, commands must refuse with one clear
// Indonesian message instead of crashing or silently doing nothing, the refusal
// surface must stay hidden from every menu/index, and with the feature flag false
// the plugins must not react at all.

const logger = pino({ level: 'silent' })
const groupJid = '120363000000000099@g.us'
const memberJid = '628120000098@s.whatsapp.net'
const botJid = '628990000000@s.whatsapp.net'

const REFUSAL = {
  economy: 'Fitur ekonomi belum tersedia — backend sedang disiapkan.',
  groupContext: 'Fitur konteks grup belum tersedia — backend sedang disiapkan.',
  characterGuide: 'Fitur Character Guide belum tersedia — backend sedang disiapkan.',
}

function whatsappStub() {
  const sent = []
  return {
    userJid: botJid,
    sent,
    async sendText(remoteJid, text, options) { sent.push({ remoteJid, text, options }) },
    async sendNativeQuickReplies() {},
    async getGroupMetadata() { return { jid: groupJid, subject: 'Refusal', participants: [] } },
  }
}

function emptyServices() {
  return { has: () => false, get: () => { throw new Error('no service expected') } }
}

function stubEconomyService() {
  // Flag on, backend stub: src/index.ts constructs exactly this shape (no createClient).
  const service = new EconomyService(logger, { env: { ECONOMY_ENABLED: 'true' } })
  service.initialize({ logger, config: {}, services: emptyServices() })
  return service
}

function stubGroupContextService() {
  const service = new GroupContextService(logger, { env: { GROUP_CONTEXT_ENABLED: 'true' } })
  service.initialize({ logger, config: {}, services: emptyServices() })
  return service
}

function stubCharacterGuideService() {
  const service = new CharacterGuideService(logger, { env: { CHARACTER_GUIDE_ENABLED: 'true' } })
  service.initialize({ logger, config: {}, services: emptyServices() })
  return service
}

function loadPlugin(plugin, services, whatsapp, config = {}) {
  const commands = new Map()
  const register = (definition) => {
    commands.set(definition.name, definition)
    for (const alias of definition.aliases ?? []) commands.set(alias, definition)
    return () => {}
  }
  const events = new EventBus(logger)
  const messageGates = new MessageGateRegistry()
  const context = {
    logger,
    config: { commandPrefix: '!', defaultCooldownMs: 0, ...config },
    services: {
      has: (name) => name in services,
      get: (name) => {
        if (name in services) return services[name]
        throw new Error(`unexpected service: ${name}`)
      },
    },
    commands: { register, get: (name) => commands.get(name) },
    events,
    messageGates,
  }
  plugin.load(context)
  return { commands, events, messageGates, whatsapp }
}

// Runs a registered command handler directly. `services.get` throws: a refusal
// handler that accidentally touched its (empty) backend would fail loudly here.
async function runCommand(command, args = []) {
  const replies = []
  const commandContext = {
    message: { id: 'refusal-message', remoteJid: groupJid, senderJid: memberJid, text: 'irrelevant', timestamp: Date.now(), fromMe: false },
    args,
    commandName: command.name,
    prefix: '!',
    config: { commandPrefix: '!' },
    logger,
    services: emptyServices(),
    whatsapp: whatsappStub(),
    reply: async (text) => { replies.push(text) },
  }
  await command.handler(commandContext)
  return replies
}

function assertAllHidden(commands) {
  const unique = [...new Set(commands.values())]
  assert.ok(unique.length > 0)
  assert.ok(unique.every((command) => command.hidden === true), 'refusal commands must be hidden from menus')
}

test('stub services report backendConfigured explicitly and never guess from errors', () => {
  const economyStub = stubEconomyService()
  assert.equal(economyStub.isEnabled, true)
  assert.equal(economyStub.hasBackend, false)
  const economyLive = new EconomyService(logger, {
    env: { ECONOMY_ENABLED: 'true' },
    createClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
  })
  economyLive.initialize({ logger, config: {}, services: emptyServices() })
  assert.equal(economyLive.hasBackend, true)

  const groupContextStub = stubGroupContextService()
  assert.equal(groupContextStub.isEnabled, true)
  assert.equal(groupContextStub.hasBackend, false)
  const groupContextLive = new GroupContextService(logger, {
    env: { GROUP_CONTEXT_ENABLED: 'true' },
    createClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
  })
  groupContextLive.initialize({ logger, config: {}, services: emptyServices() })
  assert.equal(groupContextLive.hasBackend, true)

  const characterStub = stubCharacterGuideService()
  assert.equal(characterStub.isEnabled, true)
  assert.equal(characterStub.hasBackend, false)
  const characterLive = new CharacterGuideService(logger, {
    env: { CHARACTER_GUIDE_ENABLED: 'true' },
    createClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
  })
  characterLive.initialize({ logger, config: {}, services: emptyServices() })
  assert.equal(characterLive.hasBackend, true)
})

test('economy commands refuse with one clear Indonesian message while the backend stub is empty', async () => {
  const { commands } = loadPlugin(economyPlugin, { economy: stubEconomyService() }, whatsappStub())
  for (const name of ['vela', 'wallet', 'bank', 'bankpolicy', 'economypolicy', 'bankreward', 'banksweep', 'tax', 'taxbayar', 'bayarpajak']) {
    assert.ok(commands.get(name), `missing refusal surface for ${name}`)
  }
  assertAllHidden(commands)

  for (const name of ['vela', 'wallet', 'bank', 'bankpolicy', 'bankreward', 'banksweep', 'tax', 'taxbayar', 'bayarpajak']) {
    const replies = await runCommand(commands.get(name), ['setor', '1000'])
    assert.deepEqual(replies, [REFUSAL.economy], `${name} must refuse exactly once with the pending text`)
  }
})

test('economy plugin registers nothing at all when the flag is false', () => {
  const disabled = new EconomyService(logger, { env: { ECONOMY_ENABLED: 'false' } })
  disabled.initialize({ logger, config: {}, services: emptyServices() })
  const { commands } = loadPlugin(economyPlugin, { economy: disabled }, whatsappStub())
  assert.equal(commands.size, 0)
})

test('group context commands refuse with one clear Indonesian message while the backend stub is empty', async () => {
  const { commands, messageGates } = loadPlugin(
    createGroupContextPlugin(whatsappStub()),
    { 'group-context': stubGroupContextService() },
    whatsappStub(),
  )
  for (const name of ['setgroup', 'groupmode', 'ooc', 'whitelistooc', 'oocwhitelist']) {
    assert.ok(commands.get(name), `missing refusal surface for ${name}`)
  }
  assertAllHidden(commands)

  // The IC/OOC gate must not be registered against a stub that can only ever
  // report mode 'normal' — it would be dead weight on every message.
  assert.deepEqual(messageGates.list(), [])

  for (const name of ['setgroup', 'groupmode', 'ooc', 'whitelistooc', 'oocwhitelist']) {
    const replies = await runCommand(commands.get(name), ['guide'])
    assert.deepEqual(replies, [REFUSAL.groupContext], `${name} must refuse exactly once with the pending text`)
  }
})

test('group context plugin registers nothing at all when the flag is false', () => {
  const disabled = new GroupContextService(logger, { env: { GROUP_CONTEXT_ENABLED: 'false' } })
  disabled.initialize({ logger, config: {}, services: emptyServices() })
  const { commands, messageGates } = loadPlugin(createGroupContextPlugin(whatsappStub()), { 'group-context': disabled }, whatsappStub())
  assert.equal(commands.size, 0)
  assert.deepEqual(messageGates.list(), [])
})

test('character guide commands refuse with one clear Indonesian message while the backend stub is empty', async () => {
  const whatsapp = whatsappStub()
  const { commands, events } = loadPlugin(
    createCharacterGuidePlugin(whatsapp),
    { 'character-guide': stubCharacterGuideService(), 'group-context': stubGroupContextService() },
    whatsapp,
  )
  for (const name of [
    'daftar', 'registercharacter', 'createcharacter',
    'savecharacter', 'savechar',
    'retry', 'retrycharacter',
    'cancel', 'cancelcharacter',
    'character', 'char', 'yourcharacter',
    'deletecharacter', 'deletechar', 'offcharacter',
    'timerp', 'rpwaktu',
    'guider',
  ]) {
    assert.ok(commands.get(name), `missing refusal surface for ${name}`)
  }
  assertAllHidden(commands)

  for (const name of ['daftar', 'savecharacter', 'retry', 'cancel', 'character', 'deletecharacter', 'timerp', 'guider']) {
    const replies = await runCommand(commands.get(name))
    assert.deepEqual(replies, [REFUSAL.characterGuide], `${name} must refuse exactly once with the pending text`)
  }

  // Onboarding listeners must not be registered in refusal mode: emitting the
  // events that would normally trigger card flows must leave WhatsApp untouched.
  await events.emit('message.received', { id: 'choice', remoteJid: groupJid, senderJid: memberJid, text: '1', timestamp: Date.now(), fromMe: false })
  await events.emit('group.participants.changed', { groupJid, action: 'add', participantJids: [memberJid], at: Date.now() })
  assert.deepEqual(whatsapp.sent, [])
})

test('character guide plugin registers nothing at all when the flag is false', () => {
  const disabled = new CharacterGuideService(logger, { env: { CHARACTER_GUIDE_ENABLED: 'false' } })
  disabled.initialize({ logger, config: {}, services: emptyServices() })
  const { commands } = loadPlugin(
    createCharacterGuidePlugin(whatsappStub()),
    { 'character-guide': disabled, 'group-context': stubGroupContextService() },
    whatsappStub(),
  )
  assert.equal(commands.size, 0)
})

test('menus and command indexes never advertise stub-refused commands as active', async () => {
  const whatsapp = whatsappStub()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry({ commandPrefix: '!', defaultCooldownMs: 0 }, logger, whatsapp, services, events)
  menuPlugin.load?.({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, events, commands: registry, services })
  registry.register({ name: 'ping', category: 'general', description: 'alive', handler: async () => {} })

  const economy = stubEconomyService()
  economyPlugin.load({
    logger,
    config: { commandPrefix: '!', defaultCooldownMs: 0 },
    events,
    commands: registry,
    services: { has: (name) => name === 'economy', get: () => economy },
  })

  await registry.dispatch({ id: 'menu-1', remoteJid: 'main@s.whatsapp.net', senderJid: memberJid, text: '!menu', timestamp: Date.now(), fromMe: false })
  const mainBody = whatsapp.sent[0].text
  assert.match(mainBody, /YOUR CHARACTER/)
  for (const hidden of ['!vela', '!wallet', '!bank', '!bankpolicy', '!bankreward', '!banksweep', '!tax', '!taxbayar']) {
    assert.equal(mainBody.includes(hidden), false, `main menu must not list ${hidden} as active`)
  }
  assert.doesNotMatch(mainBody, /EKONOMI/, 'menu must not show the economy category while the backend is empty')

  // The category page lists every visible command by name; refused stub commands
  // must be absent there too, while the genuinely-registered command stays listed.
  await registry.dispatch({ id: 'menu-2', remoteJid: 'main@s.whatsapp.net', senderJid: memberJid, text: '!menu 1', timestamp: Date.now(), fromMe: false })
  const categoryBody = whatsapp.sent[1].text
  assert.match(categoryBody, /ping/)
  for (const hidden of ['!vela', '!wallet', '!bank', '!bankpolicy', '!economypolicy', '!bankreward', '!banksweep', '!tax', '!taxbayar', '!bayarpajak']) {
    assert.equal(categoryBody.includes(hidden), false, `category menu must not list ${hidden} as active`)
  }
})
