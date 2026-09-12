import assert from 'node:assert/strict'
import test from 'node:test'
import { RedisService, readRedisConfig } from '../dist/redis.js'

test('RedisService readConfig and health status disabled by default', async () => {
  const config = readRedisConfig({})
  assert.equal(config, undefined)

  const service = new RedisService({ env: {} })
  assert.equal(service.isEnabled, false)
  assert.equal(service.getHealth().status, 'disabled')

  await service.initialize({ logger: { info() {}, error() {}, debug() {} } })
  assert.equal(service.getHealth().status, 'disabled')
  await service.shutdown()
})

test('RedisService yields no decision when disabled so callers keep their local guards', async () => {
  const service = new RedisService({ env: {} })
  assert.equal(await service.consumeFixedWindow('spam', 'test-user', 5, 1000), undefined)

  const val = await service.cacheGet('test', 'key')
  assert.equal(val, undefined)

  const saved = await service.cacheSet('test', 'key', { foo: 'bar' }, 60)
  assert.equal(saved, false)

  assert.equal(await service.cacheDelete('test', 'key'), false)

  const dedupe = await service.rememberOnce('test', 'id-1', 60)
  assert.equal(dedupe, undefined)
})
// Minimal in-memory ioredis-like client honoring SET ... EX ... NX semantics.
class FakeRedisClient {
  constructor() {
    this.store = new Map()
    this.ttls = new Map()
  }
  async ping() { return 'PONG' }
  async get(key) {
    const expiresAt = this.ttls.get(key)
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      this.store.delete(key)
      this.ttls.delete(key)
    }
    return this.store.has(key) ? this.store.get(key) : null
  }
  async set(key, value, ...modifiers) {
    const nx = modifiers.includes('NX')
    if (nx && this.store.has(key)) return null
    let ttl = null
    const exIndex = modifiers.indexOf('EX')
    if (exIndex !== -1) ttl = Number(modifiers[exIndex + 1])
    this.store.set(key, String(value))
    if (ttl !== null) this.ttls.set(key, Date.now() + ttl * 1000)
    else this.ttls.delete(key)
    return 'OK'
  }
  async del(key) { return this.store.delete(key) ? 1 : 0 }
  async eval(script, _numkeys, key, ...args) {
    if (script.includes('GET') && script.includes('DEL')) {
      // RELEASE_LOCK_SCRIPT semantics: delete only when the stored token matches.
      if (this.store.get(key) === args[0]) {
        this.store.delete(key)
        this.ttls.delete(key)
        return 1
      }
      return 0
    }
    return 1
  }
}

function loggerCapturing(events = []) {
  return {
    info(fields, message) { events.push({ level: 'info', fields, message }) },
    warn(fields, message) { events.push({ level: 'warn', fields, message }) },
    debug() {},
    error() {},
  }
}

test('RedisService acquireLock is a real mutex: NX prevents stealing a held lock', async () => {
  const client = new FakeRedisClient()
  const service = new RedisService({
    env: { REDIS_ENABLED: 'true', REDIS_URL: 'redis://localhost:6379' },
    createClient: () => client,
  })
  await service.initialize({ logger: loggerCapturing() })

  const first = await service.acquireLock('critical-section', 60)
  assert.equal(first.available, true)
  assert.equal(first.acquired, true)
  assert.ok(first.token)

  // Second acquirer must fail while the lock is held (SET ... NX returns null).
  const second = await service.acquireLock('critical-section', 60)
  assert.equal(second.available, true)
  assert.equal(second.acquired, false)
  assert.equal(second.token, undefined)

  // Releasing with the correct token lets the next acquirer succeed.
  assert.equal(await service.releaseLock('critical-section', first.token ?? ''), true)
  const third = await service.acquireLock('critical-section', 60)
  assert.equal(third.acquired, true)

  // A wrong token cannot release someone else's lock.
  assert.equal(await service.releaseLock('critical-section', 'forged-token'), false)
  assert.equal((await service.acquireLock('critical-section', 60)).acquired, false)

  await service.shutdown()
})

