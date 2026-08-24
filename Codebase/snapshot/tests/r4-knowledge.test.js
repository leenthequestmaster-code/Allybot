import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { createKnowledgePlugin } from '../dist/framework/plugins/knowledge.js'
import { KnowledgeService } from '../dist/services/knowledge-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const groupA = '<jid-redacted@g.us>'
const groupB = '<jid-redacted@g.us>'
const adminJid = '<jid-redacted@s.whatsapp.net>'
const memberJid = '<jid-redacted@s.whatsapp.net>'
const otherMemberJid = '<jid-redacted@s.whatsapp.net>'
const botJid = '<jid-redacted@s.whatsapp.net>'

function tempDatabase(prefix = 'allybot-r4-') {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'core.sqlite')
}

function cleanupDatabase(databasePath) {
  rmSync(databasePath, { force: true })
  rmSync(`${databasePath}-wal`, { force: true })
  rmSync(`${databasePath}-shm`, { force: true })
  rmSync(databasePath.replace(/core\.sqlite$/, ''), { recursive: true, force: true })
}

function serviceContext(services, databasePath) {
  return { logger, config: { commandPrefix: '!', defaultCooldownMs: 0, databasePath }, services }
}

function createFixture(options = {}) {
  const databasePath = tempDatabase()
  let now = 1_700_000_000_000
  const guardrails = new PlatformGuardrailService(databasePath, logger, { clock: () => now, maxHotAuditRecords: 200 })
  const services = { get(name) { if (name === 'platform-guardrails') return guardrails; throw new Error(`unknown service ${name}`) } }
  guardrails.initialize(serviceContext(services, databasePath))
  const knowledge = new KnowledgeService(databasePath, logger, { clock: () => now, defaultRetentionMs: 60_000, ...options })
  knowledge.initialize(serviceContext(services, databasePath))
  return { databasePath, guardrails, knowledge, advance(ms) { now += ms }, now: () => now }
}

function closeFixture(fixture) {
  fixture.knowledge.shutdown(serviceContext({}, fixture.databasePath))
  fixture.guardrails.shutdown(serviceContext({}, fixture.databasePath))
  cleanupDatabase(fixture.databasePath)
}

test('R4 default-off prevents explicit bookmark persistence', () => {
  const fixture = createFixture()
  try {
    assert.equal(fixture.knowledge.isEnabled(groupA), false)
    assert.throws(() => fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, title: 'Fact', excerpt: 'Explicit fact' }), /disabled/i)
  } finally {
    closeFixture(fixture)
  }
})

test('R4 bookmark requires explicit bounded source and keeps source identities hashed in returned metadata', () => {
  const fixture = createFixture()
  try {
    fixture.knowledge.setEnabled(groupA, true, adminJid, fixture.now())
    const record = fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, title: 'Scene rule', excerpt: 'A deliberately selected excerpt', sourceMessageId: 'wamid.source-1', sourceSenderJid: otherMemberJid, sourceTimestamp: fixture.now(), now: fixture.now() })
    assert.equal(record.excerpt, 'A deliberately selected excerpt')
    assert.notEqual(record.sourceMessageHash, 'wamid.source-1')
    assert.notEqual(record.sourceSenderHash, otherMemberJid)
    assert.equal(fixture.knowledge.listSources(groupB, memberJid).length, 0)
    assert.equal(fixture.knowledge.findSource(groupA, record.id.slice(0, 8), memberJid)?.id, record.id)
  } finally {
    closeFixture(fixture)
  }
})

test('R4 private visibility is creator-only while group visibility is readable by group members', () => {
  const fixture = createFixture()
  try {
    fixture.knowledge.setEnabled(groupA, true, adminJid, fixture.now())
    const privateRecord = fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, title: 'Private note', excerpt: 'Private source', visibility: 'private', now: fixture.now() })
    const groupRecord = fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, title: 'Group note', excerpt: 'Group source', visibility: 'group', now: fixture.now() })
    assert.equal(fixture.knowledge.listSources(groupA, otherMemberJid).map((record) => record.id).includes(privateRecord.id), false)
    assert.equal(fixture.knowledge.listSources(groupA, otherMemberJid).map((record) => record.id).includes(groupRecord.id), true)
    assert.equal(fixture.knowledge.findSource(groupA, privateRecord.id.slice(0, 8), otherMemberJid), undefined)
    assert.equal(fixture.knowledge.findSource(groupA, privateRecord.id.slice(0, 8), memberJid)?.id, privateRecord.id)
  } finally {
    closeFixture(fixture)
  }
})

