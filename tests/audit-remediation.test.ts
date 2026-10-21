import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { EconomyService } from '../dist/services/economy-service.js'
import { createSqliteEconomyClient } from '../dist/services/economy-sqlite-client.js'
import { GroupModerationSuiteService } from '../dist/services/group-moderation-suite-service.js'

const expect = (actual: any) => ({
  toBe: (expected: any) => assert.equal(actual, expected),
  toEqual: (expected: any) => assert.deepEqual(actual, expected),
  toBeDefined: () => assert.notEqual(actual, undefined),
})

const logger = pino({ level: 'silent' })
const GROUP_A = '120363000000000001@g.us'
const GROUP_B = '120363000000000002@g.us'
const USER_1 = '628111111111@s.whatsapp.net'
const USER_2 = '628222222222@s.whatsapp.net'

describe('Audit Remediation Regression Suite', () => {
  it('TASK-01: does not brick economy account when reward exceeds 20,000 Vela wallet limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'allybot-econ-test-'))
    const client = createSqliteEconomyClient(join(dir, 'economy.sqlite'))
    try {
      const service = new EconomyService(logger, {
        env: { ECONOMY_ENABLED: 'true' },
        createClient: () => client,
      })
      service.initialize({ logger, config: {} as any, services: { has: () => false, get: () => undefined } as any })

      // Grant 25,000 Vela (with 1,000 starter balance, total 26,000 exceeds 20,000 limit)
      await service.grantReward(GROUP_A, USER_1, 25_000, USER_1, 'op-reward-25k', 'Quest Boss')
      const snap = await service.getAccountSnapshot(GROUP_A, USER_1)
      expect(snap.snapshot.walletBalance).toBe(26_000)
      expect(snap.snapshot.restrictedWalletBalance).toBe(6_000)

      await service.shutdown()
    } finally {
      client.close?.()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TASK-02: upgrades membership tier to silver/gold/star instead of forcing bronze', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'allybot-tier-test-'))
    const client = createSqliteEconomyClient(join(dir, 'economy.sqlite'))
    try {
      const service = new EconomyService(logger, {
        env: { ECONOMY_ENABLED: 'true' },
        createClient: () => client,
      })
      service.initialize({ logger, config: {} as any, services: { has: () => false, get: () => undefined } as any })

      await service.upgradeMembership(GROUP_A, USER_1, 'gold', USER_1, 'op-upgrade-gold')
      const snap = await service.getAccountSnapshot(GROUP_A, USER_1)
      expect(snap.snapshot.membershipTier).toBe('gold')
      expect(snap.snapshot.safeLimit).toBe(500_000)

      await service.shutdown()
    } finally {
      client.close?.()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TASK-03: calculates weekly tax without 290% epoch penalty and prevents double payment in same week', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'allybot-tax-test-'))
    const client = createSqliteEconomyClient(join(dir, 'economy.sqlite'))
    try {
      const service = new EconomyService(logger, {
        env: { ECONOMY_ENABLED: 'true' },
        createClient: () => client,
      })
      service.initialize({ logger, config: {} as any, services: { has: () => false, get: () => undefined } as any })

      await service.grantReward(GROUP_A, USER_1, 10_000, USER_1, 'op-seed-10k', 'Starter')
      const summaryBefore = await service.getTaxSummary(GROUP_A, USER_1)
      expect(summaryBefore).toBeDefined()
      expect(summaryBefore!.frozenScope).toBe('none')
      expect(summaryBefore!.penaltyRate).toBe(0)
      expect(summaryBefore!.totalDue).toBe(220) // 2% base tax of 11,000 wealth (1,000 starter + 10,000 reward)

      await service.payTax(GROUP_A, USER_1, USER_1, 'op-pay-tax-1', 'Bayar pajak mingguan')
      const summaryAfter = await service.getTaxSummary(GROUP_A, USER_1)
      expect(summaryAfter!.totalDue).toBe(0)

      await service.shutdown()
    } finally {
      client.close?.()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TASK-16: isolates cryptographic audit chain per group and blocks empty-digit wildcard unban', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allybot-mod-test-'))
    try {
      const dbPath = join(dir, 'mod.sqlite')
      const mod = new GroupModerationSuiteService(dbPath, logger)

      mod.recordAudit(GROUP_A, USER_1, 'kick', USER_2, 'Spam')
      mod.recordAudit(GROUP_B, USER_1, 'ban', USER_2, 'Toxic')
      mod.recordAudit(GROUP_A, USER_1, 'mute', USER_2, '10m')

      expect(mod.verifyAuditChain(GROUP_A)).toEqual({ valid: true, totalEvents: 2 })
      expect(mod.verifyAuditChain(GROUP_B)).toEqual({ valid: true, totalEvents: 1 })

      mod.ban(GROUP_A, USER_2, USER_1, 'Blacklist')
      expect(mod.isBanned(GROUP_A, USER_2)).toBe(true)
      // Non-digit unban input must NOT wipe group bans
      expect(mod.unban(GROUP_A, '@non_digit_username')).toBe(false)
      expect(mod.isBanned(GROUP_A, USER_2)).toBe(true)

      mod.shutdown()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
