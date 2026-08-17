import assert from 'node:assert/strict'
import { test } from 'node:test'
import pino from 'pino'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { ServiceRegistry } from '../dist/framework/service-registry.js'
import { menuPlugin } from '../dist/framework/plugins/menu.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

function fakeWhatsapp({ native = false, nativeFailure = false } = {}) {
  const transport = {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    sent: [],
    native: [],
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text) { this.sent.push({ remoteJid, text }) },
    async start() {},
    async close() {},
  }
  if (native) {
    transport.sendNativeQuickReplies = async function sendNativeQuickReplies(remoteJid, payload) {
      this.native.push({ remoteJid, payload })
      if (nativeFailure) throw new Error('native transport unavailable')
    }
  }
  return transport
}

function message(id, remoteJid, text, options = {}) {
  return {
    id,
    remoteJid,
    text,
    timestamp: Date.now(),
    fromMe: false,
    ...options,
  }
}

function createRegistry(whatsapp, prefixResolver) {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events, undefined, [], prefixResolver)
  menuPlugin.load?.({ logger, config, events, commands: registry, services })
  return { events, registry }
}

test('menu plugin renders the decorative main menu and supports numbered categories', async () => {
  const whatsapp = fakeWhatsapp()
  const { events, registry } = createRegistry(whatsapp)

  registry.register({
    name: 'ping',
    description: 'Check bot latency',
    category: 'general',
    menuOrder: 1,
    handler: async () => {},
  })
  registry.register({
    name: 'secret',
    description: 'Hidden internal command',
    category: 'owner',
    hidden: true,
    handler: async () => {},
  })

  assert.equal(registry.get('menu')?.name, 'menu')
  assert.equal(registry.get('m')?.name, 'menu')
  assert.equal(registry.get('help')?.name, 'menu')
  assert.equal(registry.get('back'), undefined)

  await registry.dispatch(message('menu-main', 'main@s.whatsapp.net', '!menu'))
  assert.match(whatsapp.sent[0].text, /Listmenu/)
  assert.match(whatsapp.sent[0].text, /GENERAL/)
  assert.match(whatsapp.sent[0].text, /!help/)
  assert.doesNotMatch(whatsapp.sent[0].text, /!secret/)

  await registry.dispatch(message('menu-roadmap', 'roadmap@s.whatsapp.net', '!menu ai'))
  assert.match(whatsapp.sent[1].text, /AI/)
  assert.match(whatsapp.sent[1].text, /Coming Soon/)

  await registry.dispatch(message('menu-numbered', 'numbered@s.whatsapp.net', '!menu 5'))
  assert.match(whatsapp.sent[2].text, /GENERAL/)
  assert.match(whatsapp.sent[2].text, /\*1\.\* !ping/)

  await registry.dispatch(message('menu-main-again', 'back@s.whatsapp.net', '!menu'))
  assert.match(whatsapp.sent[3].text, /Listmenu/)
})

