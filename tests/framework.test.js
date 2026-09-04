import test from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { EventBus } from '../dist/framework/event-bus.js'
import { ServiceRegistry } from '../dist/framework/service-registry.js'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { PluginManager } from '../dist/framework/plugin-manager.js'
import { createFakeWhatsapp } from './helpers/fake-whatsapp.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }


test('EventBus isolates listener failures and emits framework.error', async () => {
  const bus = new EventBus(logger)
  let healthyListenerCalled = false
  let errorEventCalled = false
  bus.on('message.received', () => { throw new Error('listener failure') })
  bus.on('message.received', () => { healthyListenerCalled = true })
  bus.on('framework.error', ({ source }) => {
    errorEventCalled = source === 'event:message.received'
  })

  await bus.emit('message.received', {
    id: 'm1', remoteJid: 'chat@s.whatsapp.net', timestamp: Date.now(), fromMe: false,
  })

  assert.equal(healthyListenerCalled, true)
  assert.equal(errorEventCalled, true)
})

test('ServiceRegistry initializes dependencies and shuts them down in reverse order', async () => {
  const registry = new ServiceRegistry(logger)
  const events = []
  registry.register({
    name: 'database',
    initialize() { events.push('database:init') },
    shutdown() { events.push('database:shutdown') },
  })
  registry.register({
    name: 'cache',
    dependencies: ['database'],
    initialize() { events.push('cache:init') },
    shutdown() { events.push('cache:shutdown') },
  })

  await registry.initialize({ logger, config })
  await registry.shutdown({ logger, config })
  assert.deepEqual(events, ['database:init', 'cache:init', 'cache:shutdown', 'database:shutdown'])
})

test('CommandRegistry supports alias, validation, cooldown, and reply context', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  registry.register({
    name: 'hello',
    aliases: ['hi'],
    cooldownMs: 1000,
    handler: async (context) => context.reply(`hello ${context.args[0] ?? 'world'}`),
  })
  registry.register({
    name: 'validated',
    validate: () => 'missing argument',
    handler: async (context) => context.reply('must not run'),
  })

  const message = { id: 'm1', remoteJid: 'chat@s.whatsapp.net', senderJid: 'user@s.whatsapp.net', text: '!hi bob', timestamp: Date.now(), fromMe: false }
  assert.equal(await registry.dispatch(message), true)
  assert.equal(await registry.dispatch({ ...message, id: 'm2' }), true)
  assert.equal(await registry.dispatch({ ...message, id: 'm3', text: '!validated' }), true)
  assert.deepEqual(whatsapp.sent, [
    { remoteJid: 'chat@s.whatsapp.net', text: 'hello bob' },
    { remoteJid: 'chat@s.whatsapp.net', text: 'missing argument' },
  ])
})

test('Invalid command input does not consume the command cooldown', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  registry.register({
    name: 'validated-cooldown',
    cooldownMs: 10_000,
    validate: (context) => context.args.length === 0 ? 'Format: `!validated-cooldown <nilai>`' : undefined,
    handler: async (context) => context.reply('valid input'),
  })

  await registry.dispatch({ id: 'invalid-cooldown', remoteJid: 'chat@s.whatsapp.net', text: '!validated-cooldown', timestamp: Date.now(), fromMe: false })
  await registry.dispatch({ id: 'valid-cooldown', remoteJid: 'chat@s.whatsapp.net', text: '!validated-cooldown ok', timestamp: Date.now(), fromMe: false })

  assert.deepEqual(whatsapp.sent, [
    { remoteJid: 'chat@s.whatsapp.net', text: 'Format: `!validated-cooldown <nilai>`' },
    { remoteJid: 'chat@s.whatsapp.net', text: 'valid input' },
  ])
})

test('CommandRegistry sends a safe fallback when a handler fails before replying', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  registry.register({ name: 'boom', handler: async () => { throw new Error('private internal detail') } })
  registry.register({ name: 'partial-boom', handler: async (context) => { await context.reply('partial response'); throw new Error('after reply') } })

  await registry.dispatch({ id: 'boom', remoteJid: 'chat@s.whatsapp.net', text: '!boom', timestamp: Date.now(), fromMe: false })
  await registry.dispatch({ id: 'partial-boom', remoteJid: 'chat@s.whatsapp.net', text: '!partial-boom', timestamp: Date.now(), fromMe: false })

  assert.deepEqual(whatsapp.sent, [
    { remoteJid: 'chat@s.whatsapp.net', text: 'Maaf, command tidak dapat diproses saat ini. Silakan coba lagi.' },
    { remoteJid: 'chat@s.whatsapp.net', text: 'partial response' },
  ])
})

test('CommandRegistry retries the safe fallback when the first reply delivery fails', async () => {
  let attempts = 0
  const whatsapp = createFakeWhatsapp({
    async sendText(remoteJid, text) {
      attempts += 1
      if (attempts === 1) throw new Error('transport unavailable')
      this.sent.push({ remoteJid, text })
    },
  })
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  registry.register({ name: 'reply-failure', handler: async (context) => context.reply('handler response') })

  await registry.dispatch({ id: 'reply-failure', remoteJid: 'chat@s.whatsapp.net', text: '!reply-failure', timestamp: Date.now(), fromMe: false })

  assert.equal(attempts, 2)
  assert.deepEqual(whatsapp.sent, [
    { remoteJid: 'chat@s.whatsapp.net', text: 'Maaf, command tidak dapat diproses saat ini. Silakan coba lagi.' },
  ])
})

