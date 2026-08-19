import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { onboardingPlugin } from '../dist/framework/plugins/onboarding.js'
import { OnboardingService } from '../dist/services/onboarding-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const groupA = '120363100000000000@g.us'
const groupB = '120363100000000001@g.us'
const adminJid = '628130000001@s.whatsapp.net'
const applicantJid = '628130000002@s.whatsapp.net'
const otherApplicantJid = '628130000003@s.whatsapp.net'
const botJid = '628130000009@s.whatsapp.net'
const initialNow = Date.UTC(2024, 0, 1, 12, 0, 0)

function tempDatabase(prefix = 'allybot-r10-') {
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

class OnboardingCore {
  isConnected = true
  currentStatus = 'connected'
  userJid = botJid
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: groupA,
    subject: 'Onboarding Test Group',
    ownerJid: adminJid,
    participants: [
      { jid: adminJid, role: 'admin' },
      { jid: applicantJid, role: 'member' },
      { jid: otherApplicantJid, role: 'member' },
      { jid: botJid, role: 'admin' },
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

function createFixture(options = {}, initializeServices = true) {
  const databasePath = tempDatabase()
  let now = initialNow
  const guardrails = new PlatformGuardrailService(databasePath, logger, { clock: () => now, maxHotAuditRecords: 500 })
  const onboarding = new OnboardingService(databasePath, logger, { clock: () => now, ...options })
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'onboarding') return onboarding
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'onboarding' },
  }
  if (initializeServices) {
    guardrails.initialize(serviceContext(services, databasePath))
    onboarding.initialize(serviceContext(services, databasePath))
  }
  const whatsapp = new OnboardingCore()
  return {
    databasePath,
    guardrails,
    onboarding,
    whatsapp,
    now: () => now,
    advance(ms) { now += ms },
    services,
  }
}

function closeFixture(fixture) {
  fixture.onboarding.shutdown(serviceContext(fixture.services, fixture.databasePath))
  fixture.guardrails.shutdown(serviceContext(fixture.services, fixture.databasePath))
  cleanupDatabase(fixture.databasePath)
}

async function enableGroup(fixture, group = groupA) {
  const result = await fixture.onboarding.setEnabled(group, adminJid, true, fixture.whatsapp, fixture.now())
  assert.deepEqual(result, { enabled: true })
}

