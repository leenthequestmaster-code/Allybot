import test from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { EventBus } from '../dist/framework/event-bus.js'
import { ServiceRegistry } from '../dist/framework/service-registry.js'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { isJid, isGroupJid } from '../dist/framework/validation.js'
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
    { remoteJid: 'chat@s.whatsapp.net', text: '⏳ Tunggu sebentar ya, command ini masih cooldown 1 detik lagi~ 🙏' },
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

test('isJid accepts only strict WhatsApp JID formats', () => {
  const valid = [
    '6281234567890@s.whatsapp.net',
    '6281234567890:12@s.whatsapp.net',
    '120363012345678901@g.us',
    '120363012345678901-1111111111@g.us',
    '39847123456789@lid',
    '123456789012345678@newsletter',
    '123456789012@broadcast',
    'status@broadcast',
  ]
  for (const jid of valid) {
    assert.equal(isJid(jid), true, `expected valid: ${jid}`)
  }

  const invalid = [
    '',
    'x@y',
    'user@server',
    'owner-lid@lid',
    'economy-test-user@s.whatsapp.net',
    'roleplay@g.us',
    'status@g.us',
    '6281234567890@s.whatsapp.net.evil.com',
    '6281234567890@s.whatsapp.net/../secrets',
    '@s.whatsapp.net',
    '6281234567890@',
    '6281234567890@s whatsapp net',
    '6281234567890@S.WHATSAPP.NET',
    ' 6281234567890@s.whatsapp.net',
    '6281234567890@s.whatsapp.net ',
    '6281234567890:s.whatsapp.net@s.whatsapp.net',
    '6281234567890::1@s.whatsapp.net',
    '-120363012345678901@g.us',
    '120363012345678901--1111111111@g.us',
    '120363012345678901-@g.us',
    'status@broadcast@broadcast',
    'https://example.test/@x',
    'javascript:alert(1)@s.whatsapp.net',
    '12345678901234567 8@broadcast',
  ]
  for (const jid of invalid) {
    assert.equal(isJid(jid), false, `expected invalid: ${JSON.stringify(jid)}`)
  }
})

test('isGroupJid only accepts numeric WhatsApp group JIDs', () => {
  assert.equal(isGroupJid('120363012345678901@g.us'), true)
  assert.equal(isGroupJid('120363012345678901-1111111111@g.us'), true)
  assert.equal(isGroupJid('6281234567890@s.whatsapp.net'), false)
  assert.equal(isGroupJid('roleplay@g.us'), false)
  assert.equal(isGroupJid('120363012345678901@newsletter'), false)
  assert.equal(isGroupJid(''), false)
})

test('CommandRegistry drops stale commands when freshness policy is configured', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)

  let interactiveExecuted = false
  let regularExecuted = false

  registry.register({
    name: 'fresh-game',
    freshness: { maxAgeMs: 30_000 },
    handler: async (ctx) => {
      interactiveExecuted = true
      await ctx.reply('game moved')
    },
  })

  registry.register({
    name: 'regular-info',
    handler: async (ctx) => {
      regularExecuted = true
      await ctx.reply('info delivered')
    },
  })

  const now = Date.now()

  // 1. Stale interactive command (45s old) -> dropped silently
  const staleMsg = {
    id: 'msg-stale',
    remoteJid: 'chat@s.whatsapp.net',
    senderJid: 'user@s.whatsapp.net',
    text: '!fresh-game',
    timestamp: now - 45_000,
    fromMe: false,
  }
  const staleResult = await registry.dispatch(staleMsg)
  assert.equal(staleResult, false)
  assert.equal(interactiveExecuted, false)
  assert.equal(whatsapp.sent.length, 0)

  // 2. Fresh interactive command (5s old) -> executed
  const freshMsg = {
    id: 'msg-fresh',
    remoteJid: 'chat@s.whatsapp.net',
    senderJid: 'user@s.whatsapp.net',
    text: '!fresh-game',
    timestamp: now - 5_000,
    fromMe: false,
  }
  const freshResult = await registry.dispatch(freshMsg)
  assert.equal(freshResult, true)
  assert.equal(interactiveExecuted, true)
  assert.equal(whatsapp.sent.length, 1)
  assert.equal(whatsapp.sent[0].text, 'game moved')

  // 3. Regular command without freshness policy (60s old) -> executed normally
  const regularOldMsg = {
    id: 'msg-regular',
    remoteJid: 'chat@s.whatsapp.net',
    senderJid: 'user@s.whatsapp.net',
    text: '!regular-info',
    timestamp: now - 60_000,
    fromMe: false,
  }
  const regularResult = await registry.dispatch(regularOldMsg)
  assert.equal(regularResult, true)
  assert.equal(regularExecuted, true)
  assert.equal(whatsapp.sent.length, 2)
  assert.equal(whatsapp.sent[1].text, 'info delivered')
})

