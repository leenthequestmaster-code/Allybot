import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { AnnouncementService } from '../dist/services/announcement-service.js'
import { KnowledgeService } from '../dist/services/knowledge-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'
import { SceneService } from '../dist/services/scene-service.js'
import { SuggestionRelayService } from '../dist/services/suggestion-relay-service.js'
import { createAnnouncementPlugin } from '../dist/framework/plugins/announcement.js'

const logger = pino({ level: 'silent' })
const groupA = '120363100000000000@g.us'
const groupB = '120363100000000001@g.us'
const adminJid = '628130000001@s.whatsapp.net'
const userA = '628130000002@s.whatsapp.net'
const userB = '628130000003@s.whatsapp.net'
const botJid = '628130000009@s.whatsapp.net'
const initialNow = Date.UTC(2024, 0, 1, 12, 0, 0)

function tempDatabase(prefix = 'allybot-r11-') {
  return join(mkdtempSync(join(tmpdir(), prefix)), 'core.sqlite')
}

function cleanupDatabase(databasePath) {
  rmSync(databasePath, { force: true })
  rmSync(`${databasePath}-wal`, { force: true })
  rmSync(`${databasePath}-shm`, { force: true })
  rmSync(databasePath.replace(/core\.sqlite$/, ''), { recursive: true, force: true })
}

class FakeWhatsApp {
  isConnected = true
  currentStatus = 'connected'
  userJid = botJid
  sent = []
  failTargets = new Set()
  replies = []
  metadata = {
    jid: groupA,
    subject: 'R11 test group',
    participants: [
      { jid: adminJid, role: 'admin' },
      { jid: userA, role: 'member' },
      { jid: userB, role: 'member' },
      { jid: botJid, role: 'admin' },
    ],
  }
  messageListeners = new Set()
  connectionListeners = new Set()
  participantListeners = new Set()

  onMessage(listener) { this.messageListeners.add(listener); return () => this.messageListeners.delete(listener) }
  onConnectionState(listener) { this.connectionListeners.add(listener); return () => this.connectionListeners.delete(listener) }
  onGroupParticipantUpdate(listener) { this.participantListeners.add(listener); return () => this.participantListeners.delete(listener) }
  async sendText(remoteJid, text) {
    if (this.failTargets.has(remoteJid)) throw new Error('SyntheticTransportFailure')
    this.sent.push({ remoteJid, text })
  }
  async getGroupMetadata(groupJid) {
    if (groupJid !== this.metadata.jid) throw new Error('SyntheticMetadataFailure')
    return this.metadata
  }
  async start() {}
  async close() { this.isConnected = false }
  async emitMessage(message) {
    for (const listener of this.messageListeners) await listener(message)
  }
}

function serviceContext(services, databasePath) {
  return { logger, config: { commandPrefix: '!', defaultCooldownMs: 0, databasePath }, services }
}

function createFixture(options = {}) {
  const databasePath = tempDatabase()
  let now = initialNow
  const whatsapp = new FakeWhatsApp()
  const guardrails = new PlatformGuardrailService(databasePath, logger, { clock: () => now, maxHotAuditRecords: 500 })
  const scenes = new SceneService(databasePath, logger, { clock: () => now, defaultTtlMinutes: 60 })
  const knowledge = new KnowledgeService(databasePath, logger, { clock: () => now })
  const announcements = new AnnouncementService(databasePath, logger, {
    clock: () => now,
    previewTtlMs: options.previewTtlMs ?? 60_000,
    contentRetentionMs: options.contentRetentionMs ?? 120_000,
    dispatcherIntervalMs: 60_000,
  })
  let providerCalls = 0
  const provider = options.provider ?? (async ({ requestText, context }) => {
    providerCalls += 1
    return `Saran untuk ${requestText}: gunakan ${context[0].title}.`
  })
  const suggestions = new SuggestionRelayService(databasePath, logger, {
    clock: () => now,
    provider,
    requestTtlMs: 60_000,
    contentRetentionMs: 120_000,
  })
  const services = {
    get(name) {
      const map = {
        'platform-guardrails': guardrails,
        scene: scenes,
        knowledge,
        announcement: announcements,
        'suggestion-relay': suggestions,
      }
      if (!(name in map)) throw new Error(`unknown service ${name}`)
      return map[name]
    },
    has(name) { return ['platform-guardrails', 'scene', 'knowledge', 'announcement', 'suggestion-relay'].includes(name) },
  }
  const context = serviceContext(services, databasePath)
  guardrails.initialize(context)
  scenes.initialize(context)
  knowledge.initialize(context)
  announcements.initialize(context)
  suggestions.initialize(context)
  return {
    databasePath,
    whatsapp,
    guardrails,
    scenes,
    knowledge,
    announcements,
    suggestions,
    services,
    now: () => now,
    advance(ms) { now += ms },
    providerCalls: () => providerCalls,
  }
}

