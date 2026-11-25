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

function socketWhatsapp(configOverrides = {}) {
  const relayed = []
  const whatsapp = {
    isConnected: true,
    userJid: 'bot@s.whatsapp.net',
    sent: [],
    relayed,
    socket: {
      user: { id: 'bot@s.whatsapp.net' },
      logger: { warn() {} },
      async relayMessage(jid, msg, options) {
        relayed.push({ jid, msg, options })
      },
    },
    onMessage() { return () => {} },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async sendText(remoteJid, text) { this.sent.push({ remoteJid, text }) },
  }
  const { registry } = createRegistry(whatsapp, undefined, configOverrides)
  return { whatsapp, registry, relayed }
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

test('!menu mengirim satu thumbnail dengan biodata dan ringkasan kategori menu', async () => {
  const whatsapp = fakeWhatsapp({ media: true })
  const { registry } = createRegistry(whatsapp, undefined, { botOwnerJid: '628123456789@s.whatsapp.net' })
  registerCommand(registry, 'ping', 'general', 'Check bot latency')

  await registry.dispatch(message('menu-main', '120363012345678901@g.us', '!menu'))

  assert.equal(whatsapp.media.length, 1)
  assert.equal(whatsapp.sent.length, 0)
  assert.equal(whatsapp.media[0].payload.kind, 'image')
  assert.equal(whatsapp.media[0].payload.mimeType, 'image/jpeg')
  assert.ok(whatsapp.media[0].payload.data.length > 1000)
  assert.match(whatsapp.media[0].payload.caption, /𝐀𝗹𝗹𝘆𝗯𝗼𝘁 𝐌𝗲𝗻𝘂/)
  assert.match(whatsapp.media[0].payload.caption, /Nama : \*Allybot\*/)
  assert.match(whatsapp.media[0].payload.caption, /TOOLS/)
  assert.doesNotMatch(whatsapp.media[0].payload.caption, /DEVELOPER/)
})

test('!menu fallback ke satu pesan teks jika thumbnail tidak tersedia atau gagal', async () => {
  const unavailableWhatsapp = fakeWhatsapp()
  const { registry: unavailableRegistry } = createRegistry(unavailableWhatsapp)
  registerCommand(unavailableRegistry, 'ping', 'general')
  await unavailableRegistry.dispatch(message('text-menu', '120363012345678902@g.us', '!menu'))
  assert.equal(unavailableWhatsapp.sent.length, 1)
  assert.match(unavailableWhatsapp.sent[0].text, /𝐀𝗹𝗹𝘆𝗯𝗼𝘁 𝐌𝗲𝗻𝘂/)
  assert.match(unavailableWhatsapp.sent[0].text, /TOOLS/)

  const failedWhatsapp = fakeWhatsapp({ media: true, mediaFailure: true })
  const { registry: failedRegistry } = createRegistry(failedWhatsapp)
  registerCommand(failedRegistry, 'ping', 'general')
  await failedRegistry.dispatch(message('failed-menu', '120363012345678903@g.us', '!menu'))
  assert.equal(failedWhatsapp.media.length, 1)
  assert.equal(failedWhatsapp.sent.length, 1)
  assert.match(failedWhatsapp.sent[0].text, /𝐀𝗹𝗹𝘆𝗯𝗼𝘁 𝐌𝗲𝗻𝘂/)
})

test('navigasi kategori angka & nama menampilkan submenu dengan deskripsi dan info nomor tidak valid', async () => {
  const whatsapp = fakeWhatsapp()
  const { registry } = createRegistry(whatsapp)
  registerCommand(registry, 'groupinfo', 'group', 'Show group information')
  registerCommand(registry, 'ping', 'general', 'Check bot latency')

  await registry.dispatch(message('main', '120363012345678904@g.us', '!menu'))
  assert.match(whatsapp.sent[0].text, /\[1\] 👥 GROUP/)
  assert.match(whatsapp.sent[0].text, /\[2\] 🧰 TOOLS/)

  await registry.dispatch(message('first-submenu', '120363012345678904@g.us', '!menu 1'))
  assert.match(whatsapp.sent[1].text, /GROUP/)
  assert.match(whatsapp.sent[1].text, /!groupinfo/)
  assert.doesNotMatch(whatsapp.sent[1].text, /!ping/)

  await registry.dispatch(message('second-submenu', '120363012345678904@g.us', '!menu 2'))
  assert.match(whatsapp.sent[2].text, /TOOLS/)
  assert.match(whatsapp.sent[2].text, /!ping/)

  await registry.dispatch(message('unknown-keyword', '120363012345678904@g.us', '!menu unknowncat'))
  assert.match(whatsapp.sent[3].text, /tidak ditemukan/)

  await registry.dispatch(message('out-of-range', '120363012345678904@g.us', '!menu 99'))
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

test('kategori admin/moderasi hanya tampil untuk admin grup dan disembunyikan untuk member biasa', async () => {
  const groupJid = '1203630123456789@g.us'
  const memberJid = 'member@s.whatsapp.net'
  const adminJid = 'admin@s.whatsapp.net'
  const groupMetadata = {
    jid: groupJid,
    subject: 'Test Group',
    participants: [
      { jid: memberJid, role: 'member' },
      { jid: adminJid, role: 'admin' },
    ],
  }
  const whatsapp = {
    ...fakeWhatsapp(),
    async getGroupMetadata(jid) {
      if (jid === groupJid) return groupMetadata
      throw new Error('Group not found')
    },
  }
  const { registry } = createRegistry(whatsapp)
  registerCommand(registry, 'kick', 'moderation', 'Keluarkan member', { permission: 'group.admin' })
  registerCommand(registry, 'ping', 'general', 'Check latency')

  await registry.dispatch({ id: 'm-1', remoteJid: groupJid, senderJid: memberJid, text: '!menu', timestamp: Date.now(), fromMe: false })
  assert.doesNotMatch(whatsapp.sent.at(-1)?.text ?? '', /ADMIN TOOLS/)

  await registry.dispatch({ id: 'm-2', remoteJid: groupJid, senderJid: adminJid, text: '!menu', timestamp: Date.now(), fromMe: false })
  assert.match(whatsapp.sent.at(-1)?.text ?? '', /ADMIN TOOLS/)
})

test('menu mengikuti effective prefix tanpa mengandalkan nama kategori', async () => {
  const whatsapp = fakeWhatsapp()
  const { registry } = createRegistry(whatsapp, (incomingMessage, _services, fallback) => (
    incomingMessage.remoteJid.endsWith('@g.us') ? '##' : fallback
  ))
  registerCommand(registry, 'ping', 'general')

  await registry.dispatch(message('custom-menu', '120363012345678906@g.us', '##menu'))
  assert.match(whatsapp.sent[0].text, /𝐀𝗹𝗹𝘆𝗯𝗼𝘁 𝐌𝗲𝗻𝘂/)
  assert.match(whatsapp.sent[0].text, /Nama : \*Allybot\*/)

  await registry.dispatch(message('custom-submenu', '120363012345678906@g.us', '##menu 1'))
  assert.match(whatsapp.sent[1].text, /##ping/)
})

test('!menu utama menggunakan multi single_select list di posisi awal bottom-sheet & cta_url kondisional', async () => {
  const { registry, relayed } = socketWhatsapp({ officialOocInviteLink: 'https://chat.whatsapp.com/TestInvite123' })
  registerCommand(registry, 'ping', 'general', 'Check bot latency')
  await registry.dispatch(message('interactive-menu', '120363012345678907@g.us', '!menu'))

  assert.equal(relayed.length, 1)
  const im = relayed[0].msg.interactiveMessage
  assert.ok(im)
  assert.match(im.body?.text, /𝐀𝗹𝗹𝘆𝗯𝗼𝘁 𝐌𝗲𝗻𝘂/)
  assert.doesNotMatch(im.body?.text, /Daftar Kategori/)
  const buttons = im.nativeFlowMessage?.buttons ?? []
  assert.equal(buttons.length, 3)
  assert.equal(buttons[0]?.name, 'single_select')
  assert.equal(buttons[1]?.name, 'single_select')
  assert.equal(buttons[2]?.name, 'cta_url')
  assert.equal(JSON.parse(buttons[0]?.buttonParamsJson ?? '{}').title, '📋 List Command')
  assert.equal(JSON.parse(buttons[1]?.buttonParamsJson ?? '{}').title, 'ℹ️ Information Bot')
  assert.equal(JSON.parse(buttons[2]?.buttonParamsJson ?? '{}').display_text, '🏛️ Grup Resmi')
})

test('!menu tanpa officialOocInviteLink tidak memasang tombol cta_url mati', async () => {
  const { registry, relayed } = socketWhatsapp({ officialOocInviteLink: '' })
  registerCommand(registry, 'ping', 'general', 'Check bot latency')
  await registry.dispatch(message('interactive-menu-no-url', '120363012345678908@g.us', '!menu'))

  assert.equal(relayed.length, 1)
  const buttons = relayed[0].msg.interactiveMessage?.nativeFlowMessage?.buttons ?? []
  assert.deepEqual(buttons.map((b) => b.name), ['single_select', 'single_select'])
})

test('!menu <category> menampilkan deskripsi singkat per command, list ganti kategori & tombol Menu Utama', async () => {
  const { registry, relayed } = socketWhatsapp()
  registerCommand(registry, 'ping', 'general', 'Check bot latency')
  await registry.dispatch(message('submenu-rich', '120363012345678905@g.us', '!menu 1'))

  assert.equal(relayed.length, 1)
  const im = relayed[0].msg.interactiveMessage
  assert.ok(im)
  assert.match(im.body?.text, /TOOLS/)
  assert.match(im.body?.text, /command tersedia/)
  assert.match(im.body?.text, /!ping/)
  assert.match(im.body?.text, /_.*_/)
  assert.match(im.body?.text, /© Allybot/)
  assert.doesNotMatch(im.body?.text, /Versi :/)

  const buttons = im.nativeFlowMessage?.buttons ?? []
  assert.deepEqual(buttons.map((b) => b.name), ['single_select', 'quick_reply'])
  assert.equal(JSON.parse(buttons[0]?.buttonParamsJson ?? '{}').title, '📋 Ganti Kategori')
  assert.equal(JSON.parse(buttons[1]?.buttonParamsJson ?? '{}').display_text, '⬅️ Menu Utama')
  assert.equal(JSON.parse(buttons[1]?.buttonParamsJson ?? '{}').id, '!menu')
})

test('!menu <kata kunci> mencari command sesuai deskripsi dan izin user dengan tombol Menu Utama', async () => {
  const { registry, relayed } = socketWhatsapp()
  registerCommand(registry, 'image', 'general', 'Cari gambar keren dari internet')
  registerCommand(registry, 'kick', 'moderation', 'Keluarkan member', { permission: 'group.admin' })

  await registry.dispatch(message('search-menu', '120363012345678909@g.us', '!menu gambar'))

  assert.equal(relayed.length, 1)
  const im = relayed[0].msg.interactiveMessage
  assert.match(im.body?.text, /Hasil Pencarian/)
  assert.match(im.body?.text, /!image/)
  const buttons = im.nativeFlowMessage?.buttons ?? []
  assert.equal(buttons.length, 1)
  assert.equal(buttons[0]?.name, 'quick_reply')
  assert.equal(JSON.parse(buttons[0]?.buttonParamsJson ?? '{}').id, '!menu')

  // Member biasa tidak boleh melihat command admin via keyword search
  await registry.dispatch(message('search-admin-blocked', '120363012345678909@g.us', '!menu keluarkan', { senderJid: 'member@s.whatsapp.net' }))
  const imBlocked = relayed[1].msg.interactiveMessage
  assert.match(imBlocked.body?.text, /tidak ditemukan/i)
  assert.doesNotMatch(imBlocked.body?.text, /!kick/)
})
