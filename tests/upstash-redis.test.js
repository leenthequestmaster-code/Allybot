import assert from 'node:assert/strict'
import test from 'node:test'
import {
  UpstashRedisService,
  readUpstashRedisConfig,
} from '../dist/upstash-redis.js'

function loggerFor(events = []) {
  return {
    info(fields, message) {
      events.push({ level: 'info', fields, message })
    },
    warn(fields, message) {
      events.push({ level: 'warn', fields, message })
    },
  }
}

const enabledEnv = {
  UPSTASH_REDIS_ENABLED: 'true',
  UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
  UPSTASH_REDIS_REST_TOKEN: 'token-is-test-only',
}

test('Upstash Redis is disabled by default', () => {
  assert.equal(readUpstashRedisConfig({}), undefined)
  assert.equal(readUpstashRedisConfig({ UPSTASH_REDIS_ENABLED: 'false', UPSTASH_REDIS_REST_TOKEN: 'ignored' }), undefined)
})

test('Upstash Redis requires HTTPS URL and token when enabled', () => {
  assert.throws(
    () => readUpstashRedisConfig({ UPSTASH_REDIS_ENABLED: 'true' }),
    /UPSTASH_REDIS_REST_URL is required/,
  )
  assert.throws(
    () => readUpstashRedisConfig({
      ...enabledEnv,
      UPSTASH_REDIS_REST_URL: 'http://example.upstash.io',
    }),
    /must use https/,
  )
  assert.throws(
    () => readUpstashRedisConfig({
      UPSTASH_REDIS_ENABLED: 'true',
      UPSTASH_REDIS_REST_URL: 'https://example.upstash.io',
    }),
    /UPSTASH_REDIS_REST_TOKEN is required/,
  )
})

test('Upstash Redis validates bounded timeout, attempts, and retry delay', () => {
  assert.throws(
    () => readUpstashRedisConfig({ ...enabledEnv, UPSTASH_REDIS_TIMEOUT_MS: '999' }),
    /UPSTASH_REDIS_TIMEOUT_MS must be between 1000 and 10000/,
  )
  assert.throws(
    () => readUpstashRedisConfig({ ...enabledEnv, UPSTASH_REDIS_MAX_ATTEMPTS: '4' }),
    /UPSTASH_REDIS_MAX_ATTEMPTS must be between 1 and 3/,
  )
  assert.throws(
    () => readUpstashRedisConfig({ ...enabledEnv, UPSTASH_REDIS_RETRY_DELAY_MS: '49' }),
    /UPSTASH_REDIS_RETRY_DELAY_MS must be between 50 and 2000/,
  )
})

test('Upstash Redis health-check reports healthy without exposing configuration', async () => {
  const events = []
  const service = new UpstashRedisService(loggerFor(events), {
    env: enabledEnv,
    clock: () => 1_700_000_000_000,
    createClient: (_config, signal) => ({
      async ping() {
        assert.equal(signal.aborted, false)
        return 'PONG'
      },
    }),
  })
  service.initialize({})

  assert.equal(service.isEnabled, true)
  assert.deepEqual(await service.checkHealth(), {
    status: 'healthy',
    checkedAt: '2023-11-14T22:13:20.000Z',
    attempts: 1,
  })
  assert.equal(JSON.stringify(events).includes('token-is-test-only'), false)
  assert.equal(JSON.stringify(events).includes('example.upstash.io'), false)

  await service.shutdown({})
  assert.equal(service.isEnabled, false)
  assert.equal(service.getHealth().status, 'disabled')
})

test('Upstash Redis retries only within configured bounded attempts', async () => {
  let attempts = 0
  const sleeps = []
  const service = new UpstashRedisService(loggerFor(), {
    env: { ...enabledEnv, UPSTASH_REDIS_MAX_ATTEMPTS: '3', UPSTASH_REDIS_RETRY_DELAY_MS: '50' },
    clock: () => 0,
    createClient: () => ({
      async ping() {
        attempts += 1
        throw new Error('synthetic outage')
      },
    }),
    sleep: async (delayMs) => sleeps.push(delayMs),
  })
  service.initialize({})

  assert.deepEqual(await service.checkHealth(), {
    status: 'unhealthy',
    checkedAt: '1970-01-01T00:00:00.000Z',
    attempts: 3,
    error: 'unavailable',
  })
  assert.equal(attempts, 3)
  assert.deepEqual(sleeps, [50, 100])
})