test('menu plugin follows the effective group prefix while retaining global fallback', async () => {
  const whatsapp = fakeWhatsapp()
  const { registry } = createRegistry(whatsapp, (incomingMessage, _services, fallback) => (
    incomingMessage.remoteJid.endsWith('@g.us') ? '##' : fallback
  ))

  registry.register({
    name: 'ping',
    description: 'Check bot latency',
    category: 'general',
    menuOrder: 1,
    handler: async () => {},
  })

  await registry.dispatch(message('custom-menu', 'group@g.us', '##menu'))
  assert.match(whatsapp.sent[0].text, /##help/)
  assert.match(whatsapp.sent[0].text, /##menu <angka>/)
  assert.doesNotMatch(whatsapp.sent[0].text, /!help/)

  const fallbackWhatsapp = fakeWhatsapp()
  const { registry: fallbackRegistry } = createRegistry(fallbackWhatsapp, (incomingMessage, _services, fallback) => (
    incomingMessage.remoteJid.endsWith('@g.us') ? '##' : fallback
  ))
  fallbackRegistry.register({
    name: 'ping',
    description: 'Check bot latency',
    category: 'general',
    menuOrder: 1,
    handler: async () => {},
  })
  await fallbackRegistry.dispatch(message('fallback-menu', 'group@g.us', '!menu'))
  assert.match(fallbackWhatsapp.sent[0].text, /##help/)
})

test('replying with a category number navigates only from a quoted main menu', async () => {
  const whatsapp = fakeWhatsapp()
  const { events, registry } = createRegistry(whatsapp)

  registry.register({
    name: 'ping',
    description: 'Check bot latency',
    category: 'general',
    menuOrder: 1,
    handler: async () => {},
  })
  registry.register({
    name: 'groupinfo',
    description: 'Show group information',
    category: 'group',
    menuOrder: 1,
    handler: async () => {},
  })

  await registry.dispatch(message('reply-menu-main', 'reply@s.whatsapp.net', '!menu'))
  const mainMenu = whatsapp.sent[0].text
  assert.match(mainMenu, /Atau balas pesan menu ini dengan angka kategorinya/)

  await events.emit('message.received', message('reply-menu-number', 'reply@s.whatsapp.net', '6', {
    quotedText: mainMenu,
    quotedSenderJid: 'bot@s.whatsapp.net',
  }))
  assert.match(whatsapp.sent[1].text, /GROUP/)
  assert.match(whatsapp.sent[1].text, /!groupinfo/)

  const sentBeforePlainNumber = whatsapp.sent.length
  await events.emit('message.received', message('plain-number', 'reply@s.whatsapp.net', '2'))
  assert.equal(whatsapp.sent.length, sentBeforePlainNumber)

  const submenu = whatsapp.sent[1].text
  await events.emit('message.received', message('submenu-number', 'reply@s.whatsapp.net', '1', {
    quotedText: submenu,
    quotedSenderJid: 'bot@s.whatsapp.net',
  }))
  assert.equal(whatsapp.sent.length, sentBeforePlainNumber)

  await events.emit('message.received', message('out-of-range-number', 'reply@s.whatsapp.net', '99', {
    quotedText: mainMenu,
    quotedSenderJid: 'bot@s.whatsapp.net',
  }))
  assert.match(whatsapp.sent[2].text, /tidak ditemukan/)
})

test('menu plugin sends native buttons and routes a button callback to the category submenu', async () => {
  const whatsapp = fakeWhatsapp({ native: true })
  const { events, registry } = createRegistry(whatsapp)

  registry.register({
    name: 'ping',
    description: 'Check bot latency',
    category: 'general',
    handler: async () => {},
  })
  registry.register({
    name: 'groupinfo',
    description: 'Show group information',
    category: 'group',
    handler: async () => {},
  })
  registry.register({
    name: 'diagnostics',
    description: 'Show diagnostics',
    category: 'system',
    handler: async () => {},
  })

  await registry.dispatch(message('button-menu-main', 'button@s.whatsapp.net', '!menu'))
  assert.equal(whatsapp.sent.length, 0)
  assert.equal(whatsapp.native.length, 1)
  assert.equal(whatsapp.native[0].payload.type, 'native_quick_reply')
  assert.equal(whatsapp.native[0].payload.buttons.length, 3)

  const groupButton = whatsapp.native[0].payload.buttons.find((button) => button.title.includes('GROUP'))
  assert.ok(groupButton)
  await events.emit('message.received', message('button-group-selection', 'button@s.whatsapp.net', undefined, {
    buttonId: groupButton.id,
  }))
  assert.equal(whatsapp.native.length, 1)
  assert.match(whatsapp.sent[0].text, /GROUP/)
  assert.match(whatsapp.sent[0].text, /!groupinfo/)
})

test('menu plugin falls back to text when the native button sender fails', async () => {
  const whatsapp = fakeWhatsapp({ native: true, nativeFailure: true })
  const { registry } = createRegistry(whatsapp)

  registry.register({
    name: 'ping',
    description: 'Check bot latency',
    category: 'general',
    handler: async () => {},
  })

  await registry.dispatch(message('button-fallback', 'fallback@s.whatsapp.net', '!menu'))
  assert.equal(whatsapp.native.length, 1)
  assert.equal(whatsapp.sent.length, 1)
  assert.match(whatsapp.sent[0].text, /Listmenu/)
})

test('menu plugin renders paginated submenus and unknown-category guidance', async () => {
  const whatsapp = fakeWhatsapp()
  const { registry } = createRegistry(whatsapp)

  for (let index = 1; index <= 10; index += 1) {
    registry.register({
      name: `tool${index}`,
      description: `Tool command ${index}`,
      category: 'tools',
      handler: async () => {},
    })
  }

  await registry.dispatch(message('menu-page', 'page@s.whatsapp.net', '!menu tools 2'))
  assert.match(whatsapp.sent[0].text, /TOOLS/)
  assert.match(whatsapp.sent[0].text, /Halaman 2\/2/)
  assert.match(whatsapp.sent[0].text, /\*9\.\* !tool9/)
  assert.doesNotMatch(whatsapp.sent[0].text, /\*1\.\* !tool1/)
  assert.match(whatsapp.sent[0].text, /!menu/)
  assert.doesNotMatch(whatsapp.sent[0].text, /!back/)

  await registry.dispatch(message('menu-unknown', 'unknown@s.whatsapp.net', '!m missing'))
  assert.match(whatsapp.sent[1].text, /tidak ditemukan/)
  assert.match(whatsapp.sent[1].text, /!menu/)
})
