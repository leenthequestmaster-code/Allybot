import assert from 'node:assert/strict'
import { test } from 'node:test'
import pino from 'pino'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { ServiceRegistry } from '../dist/framework/service-registry.js'
import { menuPlugin } from '../dist/framework/plugins/menu.js'

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

function message(id, remoteJid, text) {
  return {
    id,
    remoteJid,
    text,
    timestamp: Date.now(),
    fromMe: false,
  }
}

function createRegistry(whatsapp, prefixResolver) {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const registry = new CommandRegistry(config, logger, whatsapp, services, events, undefined, [], prefixResolver)
  menuPlugin.load?.({ logger, config, events, commands: registry, services })
  return registry
}

test('menu plugin renders the decorative main menu and supports numbered categories', async () => {
  const whatsapp = fakeWhatsapp()
  const registry = createRegistry(whatsapp)

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
  assert.equal(registry.get('back')?.name, 'menu')

  await registry.dispatch(message('menu-main', 'main@s.whatsapp.net', '!menu'))
  assert.match(whatsapp.sent[0].text, /Listmenu/)
  assert.match(whatsapp.sent[0].text, /GENERAL/)
  assert.match(whatsapp.sent[0].text, /!help/)
  assert.doesNotMatch(whatsapp.sent[0].text, /!secret/)

  await registry.dispatch(message('menu-numbered', 'numbered@s.whatsapp.net', '!menu 1'))
  assert.match(whatsapp.sent[1].text, /GENERAL/)
  assert.match(whatsapp.sent[1].text, /\*1\.\* !ping/)

  await registry.dispatch(message('menu-back', 'back@s.whatsapp.net', '!back'))
  assert.match(whatsapp.sent[2].text, /Listmenu/)
})

test('menu plugin follows the effective group prefix while retaining global fallback', async () => {
  const whatsapp = fakeWhatsapp()
  const registry = createRegistry(whatsapp, (incomingMessage, _services, fallback) => (
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
  const fallbackRegistry = createRegistry(fallbackWhatsapp, (incomingMessage, _services, fallback) => (
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

test('menu plugin renders paginated submenus and unknown-category guidance', async () => {
  const whatsapp = fakeWhatsapp()
  const registry = createRegistry(whatsapp)

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
  assert.match(whatsapp.sent[0].text, /!back/)

  await registry.dispatch(message('menu-unknown', 'unknown@s.whatsapp.net', '!m missing'))
  assert.match(whatsapp.sent[1].text, /tidak ditemukan/)
  assert.match(whatsapp.sent[1].text, /!menu/)
})
