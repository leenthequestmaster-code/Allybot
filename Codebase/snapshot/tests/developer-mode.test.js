import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { DeveloperModeService } from '../dist/services/developer-mode-service.js'
import { developerModePlugin } from '../dist/framework/plugins/developer-mode.js'

const logger = pino({ level: 'silent' })
const ownerJid = '<jid-redacted@s.whatsapp.net>'
const targetJid = '<jid-redacted@s.whatsapp.net>'

class DeveloperCore {
  isConnected = true
  currentStatus = 'connected'
  userJid = 'bot@s.whatsapp.net'
  sent = []
  messages = new Set()
  groupParticipantListeners = new Set()
  connections = new Set()
  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener) }
  onGroupParticipantUpdate(listener) { this.groupParticipantListeners.add(listener); return () => this.groupParticipantListeners.delete(listener) }
  onConnectionState(listener) { this.connections.add(listener); return () => this.connections.delete(listener) }
  async sendText(remoteJid, text) { this.sent.push({ remoteJid, text }) }
  async getGroupMetadata() { throw new Error('not used in developer mode test') }
  async getGroupInviteLink() { return undefined }
  clearRuntimeCaches() { return { duplicateMessages: 2, groupNames: 1, retryCounters: 1 } }
  async start() { this.isConnected = true }
  async close() { this.isConnected = false }
  async emitMessage(message) { await Promise.all([...this.messages].map((listener) => listener(message))) }
}

function privateMessage(id, senderJid, text) {
  return { id, remoteJid: senderJid, senderJid, text, timestamp: Date.now(), fromMe: false }
}

function groupMessage(id, senderJid, text) {
  return { id, remoteJid: '<jid-redacted@g.us>', senderJid, text, timestamp: Date.now(), fromMe: false }
}

function tempDatabase() {
  return join(mkdtempSync(join(tmpdir(), 'allybot-developer-mode-')), 'core.sqlite')
}

function waitForCommandCooldown() {
  return new Promise((resolve) => setTimeout(resolve, 1_050))
}

test('DeveloperModeService enforces activation, expiry, revoke, and global kill/resume', () => {
  const databasePath = tempDatabase()
  let now = 1_700_000_000_000
  const service = new DeveloperModeService(databasePath, logger, { clock: () => now, maxAuditRecords: 20 })
  service.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 } })
  try {
    const activation = service.activate(ownerJid, targetJid, 'observer', 60_000, 'debug connection')
    assert.equal(service.evaluate(targetJid).allowed, true)
    assert.equal(service.listVisibleActivations(targetJid, false).length, 1)

    now += 60_000
    assert.equal(service.evaluate(targetJid).allowed, false)
    assert.equal(service.getActivation(activation.id)?.expiredAt, now)
    assert.ok(service.listAudit(20).some((record) => record.event === 'activation.expired'))

    now += 1
    const second = service.activate(ownerJid, targetJid, 'observer', 60_000, 'debug again')
    assert.equal(service.revoke(ownerJid, second.id), true)
    assert.equal(service.evaluate(targetJid).allowed, false)

    const third = service.activate(ownerJid, targetJid, 'observer', 60_000, 'global kill test')
    assert.equal(service.evaluate(targetJid).allowed, true)
    service.setGlobalEnabled(ownerJid, false)
    assert.equal(service.evaluate(targetJid).allowed, false)
    service.setGlobalEnabled(ownerJid, true)
    assert.equal(service.evaluate(targetJid).allowed, true)
    assert.equal(service.getActivation(third.id)?.revokedAt, undefined)
  } finally {
    service.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 } })
    rmSync(databasePath, { force: true })
    rmSync(join(databasePath, '-wal'), { force: true })
    rmSync(join(databasePath, '-shm'), { force: true })
  }
})

