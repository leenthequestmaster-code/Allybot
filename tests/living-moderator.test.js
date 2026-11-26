import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import pino from 'pino'
import {
  LivingModeratorService,
  isModerationReportIntent,
  bareJid,
} from '../dist/services/living-moderator-service.js'
import { ChatHistoryService } from '../dist/services/chat-history-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'
import { GroupSafetyService } from '../dist/services/group-safety-service.js'
import { GroupModerationSuiteService } from '../dist/services/group-moderation-suite-service.js'
import { detectChlonaWake } from '../dist/services/chlona-wake-gate.js'

const logger = pino({ level: 'silent' })

function createTestEnv(dir, overrides = {}) {
  const dbPath = join(dir, 'allybot.sqlite')
  const groupJid = '120363421406209536@g.us'
  const botJid = '6285181696890@s.whatsapp.net'
  const ownerJid = '6283197859955@s.whatsapp.net'
  const adminJid = '628111000999@s.whatsapp.net'
  const offenderJid = '628111000333@s.whatsapp.net'
  const innocentJid = '628111000444@s.whatsapp.net'
  const reporterJid = '628111000555@s.whatsapp.net'

  let nowMs = overrides.initialNow ?? 1_795_700_000_000
  const clock = () => nowMs
  const advanceTime = (ms) => { nowMs += ms }

  const deleted = []
  const settingsUpdates = []
  const participantUpdates = []
  const sentTexts = []

  const whatsapp = {
    userJid: botJid,
    userLid: '999888777@lid',
    async sendText(remoteJid, text, options) { sentTexts.push({ remoteJid, text, options }) },
    async deleteMessage(remoteJid, key) { deleted.push({ remoteJid, key }) },
    async groupSettingUpdate(remoteJid, setting) { settingsUpdates.push({ remoteJid, setting }) },
    async groupParticipantsUpdate(remoteJid, jids, action) { participantUpdates.push({ remoteJid, jids, action }) },
    async getGroupMetadata(remoteJid) {
      return {
        jid: remoteJid,
        subject: 'Forsaken Land - OOC Talk',
        ownerJid,
        participants: [
          { jid: botJid, role: 'admin' },
          { jid: ownerJid, role: 'superadmin' },
          { jid: adminJid, role: 'admin' },
          { jid: offenderJid, role: 'member' },
          { jid: innocentJid, role: 'member' },
          { jid: reporterJid, role: 'member' },
        ],
      }
    },
  }

  const chatHistory = new ChatHistoryService(logger)
  const guardrails = new PlatformGuardrailService(dbPath, logger, { clock })
  const safety = new GroupSafetyService(dbPath, logger, { clock })
  const suite = new GroupModerationSuiteService(dbPath, logger)

  const gatekeeper = {
    name: 'gatekeeper',
    getContextPolicy(jid) {
      return overrides.contextPolicies?.[jid] ?? 'ooc_limited'
    },
    isOfficialMember(jid) {
      return bareJid(jid) === bareJid(reporterJid) || bareJid(jid) === bareJid(ownerJid)
    },
    isOwner(jid) {
      return bareJid(jid) === bareJid(ownerJid)
    },
    getOocGroupJid() {
      return groupJid
    },
  }

  const suggest = {
    name: 'suggestion',
    getBoxGroup(type) {
      return type === 'report' ? '120363433777737475@g.us' : undefined
    },
  }

  const map = new Map([
    ['chat-history', chatHistory],
    ['platform-guardrails', guardrails],
    ['group-safety', safety],
    ['group-moderation-suite', suite],
    ['gatekeeper', gatekeeper],
    ['suggestion', suggest],
  ])
  const services = {
    has: (name) => map.has(name),
    get: (name) => map.get(name),
  }
  const ctx = {
    logger,
    services,
    config: { commandPrefix: '!', defaultCooldownMs: 0, databasePath: dbPath },
  }
  guardrails.initialize(ctx)
  safety.initialize(ctx)
  suite.initialize()

  return {
    dbPath, groupJid, botJid, ownerJid, adminJid, offenderJid, innocentJid, reporterJid,
    clock, advanceTime, deleted, settingsUpdates, participantUpdates, sentTexts,
    whatsapp, chatHistory, safety, suite, services,
  }
}

test('isModerationReportIntent & bareJid accurately identify reports without hijacking normal commands', () => {
  assert.equal(bareJid('628111:14@s.whatsapp.net'), '628111@s.whatsapp.net')
  assert.equal(isModerationReportIntent('tolong cek atas ada yang spam dan ngatain kasar'), true)
  assert.equal(isModerationReportIntent('di ooc ada yang promosi link server lain'), true)
  assert.equal(isModerationReportIntent('cek cuaca bandung dong'), false)
  assert.equal(isModerationReportIntent('cek saldo sona aku dong'), false)
})

