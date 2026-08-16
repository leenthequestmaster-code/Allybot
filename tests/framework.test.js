import test from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { EventBus } from '../dist/framework/event-bus.js'
import { ServiceRegistry } from '../dist/framework/service-registry.js'
import { CommandRegistry } from '../dist/framework/command-registry.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

function fakeWhatsapp() {
  return {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    sent: [],
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text) { this.sent.push({ remoteJid, text }) },
    async start() {},
    async close() {},
  }
}

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
  const whatsapp = fakeWhatsapp()
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
  assert.deepEqual(whatsapp.sent, [{ remoteJid: 'chat@s.whatsapp.net', text: 'hello bob' }])
})

test('CommandRegistry denies permission before handler execution', async () => {
  const whatsapp = fakeWhatsapp()
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