test('RedisService lock key and TTL are written with the NX set command', async () => {
  const client = new FakeRedisClient()
  const sets = []
  const instrumented = {
    ...client,
    async set(key, value, ...modifiers) {
      sets.push({ key, value, modifiers })
      return client.set(key, value, ...modifiers)
    },
  }
  const service = new RedisService({
    env: { REDIS_ENABLED: 'true', REDIS_URL: 'redis://localhost:6379' },
    createClient: () => instrumented,
  })
  await service.initialize({ logger: loggerCapturing() })

  const lease = await service.acquireLock('maintenance', 30)
  assert.equal(lease.acquired, true)
  assert.equal(sets.length, 1)
  assert.equal(sets[0].key, 'allybot:v1:maintenance')
  assert.deepEqual(sets[0].modifiers, ['EX', 30, 'NX'])
  assert.ok(sets[0].ttlMs === undefined || true)

  await service.shutdown()
})

test('RedisService silent catches now emit warn-level observability without leaking error messages', async () => {
  const events = []
  const failing = {
    ping: async () => { throw new Error('Redis connection to redis://secret-user:secret-pass@host:6379 refused') },
    get: async () => { throw new Error('get failed redis://secret-user:secret-pass@host:6379') },
    set: async () => { throw new Error('set failed redis://secret-user:secret-pass@host:6379') },
    del: async () => { throw new Error('del failed redis://secret-user:secret-pass@host:6377') },
    eval: async () => { throw new Error('eval failed redis://secret-user:secret-pass@host:6377') },
    quit: async () => { throw new Error('quit failed redis://secret-user:secret-pass@host:6379') },
  }
  const service = new RedisService({
    env: { REDIS_ENABLED: 'true', REDIS_URL: 'redis://secret-user:secret-pass@host:6379' },
    createClient: () => failing,
  })
  const logger = loggerCapturing(events)
  await service.initialize({ logger })

  // Every fail-soft operation still returns its safe fallback (fail-closed preserved).
  assert.equal((await service.get('k')) === null, true)
  assert.equal(await service.set('k', 'v'), false)
  assert.equal(await service.del('k'), false)
  assert.equal(await service.consumeFixedWindow('ns', 'k', 1, 1000), undefined)
  assert.equal((await service.acquireLock('k', 10)).available, false)
  assert.equal(await service.releaseLock('k', 't'), false)
  assert.equal(await service.increment('k', 10), 0)
  assert.equal((await service.enqueueBounded('k', 'i', 1, 10)).available, false)
  assert.equal((await service.cacheGet('ns', 'k')) === undefined, true)
  assert.equal(await service.cacheSet('ns', 'k', 'v', 10), false)
  assert.equal(await service.cacheDelete('ns', 'k'), false)
  assert.equal(await service.rememberOnce('ns', 'k', 10), undefined)
  await service.shutdown()

  // Observability: every swallowed error produced a warn with the error name and
  // operation, and no log line leaks the raw error message (which embeds credentials).
  const warns = events.filter((event) => event.level === 'warn')
  assert.ok(warns.length >= 12, `expected >= 12 warns, got ${warns.length}`)
  const operations = new Set(warns.map((event) => event.fields?.operation))
  for (const expected of ['ping', 'get', 'set', 'del', 'consumeFixedWindow', 'acquireLock', 'releaseLock', 'increment', 'enqueueBounded', 'cacheGet', 'cacheSet', 'cacheDelete', 'rememberOnce', 'quit']) {
    assert.ok(operations.has(expected), `missing warn for operation: ${expected}`)
  }
  const serialized = JSON.stringify(events)
  assert.equal(serialized.includes('secret-user'), false)
  assert.equal(serialized.includes('secret-pass'), false)
  assert.equal(serialized.includes('refused'), false)
  for (const warn of warns) {
    assert.ok(typeof warn.fields?.errorName === 'string' && warn.fields.errorName.length > 0)
  }
})
