import 'dotenv/config'
import { UpstashRedisService } from '../dist/upstash-redis.js'

const logger = {
  info() {},
  warn() {},
}

const service = new UpstashRedisService(logger)
try {
  service.initialize({})
  const result = await service.checkHealth()
  if (result.status === 'disabled') {
    console.log('UPSTASH_REDIS_VERIFY=DISABLED')
  } else if (result.status === 'healthy') {
    console.log(`UPSTASH_REDIS_VERIFY=PASS (attempts=${result.attempts})`)
  } else {
    console.error(`UPSTASH_REDIS_VERIFY=FAIL (error=${result.error ?? 'unavailable'})`)
    process.exitCode = 1
  }
} catch {
  console.error('UPSTASH_REDIS_VERIFY=FAIL (configuration-or-client-error)')
  process.exitCode = 1
} finally {
  await service.shutdown()
}
