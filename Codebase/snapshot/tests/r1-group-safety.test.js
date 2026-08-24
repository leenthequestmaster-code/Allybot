import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { createGroupSafetyPlugin } from '../dist/framework/plugins/group-safety.js'
import { GroupSafetyService } from '../dist/services/group-safety-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const groupA = '<jid-redacted@g.us>'
const groupB = '<jid-redacted@g.us>'
const adminJid = '<jid-redacted@s.whatsapp.net>'
const memberJid = '<jid-redacted@s.whatsapp.net>'
const otherMemberJid = '<jid-redacted@s.whatsapp.net>'
const botJid = '<jid-redacted@s.whatsapp.net>'

function tempDatabase(prefix = 'allybot-r1-') {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'core.sqlite')
}

function cleanupDatabase(databasePath) {
  rmSync(databasePath, { force: true })
  rmSync(`${databasePath}-wal`, { force: true })
  rmSync(`${databasePath}-shm`, { force: true })
  rmSync(databasePath.replace(/core\.sqlite$/, ''), { recursive: true, force: true })
}

function serviceContext(services, databasePath) {
  return {
    logger,
    config: { commandPrefix: '!', defaultCooldownMs: 0, databasePath },
    services,
  }
}

function createServiceFixture() {
  const databasePath = tempDatabase()
  let now = 1_700_000_000_000
  const guardrails = new PlatformGuardrailService(databasePath, logger, { clock: () => now, maxHotAuditRecords: 50 })
  const services = { get(name) { if (name === 'platform-guardrails') return guardrails; throw new Error(`unknown service ${name}`) } }
  guardrails.initialize(serviceContext(services, databasePath))
  const safety = new GroupSafetyService(databasePath, logger, { clock: () => now, warningTtlMs: 1_000, maxListLimit: 25 })
  safety.initialize(serviceContext(services, databasePath))
  return { databasePath, guardrails, safety, advance(ms) { now += ms }, now: () => now }
}

test('R1 warning ledger enforces expiry, bounded state, and group isolation', () => {
  const fixture = createServiceFixture()
  try {
    fixture.safety.setMode(groupA, 'dry-run', adminJid)
    assert.equal(fixture.safety.isDryRun(groupA), true)
    assert.equal(fixture.safety.isDryRun(groupB), false)
    assert.equal(fixture.safety.shouldCreateDryRunCase(groupA, memberJid, 'anti-link', fixture.now()), true)
    assert.equal(fixture.safety.shouldCreateDryRunCase(groupA, memberJid, 'anti-link', fixture.now()), false)
    fixture.advance(10_001)
    assert.equal(fixture.safety.shouldCreateDryRunCase(groupA, memberJid, 'anti-link', fixture.now()), true)

    const warning = fixture.safety.issueWarning(groupA, memberJid, adminJid, 'link policy', fixture.now())
    assert.equal(fixture.safety.countActiveWarnings(groupA, memberJid, fixture.now()), 1)
    assert.equal(fixture.safety.listWarnings(groupB).length, 0)
    assert.equal(fixture.safety.getWarning(warning.id)?.status, 'active')

    fixture.advance(1_001)
    assert.equal(fixture.safety.getWarning(warning.id)?.status, 'expired')
    assert.equal(fixture.safety.countActiveWarnings(groupA, memberJid, fixture.now()), 0)
    assert.equal(fixture.safety.revokeWarning(groupA, warning.id, adminJid), undefined)
    assert.throws(() => fixture.safety.issueWarning(groupA, memberJid, adminJid, 'x'.repeat(241)), /too long/)
    assert.throws(() => fixture.safety.issueWarning(groupA, memberJid, adminJid, 'Bearer abc.def.ghi'), /sensitive-looking/)
  } finally {
    fixture.safety.shutdown(serviceContext({}, fixture.databasePath))
    fixture.guardrails.shutdown(serviceContext({}, fixture.databasePath))
    cleanupDatabase(fixture.databasePath)
  }
})

