import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { createGroupGovernancePlugin } from '../dist/framework/plugins/group-governance.js'
import { GroupGovernanceService } from '../dist/services/group-governance-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const groupA = '120363100000000000@g.us'
const groupB = '120363100000000001@g.us'
const adminJid = '628130000001@s.whatsapp.net'
const userA = '628130000002@s.whatsapp.net'
const userB = '628130000003@s.whatsapp.net'
const botJid = '628130000009@s.whatsapp.net'
const initialNow = Date.UTC(2024, 0, 1, 12, 0, 0)

function tempDatabase(prefix = 'allybot-r8-') {
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

class GovernanceCore {
  isConnected = true
  currentStatus = 'connected'
  userJid = botJid
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  revokeCalls = 0
  participantCalls = []
  inviteLink = 'https://chat.whatsapp.com/sensitive-invite-code'
  metadata = {
    jid: groupA,
    subject: 'Governance Test Group',
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
  async getGroupInviteLink() { return this.inviteLink }
  async groupRevokeInvite() { this.revokeCalls += 1; this.inviteLink = 'https://chat.whatsapp.com/new-code'; return 'new-code' }
  async groupParticipantsUpdate(groupJid, participantJids, action) { this.participantCalls.push({ groupJid, participantJids, action }); return participantJids.map((participantJid) => ({ participantJid, status: 'ok' })) }
  async start() {}
  async close() {}
  async emitMessage(message) { await Promise.all([...this.messages].map((listener) => listener(message))) }
}

function createFixture() {
  const databasePath = tempDatabase()
  let now = initialNow
  const guardrails = new PlatformGuardrailService(databasePath, logger, { clock: () => now, maxHotAuditRecords: 500 })
  const governance = new GroupGovernanceService(databasePath, logger, { clock: () => now })
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'group-governance') return governance
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'group-governance' },
  }
  guardrails.initialize(serviceContext(services, databasePath))
  governance.initialize(serviceContext(services, databasePath))
  governance.setEnabled(groupA, true, adminJid, now)
  const whatsapp = new GovernanceCore()
  return { databasePath, guardrails, governance, whatsapp, now: () => now, advance(ms) { now += ms }, services }
}

function closeFixture(fixture) {
  fixture.governance.shutdown(serviceContext(fixture.services, fixture.databasePath))
  fixture.guardrails.shutdown(serviceContext(fixture.services, fixture.databasePath))
  cleanupDatabase(fixture.databasePath)
}

test('R8 default-off blocks governance persistence and cross-group access', async () => {
  const fixture = createFixture()
  try {
    assert.equal(fixture.governance.isFeatureEnabled(groupB), false)
    assert.equal(fixture.governance.recordJoinRequest({ groupJid: groupB, requesterJid: userA }), undefined)
    assert.equal(await fixture.governance.createRetcon({ groupJid: groupB, actorJid: adminJid, target: 'x', replacement: 'y', rationale: 'z' }, fixture.whatsapp), undefined)
    assert.equal(fixture.governance.getSettings(groupB).enabled, false)
  } finally {
    closeFixture(fixture)
  }
})

test('R8 retcon lifecycle is explicit, group-scoped, revision-CAS, and append-only', async () => {
  const fixture = createFixture()
  try {
    const draft = await fixture.governance.createRetcon({ groupJid: groupA, actorJid: adminJid, target: 'old fact', replacement: 'new fact', rationale: 'moderator review', sourceRef: 'source-1' }, fixture.whatsapp)
    assert.equal(draft.status, 'draft')
    const proposed = await fixture.governance.transitionRetcon({ groupJid: groupA, actorJid: adminJid, retconId: draft.id, target: 'proposed', expectedRevision: 1 }, fixture.whatsapp)
    assert.equal(proposed.status, 'proposed')
    const approved = await fixture.governance.transitionRetcon({ groupJid: groupA, actorJid: adminJid, retconId: draft.id, target: 'approved', expectedRevision: 2 }, fixture.whatsapp)
    assert.equal(approved.status, 'approved')
    assert.equal(await fixture.governance.transitionRetcon({ groupJid: groupA, actorJid: adminJid, retconId: draft.id, target: 'rejected', expectedRevision: 2 }, fixture.whatsapp), undefined)
    assert.equal(fixture.governance.getRetcon(groupB, draft.id), undefined)
    assert.deepEqual(fixture.governance.listRetconHistory(groupA, draft.id).map((entry) => entry.action), ['approved', 'proposed', 'created'])
  } finally {
    closeFixture(fixture)
  }
})