test('R4 search is group-scoped, visibility-aware, and escapes LIKE wildcards', () => {
  const fixture = createFixture()
  try {
    fixture.knowledge.setEnabled(groupA, true, adminJid, fixture.now())
    fixture.knowledge.setEnabled(groupB, true, adminJid, fixture.now())
    const privateRecord = fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, title: 'Private scene', excerpt: 'private only', visibility: 'private', now: fixture.now() })
    const visibleRecord = fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, title: 'Scene 100% rule', excerpt: 'Use the scene marker', visibility: 'group', now: fixture.now() })
    assert.deepEqual(new Set(fixture.knowledge.searchSources(groupA, memberJid, 'scene').map((record) => record.id)), new Set([visibleRecord.id, privateRecord.id]))
    assert.equal(fixture.knowledge.searchSources(groupA, otherMemberJid, 'scene').some((record) => record.id === privateRecord.id), false)
    assert.equal(fixture.knowledge.searchSources(groupA, otherMemberJid, '100%').length, 1)
    assert.equal(fixture.knowledge.searchSources(groupB, otherMemberJid, 'scene').length, 0)
  } finally {
    closeFixture(fixture)
  }
})

test('R4 retention retires expired records and excludes them from active lookup', () => {
  const fixture = createFixture()
  try {
    fixture.knowledge.setEnabled(groupA, true, adminJid, fixture.now())
    const record = fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, excerpt: 'Short retention', retentionMs: 60_000, now: fixture.now() })
    fixture.advance(60_001)
    assert.equal(fixture.knowledge.findSource(groupA, record.id.slice(0, 8), memberJid), undefined)
    assert.equal(fixture.knowledge.getSource(record.id)?.status, 'retired')
    assert.equal(fixture.knowledge.listSources(groupA, memberJid, 'retired').length, 1)
  } finally {
    closeFixture(fixture)
  }
})

test('R4 delete removes excerpt from hot record and export', () => {
  const fixture = createFixture()
  try {
    fixture.knowledge.setEnabled(groupA, true, adminJid, fixture.now())
    const record = fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, excerpt: 'Delete me', now: fixture.now() })
    assert.equal(fixture.knowledge.deleteSource(groupA, record.id.slice(0, 8), memberJid, fixture.now())?.status, 'deleted')
    assert.equal(fixture.knowledge.getSource(record.id)?.excerpt, '')
    assert.equal(fixture.knowledge.exportSources(groupA, memberJid).length, 0)
  } finally {
    closeFixture(fixture)
  }
})

test('R4 source prefixes are group-scoped and ambiguous prefixes fail closed', () => {
  const fixture = createFixture()
  try {
    fixture.knowledge.setEnabled(groupA, true, adminJid, fixture.now())
    const record = fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, excerpt: 'Scoped', now: fixture.now() })
    assert.equal(fixture.knowledge.findSource(groupB, record.id.slice(0, 8), memberJid), undefined)
    assert.equal(fixture.knowledge.findSource(groupA, record.id.slice(0, 3), memberJid), undefined)
  } finally {
    closeFixture(fixture)
  }
})

