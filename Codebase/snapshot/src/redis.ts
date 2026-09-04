import { Redis as IORedis, type RedisOptions } from 'ioredis'
import { randomUUID } from 'node:crypto'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from './framework/contracts.js'

export type RedisHealthStatus = 'disabled' | 'healthy' | 'unhealthy'
export type RedisHealthError = 'timeout' | 'unavailable' | 'unexpected-response'

export interface RedisConfig {
  readonly url: string
  readonly timeoutMs: number
  readonly operationTimeoutMs: number
  readonly maxAttempts: number
  readonly retryDelayMs: number
  readonly keyPrefix: string
}

export interface RedisHealth {
  readonly status: RedisHealthStatus
  readonly checkedAt: string
  readonly attempts: number
  readonly error?: RedisHealthError
}

export interface RedisRateDecision {
  readonly allowed: boolean
  readonly count: number
  readonly limit: number
  readonly resetAt: number
}

export interface RedisLockLease {
  readonly available: boolean
  readonly acquired: boolean
  readonly token?: string
}

export interface RedisQueueResult {
  readonly available: boolean
  readonly accepted: boolean
  readonly droppedOldest: boolean
}

export interface RedisClientInterface {
  ping(): Promise<string>
  get(key: string): Promise<string | null>
  set(key: string, value: string | number | Buffer, ...args: any[]): Promise<'OK' | null | any>
  del(key: string): Promise<number>
  incr(key: string): Promise<number>
  expire(key: string, seconds: number): Promise<number>
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>
  rpush(key: string, ...values: string[]): Promise<number>
  lpop(key: string): Promise<string | null>
  quit?(): Promise<string>
  disconnect?(): void
}

export interface RedisServiceOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly createClient?: (config: RedisConfig) => RedisClientInterface
  readonly sleep?: (delayMs: number) => Promise<void>
  readonly clock?: () => number
}

const RATE_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return { current, redis.call('PTTL', KEYS[1]) }
`

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end
`

