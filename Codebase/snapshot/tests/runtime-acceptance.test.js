import test from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { menuPlugin } from '../dist/framework/plugins/menu.js'

const logger = pino({ level: 'silent' })

function createFakeWhatsapp(options = {}) {
  const messageListeners = []
  const groupParticipantListeners = []
  const connectionListeners = []
  const sentTexts = []
  const sentQuickReplies = []
  const sentLocations = []
  const metadata = options.metadata ?? {
    jid: 'group@g.us',
    subject: 'Acceptance Group',
    ownerJid: 'group-owner@s.whatsapp.net',
    participants: [
      { jid: 'admin@s.whatsapp.net', role: 'admin' },
      { jid: 'member@s.whatsapp.net', role: 'member' },
    ],
  }

  return {
    isConnected: true,
    currentStatus: 'connected',
    userJid: 'bot@s.whatsapp.net',
    sentTexts,
    sentQuickReplies,
    sentLocations,
    onMessage(listener) {
      messageListeners.push(listener)
      return () => {
        const index = messageListeners.indexOf(listener)
        if (index >= 0) messageListeners.splice(index, 1)
      }
    },
    onGroupParticipantUpdate(listener) {
      groupParticipantListeners.push(listener)
      return () => {
        const index = groupParticipantListeners.indexOf(listener)
        if (index >= 0) groupParticipantListeners.splice(index, 1)
      }
    },
    onConnectionState(listener) {
      connectionListeners.push(listener)
      return () => {
        const index = connectionListeners.indexOf(listener)
        if (index >= 0) connectionListeners.splice(index, 1)
      }
    },
    async sendText(remoteJid, text) {
      sentTexts.push({ remoteJid, text })
    },
    async sendNativeQuickReplies(remoteJid, payload) {
      sentQuickReplies.push({ remoteJid, payload })
    },
    async sendLocation(remoteJid, payload) {
      sentLocations.push({ remoteJid, payload })
    },
    async getGroupMetadata() {
      return metadata
    },
    async start() {},
    async close() {},
    async emitMessage(message) {
      for (const listener of [...messageListeners]) await listener(message)
    },
    async emitConnectionState(event) {
      for (const listener of [...connectionListeners]) await listener(event)
    },
  }
}

function message(overrides = {}) {
  return {
    id: `acceptance-${Math.random().toString(36).slice(2)}`,
    remoteJid: 'chat@s.whatsapp.net',
    senderJid: 'member@s.whatsapp.net',
    timestamp: Date.now(),
    fromMe: false,
    ...overrides,
  }
}

function createFramework(whatsapp, options = {}) {
  return new ApplicationFramework(
    {
      commandPrefix: '!',
      defaultCooldownMs: 0,
      botOwnerJid: 'owner@s.whatsapp.net',
    },
    logger,
    whatsapp,
    {
      permissionResolver: options.permissionResolver,
    },
  )
}

test('runtime acceptance traces inbound message through command handler to response', async () => {
  const whatsapp = createFakeWhatsapp()
  const framework = createFramework(whatsapp)
  let executions = 0

  framework.registerPlugin({
    name: 'acceptance-runtime',
    load(context) {
      context.commands.register({
        name: 'echo',
        aliases: ['e'],
        category: 'general',
        handler: async (ctx) => {
          executions += 1
          await ctx.reply(`echo:${ctx.args.join('|')}`)
        },
      })
    },
  })

  await framework.start()
  await whatsapp.emitMessage(message({ id: 'flow-1', text: '!e alpha beta' }))

  assert.equal(executions, 1)
  assert.deepEqual(whatsapp.sentTexts, [{ remoteJid: 'chat@s.whatsapp.net', text: 'echo:alpha|beta' }])
  assert.equal(framework.state.phase, 'ready')

  await framework.stop()
  assert.equal(framework.state.phase, 'stopped')
})

