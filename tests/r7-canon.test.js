import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { createCanonPlugin } from '../dist/framework/plugins/canon.js'
import { CanonService } from '../dist/services/canon-service.js'
import { KnowledgeService } from '../dist/services/knowledge-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const groupA = '120363100000000000@g.us'
const groupB = '120363100000000001@g.us'
const adminJid = '628130000001@s.whatsapp.net'
const userA = '628130000002@s.whatsapp.net'
const userB = '628130000003@s.whatsapp.net'
const botJid = '628130000009@s.whatsapp.net'
const initialNow = Date.UTC(2024, 0, 1, 12, 0, 0)

function tempDatabase(prefix = 'allybot-r7-') {
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

function createFixture() {
  const databasePath = tempDatabase()
  let now = initialNow
  const guardrails = new PlatformGuardrailService(databasePath, logger, { clock: () => now, maxHotAuditRecords: 500 })
  const knowledge = new KnowledgeService(databasePath, logger, { clock: () => now })
  const canon = new CanonService(databasePath, logger, { clock: () => now })
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'knowledge') return knowledge
      if (name === 'canon') return canon
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'knowledge' || name === 'canon' },
  }
  guardrails.initialize(serviceContext(services, databasePath))
  knowledge.initialize(serviceContext(services, databasePath))
  canon.initialize(serviceContext(services, databasePath))
  knowledge.setEnabled(groupA, true, adminJid, now)
  canon.setEnabled(groupA, true, adminJid, now)
  return { databasePath, guardrails, knowledge, canon, now: () => now, advance(ms) { now += ms }, services }
}

function closeFixture(fixture) {
  fixture.canon.shutdown(serviceContext(fixture.services, fixture.databasePath))
  fixture.knowledge.shutdown()
  fixture.guardrails.shutdown(serviceContext(fixture.services, fixture.databasePath))
  cleanupDatabase(fixture.databasePath)
}

function addAndPropose(fixture, input = {}) {
  const record = fixture.canon.addCanon({ groupJid: groupA, creatorJid: userA, title: 'World Rule', content: 'The city has a night curfew.', ...input })
  const proposed = fixture.canon.propose(groupA, record.id, userA)
  return { record, proposed }
}

test('R7 default-off blocks canon persistence until group flag is enabled', () => {
  const fixture = createFixture()
  try {
    assert.equal(fixture.canon.isEnabled(groupB), false)
    assert.throws(() => fixture.canon.addCanon({ groupJid: groupB, creatorJid: userA, title: 'Blocked', content: 'No write.' }), /disabled/i)
    fixture.canon.setEnabled(groupB, true, adminJid)
    assert.equal(fixture.canon.addCanon({ groupJid: groupB, creatorJid: userA, title: 'Allowed', content: 'Scoped.' }).status, 'draft')
  } finally {
    closeFixture(fixture)
  }
})

test('R7 draft and proposed entries are hidden from other group members', () => {
  const fixture = createFixture()
  try {
    const added = fixture.canon.addCanon({ groupJid: groupA, creatorJid: userA, title: 'Hidden Rule', content: 'Draft text.' })
    assert.equal(fixture.canon.getVisible(groupA, added.id, userB), undefined)
    assert.equal(fixture.canon.listVisible(groupA, userB).some((record) => record.id === added.id), false)
    fixture.canon.propose(groupA, added.id, userA)
    assert.equal(fixture.canon.getVisible(groupA, added.id, userB), undefined)
    assert.equal(fixture.canon.getVisible(groupA, added.id, userA)?.status, 'proposed')
  } finally {
    closeFixture(fixture)
  }
})

test('R7 lifecycle requires creator for propose and admin for approval at plugin boundary', () => {
  const fixture = createFixture()
  try {
    const added = fixture.canon.addCanon({ groupJid: groupA, creatorJid: userA, title: 'Authority Rule', content: 'Creator owned.' })
    assert.throws(() => fixture.canon.propose(groupA, added.id, userB), /creator/i)
    const proposed = fixture.canon.propose(groupA, added.id, userA)
    assert.equal(proposed.status, 'proposed')
    const approved = fixture.canon.approve(groupA, added.id, adminJid, proposed.revision)
    assert.equal(approved.status, 'approved')
    assert.equal(fixture.canon.getVisible(groupA, added.id, userB)?.content, 'Creator owned.')
  } finally {
    closeFixture(fixture)
  }
})

