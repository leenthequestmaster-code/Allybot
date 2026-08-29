import assert from 'node:assert/strict'
import { test } from 'node:test'
import pino from 'pino'
import { CommandRegistry } from '../dist/framework/command-registry.js'
import { EventBus } from '../dist/framework/event-bus.js'
import { ServiceRegistry } from '../dist/framework/service-registry.js'
import { menuPlugin } from '../dist/framework/plugins/menu.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

function fakeWhatsapp({ media = false, mediaFailure = false } = {}) {
  const transport = {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    sent: [],
    media: [],
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text) { this.sent.push({ remoteJid, text }) },
    async start() {},
    async close() {},
  }
  if (media) {
    transport.sendMedia = async function sendMedia(remoteJid, payload) {
      this.media.push({ remoteJid, payload })
      if (mediaFailure) throw new Error('media transport unavailable')
    }
  }
  return transport
}

function message(id, remoteJid, text, options = {}) {
  return { id, remoteJid, text, timestamp: Date.now(), fromMe: false, ...options }
}

function createRegistry(whatsapp, prefixResolver, configOverrides = {}) {
  const events = new EventBus(logger)
  const services = new ServiceRegistry(logger)
  const effectiveConfig = { ...config, ...configOverrides }
  const registry = new CommandRegistry(effectiveConfig, logger, whatsapp, services, events, undefined, [], prefixResolver)
  menuPlugin.load?.({ logger, config: effectiveConfig, events, commands: registry, services })
  return { registry }
}

function registerCommand(registry, name, category, description = `${name} description`, options = {}) {
  registry.register({ name, category, description, handler: async () => {}, ...options })
}

test('!menu mengirim satu thumbnail dengan biodata dan deskripsi menu', async () => {
  const whatsapp = fakeWhatsapp({ media: true })
  const { registry } = createRegistry(whatsapp, undefined, { botOwnerJid: '628123456789@s.whatsapp.net' })
  registerCommand(registry, 'ping', 'general', 'Check bot latency')

  await registry.dispatch(message('menu-main', 'main@s.whatsapp.net', '!menu'))

  assert.equal(whatsapp.media.length, 1)
  assert.equal(whatsapp.sent.length, 0)
  assert.equal(whatsapp.media[0].payload.kind, 'image')
  assert.equal(whatsapp.media[0].payload.mimeType, 'image/jpeg')
  assert.ok(whatsapp.media[0].payload.data.length > 1000)
  assert.match(whatsapp.media[0].payload.caption, /Nama\s+: \*Allybot\*/)
  assert.match(whatsapp.media[0].payload.caption, /Uptime\s+: \*\d+[sm]/)
  assert.match(whatsapp.media[0].payload.caption, /Owner\s+: \*628••••6789\*/)
  assert.match(whatsapp.media[0].payload.caption, /Versi\s+: \*v0\.1\.0\*/)
  assert.match(whatsapp.media[0].payload.caption, /Balas dengan \*!menu 1\*/)
  assert.doesNotMatch(whatsapp.media[0].payload.caption, /DEVELOPER/)
})

test('!menu fallback ke satu pesan teks jika thumbnail tidak tersedia atau gagal', async () => {
  const unavailableWhatsapp = fakeWhatsapp()
  const { registry: unavailableRegistry } = createRegistry(unavailableWhatsapp)
  registerCommand(unavailableRegistry, 'ping', 'general')
  await unavailableRegistry.dispatch(message('text-menu', 'text@s.whatsapp.net', '!menu'))
  assert.equal(unavailableWhatsapp.sent.length, 1)
  assert.match(unavailableWhatsapp.sent[0].text, /PROFILE BOT/)
  assert.match(unavailableWhatsapp.sent[0].text, /Listmenu|ALLYBOT MENU/)

  const failedWhatsapp = fakeWhatsapp({ media: true, mediaFailure: true })
  const { registry: failedRegistry } = createRegistry(failedWhatsapp)
  registerCommand(failedRegistry, 'ping', 'general')
  await failedRegistry.dispatch(message('failed-menu', 'failed@s.whatsapp.net', '!menu'))
  assert.equal(failedWhatsapp.media.length, 1)
  assert.equal(failedWhatsapp.sent.length, 1)
  assert.match(failedWhatsapp.sent[0].text, /ALLYBOT MENU/)
})

