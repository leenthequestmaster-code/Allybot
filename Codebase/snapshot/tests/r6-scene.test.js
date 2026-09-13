import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { createScenePlugin } from '../dist/framework/plugins/scene.js'
import { SceneService } from '../dist/services/scene-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const groupA = '<jid-redacted@g.us>'
const groupB = '<jid-redacted@g.us>'
const adminJid = '<jid-redacted@s.whatsapp.net>'
const userA = '<jid-redacted@s.whatsapp.net>'
const userB = '<jid-redacted@s.whatsapp.net>'
const botJid = '<jid-redacted@s.whatsapp.net>'
const initialNow = Date.UTC(2024, 0, 1, 12, 0, 0)

function tempDatabase(prefix = 'allybot-r6-') {
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
  const guardrails = new PlatformGuardrailService(databasePath, logger, { clock: () => now, maxHotAuditRecords: 400 })
  const scenes = new SceneService(databasePath, logger, { clock: () => now, defaultTtlMinutes: 60 })
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'scene') return scenes
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'scene' },
  }
  guardrails.initialize(serviceContext(services, databasePath))
  scenes.initialize(serviceContext(services, databasePath))
  scenes.setEnabled(groupA, true, adminJid, now)
  return { databasePath, guardrails, scenes, now: () => now, advance(ms) { now += ms }, services }
}

function closeFixture(fixture) {
  fixture.scenes.shutdown(serviceContext(fixture.services, fixture.databasePath))
  fixture.guardrails.shutdown(serviceContext(fixture.services, fixture.databasePath))
  cleanupDatabase(fixture.databasePath)
}

test('R6 default-off blocks scene mutation until the group flag is enabled', () => {
  const fixture = createFixture()
  try {
    scenesOff(fixture)
    assert.equal(fixture.scenes.isEnabled(groupB), false)
    assert.throws(() => fixture.scenes.openScene({ groupJid: groupB, creatorJid: userA, title: 'Blocked' }), /disabled/i)
    const scene = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'Allowed' })
    assert.equal(scene.status, 'open')
  } finally {
    closeFixture(fixture)
  }
})

function scenesOff(fixture) {
  assert.equal(fixture.scenes.isEnabled(groupB), false)
}

test('R6 keeps two parallel scenes and groups isolated', () => {
  const fixture = createFixture()
  try {
    fixture.scenes.setEnabled(groupB, true, adminJid, fixture.now())
    const first = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'Scene A' })
    const second = fixture.scenes.openScene({ groupJid: groupB, creatorJid: userB, title: 'Scene B' })
    assert.equal(fixture.scenes.listVisibleScenes(groupA, userB).length, 1)
    assert.equal(fixture.scenes.listVisibleScenes(groupA, userB)[0].scene.id, first.id)
    assert.equal(fixture.scenes.getVisibleScene(groupB, first.id, userB), undefined)
    assert.throws(() => fixture.scenes.joinScene(groupB, first.id, userA), /tidak ditemukan|Scene/i)
    assert.notEqual(first.id, second.id)
  } finally {
    closeFixture(fixture)
  }
})

test('R6 public scenes support opt-in join while private scenes fail closed for nonparticipants', () => {
  const fixture = createFixture()
  try {
    const publicScene = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'Open Table', visibility: 'public' })
    const privateScene = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'Private Table', visibility: 'private' })
    assert.equal(fixture.scenes.getVisibleScene(groupA, publicScene.id, userB)?.participant, undefined)
    assert.equal(fixture.scenes.getVisibleScene(groupA, privateScene.id, userB), undefined)
    const participant = fixture.scenes.joinScene(groupA, publicScene.id, userB)
    assert.equal(participant.status, 'active')
    assert.equal(fixture.scenes.getVisibleScene(groupA, publicScene.id, userB)?.participant?.userJid, userB)
  } finally {
    closeFixture(fixture)
  }
})

test('R6 leaving withdraws consent and rejoining requires consent again', () => {
  const fixture = createFixture()
  try {
    const record = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'Consent Table' })
    fixture.scenes.joinScene(groupA, record.id, userB)
    fixture.scenes.setConsent({ groupJid: groupA, sceneReference: record.id, userJid: userB, action: 'participate', enabled: true, ttlMinutes: 10 })
    assert.equal(fixture.scenes.hasConsent(groupA, record.id, userB, 'participate'), true)
    assert.equal(fixture.scenes.leaveScene(groupA, record.id, userB), true)
    assert.equal(fixture.scenes.hasConsent(groupA, record.id, userB, 'participate'), false)
    fixture.scenes.joinScene(groupA, record.id, userB)
    assert.equal(fixture.scenes.hasConsent(groupA, record.id, userB, 'participate'), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R6 IC/OOC is presentation metadata and does not grant consent or access', () => {
  const fixture = createFixture()
  try {
    const record = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'Boundary Table' })
    assert.throws(() => fixture.scenes.setMode(groupA, record.id, userB, 'ic'), /participant/i)
    fixture.scenes.joinScene(groupA, record.id, userB)
    const participant = fixture.scenes.setMode(groupA, record.id, userB, 'ic')
    assert.equal(participant.mode, 'ic')
    assert.equal(fixture.scenes.hasConsent(groupA, record.id, userB, 'participate'), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R6 lifecycle is creator-only and stale revision fails closed', () => {
  const fixture = createFixture()
  try {
    const record = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'Lifecycle Table' })
    assert.throws(() => fixture.scenes.pauseScene(groupA, record.id, userB), /creator/i)
    const paused = fixture.scenes.pauseScene(groupA, record.id, userA, 0)
    assert.equal(paused.status, 'paused')
    assert.equal(paused.revision, 1)
    assert.throws(() => fixture.scenes.resumeScene(groupA, record.id, userA, 0), /stale/i)
    const resumed = fixture.scenes.resumeScene(groupA, record.id, userA, paused.revision)
    assert.equal(resumed.status, 'open')
    const closed = fixture.scenes.closeScene(groupA, record.id, userA, resumed.revision)
    assert.equal(closed.status, 'closed')
    assert.equal(fixture.scenes.hasConsent(groupA, record.id, userA, 'participate'), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R6 consent supports scoped actions, withdrawal, and expiry', () => {
  const fixture = createFixture()
  try {
    const record = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'Consent Window' })
    const consent = fixture.scenes.setConsent({ groupJid: groupA, sceneReference: record.id, userJid: userA, action: 'share_context', enabled: true, ttlMinutes: 1 })
    assert.equal(consent.enabled, true)
    assert.equal(fixture.scenes.hasConsent(groupA, record.id, userA, 'share_context'), true)
    fixture.advance(60_000)
    assert.equal(fixture.scenes.hasConsent(groupA, record.id, userA, 'share_context'), false)
    const withdrawn = fixture.scenes.setConsent({ groupJid: groupA, sceneReference: record.id, userJid: userA, action: 'share_context', enabled: false })
    assert.equal(withdrawn.enabled, false)
    assert.throws(() => fixture.scenes.setConsent({ groupJid: groupA, sceneReference: record.id, userJid: userA, action: 'unknown', enabled: true }), /Consent action/i)
  } finally {
    closeFixture(fixture)
  }
})

