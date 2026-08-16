import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import pino from 'pino'
import Database from 'better-sqlite3'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createAfkPlugin } from '../dist/framework/plugins/afk.js'
import { menuPlugin } from '../dist/framework/plugins/menu.js'
import { AfkService } from '../dist/services/afk-service.js'
import { GroupConfigurationService } from '../dist/services/group-configuration-service.js'

const logger = pino({ level: 'silent' })
const config = { commandPrefix: '!', defaultCooldownMs: 0 }

class FakeCore {
  isConnected = false
  userJid = 'bot@s.whatsapp.net'
  sent = []
  messages = new Set()
  groupParticipantListeners = new Set()
  connections = new Set()

  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener) }
  onGroupParticipantUpdate(listener) { this.groupParticipantListeners.add(listener); return () => this.groupParticipantListeners.delete(listener) }
  onConnectionState(listener) { this.connections.add(listener); return () => this.connections.delete(listener) }
  async sendText(remoteJid, text, options) { this.sent.push({ remoteJid, text, options }) }
  async start() {
    this.isConnected = true
    await Promise.all([...this.connections].map((listener) => listener({ status: 'connected', at: Date.now() })))
  }
  async close() {
    this.isConnected = false
    await Promise.all([...this.connections].map((listener) => listener({ status: 'idle', at: Date.now() })))
  }
  async emitMessage(message) {
    await Promise.all([...this.messages].map((listener) => listener(message)))
  }
}

function message(id, senderJid, remoteJid, text, mentionedJids = [], metadata = {}) {
  return {
    id,
    senderJid,
    remoteJid,
    text,
    mentionedJids,
    timestamp: Date.now(),
    fromMe: false,
    ...metadata,
  }
}

test('AFK plugin persists state, forwards every mention privately, and auto-unsets on return', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-afk-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))

  const core = new FakeCore()
  const app = new ApplicationFramework(config, logger, core, {
    prefixResolver: (message, services, fallback) => message.remoteJid.endsWith('@g.us')
      ? services.get('group-configuration').resolvePrefix(message.remoteJid, fallback)
      : fallback,
  })
  const afk = new AfkService(join(directory, 'core.sqlite'), logger)
  const groupConfiguration = new GroupConfigurationService(join(directory, 'core.sqlite'), logger)
  app.registerService(afk)
  app.registerService(groupConfiguration)
  app.registerPlugin(menuPlugin)
  app.registerPlugin(createAfkPlugin(core))
  await app.start()

  const groupJid = 'roleplay@g.us'
  const aliceJid = 'alice@s.whatsapp.net'
  const bobJid = 'bob@s.whatsapp.net'
  groupConfiguration.setPrefix(groupJid, '##', 'admin@s.whatsapp.net')

  await core.emitMessage(message('set-afk', aliceJid, groupJid, '!afk makan malam'))
  assert.match(core.sent[0].text, /sekarang AFK/)
  assert.equal(afk.getActive(aliceJid)?.reason, 'makan malam')

  await core.emitMessage(message('mention-1', bobJid, groupJid, '@alice kamu di mana?', [aliceJid], {
    groupName: 'Kansei',
    quotedText: 'Kamu ada di mana?'
  }))
  assert.equal(core.sent.length, 3)
  assert.equal(core.sent[1].remoteJid, groupJid)
  assert.match(core.sent[1].text, /Mention kamu sudah diteruskan/)
  assert.equal(core.sent[2].remoteJid, aliceJid)
  assert.match(core.sent[2].text, /menyebutmu ketika kamu AFK/)
  assert.match(core.sent[2].text, /Grup.*Kansei/)
  assert.match(core.sent[2].text, /Pesan.*@alice kamu di mana/)
  assert.match(core.sent[2].text, /Reply.*Kamu ada di mana/)
  assert.equal(afk.getMentions(aliceJid)[0]?.groupName, 'Kansei')
  assert.equal(afk.getMentions(aliceJid)[0]?.messageText, '@alice kamu di mana?')
  assert.equal(afk.getMentions(aliceJid)[0]?.quotedText, 'Kamu ada di mana?')
  assert.equal(afk.getActive(aliceJid)?.searchCount, 1)

  await core.emitMessage(message('mention-2', bobJid, groupJid, '@alice tolong jawab', [aliceJid]))
  assert.equal(core.sent.length, 5)
  assert.deepEqual(core.sent.at(-1)?.options?.mentions, [bobJid])
  assert.equal(afk.getActive(aliceJid)?.searchCount, 2)

  await core.emitMessage(message('reply-only', bobJid, groupJid, 'aku balas pesanmu', [], {
    groupName: 'Kansei',
    quotedText: 'alice, nanti kabari ya',
    quotedSenderJid: aliceJid,
  }))
  assert.equal(core.sent.length, 7)
  assert.equal(afk.getActive(aliceJid)?.searchCount, 3)
  assert.deepEqual(core.sent.at(-1)?.options?.mentions, [bobJid])
  assert.match(core.sent.at(-1)?.text ?? '', /Pesan.*aku balas pesanmu/)

  await core.emitMessage(message('private-status', aliceJid, groupJid, '!afk status'))
  assert.equal(core.sent.at(-1)?.remoteJid, aliceJid)
  assert.match(core.sent.at(-1)?.text ?? '', /makan malam/)

  await core.emitMessage(message('return', aliceJid, groupJid, 'aku kembali'))
  assert.equal(afk.getActive(aliceJid), undefined)
  assert.equal(core.sent.at(-1)?.remoteJid, groupJid)
  assert.match(core.sent.at(-1)?.text ?? '', /Selamat datang kembali/)
  assert.equal(afk.totalRecorded(), 1)
  assert.equal(afk.listLeaderboard()[0]?.userJid, aliceJid)

  await app.stop()
})

test('AFK migration converts legacy mention timestamps from seconds to milliseconds', (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-afk-migration-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))

  const databasePath = join(directory, 'allybot-afk.sqlite')
  const legacy = new Database(databasePath)
  legacy.exec(`
    CREATE TABLE afk_mentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      afk_user_jid TEXT NOT NULL,
      seeker_jid TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      mentioned_at INTEGER NOT NULL
    );
  `)
  legacy.prepare(
    'INSERT INTO afk_mentions (afk_user_jid, seeker_jid, chat_jid, mentioned_at) VALUES (?, ?, ?, ?)',
  ).run('alice@s.whatsapp.net', 'bob@s.whatsapp.net', 'roleplay@g.us', 1_700_000_000)
  legacy.close()

  const afk = new AfkService(join(directory, 'core.sqlite'), logger)
  afk.initialize({})
  assert.equal(afk.getMentions('alice@s.whatsapp.net')[0]?.mentionedAt, 1_700_000_000_000)
  afk.shutdown({})
})