test('R7 approval uses revision CAS and rejects stale concurrent intent', () => {
  const fixture = createFixture()
  try {
    const { record, proposed } = addAndPropose(fixture)
    assert.equal(proposed.revision, 1)
    const approved = fixture.canon.approve(groupA, record.id, adminJid, proposed.revision)
    assert.equal(approved.revision, 2)
    assert.throws(() => fixture.canon.approve(groupA, record.id, adminJid, proposed.revision), /proposed|stale/i)
    const second = addAndPropose(fixture, { title: 'Another Rule', content: 'Another value.' })
    assert.throws(() => fixture.canon.approve(groupA, second.record.id, adminJid, 0), /stale/i)
  } finally {
    closeFixture(fixture)
  }
})

test('R7 approving a replacement supersedes old canon without deleting history', () => {
  const fixture = createFixture()
  try {
    const first = addAndPropose(fixture, { content: 'First curfew rule.' })
    fixture.canon.approve(groupA, first.record.id, adminJid, first.proposed.revision)
    const replacement = addAndPropose(fixture, { content: 'Updated curfew rule.' })
    const approved = fixture.canon.approve(groupA, replacement.record.id, adminJid, replacement.proposed.revision)
    assert.equal(approved.status, 'approved')
    assert.equal(fixture.canon.getVisible(groupA, first.record.id, userA)?.status, 'superseded')
    assert.equal(fixture.canon.search(groupA, userB, 'curfew').records.length, 1)
    const history = fixture.canon.history(groupA, first.record.id, userA)
    assert.deepEqual(history.map((entry) => entry.action), ['created', 'proposed', 'approved', 'superseded'])
  } finally {
    closeFixture(fixture)
  }
})

test('R7 source reference is explicit, group-scoped, and never copied as canon instruction', () => {
  const fixture = createFixture()
  try {
    const source = fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: userA, title: 'Meeting source', excerpt: 'The council approved a bounded note.' })
    const record = fixture.canon.addCanon({ groupJid: groupA, creatorJid: userA, title: 'Sourced Rule', content: 'The council note is referenced for review.', sourceId: source.id })
    assert.equal(record.sourceId, source.id)
    assert.equal(record.content.includes(source.excerpt), false)
    assert.throws(() => fixture.canon.addCanon({ groupJid: groupA, creatorJid: userB, title: 'Bad source', content: 'No access.', sourceId: '00000000-0000-0000-0000-000000000000' }), /source reference/i)
    fixture.canon.setEnabled(groupB, true, adminJid)
    assert.equal(fixture.canon.getVisible(groupB, record.id, userA), undefined)
  } finally {
    closeFixture(fixture)
  }
})

test('R7 search returns deterministic uncertainty marker instead of inventing a winner', () => {
  const fixture = createFixture()
  try {
    const first = addAndPropose(fixture, { title: 'World', content: 'There is a north gate.' })
    fixture.canon.approve(groupA, first.record.id, adminJid, first.proposed.revision)
    const second = addAndPropose(fixture, { title: 'world', content: 'There is a south gate.' })
    fixture.canon.approve(groupA, second.record.id, adminJid, second.proposed.revision)
    const result = fixture.canon.search(groupA, userB, 'gate')
    assert.equal(result.records.length, 2)
    assert.equal(result.uncertainty, 'conflicting-approved-records')
  } finally {
    closeFixture(fixture)
  }
})

test('R7 rejects cross-group references and preserves source group tenancy', () => {
  const fixture = createFixture()
  try {
    fixture.canon.setEnabled(groupB, true, adminJid)
    const record = fixture.canon.addCanon({ groupJid: groupA, creatorJid: userA, title: 'Group A Rule', content: 'Only group A.' })
    assert.equal(fixture.canon.getVisible(groupB, record.id, userB), undefined)
    assert.throws(() => fixture.canon.propose(groupB, record.id, userA), /tidak ditemukan|Canon/i)
    assert.equal(fixture.canon.listVisible(groupB, userB).length, 0)
  } finally {
    closeFixture(fixture)
  }
})