test('DeveloperModeService enforces active-target uniqueness and bounded audit retention', () => {
  const databasePath = tempDatabase()
  const service = new DeveloperModeService(databasePath, logger, { maxActivations: 1, maxAuditRecords: 3 })
  service.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 } })
  try {
    const activation = service.activate(ownerJid, targetJid, 'observer', 60_000, 'uniqueness')
    assert.throws(
      () => service.activate(ownerJid, targetJid, 'observer', 60_000, 'duplicate'),
      /already has an active Developer Mode activation/,
    )
    assert.throws(
      () => service.activate(ownerJid, '<jid-redacted@s.whatsapp.net>', 'observer', 60_000, 'capacity'),
      /activation limit reached/,
    )
    service.evaluate('<jid-redacted@s.whatsapp.net>')
    service.evaluate('<jid-redacted@s.whatsapp.net>')
    assert.ok(service.listAudit(100).length <= 3)
    assert.equal(service.getActivation(activation.id)?.targetJid, targetJid)
  } finally {
    service.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 } })
    rmSync(databasePath, { force: true })
    rmSync(join(databasePath, '-wal'), { force: true })
    rmSync(join(databasePath, '-shm'), { force: true })
  }
})

test('Developer Mode command is owner-controlled, private-only, and redacted', async () => {
  const databasePath = tempDatabase()
  const core = new DeveloperCore()
  const service = new DeveloperModeService(databasePath, logger)
  const app = new ApplicationFramework(
    { commandPrefix: '!', defaultCooldownMs: 0, botOwnerJid: ownerJid, databasePath },
    logger,
    core,
    { permissionResolver: createPermissionResolver(core, ownerJid) },
  )
  app.registerService(service)
  app.registerPlugin(developerModePlugin)
  await app.start()

  try {
    await core.emitMessage(privateMessage('enable', ownerJid, `!dev enable ${targetJid} observer 10 incident diagnosis`))
    assert.match(core.sent[0].text, /Developer Mode berhasil diaktifkan/)
    const activationId = core.sent[0].text.match(/ID: (dm_[a-f0-9]{20})/)?.[1]
    assert.ok(activationId)

    await core.emitMessage(privateMessage('runtime', targetJid, '!dev runtime'))
    assert.match(core.sent[1].text, /Developer Runtime Snapshot/)
    assert.match(core.sent[1].text, /Credentials\/session\/database\/raw logs: redacted/)
    assert.equal(core.sent[1].text.includes(targetJid), false)

    await core.emitMessage(groupMessage('group-runtime', targetJid, '!dev runtime'))
    assert.match(core.sent[2].text, /hanya dapat digunakan melalui private chat/)
    const boundaryAudit = service.listAudit(100)
    assert.ok(boundaryAudit.some((record) => record.event === 'access.denied'))
    assert.equal(JSON.stringify(boundaryAudit).includes(targetJid), false)

    await waitForCommandCooldown()
    await core.emitMessage(privateMessage('kill', ownerJid, '!debug kill'))
    assert.match(core.sent[3].text, /dinonaktifkan secara global/)
    await core.emitMessage(privateMessage('blocked', targetJid, '!dev runtime'))
    assert.match(core.sent[4].text, /Developer Mode belum aktif/)

    await waitForCommandCooldown()
    await core.emitMessage(privateMessage('resume', ownerJid, '!dev resume'))
    assert.match(core.sent[5].text, /global diaktifkan kembali/)
    await waitForCommandCooldown()
    await core.emitMessage(privateMessage('disable', ownerJid, `!dev disable ${activationId}`))
    assert.match(core.sent[6].text, /berhasil dicabut/)
    await core.emitMessage(privateMessage('revoked', targetJid, '!dev runtime'))
    assert.match(core.sent[7].text, /Developer Mode belum aktif/)
  } finally {
    await app.stop()
    rmSync(databasePath, { force: true })
    rmSync(join(databasePath, '-wal'), { force: true })
    rmSync(join(databasePath, '-shm'), { force: true })
  }
})