test('R10 onboarding is default-off and blocks persistence across groups', () => {
  const fixture = createFixture()
  try {
    const blocked = fixture.onboarding.apply({ groupJid: groupA, actorJid: applicantJid, applicationText: 'join request', correlationId: 'r10-off' }, fixture.now())
    assert.equal(blocked.kind, 'denied')
    assert.equal(blocked.code, 'feature_disabled')
    assert.equal(fixture.onboarding.getOwnApplication(groupA, applicantJid, fixture.now()), undefined)
    assert.equal(fixture.onboarding.isFeatureEnabled(groupB), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R10 onboarding apply is bounded, idempotent for active applicant, and group-scoped', async () => {
  const fixture = createFixture()
  try {
    await enableGroup(fixture)
    const created = fixture.onboarding.apply({ groupJid: groupA, actorJid: applicantJid, applicationText: 'I would like to join.', correlationId: 'r10-apply-a' }, fixture.now())
    assert.equal(created.kind, 'completed')
    assert.equal(created.record.status, 'applied')
    assert.equal(created.record.revision, 1)
    assert.equal(created.record.applicationText, 'I would like to join.')
    const duplicate = fixture.onboarding.apply({ groupJid: groupA, actorJid: applicantJid, applicationText: 'duplicate request', correlationId: 'r10-apply-b' }, fixture.now())
    assert.equal(duplicate.kind, 'denied')
    assert.equal(duplicate.code, 'duplicate')
    assert.equal(fixture.onboarding.getOwnApplication(groupB, applicantJid, fixture.now()), undefined)
  } finally {
    closeFixture(fixture)
  }
})

test('R10 onboarding review requires admin, uses revision CAS, and supports reopen', async () => {
  const fixture = createFixture()
  try {
    await enableGroup(fixture)
    const created = fixture.onboarding.apply({ groupJid: groupA, actorJid: applicantJid, applicationText: 'bounded application', correlationId: 'r10-review-create' }, fixture.now())
    assert.equal(created.kind, 'completed')
    const nonAdmin = await fixture.onboarding.review({ groupJid: groupA, actorJid: applicantJid, applicationId: created.record.id, target: 'approved', expectedRevision: 1, correlationId: 'r10-review-denied' }, fixture.whatsapp, fixture.now())
    assert.equal(nonAdmin.kind, 'denied')
    assert.equal(nonAdmin.code, 'actor_not_admin')
    const stale = await fixture.onboarding.review({ groupJid: groupA, actorJid: adminJid, applicationId: created.record.id, target: 'approved', expectedRevision: 2, correlationId: 'r10-review-stale' }, fixture.whatsapp, fixture.now())
    assert.equal(stale.kind, 'denied')
    assert.equal(stale.code, 'stale_application')
    const approved = await fixture.onboarding.review({ groupJid: groupA, actorJid: adminJid, applicationId: created.record.id, target: 'approved', expectedRevision: 1, correlationId: 'r10-review-approve' }, fixture.whatsapp, fixture.now())
    assert.equal(approved.kind, 'completed')
    assert.equal(approved.record.status, 'approved')
    assert.equal(approved.record.revision, 2)
    const invalidReopen = await fixture.onboarding.review({ groupJid: groupA, actorJid: adminJid, applicationId: created.record.id, target: 'reopen', expectedRevision: 2, correlationId: 'r10-review-invalid-reopen' }, fixture.whatsapp, fixture.now())
    assert.equal(invalidReopen.kind, 'denied')
    assert.equal(invalidReopen.code, 'invalid_state')
  } finally {
    closeFixture(fixture)
  }
})

test('R10 onboarding expiry is bounded and reopen is allowed only from denied state', async () => {
  const fixture = createFixture({ applicationTtlMs: 100 })
  try {
    await enableGroup(fixture)
    const created = fixture.onboarding.apply({ groupJid: groupA, actorJid: applicantJid, applicationText: 'short-lived application', correlationId: 'r10-expire-create' }, fixture.now())
    assert.equal(created.kind, 'completed')
    fixture.advance(101)
    const expired = fixture.onboarding.getOwnApplication(groupA, applicantJid, fixture.now())
    assert.equal(expired.status, 'expired')
    const expiredReview = await fixture.onboarding.review({ groupJid: groupA, actorJid: adminJid, applicationId: created.record.id, target: 'approved', expectedRevision: 2, correlationId: 'r10-expire-review' }, fixture.whatsapp, fixture.now())
    assert.equal(expiredReview.kind, 'denied')
    assert.equal(expiredReview.code, 'expired')
  } finally {
    closeFixture(fixture)
  }
})

test('R10 onboarding audit redacts raw JIDs, application text, and IDs', async () => {
  const fixture = createFixture()
  try {
    await enableGroup(fixture)
    const created = fixture.onboarding.apply({ groupJid: groupA, actorJid: applicantJid, applicationText: 'private application text', correlationId: 'r10-redaction' }, fixture.now())
    assert.equal(created.kind, 'completed')
    await fixture.onboarding.review({ groupJid: groupA, actorJid: adminJid, applicationId: created.record.id, target: 'denied', expectedRevision: 1, correlationId: 'r10-redaction-review' }, fixture.whatsapp, fixture.now())
    const auditText = JSON.stringify(fixture.guardrails.listAudit({ includeArchive: true, limit: 500 }))
    assert.equal(auditText.includes(groupA), false)
    assert.equal(auditText.includes(applicantJid), false)
    assert.equal(auditText.includes(adminJid), false)
    assert.equal(auditText.includes('private application text'), false)
    assert.equal(auditText.includes(created.record.id), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R10 onboarding state survives service restart and admin list is bounded', async () => {
  const fixture = createFixture()
  try {
    await enableGroup(fixture)
    const created = fixture.onboarding.apply({ groupJid: groupA, actorJid: applicantJid, applicationText: 'restart-safe application', correlationId: 'r10-restart-create' }, fixture.now())
    assert.equal(created.kind, 'completed')
    fixture.onboarding.shutdown(serviceContext(fixture.services, fixture.databasePath))
    fixture.onboarding.initialize(serviceContext(fixture.services, fixture.databasePath))
    const own = fixture.onboarding.getOwnApplication(groupA, applicantJid, fixture.now())
    assert.equal(own.status, 'applied')
    const listed = await fixture.onboarding.listForReview({ groupJid: groupA, actorJid: adminJid, limit: 1, correlationId: 'r10-restart-list' }, fixture.whatsapp, fixture.now())
    assert.equal(listed.kind, 'completed')
    assert.equal(listed.records.length, 1)
    assert.equal(listed.records[0].id, created.record.id)
  } finally {
    closeFixture(fixture)
  }
})

test('R10 onboarding plugin is text-first, default-off, and admin-gated', async () => {
  const fixture = createFixture({}, false)
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0, databasePath: fixture.databasePath }, logger, fixture.whatsapp, { permissionResolver: createPermissionResolver(fixture.whatsapp) })
  app.registerService(fixture.guardrails)
  app.registerService(fixture.onboarding)
  app.registerPlugin(onboardingPlugin)
  await app.start()
  try {
    await fixture.whatsapp.emitMessage({ id: 'r10-off', remoteJid: groupA, senderJid: applicantJid, text: '!onboarding apply request', timestamp: fixture.now(), fromMe: false })
    assert.match(fixture.whatsapp.sent.at(-1).text, /belum diaktifkan/i)
    await fixture.whatsapp.emitMessage({ id: 'r10-enable-denied', remoteJid: groupA, senderJid: applicantJid, text: '!onboarding enable', timestamp: fixture.now(), fromMe: false })
    assert.match(fixture.whatsapp.sent.at(-1).text, /admin/i)
    await fixture.whatsapp.emitMessage({ id: 'r10-enable', remoteJid: groupA, senderJid: adminJid, text: '!onboard enable', timestamp: fixture.now(), fromMe: false })
    assert.match(fixture.whatsapp.sent.at(-1).text, /on/i)
    await fixture.whatsapp.emitMessage({ id: 'r10-apply', remoteJid: groupA, senderJid: applicantJid, text: '!onboarding apply hello community', timestamp: fixture.now(), fromMe: false })
    assert.match(fixture.whatsapp.sent.at(-1).text, /Application onboarding dibuat/i)
    await fixture.whatsapp.emitMessage({ id: 'r10-status', remoteJid: groupA, senderJid: applicantJid, text: '!onboarding status', timestamp: fixture.now(), fromMe: false })
    assert.match(fixture.whatsapp.sent.at(-1).text, /Status: applied/i)
    await fixture.whatsapp.emitMessage({ id: 'r10-list-denied', remoteJid: groupA, senderJid: applicantJid, text: '!onboarding list', timestamp: fixture.now(), fromMe: false })
    assert.match(fixture.whatsapp.sent.at(-1).text, /admin/i)
  } finally {
    await app.stop()
    cleanupDatabase(fixture.databasePath)
  }
})

test('R10 onboarding content retention redacts application text without removing state', async () => {
  const fixture = createFixture({ contentRetentionMs: 100 })
  try {
    await enableGroup(fixture)
    const created = fixture.onboarding.apply({ groupJid: groupA, actorJid: applicantJid, applicationText: 'retained only briefly', correlationId: 'r10-retention-create' }, fixture.now())
    assert.equal(created.kind, 'completed')
    fixture.advance(101)
    const listed = await fixture.onboarding.listForReview({ groupJid: groupA, actorJid: adminJid, correlationId: 'r10-retention-list' }, fixture.whatsapp, fixture.now())
    assert.equal(listed.kind, 'completed')
    assert.equal(listed.records[0].id, created.record.id)
    assert.equal(listed.records[0].applicationText, undefined)
    assert.equal(listed.records[0].status, 'applied')
  } finally {
    closeFixture(fixture)
  }
})

test('R10 onboarding rejects oversized input and feature-off admin reads without persistence', async () => {
  const fixture = createFixture()
  try {
    const oversized = 'x'.repeat(501)
    assert.throws(() => fixture.onboarding.apply({ groupJid: groupA, actorJid: applicantJid, applicationText: oversized, correlationId: 'r10-oversized' }, fixture.now()), /exceeds the limit/i)
    const list = await fixture.onboarding.listForReview({ groupJid: groupA, actorJid: adminJid, correlationId: 'r10-off-list' }, fixture.whatsapp, fixture.now())
    assert.deepEqual(list, { kind: 'denied', code: 'feature_disabled' })
  } finally {
    closeFixture(fixture)
  }
})

test('R10 onboarding cannot review an application through another group scope', async () => {
  const fixture = createFixture()
  try {
    await enableGroup(fixture, groupA)
    const created = fixture.onboarding.apply({ groupJid: groupA, actorJid: applicantJid, applicationText: 'group scoped request', correlationId: 'r10-cross-group-create' }, fixture.now())
    assert.equal(created.kind, 'completed')
    fixture.whatsapp.metadata = { ...fixture.whatsapp.metadata, jid: groupB }
    await enableGroup(fixture, groupB)
    const crossGroup = await fixture.onboarding.review({ groupJid: groupB, actorJid: adminJid, applicationId: created.record.id, target: 'approved', expectedRevision: 1, correlationId: 'r10-cross-group-review' }, fixture.whatsapp, fixture.now())
    assert.equal(crossGroup.kind, 'denied')
    assert.equal(crossGroup.code, 'not_found')
    const original = fixture.onboarding.getOwnApplication(groupA, applicantJid, fixture.now())
    assert.equal(original.status, 'applied')
    assert.equal(original.revision, 1)
  } finally {
    closeFixture(fixture)
  }
})
