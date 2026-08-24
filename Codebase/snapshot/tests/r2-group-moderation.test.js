import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { GroupModerationService } from '../dist/services/group-moderation-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const groupA = '<jid-redacted@g.us>'
const groupB = '<jid-redacted@g.us>'
const adminJid = '<jid-redacted@s.whatsapp.net>'
const memberJid = '<jid-redacted@s.whatsapp.net>'
const otherMemberJid = '<jid-redacted@s.whatsapp.net>'
const botJid = '<jid-redacted@s.whatsapp.net>'

function tempDatabase(prefix = 'allybot-r2-') {
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

function metadata(groupJid = groupA, { actorAdmin = true, botAdmin = true } = {}) {
  return {
    jid: groupJid,
    subject: 'R2 Test Group',
    participants: [
      ...(actorAdmin ? [{ jid: adminJid, role: 'admin' }] : [{ jid: adminJid, role: 'member' }]),
      { jid: memberJid, role: 'member' },
      { jid: otherMemberJid, role: 'member' },
      ...(botAdmin ? [{ jid: botJid, role: 'admin' }] : [{ jid: botJid, role: 'member' }]),
    ],
  }
}

function createFixture() {
  const databasePath = tempDatabase()
  let now = 1_700_000_000_000
  const guardrails = new PlatformGuardrailService(databasePath, logger, { clock: () => now, maxHotAuditRecords: 200 })
  const services = { get(name) { if (name === 'platform-guardrails') return guardrails; throw new Error(`unknown service ${name}`) } }
  guardrails.initialize(serviceContext(services, databasePath))
  const moderation = new GroupModerationService(databasePath, logger, { clock: () => now, operationTtlMs: 60_000, maxListLimit: 25 })
  moderation.initialize(serviceContext(services, databasePath))
  return {
    databasePath,
    guardrails,
    moderation,
    advance(ms) { now += ms },
    now: () => now,
  }
}

function createWhatsapp({ group = groupA, actorAdmin = true, botAdmin = true, participantUpdate, settingUpdate } = {}) {
  const calls = { participant: 0, setting: 0 }
  const port = {
    userJid: botJid,
    async getGroupMetadata() { return metadata(group, { actorAdmin, botAdmin }) },
  }
  if (participantUpdate !== undefined) {
    port.groupParticipantsUpdate = async (...args) => {
      calls.participant += 1
      return participantUpdate(...args)
    }
  }
  if (settingUpdate !== undefined) {
    port.groupSettingUpdate = async (...args) => {
      calls.setting += 1
      return settingUpdate(...args)
    }
  }
  return { port, calls }
}

function participantRequest(correlationId, mode = 'live', groupJid = groupA) {
  return {
    groupJid,
    actorJid: adminJid,
    botJid,
    correlationId,
    mode,
    action: 'remove',
    targetJids: [memberJid],
  }
}

function settingRequest(correlationId, mode = 'live') {
  return {
    groupJid: groupA,
    actorJid: adminJid,
    botJid,
    correlationId,
    mode,
    setting: 'announcement',
  }
}

function closeFixture(fixture) {
  fixture.moderation.shutdown(serviceContext({}, fixture.databasePath))
  fixture.guardrails.shutdown(serviceContext({}, fixture.databasePath))
  cleanupDatabase(fixture.databasePath)
}

test('R2 default-off blocks transport call before role/side effect', async () => {
  const fixture = createFixture()
  try {
    const whatsapp = createWhatsapp({ participantUpdate: async () => [{ jid: memberJid, status: 'ok' }] })
    const planned = await fixture.moderation.planAction(participantRequest('r2-default-off'), whatsapp.port)
    assert.deepEqual(planned, { kind: 'denied', code: 'feature_disabled' })
    assert.equal(whatsapp.calls.participant, 0)
  } finally {
    closeFixture(fixture)
  }
})

test('R2 dry-run audits and completes without transport side effect', async () => {
  const fixture = createFixture()
  try {
    fixture.moderation.setMode(groupA, 'dry-run', adminJid)
    const whatsapp = createWhatsapp({ participantUpdate: async () => [{ jid: memberJid, status: 'ok' }] })
    const planned = await fixture.moderation.planAction(participantRequest('r2-dry-run', 'dry-run'), whatsapp.port)
    assert.equal(planned.kind, 'planned')
    const executed = await fixture.moderation.executeAction(planned.record.operationId, whatsapp.port)
    assert.equal(executed.kind, 'completed')
    assert.equal(executed.record.status, 'dry-run')
    assert.equal(whatsapp.calls.participant, 0)
    assert.equal(fixture.moderation.listOperations(groupA, 'dry-run').length, 1)
  } finally {
    closeFixture(fixture)
  }
})

test('R2 duplicate correlation returns duplicate and never replays mutation', async () => {
  const fixture = createFixture()
  try {
    fixture.moderation.setMode(groupA, 'live', adminJid)
    const whatsapp = createWhatsapp({ participantUpdate: async () => [{ jid: memberJid, status: 'ok' }] })
    const first = await fixture.moderation.planAction(participantRequest('r2-duplicate'), whatsapp.port)
    const duplicate = await fixture.moderation.planAction(participantRequest('r2-duplicate'), whatsapp.port)
    assert.equal(first.kind, 'planned')
    assert.equal(duplicate.kind, 'duplicate')
    assert.equal(duplicate.record.operationId, first.record.operationId)
    assert.equal(whatsapp.calls.participant, 0)
    const executed = await fixture.moderation.executeAction(first.record.operationId, whatsapp.port)
    assert.equal(executed.kind, 'completed')
    assert.equal(whatsapp.calls.participant, 1)
    const replay = await fixture.moderation.executeAction(first.record.operationId, whatsapp.port)
    assert.equal(replay.kind, 'completed')
    assert.equal(whatsapp.calls.participant, 1)
  } finally {
    closeFixture(fixture)
  }
})

test('R2 denies non-admin actor and non-admin bot after current metadata check', async () => {
  const actorFixture = createFixture()
  try {
    actorFixture.moderation.setMode(groupA, 'live', adminJid)
    const actorDenied = await actorFixture.moderation.planAction(participantRequest('r2-actor-denied'), createWhatsapp({ actorAdmin: false, participantUpdate: async () => [] }).port)
    assert.deepEqual(actorDenied, { kind: 'denied', code: 'actor_not_admin' })
  } finally {
    closeFixture(actorFixture)
  }

  const botFixture = createFixture()
  try {
    botFixture.moderation.setMode(groupA, 'live', adminJid)
    const botDenied = await botFixture.moderation.planAction(participantRequest('r2-bot-denied'), createWhatsapp({ botAdmin: false, participantUpdate: async () => [] }).port)
    assert.deepEqual(botDenied, { kind: 'denied', code: 'bot_not_admin' })
  } finally {
    closeFixture(botFixture)
  }
})

test('R2 rejects invalid action, setting, target, and cross-group feature state', async () => {
  const fixture = createFixture()
  try {
    fixture.moderation.setMode(groupA, 'live', adminJid)
    const whatsapp = createWhatsapp({ participantUpdate: async () => [] }).port
    await assert.rejects(fixture.moderation.planAction({ ...participantRequest('r2-invalid-action'), action: 'modify' }, whatsapp), /Invalid moderation action/)
    await assert.rejects(fixture.moderation.planAction({ ...settingRequest('r2-invalid-setting'), setting: 'free-form' }, whatsapp), /Invalid group setting/)
    await assert.rejects(fixture.moderation.planAction({ ...participantRequest('r2-duplicate-target'), targetJids: [memberJid, memberJid] }, whatsapp), /targets must be unique/)
    const isolated = await fixture.moderation.planAction(participantRequest('r2-group-b', 'live', groupB), createWhatsapp({ group: groupB, participantUpdate: async () => [] }).port)
    assert.deepEqual(isolated, { kind: 'denied', code: 'feature_disabled' })
    assert.equal(fixture.moderation.listOperations(groupB).length, 0)
  } finally {
    closeFixture(fixture)
  }
})

test('R2 reports missing optional capability as stable capability_unavailable', async () => {
  const fixture = createFixture()
  try {
    fixture.moderation.setMode(groupA, 'live', adminJid)
    const planned = await fixture.moderation.planAction(participantRequest('r2-capability-missing'), createWhatsapp().port)
    assert.equal(planned.kind, 'planned')
    const executed = await fixture.moderation.executeAction(planned.record.operationId, createWhatsapp().port)
    assert.equal(executed.kind, 'denied')
    assert.equal(executed.code, 'capability_unavailable')
  } finally {
    closeFixture(fixture)
  }
})

test('R2 maps injected timeout fault without retrying mutation', async () => {
  const fixture = createFixture()
  try {
    fixture.moderation.setMode(groupA, 'live', adminJid)
    const whatsapp = createWhatsapp({ participantUpdate: async () => { throw new Error('Operation timed out: injected') } })
    const planned = await fixture.moderation.planAction(participantRequest('r2-timeout'), whatsapp.port)
    const executed = await fixture.moderation.executeAction(planned.record.operationId, whatsapp.port)
    assert.equal(executed.kind, 'denied')
    assert.equal(executed.code, 'transport_timeout')
    assert.equal(whatsapp.calls.participant, 1)
  } finally {
    closeFixture(fixture)
  }
})

test('R2 keeps raw JID and error details out of operation/audit records', async () => {
  const fixture = createFixture()
  try {
    fixture.moderation.setMode(groupA, 'live', adminJid)
    const whatsapp = createWhatsapp({ participantUpdate: async () => { throw new Error(`secret raw error ${memberJid}`) } })
    const planned = await fixture.moderation.planAction(participantRequest('r2-redaction'), whatsapp.port)
    await fixture.moderation.executeAction(planned.record.operationId, whatsapp.port)
    const operation = fixture.moderation.getOperation(planned.record.operationId)
    assert.equal(JSON.stringify(operation).includes(memberJid), false)
    const audit = fixture.guardrails.listAudit({ includeArchive: true, limit: 100 })
    const serialized = JSON.stringify(audit)
    assert.equal(serialized.includes(groupA), false)
    assert.equal(serialized.includes(adminJid), false)
    assert.equal(serialized.includes(memberJid), false)
    assert.equal(serialized.includes('secret raw error'), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R2 atomically claims a planned operation and rejects concurrent execute', async () => {
  const fixture = createFixture()
  try {
    fixture.moderation.setMode(groupA, 'live', adminJid)
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const whatsapp = createWhatsapp({ participantUpdate: async () => {
      await gate
      return [{ jid: memberJid, status: 'ok' }]
    } })
    const planned = await fixture.moderation.planAction(participantRequest('r2-concurrent'), whatsapp.port)
    const firstExecution = fixture.moderation.executeAction(planned.record.operationId, whatsapp.port)
    await new Promise((resolve) => setImmediate(resolve))
    const concurrent = await fixture.moderation.executeAction(planned.record.operationId, whatsapp.port)
    assert.equal(concurrent.kind, 'denied')
    assert.equal(concurrent.code, 'in_progress')
    release()
    const first = await firstExecution
    assert.equal(first.kind, 'completed')
    assert.equal(whatsapp.calls.participant, 1)
  } finally {
    closeFixture(fixture)
  }
})

test('R2 executes group setting through optional adapter capability', async () => {
  const fixture = createFixture()
  try {
    fixture.moderation.setMode(groupA, 'live', adminJid)
    const whatsapp = createWhatsapp({ settingUpdate: async () => undefined })
    const planned = await fixture.moderation.planAction(settingRequest('r2-setting-live'), whatsapp.port)
    assert.equal(planned.kind, 'planned')
    const executed = await fixture.moderation.executeAction(planned.record.operationId, whatsapp.port)
    assert.equal(executed.kind, 'completed')
    assert.equal(executed.record.status, 'succeeded')
    assert.equal(whatsapp.calls.setting, 1)
  } finally {
    closeFixture(fixture)
  }
})

test('R2 records partial participant result as failed without retry', async () => {
  const fixture = createFixture()
  try {
    fixture.moderation.setMode(groupA, 'live', adminJid)
    const whatsapp = createWhatsapp({ participantUpdate: async () => [{ jid: memberJid, status: 'not-authorized' }] })
    const planned = await fixture.moderation.planAction(participantRequest('r2-partial'), whatsapp.port)
    const executed = await fixture.moderation.executeAction(planned.record.operationId, whatsapp.port)
    assert.equal(executed.kind, 'denied')
    assert.equal(executed.code, 'transport_failed')
    assert.equal(executed.record?.status, 'failed')
    assert.equal(whatsapp.calls.participant, 1)
  } finally {
    closeFixture(fixture)
  }
})
