import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createEventPlugin } from '../dist/framework/plugins/event.js'
import { EventService } from '../dist/services/event-service.js'
import { CollaborationService } from '../dist/services/collaboration-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const groupA = '120363100000000000@g.us'
const groupB = '120363100000000001@g.us'
const adminJid = '628130000001@s.whatsapp.net'
const creatorJid = adminJid
const userA = '628130000002@s.whatsapp.net'
const userB = '628130000003@s.whatsapp.net'
const botJid = '628130000009@s.whatsapp.net'
const initialNow = Date.UTC(2025, 0, 1, 12, 0, 0)

function tempDatabase(prefix = 'allybot-r9-') {
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

class EventCore {
  isConnected = true
  currentStatus = 'connected'
  userJid = botJid
  sent = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  metadata = {
    jid: groupA,
    subject: 'R9 Event Test Group',
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

function createFixture({ withCollaboration = false } = {}) {
  const databasePath = tempDatabase()
  let now = initialNow
  const guardrails = new PlatformGuardrailService(databasePath, logger, { clock: () => now, maxHotAuditRecords: 500 })
  const collaboration = withCollaboration ? new CollaborationService(databasePath, logger, { clock: () => now }) : undefined
  const events = new EventService(databasePath, logger, { clock: () => now, dispatcherIntervalMs: 1_000 })
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'collaboration' && collaboration) return collaboration
      if (name === 'event') return events
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'event' || (name === 'collaboration' && Boolean(collaboration)) },
  }
  guardrails.initialize(serviceContext(services, databasePath))
  if (collaboration) collaboration.initialize(serviceContext(services, databasePath))
  events.initialize(serviceContext(services, databasePath))
  events.setEnabled(groupA, true, adminJid, now)
  if (collaboration) collaboration.setEnabled(groupA, true, adminJid, now)
  const whatsapp = new EventCore()
  return { databasePath, guardrails, collaboration, events, whatsapp, now: () => now, advance(ms) { now += ms }, services }
}

async function closeFixture(fixture) {
  await fixture.events.shutdown(serviceContext(fixture.services, fixture.databasePath))
  if (fixture.collaboration) fixture.collaboration.shutdown(serviceContext(fixture.services, fixture.databasePath))
  fixture.guardrails.shutdown(serviceContext(fixture.services, fixture.databasePath))
  cleanupDatabase(fixture.databasePath)
}

function createDraft(fixture, groupJid = groupA) {
  const startAt = fixture.now() + 1_000
  return fixture.events.createEvent(
    groupJid,
    creatorJid,
    'Community Event',
    'Bounded event description',
    'Asia/Jakarta',
    startAt,
    startAt + 10_000,
    [
      { order: 1, title: 'Opening', description: 'Opening phase', startAt, endAt: startAt + 4_000 },
      { order: 2, title: 'Workshop', description: 'Workshop phase', startAt: startAt + 4_001, endAt: startAt + 8_000 },
    ],
    fixture.now(),
  )
}