test('Upstash Redis classifies an aborted health-check as timeout', async () => {
  const service = new UpstashRedisService(loggerFor(), {
    env: { ...enabledEnv, UPSTASH_REDIS_TIMEOUT_MS: '1000', UPSTASH_REDIS_MAX_ATTEMPTS: '1' },
    clock: () => 0,
    createClient: (_config, signal) => ({
      async ping() {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
        })
      },
    }),
  })
  service.initialize({})

  assert.deepEqual(await service.checkHealth(), {
    status: 'unhealthy',
    checkedAt: '1970-01-01T00:00:00.000Z',
    attempts: 1,
    error: 'timeout',
  })
})

test('Upstash Redis operational primitives are namespaced, bounded, and atomic by contract', async () => {
  const values = new Map()
  const expiries = new Map()
  const lists = new Map()
  const fakeRedis = {
    async ping() { return 'PONG' },
    async get(key) { return values.get(key) ?? null },
    async set(key, value, options = {}) {
      if (options.nx && values.has(key)) return null
      values.set(key, value)
      if (options.ex) expiries.set(key, options.ex)
      return 'OK'
    },
    async del(key) { return values.delete(key) ? 1 : 0 },
    async incr(key) {
      const next = Number(values.get(key) ?? 0) + 1
      values.set(key, next)
      return next
    },
    async expire(key, seconds) { expiries.set(key, seconds); return 1 },
    async eval(script, keys, args) {
      const key = keys[0]
      if (script.includes('INCR')) {
        const count = Number(values.get(key) ?? 0) + 1
        values.set(key, count)
        if (script.includes('PEXPIRE')) return [count, Number(args[0])]
        return count
      }
      if (script.includes('GET') && script.includes('ARGV[1]')) {
        if (values.get(key) === args[0]) {
          values.delete(key)
          return 1
        }
        return 0
      }
      if (script.includes('RPUSH')) {
        const list = lists.get(key) ?? []
        list.push(args[0])
        lists.set(key, list.slice(-Number(args[1])))
        return list.length
      }
      throw new Error('unsupported synthetic script')
    },
    async lpop(key) {
      const list = lists.get(key) ?? []
      const value = list.shift() ?? null
      lists.set(key, list)
      return value
    },
  }
  const service = new UpstashRedisService(loggerFor(), {
    env: enabledEnv,
    createClient: () => fakeRedis,
    clock: () => 1_700_000_000_000,
  })
  service.initialize({})

  assert.equal(await service.cacheSet('group-name', '120363@g.us', 'Test Group', 300), true)
  assert.equal(await service.cacheGet('group-name', '120363@g.us'), 'Test Group')
  assert.equal([...values.keys()].every((key) => key.startsWith('allybot:v1:group-name:')), true)

  assert.equal(await service.rememberOnce('message-dedupe', 'same-event', 600), true)
  assert.equal(await service.rememberOnce('message-dedupe', 'same-event', 600), false)

  assert.deepEqual(await service.consumeFixedWindow('rate', 'actor', 2, 10_000, 1_700_000_000_001), {
    allowed: true,
    count: 1,
    limit: 2,
    resetAt: 1_700_000_010_000,
  })
  assert.equal((await service.consumeFixedWindow('rate', 'actor', 2, 10_000, 1_700_000_000_001)).allowed, true)
  assert.equal((await service.consumeFixedWindow('rate', 'actor', 2, 10_000, 1_700_000_000_001)).allowed, false)

  assert.equal(await service.incrementCounter('metric', 'events', 60), 1)
  assert.equal(await service.incrementCounter('metric', 'events', 60), 2)
  assert.equal(expiries.size > 0, true)

  const firstLease = await service.acquireLock('job', 'single', 30)
  assert.equal(firstLease.available, true)
  assert.equal(firstLease.acquired, true)
  assert.equal((await service.acquireLock('job', 'single', 30)).acquired, false)
  assert.equal(await service.releaseLock('job', 'single', firstLease.token), true)

  assert.equal((await service.enqueueBounded('queue', 'work', 'one', 2, 60)).accepted, true)
  assert.equal((await service.enqueueBounded('queue', 'work', 'two', 2, 60)).droppedOldest, false)
  assert.equal((await service.enqueueBounded('queue', 'work', 'three', 2, 60)).droppedOldest, true)
  assert.equal(await service.dequeue('queue', 'work'), 'two')
})