test('R1 case workflow is idempotent, revision-checked, appeal-owned, and evidence-minimized', () => {
  const fixture = createServiceFixture()
  try {
    const first = fixture.safety.reportCase(groupA, memberJid, otherMemberJid, 'member.report', 'reported content', 'message-1', 'secret full message')
    const duplicate = fixture.safety.reportCase(groupA, memberJid, otherMemberJid, 'member.report', 'different duplicate', 'message-1', 'another body')
    assert.equal(first.created, true)
    assert.equal(duplicate.created, false)
    assert.equal(duplicate.record.id, first.record.id)
    assert.equal(duplicate.record.evidenceHash?.includes('secret'), false)
    assert.equal(duplicate.record.reason, first.record.reason)

    const claimed = fixture.safety.claimCase(groupA, first.record.id, adminJid, 0)
    assert.equal(claimed?.status, 'claimed')
    assert.equal(fixture.safety.resolveCase(groupA, first.record.id, adminJid, 'handled', 0), undefined)
    const resolved = fixture.safety.resolveCase(groupA, first.record.id, adminJid, 'handled', 1)
    assert.equal(resolved?.status, 'resolved')

    const deniedAppeal = fixture.safety.appealCase(groupA, first.record.id, memberJid, 'not target')
    assert.equal(deniedAppeal, undefined)
    const appeal = fixture.safety.appealCase(groupA, first.record.id, otherMemberJid, 'please review')
    assert.equal(appeal?.record.status, 'appealed')
    assert.equal(appeal?.created, true)
    const duplicateAppeal = fixture.safety.appealCase(groupA, first.record.id, otherMemberJid, 'duplicate')
    assert.equal(duplicateAppeal?.created, false)
    assert.equal(fixture.safety.listCases(groupB).length, 0)
  } finally {
    fixture.safety.shutdown(serviceContext({}, fixture.databasePath))
    fixture.guardrails.shutdown(serviceContext({}, fixture.databasePath))
    cleanupDatabase(fixture.databasePath)
  }
})

class SafetyCore {
  isConnected = true
  currentStatus = 'connected'
  userJid = botJid
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: groupA,
    subject: 'R1 Test Group',
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

test('R1 plugin keeps admin boundary and creates dry-run cases without destructive actions', async () => {
  const databasePath = tempDatabase('allybot-r1-plugin-')
  const core = new SafetyCore()
  const guardrails = new PlatformGuardrailService(databasePath, logger)
  const safety = new GroupSafetyService(databasePath, logger)
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0, databasePath }, logger, core, { permissionResolver: createPermissionResolver(core) })
  app.registerService(guardrails)
  app.registerService(safety)
  app.registerPlugin(createGroupSafetyPlugin(core))
  await app.start()

  try {
    await core.emitMessage(groupMessage('member-enable', memberJid, '!setsafety dry-run'))
    assert.equal(core.sent.at(-1).text, 'Maaf, command ini hanya dapat digunakan oleh admin grup.')

    await core.emitMessage(groupMessage('admin-enable', adminJid, '!setsafety dry-run'))
    assert.match(core.sent.at(-1).text, /sekarang: \*dry-run\*/)

    await core.emitMessage(groupMessage('member-report', memberJid, '!report unsafe', { mentionedJids: [otherMemberJid] }))
    assert.match(core.sent.at(-1).text, /Laporan dibuat/)

    await core.emitMessage(groupMessage('link-message', memberJid, 'lihat https://example.test/a'))
    await core.emitMessage(groupMessage('admin-cases', adminJid, '!cases'))
    assert.match(core.sent.at(-1).text, /member\.report/)
    assert.match(core.sent.at(-1).text, /anti-link/)
    assert.equal(core.sent.some((entry) => /delete|kick|remove/i.test(entry.text)), false)
  } finally {
    await app.stop()
    cleanupDatabase(databasePath)
  }
})