test('R8 retcon audit redacts raw JIDs, text, source references, and IDs', async () => {
  const fixture = createFixture()
  try {
    const draft = await fixture.governance.createRetcon({ groupJid: groupA, actorJid: adminJid, target: 'private target text', replacement: 'private replacement text', rationale: 'private rationale text', sourceRef: 'private-source-id' }, fixture.whatsapp)
    await fixture.governance.transitionRetcon({ groupJid: groupA, actorJid: adminJid, retconId: draft.id, target: 'proposed' }, fixture.whatsapp)
    const auditText = JSON.stringify(fixture.guardrails.listAudit({ includeArchive: true, limit: 500 }))
    assert.equal(auditText.includes(groupA), false)
    assert.equal(auditText.includes(adminJid), false)
    assert.equal(auditText.includes('private target text'), false)
    assert.equal(auditText.includes('private replacement text'), false)
    assert.equal(auditText.includes('private-source-id'), false)
    assert.equal(auditText.includes(draft.id), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R8 handoff supports claim/decline and expires bounded offers', async () => {
  const fixture = createFixture()
  try {
    const handoff = await fixture.governance.createHandoff({ groupJid: groupA, actorJid: adminJid, scope: 'continuity review', evidenceCount: 2, expiresAt: initialNow + 500 }, fixture.whatsapp)
    assert.equal(handoff.status, 'offered')
    const claimed = await fixture.governance.transitionHandoff({ groupJid: groupA, actorJid: adminJid, handoffId: handoff.id, target: 'claimed', expectedRevision: 1 }, fixture.whatsapp)
    assert.equal(claimed.status, 'claimed')
    const expiring = await fixture.governance.createHandoff({ groupJid: groupA, actorJid: adminJid, scope: 'short handoff', expiresAt: initialNow + 100 }, fixture.whatsapp)
    fixture.advance(101)
    assert.equal(fixture.governance.getHandoff(groupA, expiring.id).status, 'expired')
  } finally {
    closeFixture(fixture)
  }
})

test('R8 join approval uses request revision, CAS operation ledger, and participant mutation', async () => {
  const fixture = createFixture()
  try {
    const request = fixture.governance.recordJoinRequest({ groupJid: groupA, requesterJid: userA, requestId: 'join-request-a' })
    const result = await fixture.governance.approveJoinRequest({ groupJid: groupA, actorJid: adminJid, botJid, requestId: request.id, correlationId: 'join-approval-a', expectedRevision: 1 }, fixture.whatsapp)
    assert.equal(result.kind, 'completed')
    assert.equal(fixture.whatsapp.participantCalls[0].action, 'add')
    assert.equal(fixture.governance.getJoinRequest(groupA, request.id).status, 'approved')
    const duplicate = await fixture.governance.approveJoinRequest({ groupJid: groupA, actorJid: adminJid, botJid, requestId: request.id, correlationId: 'join-approval-a' }, fixture.whatsapp)
    assert.equal(duplicate.kind, 'denied')
    assert.equal(duplicate.code, 'duplicate')
  } finally {
    closeFixture(fixture)
  }
})

test('R8 stale join request and non-admin bot fail closed without side effect', async () => {
  const fixture = createFixture()
  try {
    const request = fixture.governance.recordJoinRequest({ groupJid: groupA, requesterJid: userB, requestId: 'join-request-stale' })
    const stale = await fixture.governance.approveJoinRequest({ groupJid: groupA, actorJid: adminJid, botJid, requestId: request.id, correlationId: 'join-stale', expectedRevision: 0 }, fixture.whatsapp)
    assert.equal(stale.code, 'stale_request')
    fixture.whatsapp.metadata = { ...fixture.whatsapp.metadata, participants: fixture.whatsapp.metadata.participants.map((item) => item.jid === botJid ? { ...item, role: 'member' } : item) }
    const denied = await fixture.governance.rejectJoinRequest({ groupJid: groupA, actorJid: adminJid, botJid, requestId: request.id, correlationId: 'join-bot-not-admin', expectedRevision: 1 }, fixture.whatsapp)
    assert.equal(denied.code, 'bot_not_admin')
    assert.equal(fixture.whatsapp.participantCalls.length, 0)
  } finally {
    closeFixture(fixture)
  }
})

test('R8 join request rejection is a ledgered mutation without participant side effect', async () => {
  const fixture = createFixture()
  try {
    const request = fixture.governance.recordJoinRequest({ groupJid: groupA, requesterJid: userA, requestId: 'join-request-reject' })
    const result = await fixture.governance.rejectJoinRequest({ groupJid: groupA, actorJid: adminJid, botJid, requestId: request.id, correlationId: 'join-rejection-a', expectedRevision: 1 }, fixture.whatsapp)
    assert.equal(result.kind, 'completed')
    assert.equal(fixture.governance.getJoinRequest(groupA, request.id).status, 'rejected')
    assert.equal(fixture.whatsapp.participantCalls.length, 0)
  } finally {
    closeFixture(fixture)
  }
})

test('R8 invite info is admin-gated and revoke requires expiring explicit confirmation', async () => {
  const fixture = createFixture()
  try {
    assert.equal(await fixture.governance.getInviteLink(groupA, adminJid, fixture.whatsapp), fixture.whatsapp.inviteLink)
    assert.equal(await fixture.governance.getInviteLink(groupA, userA, fixture.whatsapp), undefined)
    const preview = await fixture.governance.previewInviteRevoke({ groupJid: groupA, actorJid: adminJid }, fixture.whatsapp)
    const result = await fixture.governance.confirmInviteRevoke({ groupJid: groupA, actorJid: adminJid, botJid, confirmationToken: preview.confirmationToken, correlationId: 'invite-revoke-a' }, fixture.whatsapp)
    assert.equal(result.kind, 'completed')
    assert.equal(fixture.whatsapp.revokeCalls, 1)
    const replay = await fixture.governance.confirmInviteRevoke({ groupJid: groupA, actorJid: adminJid, botJid, confirmationToken: preview.confirmationToken, correlationId: 'invite-revoke-replay' }, fixture.whatsapp)
    assert.equal(replay.code, 'invalid_confirmation')
    const auditText = JSON.stringify(fixture.guardrails.listAudit({ includeArchive: true, limit: 500 }))
    assert.equal(auditText.includes('sensitive-invite-code'), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R8 invite revoke fails closed when adapter capability is absent', async () => {
  const fixture = createFixture()
  try {
    const preview = await fixture.governance.previewInviteRevoke({ groupJid: groupA, actorJid: adminJid }, fixture.whatsapp)
    fixture.whatsapp.groupRevokeInvite = undefined
    const result = await fixture.governance.confirmInviteRevoke({ groupJid: groupA, actorJid: adminJid, botJid, confirmationToken: preview.confirmationToken, correlationId: 'invite-revoke-capability' }, fixture.whatsapp)
    assert.equal(result.code, 'capability_unavailable')
  } finally {
    closeFixture(fixture)
  }
})

test('R8 governance state survives service restart and continuity remains bounded', async () => {
  const fixture = createFixture()
  try {
    const draft = await fixture.governance.createRetcon({ groupJid: groupA, actorJid: adminJid, target: 'restart target', replacement: 'restart replacement', rationale: 'restart test' }, fixture.whatsapp)
    const handoff = await fixture.governance.createHandoff({ groupJid: groupA, actorJid: adminJid, scope: 'restart scope', evidenceCount: 1, expiresAt: initialNow + 10_000 }, fixture.whatsapp)
    const request = fixture.governance.recordJoinRequest({ groupJid: groupA, requesterJid: userA, requestId: 'join-request-restart' })
    fixture.governance.shutdown(serviceContext(fixture.services, fixture.databasePath))
    fixture.governance.initialize(serviceContext(fixture.services, fixture.databasePath))
    assert.equal(fixture.governance.getRetcon(groupA, draft.id).status, 'draft')
    assert.equal(fixture.governance.getHandoff(groupA, handoff.id).status, 'offered')
    assert.equal(fixture.governance.getJoinRequest(groupA, request.id).status, 'pending')
    assert.deepEqual(fixture.governance.continuityCheck(groupA), { pendingRetcons: 1, activeHandoffs: 1, pendingJoinRequests: 1, recoverableOperations: 0 })
  } finally {
    closeFixture(fixture)
  }
})

test('R8 plugin is default-off, admin-gated, text-only, and exposes fallback replies', async () => {
  const databasePath = tempDatabase('allybot-r8-plugin-')
  const core = new GovernanceCore()
  const guardrails = new PlatformGuardrailService(databasePath, logger)
  const governance = new GroupGovernanceService(databasePath, logger)
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'group-governance') return governance
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'group-governance' },
  }
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0, databasePath }, logger, core, { permissionResolver: createPermissionResolver(core) })
  app.registerService(guardrails)
  app.registerService(governance)
  app.registerPlugin(createGroupGovernancePlugin(core))
  await app.start()
  try {
    await core.emitMessage({ id: 'off', remoteJid: groupA, senderJid: adminJid, text: '!retcon propose a | b | c', timestamp: initialNow, fromMe: false })
    assert.match(core.sent.at(-1).text, /belum diaktifkan/i)
    await core.emitMessage({ id: 'toggle-denied', remoteJid: groupA, senderJid: userA, text: '!retcon enable', timestamp: initialNow, fromMe: false })
    assert.match(core.sent.at(-1).text, /admin/i)
    await core.emitMessage({ id: 'toggle', remoteJid: groupA, senderJid: adminJid, text: '!retcon enable', timestamp: initialNow, fromMe: false })
    assert.match(core.sent.at(-1).text, /on/i)
    await core.emitMessage({ id: 'preview', remoteJid: groupA, senderJid: adminJid, text: '!retcon preview old | new | reason', timestamp: initialNow, fromMe: false })
    assert.match(core.sent.at(-1).text, /Belum ada perubahan canon/i)
    await core.emitMessage({ id: 'help', remoteJid: groupA, senderJid: adminJid, text: '!invite unknown', timestamp: initialNow, fromMe: false })
    assert.match(core.sent.at(-1).text, /invite info/i)
  } finally {
    await app.stop()
    cleanupDatabase(databasePath)
  }
})