test('CommandRegistry rejects duplicate command names and aliases', () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  registry.register({ name: 'groupid', aliases: ['jid'], handler: async () => {} })
  assert.throws(() => registry.register({ name: 'groupid', handler: async () => {} }), /Command name already registered: groupid/)
  assert.throws(() => registry.register({ name: 'other', aliases: ['jid'], handler: async () => {} }), /Command name already registered: jid/)
})

test('CommandRegistry accepts safe numeric-leading command names', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  registry.register({ name: '8ball', aliases: ['8b'], handler: async (context) => context.reply('ok') })

  assert.equal(await registry.dispatch({ id: 'numeric-command', remoteJid: 'chat@s.whatsapp.net', text: '!8ball', timestamp: Date.now(), fromMe: false }), true)
  assert.deepEqual(whatsapp.sent, [{ remoteJid: 'chat@s.whatsapp.net', text: 'ok' }])
  assert.throws(() => registry.register({ name: '8 ball', handler: async () => {} }), /Invalid command name/)
})

test('CommandRegistry ignores commands from the bot itself', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)
  let executions = 0
  registry.register({
    name: 'self-test',
    handler: async () => { executions += 1 },
  })

  const dispatched = await registry.dispatch({
    id: 'self-1',
    remoteJid: 'chat@s.whatsapp.net',
    senderJid: 'bot@s.whatsapp.net',
    text: '!self-test',
    timestamp: Date.now(),
    fromMe: true,
  })

  assert.equal(dispatched, false)
  assert.equal(executions, 0)
  assert.deepEqual(whatsapp.sent, [])
})

test('PluginManager cleans plugin registrations on unload and supports reload', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const commands = new CommandRegistry(config, logger, whatsapp, services, events)
  const manager = new PluginManager(logger, config, events, commands, services)
  let messageEvents = 0

  manager.register({
    name: 'reloadable',
    load(context) {
      context.commands.register({ name: 'reloadable-command', handler: async () => {} })
      context.events.on('message.received', () => { messageEvents += 1 })
    },
  })

  await manager.loadAndInitialize()
  assert.ok(commands.get('reloadable-command'))
  await events.emit('message.received', {
    id: 'm1', remoteJid: 'chat@s.whatsapp.net', timestamp: Date.now(), fromMe: false,
  })
  assert.equal(messageEvents, 1)

  await manager.unload()
  assert.equal(commands.get('reloadable-command'), undefined)
  await events.emit('message.received', {
    id: 'm2', remoteJid: 'chat@s.whatsapp.net', timestamp: Date.now(), fromMe: false,
  })
  assert.equal(messageEvents, 1)

  await manager.loadAndInitialize()
  assert.ok(commands.get('reloadable-command'))
  await events.emit('message.received', {
    id: 'm3', remoteJid: 'chat@s.whatsapp.net', timestamp: Date.now(), fromMe: false,
  })
  assert.equal(messageEvents, 2)
  await manager.unload()
})

test('PluginManager unloads partially loaded failed plugins safely', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const commands = new CommandRegistry(config, logger, whatsapp, services, events)
  const manager = new PluginManager(logger, config, events, commands, services)
  let unloaded = 0

  manager.register({
    name: 'partial-failure',
    load(context) {
      context.commands.register({ name: 'partial-command', handler: async () => {} })
      context.events.on('message.received', () => {})
      throw new Error('load failed after registration')
    },
    unload() { unloaded += 1 },
  })

  await manager.loadAndInitialize()
  assert.equal(manager.list()[0].state, 'failed')
  assert.equal(commands.get('partial-command'), undefined)
  await manager.unload()
  assert.equal(unloaded, 1)
  assert.equal(manager.list()[0].state, 'registered')
})

test('CommandRegistry denies permission before handler execution', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events, () => false)
  registry.register({
    name: 'admin',
    permission: 'admin.use',
    handler: async (context) => context.reply('secret'),
  })

  await registry.dispatch({ id: 'm1', remoteJid: 'chat@s.whatsapp.net', text: '!admin', timestamp: Date.now(), fromMe: false })
  assert.deepEqual(whatsapp.sent, [{
    remoteJid: 'chat@s.whatsapp.net',
    text: 'Maaf, kamu belum memiliki izin untuk menggunakan command ini.',
  }])
})


test('ServiceRegistry rejects missing and circular dependencies before initialization', async () => {
  const missing = new ServiceRegistry(logger)
  missing.register({ name: 'consumer', dependencies: ['missing-service'], initialize() {} })
  await assert.rejects(() => missing.initialize({ logger, config }), /Missing service dependency: consumer -> missing-service/)

  const circular = new ServiceRegistry(logger)
  circular.register({ name: 'alpha', dependencies: ['beta'], initialize() {} })
  circular.register({ name: 'beta', dependencies: ['alpha'], initialize() {} })
  await assert.rejects(() => circular.initialize({ logger, config }), /Circular service dependency: alpha/)
})

test('PluginManager cleans registrations when ready hook fails', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const commands = new CommandRegistry(config, logger, whatsapp, services, events)
  const manager = new PluginManager(logger, config, events, commands, services)

  manager.register({
    name: 'ready-failure',
    load(context) {
      context.commands.register({ name: 'ready-failure-command', handler: async () => {} })
    },
    ready() {
      throw new Error('ready failed')
    },
  })

  await manager.loadAndInitialize()
  await manager.ready()
  assert.equal(manager.list()[0].state, 'failed')
  assert.equal(commands.get('ready-failure-command'), undefined)
  await manager.unload()
  assert.equal(manager.list()[0].state, 'registered')
})
