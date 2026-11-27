import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import pino from 'pino'
import { ApplicationFramework } from '../dist/framework/application.js'
import { createPermissionResolver } from '../dist/permissions.js'
import { createGroupSafetyPlugin } from '../dist/framework/plugins/group-safety.js'
import { createSuggestPlugin } from '../dist/framework/plugins/suggest.js'
import { GroupSafetyService } from '../dist/services/group-safety-service.js'
import { GroupModerationSuiteService } from '../dist/services/group-moderation-suite-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'
import { SuggestionService } from '../dist/services/suggestion-service.js'

const logger = pino({ level: 'silent' })

class MockPasal34Core {
  isConnected = true
  currentStatus = 'connected'
  userJid = '6285181696890@s.whatsapp.net'
  userLid = '888777666@lid'
  sent = []
  participantActions = []
  messages = new Set()
  participants = new Set()
  connections = new Set()
  nextAddResults = [{ participantJid: '628111000333@s.whatsapp.net', status: 'ok' }]
  throwOnAdd = false
  inviteLink = 'https://chat.whatsapp.com/TestInviteLink123'

  constructor(groupJid, ownerJid, adminJid, memberJid) {
    this.metadata = {
      jid: groupJid,
      subject: 'Forsaken Land - OOC Talk',
      ownerJid,
      participants: [
        { jid: this.userJid, role: 'admin' },
        { jid: ownerJid, role: 'superadmin' },
        { jid: adminJid, role: 'admin' },
        { jid: memberJid, role: 'member' },
      ],
    }
  }

  onMessage(listener) { this.messages.add(listener); return () => this.messages.delete(listener) }
  onGroupParticipantUpdate(listener) { this.participants.add(listener); return () => this.participants.delete(listener) }
  onConnectionState(listener) { this.connections.add(listener); return () => this.connections.delete(listener) }
  async sendText(remoteJid, text, options) { this.sent.push({ remoteJid, text, options }) }
  async getGroupMetadata() { return this.metadata }
  async getGroupInviteLink() { return this.inviteLink }
  async groupParticipantsUpdate(groupJid, jids, action) {
    this.participantActions.push({ groupJid, jids, action })
    if (action === 'add' && this.throwOnAdd) throw new Error('WA_403_PRIVACY')
    if (action === 'add') return this.nextAddResults
    return jids.map((jid) => ({ participantJid: jid, status: 'ok' }))
  }
  async start() {}
  async close() {}
  async emitMessage(message) { await Promise.all([...this.messages].map((listener) => listener(message))) }
}