test('R6 expiry closes active scene and prevents post-expiry consent', () => {
  const fixture = createFixture()
  try {
    const record = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'Expiring Table', ttlMinutes: 1 })
    fixture.advance(60_000)
    assert.equal(fixture.scenes.expireScenes(), 1)
    assert.equal(fixture.scenes.getVisibleScene(groupA, record.id, userA), undefined)
    assert.equal(fixture.scenes.hasConsent(groupA, record.id, userA, 'participate'), false)
    assert.throws(() => fixture.scenes.pauseScene(groupA, record.id, userA), /transition|expired/i)
  } finally {
    closeFixture(fixture)
  }
})

test('R6 audit redacts raw JIDs, title, and scene identifier', () => {
  const fixture = createFixture()
  try {
    const record = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'Secret Title' })
    fixture.scenes.joinScene(groupA, record.id, userB)
    fixture.scenes.setConsent({ groupJid: groupA, sceneReference: record.id, userJid: userB, action: 'participate', enabled: true })
    const auditText = JSON.stringify(fixture.guardrails.listAudit({ includeArchive: true, limit: 400 }))
    assert.equal(auditText.includes(groupA), false)
    assert.equal(auditText.includes(userA), false)
    assert.equal(auditText.includes(userB), false)
    assert.equal(auditText.includes('Secret Title'), false)
    assert.equal(auditText.includes(record.id), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R6 scene state survives service restart', () => {
  const fixture = createFixture()
  try {
    const record = fixture.scenes.openScene({ groupJid: groupA, creatorJid: userA, title: 'Restart Table' })
    fixture.scenes.joinScene(groupA, record.id, userB)
    fixture.scenes.shutdown(serviceContext(fixture.services, fixture.databasePath))
    fixture.scenes.initialize(serviceContext(fixture.services, fixture.databasePath))
    const restored = fixture.scenes.getVisibleScene(groupA, record.id, userB)
    assert.equal(restored?.scene.title, 'Restart Table')
    assert.equal(restored?.participant?.status, 'active')
  } finally {
    closeFixture(fixture)
  }
})

class SceneCore {
  isConnected = true
  currentStatus = 'connected'
  userJid = botJid
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: groupA,
    subject: 'Scene Test Group',
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

test('R6 plugin is default-off, admin-gated, text-only, and supports lifecycle fallback', async () => {
  const databasePath = tempDatabase('allybot-r6-plugin-')
  const core = new SceneCore()
  const guardrails = new PlatformGuardrailService(databasePath, logger)
  const scenes = new SceneService(databasePath, logger)
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'scene') return scenes
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'scene' },
  }
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0, databasePath }, logger, core, { permissionResolver: createPermissionResolver(core) })
  app.registerService(guardrails)
  app.registerService(scenes)
  app.registerPlugin(createScenePlugin(core))
  await app.start()
  try {
    await core.emitMessage(groupMessage('off', userA, '!scene open Blocked'))
    assert.match(core.sent.at(-1).text, /belum aktif/i)
    await core.emitMessage(groupMessage('forbidden', userA, '!setscene on'))
    assert.match(core.sent.at(-1).text, /hanya dapat digunakan oleh admin/i)
    await core.emitMessage(groupMessage('enable', adminJid, '!setscene on'))
    assert.match(core.sent.at(-1).text, /on/i)
    await core.emitMessage(groupMessage('open', userA, '!scene open Town Square public ttl=30'))
    assert.match(core.sent.at(-1).text, /Scene dibuat/i)
    const sceneId = scenes.listVisibleScenes(groupA, userA)[0].scene.id.slice(0, 8)
    await core.emitMessage(groupMessage('mode', userB, `!ic ${sceneId}`))
    assert.match(core.sent.at(-1).text, /participant/i)
    await core.emitMessage(groupMessage('join', userB, `!scene join ${sceneId}`))
    assert.match(core.sent.at(-1).text, /bergabung/i)
    await core.emitMessage(groupMessage('ic', userB, `!ic ${sceneId}`))
    assert.match(core.sent.at(-1).text, /metadata presentasi/i)
    await core.emitMessage(groupMessage('help', userB, '!scene unknown'))
    assert.match(core.sent.at(-1).text, /scene open/i)
  } finally {
    await app.stop()
    cleanupDatabase(databasePath)
  }
})
