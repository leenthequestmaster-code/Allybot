import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { GroupModerationSuiteService } from '../dist/services/group-moderation-suite-service.js'

const logger = pino({ level: 'silent' })

test('Security Modules: banstc, antiraid, and detailed antispam', async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'allybot-sec-test-'))
  const dbPath = join(tempDir, 'test.db')
  const suite = new GroupModerationSuiteService(dbPath, logger)
  const group = '120363000000000000@g.us'
  const user1 = '6281111111111@s.whatsapp.net'
  const user2 = '6282222222222@s.whatsapp.net'

  t.after(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  await t.test('banstc: configuration and strike tracking with 1h TTL', () => {
    assert.equal(suite.getSecuritySettings(group).banstc, 'off')

    suite.setBanstc(group, 'on')
    assert.equal(suite.getSecuritySettings(group).banstc, 'on')

    suite.setBanstc(group, 'strict')
    assert.equal(suite.getSecuritySettings(group).banstc, 'strict')

    // Strike accumulation
    assert.equal(suite.addStickerStrike(group, user1), 1)
    assert.equal(suite.addStickerStrike(group, user1), 2)
    assert.equal(suite.addStickerStrike(group, user1), 3)

    // Clear strikes
    suite.clearStickerStrikes(group, user1)
    assert.equal(suite.addStickerStrike(group, user1), 1)

    // Admin caching
    assert.equal(suite.isSenderAdminCached(group, user1), undefined)
    suite.cacheGroupAdmins(group, [user1])
    assert.equal(suite.isSenderAdminCached(group, user1), true)
    assert.equal(suite.isSenderAdminCached(group, user2), false)
    suite.invalidateGroupAdmins(group)
    assert.equal(suite.isSenderAdminCached(group, user1), undefined)
  })

  await t.test('antiraid: join velocity guard triggers on >=3 joins in 10s', () => {
    const baseNow = Date.now()
    const r1 = suite.recordGroupJoins(group, ['6283333333333@s.whatsapp.net'], 10_000, 3, 86_400_000, baseNow)
    assert.equal(r1.recentJoins, 1)
    assert.equal(r1.triggerRaidLock, false)

    const r2 = suite.recordGroupJoins(group, ['6284444444444@s.whatsapp.net'], 10_000, 3, 86_400_000, baseNow + 1000)
    assert.equal(r2.recentJoins, 2)
    assert.equal(r2.triggerRaidLock, false)

    const r3 = suite.recordGroupJoins(group, ['6285555555555@s.whatsapp.net'], 10_000, 3, 86_400_000, baseNow + 2000)
    assert.equal(r3.recentJoins, 3)
    assert.equal(r3.triggerRaidLock, true)

    // Newcomer is quarantined for 24h
    assert.equal(suite.isQuarantined(group, '6285555555555@s.whatsapp.net', baseNow + 2000), true)
    // After 24h + 1s from join time (baseNow + 2000), quarantine expires
    assert.equal(suite.isQuarantined(group, '6285555555555@s.whatsapp.net', baseNow + 2000 + 86_400_000 + 1000), false)
  })

  await t.test('antispam: sliding-window rate limit and duplicate hash detection', () => {
    const now = Date.now()
    const spammer = '6286666666666@s.whatsapp.net'

    // Normal message flow (different texts, within threshold)
    const e1 = suite.evaluateDetailedSpam(group, spammer, 'halo 1', undefined, now)
    assert.equal(e1.violated, false)
    assert.equal(e1.tier, 0)

    const e2 = suite.evaluateDetailedSpam(group, spammer, 'halo 2', undefined, now + 100)
    assert.equal(e2.violated, false)

    // Trigger duplicate hash limit (3 identical messages)
    const d1 = suite.evaluateDetailedSpam(group, spammer, 'spam text', undefined, now + 200)
    const d2 = suite.evaluateDetailedSpam(group, spammer, 'SPAM TEXT', undefined, now + 300)
    const d3 = suite.evaluateDetailedSpam(group, spammer, 'spam text  ', undefined, now + 400)
    assert.equal(d3.violated, true)
    assert.equal(d3.reason, 'duplicate_hash')
    assert.equal(d3.tier, 1)
    assert.equal(d3.shouldWarn, true)

    // Continued spam after warning escalates to Tier 2 (Mute)
    const d4 = suite.evaluateDetailedSpam(group, spammer, 'spam text', undefined, now + 1000)
    assert.equal(d4.violated, true)
    assert.equal(d4.tier, 2)
    assert.equal(suite.isMuted(group, spammer, now + 1000), true)
  })
})
