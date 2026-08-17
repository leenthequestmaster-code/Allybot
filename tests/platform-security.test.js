import test from 'node:test'
import assert from 'node:assert/strict'
import {
  InMemoryPlatformEventSink,
  PolicyPermissionEvaluator,
  isJid,
  isSafeIdentifier,
  normalizeText,
} from '../dist/platform/index.js'

test('permission evaluator is default-deny and respects deterministic first-match policy', () => {
  const evaluator = new PolicyPermissionEvaluator()
  const request = { subjectJid: 'user@s.whatsapp.net', action: 'menu.open', scope: 'chat' }
  assert.equal(evaluator.evaluate(request).allowed, false)

  const remove = evaluator.addRule((candidate) => candidate.action === 'menu.open'
    ? { allowed: true, reason: 'Menu access is public', policy: 'public-menu' }
    : undefined)
  assert.deepEqual(evaluator.evaluate(request), { allowed: true, reason: 'Menu access is public', policy: 'public-menu' })
  remove()
  assert.equal(evaluator.evaluate(request).allowed, false)
  assert.throws(() => evaluator.evaluate({ ...request, action: ' ' }), /action must not be empty/)
})

test('event sink keeps a bounded copy suitable for audit inspection', () => {
  const sink = new InMemoryPlatformEventSink(2)
  sink.emit({ name: 'feature.registered', at: 1, payload: { id: 'one' } })
  sink.emit({ name: 'feature.ready', at: 2, payload: { id: 'two' } })
  sink.emit({ name: 'platform.error', at: 3, payload: { code: 'E_TEST' } })
  assert.deepEqual(sink.list().map((event) => event.at), [2, 3])
  sink.clear()
  assert.equal(sink.list().length, 0)
})

test('validation utilities reject unsafe identifiers and malformed JIDs', () => {
  assert.equal(isSafeIdentifier('group-setup'), true)
  assert.equal(isSafeIdentifier('Group Setup'), false)
  assert.equal(isJid('user@s.whatsapp.net'), true)
  assert.equal(isJid('not a jid'), false)
  assert.equal(normalizeText('  hello  '), 'hello')
  assert.equal(normalizeText('   '), undefined)
})
