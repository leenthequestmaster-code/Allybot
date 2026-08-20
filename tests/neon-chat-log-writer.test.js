import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NeonChatLogWriter,
  isRetryableNeonError,
  toNeonChatLogRecord,
} from '../dist/neon-chat-log-writer.js'

function message(overrides = {}) {
  return {
    id: 'msg-1',
    remoteJid: '120@g.us',
    senderJid: '6281@s.whatsapp.net',
    text: 'scene update',
    timestamp: 1_750_000_000_000,
    receivedAt: 1_750_000_001_000,
    fromMe: false,
    ...overrides,
  }
}

function options(overrides = {}) {
  return {
    groupJids: new Set(['120@g.us']),
    queueCapacity: 10,
    maxAttempts: 3,
    retryDelayMs: 1,
    maxRetryDelayMs: 4,
    drainTimeoutMs: 100,
    sleep: async () => {},
    ...overrides,
  }
}

test('writer builds a stable integrity record and classifies message type', () => {
  const record = toNeonChatLogRecord(message({ buttonId: 'next', mentionedJids: ['6282@s.whatsapp.net'] }))
  assert.equal(record.eventKey, '120@g.us:msg-1')
  assert.equal(record.messageType, 'text_button')
  assert.equal(record.mentionedJidsJson, '["6282@s.whatsapp.net"]')
  assert.match(record.contentSha256, /^[a-f0-9]{64}$/)
  assert.notEqual(toNeonChatLogRecord(message({ text: 'changed' })).contentSha256, record.contentSha256)
})

test('writer retries transient Neon failures and persists after recovery', async () => {
  let attempts = 0
  const calls = []
  const sql = {
    unsafe: async (query, values) => {
      calls.push({ query, values })
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' })
      return []
    },
  }
  const writer = new NeonChatLogWriter(sql, { error() {}, warn() {} }, options())

  assert.equal(writer.enqueue(message()), 'queued')
  const result = await writer.close()
  assert.equal(result.drained, true)
  assert.equal(attempts, 2)
  assert.equal(writer.getStats().retries, 1)
  assert.equal(writer.getStats().persisted, 1)
  assert.match(calls[0].query, /ON CONFLICT \(event_key\) DO NOTHING/)
  assert.equal(calls[0].values[0], '120@g.us:msg-1')
})

test('writer does not retry permanent SQL failures', async () => {
  let attempts = 0
  const sql = {
    unsafe: async () => {
      attempts += 1
      throw Object.assign(new Error('relation missing'), { code: '42P01' })
    },
  }
  const writer = new NeonChatLogWriter(sql, { error() {}, warn() {} }, options())

  writer.enqueue(message())
  const result = await writer.close()
  assert.equal(result.drained, true)
  assert.equal(attempts, 1)
  assert.equal(writer.getStats().failed, 1)
  assert.equal(writer.getStats().retries, 0)
})

test('writer enforces group scope and bounded queue', async () => {
  let release
  let startedResolve
  const started = new Promise((resolve) => { startedResolve = resolve })
  const gate = new Promise((resolve) => { release = resolve })
  const sql = {
    unsafe: async () => {
      startedResolve()
      await gate
      return []
    },
  }
  const writer = new NeonChatLogWriter(sql, { error() {}, warn() {} }, options({ queueCapacity: 2 }))

  assert.equal(writer.enqueue(message({ remoteJid: '999@g.us' })), 'group-disabled')
  assert.equal(writer.enqueue(message({ id: 'first' })), 'queued')
  await started
  assert.equal(writer.enqueue(message({ id: 'second' })), 'queued')
  assert.equal(writer.enqueue(message({ id: 'third' })), 'queue-full')

  release()
  const result = await writer.close()
  assert.equal(result.drained, true)
  assert.equal(writer.getStats().dropped, 1)
})

test('writer close reports bounded drain timeout and rejects new records', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const sql = { unsafe: async () => gate }
  const writer = new NeonChatLogWriter(sql, { error() {}, warn() {} }, options({ drainTimeoutMs: 5 }))

  writer.enqueue(message())
  const result = await writer.close()
  assert.equal(result.drained, false)
  assert.equal(result.remaining, 1)
  assert.equal(writer.enqueue(message({ id: 'after-close' })), 'closed')

  release()
  await new Promise((resolve) => setImmediate(resolve))
})

test('writer drops malformed or oversized records without throwing', async () => {
  const sql = { unsafe: async () => [] }
  const writer = new NeonChatLogWriter(sql, { error() {}, warn() {} }, options())

  assert.equal(writer.enqueue(message({ text: 'x'.repeat(128_001) })), 'invalid')
  assert.equal(writer.enqueue(message({ timestamp: 0 })), 'invalid')
  assert.equal(writer.getStats().accepted, 0)
  assert.equal(writer.getStats().dropped, 2)
  assert.equal((await writer.close()).drained, true)
})

test('retry classification excludes authentication and schema failures', () => {
  assert.equal(isRetryableNeonError(Object.assign(new Error('temporary'), { code: '57P01' })), true)
  assert.equal(isRetryableNeonError(Object.assign(new Error('auth'), { code: '28P01' })), false)
  assert.equal(isRetryableNeonError(Object.assign(new Error('missing table'), { code: '42P01' })), false)
})
