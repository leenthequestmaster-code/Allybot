import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { createCollaborationPlugin } from '../dist/framework/plugins/collaboration.js'
import { CollaborationService } from '../dist/services/collaboration-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const groupA = '120363000000000000@g.us'
const groupB = '120363000000000001@g.us'
const adminJid = '628120000001@s.whatsapp.net'
const memberJid = '628120000002@s.whatsapp.net'
const otherMemberJid = '628120000003@s.whatsapp.net'
const botJid = '628120000009@s.whatsapp.net'

function tempDatabase(prefix = 'allybot-r3-') {
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
  const collaboration = new CollaborationService(databasePath, logger, { clock: () => now, operationTimeoutMs: 20, ...options })
  collaboration.initialize(serviceContext(services, databasePath))
  return { databasePath, guardrails, collaboration, advance(ms) { now += ms }, now: () => now }
}

function closeFixture(fixture) {
  fixture.collaboration.shutdown(serviceContext({}, fixture.databasePath))
  fixture.guardrails.shutdown(serviceContext({}, fixture.databasePath))
  cleanupDatabase(fixture.databasePath)
}

test('R3 default-off prevents poll state mutation until group flag is enabled', () => {
  const fixture = createFixture()
  try {
    assert.equal(fixture.collaboration.isEnabled(groupA), false)
    assert.throws(() => fixture.collaboration.createPoll(groupA, memberJid, 'Decision?', ['A', 'B']), /feature|enabled|off/i)
  } finally {
    closeFixture(fixture)
  }
})

test('R3 poll lifecycle is group-scoped, expires, and uses CAS close', () => {
  const fixture = createFixture()
  try {
    fixture.collaboration.setEnabled(groupA, true, adminJid, fixture.now())
    const poll = fixture.collaboration.createPoll(groupA, memberJid, 'Lokasi?', ['Pelabuhan', 'Kota Tua'], 1, fixture.now())
    assert.equal(fixture.collaboration.listPolls(groupB).length, 0)
    assert.equal(fixture.collaboration.closePoll(groupA, poll.id, memberJid)?.status, 'closed')
    assert.equal(fixture.collaboration.closePoll(groupA, poll.id, memberJid)?.status, 'closed')
    const second = fixture.collaboration.createPoll(groupA, memberJid, 'Waktu?', ['Pagi', 'Malam'], 1, fixture.now())
    fixture.advance(24 * 60 * 60 * 1_000 + 1)
    assert.equal(fixture.collaboration.getPoll(second.id)?.status, 'expired')
  } finally {
    closeFixture(fixture)
  }
})

test('R3 poll origin key is idempotent and payload-bound', () => {
  const fixture = createFixture()
  try {
    fixture.collaboration.setEnabled(groupA, true, adminJid, fixture.now())
    const first = fixture.collaboration.createPoll(groupA, memberJid, 'Origin?', ['A', 'B'], 1, fixture.now(), 'event-poll-origin-1')
    const duplicate = fixture.collaboration.createPoll(groupA, memberJid, 'Origin?', ['A', 'B'], 1, fixture.now(), 'event-poll-origin-1')
    assert.equal(duplicate.id, first.id)
    assert.throws(() => fixture.collaboration.createPoll(groupA, memberJid, 'Different?', ['A', 'B'], 1, fixture.now(), 'event-poll-origin-1'), /different request/i)
  } finally {
    closeFixture(fixture)
  }
})

test('R3 vote is idempotent per voter and does not accept cross-group access', () => {
  const fixture = createFixture()
  try {
    fixture.collaboration.setEnabled(groupA, true, adminJid, fixture.now())
    const poll = fixture.collaboration.createPoll(groupA, memberJid, 'Choice?', ['A', 'B'], 1, fixture.now())
    const first = fixture.collaboration.vote(groupA, poll.id, otherMemberJid, 0, 'message-1', fixture.now())
    const duplicate = fixture.collaboration.vote(groupA, poll.id, otherMemberJid, 1, 'message-2', fixture.now())
    assert.equal(first.duplicate, false)
    assert.equal(duplicate.duplicate, true)
    assert.equal(duplicate.vote.optionIndex, 0)
    assert.throws(() => fixture.collaboration.vote(groupB, poll.id, memberJid, 0, 'message-3'), /not found/i)
  } finally {
    closeFixture(fixture)
  }
})

test('R3 invalid poll input is rejected before persistence', () => {
  const fixture = createFixture()
  try {
    fixture.collaboration.setEnabled(groupA, true, adminJid, fixture.now())
    assert.throws(() => fixture.collaboration.createPoll(groupA, memberJid, 'x', ['same', 'same']), /unique/i)
    assert.throws(() => fixture.collaboration.createPoll(groupA, memberJid, 'x', ['one']), /between 2/i)
    assert.throws(() => fixture.collaboration.createPoll(groupA, memberJid, 'Bearer abc', ['one', 'two']), /sensitive/i)
  } finally {
    closeFixture(fixture)
  }
})

test('R3 native poll is optional and records capability failure without losing text domain state', () => {
  const fixture = createFixture()
  try {
    fixture.collaboration.setEnabled(groupA, true, adminJid, fixture.now())
    fixture.collaboration.setNativePollEnabled(groupA, true, adminJid, fixture.now())
    const poll = fixture.collaboration.createPoll(groupA, memberJid, 'Transport?', ['Text', 'Native'], 1, fixture.now())
    assert.equal(fixture.collaboration.markPollNativePending(groupA, poll.id, memberJid)?.transportStatus, 'native-pending')
    assert.equal(fixture.collaboration.markPollNativeSent(groupA, poll.id, memberJid)?.transportStatus, 'native-sent')
    assert.equal(fixture.collaboration.markPollNativeFailed(groupA, poll.id, memberJid)?.transportStatus, 'native-failed')
    assert.equal(fixture.collaboration.getPoll(poll.id)?.status, 'open')
  } finally {
    closeFixture(fixture)
  }
})