test('Pasal 34 Scheduler enforces SP 1 (7d auto re-add), SP 2 (DM invite fallback on 403), SP 3 escalation (NO kick), immunity, & admin cancel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pasal34-sp-'))
  const dbPath = join(dir, 'allybot.sqlite')
  const groupJid = '120363421406209536@g.us'
  const reportBoxJid = '120363433777737475@g.us'
  const ownerJid = '6283197859955@s.whatsapp.net'
  const adminJid = '628111000111@s.whatsapp.net'
  const memberJid = '628111000333@s.whatsapp.net'

  let now = 1_795_700_000_000
  const clock = () => now
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1_000

  try {
    const core = new MockPasal34Core(groupJid, ownerJid, adminJid, memberJid)
    const guardrails = new PlatformGuardrailService(dbPath, logger, { clock })
    const suite = new GroupModerationSuiteService(dbPath, logger)
    const suggest = new SuggestionService(dbPath, logger)
    const safety = new GroupSafetyService(dbPath, logger, {
      clock,
      spBanDurationMs: SEVEN_DAYS,
      pollIntervalMs: 0,
      whatsapp: core,
      botOwnerJid: ownerJid,
    })

    const app = new ApplicationFramework(
      { commandPrefix: '!', defaultCooldownMs: 0, databasePath: dbPath, botOwnerJid: ownerJid },
      logger,
      core,
      { permissionResolver: createPermissionResolver(core, ownerJid) },
    )
    app.registerService(guardrails)
    app.registerService(suite)
    app.registerService(suggest)
    app.registerService(safety)
    app.registerPlugin(createGroupSafetyPlugin(core))
    app.registerPlugin(createSuggestPlugin(core))
    await app.start()

    suggest.setBoxGroup('report', 'primary', reportBoxJid)
    suite.ensureGroupDefaults(groupJid, { antilink: true, antispam: true, antitoxic: true, warnLimit: 5 })
    assert.equal(suite.getWarnLimit(groupJid), 5)

    // Immunity check: even if admin somehow had 5 warnings, enforceWarnThreshold refuses to kick
    for (let i = 1; i <= 5; i++) {
      safety.issueWarning(groupJid, adminJid, ownerJid, `test-immune-${i}`, now)
    }
    const immuneRes = await safety.enforceWarnThreshold({
      groupJid,
      targetJid: adminJid,
      actorJid: ownerJid,
      reason: 'test',
      limit: 5,
      now,
      whatsapp: core,
    })
    assert.equal(immuneRes.action, 'immune_skip')
    assert.equal(core.participantActions.length, 0)

    // Cycle 1: Member gets 5 warnings -> SP 1 kick + 7-day persistent schedule
    for (let i = 1; i <= 5; i++) {
      safety.issueWarning(groupJid, memberJid, adminJid, `pelanggaran-${i}`, now)
    }
    const sp1 = await safety.enforceWarnThreshold({
      groupJid,
      targetJid: memberJid,
      actorJid: adminJid,
      reason: '5 warn OOC',
      limit: 5,
      now,
      whatsapp: core,
      announceInGroup: true,
    })
    assert.equal(sp1.action, 'kicked_sp')
    assert.equal(sp1.spLevel, 1)
    assert.equal(sp1.reentryAt, now + SEVEN_DAYS)
    assert.equal(core.participantActions.at(-1).action, 'remove')
    assert.equal(safety.getSpState(groupJid, memberJid).spLevel, 1)

    // Simulate restart before 7 days: should NOT re-add yet
    now += 3 * 24 * 60 * 60 * 1_000
    assert.equal(await safety.recoverSpReentries(core), 0)

    // Advance past 7 days: boot recovery / sweep auto-adds member & resets warnings to 0
    now += 4 * 24 * 60 * 60 * 1_000 + 5_000
    assert.equal(await safety.recoverSpReentries(core), 1)
    assert.equal(core.participantActions.at(-1).action, 'add')
    assert.equal(safety.countActiveWarnings(groupJid, memberJid, now), 0)
    assert.equal(safety.getActiveSpSchedule(groupJid, memberJid), undefined)

    // Cycle 2: Member gets 5 warnings again -> SP 2 kick, then WA 403 privacy triggers DM invite fallback
    for (let i = 1; i <= 5; i++) {
      safety.issueWarning(groupJid, memberJid, adminJid, `sp2-${i}`, now)
    }
    const sp2 = await safety.enforceWarnThreshold({
      groupJid,
      targetJid: memberJid,
      actorJid: adminJid,
      reason: '5 warn lagi',
      limit: 5,
      now,
      whatsapp: core,
      announceInGroup: true,
    })
    assert.equal(sp2.action, 'kicked_sp')
    assert.equal(sp2.spLevel, 2)

    now += SEVEN_DAYS + 1_000
    core.nextAddResults = [{ participantJid: memberJid, status: '403' }]
    assert.equal(await safety.recoverSpReentries(core), 1)
    const dmInvite = core.sent.find((m) => m.remoteJid === memberJid && m.text.includes('TestInviteLink123'))
    assert.ok(dmInvite)

    // Cycle 3: At SP 2, reaching 5 warnings enters SP 3 -> OUTSIDE bot authority (NO kick, mute 30m, escalate to Report Box)
    const kicksBeforeSp3 = core.participantActions.filter((a) => a.action === 'remove').length
    for (let i = 1; i <= 5; i++) {
      safety.issueWarning(groupJid, memberJid, adminJid, `sp3-${i}`, now)
    }
    const sp3 = await safety.enforceWarnThreshold({
      groupJid,
      targetJid: memberJid,
      actorJid: adminJid,
      reason: 'pelanggaran berulang sp3',
      limit: 5,
      now,
      whatsapp: core,
      announceInGroup: true,
    })
    assert.equal(sp3.action, 'escalated_sp3')
    assert.equal(sp3.spLevel, 3)
    assert.equal(core.participantActions.filter((a) => a.action === 'remove').length, kicksBeforeSp3)
    assert.equal(suite.isMuted(groupJid, memberJid), true)
    assert.ok(core.sent.some((m) => m.remoteJid === reportBoxJid && m.text.includes('SP 3')))

    // Admin commands: !spstatus & !cancelsp @member reset
    await core.emitMessage({
      id: 'cmd-spstatus',
      remoteJid: groupJid,
      senderJid: adminJid,
      text: `!spstatus @${memberJid.split('@')[0]}`,
      mentionedJids: [memberJid],
      timestamp: now,
      fromMe: false,
    })
    assert.match(core.sent.at(-1).text, /Level SP: \*SP 3\*/)

    await core.emitMessage({
      id: 'cmd-cancelsp',
      remoteJid: groupJid,
      senderJid: adminJid,
      text: `!cancelsp @${memberJid.split('@')[0]} reset`,
      mentionedJids: [memberJid],
      timestamp: now,
      fromMe: false,
    })
    assert.match(core.sent.at(-1).text, /Level SP saat ini: \*SP 0\*/)
    assert.equal(safety.getSpState(groupJid, memberJid).spLevel, 0)

    await app.stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