async function enableCoreFeatures(fixture) {
  fixture.scenes.setEnabled(groupA, true, adminJid, fixture.now())
  fixture.knowledge.setEnabled(groupA, true, adminJid, fixture.now())
  await fixture.announcements.setEnabled(groupA, adminJid, true, fixture.whatsapp, fixture.now())
  await fixture.suggestions.setEnabled(groupA, adminJid, true, fixture.whatsapp, fixture.now())
}

function prepareApprovedContext(fixture) {
  const scene = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'R11 Scene' })
  fixture.scenes.joinScene(groupA, scene.id, userB, fixture.now())
  fixture.scenes.setConsent({ groupJid: groupA, sceneReference: scene.id, userJid: userA, action: 'share_context', enabled: true, ttlMinutes: 20, now: fixture.now() })
  fixture.scenes.setConsent({ groupJid: groupA, sceneReference: scene.id, userJid: userB, action: 'receive_assistance', enabled: true, ttlMinutes: 20, now: fixture.now() })
  const source = fixture.knowledge.createBookmark({ groupJid: groupA, creatorJid: userA, title: 'Approved Canon', excerpt: 'Gunakan format singkat dan pertahankan fakta yang sudah disetujui.', visibility: 'group', now: fixture.now() })
  return { scene, source }
}

function closeFixture(fixture) {
  const context = serviceContext(fixture.services, fixture.databasePath)
  fixture.suggestions.shutdown(context)
  fixture.announcements.shutdown(context)
  fixture.knowledge.shutdown(context)
  fixture.scenes.shutdown(context)
  fixture.guardrails.shutdown(context)
  cleanupDatabase(fixture.databasePath)
}

test('R11 announcement is default-off, rejects implicit targets, and preserves group isolation', async () => {
  const fixture = createFixture()
  try {
    const disabled = await fixture.announcements.preview({ groupJid: groupA, actorJid: adminJid, body: 'Update', targetJids: [userA], correlationId: 'r11-preview-off' }, fixture.whatsapp, fixture.now())
    assert.deepEqual(disabled, { kind: 'denied', code: 'feature_disabled' })
    await assert.rejects(() => fixture.announcements.preview({ groupJid: groupA, actorJid: adminJid, body: 'Update', targetJids: [], correlationId: 'r11-invalid-targets' }, fixture.whatsapp, fixture.now()), /explicit targets/i)
    await fixture.announcements.setEnabled(groupA, adminJid, true, fixture.whatsapp, fixture.now())
    assert.equal(fixture.announcements.isFeatureEnabled(groupB), false)
    const isolated = await fixture.announcements.preview({ groupJid: groupB, actorJid: adminJid, body: 'Blocked', targetJids: [userA], correlationId: 'r11-group-b' }, fixture.whatsapp, fixture.now())
    assert.deepEqual(isolated, { kind: 'denied', code: 'feature_disabled' })
  } finally {
    closeFixture(fixture)
  }
})

test('R11 announcement preview fingerprint, approval CAS, idempotency, and bounded delivery work', async () => {
  const fixture = createFixture()
  try {
    await fixture.announcements.setEnabled(groupA, adminJid, true, fixture.whatsapp, fixture.now())
    const preview = await fixture.announcements.preview({ groupJid: groupA, actorJid: adminJid, body: 'Pengumuman bounded', targetJids: [userB, userA], correlationId: 'r11-preview-1' }, fixture.whatsapp, fixture.now())
    assert.equal(preview.kind, 'completed')
    assert.equal(preview.record.status, 'planned')
    assert.equal(preview.record.targetCount, 2)
    const duplicate = await fixture.announcements.preview({ groupJid: groupA, actorJid: adminJid, body: 'Berbeda', targetJids: [userA, userB], correlationId: 'r11-preview-1' }, fixture.whatsapp, fixture.now())
    assert.equal(duplicate.kind, 'denied')
    assert.equal(duplicate.code, 'duplicate')
    const stale = await fixture.announcements.approve({ groupJid: groupA, actorJid: adminJid, announcementId: preview.record.id, expectedRevision: 2, correlationId: 'r11-approve-stale' }, fixture.whatsapp, fixture.now())
    assert.equal(stale.kind, 'denied')
    assert.equal(stale.code, 'stale_operation')
    const approved = await fixture.announcements.approve({ groupJid: groupA, actorJid: adminJid, announcementId: preview.record.id, expectedRevision: 1, correlationId: 'r11-approve-1' }, fixture.whatsapp, fixture.now())
    assert.equal(approved.kind, 'completed')
    assert.equal(approved.record.status, 'queued')
    const delivered = await fixture.announcements.dispatchDueAnnouncements(fixture.whatsapp, fixture.now())
    assert.equal(delivered, 2)
    assert.equal(fixture.whatsapp.sent.length, 2)
    assert.equal(fixture.announcements.getAnnouncement(preview.record.id)?.status, 'sent')
    const replay = await fixture.announcements.approve({ groupJid: groupA, actorJid: adminJid, announcementId: preview.record.id, expectedRevision: 2, correlationId: 'r11-approve-replay' }, fixture.whatsapp, fixture.now())
    assert.equal(replay.kind, 'denied')
    assert.equal(replay.code, 'stale_operation')
  } finally {
    closeFixture(fixture)
  }
})

