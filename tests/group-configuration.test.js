import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { groupPlugin } from '../dist/framework/plugins/group.js'
import { GroupConfigurationService } from '../dist/services/group-configuration-service.js'
import { createPermissionResolver } from '../dist/permissions.js'

const logger = pino({ level: 'silent' })
const groupA = '120363000000000001@g.us'
const groupB = '120363000000000002@g.us'
const adminJid = '628120000002@s.whatsapp.net'
const memberJid = '628120000003@s.whatsapp.net'

class GroupConfigurationCore {
  isConnected = true
  userJid = '628120000000@s.whatsapp.net'
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: groupA,
    subject: 'Configuration Test Room',
    ownerJid: '628120000001@s.whatsapp.net',
    participants: [
      { jid: '628120000001@s.whatsapp.net', role: 'superadmin' },
      { jid: adminJid, role: 'admin' },
      { jid: memberJid, role: 'member' },
    ],
  }

  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener) }
  onGroupParticipantUpdate(listener) { this.participants.add(listener); return () => this.participants.delete(listener) }
  onConnectionState(listener) { this.connections.add(listener); return () => this.connections.delete(listener) }
  async sendText(remoteJid, text, options) { this.sent.push({ remoteJid, text, options }) }
  async getGroupMetadata(groupJid) { return { ...this.metadata, jid: groupJid } }
  async getGroupInviteLink() { return undefined }
  async start() {}
  async close() {}
  async emitMessage(message) { await Promise.all([...this.messages].map((listener) => listener(message))) }
}

function message(id, remoteJid, senderJid, text) {
  return { id, remoteJid, senderJid, text, timestamp: Date.now(), fromMe: false }
}

function createApp(core, databasePath) {
  const app = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0 },
    logger,
    core,
    {
      permissionResolver: createPermissionResolver(core),
      prefixResolver: (message, services, fallback) => message.remoteJid.endsWith('@g.us')
        ? services.get('group-configuration').resolvePrefix(message.remoteJid, fallback)
        : fallback,
    },
  )
  app.registerService(new GroupConfigurationService(databasePath, logger))
  app.registerPlugin(groupPlugin)
  return app
}

