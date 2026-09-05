import assert from 'node:assert/strict'
import test from 'node:test'
import { MongoService, readMongoConfig } from '../dist/mongodb.js'
import { RedisService, readRedisConfig } from '../dist/redis.js'

test('MongoService readConfig and health status disabled by default', async () => {
  const config = readMongoConfig({})
  assert.equal(config, undefined)

  const service = new MongoService({ env: {} })
  assert.equal(service.isEnabled, false)
  assert.equal(service.getHealth().status, 'disabled')

  await service.initialize({ logger: { info() {}, error() {}, debug() {} } })
  assert.equal(service.getHealth().status, 'disabled')
  await service.shutdown()
})

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