test('R4 audit metadata redacts raw group, actor, source id, and excerpt', () => {
  const fixture = createFixture()
  try {
    fixture.knowledge.setEnabled(groupA, true, adminJid, fixture.now())
    fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, title: 'Redaction test', excerpt: 'private quoted body', sourceMessageId: 'wamid-raw-source', sourceSenderJid: otherMemberJid, now: fixture.now() })
    const auditText = JSON.stringify(fixture.guardrails.listAudit({ includeArchive: true, limit: 100 }))
    assert.equal(auditText.includes(groupA), false)
    assert.equal(auditText.includes(memberJid), false)
    assert.equal(auditText.includes('wamid-raw-source'), false)
    assert.equal(auditText.includes('private quoted body'), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R4 rejects sensitive-looking or oversized explicit source content', () => {
  const fixture = createFixture()
  try {
    fixture.knowledge.setEnabled(groupA, true, adminJid, fixture.now())
    assert.throws(() => fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, excerpt: 'Bearer abc.def.ghi' }), /sensitive/i)
    assert.throws(() => fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: memberJid, excerpt: 'x'.repeat(2_001) }), /too long/i)
  } finally {
    closeFixture(fixture)
  }
})

class KnowledgeCore {
  isConnected = true
  currentStatus = 'connected'
  userJid = botJid
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: groupA,
    subject: 'R4 Test Group',
    ownerJid: adminJid,
    participants: [
      { jid: adminJid, role: 'admin' },
      { jid: memberJid, role: 'member' },
      { jid: otherMemberJid, role: 'member' },
      { jid: botJid, role: 'admin' },
    ],
  }
  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener) }
  onGroupParticipantUpdate(listener) { this.participants.add(listener); return () => this.participants.delete(listener) }
  onConnectionState(listener) { this.connections.add(listener); return () => this.connections.delete(listener) }
  async sendText(remoteJid, text, options) { this.sent.push({ remoteJid, text, options }) }
  async getGroupMetadata() { return this.metadata }
  async getGroupInviteLink() { return undefined }
  async start() {}
  async close() {}
  async emitMessage(message) { await Promise.all([...this.messages].map((listener) => listener(message))) }
}

function groupMessage(id, senderJid, text, extra = {}) {
  return { id, remoteJid: groupA, senderJid, text, timestamp: Date.now(), fromMe: false, ...extra }
}

test('R4 plugin is default-off, admin-gated, explicit-reply-only, and has text fallback', async () => {
  const databasePath = tempDatabase('allybot-r4-plugin-')
  const core = new KnowledgeCore()
  const guardrails = new PlatformGuardrailService(databasePath, logger)
  const knowledge = new KnowledgeService(databasePath, logger)
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0, databasePath }, logger, core, { permissionResolver: createPermissionResolver(core) })
  app.registerService(guardrails)
  app.registerService(knowledge)
  app.registerPlugin(createKnowledgePlugin(core))
  await app.start()
  try {
    await core.emitMessage(groupMessage('member-off', memberJid, '!bookmark should fail', { quotedText: 'explicit text' }))
    assert.match(core.sent.at(-1).text, /belum aktif/i)
    await core.emitMessage(groupMessage('member-enable', memberJid, '!setknowledge on'))
    assert.match(core.sent.at(-1).text, /hanya dapat digunakan oleh admin/i)
    await core.emitMessage(groupMessage('admin-enable', adminJid, '!setknowledge on'))
    assert.match(core.sent.at(-1).text, /on/i)
    await core.emitMessage(groupMessage('member-no-quote', memberJid, '!bookmark title'))
    assert.match(core.sent.at(-1).text, /Reply pesan sumber/i)
    await core.emitMessage(groupMessage('member-bookmark', memberJid, '!bookmark Scene rule', { quotedText: 'Only this reply is captured', quotedSenderJid: otherMemberJid }))
    assert.match(core.sent.at(-1).text, /Bookmark [a-f0-9]{8}/i)
    const id = core.sent.at(-1).text.match(/Bookmark ([a-f0-9]{8})/i)?.[1]
    assert.ok(id)
    await core.emitMessage(groupMessage('member-source', memberJid, `!source ${id}`))
    assert.match(core.sent.at(-1).text, /Only this reply is captured/)
    await core.emitMessage(groupMessage('member-list', memberJid, '!bookmarks'))
    assert.match(core.sent.at(-1).text, /Scene rule/)
    await core.emitMessage(groupMessage('member-search', memberJid, '!find Only this'))
    assert.match(core.sent.at(-1).text, /Only this reply is captured/)
  } finally {
    await app.stop()
    cleanupDatabase(databasePath)
  }
})