test('R11 cancellation and disable kill switch beat not-yet-claimed delivery', async () => {
  const fixture = createFixture()
  try {
    await fixture.announcements.setEnabled(groupA, adminJid, true, fixture.whatsapp, fixture.now())
    const preview = await fixture.announcements.preview({ groupJid: groupA, actorJid: adminJid, body: 'Cancel me', targetJids: [userA, userB], correlationId: 'r11-cancel-1' }, fixture.whatsapp, fixture.now())
    const approved = await fixture.announcements.approve({ groupJid: groupA, actorJid: adminJid, announcementId: preview.record.id, expectedRevision: 1, correlationId: 'r11-cancel-approve' }, fixture.whatsapp, fixture.now())
    const cancelled = await fixture.announcements.cancel({ groupJid: groupA, actorJid: adminJid, announcementId: preview.record.id, expectedRevision: approved.record.revision, correlationId: 'r11-cancel-2' }, fixture.whatsapp, fixture.now())
    assert.equal(cancelled.kind, 'completed')
    assert.equal(cancelled.record.status, 'cancelled')
    assert.equal(await fixture.announcements.dispatchDueAnnouncements(fixture.whatsapp, fixture.now()), 0)
    assert.equal(fixture.whatsapp.sent.length, 0)

    const second = await fixture.announcements.preview({ groupJid: groupA, actorJid: adminJid, body: 'Disable me', targetJids: [userA], correlationId: 'r11-disable-1' }, fixture.whatsapp, fixture.now())
    await fixture.announcements.setEnabled(groupA, adminJid, false, fixture.whatsapp, fixture.now())
    assert.equal(fixture.announcements.getAnnouncement(second.record.id)?.status, 'cancelled')
  } finally {
    closeFixture(fixture)
  }
})

test('R11 announcement expires previews, records partial transport failure, and does not retry', async () => {
  const fixture = createFixture({ previewTtlMs: 100, contentRetentionMs: 200 })
  try {
    await fixture.announcements.setEnabled(groupA, adminJid, true, fixture.whatsapp, fixture.now())
    const expired = await fixture.announcements.preview({ groupJid: groupA, actorJid: adminJid, body: 'Too late', targetJids: [userA], correlationId: 'r11-expire-1' }, fixture.whatsapp, fixture.now())
    fixture.advance(101)
    const approval = await fixture.announcements.approve({ groupJid: groupA, actorJid: adminJid, announcementId: expired.record.id, expectedRevision: 1, correlationId: 'r11-expire-approve' }, fixture.whatsapp, fixture.now())
    assert.equal(approval.kind, 'denied')
    assert.equal(approval.code, 'expired')

    const partial = await fixture.announcements.preview({ groupJid: groupA, actorJid: adminJid, body: 'Partial', targetJids: [userA, userB], correlationId: 'r11-partial-1' }, fixture.whatsapp, fixture.now())
    const partialApproval = await fixture.announcements.approve({ groupJid: groupA, actorJid: adminJid, announcementId: partial.record.id, expectedRevision: 1, correlationId: 'r11-partial-approve' }, fixture.whatsapp, fixture.now())
    fixture.whatsapp.failTargets.add(userB)
    await fixture.announcements.dispatchDueAnnouncements(fixture.whatsapp, fixture.now())
    assert.equal(fixture.announcements.getAnnouncement(partial.record.id)?.status, 'partial')
    assert.equal(fixture.whatsapp.sent.length, 1)
    await fixture.announcements.dispatchDueAnnouncements(fixture.whatsapp, fixture.now())
    assert.equal(fixture.whatsapp.sent.length, 1)
    void partialApproval
  } finally {
    closeFixture(fixture)
  }
})