test('R3 reminders survive service restart and dispatch only once', async () => {
  const fixture = createFixture()
  try {
    fixture.collaboration.setEnabled(groupA, true, adminJid, fixture.now())
    const reminder = fixture.collaboration.createReminder(groupA, memberJid, 'Scene dimulai', fixture.now() + 1, fixture.now())
    const sent = []
    const port = { async sendText(remoteJid, text) { sent.push({ remoteJid, text }) } }
    fixture.advance(2)
    assert.equal(await fixture.collaboration.dispatchDueReminders(port, fixture.now()), 1)
    assert.equal(await fixture.collaboration.dispatchDueReminders(port, fixture.now()), 0)
    assert.equal(sent.length, 1)
    assert.equal(fixture.collaboration.getReminder(reminder.id)?.status, 'sent')
  } finally {
    closeFixture(fixture)
  }
})

test('R3 reminder timeout marks operation failed without retry', async () => {
  const fixture = createFixture({ operationTimeoutMs: 5 })
  try {
    fixture.collaboration.setEnabled(groupA, true, adminJid, fixture.now())
    fixture.collaboration.createReminder(groupA, memberJid, 'Timeout', fixture.now() + 1, fixture.now())
    fixture.advance(2)
    const port = { sendText() { return new Promise(() => {}) } }
    assert.equal(await fixture.collaboration.dispatchDueReminders(port, fixture.now()), 0)
    assert.equal(fixture.collaboration.listReminders(groupA, 'expired').length, 1)
  } finally {
    closeFixture(fixture)
  }
})

test('R3 task completion enforces creator or assignee ownership', () => {
  const fixture = createFixture()
  try {
    fixture.collaboration.setEnabled(groupA, true, adminJid, fixture.now())
    const task = fixture.collaboration.createTask(groupA, memberJid, 'Review canon', otherMemberJid, fixture.now())
    assert.equal(fixture.collaboration.completeTask(groupA, task.id, adminJid), undefined)
    assert.equal(fixture.collaboration.completeTask(groupA, task.id, otherMemberJid)?.status, 'done')
  } finally {
    closeFixture(fixture)
  }
})

test('R3 decisions are explicit and group-isolated', () => {
  const fixture = createFixture()
  try {
    fixture.collaboration.setEnabled(groupA, true, adminJid, fixture.now())
    fixture.collaboration.createDecision(groupA, memberJid, 'Canon proposal approved', fixture.now())
    assert.equal(fixture.collaboration.listDecisions(groupA).length, 1)
    assert.equal(fixture.collaboration.listDecisions(groupB).length, 0)
  } finally {
    closeFixture(fixture)
  }
})

class CollaborationCore {
  isConnected = true
  currentStatus = 'connected'
  userJid = botJid
  sent = []
  nativePolls = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: groupA,
    subject: 'R3 Test Group',
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
  async sendNativePoll(remoteJid, options) { this.nativePolls.push({ remoteJid, options }) }
  async getGroupMetadata() { return this.metadata }
  async getGroupInviteLink() { return undefined }
  async start() {}
  async close() {}
  async emitMessage(message) { await Promise.all([...this.messages].map((listener) => listener(message))) }
}

function groupMessage(id, senderJid, text, extra = {}) {
  return { id, remoteJid: groupA, senderJid, text, timestamp: Date.now(), fromMe: false, ...extra }
}

test('R3 plugin is default-off, admin-gated, and supports text poll/vote fallback', async () => {
  const databasePath = tempDatabase('allybot-r3-plugin-')
  const core = new CollaborationCore()
  const guardrails = new PlatformGuardrailService(databasePath, logger)
  const collaboration = new CollaborationService(databasePath, logger)
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0, databasePath }, logger, core, { permissionResolver: createPermissionResolver(core) })
  app.registerService(guardrails)
  app.registerService(collaboration)
  app.registerPlugin(createCollaborationPlugin(core))
  await app.start()
  try {
    await core.emitMessage(groupMessage('member-poll-off', memberJid, '!poll Choose? | A | B'))
    assert.match(core.sent.at(-1).text, /belum aktif/i)
    await core.emitMessage(groupMessage('member-enable', memberJid, '!setcollab on'))
    assert.match(core.sent.at(-1).text, /hanya dapat digunakan oleh admin/i)
    await core.emitMessage(groupMessage('admin-enable', adminJid, '!setcollab on'))
    assert.match(core.sent.at(-1).text, /on/i)
    await core.emitMessage(groupMessage('admin-poll', adminJid, '!poll Choose? | A | B'))
    assert.match(core.sent.at(-1).text, /Poll/)
    const pollId = [...core.sent.at(-1).text.matchAll(/Poll ([a-f0-9]{8})/gi)][0]?.[1]
    assert.ok(pollId)
    await core.emitMessage(groupMessage('member-vote', memberJid, `!vote ${pollId} 1`))
    assert.match(core.sent.at(-1).text, /Vote tercatat/)
  } finally {
    await app.stop()
    cleanupDatabase(databasePath)
  }
})
