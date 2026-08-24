import assert from 'node:assert/strict'
import test from 'node:test'
import { PostgresReadOnlyMonitor } from '../dist/postgres-monitor.js'

const config = {
  url: 'postgres://postgres.example.test/postgres',
  poolMode: 'session',
}

test('PostgreSQL monitor emits a read-only pass event and closes the verifier', async () => {
  const events = []
  let closeCalls = 0
  const monitor = new PostgresReadOnlyMonitor(config, {
    intervalMs: 60_000,
    timeoutMs: 100,
    createVerifier: () => ({
      verify: async () => ({ ok: true, checked: 'read-only-select-1' }),
      close: async () => { closeCalls += 1 },
    }),
    onEvent: (event) => events.push(event),
  })

  const event = await monitor.checkNow()
  await monitor.stop()

  assert.equal(event.status, 'pass')
  assert.equal(event.checked, 'read-only-select-1')
  assert.equal(closeCalls, 1)
  assert.equal(events.length, 1)
})

test('PostgreSQL monitor prevents overlapping checks', async () => {
  const events = []
  let verifyCalls = 0
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const monitor = new PostgresReadOnlyMonitor(config, {
    intervalMs: 60_000,
    timeoutMs: 500,
    createVerifier: () => ({
      verify: async () => {
        verifyCalls += 1
        await pending
        return { ok: true, checked: 'read-only-select-1' }
      },
      close: async () => undefined,
    }),
    onEvent: (event) => events.push(event),
  })

  const first = monitor.checkNow()
  const second = monitor.checkNow()
  release()
  const [firstEvent, secondEvent] = await Promise.all([first, second])
  await monitor.stop()

  assert.equal(verifyCalls, 1)
  assert.equal(firstEvent.status, 'pass')
  assert.equal(secondEvent.status, 'pass')
  assert.equal(events.length, 1)
})

test('PostgreSQL monitor reports bounded timeout and still closes the verifier', async () => {
  let closeCalls = 0
  const monitor = new PostgresReadOnlyMonitor(config, {
    intervalMs: 60_000,
    timeoutMs: 10,
    createVerifier: () => ({
      verify: async () => new Promise(() => undefined),
      close: async () => { closeCalls += 1 },
    }),
    onEvent: () => undefined,
  })

  const event = await monitor.checkNow()
  await monitor.stop()

  assert.equal(event.status, 'fail')
  assert.match(event.error, /timed out after 10ms/)
  assert.equal(closeCalls, 1)
})

test('PostgreSQL monitor redacts connection details from failures', async () => {
  const events = []
  const monitor = new PostgresReadOnlyMonitor(config, {
    intervalMs: 60_000,
    timeoutMs: 100,
    createVerifier: () => ({
      verify: async () => {
        throw new Error('failed postgres://user@example.test/postgres password=redacted-value')
      },
      close: async () => undefined,
    }),
    onEvent: (event) => events.push(event),
  })

  const event = await monitor.checkNow()
  await monitor.stop()

  assert.equal(event.status, 'fail')
  assert.match(event.error, /password=\*\*\*/)
  assert.doesNotMatch(event.error, /redacted-value/)
  assert.equal(events.length, 1)
})

test('PostgreSQL monitor stops its timer and rejects new checks after stop', async () => {
  const monitor = new PostgresReadOnlyMonitor(config, {
    intervalMs: 10,
    timeoutMs: 100,
    createVerifier: () => ({
      verify: async () => ({ ok: true, checked: 'read-only-select-1' }),
      close: async () => undefined,
    }),
    onEvent: () => undefined,
  })

  monitor.start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  await monitor.stop()

  await assert.rejects(() => monitor.checkNow(), /has been stopped/)
})
