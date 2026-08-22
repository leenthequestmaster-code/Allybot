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
