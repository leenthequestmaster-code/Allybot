import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeveloperModeService } from '../dist/services/developer-mode-service.js'
import { PlatformGuardrailService } from '../dist/services/platform-guardrail-service.js'

const logger = {
  child() { return this },
  info() {},
  warn() {},
  error() {},
  debug() {},
}

const actorJid = '<jid-redacted@s.whatsapp.net>'
const resourceJid = '<jid-redacted@g.us>'

function assertScalarMetadata(metadata) {
  for (const value of Object.values(metadata)) {
    assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value))
  }
}

test('observability contract keeps guardrail audit bounded, scalar, and redacted', () => {
  const service = new PlatformGuardrailService(':memory:', logger, { maxHotAuditRecords: 2 })
  service.initialize({})
  try {
    service.recordAudit({
      eventId: 'observability-event-1',
      eventType: 'security.denied',
      namespace: 'allybot',
      occurredAt: 1,
      actorJid,
      resourceJid,
      outcome: 'denied',
      correlationId: 'observability-correlation-1',
      metadata: { command: 'owner', scope: 'private', policyVersion: 1, count: 1, feature: 'diagnostics' },
    })
    const record = service.listAudit({ includeArchive: true, limit: 10 })[0]
    const serialized = JSON.stringify(record)

    assert.equal(serialized.includes(actorJid), false)
    assert.equal(serialized.includes(resourceJid), false)
    assert.equal(record.outcome, 'denied')
    assertScalarMetadata(record.metadata)
    assert.throws(() => service.recordAudit({
      eventId: 'observability-event-2',
      eventType: 'security.denied',
      namespace: 'allybot',
      occurredAt: 2,
      outcome: 'denied',
      metadata: { rawMessage: 'should-not-be-stored' },
    }), /not allowed/)

    service.recordAudit({ eventId: 'observability-event-3', eventType: 'security.allowed', namespace: 'allybot', occurredAt: 3, outcome: 'allowed' })
    service.recordAudit({ eventId: 'observability-event-4', eventType: 'security.limited', namespace: 'allybot', occurredAt: 4, outcome: 'limited' })
    assert.deepEqual(service.listAudit({ includeArchive: true, limit: 10 }).map((item) => item.eventId), [
      'observability-event-4',
      'observability-event-3',
      'observability-event-1',
    ])
  } finally {
    service.shutdown({})
  }
})

test('observability contract exposes Developer Mode audit as bounded hashes and outcomes', () => {
  const service = new DeveloperModeService(':memory:', logger, { maxAuditRecords: 3 })
  service.initialize({})
  try {
    const owner = '<jid-redacted@s.whatsapp.net>'
    const target = '<jid-redacted@s.whatsapp.net>'
    const activation = service.activate(owner, target, 'observer', 60_000, 'diagnostic review', 1_000)
    assert.equal(activation.scope, 'observer')
    assert.equal(service.evaluate(target, 'observer', 1_001).allowed, true)
    assert.equal(service.revoke(owner, activation.id, 1_002), true)

    const audit = service.listAudit(10)
    const serialized = JSON.stringify(audit)
    assert.equal(serialized.includes(owner), false)
    assert.equal(serialized.includes(target), false)
    assert.ok(audit.length <= 3)
    assert.ok(audit.every((item) => typeof item.actorHash === 'string' && typeof item.outcome === 'string'))
  } finally {
    service.shutdown({})
  }
})
