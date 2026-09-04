import assert from 'node:assert/strict'
import test from 'node:test'
import { MongoService, readMongoConfig } from '../dist/mongodb.js'
import { RedisService, readRedisConfig } from '../dist/redis.js'

test('MongoService readConfig and health status disabled by default', async () => {
  const config = readMongoConfig({})
  assert.equal(config, undefined)

  const service = new MongoService({ env: {} })
  assert.equal(service.isEnabled(), false)
  assert.equal(service.getHealth().status, 'disabled')

  await service.start({ logger: { info() {}, error() {}, debug() {} } })
  assert.equal(service.getHealth().status, 'disabled')
  await service.stop()
})

test('RedisService readConfig and health status disabled by default', async () => {
  const config = readRedisConfig({})
  assert.equal(config, undefined)

  const service = new RedisService({ env: {} })
  assert.equal(service.isEnabled(), false)
  assert.equal(service.getHealth().status, 'disabled')

  await service.start({ logger: { info() {}, error() {}, debug() {} } })
  assert.equal(service.getHealth().status, 'disabled')
  await service.stop()
})

test('RedisService rate limiting and caching fallback gracefully when disabled', async () => {
  const service = new RedisService({ env: {} })
  const decision = await service.consumeRateWindow('test-user', 5, 1000)
  assert.equal(decision.allowed, true)
  assert.equal(decision.count, 1)

  const val = await service.cacheGet('test', 'key')
  assert.equal(val, undefined)

  const saved = await service.cacheSet('test', 'key', { foo: 'bar' }, 60)
  assert.equal(saved, false)

  const dedupe = await service.rememberOnce('test', 'id-1', 60)
  assert.equal(dedupe, undefined)
})
