import test from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { diagnosticsPlugin } from '../dist/framework/plugins/diagnostics.js'
import { technicalPlugin } from '../dist/framework/plugins/technical.js'
import { createPermissionResolver } from '../dist/permissions.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

class FakeCore {
  isConnected = false
  userJid = 'bot@s.whatsapp.net'
  sent = []
  messages = new Set()
  clearRuntimeCaches() { return { duplicateMessages: 3, groupNames: 2, retryCounters: 1 } }
  async listParticipatingGroups() {
    return [
      { jid: '120363000000000001-1111111111@g.us', subject: 'Alpha\nRoom' },
      { jid: '120363000000000002-2222222222@g.us', subject: 'Beta Room' },
      { jid: 'not-a-group', subject: 'Should not show' },
    ]
  }
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

test('ApplicationFramework owns lifecycle and dispatches through WhatsAppPort', async () => {
  const core = new FakeCore()
  const app = new ApplicationFramework(config, logger, core)
  const lifecycle = []
  app.registerService({
    name: 'sample-service',
    initialize() { lifecycle.push('service:init') },
    shutdown() { lifecycle.push('service:shutdown') },
  })
  app.registerPlugin({
    name: 'sample-plugin',
    load(context) {
      lifecycle.push('plugin:load')
      context.commands.register({
        name: 'hello',
        handler: async (commandContext) => commandContext.reply('hello from framework'),
      })
    },
    initialize() { lifecycle.push('plugin:init') },
    ready() { lifecycle.push('plugin:ready') },
    unload() { lifecycle.push('plugin:unload') },
  })

  await app.start()
  assert.equal(app.state.phase, 'ready')
  assert.equal(core.isConnected, true)
  await core.emitMessage({ id: 'm1', remoteJid: 'chat@s.whatsapp.net', text: '!hello', timestamp: Date.now(), fromMe: false })
  assert.deepEqual(core.sent, [{ remoteJid: 'chat@s.whatsapp.net', text: 'hello from framework' }])
  await app.stop()
  assert.equal(app.state.phase, 'stopped')
  assert.deepEqual(lifecycle, ['service:init', 'plugin:load', 'plugin:init', 'plugin:ready', 'plugin:unload', 'service:shutdown'])
})

test('A failed command is isolated and framework remains ready for later commands', async () => {
  const core = new FakeCore()
  const app = new ApplicationFramework(config, logger, core)
  let frameworkErrors = 0
  app.events.on('framework.error', () => { frameworkErrors += 1 })
  app.registerPlugin({
    name: 'fault-isolation',
    load(context) {
      context.commands.register({ name: 'bad', handler: () => { throw new Error('expected failure') } })
      context.commands.register({ name: 'good', handler: async (commandContext) => commandContext.reply('still alive') })
    },
  })

  await app.start()
  await core.emitMessage({ id: 'bad', remoteJid: 'chat@s.whatsapp.net', text: '!bad', timestamp: Date.now(), fromMe: false })
  await core.emitMessage({ id: 'good', remoteJid: 'chat@s.whatsapp.net', text: '!good', timestamp: Date.now(), fromMe: false })
  assert.equal(app.state.phase, 'ready')
  assert.equal(frameworkErrors, 1)
  assert.deepEqual(core.sent, [{ remoteJid: 'chat@s.whatsapp.net', text: 'still alive' }])
  await app.stop()
})

test('Technical commands provide routed ping, safe profile, and owner-only cache clear', async () => {
  const core = new FakeCore()
  const app = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: 'owner@s.whatsapp.net' },
    logger,
    core,
    {
      permissionResolver: (permission, context) => permission === 'bot.owner'
        && context.message.senderJid === 'owner@s.whatsapp.net',
    },
  )
  app.registerPlugin(technicalPlugin)
  await app.start()

  await core.emitMessage({ id: 'ping', remoteJid: 'chat@s.whatsapp.net', senderJid: 'owner@s.whatsapp.net', text: '!ping', timestamp: Date.now() - 20, receivedAt: Date.now() - 15, fromMe: false })
  assert.match(core.sent[0].text, /Pong.*Allybot aktif/)
  assert.match(core.sent[0].text, /Latency: \d+ ms/)

  await core.emitMessage({ id: 'profile', remoteJid: 'chat@s.whatsapp.net', senderJid: 'owner@s.whatsapp.net', text: '!bprofile', timestamp: Date.now(), fromMe: false })
  assert.match(core.sent[1].text, /Allybot Profile/)
  assert.match(core.sent[1].text, /Node\.js/)
  assert.equal(core.sent[1].text.includes('owner@s.whatsapp.net'), false)
  assert.equal(core.sent[1].text.includes('databasePath'), false)

  await core.emitMessage({ id: 'owner-profile', remoteJid: 'chat@s.whatsapp.net', senderJid: 'stranger@s.whatsapp.net', text: '!owner', timestamp: Date.now(), fromMe: false })
  assert.match(core.sent[2].text, /Allybot Owner Profile/)
  assert.match(core.sent[2].text, /Nama: Vallen/)
  assert.match(core.sent[2].text, /Status: Owner/)
  assert.match(core.sent[2].text, /Nomor HP: 083197859955/)
  assert.match(core.sent[2].text, /text fallback digunakan/)
  assert.equal(core.sent[2].text.includes('owner@s.whatsapp.net'), false)
  assert.equal(core.sent[2].text.includes('password'), false)