const COUNTER_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return current
`

const ENQUEUE_SCRIPT = `
local length = redis.call('RPUSH', KEYS[1], ARGV[1])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[2]), -1)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return length
`

export function readRedisConfig(env: NodeJS.ProcessEnv = process.env): RedisConfig | undefined {
  const enabled = env.REDIS_ENABLED === 'true'
  const url = env.REDIS_URL?.trim()
  if (!enabled && !url) return undefined
  if (enabled && !url) throw new Error('REDIS_URL is required when REDIS_ENABLED=true')
  if (!url) return undefined

  return {
    url,
    timeoutMs: Number(env.REDIS_TIMEOUT_MS) || 5_000,
    operationTimeoutMs: Number(env.REDIS_OPERATION_TIMEOUT_MS) || 1_000,
    maxAttempts: Number(env.REDIS_MAX_ATTEMPTS) || 2,
    retryDelayMs: Number(env.REDIS_RETRY_DELAY_MS) || 100,
    keyPrefix: env.REDIS_KEY_PREFIX?.trim() || 'allybot:v1',
  }
}

export class RedisService implements Service {
  readonly name = 'redis'
  readonly id = 'redis'
  private readonly config?: RedisConfig
  private readonly createClientHook?: (config: RedisConfig) => RedisClientInterface
  private readonly sleepHook: (delayMs: number) => Promise<void>
  private readonly clock: () => number
  private client?: RedisClientInterface
  private logger?: Logger
  private lastHealth: RedisHealth = {
    status: 'disabled',
    checkedAt: new Date(0).toISOString(),
    attempts: 0,
  }

  constructor(options: RedisServiceOptions = {}) {
    const env = options.env ?? process.env
    this.config = readRedisConfig(env)
    this.createClientHook = options.createClient
    this.sleepHook = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.clock = options.clock ?? (() => Date.now())
  }

  async start(context: ServiceContext): Promise<void> {
    this.logger = context.logger
    if (!this.config) {
      this.lastHealth = {
        status: 'disabled',
        checkedAt: new Date(this.clock()).toISOString(),
        attempts: 0,
      }
      return
    }

    this.client = this.createClientHook
      ? this.createClientHook(this.config)
      : new IORedis(this.config.url, {
          connectTimeout: this.config.timeoutMs,
          maxRetriesPerRequest: this.config.maxAttempts,
          lazyConnect: true,
        })

    await this.healthCheck()
  }

  async stop(): Promise<void> {
    if (this.client) {
      if (typeof this.client.quit === 'function') {
        await this.client.quit().catch(() => {})
      } else if (typeof this.client.disconnect === 'function') {
        this.client.disconnect()
      }
      this.client = undefined
    }
  }

  getHealth(): RedisHealth {
    return this.lastHealth
  }

  isEnabled(): boolean {
    return Boolean(this.config)
  }

  private prefixedKey(key: string): string {
    const prefix = this.config?.keyPrefix ?? 'allybot:v1'
    return `${prefix}:${key}`
  }

  async healthCheck(): Promise<RedisHealth> {
    if (!this.config || !this.client) {
      this.lastHealth = {
        status: 'disabled',
        checkedAt: new Date(this.clock()).toISOString(),
        attempts: 0,
      }
      return this.lastHealth
    }

    try {
      const pong = await this.client.ping()
      if (pong.toUpperCase() === 'PONG') {
        this.lastHealth = {
          status: 'healthy',
          checkedAt: new Date(this.clock()).toISOString(),
          attempts: 1,
        }
      } else {
        this.lastHealth = {
          status: 'unhealthy',
          checkedAt: new Date(this.clock()).toISOString(),
          attempts: 1,
          error: 'unexpected-response',
        }
      }
    } catch {
      this.lastHealth = {
        status: 'unhealthy',
        checkedAt: new Date(this.clock()).toISOString(),
        attempts: 1,
        error: 'unavailable',
      }
    }
    return this.lastHealth
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.client) return null
    try {
      const val = await this.client.get(this.prefixedKey(key))
      if (val === null) return null
      return JSON.parse(val) as T
    } catch {
      return null
    }
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean> {
    if (!this.client) return false
    try {
      const payload = JSON.stringify(value)
      if (ttlSeconds && ttlSeconds > 0) {
        await this.client.set(this.prefixedKey(key), payload, 'EX', ttlSeconds)
      } else {
        await this.client.set(this.prefixedKey(key), payload)
      }
      return true
    } catch {
      return false
    }
  }

  async del(key: string): Promise<boolean> {
    if (!this.client) return false
    try {
      const count = await this.client.del(this.prefixedKey(key))
      return count > 0
    } catch {
      return false
    }
  }

  async consumeRateWindow(key: string, limit: number, windowMs: number): Promise<RedisRateDecision> {
    const fallbackReset = this.clock() + windowMs
    if (!this.client) {
      return { allowed: true, count: 1, limit, resetAt: fallbackReset }
    }

    try {
      const result = (await this.client.eval(
        RATE_WINDOW_SCRIPT,
        1,
        this.prefixedKey(key),
        windowMs.toString(),
      )) as [number, number]

      const count = Number(result[0]) || 1
      const pttl = Number(result[1]) || windowMs
      return {
        allowed: count <= limit,
        count,
        limit,
        resetAt: this.clock() + Math.max(0, pttl),
      }
    } catch {
      return { allowed: true, count: 1, limit, resetAt: fallbackReset }
    }
  }

  async consumeFixedWindow(namespace: string, key: string, limit: number, windowMs: number, _now = this.clock()): Promise<RedisRateDecision> {
    return this.consumeRateWindow(`${namespace}:${key}`, limit, windowMs)
  }

  async acquireLock(key: string, ttlSeconds: number): Promise<RedisLockLease> {
    if (!this.client) return { available: false, acquired: false }
    const token = randomUUID()
    try {
      const ok = await this.client.set(this.prefixedKey(key), token, 'EX', ttlSeconds)
      return {
        available: true,
        acquired: Boolean(ok),
        ...(ok ? { token } : {}),
      }
    } catch {
      return { available: false, acquired: false }
    }
  }

  async releaseLock(key: string, token: string): Promise<boolean> {
    if (!this.client) return false
    try {
      const result = await this.client.eval(RELEASE_LOCK_SCRIPT, 1, this.prefixedKey(key), token)
      return Number(result) === 1
    } catch {
      return false
    }
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    if (!this.client) return 0
    try {
      const result = await this.client.eval(COUNTER_SCRIPT, 1, this.prefixedKey(key), ttlSeconds.toString())
      return Number(result) || 0
    } catch {
      return 0
    }
  }

  async enqueueBounded<T>(key: string, item: T, maxItems: number, ttlSeconds: number): Promise<RedisQueueResult> {
    if (!this.client) return { available: false, accepted: false, droppedOldest: false }
    try {
      const payload = JSON.stringify(item)
      const length = (await this.client.eval(
        ENQUEUE_SCRIPT,
        1,
        this.prefixedKey(key),
        payload,
        maxItems.toString(),
        ttlSeconds.toString(),
      )) as number
      return {
        available: true,
        accepted: true,
        droppedOldest: Number(length) > maxItems,
      }
    } catch {
      return { available: false, accepted: false, droppedOldest: false }
    }
  }

  async cacheGet<T>(namespace: string, key: string): Promise<T | undefined> {
    if (!this.client) return undefined
    try {
      const raw = await this.client.get(this.prefixedKey(`${namespace}:${key}`))
      if (!raw) return undefined
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }

  async cacheSet<T>(namespace: string, key: string, value: T, ttlSeconds: number): Promise<boolean> {
    if (!this.client) return false
    try {
      const serialized = JSON.stringify(value)
      await this.client.set(this.prefixedKey(`${namespace}:${key}`), serialized, 'EX', ttlSeconds)
      return true
    } catch {
      return false
    }
  }

  async rememberOnce(namespace: string, key: string, ttlSeconds: number): Promise<boolean | undefined> {
    if (!this.client) return undefined
    try {
      const res = await this.client.set(this.prefixedKey(`${namespace}:${key}`), '1', 'EX', ttlSeconds, 'NX')
      return res === 'OK'
    } catch {
      return undefined
    }
  }
}
