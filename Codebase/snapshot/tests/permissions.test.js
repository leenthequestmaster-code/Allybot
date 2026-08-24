import assert from 'node:assert/strict'
import { test } from 'node:test'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { groupPlugin } from '../dist/framework/plugins/group.js'
import { loadConfig, publicConfig } from '../dist/config.js'

const logger = pino({ level: 'silent' })

class PermissionCore {
  isConnected = true
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: '<jid-redacted@g.us>',
    subject: 'Permission Test Room',
    ownerJid: '<jid-redacted@s.whatsapp.net>',
    participants: [
      { jid: '<jid-redacted@s.whatsapp.net>', role: 'superadmin' },
      { jid: '<jid-redacted@s.whatsapp.net>', role: 'admin' },
      { jid: '<jid-redacted@s.whatsapp.net>', role: 'member' },
      { jid: '<jid-redacted@s.whatsapp.net>', role: 'member' },
    ],
  }

  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener) }
  onGroupParticipantUpdate(listener) { this.participants.add(listener); return () => this.participants.delete(listener) }
  onConnectionState(listener) { this.connections.add(listener); return () => this.connections.delete(listener) }
  async sendText(remoteJid, text) { this.sent.push({ remoteJid, text }) }
  async getGroupMetadata() { return this.metadata }
  async getGroupInviteLink() { return 'https://chat.whatsapp.com/test-invite-code' }
  async start() {}
  async close() {}
  async emitMessage(message) { await Promise.all([...this.messages].map((listener) => listener(message))) }
}

function appFor(core, botOwnerJid) {
  return new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid },
    logger,
    core,
    { permissionResolver: createPermissionResolver(core, botOwnerJid) },
  )
}

function message(id, remoteJid, senderJid, text) {
  return { id, remoteJid, senderJid, text, timestamp: Date.now(), fromMe: false }
}

test('group admin permission allows admins and denies regular members with a denial response', async () => {
  const core = new PermissionCore()
  const app = appFor(core)
  app.registerPlugin(groupPlugin)
  app.commands.register({
    name: 'adminprobe',
    permission: 'group.admin',
    handler: async ({ reply }) => reply('admin command accepted'),
  })
  await app.start()

  await core.emitMessage(message('member', core.metadata.jid, '<jid-redacted@s.whatsapp.net>', '!adminprobe'))
  assert.deepEqual(core.sent, [{
    remoteJid: core.metadata.jid,
    text: 'Maaf, command ini hanya dapat digunakan oleh admin grup.',
  }])

  await core.emitMessage(message('admin', core.metadata.jid, '<jid-redacted@s.whatsapp.net>', '!adminprobe'))
  assert.equal(core.sent[1].text, 'admin command accepted')

  await core.emitMessage(message('member-link', core.metadata.jid, '<jid-redacted@s.whatsapp.net>', '!link'))
  assert.equal(core.sent[2].text, 'Maaf, command ini hanya dapat digunakan oleh admin grup.')

  await core.emitMessage(message('admin-link', core.metadata.jid, '<jid-redacted@s.whatsapp.net>', '!link'))
  assert.equal(core.sent[3].text, '🔗 *Invite Link Grup*\nhttps://chat.whatsapp.com/test-invite-code')

  await app.stop()
})

test('configured bot owner bypasses group admin permission in groups', async () => {
  const core = new PermissionCore()
  const ownerJid = '<jid-redacted@s.whatsapp.net>'
  const app = appFor(core, ownerJid)
  app.commands.register({
    name: 'adminprobe',
    permission: 'group.admin',
    handler: async ({ reply }) => reply('admin command accepted'),
  })
  await app.start()

  await core.emitMessage(message('owner-admin', core.metadata.jid, ownerJid, '!adminprobe'))
  assert.equal(core.sent[0].text, 'admin command accepted')

  await core.emitMessage(message('member-admin', core.metadata.jid, '<jid-redacted@s.whatsapp.net>', '!adminprobe'))
  assert.equal(core.sent[1].text, 'Maaf, command ini hanya dapat digunakan oleh admin grup.')

  await app.stop()
})

test('bot owner permission works outside groups and group owner permission remains separate', async () => {
  const core = new PermissionCore()
  const ownerJid = '<jid-redacted@s.whatsapp.net>'
  const app = appFor(core, ownerJid)
  app.commands.register({
    name: 'ownerprobe',
    permission: 'bot.owner',
    handler: async ({ reply }) => reply('owner command accepted'),
  })
  app.commands.register({
    name: 'groupownerprobe',
    permission: 'group.owner',
    handler: async ({ reply }) => reply('group owner command accepted'),
  })
  app.commands.register({
    name: 'unknownprobe',
    permission: 'unknown.permission',
    handler: async ({ reply }) => reply('should not execute'),
  })
  await app.start()

  await core.emitMessage(message('owner-private', '<jid-redacted@s.whatsapp.net>', ownerJid, '!ownerprobe'))
  assert.equal(core.sent[0].text, 'owner command accepted')

  await core.emitMessage(message('member-private', '<jid-redacted@s.whatsapp.net>', '<jid-redacted@s.whatsapp.net>', '!ownerprobe'))
  assert.equal(core.sent[1].text, 'Maaf, command ini hanya tersedia untuk owner Allybot.')

  await core.emitMessage(message('creator-group', core.metadata.jid, '<jid-redacted@s.whatsapp.net>', '!groupownerprobe'))
  assert.equal(core.sent[2].text, 'group owner command accepted')

  await core.emitMessage(message('admin-group', core.metadata.jid, '<jid-redacted@s.whatsapp.net>', '!groupownerprobe'))
  assert.equal(core.sent[3].text, 'Maaf, command ini hanya dapat digunakan oleh pembuat grup.')

  await core.emitMessage(message('unknown-group', core.metadata.jid, '<jid-redacted@s.whatsapp.net>', '!unknownprobe'))
  assert.equal(core.sent[4].text, 'Maaf, kamu belum memiliki izin untuk menggunakan command ini.')

  await app.stop()
})

test('BOT_OWNER_JID accepts a phone JID and stays out of publicConfig', () => {
  const config = loadConfig({ NODE_ENV: 'test', BOT_OWNER_JID: '<jid-redacted@s.whatsapp.net>' })
  assert.equal(config.BOT_OWNER_JID, '<jid-redacted@s.whatsapp.net>')
  assert.equal('botOwnerJid' in publicConfig(config), false)
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', BOT_OWNER_JID: 'not-a-jid' }),
    /Invalid Allybot configuration/,
  )
})

test('group role and permissions identify the configured bot owner', async () => {
  const core = new PermissionCore()
  const ownerJid = '<jid-redacted@s.whatsapp.net>'
  const app = appFor(core, ownerJid)
  app.registerPlugin(groupPlugin)
  await app.start()

  await core.emitMessage(message('owner-role', core.metadata.jid, ownerJid, '!role'))
  assert.equal(core.sent[0].text, '↳ @<phone-redacted> memiliki role *Bot Owner*.')

  await core.emitMessage(message('owner-permissions', core.metadata.jid, ownerJid, '!permissions'))
  assert.match(core.sent[1].text, /Role : Bot Owner/)
  assert.match(core.sent[1].text, /Menggunakan command bot owner/)

  await app.stop()
})
