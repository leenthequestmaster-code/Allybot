import test from 'node:test'
import assert from 'node:assert/strict'
import { InMemoryPlatformEventSink, PolicyPermissionEvaluator, runPlatformOperation } from '../dist/platform/index.js'

test('operation runner applies permission gate before execution and audits denial', async () => {
  const events = new InMemoryPlatformEventSink()
  const permission = new PolicyPermissionEvaluator()
  let executed = false
  const result = await runPlatformOperation({
    operationId: 'admin.action',
    permission,
    permissionPort: permission,
    events,
    permission: { subjectJid: 'user@s.whatsapp.net', action: 'admin.action', scope: 'group' },
    execute: () => { executed = true },
  })
  assert.equal(result.ok, false)
  assert.equal(executed, false)
  assert.deepEqual(events.list().map(({ name }) => name), ['permission.denied'])
})

test('operation runner retries retryable errors and emits success after recovery', async () => {
  const events = new InMemoryPlatformEventSink()
  let attempts = 0
  const result = await runPlatformOperation({
    operationId: 'network.lookup',
    events,
    retry: { maxAttempts: 3, baseDelayMs: 0 },
    execute: () => {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('temporary'), { category: 'network' })
      return 'ok'
    },
  })
  assert.deepEqual(result, { ok: true, value: 'ok', attempts: 3 })
  assert.deepEqual(events.list().map(({ name }) => name), ['operation.started', 'operation.succeeded'])
})

test('operation runner does not retry non-retryable errors and reports safe error name', async () => {
  const events = new InMemoryPlatformEventSink()
  const result = await runPlatformOperation({
    operationId: 'validation.check',
    events,
    retry: { maxAttempts: 3, baseDelayMs: 0 },
    execute: () => { throw new TypeError('invalid input') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.attempts, 1)
  assert.deepEqual(events.list().map(({ name }) => name), ['operation.started', 'operation.failed'])
  assert.equal(events.list()[1].payload.error, 'TypeError')
})