test('R9 default-off blocks persistence mutations and isolates groups', async () => {
  const fixture = createFixture()
  try {
    assert.equal(fixture.events.isEnabled(groupB), false)
    assert.throws(() => createDraft(fixture, groupB), /disabled/i)
    assert.equal(fixture.events.listEvents(groupB).length, 0)
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 listEvents prefetches complete bounded records without crossing group scope', async () => {
  const fixture = createFixture()
  try {
    const first = createDraft(fixture)
    const second = createDraft(fixture)
    fixture.events.publishEvent(groupA, first.id, creatorJid, fixture.now())
    fixture.events.joinEvent(groupA, first.id, userA, fixture.now())
    fixture.events.setEnabled(groupB, true, adminJid, fixture.now())
    const otherGroupEvent = createDraft(fixture, groupB)
    const listed = fixture.events.listEvents(groupA, 25, fixture.now())

    assert.equal(listed.length, 2)
    assert.deepEqual(new Set(listed.map((event) => event.id)), new Set([first.id, second.id]))
    assert.equal(listed.every((event) => event.groupJid === groupA), true)
    assert.equal(listed.find((event) => event.id === first.id)?.phases.length, 2)
    assert.equal(listed.find((event) => event.id === first.id)?.participantCount, 1)
    assert.equal(fixture.events.listEvents(groupB, 25, fixture.now()).some((event) => event.id === otherGroupEvent.id), true)
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 lifecycle uses creator authorization and CAS state transitions', async () => {
  const fixture = createFixture()
  try {
    const draft = createDraft(fixture)
    assert.equal(draft.status, 'draft')
    assert.equal(fixture.events.publishEvent(groupA, draft.id, creatorJid).status, 'published')
    assert.throws(() => fixture.events.publishEvent(groupA, draft.id, userA), /creator/i)
    assert.equal(fixture.events.pauseEvent(groupA, draft.id, creatorJid).status, 'paused')
    assert.equal(fixture.events.resumeEvent(groupA, draft.id, creatorJid).status, 'active')
    assert.equal(fixture.events.closeEvent(groupA, draft.id, creatorJid).status, 'closed')
    assert.throws(() => fixture.events.resumeEvent(groupA, draft.id, creatorJid), /Invalid event transition/i)
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 phases transition automatically with bounded scheduler and persisted operation ledger', async () => {
  const fixture = createFixture()
  try {
    const draft = createDraft(fixture)
    fixture.events.publishEvent(groupA, draft.id, creatorJid, fixture.now())
    fixture.advance(1_001)
    assert.equal(await fixture.events.dispatchDueEvents(fixture.whatsapp, fixture.now()), 2)
    const active = fixture.events.getEvent(groupA, draft.id)
    assert.equal(active.status, 'active')
    assert.equal(active.phases[0].status, 'active')
    fixture.advance(4_000)
    assert.equal(await fixture.events.dispatchDueEvents(fixture.whatsapp, fixture.now()), 2)
    assert.equal(fixture.events.getEvent(groupA, draft.id).phases[0].status, 'completed')
    assert.equal(fixture.events.getEvent(groupA, draft.id).phases[1].status, 'active')
    assert.equal(fixture.whatsapp.sent.length >= 2, true)
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 manual phase transition changes only the selected event group', async () => {
  const fixture = createFixture()
  try {
    const eventA = createDraft(fixture, groupA)
    fixture.events.setEnabled(groupB, true, adminJid, fixture.now())
    const eventB = createDraft(fixture, groupB)
    fixture.events.publishEvent(groupA, eventA.id, creatorJid)
    fixture.events.publishEvent(groupB, eventB.id, creatorJid)
    assert.equal(fixture.events.setPhase(groupA, eventA.id, creatorJid, 2).phases[1].status, 'active')
    assert.equal(fixture.events.getEvent(groupB, eventB.id).phases[0].status, 'scheduled')
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 participant join leave is explicit, idempotent, bounded, and group-scoped', async () => {
  const fixture = createFixture()
  try {
    const event = createDraft(fixture)
    fixture.events.publishEvent(groupA, event.id, creatorJid)
    assert.equal(fixture.events.joinEvent(groupA, event.id, userA), true)
    assert.equal(fixture.events.joinEvent(groupA, event.id, userA), false)
    assert.equal(fixture.events.leaveEvent(groupA, event.id, userA), true)
    assert.equal(fixture.events.leaveEvent(groupA, event.id, userA), false)
    fixture.events.setEnabled(groupB, true, adminJid, fixture.now())
    assert.throws(() => fixture.events.joinEvent(groupB, event.id, userB), /not found/i)
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 participant listing returns bounded references rather than raw JIDs', async () => {
  const fixture = createFixture()
  try {
    const event = createDraft(fixture)
    fixture.events.publishEvent(groupA, event.id, creatorJid)
    fixture.events.joinEvent(groupA, event.id, userA)
    const participants = fixture.events.getParticipants(groupA, event.id, 1)
    assert.equal(participants.length, 1)
    assert.equal(participants[0].participantRef.includes('@'), false)
    assert.equal(JSON.stringify(participants).includes(userA), false)
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 event-linked poll delegates to CollaborationService and persists link', async () => {
  const fixture = createFixture({ withCollaboration: true })
  try {
    const event = createDraft(fixture)
    const linked = fixture.events.linkPoll(groupA, event.id, creatorJid, 'Choose a slot', ['Morning', 'Evening'])
    assert.match(linked.pollId, /^[0-9a-f-]{8}/i)
    assert.equal(fixture.events.getEvent(groupA, event.id).pollId, linked.pollId)
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 poll linkage fails closed when Collaboration is unavailable', async () => {
  const fixture = createFixture()
  try {
    const event = createDraft(fixture)
    assert.throws(() => fixture.events.linkPoll(groupA, event.id, creatorJid, 'Choose', ['A', 'B']), /Collaboration poll is unavailable/i)
    assert.equal(fixture.events.getEvent(groupA, event.id).pollId, undefined)
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 restart recovery preserves lifecycle, phases, participants, and operation ledger', async () => {
  const fixture = createFixture()
  try {
    const event = createDraft(fixture)
    fixture.events.publishEvent(groupA, event.id, creatorJid)
    fixture.events.joinEvent(groupA, event.id, userA)
    fixture.events.shutdown(serviceContext(fixture.services, fixture.databasePath))
    fixture.events.initialize(serviceContext(fixture.services, fixture.databasePath))
    assert.equal(fixture.events.getEvent(groupA, event.id).status, 'published')
    assert.equal(fixture.events.getEvent(groupA, event.id).participantCount, 1)
    fixture.advance(1_001)
    assert.equal(await fixture.events.dispatchDueEvents(fixture.whatsapp, fixture.now()), 2)
    assert.equal(fixture.events.getEvent(groupA, event.id).status, 'active')
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 audit redaction excludes raw JID, title, description, location, and event ID', async () => {
  const fixture = createFixture()
  try {
    const event = fixture.events.createEvent(groupA, creatorJid, 'private event title', 'private event description', 'UTC', fixture.now() + 1_000, undefined, [{ order: 1, title: 'private phase', startAt: fixture.now() + 1_000 }])
    fixture.events.setLocation(groupA, event.id, creatorJid, 'private location', 1, 2)
    fixture.events.publishEvent(groupA, event.id, creatorJid)
    const auditText = JSON.stringify(fixture.guardrails.listAudit({ includeArchive: true, limit: 500 }))
    assert.equal(auditText.includes(groupA), false)
    assert.equal(auditText.includes(creatorJid), false)
    assert.equal(auditText.includes('private event title'), false)
    assert.equal(auditText.includes('private event description'), false)
    assert.equal(auditText.includes('private location'), false)
    assert.equal(auditText.includes(event.id), false)
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 timezone, timestamp, phase ordering, and location validation fail closed', async () => {
  const fixture = createFixture()
  try {
    assert.throws(() => fixture.events.createEvent(groupA, creatorJid, 'title', 'description', 'Not/AZone', fixture.now() + 1_000, undefined, [{ order: 1, title: 'phase', startAt: fixture.now() + 1_000 }]), /Timezone/i)
    assert.throws(() => fixture.events.createEvent(groupA, creatorJid, 'title', 'description', 'UTC', fixture.now() + 1_000, undefined, [{ order: 2, title: 'phase', startAt: fixture.now() + 1_000 }]), /contiguous/i)
    const event = createDraft(fixture)
    assert.throws(() => fixture.events.setLocation(groupA, event.id, creatorJid, 'location', 100, 2), /latitude/i)
  } finally {
    await closeFixture(fixture)
  }
})

test('R9 plugin is default-off, admin-gated, group-only, and text fallback based', async () => {
  const databasePath = tempDatabase('allybot-r9-plugin-')
  const core = new EventCore()
  const guardrails = new PlatformGuardrailService(databasePath, logger)
  const events = new EventService(databasePath, logger)
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'event') return events
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'event' },
  }
  const app = new ApplicationFramework({ commandPrefix: '!', defaultCooldownMs: 0, databasePath }, logger, core)
  app.registerService(guardrails)
  app.registerService(events)
  app.registerPlugin(createEventPlugin(core))
  await app.start()
  try {
    await core.emitMessage({ id: 'off', remoteJid: groupA, senderJid: adminJid, text: '!event status', timestamp: initialNow, fromMe: false })
    assert.match(core.sent.at(-1).text, /belum aktif/i)
    await core.emitMessage({ id: 'private', remoteJid: userA, senderJid: userA, text: '!event', timestamp: initialNow, fromMe: false })
    assert.match(core.sent.at(-1).text, /grup/i)
    await core.emitMessage({ id: 'deny', remoteJid: groupA, senderJid: userA, text: '!event enable', timestamp: initialNow, fromMe: false })
    assert.match(core.sent.at(-1).text, /admin/i)
    await core.emitMessage({ id: 'enable', remoteJid: groupA, senderJid: adminJid, text: '!event enable', timestamp: initialNow, fromMe: false })
    assert.match(core.sent.at(-1).text, /on/i)
    await core.emitMessage({ id: 'help', remoteJid: groupA, senderJid: adminJid, text: '!event unknown', timestamp: initialNow, fromMe: false })
    assert.match(core.sent.at(-1).text, /Format/i)
    assert.match(core.sent.at(-1).text, /Contact-card/i)
  } finally {
    await app.stop()
    cleanupDatabase(databasePath)
  }
})