test('Upstash Redis operation failure degrades to undefined instead of blocking callers', async () => {
  const events = []
  const service = new UpstashRedisService(loggerFor(events), {
    env: { ...enabledEnv, UPSTASH_REDIS_MAX_ATTEMPTS: '1' },
    clock: () => 0,
    createClient: () => ({
      async ping() { return 'PONG' },
      async get() { throw new Error('synthetic network outage') },
    }),
  })
  service.initialize({})

  assert.equal(await service.cacheGet('group-name', 'group'), undefined)
  assert.equal(events.some((event) => event.fields.errorClass === 'unavailable'), true)
})

test('Upstash Redis rejects credential-bearing URLs and unsafe identities', () => {
  assert.throws(
    () => readUpstashRedisConfig({ ...enabledEnv, UPSTASH_REDIS_REST_URL: 'https://user:password@example.upstash.io' }),
    /must not include credentials/,
  )
  assert.throws(
    () => readUpstashRedisConfig({ ...enabledEnv, UPSTASH_REDIS_KEY_PREFIX: 'unsafe prefix' }),
    /Redis scope is invalid/,
  )
})

test('Upstash Redis dedupe and rate limit remain correct under concurrent calls', async () => {
  const values = new Map()
  const service = new UpstashRedisService(loggerFor(), {
    env: { ...enabledEnv, UPSTASH_REDIS_OPERATION_TIMEOUT_MS: '100' },
    createClient: () => ({
      async ping() { return 'PONG' },
      async set(key, value, options = {}) {
        if (options.nx && values.has(key)) return null
        values.set(key, value)
        return 'OK'
      },
      async eval(script, keys) {
        const current = Number(values.get(keys[0]) ?? 0) + 1
        values.set(keys[0], current)
        if (script.includes('INCR') && script.includes('PEXPIRE')) return [current, 10_000]
        if (script.includes('INCR') && script.includes('EXPIRE')) return current
        if (script.includes('GET')) return 0
        return current
      },
    }),
  })
  service.initialize({})

  const dedupe = await Promise.all(Array.from({ length: 10 }, () => service.rememberOnce('dedupe', 'same', 10)))
  assert.equal(dedupe.filter(Boolean).length, 1)
  const decisions = await Promise.all(Array.from({ length: 5 }, () => service.consumeFixedWindow('limit', 'same', 2, 10_000, 1_700_000_000_001)))
  assert.equal(decisions.filter((decision) => decision?.allowed).length, 2)
  assert.equal(decisions.filter((decision) => decision && !decision.allowed).length, 3)
})

test('Upstash Redis operation timeout aborts the request and falls back', async () => {
  const service = new UpstashRedisService(loggerFor(), {
    env: { ...enabledEnv, UPSTASH_REDIS_OPERATION_TIMEOUT_MS: '100', UPSTASH_REDIS_MAX_ATTEMPTS: '1' },
    createClient: (_config, signal) => ({
      async ping() { return 'PONG' },
      async get() {
        return new Promise((_, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
        })
      },
    }),
  })
  service.initialize({})
  assert.equal(await service.cacheGet('group-name', 'slow'), undefined)
})

test('Upstash Redis lock release requires the owner token', async () => {
  let token
  const values = new Map()
  const service = new UpstashRedisService(loggerFor(), {
    env: enabledEnv,
    createClient: () => ({
      async ping() { return 'PONG' },
      async set(key, value, options = {}) {
        if (options.nx && values.has(key)) return null
        values.set(key, value)
        token = value
        return 'OK'
      },
      async eval(_script, keys, args) {
        if (values.get(keys[0]) === args[0]) {
          values.delete(keys[0])
          return 1
        }
        return 0
      },
    }),
  })
  service.initialize({})
  const lease = await service.acquireLock('job', 'owner-check', 30)
  assert.equal(await service.releaseLock('job', 'owner-check', 'wrong-token'), false)
  assert.equal(await service.releaseLock('job', 'owner-check', lease.token), true)
  assert.equal(values.size >= 0, true)
  assert.equal(typeof token, 'string')
})
