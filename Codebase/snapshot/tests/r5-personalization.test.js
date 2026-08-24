import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { createPersonalizationPlugin } from '../dist/framework/plugins/personalization.js'
import { CollaborationService } from '../dist/services/collaboration-service.js'
import { PersonalizationService } from '../dist/services/personalization-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const groupA = '<jid-redacted@g.us>'
const groupB = '<jid-redacted@g.us>'
const adminJid = '<jid-redacted@s.whatsapp.net>'
const userA = '<jid-redacted@s.whatsapp.net>'
const userB = '<jid-redacted@s.whatsapp.net>'
const botJid = '<jid-redacted@s.whatsapp.net>'
const initialNow = Date.UTC(2024, 0, 1, 12, 0, 0)

function tempDatabase(prefix = 'allybot-r5-') {
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
  let now = initialNow
  const guardrails = new PlatformGuardrailService(databasePath, logger, { clock: () => now, maxHotAuditRecords: 300 })
  const personalization = new PersonalizationService(databasePath, logger, { clock: () => now, ...options })
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'personalization') return personalization
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'personalization' },
  }
  guardrails.initialize(serviceContext(services, databasePath))
  personalization.initialize(serviceContext(services, databasePath))
  personalization.setEnabled(groupA, true, adminJid, now)
  return {
    databasePath,
    guardrails,
    personalization,
    advance(ms) { now += ms },
    setNow(value) { now = value },
    now: () => now,
  }
}

function closeFixture(fixture) {
  fixture.personalization.shutdown(serviceContext({}, fixture.databasePath))
  fixture.guardrails.shutdown(serviceContext({}, fixture.databasePath))
  cleanupDatabase(fixture.databasePath)
}

test('R5 default-off blocks preference persistence and leaves default resolution', () => {
  const fixture = createFixture()
  try {
    fixture.personalization.setEnabled(groupA, false, adminJid, fixture.now())
    assert.equal(fixture.personalization.isEnabled(groupA), false)
    assert.deepEqual(fixture.personalization.resolvePreferences(groupA, userA), {
      groupJid: groupA,
      userJid: userA,
      language: 'id',
      timezone: 'UTC',
      notificationsEnabled: true,
      verbosity: 'normal',
      format: 'plain',
      sources: {
        language: 'default',
        timezone: 'default',
        quietHours: 'default',
        notificationsEnabled: 'default',
        verbosity: 'default',
        format: 'default',
      },
    })
    assert.throws(() => fixture.personalization.setUserLanguage(groupA, userA, 'en'), /disabled/i)
  } finally {
    closeFixture(fixture)
  }
})

test('R5 accepts canonical IANA timezone and rejects offset or unknown values', () => {
  const fixture = createFixture()
  try {
    const record = fixture.personalization.setUserTimezone(groupA, userA, 'Asia/Jakarta', fixture.now())
    assert.equal(record.timezone, 'Asia/Jakarta')
    assert.throws(() => fixture.personalization.setUserTimezone(groupA, userA, '+07:00'), /IANA/i)
    assert.throws(() => fixture.personalization.setUserTimezone(groupA, userA, 'Not/AZone'), /IANA/i)
    assert.throws(() => fixture.personalization.setUserTimezone(groupA, userA, 'Asia Jakarta'), /IANA/i)
  } finally {
    closeFixture(fixture)
  }
})

test('R5 quiet hours suppress notifications inside a normal interval', () => {
  const fixture = createFixture()
  try {
    fixture.personalization.setGroupTimezone(groupA, adminJid, 'UTC', fixture.now())
    fixture.personalization.setGroupQuietHours(groupA, adminJid, { start: '09:00', end: '17:00' }, fixture.now())
    assert.equal(fixture.personalization.evaluateGroupNotification(groupA, Date.UTC(2024, 0, 1, 12)).reason, 'quiet-hours')
    assert.equal(fixture.personalization.evaluateGroupNotification(groupA, Date.UTC(2024, 0, 1, 17)).allowed, true)
    assert.equal(fixture.personalization.evaluateGroupNotification(groupA, Date.UTC(2024, 0, 1, 8)).allowed, true)
  } finally {
    closeFixture(fixture)
  }
})