test('group rules require admin access, stay isolated by group, validate input, and persist after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-group-config-test-'))
  const databasePath = join(directory, 'core.sqlite')
  const core = new GroupConfigurationCore()

  try {
    const app = createApp(core, databasePath)
    await app.start()

    await core.emitMessage(message('member-set', groupA, memberJid, '!setrules Jangan spam.'))
    assert.equal(core.sent[0].text, 'Maaf, command ini hanya dapat digunakan oleh admin grup.')

    await core.emitMessage(message('admin-set', groupA, adminJid, '!setrules Saling menghormati dan tidak spam.'))
    assert.match(core.sent[1].text, /Aturan grup berhasil disimpan/)
    assert.match(core.sent[1].text, /Saling menghormati dan tidak spam\./)

    await core.emitMessage(message('member-read', groupA, memberJid, '!rules'))
    assert.match(core.sent[2].text, /Saling menghormati dan tidak spam\./)

    await core.emitMessage(message('other-group-read', groupB, memberJid, '!rules'))
    assert.match(core.sent[3].text, /Aturan grup belum dikonfigurasi/)

    await core.emitMessage(message('too-long', groupA, adminJid, `!setrules ${'x'.repeat(2001)}`))
    assert.match(core.sent[4].text, /terlalu panjang/)

    await core.emitMessage(message('member-clear', groupA, memberJid, '!clearrules'))
    assert.equal(core.sent[5].text, 'Maaf, command ini hanya dapat digunakan oleh admin grup.')

    await core.emitMessage(message('admin-set-persisted', groupA, adminJid, '!setrules Rules yang bertahan setelah restart.'))
    assert.match(core.sent[6].text, /berhasil disimpan/)
    await app.stop()

    core.sent = []
    const restartedApp = createApp(core, databasePath)
    await restartedApp.start()
    await core.emitMessage(message('after-restart', groupA, memberJid, '!rules'))
    assert.match(core.sent[0].text, /Rules yang bertahan setelah restart\./)

    await core.emitMessage(message('admin-clear', groupA, adminJid, '!clearrules'))
    assert.equal(core.sent[1].text, '✅ Aturan grup berhasil dihapus.')

    await core.emitMessage(message('after-clear', groupA, memberJid, '!rules'))
    assert.match(core.sent[2].text, /Aturan grup belum dikonfigurasi/)
    await restartedApp.stop()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('setrules returns guidance when no rule text is provided', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-group-config-format-'))
  const core = new GroupConfigurationCore()
  const app = createApp(core, join(directory, 'core.sqlite'))

  try {
    await app.start()
    await core.emitMessage(message('empty-rules', groupA, adminJid, '!setrules'))
    assert.match(core.sent[0].text, /Format: !setrules <aturan grup>/)
    await app.stop()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('welcome and leave configuration commands are admin-only and expose active settings', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-group-config-messages-'))
  const core = new GroupConfigurationCore()
  const app = createApp(core, join(directory, 'core.sqlite'))

  try {
    await app.start()
    await core.emitMessage(message('member-welcome', groupA, memberJid, '!setwelcome Halo {{user}}.'))
    assert.equal(core.sent[0].text, 'Maaf, command ini hanya dapat digunakan oleh admin grup.')

    await core.emitMessage(message('admin-welcome', groupA, adminJid, '!setwelcome Halo {{user}} di {{group}}.'))
    assert.equal(core.sent[1].text, '✅ Pesan welcome custom berhasil disimpan.')

    await core.emitMessage(message('admin-leave', groupA, adminJid, '!setleave Sampai jumpa {{user}}.'))
    assert.equal(core.sent[2].text, '✅ Pesan leave custom berhasil disimpan.')

    await core.emitMessage(message('clear-welcome', groupA, adminJid, '!clearwelcome'))
    assert.match(core.sent[3].text, /Pesan welcome custom berhasil dihapus/)

    await core.emitMessage(message('clear-leave', groupA, adminJid, '!clearleave'))
    assert.match(core.sent[4].text, /Pesan leave custom berhasil dihapus/)
    await app.stop()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('prefix configuration remains validated, group-scoped, and persistent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-group-config-preferences-'))
  const databasePath = join(directory, 'core.sqlite')
  const core = new GroupConfigurationCore()
  let app = createApp(core, databasePath)

  try {
    await app.start()
    await core.emitMessage(message('member-prefix', groupA, memberJid, '!setprefix ##'))
    assert.equal(core.sent[0].text, 'Maaf, command ini hanya dapat digunakan oleh admin grup.')

    await core.emitMessage(message('admin-prefix', groupA, adminJid, '!setprefix ##'))
    assert.match(core.sent[1].text, /Prefix grup berhasil diubah menjadi `##`/)

    await core.emitMessage(message('old-prefix', groupA, adminJid, '!prefix'))
    assert.match(core.sent[2].text, /Prefix aktif.*##/)

    await core.emitMessage(message('new-prefix', groupA, adminJid, '##prefix'))
    assert.match(core.sent[3].text, /Prefix aktif.*##/)

    await core.emitMessage(message('invalid-prefix', groupA, adminJid, '##setprefix abc'))
    assert.match(core.sent[4].text, /Prefix harus terdiri/)

    await core.emitMessage(message('change-prefix', groupA, adminJid, '##setprefix ??'))
    assert.match(core.sent[5].text, /Prefix grup berhasil diubah menjadi `\?\?`/)
    await app.stop()

    core.sent = []
    app = createApp(core, databasePath)
    await app.start()
    await core.emitMessage(message('after-restart', groupA, adminJid, '??prefix'))
    assert.match(core.sent[0].text, /Prefix aktif.*\?\?/)
    await core.emitMessage(message('fallback-prefix', groupA, adminJid, '!prefix'))
    assert.match(core.sent[1].text, /Prefix aktif.*\?\?/)

    await core.emitMessage(message('reset-prefix', groupA, adminJid, '??setprefix default'))
    assert.match(core.sent[2].text, /dikembalikan ke prefix global/)
    await app.stop()
  } finally {
    if (app.state.phase !== 'stopped') await app.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('deprecated group preference commands are not registered', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-group-config-history-'))
  const core = new GroupConfigurationCore()
  const app = createApp(core, join(directory, 'core.sqlite'))
  try {
    await app.start()
    for (const name of ['groupsettings', 'setlanguage', 'ruleshistory', 'settimezone']) {
      assert.equal(app.commands.get(name), undefined, `${name} must be deprecated`)
    }
    await app.stop()
  } finally {
    if (app.state.phase !== 'stopped') await app.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