test('CommandRegistry enforces scope: group-only, private-only, both, and your-character default', async () => {
  const whatsapp = createFakeWhatsapp()
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events)

  let groupExecuted = false
  let charExecuted = false
  let privateExecuted = false

  registry.register({
    name: 'kick',
    category: 'moderation',
    handler: async () => { groupExecuted = true },
  })

  registry.register({
    name: 'stats',
    category: 'your-character',
    handler: async () => { charExecuted = true },
  })

  registry.register({
    name: 'secret',
    scope: 'private',
    handler: async () => { privateExecuted = true },
  })

  const groupJid = '120363012345678901@g.us'
  const privateJid = '6281234567890@s.whatsapp.net'

  // 1. Group command in private -> denied with group-only message
  await registry.dispatch({ id: 'm1', remoteJid: privateJid, text: '!kick', timestamp: Date.now(), fromMe: false })
  assert.equal(groupExecuted, false)
  assert.match(whatsapp.sent.at(-1)?.text ?? '', /cuma bisa dijalankan di dalam grup/)

  // 2. Group command in group -> executed
  await registry.dispatch({ id: 'm2', remoteJid: groupJid, text: '!kick', timestamp: Date.now(), fromMe: false })
  assert.equal(groupExecuted, true)

  // 3. your-character command in private -> executed
  await registry.dispatch({ id: 'm3', remoteJid: privateJid, text: '!stats', timestamp: Date.now(), fromMe: false })
  assert.equal(charExecuted, true)

  // 4. your-character command in group -> executed
  charExecuted = false
  await registry.dispatch({ id: 'm4', remoteJid: groupJid, text: '!stats', timestamp: Date.now(), fromMe: false })
  assert.equal(charExecuted, true)

  // 5. Private-only command in group -> denied with private chat message
  await registry.dispatch({ id: 'm5', remoteJid: groupJid, text: '!secret', timestamp: Date.now(), fromMe: false })
  assert.equal(privateExecuted, false)
  assert.match(whatsapp.sent.at(-1)?.text ?? '', /cuma bisa dijalankan di private chat/)

  // 6. Private-only command in private -> executed
  await registry.dispatch({ id: 'm6', remoteJid: privateJid, text: '!secret', timestamp: Date.now(), fromMe: false })
  assert.equal(privateExecuted, true)
})

test('CommandRegistry enforces Join-First Gate (OOC Allyssea membership)', async () => {
  const oocGroupJid = '120363099999999999@g.us'
  const externalGroupJid = '120363088888888888@g.us'
  const memberJid = '6281111111111@s.whatsapp.net'
  const nonMemberJid = '6282222222222@s.whatsapp.net'

  const whatsapp = {
    ...createFakeWhatsapp(),
    async getGroupMetadata(jid) {
      if (jid === oocGroupJid) {
        return {
          jid: oocGroupJid,
          subject: 'OOC Allyssea',
          participants: [{ jid: memberJid, role: 'member' }],
        }
      }
      return undefined
    },
  }

  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(
    {
      ...config,
      officialOocGroupJid: oocGroupJid,
      officialOocInviteLink: 'https://chat.whatsapp.com/test-ooc-link',
    },
    logger,
    whatsapp,
    services,
    events,
  )

  let commandExecuted = false
  registry.register({
    name: 'ping',
    scope: 'both',
    handler: async () => { commandExecuted = true },
  })

  // 1. Non-member in external group -> rejected with invite link
  commandExecuted = false
  await registry.dispatch({
    id: 'm1',
    remoteJid: externalGroupJid,
    senderJid: nonMemberJid,
    text: '!ping',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.equal(commandExecuted, false)
  assert.match(whatsapp.sent.at(-1)?.text ?? '', /bergabung ke grup resmi OOC Allyssea/)
  assert.match(whatsapp.sent.at(-1)?.text ?? '', /test-ooc-link/)

  // 2. Member in external group -> allowed!
  commandExecuted = false
  await registry.dispatch({
    id: 'm2',
    remoteJid: externalGroupJid,
    senderJid: memberJid,
    text: '!ping',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.equal(commandExecuted, true)

  // 3. Any user inside official OOC group itself -> bypasses join check!
  commandExecuted = false
  await registry.dispatch({
    id: 'm3',
    remoteJid: oocGroupJid,
    senderJid: nonMemberJid,
    text: '!ping',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.equal(commandExecuted, true)
})
