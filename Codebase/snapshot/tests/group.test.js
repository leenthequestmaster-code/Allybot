import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { groupPlugin } from '../dist/framework/plugins/group.js'
import { GroupConfigurationService } from '../dist/services/group-configuration-service.js'
import { isGroupJid } from '../dist/framework/validation.js'

const logger = pino({ level: 'silent' })

class FakeGroupCore {
  isConnected = true
  userJid = '<jid-redacted@s.whatsapp.net>'
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: '<jid-redacted@g.us>',
    subject: 'Allyssea Test Room',
    ownerJid: '<jid-redacted@s.whatsapp.net>',
    description: 'Room untuk pengujian group foundation.',
    participants: [
      { jid: '<jid-redacted@s.whatsapp.net>', role: 'superadmin' },
      { jid: '<jid-redacted@s.whatsapp.net>', role: 'admin' },
      { jid: '<jid-redacted@s.whatsapp.net>', role: 'member' },
    ],
  }

  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener) }
  onGroupParticipantUpdate(listener) { this.participants.add(listener); return () => this.participants.delete(listener) }
  onConnectionState(listener) { this.connections.add(listener); return () => this.connections.delete(listener) }
  async sendText(remoteJid, text, options) { this.sent.push({ remoteJid, text, options }) }
  async getGroupMetadata() { return this.metadata }
  async start() {}
  async close() {}
  async emitMessage(message) { await Promise.all([...this.messages].map((listener) => listener(message))) }
}

test('group foundation serves read-only metadata and clickable member lists', async () => {
  const core = new FakeGroupCore()
  const directory = mkdtempSync(join(tmpdir(), 'allybot-group-test-'))
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0 }, logger, core)
  app.registerService(new GroupConfigurationService(join(directory, 'core.sqlite'), logger))
  app.registerPlugin(groupPlugin)
  await app.start()

  await core.emitMessage({
    id: 'private',
    remoteJid: '<jid-redacted@s.whatsapp.net>',
    senderJid: '<jid-redacted@s.whatsapp.net>',
    text: '!groupinfo',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[0].text, /hanya dapat digunakan di dalam grup/)

  await core.emitMessage({
    id: 'info',
    remoteJid: core.metadata.jid,
    senderJid: '<jid-redacted@s.whatsapp.net>',
    text: '!groupinfo',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[1].text, /Allyssea Test Room/)
  assert.match(core.sent[1].text, /Member.*3/)

  await core.emitMessage({
    id: 'admins',
    remoteJid: core.metadata.jid,
    senderJid: '<jid-redacted@s.whatsapp.net>',
    text: '!admins',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.deepEqual(core.sent[2].options, { mentions: [
    '<jid-redacted@s.whatsapp.net>',
    '<jid-redacted@s.whatsapp.net>',
  ] })
  assert.match(core.sent[2].text, /@<phone-redacted>/)

  await core.emitMessage({
    id: 'memberinfo',
    remoteJid: core.metadata.jid,
    senderJid: '<jid-redacted@s.whatsapp.net>',
    mentionedJids: ['<jid-redacted@s.whatsapp.net>'],
    text: '!memberinfo @<phone-redacted>',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[3].text, /Admin/)

  await core.emitMessage({
    id: 'permissions',
    remoteJid: core.metadata.jid,
    senderJid: '<jid-redacted@s.whatsapp.net>',
    text: '!permissions',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[4].text, /Role : Admin/)

  await core.emitMessage({
    id: 'rules',
    remoteJid: core.metadata.jid,
    senderJid: '<jid-redacted@s.whatsapp.net>',
    text: '!rules',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[5].text, /Aturan grup belum dikonfigurasi/)

  await app.stop()
  rmSync(directory, { recursive: true, force: true })
})
test('group pagination uses the effective prefix and memberinfo accepts a quoted member', async () => {
  const core = new FakeGroupCore()
  core.metadata = {
    ...core.metadata,
    participants: Array.from({ length: 26 }, (_, index) => ({
      jid: `628120000${String(index + 1).padStart(3, '0')}@s.whatsapp.net`,
      role: index === 0 ? 'admin' : 'member',
    })),
  }
  const directory = mkdtempSync(join(tmpdir(), 'allybot-group-ux-test-'))
  const configuration = new GroupConfigurationService(join(directory, 'core.sqlite'), logger)
  const app = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0 },
    logger,
    core,
    {
      prefixResolver: (message, services, fallback) => isGroupJid(message.remoteJid)
        ? services.get('group-configuration').resolvePrefix(message.remoteJid, fallback)
        : fallback,
    },
  )
  app.registerService(configuration)
  app.registerPlugin(groupPlugin)
  await app.start()
  configuration.setPrefix(core.metadata.jid, '##', '<jid-redacted@s.whatsapp.net>')

  await core.emitMessage({
    id: 'members-custom-prefix',
    remoteJid: core.metadata.jid,
    senderJid: '<jid-redacted@s.whatsapp.net>',
    text: '##members',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[0].text, /Ketik ##members 2 untuk halaman berikutnya/)

  await core.emitMessage({
    id: 'memberinfo-quoted',
    remoteJid: core.metadata.jid,
    senderJid: '<jid-redacted@s.whatsapp.net>',
    quotedSenderJid: core.metadata.participants[0].jid,
    text: '##memberinfo',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[1].text, /Admin/)

  await app.stop()
  rmSync(directory, { recursive: true, force: true })
})

test('prefix command explains override source and reset path', async () => {
  const core = new FakeGroupCore()
  const directory = mkdtempSync(join(tmpdir(), 'allybot-prefix-ux-test-'))
  const configuration = new GroupConfigurationService(join(directory, 'core.sqlite'), logger)
  const app = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0 },
    logger,
    core,
    {
      prefixResolver: (message, services, fallback) => isGroupJid(message.remoteJid)
        ? services.get('group-configuration').resolvePrefix(message.remoteJid, fallback)
        : fallback,
      permissionResolver: (permission, context) => permission === 'group.admin' && context.message.senderJid === core.metadata.ownerJid,
    },
  )
  app.registerService(configuration)
  app.registerPlugin(groupPlugin)
  await app.start()
  configuration.setPrefix(core.metadata.jid, '##', core.metadata.ownerJid)

  await core.emitMessage({
    id: 'prefix-status',
    remoteJid: core.metadata.jid,
    senderJid: core.metadata.participants[2].jid,
    text: '##prefix',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[0].text, /Sumber.*Override grup/)
  assert.match(core.sent[0].text, /Prefix global.*!/)
  assert.match(core.sent[0].text, /Reset ke global: `##setprefix default`/)

  await core.emitMessage({
    id: 'prefix-reset',
    remoteJid: core.metadata.jid,
    senderJid: core.metadata.ownerJid,
    text: '##setprefix default',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[1].text, /dikembalikan ke prefix global/)

  await app.stop()
  rmSync(directory, { recursive: true, force: true })
})