test('runtime acceptance rejects fromMe, unknown, and invalid commands without handler side effects', async () => {
  const whatsapp = createFakeWhatsapp()
  const framework = createFramework(whatsapp)
  let executions = 0

  framework.registerPlugin({
    name: 'acceptance-rejections',
    load(context) {
      context.commands.register({
        name: 'validated',
        validate: () => 'invalid input',
        handler: async () => { executions += 1 },
      })
    },
  })

  await framework.start()
  await whatsapp.emitMessage(message({ id: 'reject-self', fromMe: true, senderJid: 'bot@s.whatsapp.net', text: '!validated' }))
  await whatsapp.emitMessage(message({ id: 'reject-unknown', text: '!does-not-exist' }))
  await whatsapp.emitMessage(message({ id: 'reject-validation', text: '!validated' }))

  assert.equal(executions, 0)
  assert.deepEqual(whatsapp.sentTexts, [{ remoteJid: 'chat@s.whatsapp.net', text: 'invalid input' }])
  await framework.stop()
})

test('permission denial is enforced before protected handler execution', async () => {
  const whatsapp = createFakeWhatsapp()
  const framework = createFramework(whatsapp, {
    permissionResolver: async () => false,
  })
  let executions = 0

  framework.registerPlugin({
    name: 'acceptance-permission',
    load(context) {
      context.commands.register({
        name: 'protected',
        permission: 'bot.owner',
        handler: async () => { executions += 1 },
      })
    },
  })

  await framework.start()
  await whatsapp.emitMessage(message({ id: 'permission-denied', text: '!protected' }))

  assert.equal(executions, 0)
  assert.deepEqual(whatsapp.sentTexts, [{
    remoteJid: 'chat@s.whatsapp.net',
    text: 'Maaf, command ini hanya tersedia untuk owner Allybot.',
  }])
  await framework.stop()
})

test('menu uses a text fallback with numeric navigation', async () => {
  const whatsapp = createFakeWhatsapp()
  const framework = createFramework(whatsapp)
  framework.registerPlugin({
    name: 'acceptance-menu-command',
    load(context) {
      context.commands.register({
        name: 'status',
        category: 'general',
        description: 'Acceptance status command',
        handler: async (ctx) => ctx.reply('status-ok'),
      })
    },
  })
  framework.registerPlugin(menuPlugin)

  await framework.start()
  await whatsapp.emitMessage(message({ id: 'menu-main', text: '!menu' }))

  assert.equal(whatsapp.sentLocations.length, 0)
  assert.equal(whatsapp.sentQuickReplies.length, 0)
  assert.equal(whatsapp.sentTexts.length, 1)
  assert.match(whatsapp.sentTexts[0].text, /PROFILE BOT/)
  assert.match(whatsapp.sentTexts[0].text, /\*1\.\*/)
  assert.match(whatsapp.sentTexts[0].text, /\*!menu 1\*/)

  await whatsapp.emitMessage(message({ id: 'menu-numeric', text: '!menu 1' }))

  assert.equal(whatsapp.sentQuickReplies.length, 0)
  assert.equal(whatsapp.sentTexts.length, 2)
  assert.match(whatsapp.sentTexts[1].text, /YOUR CHARACTER/)
  assert.match(whatsapp.sentTexts[1].text, /!status/)
  await framework.stop()
})

test('framework stop unbinds inbound listeners and prevents post-stop dispatch', async () => {
  const whatsapp = createFakeWhatsapp()
  const framework = createFramework(whatsapp)
  framework.registerPlugin({
    name: 'acceptance-stop',
    load(context) {
      context.commands.register({
        name: 'stop-check',
        handler: async (ctx) => ctx.reply('should-not-run-after-stop'),
      })
    },
  })

  await framework.start()
  await framework.stop()
  await whatsapp.emitMessage(message({ id: 'after-stop', text: '!stop-check' }))

  assert.deepEqual(whatsapp.sentTexts, [])
  assert.equal(framework.state.phase, 'stopped')
})


test('message gate denies before message.received and command dispatch', async () => {
  const whatsapp = createFakeWhatsapp()
  const framework = createFramework(whatsapp)
  let received = 0
  let executions = 0

  framework.registerPlugin({
    name: 'acceptance-message-gate',
    load(context) {
      context.messageGates.register('deny-acceptance-message', () => ({ allowed: false, reason: 'test-denied' }))
      context.events.on('message.received', () => { received += 1 })
      context.commands.register({
        name: 'gated',
        handler: async () => { executions += 1 },
      })
    },
  })

  await framework.start()
  await whatsapp.emitMessage(message({ id: 'gate-denied', text: '!gated' }))

  assert.equal(received, 0)
  assert.equal(executions, 0)
  assert.deepEqual(whatsapp.sentTexts, [])
  await framework.stop()
})
