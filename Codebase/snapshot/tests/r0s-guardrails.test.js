import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FixedWindowRateLimiter,
  GuardrailPolicyRegistry,
  ProviderCircuitBreaker,
  SafeActionRegistry,
} from '../dist/platform/index.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = {
  child() { return this },
  info() {},
  warn() {},
  error() {},
  debug() {},
}

function serviceFor(path, options = {}) {
  const service = new PlatformGuardrailService(path, logger, options)
  service.initialize({})
  return service
}

test('R0-S policy registry is deterministic and default-deny', () => {
  const registry = new GuardrailPolicyRegistry()
  assert.equal(registry.evaluate({ policyId: 'missing', action: 'safe.send', scope: 'group' }).allowed, false)
  registry.register({ id: 'policy.send', version: 1, action: 'safe.send', scope: 'group', description: 'Allow safe send' })
  assert.equal(registry.evaluate({ policyId: 'policy.send', action: 'safe.delete', scope: 'group' }).allowed, false)
  assert.equal(registry.evaluate({ policyId: 'policy.send', action: 'safe.send', scope: 'group' }).allowed, true)
})

test('R0-S safe action registry exposes only registered enabled metadata', () => {
  const registry = new SafeActionRegistry()
  registry.register({ id: 'message.send', version: 1, description: 'Send a bounded message', inputSchemaVersion: 1, risk: 'low' })
  registry.register({ id: 'message.delete', version: 1, description: 'Delete a message', inputSchemaVersion: 1, risk: 'high', enabled: false })
  assert.equal(registry.get('message.send')?.risk, 'low')
  assert.equal(registry.get('message.delete'), undefined)
  assert.equal(registry.get('eval'), undefined)
})

test('R0-S fixed-window rate limiter is bounded and resets deterministically', () => {
  let now = 0
  const limiter = new FixedWindowRateLimiter({ clock: () => now, maxKeys: 1 })
  limiter.registerProfile({ id: 'burst', maxRequests: 1, windowMs: 10 })
  assert.equal(limiter.consume('burst', 'actor-a').allowed, true)
  assert.equal(limiter.consume('burst', 'actor-a').allowed, false)
  assert.equal(limiter.consume('burst', 'actor-b').reason, 'Rate limiter capacity exhausted')
  now = 10
  assert.equal(limiter.consume('burst', 'actor-a').allowed, true)
})

test('R0-S provider circuit transitions closed, open, half-open, and closed', () => {
  let now = 0
  const circuit = new ProviderCircuitBreaker({ failureThreshold: 2, cooldownMs: 10, halfOpenMaxCalls: 1, clock: () => now })
  assert.equal(circuit.allow().allowed, true)
  circuit.recordFailure()
  circuit.recordFailure()
  assert.equal(circuit.state, 'open')
  assert.equal(circuit.allow().allowed, false)
  now = 10
  assert.equal(circuit.allow().state, 'half-open')
  circuit.recordSuccess()
  assert.equal(circuit.state, 'closed')
})

test('R0-S audit sanitizer hashes JIDs and rejects sensitive metadata', () => {
  const service = serviceFor(':memory:')
  service.recordAudit({ eventType: 'security.denied', namespace: 'allybot', occurredAt: 1, outcome: 'denied', actorJid: '6281@s.whatsapp.net', metadata: { reason: 'policy' } })
  const record = service.listAudit()[0]
  assert.equal(record.actorHash, '019ef87e741de77b')
  assert.equal('reason' in record.metadata, true)
  assert.throws(() => service.recordAudit({ eventType: 'security.denied', namespace: 'allybot', occurredAt: 2, outcome: 'denied', metadata: { rawMessage: 'secret' } }), /not allowed/)
  assert.throws(() => service.recordAudit({ eventType: 'security.denied', namespace: 'allybot', occurredAt: 3, outcome: 'denied', metadata: { reason: 'Bearer abc.def.ghi' } }), /looks sensitive/)
  service.shutdown({})
})

test('R0-S group feature flags are isolated and persist across service restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-r0s-'))
  const databasePath = join(directory, 'guardrails.sqlite')
  const first = serviceFor(databasePath)
  const flag = first.setFeatureFlag('120@g.us', 'anti-link', true, '6281@s.whatsapp.net', 'flag-1', 100)
  assert.equal(flag.enabled, true)
  assert.equal(first.isFeatureEnabled('120@g.us', 'anti-link'), true)
  assert.equal(first.isFeatureEnabled('121@g.us', 'anti-link'), false)
  first.shutdown({})
  const second = serviceFor(databasePath)
  assert.equal(second.isFeatureEnabled('120@g.us', 'anti-link'), true)
  assert.equal(second.getFeatureFlag('120@g.us', 'anti-link')?.updatedByHash, '019ef87e741de77b')
  second.shutdown({})
  rmSync(directory, { recursive: true, force: true })
})

test('R0-S audit overflow archives old records transactionally and keeps archive', () => {
  const service = serviceFor(':memory:', { maxHotAuditRecords: 2 })
  service.recordAudit({ eventId: 'event-1', eventType: 'test.one', namespace: 'allybot', occurredAt: 1, outcome: 'allowed' })
  service.recordAudit({ eventId: 'event-2', eventType: 'test.two', namespace: 'allybot', occurredAt: 2, outcome: 'allowed' })
  service.recordAudit({ eventId: 'event-3', eventType: 'test.three', namespace: 'allybot', occurredAt: 3, outcome: 'allowed' })
  assert.equal(service.listAudit({ limit: 10 }).length, 2)
  assert.deepEqual(service.listAudit({ includeArchive: true, limit: 10 }).map((record) => record.eventId), ['event-3', 'event-2', 'event-1'])
  assert.equal(service.recordAudit({ eventId: 'event-1', eventType: 'test.one', namespace: 'allybot', occurredAt: 1, outcome: 'allowed' }).eventId, 'event-1')
  service.shutdown({})
})

test('R0-S archive failure rolls back the hot insert atomically', () => {
  const directory = mkdtempSync(join(tmpdir(), 'allybot-r0s-archive-'))
  const databasePath = join(directory, 'guardrails.sqlite')
  const service = serviceFor(databasePath, { maxHotAuditRecords: 1 })
  service.recordAudit({ eventId: 'event-1', eventType: 'test.one', namespace: 'allybot', occurredAt: 1, outcome: 'allowed' })
  const blocker = new Database(databasePath)
  blocker.exec(`CREATE TRIGGER block_guardrail_archive BEFORE INSERT ON platform_guardrail_audit_archive BEGIN SELECT RAISE(ABORT, 'archive blocked'); END;`)
  assert.throws(() => service.recordAudit({ eventId: 'event-2', eventType: 'test.two', namespace: 'allybot', occurredAt: 2, outcome: 'allowed' }), /archive blocked/)
  assert.deepEqual(service.listAudit({ includeArchive: true, limit: 10 }).map((record) => record.eventId), ['event-1'])
  blocker.close()
  service.shutdown({})
  rmSync(directory, { recursive: true, force: true })
})

test('R0-S policy evaluation fails closed when audit persistence is unavailable', () => {
  const service = serviceFor(':memory:')
  service.registerPolicy({ id: 'policy.safe', version: 1, action: 'safe.read', scope: 'group', description: 'Safe read' })
  service.shutdown({})
  const decision = service.evaluatePolicy({ policyId: 'policy.safe', action: 'safe.read', scope: 'group' }, { actorJid: '6281@s.whatsapp.net' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, 'Guardrail audit unavailable')
})