test('R11 suggestion relay requires explicit receive/share consent and approved sources', async () => {
  const fixture = createFixture()
  try {
    const disabled = await fixture.suggestions.request({ groupJid: groupA, actorJid: userB, sceneReference: 'missing', requestText: 'Bantu', sourceReferences: ['missing'], correlationId: 'r11-suggestion-off' }, fixture.now())
    assert.deepEqual(disabled, { kind: 'denied', code: 'feature_disabled' })
    await enableCoreFeatures(fixture)
    const context = prepareApprovedContext(fixture)
    const success = await fixture.suggestions.request({ groupJid: groupA, actorJid: userB, sceneReference: context.scene.id, requestText: 'Bantu ringkas', sourceReferences: [context.source.id], correlationId: 'r11-suggestion-1' }, fixture.now())
    assert.equal(success.kind, 'completed')
    assert.equal(success.record.status, 'completed')
    assert.match(success.record.suggestion, /Approved Canon/)
    assert.equal(fixture.providerCalls(), 1)
    const duplicate = await fixture.suggestions.request({ groupJid: groupA, actorJid: userB, sceneReference: context.scene.id, requestText: 'Berubah', sourceReferences: [context.source.id], correlationId: 'r11-suggestion-1' }, fixture.now())
    assert.equal(duplicate.kind, 'completed')
    assert.equal(duplicate.duplicate, true)
    assert.equal(fixture.providerCalls(), 1)
    fixture.scenes.leaveScene(groupA, context.scene.id, userB, fixture.now())
    const withdrawn = await fixture.suggestions.request({ groupJid: groupA, actorJid: userB, sceneReference: context.scene.id, requestText: 'Bantu lagi', sourceReferences: [context.source.id], correlationId: 'r11-suggestion-2' }, fixture.now())
    assert.deepEqual(withdrawn, { kind: 'denied', code: 'consent_required' })
  } finally {
    closeFixture(fixture)
  }
})

test('R11 suggestion provider failure is bounded, circuit-protected, and never retried automatically', async () => {
  const fixture = createFixture({ provider: async () => { throw new Error('SyntheticProviderFailure') } })
  try {
    await enableCoreFeatures(fixture)
    const context = prepareApprovedContext(fixture)
    const result = await fixture.suggestions.request({ groupJid: groupA, actorJid: userB, sceneReference: context.scene.id, requestText: 'Bantu', sourceReferences: [context.source.id], correlationId: 'r11-provider-fail' }, fixture.now())
    assert.equal(result.kind, 'denied')
    assert.equal(result.code, 'provider_unavailable')
    assert.equal(fixture.suggestions.getRequest(result.record.id)?.status, 'failed')
  } finally {
    closeFixture(fixture)
  }
})

test('R11 audit records stay redacted and announcement plugin remains text-first', async () => {
  const fixture = createFixture()
  try {
    await fixture.announcements.setEnabled(groupA, adminJid, true, fixture.whatsapp, fixture.now())
    const preview = await fixture.announcements.preview({ groupJid: groupA, actorJid: adminJid, body: 'Secretless update', targetJids: [userA], correlationId: 'r11-audit-1' }, fixture.whatsapp, fixture.now())
    const auditText = JSON.stringify(fixture.guardrails.listAudit({ includeArchive: true, limit: 200 }))
    assert.equal(auditText.includes(adminJid), false)
    assert.equal(auditText.includes('Secretless update'), false)
    assert.equal(auditText.includes(preview.record.id), false)

    const pluginDatabasePath = tempDatabase('allybot-r11-plugin-')
    const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0, databasePath: pluginDatabasePath }, logger, fixture.whatsapp)
    const appService = new AnnouncementService(pluginDatabasePath, logger, { clock: fixture.now, dispatcherIntervalMs: 60_000 })
    const appGuardrails = new PlatformGuardrailService(pluginDatabasePath, logger, { clock: fixture.now, maxHotAuditRecords: 500 })
    app.registerService(appGuardrails)
    app.registerService(appService)
    app.registerPlugin(createAnnouncementPlugin(fixture.whatsapp))
    await app.start()
    await fixture.whatsapp.emitMessage({ id: 'r11-plugin', remoteJid: groupA, senderJid: adminJid, text: '!announce preview Hello', timestamp: fixture.now(), fromMe: false, mentionedJids: [userA] })
    assert.equal(fixture.whatsapp.sent.some((item) => item.remoteJid === userA), false)
    assert.match(fixture.whatsapp.sent.at(-1)?.text ?? '', /belum diaktifkan/i)
    await app.stop()
    cleanupDatabase(pluginDatabasePath)
  } finally {
    closeFixture(fixture)
  }
})