  await core.emitMessage({ id: 'clearcache-denied', remoteJid: 'chat@s.whatsapp.net', senderJid: 'stranger@s.whatsapp.net', text: '!clearcache', timestamp: Date.now(), fromMe: false })
  assert.match(core.sent[3].text, /hanya tersedia untuk owner Allybot/)

  await core.emitMessage({ id: 'clearcache', remoteJid: 'chat@s.whatsapp.net', senderJid: 'owner@s.whatsapp.net', text: '!clearcache', timestamp: Date.now(), fromMe: false })
  assert.match(core.sent[4].text, /Duplicate-message cache: 3 entry/)
  assert.match(core.sent[4].text, /Auth\/session\/database: tidak disentuh/)
  await app.stop()
})

test('JID commands are owner/developer-gated, group-scoped, bounded, and text-only', async () => {
  const core = new FakeCore()
  const ownerJid = 'owner@s.whatsapp.net'
  const app = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: ownerJid },
    logger,
    core,
    { permissionResolver: createPermissionResolver(core, ownerJid) },
  )
  app.registerPlugin(technicalPlugin)
  await app.start()

  await core.emitMessage({
    id: 'groupid',
    remoteJid: '120363000000000000-3333333333@g.us',
    senderJid: ownerJid,
    text: '!jid',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[0].text, /JID Grup Saat Ini/)
  assert.match(core.sent[0].text, /120363000000000000-3333333333@g\.us/)

  await core.emitMessage({
    id: 'groupid-denied',
    remoteJid: '120363000000000000-3333333333@g.us',
    senderJid: 'stranger@s.whatsapp.net',
    text: '!groupid',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[1].text, /Developer Mode belum aktif/)

  await core.emitMessage({
    id: 'alljid',
    remoteJid: ownerJid,
    senderJid: ownerJid,
    text: '!alljid',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[2].text, /Semua JID Grup Allybot/)
  assert.match(core.sent[2].text, /120363000000000001-1111111111@g\.us/)
  assert.match(core.sent[2].text, /120363000000000002-2222222222@g\.us/)
  assert.match(core.sent[2].text, /Alpha Room/)
  assert.equal(core.sent[2].text.includes('Should not show'), false)
  assert.equal(core.sent[2].text.includes('Alpha\nRoom'), false)

  await app.stop()
})

test('Diagnostics plugin exposes only a minimal non-sensitive proof command', async () => {
  const core = new FakeCore()
  const app = new ApplicationFramework(config, logger, core)
  app.registerPlugin(diagnosticsPlugin)
  await app.start()
  await core.emitMessage({ id: 'diag', remoteJid: 'chat@s.whatsapp.net', text: '!health', timestamp: Date.now(), fromMe: false })
  assert.equal(core.sent.length, 1)
  assert.match(core.sent[0].text, /^Allybot framework ready \| connected=true \| services=/)
  await app.stop()
})


test('Plugin ready hooks follow dependency order', async () => {
  const core = new FakeCore()
  const app = new ApplicationFramework(config, logger, core)
  const readyOrder = []

  app.registerPlugin({
    name: 'dependent-plugin',
    dependencies: ['base-plugin'],
    ready() { readyOrder.push('dependent') },
  })
  app.registerPlugin({
    name: 'base-plugin',
    ready() { readyOrder.push('base') },
  })

  await app.start()
  assert.deepEqual(readyOrder, ['base', 'dependent'])
  await app.stop()
})

test('Public owner profile is available to non-owner callers in a group without identity disclosure', async () => {
  const core = new FakeCore()
  const app = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: 'owner@s.whatsapp.net' },
    logger,
    core,
  )
  app.registerPlugin(technicalPlugin)
  await app.start()

  try {
    await core.emitMessage({
      id: 'owner-profile-group',
      remoteJid: '120363000000000000@g.us',
      senderJid: 'stranger@s.whatsapp.net',
      text: '!owner',
      timestamp: Date.now(),
      fromMe: false,
    })
    assert.match(core.sent[0].text, /Allybot Owner Profile/)
    assert.match(core.sent[0].text, /Control plane: protected/)
    assert.match(core.sent[0].text, /Nomor HP: 083197859955/)
    assert.equal(core.sent[0].text.includes('owner@s.whatsapp.net'), false)
  } finally {
    await app.stop()
  }
})

test('Public owner profile image failure uses text fallback without raw error logging', async () => {
  const commands = []
  const logs = []
  technicalPlugin.load({
    commands: { register(command) { commands.push(command) } },
  })
  const owner = commands.find((command) => command.name === 'owner')
  const replies = []
  await owner.handler({
    message: { remoteJid: 'chat@s.whatsapp.net', timestamp: Date.now() },
    config: { botOwnerJid: '6283197859955@s.whatsapp.net' },
    prefix: '!',
    whatsapp: {
      getProfilePictureUrl: async () => 'https://cdn.example.test/owner.jpg',
      sendImage: async () => { throw new Error('relay failed for token=example-token') },
    },
    logger: { debug(payload, message) { logs.push({ payload, message }) } },
    reply: async (text) => replies.push(text),
  })

  assert.match(replies[0], /text fallback digunakan/)
  assert.deepEqual(logs[0].payload, { errorName: 'Error' })
  assert.equal(JSON.stringify(logs).includes('example-token'), false)
})