test('R5 quiet hours support an overnight interval', () => {
  const fixture = createFixture()
  try {
    fixture.personalization.setGroupQuietHours(groupA, adminJid, { start: '22:00', end: '07:00' }, fixture.now())
    assert.equal(fixture.personalization.evaluateGroupNotification(groupA, Date.UTC(2024, 0, 1, 23)).reason, 'quiet-hours')
    assert.equal(fixture.personalization.evaluateGroupNotification(groupA, Date.UTC(2024, 0, 2, 6, 59)).reason, 'quiet-hours')
    assert.equal(fixture.personalization.evaluateGroupNotification(groupA, Date.UTC(2024, 0, 2, 7)).allowed, true)
  } finally {
    closeFixture(fixture)
  }
})

test('R5 resolves explicit user override before group policy and global defaults', () => {
  const fixture = createFixture()
  try {
    fixture.personalization.setGroupLanguage(groupA, adminJid, 'en', fixture.now())
    fixture.personalization.setGroupTimezone(groupA, adminJid, 'Asia/Jakarta', fixture.now())
    fixture.personalization.setGroupVerbosity(groupA, adminJid, 'detailed', fixture.now())
    fixture.personalization.setUserLanguage(groupA, userA, 'id', fixture.now())
    fixture.personalization.setUserNotifications(groupA, userA, false, fixture.now())
    const resolved = fixture.personalization.resolvePreferences(groupA, userA)
    assert.equal(resolved.language, 'id')
    assert.equal(resolved.sources.language, 'user')
    assert.equal(resolved.timezone, 'Asia/Jakarta')
    assert.equal(resolved.sources.timezone, 'group')
    assert.equal(resolved.verbosity, 'detailed')
    assert.equal(resolved.sources.verbosity, 'group')
    assert.equal(resolved.notificationsEnabled, false)
    assert.equal(resolved.sources.notificationsEnabled, 'user')
    assert.equal(resolved.format, 'plain')
    assert.equal(resolved.sources.format, 'default')
  } finally {
    closeFixture(fixture)
  }
})

test('R5 isolates users and groups', () => {
  const fixture = createFixture()
  try {
    fixture.personalization.setUserVerbosity(groupA, userA, 'detailed', fixture.now())
    assert.equal(fixture.personalization.resolvePreferences(groupA, userA).verbosity, 'detailed')
    assert.equal(fixture.personalization.resolvePreferences(groupA, userB).verbosity, 'normal')
    assert.equal(fixture.personalization.resolvePreferences(groupB, userA).verbosity, 'normal')
    assert.equal(fixture.personalization.getUserPreferences(groupB, userA), undefined)
  } finally {
    closeFixture(fixture)
  }
})

test('R5 export and delete only affect the requesting user scope', () => {
  const fixture = createFixture()
  try {
    fixture.personalization.setUserLanguage(groupA, userA, 'en', fixture.now())
    fixture.personalization.setUserFormat(groupA, userB, 'accessible', fixture.now())
    assert.equal(fixture.personalization.exportUserPreferences(groupA, userA)?.language, 'en')
    assert.equal(fixture.personalization.deleteUserPreferences(groupA, userA, fixture.now()), true)
    assert.equal(fixture.personalization.getUserPreferences(groupA, userA), undefined)
    assert.equal(fixture.personalization.getUserPreferences(groupA, userB)?.format, 'accessible')
    assert.equal(fixture.personalization.resolvePreferences(groupA, userA).language, 'id')
  } finally {
    closeFixture(fixture)
  }
})

test('R5 audit metadata does not expose raw actor or group JIDs', () => {
  const fixture = createFixture()
  try {
    fixture.personalization.setUserTimezone(groupA, userA, 'Asia/Jakarta', fixture.now())
    fixture.personalization.setGroupNotifications(groupA, adminJid, false, fixture.now())
    const auditText = JSON.stringify(fixture.guardrails.listAudit({ includeArchive: true, limit: 300 }))
    assert.equal(auditText.includes(groupA), false)
    assert.equal(auditText.includes(userA), false)
    assert.equal(auditText.includes(adminJid), false)
    assert.equal(auditText.includes('Asia/Jakarta'), false)
  } finally {
    closeFixture(fixture)
  }
})

test('R5 notification policy returns an explicit disabled decision', () => {
  const fixture = createFixture()
  try {
    fixture.personalization.setGroupNotifications(groupA, adminJid, false, fixture.now())
    const decision = fixture.personalization.evaluateGroupNotification(groupA, fixture.now())
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'policy-disabled')
  } finally {
    closeFixture(fixture)
  }
})

