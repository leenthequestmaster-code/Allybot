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

    gk.setGroupKind(officialGroupJid, 'rp')
    const list = gk.listOfficialGroups()
    assert.equal(list.length, 1)
    assert.equal(list[0].jid, officialGroupJid)
    assert.equal(list[0].name, 'Allyssea Roleplay')
    assert.equal(list[0].groupKind, 'rp')
    assert.equal(gk.getContextPolicy(officialGroupJid), 'moderator_only')

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

    // 7. Dot prefix & interactive buttonId commands also recognized cleanly
    const dotCmdResult = await gk.evaluateMessage(
      { id: '7', remoteJid: '628999999999@s.whatsapp.net', senderJid: '628999999999@s.whatsapp.net', buttonId: '.menu', timestamp: Date.now(), fromMe: false },
      mockWa
    )
    assert.equal(dotCmdResult.allowed, true)

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

test('Gatekeeper + ApplicationFramework E2E simulation: unofficial group deaf brick, participant guard, LID/PN OOC check & 12h DM trial', async () => {
  const { ApplicationFramework } = await import('../dist/framework/application.js')
  const { remoteOpsPlugin } = await import('../dist/framework/plugins/remote-ops.js')
  const Database = (await import('better-sqlite3')).default
  const dir = mkdtempSync(join(tmpdir(), 'gk-e2e-sim-'))
  const dbPath = join(dir, 'sim.sqlite')

  const OOC_GROUP = '120363405355522626@g.us'
  const RP_GROUP = '120363405381639593@g.us'
  const LIAR_GROUP = '999999999999999999@g.us'
  const MEMBER_PN = '628111111111@s.whatsapp.net'
  const MEMBER_LID = '777777777777@lid'
  const STRANGER_PN = '628222222222@s.whatsapp.net'
  const EXPIRED_PN = '628333333333@s.whatsapp.net'

  const sent = []
  const msgListeners = new Set()
  const partListeners = new Set()
  const connListeners = new Set()

  const simWa = {
    isConnected: true,
    userJid: '6285181696890@s.whatsapp.net',
    onMessage(cb) { msgListeners.add(cb); return () => msgListeners.delete(cb) },
    onGroupParticipantUpdate(cb) { partListeners.add(cb); return () => partListeners.delete(cb) },
    onConnectionState(cb) { connListeners.add(cb); return () => connListeners.delete(cb) },
    async start() {},
    async close() {},
    async sendText(remoteJid, text) { sent.push({ remoteJid, text }) },
    async getGroupMetadata(jid) {
      if (jid === OOC_GROUP) {
        return { jid, subject: 'The Horizon - OOC Room', participants: [{ jid: MEMBER_LID, role: 'member' }] }
      }
      if (jid === RP_GROUP) {
        return { jid, subject: 'Pillars Of Allyssea', participants: [{ jid: MEMBER_PN, role: 'member' }, { jid: STRANGER_PN, role: 'member' }] }
      }
      throw new Error('not-in-group')
    },
    async getGroupInviteLink() { throw new Error('not-admin') },
  }

  const framework = new ApplicationFramework({
    commandPrefix: '!',
    defaultCooldownMs: 0,
    botOwnerJid: ownerJid,
    databasePath: dbPath,
    officialOocGroupJid: OOC_GROUP,
    officialOocInviteLink: 'https://chat.whatsapp.com/J9TKYBfvTtt4zLRBOHHNVd',
  }, logger, simWa)

  const gk = new GatekeeperService(dbPath, logger, ownerJid, { whatsapp: simWa })
  framework.registerService(gk)
  framework.registerPlugin(remoteOpsPlugin)

  let pingRuns = 0
  let participantEventsSeen = 0
  framework.registerPlugin({
    name: 'sim-probe',
    load(ctx) {
      ctx.commands.register({
        name: 'ping',
        scope: 'both',
        handler: async (c) => { pingRuns++; await c.reply('pong') },
      })
      ctx.commands.register({
        name: 'suggest',
        scope: 'private',
        handler: async (c) => { await c.reply('suggest ok') },
      })
      ctx.commands.register({
        name: 'menfess',
        scope: 'private',
        handler: async (c) => { await c.reply('menfess ok') },
      })
      ctx.events.on('group.participants.changed', () => { participantEventsSeen++ })
    },
  })

  try {
    await framework.start()
    gk.setGateMode('strict')
    gk.registerGroup(OOC_GROUP, 'The Horizon - OOC Room', ownerJid)
    gk.registerGroup(RP_GROUP, 'Pillars Of Allyssea', ownerJid)
    gk.setOocGroup(OOC_GROUP)
    gk.setOocStaticLink('https://chat.whatsapp.com/J9TKYBfvTtt4zLRBOHHNVd')

    const rawDb = new Database(dbPath)
    rawDb.prepare('INSERT INTO identity_map (lid_jid, phone_jid, updated_at) VALUES (?, ?, unixepoch())').run(MEMBER_LID, MEMBER_PN)
    rawDb.prepare('INSERT INTO trial_guests (canonical_id, phone_jid, started_at, expires_at, command_count, last_seen_at) VALUES (?, ?, 100, 200, 3, 200)').run(EXPIRED_PN, EXPIRED_PN)
    rawDb.close()

    for (const cb of connListeners) await cb({ status: 'connected' })
    await new Promise((r) => setTimeout(r, 50))

    const emitMsg = async (m) => { for (const cb of msgListeners) await cb({ timestamp: Date.now(), fromMe: false, ...m }) }
    const emitPart = async (e) => { for (const cb of partListeners) await cb({ at: Date.now(), ...e }) }

    // 1. Grup luar non-Allyssea -> silent drop total
    sent.length = 0; pingRuns = 0
    await emitMsg({ id: 's1', remoteJid: LIAR_GROUP, senderJid: STRANGER_PN, text: '!ping' })
    await emitMsg({ id: 's1b', remoteJid: LIAR_GROUP, senderJid: MEMBER_PN, text: '!ping' })
    assert.equal(pingRuns, 0)
    assert.equal(sent.length, 0)

    // 2. Participant update di grup luar maupun grup silenced (Announcements) -> diblokir sebelum welcome/leave/antiraid
    const ANNOUNCE_GROUP = '120363421413903577@g.us'
    gk.registerGroup(ANNOUNCE_GROUP, 'Announcements', ownerJid)
    gk.silenceGroup(ANNOUNCE_GROUP, true)
    participantEventsSeen = 0
    await emitPart({ groupJid: LIAR_GROUP, action: 'add', participantJids: [STRANGER_PN] })
    await emitPart({ groupJid: ANNOUNCE_GROUP, action: 'add', participantJids: [STRANGER_PN] })
    assert.equal(participantEventsSeen, 0)

    // 3. Grup resmi selain OOC, user non-OOC -> ditolak dengan link OOC
    sent.length = 0; pingRuns = 0
    await emitMsg({ id: 's3', remoteJid: RP_GROUP, senderJid: STRANGER_PN, text: '!ping' })
    assert.equal(pingRuns, 0)
    assert.match(sent.at(-1)?.text ?? '', /J9TKYBfvTtt4zLRBOHHNVd/)

    // 4. Grup resmi selain OOC, member OOC terhubung via LID<->PN dinamis -> diizinkan
    sent.length = 0; pingRuns = 0
    await emitMsg({ id: 's4', remoteJid: RP_GROUP, senderJid: MEMBER_PN, text: '!ping' })
    assert.equal(pingRuns, 1)

    // 5. PC non-OOC chat biasa -> silent drop
    sent.length = 0
    await emitMsg({ id: 's5', remoteJid: STRANGER_PN, senderJid: STRANGER_PN, text: 'halo' })
    assert.equal(sent.length, 0)

    // 6. PC non-OOC command pertama -> 12h Guest Trial jalan
    sent.length = 0; pingRuns = 0
    await emitMsg({ id: 's6', remoteJid: STRANGER_PN, senderJid: STRANGER_PN, text: '!ping' })
    assert.equal(pingRuns, 1)

    // 7. PC non-OOC !suggest diblokir, !menfess diizinkan, trial expired diblokir
    sent.length = 0
    await emitMsg({ id: 's7a', remoteJid: STRANGER_PN, senderJid: STRANGER_PN, text: '!suggest fitur' })
    assert.match(sent.at(-1)?.text ?? '', /J9TKYBfvTtt4zLRBOHHNVd/)

    sent.length = 0
    await emitMsg({ id: 's7b', remoteJid: STRANGER_PN, senderJid: STRANGER_PN, text: '!menfess halo' })
    assert.equal(sent.at(-1)?.text, 'menfess ok')

    sent.length = 0; pingRuns = 0
    await emitMsg({ id: 's7c', remoteJid: EXPIRED_PN, senderJid: EXPIRED_PN, text: '!ping' })
    assert.equal(pingRuns, 0)
    assert.match(sent.at(-1)?.text ?? '', /J9TKYBfvTtt4zLRBOHHNVd/)

    // 8. Owner di grup luar tetap bypass
    sent.length = 0; pingRuns = 0
    await emitMsg({ id: 's8', remoteJid: LIAR_GROUP, senderJid: ownerJid, text: '!ping' })
    assert.equal(pingRuns, 1)
  } finally {
    await framework.stop().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Allybot Group_Context policies: RP moderator_only vs OOC ooc_limited vs Bot Room full vs Announcement silent', async () => {
  const { ApplicationFramework } = await import('../dist/framework/application.js')
  const dir = mkdtempSync(join(tmpdir(), 'allybot-ctx-policy-'))
  const dbPath = join(dir, 'ctx.sqlite')
  const OOC_GROUP = '120363990000000010@g.us'
  const RP_GROUP = '120363990000000011@g.us'
  const BOT_GROUP = '120363990000000012@g.us'
  const ANN_GROUP = '120363990000000013@g.us'
  const OWNER = '6283197859955@s.whatsapp.net'
  const MEMBER = '6281111222333@s.whatsapp.net'

  const sent = []
  let warnRuns = 0
  let pinRuns = 0
  let aiRuns = 0
  const msgListeners = new Set()

  const mockWa = {
    isConnected: true,
    userJid: '6289999999999@s.whatsapp.net',
    onMessage(cb) { msgListeners.add(cb); return () => msgListeners.delete(cb) },
    onGroupParticipantUpdate() { return () => {} },
    onConnectionState() { return () => {} },
    async start() {},
    async close() {},
    async sendText(remoteJid, text) { sent.push({ remoteJid, text }) },
    async getGroupMetadata(jid) {
      return { jid, subject: 'Group', participants: [{ jid: MEMBER, role: 'member' }] }
    },
    async getGroupInviteLink() { return 'https://chat.whatsapp.com/J9TKYBfvTtt4zLRBOHHNVd' },
  }

  const framework = new ApplicationFramework({
    commandPrefix: '!',
    defaultCooldownMs: 0,
    botOwnerJid: OWNER,
    databasePath: dbPath,
    officialOocGroupJid: OOC_GROUP,
    officialOocInviteLink: 'https://chat.whatsapp.com/J9TKYBfvTtt4zLRBOHHNVd',
    officialGroupJids: [OOC_GROUP, RP_GROUP, BOT_GROUP, ANN_GROUP],
  }, logger, mockWa)

  const gk = new GatekeeperService(dbPath, logger, OWNER, { whatsapp: mockWa })
  framework.registerService(gk)
  framework.registerPlugin({
    name: 'ctx-test-commands',
    version: '1.0.0',
    load(ctx) {
      ctx.messageGates.register('gatekeeper-guard', async (msg) => {
        const res = await gk.evaluateMessage(msg, mockWa)
        if (!res.allowed) {
          if (res.replyText) await mockWa.sendText(msg.remoteJid, res.replyText)
          return { allowed: false, reason: res.reason }
        }
        return { allowed: true }
      })
      ctx.commands.register({
        name: 'warn', category: 'moderation', description: 'Warn user',
        handler: async (c) => { warnRuns += 1; await c.reply('warned') },
      })
      ctx.commands.register({
        name: 'pin', category: 'tools', description: 'Search pin',
        handler: async (c) => { pinRuns += 1; await c.reply('pin ok') },
      })
      ctx.commands.register({
        name: 'ai', category: 'tools', description: 'Ask Chlona',
        handler: async (c) => { aiRuns += 1; await c.reply('ai ok') },
      })
    },
  })

  await framework.start()
  try {
    gk.setGateMode('strict')
    gk.registerGroup(OOC_GROUP, 'OOC Talk', OWNER, 'ooc')
    gk.setOocGroup(OOC_GROUP)
    gk.registerGroup(RP_GROUP, '◈ Landmark RP', OWNER, 'rp')
    gk.registerGroup(BOT_GROUP, 'Voice & Bot Room', OWNER, 'bot_room')
    gk.registerGroup(ANN_GROUP, 'Announcements', OWNER, 'announcement')
    gk.setGroupSilenced(ANN_GROUP, true)
    await gk.syncGroupMembers(mockWa)

    const dispatch = async (remoteJid, text) => {
      const msg = { id: `id-${Math.random()}`, remoteJid, senderJid: MEMBER, text, timestamp: Date.now(), fromMe: false }
      for (const cb of msgListeners) await cb(msg)
    }

    // 1. RP Group (moderator_only): !pin, !ai & typo are silently dropped; !warn works
    await dispatch(RP_GROUP, '!pin anime')
    await dispatch(RP_GROUP, '!ai halo')
    await dispatch(RP_GROUP, '!wran') // typo must be silent
    assert.equal(pinRuns, 0)
    assert.equal(aiRuns, 0)
    assert.equal(sent.length, 0)

    await dispatch(RP_GROUP, '!warn @user')
    assert.equal(warnRuns, 1)

    // 2. OOC Group (ooc_limited): !ai & !warn work; !pin blocked with Voice & Bot Room notice
    sent.length = 0
    await dispatch(OOC_GROUP, '!ai halo')
    assert.equal(aiRuns, 1)
    await dispatch(OOC_GROUP, '!pin anime')
    assert.equal(pinRuns, 0)
    assert.match(sent.at(-1)?.text ?? '', /Voice & Bot Room/)

    // 3. Bot Room (full): !pin works freely
    sent.length = 0
    await dispatch(BOT_GROUP, '!pin anime')
    assert.equal(pinRuns, 1)

    // 4. Announcement (silent): !warn also dropped silently
    sent.length = 0
    await dispatch(ANN_GROUP, '!warn @user')
    assert.equal(warnRuns, 1)
    assert.equal(sent.length, 0)
  } finally {
    await framework.stop().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})