test('R7 audit output redacts raw JIDs, title, content, and canon/source IDs', () => {
  const fixture = createFixture()
  try {
    const source = fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: userA, title: 'Sensitive source', excerpt: 'Explicit source text.' })
    const record = fixture.canon.addCanon({ groupJid: groupA, creatorJid: userA, title: 'Sensitive canon title', content: 'Sensitive canon content.', sourceId: source.id })
    fixture.canon.propose(groupA, record.id, userA)
    fixture.canon.approve(groupA, record.id, adminJid)
    const auditText = JSON.stringify(fixture.guardrails.listAudit({ includeArchive: true, limit: 500 }))
    assert.equal(auditText.includes(groupA), false)
    assert.equal(auditText.includes(userA), false)
    assert.equal(auditText.includes('Sensitive canon title'), false)
    assert.equal(auditText.includes('Sensitive canon content.'), false)
    assert.equal(auditText.includes(record.id), false)
    assert.equal(auditText.includes(source.id), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R7 canon and history survive service restart', () => {
  const fixture = createFixture()
  try {
    const { record, proposed } = addAndPropose(fixture)
    fixture.canon.approve(groupA, record.id, adminJid, proposed.revision)
    fixture.canon.shutdown(serviceContext(fixture.services, fixture.databasePath))
    fixture.canon.initialize(serviceContext(fixture.services, fixture.databasePath))
    assert.equal(fixture.canon.getVisible(groupA, record.id, userB)?.status, 'approved')
    assert.equal(fixture.canon.history(groupA, record.id, userB).length, 3)
  } finally {
    closeFixture(fixture)
  }
})

class CanonCore {
  isConnected = true
  currentStatus = 'connected'
  userJid = botJid
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: groupA,
    subject: 'Canon Test Group',
    ownerJid: adminJid,
    participants: [
      { jid: adminJid, role: 'admin' },
      { jid: userA, role: 'member' },
      { jid: userB, role: 'member' },
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

function groupMessage(id, senderJid, text) {
  return { id, remoteJid: groupA, senderJid, text, timestamp: initialNow, fromMe: false }
}

test('R7 plugin is default-off, admin-gated, text-only, and exposes conflict fallback', async () => {
  const databasePath = tempDatabase('allybot-r7-plugin-')
  const core = new CanonCore()
  const guardrails = new PlatformGuardrailService(databasePath, logger)
  const knowledge = new KnowledgeService(databasePath, logger)
  const canon = new CanonService(databasePath, logger)
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'knowledge') return knowledge
      if (name === 'canon') return canon
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'knowledge' || name === 'canon' },
  }
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0, databasePath }, logger, core, { permissionResolver: createPermissionResolver(core) })
  app.registerService(guardrails)
  app.registerService(knowledge)
  app.registerService(canon)
  app.registerPlugin(createCanonPlugin(core))
  await app.start()
  try {
    await core.emitMessage(groupMessage('off', userA, '!canon add Blocked :: no write'))
    assert.match(core.sent.at(-1).text, /belum aktif/i)
    await core.emitMessage(groupMessage('bad-toggle', userA, '!setcanon on'))
    assert.match(core.sent.at(-1).text, /hanya dapat digunakan oleh admin/i)
    await core.emitMessage(groupMessage('toggle', adminJid, '!setcanon on'))
    assert.match(core.sent.at(-1).text, /on/i)
    await core.emitMessage(groupMessage('add', userA, '!canon add Town Rule :: The town has a bell'))
    assert.match(core.sent.at(-1).text, /Draft canon dibuat/i)
    const draftId = canon.listVisible(groupA, userA)[0].id.slice(0, 8)
    await core.emitMessage(groupMessage('propose', userA, `!canon propose ${draftId}`))
    assert.match(core.sent.at(-1).text, /diajukan/i)
    await core.emitMessage(groupMessage('approve-denied', userB, `!canon approve ${draftId}`))
    assert.match(core.sent.at(-1).text, /admin grup/i)
    await core.emitMessage(groupMessage('approve', adminJid, `!canon approve ${draftId}`))
    assert.match(core.sent.at(-1).text, /Canon diperbarui/i)
    await core.emitMessage(groupMessage('help', userB, '!canon unknown'))
    assert.match(core.sent.at(-1).text, /canon add/i)
  } finally {
    await app.stop()
    cleanupDatabase(databasePath)
  }
})