test('R5 reminder dispatcher defers during group quiet hours and resumes later', async () => {
  const fixture = createFixture()
  const collaboration = new CollaborationService(fixture.databasePath, logger, { clock: fixture.now })
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return fixture.guardrails
      if (name === 'personalization') return fixture.personalization
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'personalization' },
  }
  collaboration.initialize(serviceContext(services, fixture.databasePath))
  collaboration.setEnabled(groupA, true, adminJid, fixture.now())
  fixture.personalization.setGroupQuietHours(groupA, adminJid, { start: '00:00', end: '23:59' }, fixture.now())
  const sent = []
  const whatsapp = { async sendText(remoteJid, text) { sent.push({ remoteJid, text }) } }
  try {
    const reminder = collaboration.createReminder(groupA, userA, 'Standby', fixture.now() - 1, fixture.now() - 2)
    assert.equal(await collaboration.dispatchDueReminders(whatsapp, fixture.now()), 0)
    assert.equal(collaboration.getReminder(reminder.id, fixture.now()).status, 'scheduled')
    assert.match(JSON.stringify(fixture.guardrails.listAudit({ includeArchive: true, limit: 300 })), /quiet-hours/)
    fixture.personalization.setGroupQuietHours(groupA, adminJid, null, fixture.now())
    assert.equal(await collaboration.dispatchDueReminders(whatsapp, fixture.now()), 1)
    assert.equal(sent.length, 1)
    assert.equal(collaboration.getReminder(reminder.id, fixture.now()).status, 'sent')
  } finally {
    collaboration.shutdown(serviceContext(services, fixture.databasePath))
    closeFixture(fixture)
  }
})

class PersonalizationCore {
  isConnected = true
  currentStatus = 'connected'
  userJid = botJid
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: groupA,
    subject: 'R5 Test Group',
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

test('R5 plugin is default-off, admin-gated, text-only, and reports effective precedence', async () => {
  const databasePath = tempDatabase('allybot-r5-plugin-')
  const core = new PersonalizationCore()
  const guardrails = new PlatformGuardrailService(databasePath, logger)
  const personalization = new PersonalizationService(databasePath, logger)
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0, databasePath }, logger, core, { permissionResolver: createPermissionResolver(core) })
  app.registerService(guardrails)
  app.registerService(personalization)
  app.registerPlugin(createPersonalizationPlugin(core))
  await app.start()
  try {
    await core.emitMessage(groupMessage('off', userA, '!myprefs'))
    assert.match(core.sent.at(-1).text, /belum aktif/i)
    await core.emitMessage(groupMessage('forbidden', userA, '!setpersonalization on'))
    assert.match(core.sent.at(-1).text, /hanya dapat digunakan oleh admin/i)
    await core.emitMessage(groupMessage('enable', adminJid, '!setpersonalization on'))
    assert.match(core.sent.at(-1).text, /on/i)
    await core.emitMessage(groupMessage('language', userA, '!mylanguage en'))
    assert.match(core.sent.at(-1).text, /Preference pribadi diperbarui/i)
    await core.emitMessage(groupMessage('prefs', userA, '!myprefs'))
    assert.match(core.sent.at(-1).text, /Language: en \(user\)/i)
    assert.match(core.sent.at(-1).text, /Precedence/i)
    await core.emitMessage(groupMessage('bad-timezone', userA, '!mytimezone +07:00'))
    assert.match(core.sent.at(-1).text, /IANA/i)
  } finally {
    await app.stop()
    cleanupDatabase(databasePath)
  }
})

test('R5 rejects malformed quiet intervals and equal endpoints', () => {
  const fixture = createFixture()
  try {
    assert.throws(() => fixture.personalization.setUserQuietHours(groupA, userA, { start: '9:00', end: '17:00' }), /HH:mm/i)
    assert.throws(() => fixture.personalization.setUserQuietHours(groupA, userA, { start: '09:00', end: '09:00' }), /differ/i)
    assert.throws(() => fixture.personalization.setGroupQuietHours(groupA, adminJid, { start: '24:00', end: '01:00' }), /HH:mm/i)
  } finally {
    closeFixture(fixture)
  }
})
