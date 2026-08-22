import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { GroupSafetyService } from '../dist/services/group-safety-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = pino({ level: 'silent' })
const groupJid = '120363000000000000@g.us'
const actorJid = '628120000002@s.whatsapp.net'

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'allybot-redis-safety-'))
  const databasePath = join(root, 'core.sqlite')
  let dedupeCalls = 0
  let rateCalls = 0
  const redis = {
    name: 'upstash-redis',
    isEnabled: true,
    async rememberOnce(scope, identity) {
      dedupeCalls += 1
      return dedupeCalls === 1
    },
    async consumeFixedWindow(scope, identity, limit, windowMs) {
      rateCalls += 1
      return { allowed: rateCalls <= 2, count: rateCalls, limit, resetAt: Date.now() + windowMs }
    },
  }
  const guardrails = new PlatformGuardrailService(databasePath, logger)
  const services = {
    get(name) {
      if (name === 'platform-guardrails') return guardrails
      if (name === 'upstash-redis') return redis
      throw new Error(`unknown service ${name}`)
    },
    has(name) { return name === 'platform-guardrails' || name === 'upstash-redis' },
  }
  const context = { logger, config: { commandPrefix: '!', defaultCooldownMs: 0, databasePath }, services }
  guardrails.initialize(context)
  const safety = new GroupSafetyService(databasePath, logger)
  safety.initialize(context)
  return { root, guardrails, safety, services, redis, get dedupeCalls() { return dedupeCalls }, get rateCalls() { return rateCalls } }
}

test('Group Safety uses Redis shared windows when available and preserves group scope', async () => {
  const fixture = createFixture()
  try {
    fixture.safety.setMode(groupJid, 'dry-run', actorJid)
    assert.equal(await fixture.safety.shouldCreateDryRunCaseDistributed(groupJid, actorJid, 'anti-link'), true)
    assert.equal(await fixture.safety.shouldCreateDryRunCaseDistributed(groupJid, actorJid, 'anti-link'), false)
    assert.equal(fixture.dedupeCalls, 2)

    assert.equal(await fixture.safety.consumeAntiSpamDistributed(groupJid, actorJid), true)
    assert.equal(await fixture.safety.consumeAntiSpamDistributed(groupJid, actorJid), true)
    assert.equal(await fixture.safety.consumeAntiSpamDistributed(groupJid, actorJid), false)
    assert.equal(fixture.rateCalls, 3)
  } finally {
    fixture.safety.shutdown({})
    fixture.guardrails.shutdown({})
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
