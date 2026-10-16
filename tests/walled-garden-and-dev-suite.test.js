import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { GatekeeperService } from '../dist/services/gatekeeper-service.js'
import { DeveloperModeService } from '../dist/services/developer-mode-service.js'
import { RemoteOpsService } from '../dist/services/remote-ops-service.js'

const logger = pino({ level: 'silent' })
const ownerJid = '6283197859955@s.whatsapp.net'
const officialGroupJid = '120363001@g.us'
const unofficialGroupJid = '120363999@g.us'
const memberUserJid = '628111111111@s.whatsapp.net'
const strangerUserJid = '628222222222@s.whatsapp.net'

class MockWhatsApp {
  sent = []
  async sendText(remoteJid, text) {
    this.sent.push({ remoteJid, text })
  }
}

test('GatekeeperService: gate modes, official groups, and shadowban', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-test-'))
  const dbPath = join(dir, 'test.sqlite')

  try {
    const gk = new GatekeeperService(dbPath, logger, ownerJid)
    gk.initialize({ logger })

    // Default gate mode
    assert.equal(gk.getGateMode(), 'strict')
    gk.setGateMode('permissive')
    assert.equal(gk.getGateMode(), 'permissive')
    gk.setGateMode('strict_walled_garden')
    assert.equal(gk.getGateMode(), 'strict_walled_garden')

    // Official groups
    assert.equal(gk.isGroupOfficial(officialGroupJid), false)
    gk.registerGroup(officialGroupJid, 'Allyssea Roleplay', ownerJid)
    assert.equal(gk.isGroupOfficial(officialGroupJid), true)

    const list = gk.listOfficialGroups()
    assert.equal(list.length, 1)
    assert.equal(list[0].jid, officialGroupJid)
    assert.equal(list[0].name, 'Allyssea Roleplay')

    // Silence group
    assert.equal(gk.isGroupSilenced(officialGroupJid), false)
    gk.silenceGroup(officialGroupJid, true)
    assert.equal(gk.isGroupSilenced(officialGroupJid), true)
    gk.silenceGroup(officialGroupJid, false)
    assert.equal(gk.isGroupSilenced(officialGroupJid), false)

    // Shadowban
    assert.equal(gk.isShadowbanned(strangerUserJid), false)
    gk.addShadowban(strangerUserJid, 'spam', ownerJid)
    assert.equal(gk.isShadowbanned(strangerUserJid), true)
    gk.removeShadowban(strangerUserJid)
    assert.equal(gk.isShadowbanned(strangerUserJid), false)

    gk.shutdown({ logger })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('GatekeeperService: Walled-Garden access evaluation and 12h Guest Trial', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gk-eval-test-'))
  const dbPath = join(dir, 'test.sqlite')
  const mockWa = new MockWhatsApp()

  try {
    const gk = new GatekeeperService(dbPath, logger, ownerJid)
    gk.initialize({ logger })
    gk.registerGroup(officialGroupJid, 'Official Hub', ownerJid)
    gk.setOocStaticLink('https://chat.whatsapp.com/test-ooc-link')
    gk.setGateMode('strict_walled_garden')

    // Add member
    gk.addOfficialMembers([memberUserJid])

    // 1. Unofficial group message -> rejected
    const unoffResult = await gk.evaluateMessage(
      { id: '1', remoteJid: unofficialGroupJid, senderJid: strangerUserJid, text: '!help', timestamp: Date.now(), fromMe: false },
      mockWa
    )
    assert.equal(unoffResult.allowed, false)
    assert.equal(unoffResult.reason, 'unauthorized_group')

    // 2. Official group message -> allowed
    const offResult = await gk.evaluateMessage(
      { id: '2', remoteJid: officialGroupJid, senderJid: strangerUserJid, text: '!help', timestamp: Date.now(), fromMe: false },
      mockWa
    )
    assert.equal(offResult.allowed, true)

    // 3. Private DM from official member -> allowed
    const memberDmResult = await gk.evaluateMessage(
      { id: '3', remoteJid: memberUserJid, senderJid: memberUserJid, text: '!help', timestamp: Date.now(), fromMe: false },
      mockWa
    )
    assert.equal(memberDmResult.allowed, true)

    // 4. Private DM from non-member: !menfess always allowed
    const menfessResult = await gk.evaluateMessage(
      { id: '4', remoteJid: strangerUserJid, senderJid: strangerUserJid, text: '!menfess halo', timestamp: Date.now(), fromMe: false },
      mockWa
    )
    assert.equal(menfessResult.allowed, true)

    // 5. Private DM from non-member: !suggest and !report blocked
    const suggestResult = await gk.evaluateMessage(
      { id: '5', remoteJid: strangerUserJid, senderJid: strangerUserJid, text: '!suggest fitur baru', timestamp: Date.now(), fromMe: false },
      mockWa
    )
    assert.equal(suggestResult.allowed, false)
    assert.equal(suggestResult.reason, 'member_only_cmd')

    // 6. Private DM from non-member: first command initiates 12h guest trial -> allowed
    const firstCmdResult = await gk.evaluateMessage(
      { id: '6', remoteJid: strangerUserJid, senderJid: strangerUserJid, text: '!status', timestamp: Date.now(), fromMe: false },
      mockWa
    )
    assert.equal(firstCmdResult.allowed, true)

    gk.shutdown({ logger })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RemoteOpsService: inspect wiretap, sniff_once, and peek', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ro-test-'))
  const dbPath = join(dir, 'test.sqlite')
  const mockWa = new MockWhatsApp()

  try {
    const remoteOps = new RemoteOpsService(dbPath, logger, ownerJid, mockWa)
    remoteOps.initialize({ logger })

    // Start inspect
    const session = remoteOps.startInspect(officialGroupJid, 'Official Hub', 'all', ownerJid, 600)
    assert.equal(session.groupJid, officialGroupJid)
    assert.equal(remoteOps.listActiveInspectSessions().length, 1)

    // Stop inspect
    assert.equal(remoteOps.stopInspect(officialGroupJid), true)
    assert.equal(remoteOps.listActiveInspectSessions().length, 0)

    // Sniff once toggle
    assert.equal(remoteOps.isSniffOnceActive(officialGroupJid), false)
    remoteOps.toggleSniffOnce(officialGroupJid, true)
    assert.equal(remoteOps.isSniffOnceActive(officialGroupJid), true)

    // Incoming message during sniff once
    await remoteOps.handleIncomingMessage(
      { id: 'msg-1', remoteJid: officialGroupJid, senderJid: strangerUserJid, text: 'Halo kawan', timestamp: Date.now(), fromMe: false },
      mockWa
    )
    // Sniff once automatically deactivates after 1 message
    assert.equal(remoteOps.isSniffOnceActive(officialGroupJid), false)

    // Peek group messages
    const peek = remoteOps.peekGroupMessages(officialGroupJid, 5)
    assert.ok(Array.isArray(peek))

    remoteOps.shutdown({ logger })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DeveloperModeService: storage matrix, log redaction, and V8 memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-mode-test-'))
  const dbPath = join(dir, 'test.sqlite')

  try {
    const devService = new DeveloperModeService(dbPath, logger)
    devService.initialize({ logger })

    // Storage matrix (SQLite live, Postgres/Redis undefined for unit test)
    const matrix = await devService.inspectStorageMatrix()
    assert.equal(matrix.sqlite.quickCheck, 'ok')
    assert.equal(matrix.sqlite.path, dbPath)
    assert.ok(matrix.sqlite.latencyMs >= 0)

    // Log redaction via static method
    const rawLog = 'User 6283197859955 sent token Bearer eyJhbGciOiJIUzI1NiJ9.test.sign with key sk-1234567890abcdef1234'
    const redacted = DeveloperModeService.redact(rawLog)
    assert.ok(!redacted.includes('6283197859955'))
    assert.ok(!redacted.includes('sk-1234567890abcdef1234'))
    assert.ok(redacted.includes('[REDACTED_PHONE]'))
    assert.ok(redacted.includes('[REDACTED_API_KEY]'))

    // V8 memory
    const mem = devService.collectMemoryAndOptionalGc(false)
    assert.ok(mem.rssMb > 0)
    assert.ok(mem.heapUsedMb > 0)

    devService.shutdown({ logger })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
