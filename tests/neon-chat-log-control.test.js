import assert from 'node:assert/strict'
import test from 'node:test'
import pino from 'pino'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'
import { createNeonChatLogPlugin, NEON_CHAT_LOG_SUPPRESSION_FEATURE_ID } from '../dist/framework/plugins/neon-chat-log.js'

const logger = pino({ level: 'silent' })
const groupJid = '120363000000000000@g.us'
const adminJid = '628120000002@s.whatsapp.net'
const memberJid = '628120000003@s.whatsapp.net'
const ownerJid = '628120000009@s.whatsapp.net'

class ChatLogCore {
  isConnected = true
  userJid = 'bot@s.whatsapp.net'
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: groupJid,
    subject: 'Chat Log Test Room',
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
  async sendText(remoteJid, text) { this.sent.push({ remoteJid, text }) }
  async getGroupMetadata() { return this.metadata }
  async start() {}
  async close() {}
  async emitMessage(message) { await Promise.all([...this.messages].map((listener) => listener(message))) }
}

function message(id, senderJid, text = 'hello', remoteJid = groupJid) {
  return { id, remoteJid, senderJid, text, timestamp: Date.now(), fromMe: false }
}

function pluginConfig() {
  return {
    NEON_CHAT_LOG_ENABLED: true,
    NEON_CHAT_LOG_GROUPS: groupJid,
    NEON_CHAT_LOG_QUEUE_CAPACITY: 10,
    NEON_CHAT_LOG_MAX_ATTEMPTS: 1,
    NEON_CHAT_LOG_RETRY_DELAY_MS: 1,
    NEON_CHAT_LOG_MAX_RETRY_DELAY_MS: 1,
    NEON_CHAT_LOG_DRAIN_TIMEOUT_MS: 100,
  }
}

function appFor(core, databasePath, sql, botOwnerJid = ownerJid) {
  const app = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid, databasePath },
    logger,
    core,
    { permissionResolver: createPermissionResolver(core, botOwnerJid) },
  )
  app.registerService(new PlatformGuardrailService(databasePath, logger))
  app.registerService({
    name: 'neon-client',
    isEnabled: true,
    getClient() { return sql },
  })
  app.registerPlugin(createNeonChatLogPlugin(pluginConfig()))
  return app
}

function tempDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-neon-control-'))
  return { directory, path: join(directory, 'runtime.sqlite') }
}

test('deprecated chatlog command is not registered even when the global flag is enabled', async () => {
  const { directory, path } = tempDatabase()
  const core = new ChatLogCore()
  const app = appFor(core, path, { async unsafe() {} })
  await app.start()
  assert.equal(app.commands.get('chatlog'), undefined)
  await core.emitMessage(message('deprecated-chatlog', memberJid, '!chatlog off'))
  assert.equal(core.sent.length, 0)
  await app.stop()
  rmSync(directory, { recursive: true, force: true })
})

test('chatlog command remains unavailable when the global Neon chat-log flag is disabled', async () => {
  const core = new ChatLogCore()
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0 }, logger, core)
  app.registerPlugin(createNeonChatLogPlugin({ NEON_CHAT_LOG_ENABLED: false }))
  await app.start()
  assert.equal(app.commands.get('chatlog'), undefined)
  await app.stop()
})

test('deprecated chatlog state is not exposed after restart', async () => {
  const { directory, path } = tempDatabase()
  const secondCore = new ChatLogCore()
  const second = appFor(secondCore, path, { async unsafe() {} })
  await second.start()
  assert.equal(second.commands.get('chatlog'), undefined)
  await second.stop()
  rmSync(directory, { recursive: true, force: true })
})