test('LivingModerator strictly ignores moderator_only (42 RP) and silent (announcement) groups', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'living-mod-region-'))
  try {
    const rpJid = '120363400000000042@g.us'
    const env = createTestEnv(dir, { contextPolicies: { [rpJid]: 'moderator_only' } })
    let evaluatorCalled = false
    const mod = new LivingModeratorService({
      databasePath: env.dbPath,
      whatsapp: env.whatsapp,
      botOwnerJid: env.ownerJid,
      clock: env.clock,
      logger,
      verdictEvaluator: async () => {
        evaluatorCalled = true
        return { valid: true, findings: [], publicReply: 'nope' }
      },
    })
    await mod.initialize({ logger, services: env.services, commands: {}, events: {}, messageGates: {}, config: {} })

    const res = await mod.handleReport({
      message: {
        id: 'rep-1',
        remoteJid: rpJid,
        senderJid: env.reporterJid,
        text: 'Chlona ada yang spam',
        timestamp: env.clock(),
        fromMe: false,
      },
      instruction: 'ada yang spam',
      services: env.services,
    })

    assert.equal(res.handled, false)
    assert.equal(res.reason, 'blocked_by_context_policy')
    assert.equal(evaluatorCalled, false)
    mod.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LivingModerator enforces messageId ownership validation & Admin/Owner/Bot immunity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'living-mod-guard-'))
  try {
    const env = createTestEnv(dir)
    await env.chatHistory.recordMessage({
      id: 'MSG-REAL-OFFENDER',
      remoteJid: env.groupJid,
      senderJid: env.offenderJid,
      pushName: 'Offender',
      text: 'join server sebelah https://bit.ly/abc',
      timestamp: env.clock() - 1000,
      fromMe: false,
    })
    await env.chatHistory.recordMessage({
      id: 'MSG-INNOCENT',
      remoteJid: env.groupJid,
      senderJid: env.innocentJid,
      pushName: 'Innocent',
      text: 'halo guys',
      timestamp: env.clock() - 500,
      fromMe: false,
    })
    await env.chatHistory.recordMessage({
      id: 'MSG-ADMIN',
      remoteJid: env.groupJid,
      senderJid: env.adminJid,
      pushName: 'AdminGrup',
      text: 'tenang dulu',
      timestamp: env.clock() - 200,
      fromMe: false,
    })

    const mod = new LivingModeratorService({
      databasePath: env.dbPath,
      whatsapp: env.whatsapp,
      botOwnerJid: env.ownerJid,
      clock: env.clock,
      logger,
      verdictEvaluator: async ({ transcriptBlock }) => {
        assert.ok(transcriptBlock.startsWith('<untrusted_chat_transcript>\n'))
        assert.ok(transcriptBlock.endsWith('\n</untrusted_chat_transcript>'))
        return {
          valid: true,
          findings: [
            {
              sopId: 'SOP-03',
              targetJid: env.offenderJid,
              // Include 1 genuine ID, 1 ID owned by innocent, 1 fabricated ID
              messageIds: ['MSG-REAL-OFFENDER', 'MSG-INNOCENT', 'MSG-FABRICATED-999'],
              reason: 'Promosi link server lain',
            },
            {
              sopId: 'SOP-02',
              targetJid: env.adminJid, // Admin MUST be immune
              messageIds: ['MSG-ADMIN'],
              reason: 'Coba hukum admin',
            },
            {
              sopId: 'SOP-01',
              targetJid: env.ownerJid, // Owner MUST be immune
              messageIds: [],
              reason: 'Coba hukum owner',
            },
          ],
          publicReply: 'Pelanggaran promosi oleh pelaku ditindak.',
        }
      },
    })
    await mod.initialize({ logger, services: env.services, commands: {}, events: {}, messageGates: {}, config: {} })

    const res = await mod.handleReport({
      message: {
        id: 'rep-2',
        remoteJid: env.groupJid,
        senderJid: env.reporterJid,
        text: 'Chlona ada yang promosi',
        timestamp: env.clock(),
        fromMe: false,
      },
      instruction: 'ada yang promosi link luar',
      services: env.services,
    })

    assert.equal(res.handled, true)
    assert.equal(res.valid, true)
    assert.equal(env.deleted.length, 1)
    assert.equal(env.deleted[0].key.id, 'MSG-REAL-OFFENDER')
    assert.equal(env.safety.countActiveWarnings(env.groupJid, env.offenderJid, env.clock()), 1)
    assert.equal(env.safety.countActiveWarnings(env.groupJid, env.adminJid, env.clock()), 0)
    assert.equal(env.safety.countActiveWarnings(env.groupJid, env.ownerJid, env.clock()), 0)
    assert.equal(env.participantUpdates.length, 0) // ZERO kick/ban
    mod.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LivingModerator SOP-04 locks 3m persistently across restart, enforces 15m lock cooldown, mutes 30m, escalates, and NEVER kicks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'living-mod-sop04-'))
  try {
    const env = createTestEnv(dir)
    await env.chatHistory.recordMessage({
      id: 'MSG-NSFW-1',
      remoteJid: env.groupJid,
      senderJid: env.offenderJid,
      pushName: 'Rusuh',
      text: 'konten 18+ dan doxxing nomor 081234',
      timestamp: env.clock() - 1000,
      fromMe: false,
    })

    const callOrder = []
    const origSet = env.whatsapp.groupSettingUpdate.bind(env.whatsapp)
    env.whatsapp.groupSettingUpdate = async (gid, setting) => {
      callOrder.push(`wa:${setting}`)
      return origSet(gid, setting)
    }

    const mod1 = new LivingModeratorService({
      databasePath: env.dbPath,
      whatsapp: env.whatsapp,
      botOwnerJid: env.ownerJid,
      clock: env.clock,
      logger,
      pollIntervalMs: 60_000,
      verdictEvaluator: async () => ({
        valid: true,
        findings: [
          {
            sopId: 'SOP-04',
            targetJid: env.offenderJid,
            messageIds: ['MSG-NSFW-1'],
            reason: 'Doxxing dan konten NSFW',
          },
        ],
        publicReply: 'Konten berbahaya dibersihkan dan pelaku di-mute 30 menit.',
      }),
    })
    await mod1.initialize({ logger, services: env.services, commands: {}, events: {}, messageGates: {}, config: {} })

    const res1 = await mod1.handleReport({
      message: {
        id: 'rep-sop04',
        remoteJid: env.groupJid,
        senderJid: env.reporterJid,
        text: 'Chlona ada yang doxxing!',
        timestamp: env.clock(),
        fromMe: false,
      },
      instruction: 'ada yang doxxing dan nsfw',
      services: env.services,
    })

    assert.equal(res1.valid, true)
    assert.equal(env.settingsUpdates.length, 1)
    assert.equal(env.settingsUpdates[0].setting, 'announcement')
    assert.equal(env.suite.isMuted(env.groupJid, env.offenderJid, env.clock()), true)
    assert.equal(env.participantUpdates.length, 0) // NEVER kick
    assert.ok(env.sentTexts.some((t) => t.remoteJid === '120363433777737475@g.us' && t.text.includes('SOP-04')))

    // Simulate process restart while group is still locked
    mod1.shutdown()
    env.advanceTime(3 * 60 * 1_000 + 1_000) // 3m1s elapsed

    const mod2 = new LivingModeratorService({
      databasePath: env.dbPath,
      whatsapp: env.whatsapp,
      botOwnerJid: env.ownerJid,
      clock: env.clock,
      logger,
      pollIntervalMs: 60_000,
      verdictEvaluator: async () => ({
        valid: true,
        findings: [
          {
            sopId: 'SOP-01',
            targetJid: env.offenderJid,
            messageIds: ['MSG-NSFW-1'],
            reason: 'Spam lanjutan',
          },
        ],
        publicReply: 'Spam ditindak.',
      }),
    })
    await mod2.initialize({ logger, services: env.services, commands: {}, events: {}, messageGates: {}, config: {} })

    // Startup recovery MUST automatically reopen the group
    assert.equal(env.settingsUpdates.length, 2)
    assert.equal(env.settingsUpdates[1].setting, 'not_announcement')

    // Second lock attempt within 15m MUST be blocked by lock cooldown
    const res2 = await mod2.handleReport({
      message: {
        id: 'rep-sop01-within-15m',
        remoteJid: env.groupJid,
        senderJid: env.reporterJid,
        text: 'Chlona spam lagi',
        timestamp: env.clock(),
        fromMe: false,
      },
      instruction: 'spam lagi',
      services: env.services,
    })
    assert.equal(res2.valid, true)
    assert.ok(res2.executedActions.includes('lock_skipped_cooldown'))
    assert.equal(env.settingsUpdates.length, 2) // still 2, no re-lock
    assert.equal(env.participantUpdates.length, 0) // ZERO kick/ban
    mod2.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LivingModerator enforces anti-abuse cooldown (2x false reports in 10m -> 10m cooldown) & supports 2-way PC reporting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'living-mod-pc-'))
  try {
    const env = createTestEnv(dir)
    await env.chatHistory.recordMessage({
      id: 'MSG-OOC-SPAM',
      remoteJid: env.groupJid,
      senderJid: env.offenderJid,
      pushName: 'Spammer',
      text: 'spam spam spam',
      timestamp: env.clock() - 500,
      fromMe: false,
    })

    let evalCount = 0
    let verdictMode = 'false'
    const mod = new LivingModeratorService({
      databasePath: env.dbPath,
      whatsapp: env.whatsapp,
      botOwnerJid: env.ownerJid,
      clock: env.clock,
      logger,
      verdictEvaluator: async () => {
        evalCount += 1
        if (verdictMode === 'false') {
          return { valid: false, findings: [], publicReply: 'Nggak ada pelanggaran kok.' }
        }
        return {
          valid: true,
          findings: [{ sopId: 'SOP-01', targetJid: env.offenderJid, messageIds: ['MSG-OOC-SPAM'], reason: 'Spam di OOC' }],
          publicReply: 'Spam di OOC ditindak.',
        }
      },
    })
    await mod.initialize({ logger, services: env.services, commands: {}, events: {}, messageGates: {}, config: {} })

    // 2 false reports from reporter -> triggers 10m cooldown
    await mod.handleReport({
      message: { id: 'f1', remoteJid: env.groupJid, senderJid: env.reporterJid, text: 'lapor', timestamp: env.clock(), fromMe: false },
      instruction: 'ada yg spam',
      services: env.services,
    })
    await mod.handleReport({
      message: { id: 'f2', remoteJid: env.groupJid, senderJid: env.reporterJid, text: 'lapor', timestamp: env.clock(), fromMe: false },
      instruction: 'ada yg spam lagi',
      services: env.services,
    })
    assert.equal(evalCount, 2)

    // 3rd report during cooldown MUST NOT call evaluator
    const blocked = await mod.handleReport({
      message: { id: 'f3', remoteJid: env.groupJid, senderJid: env.reporterJid, text: 'lapor', timestamp: env.clock(), fromMe: false },
      instruction: 'ada yg spam terus',
      services: env.services,
    })
    assert.equal(evalCount, 2)
    assert.equal(blocked.reason, 'reporter_false_report_cooldown')

    // After 10m cooldown, test DM/PC 2-way reporting targeting official OOC group
    env.advanceTime(11 * 60 * 1_000)
    verdictMode = 'true'
    const dmWake = detectChlonaWake({
      id: 'dm-wake',
      remoteJid: env.reporterJid,
      senderJid: env.reporterJid,
      text: 'di ooc ada yang spam barusan tolong cek',
      timestamp: env.clock(),
      fromMe: false,
    }, env.whatsapp)
    assert.equal(dmWake.triggered, true)
    assert.equal(dmWake.triggerKind, 'dm')

    const dmRes = await mod.handleReport({
      message: {
        id: 'dm-1',
        remoteJid: env.reporterJid, // DM!
        senderJid: env.reporterJid,
        text: 'di ooc ada yang spam barusan',
        timestamp: env.clock(),
        fromMe: false,
      },
      instruction: 'di ooc ada yang spam barusan',
      services: env.services,
    })
    assert.equal(dmRes.valid, true)
    assert.equal(dmRes.reason, 'executed_from_pc_anonymously')
    assert.equal(env.deleted[0].key.id, 'MSG-OOC-SPAM')
    // Group gets neutral notice without reporter identity
    const groupNotice = env.sentTexts.find((s) => s.remoteJid === env.groupJid)
    assert.ok(groupNotice)
    assert.equal(groupNotice.text.includes('628111000555'), false)

    // Test GroupModerationSuiteService.ensureGroupDefaults auto-enables OOC automod + warnLimit 5
    env.suite.ensureGroupDefaults(env.groupJid, { antilink: true, antispam: true, antitoxic: true, warnLimit: 5 })
    assert.deepEqual(env.suite.getAutomod(env.groupJid), { antilink: true, antispam: true, antitoxic: true })
    assert.equal(env.suite.getWarnLimit(env.groupJid), 5)

    // Manual override must NOT be overwritten on subsequent boot
    env.suite.setAutomod(env.groupJid, 'antilink', false)
    env.suite.ensureGroupDefaults(env.groupJid, { antilink: true, antispam: true, antitoxic: true, warnLimit: 5 })
    assert.equal(env.suite.getAutomod(env.groupJid).antilink, false)

    mod.shutdown()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