test('navigasi kategori hanya menerima angka dan menampilkan submenu yang benar', async () => {
  const whatsapp = fakeWhatsapp()
  const { registry } = createRegistry(whatsapp)
  registerCommand(registry, 'groupinfo', 'group', 'Show group information')
  registerCommand(registry, 'ping', 'general', 'Check bot latency')

  await registry.dispatch(message('main', 'numeric@s.whatsapp.net', '!menu'))
  assert.match(whatsapp.sent[0].text, /\*1\.\* 👥 \*GROUP\*/)
  assert.match(whatsapp.sent[0].text, /\*2\.\* 🎭 \*YOUR CHARACTER\*/)

  await registry.dispatch(message('group-submenu', 'numeric@s.whatsapp.net', '!menu 1'))
  assert.match(whatsapp.sent[1].text, /GROUP/)
  assert.match(whatsapp.sent[1].text, /!groupinfo/)
  assert.doesNotMatch(whatsapp.sent[1].text, /!ping/)

  await registry.dispatch(message('character-submenu', 'numeric@s.whatsapp.net', '!menu 2'))
  assert.match(whatsapp.sent[2].text, /YOUR CHARACTER/)
  assert.match(whatsapp.sent[2].text, /!ping/)

  await registry.dispatch(message('named-category', 'numeric@s.whatsapp.net', '!menu tools-media'))
  assert.match(whatsapp.sent[3].text, /Kategori nomor \*tools-media\* tidak ditemukan/)

  await registry.dispatch(message('out-of-range', 'numeric@s.whatsapp.net', '!menu 99'))
  assert.match(whatsapp.sent[4].text, /Kategori nomor \*99\* tidak ditemukan/)
})

test('kategori privileged tidak tampil untuk member dan tampil untuk owner', async () => {
  const memberWhatsapp = fakeWhatsapp()
  const { registry: memberRegistry } = createRegistry(memberWhatsapp)
  registerCommand(memberRegistry, 'developer-help', 'developer')
  registerCommand(memberRegistry, 'owner-help', 'owner')
  await memberRegistry.dispatch(message('member-menu', 'member@s.whatsapp.net', '!menu'))
  assert.doesNotMatch(memberWhatsapp.sent[0].text, /DEVELOPER/)
  assert.doesNotMatch(memberWhatsapp.sent[0].text, /OWNER/)

  const ownerWhatsapp = fakeWhatsapp()
  const { registry: ownerRegistry } = createRegistry(ownerWhatsapp, undefined, { botOwnerJid: 'owner@s.whatsapp.net' })
  registerCommand(ownerRegistry, 'developer-help', 'developer')
  registerCommand(ownerRegistry, 'owner-help', 'owner')
  await ownerRegistry.dispatch(message('owner-menu', 'owner@s.whatsapp.net', '!menu', { senderJid: 'owner@s.whatsapp.net' }))
  assert.match(ownerWhatsapp.sent[0].text, /DEVELOPER/)
  assert.match(ownerWhatsapp.sent[0].text, /OWNER/)
  await ownerRegistry.dispatch(message('owner-developer', 'owner@s.whatsapp.net', '!menu 1', { senderJid: 'owner@s.whatsapp.net' }))
  assert.match(ownerWhatsapp.sent[1].text, /DEVELOPER/)
})

test('menu mengikuti effective prefix tanpa mengandalkan nama kategori', async () => {
  const whatsapp = fakeWhatsapp()
  const { registry } = createRegistry(whatsapp, (incomingMessage, _services, fallback) => (
    incomingMessage.remoteJid.endsWith('@g.us') ? '##' : fallback
  ))
  registerCommand(registry, 'ping', 'general')

  await registry.dispatch(message('custom-menu', 'group@g.us', '##menu'))
  assert.match(whatsapp.sent[0].text, /\*##menu 1\*/)
  assert.match(whatsapp.sent[0].text, /\*##menu\*/)

  await registry.dispatch(message('custom-submenu', 'group@g.us', '##menu 1'))
  assert.match(whatsapp.sent[1].text, /##ping/)
})
