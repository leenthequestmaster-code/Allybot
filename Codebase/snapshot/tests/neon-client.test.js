import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createNeonClient,
  NeonClientService,
  readNeonClientConfig,
  redactNeonError,
} from '../dist/neon-client.js'

const logger = {
  info() {},
}

test('Neon client is disabled by default', () => {
  assert.equal(readNeonClientConfig({}), undefined)
  assert.equal(readNeonClientConfig({ NEON_ENABLED: 'false', NEON_DATABASE_URL: 'postgresql://ignored' }), undefined)
})

test('Neon client requires a URL when enabled', () => {
  assert.throws(
    () => readNeonClientConfig({ NEON_ENABLED: 'true' }),
    /NEON_DATABASE_URL is required/,
  )
})

test('Neon client validates URL and pool mode', () => {
  assert.throws(
    () => readNeonClientConfig({ NEON_ENABLED: 'true', NEON_DATABASE_URL: 'https://not-postgres' }),
    /NEON_DATABASE_URL must use postgres/,
  )
  assert.throws(
    () => readNeonClientConfig({
      NEON_ENABLED: 'true',
      NEON_DATABASE_URL: 'postgresql://db.example.test/db',
      NEON_POOL_MODE: 'session',
    }),
    /NEON_POOL_MODE must be direct or transaction/,
  )
})

test('Neon client defaults to transaction mode and redacts URI errors', async () => {
  const config = readNeonClientConfig({
    NEON_ENABLED: 'true',
    NEON_DATABASE_URL: 'postgresql://db.example.test/db?sslmode=require',
  })
  assert.deepEqual(config, {
    url: 'postgresql://db.example.test/db?sslmode=require',
    poolMode: 'transaction',
    statementTimeoutMs: 10_000,
  })
  assert.equal(redactNeonError(new Error('failed at postgresql://db.example.test/db password=secret')), 'failed at postgresql://*** password=***')

  const client = createNeonClient(config)
  await client.end({ timeout: 1 })
})

test('Neon service initializes and shuts down independently', async () => {
  const service = new NeonClientService(logger, {
    NEON_ENABLED: 'true',
    NEON_DATABASE_URL: 'postgresql://db.example.test/db',
    NEON_POOL_MODE: 'direct',
  })
  service.initialize({})
  assert.equal(service.isEnabled, true)
  assert.equal(typeof service.getClient, 'function')
  await service.shutdown({})
  assert.equal(service.isEnabled, false)
})
