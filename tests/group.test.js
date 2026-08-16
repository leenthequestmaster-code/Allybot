import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { groupPlugin } from '../dist/framework/plugins/group.js'
import { GroupConfigurationService } from '../dist/services/group-configuration-service.js'

const logger = pino({ level: 'silent' })

class FakeGroupCore {
  isConnected = true
  userJid = '628120000000@s.whatsapp.net'
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: '120363000000000000@g.us',
    subject: 'Allyssea Test Room',
    ownerJid: '628120000001@s.whatsapp.net',
    description: 'Room untuk pengujian group foundation.',
    participants: [
      { jid: '628120000001@s.whatsapp.net', role: 'superadmin' },
      { jid: '628120000002@s.whatsapp.net', role: 'admin' },
      { jid: '628120000003@s.whatsapp.net', role: 'member' },
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
    remoteJid: '628120000099@s.whatsapp.net',
    senderJid: '628120000099@s.whatsapp.net',
    text: '!groupinfo',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[0].text, /hanya dapat digunakan di dalam grup/)

  await core.emitMessage({
    id: 'info',
    remoteJid: core.metadata.jid,
    senderJid: '628120000003@s.whatsapp.net',
    text: '!groupinfo',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[1].text, /Allyssea Test Room/)
  assert.match(core.sent[1].text, /Member.*3/)

  await core.emitMessage({
    id: 'admins',
    remoteJid: core.metadata.jid,
    senderJid: '628120000003@s.whatsapp.net',
    text: '!admins',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.deepEqual(core.sent[2].options, { mentions: [
    '628120000001@s.whatsapp.net',
    '628120000002@s.whatsapp.net',
  ] })
  assert.match(core.sent[2].text, /@628120000001/)

  await core.emitMessage({
    id: 'memberinfo',
    remoteJid: core.metadata.jid,
    senderJid: '628120000003@s.whatsapp.net',
    mentionedJids: ['628120000002@s.whatsapp.net'],
    text: '!memberinfo @628120000002',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[3].text, /Admin/)

  await core.emitMessage({
    id: 'permissions',
    remoteJid: core.metadata.jid,
    senderJid: '628120000002@s.whatsapp.net',
    text: '!permissions',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[4].text, /Role : Admin/)

  await core.emitMessage({
    id: 'rules',
    remoteJid: core.metadata.jid,
    senderJid: '628120000003@s.whatsapp.net',
    text: '!rules',
    timestamp: Date.now(),
    fromMe: false,
  })
  assert.match(core.sent[5].text, /Aturan grup belum dikonfigurasi/)

  await app.stop()
  rmSync(directory, { recursive: true, force: true })
})
