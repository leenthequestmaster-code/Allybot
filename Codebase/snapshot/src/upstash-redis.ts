import { randomUUID, createHash } from 'node:crypto'
import { Redis } from '@upstash/redis'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from './framework/contracts.js'

export type UpstashRedisHealthStatus = 'disabled' | 'healthy' | 'unhealthy'
export type UpstashRedisHealthError = 'timeout' | 'unavailable' | 'unexpected-response'
export type UpstashRedisOperationError = 'timeout' | 'unavailable'

export interface UpstashRedisConfig {
  readonly url: string
  readonly token: string
  readonly timeoutMs: number
  readonly operationTimeoutMs: number
  readonly maxAttempts: number
  readonly retryDelayMs: number
  readonly keyPrefix: string
}

export interface UpstashRedisHealth {
  readonly status: UpstashRedisHealthStatus
  readonly checkedAt: string
  readonly attempts: number
  readonly error?: UpstashRedisHealthError
}

export interface UpstashRedisProbeClient {
  ping(): Promise<string>
}

interface UpstashRedisOperationalClient extends UpstashRedisProbeClient {
  get?<TData>(key: string): Promise<TData | null>
  set?<TData>(key: string, value: TData, options?: { ex?: number; nx?: boolean }): Promise<unknown>
  del?(key: string): Promise<number>
  incr?(key: string): Promise<number>
  expire?(key: string, seconds: number): Promise<number>
  eval?<TData>(script: string, keys: string[], args: unknown[]): Promise<TData>
  rpush?(key: string, ...values: string[]): Promise<number>
  lpop?<TData>(key: string): Promise<TData | null>
}

export interface UpstashRedisServiceOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly createClient?: (config: UpstashRedisConfig, signal: AbortSignal) => UpstashRedisOperationalClient
  readonly sleep?: (delayMs: number) => Promise<void>
  readonly clock?: () => number
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

const UPSTASH_URL_PATTERN = /^https:\/\//i
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_RETRY_DELAY_MS = 100
const MAX_CACHE_VALUE_LENGTH = 8_192
const DEFAULT_KEY_PREFIX = 'allybot:v1'
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

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return parsed
}

function hashIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function validateScope(scope: string): void {
  if (!/^[a-z0-9][a-z0-9:_-]{0,39}$/i.test(scope)) throw new Error('Redis scope is invalid')
}

function validatePositiveBound(value: number, name: string, max: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} must be between 1 and ${max}`)
}

export function readUpstashRedisConfig(env: NodeJS.ProcessEnv = process.env): UpstashRedisConfig | undefined {
  const enabled = env.UPSTASH_REDIS_ENABLED?.trim().toLowerCase() === 'true'
  if (!enabled) return undefined

  const url = env.UPSTASH_REDIS_REST_URL?.trim()
  if (!url) throw new Error('UPSTASH_REDIS_REST_URL is required when UPSTASH_REDIS_ENABLED=true')
  if (!UPSTASH_URL_PATTERN.test(url)) throw new Error('UPSTASH_REDIS_REST_URL must use https://')
  const parsedUrl = new URL(url)
  if (parsedUrl.username || parsedUrl.password) throw new Error('UPSTASH_REDIS_REST_URL must not include credentials')

  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim()
  if (!token) throw new Error('UPSTASH_REDIS_REST_TOKEN is required when UPSTASH_REDIS_ENABLED=true')
  const keyPrefix = env.UPSTASH_REDIS_KEY_PREFIX?.trim() || DEFAULT_KEY_PREFIX
  validateScope(keyPrefix)

  return {
    url,
    token,
    timeoutMs: boundedInteger(env.UPSTASH_REDIS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 10_000, 'UPSTASH_REDIS_TIMEOUT_MS'),
    operationTimeoutMs: boundedInteger(env.UPSTASH_REDIS_OPERATION_TIMEOUT_MS, 1_000, 100, 2_000, 'UPSTASH_REDIS_OPERATION_TIMEOUT_MS'),
    maxAttempts: boundedInteger(env.UPSTASH_REDIS_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, 3, 'UPSTASH_REDIS_MAX_ATTEMPTS'),
    retryDelayMs: boundedInteger(env.UPSTASH_REDIS_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS, 50, 2_000, 'UPSTASH_REDIS_RETRY_DELAY_MS'),
    keyPrefix,
  }
}

export function createUpstashRedisClient(config: UpstashRedisConfig, signal: AbortSignal): UpstashRedisOperationalClient {
  return new Redis({
    url: config.url,
    token: config.token,
    signal,
    retry: false,
    enableTelemetry: false,
    keepAlive: true,
  }) as unknown as UpstashRedisOperationalClient
}

export class UpstashRedisService implements Service {
  readonly name = 'upstash-redis'

  private readonly env: NodeJS.ProcessEnv
  private readonly createClient: (config: UpstashRedisConfig, signal: AbortSignal) => UpstashRedisOperationalClient
  private readonly sleep: (delayMs: number) => Promise<void>
  private readonly clock: () => number
  private config: UpstashRedisConfig | undefined
  private health: UpstashRedisHealth = { status: 'disabled', checkedAt: new Date(0).toISOString(), attempts: 0 }

  constructor(
    private readonly logger: Logger,
    options: UpstashRedisServiceOptions = {},
  ) {
    this.env = options.env ?? process.env
    this.createClient = options.createClient ?? createUpstashRedisClient
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
    this.clock = options.clock ?? (() => Date.now())
  }

  initialize(_context: ServiceContext): void {
    this.config = readUpstashRedisConfig(this.env)
    this.health = { status: this.config ? 'unhealthy' : 'disabled', checkedAt: new Date(this.clock()).toISOString(), attempts: 0 }
    if (this.config) this.logger.info({ transport: 'https-rest' }, 'Upstash Redis service initialized')
  }

  async checkHealth(): Promise<UpstashRedisHealth> {
    const config = this.config
    if (!config) {
      this.health = { status: 'disabled', checkedAt: new Date(this.clock()).toISOString(), attempts: 0 }
      return this.health
    }

    let lastError: UpstashRedisHealthError = 'unavailable'
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      const controller = new AbortController()
      try {
        const result = await withTimeout(this.createClient(config, controller.signal).ping(), config.timeoutMs, controller)
        if (result !== 'PONG') throw new UnexpectedRedisResponseError()
        this.health = { status: 'healthy', checkedAt: new Date(this.clock()).toISOString(), attempts: attempt }
        this.logger.info({ attempts: attempt }, 'Upstash Redis health-check passed')
        return this.health
      } catch (error) {
        lastError = classifyHealthError(error)
        this.logger.warn({ attempt, maxAttempts: config.maxAttempts, errorClass: lastError }, 'Upstash Redis health-check failed')
        if (attempt < config.maxAttempts) await this.sleep(config.retryDelayMs * attempt)
      } finally {
        controller.abort()
      }
    }

    this.health = {
      status: 'unhealthy',
      checkedAt: new Date(this.clock()).toISOString(),
      attempts: config.maxAttempts,
      error: lastError,
    }
    return this.health
  }

  get isEnabled(): boolean {
    return this.config !== undefined
  }

  getHealth(): UpstashRedisHealth {
    return this.health
  }

  async cacheGet<TData>(scope: string, identity: string): Promise<TData | undefined> {
    const client = this.requireClientMethod('get')
    const key = this.key(scope, identity)
    return this.execute('cache_get', client, async (redis) => redis.get ? redis.get<TData>(key) : undefined).then((value) => value ?? undefined)
  }

  async cacheSet<TData>(scope: string, identity: string, value: TData, ttlSeconds: number): Promise<boolean> {
    validatePositiveBound(ttlSeconds, 'Redis cache TTL', 86_400)
    const serialized = JSON.stringify(value)
    if (serialized === undefined || serialized.length > MAX_CACHE_VALUE_LENGTH) throw new Error(`Redis cache value exceeds ${MAX_CACHE_VALUE_LENGTH} characters`)
    const client = this.requireClientMethod('set')
    const key = this.key(scope, identity)
    const result = await this.execute('cache_set', client, async (redis) => redis.set ? redis.set(key, value, { ex: ttlSeconds }) : undefined)
    return result !== undefined
  }

  async cacheDelete(scope: string, identity: string): Promise<boolean> {
    const client = this.requireClientMethod('del')
    const result = await this.execute('cache_delete', client, async (redis) => redis.del ? redis.del(this.key(scope, identity)) : undefined)
    return result !== undefined
  }

  async rememberOnce(scope: string, identity: string, ttlSeconds: number): Promise<boolean | undefined> {
    validatePositiveBound(ttlSeconds, 'Redis dedupe TTL', 86_400)
    const client = this.requireClientMethod('set')
    const result = await this.execute('dedupe', client, async (redis) => redis.set ? redis.set(this.key(scope, identity), '1', { ex: ttlSeconds, nx: true }) : undefined)
    if (result === undefined) return undefined
    return result === 'OK'
  }

  async consumeFixedWindow(scope: string, identity: string, limit: number, windowMs: number, now = this.clock()): Promise<RedisRateDecision | undefined> {
    validatePositiveBound(limit, 'Redis rate limit', 1_000_000)
    validatePositiveBound(windowMs, 'Redis rate window', 86_400_000)
    const client = this.requireClientMethod('eval')
    const windowStart = Math.floor(now / windowMs) * windowMs
    const result = await this.execute('rate_limit', client, async (redis) => redis.eval ? redis.eval<unknown>(RATE_WINDOW_SCRIPT, [this.key(scope, `${identity}:${windowStart}`)], [windowMs, limit]) : undefined)
    if (!Array.isArray(result) || result.length < 1) return undefined
    const count = Number(result[0])
    if (!Number.isSafeInteger(count) || count < 1) return undefined
    return { allowed: count <= limit, count, limit, resetAt: windowStart + windowMs }
  }

  async incrementCounter(scope: string, identity: string, ttlSeconds: number): Promise<number | undefined> {
    validatePositiveBound(ttlSeconds, 'Redis counter TTL', 86_400)
    const client = this.requireClientMethod('eval')
    const countValue = await this.execute('counter_increment', client, async (redis) => redis.eval ? redis.eval<unknown>(COUNTER_SCRIPT, [this.key(scope, identity)], [ttlSeconds]) : undefined)
    const count = typeof countValue === 'number' ? countValue : countValue === undefined ? undefined : Number(countValue)
    if (count === undefined) return undefined
    return count
  }

  async acquireLock(scope: string, identity: string, ttlSeconds: number): Promise<RedisLockLease> {
    validatePositiveBound(ttlSeconds, 'Redis lock TTL', 86_400)
    const client = this.requireClientMethod('set')
    const token = randomUUID()
    const result = await this.execute('lock_acquire', client, async (redis) => redis.set ? redis.set(this.key(scope, identity), token, { ex: ttlSeconds, nx: true }) : undefined, 1)
    if (result === undefined) return { available: false, acquired: false }
    return result === 'OK' ? { available: true, acquired: true, token } : { available: true, acquired: false }
  }

  async releaseLock(scope: string, identity: string, token: string): Promise<boolean | undefined> {
    if (!token || token.length > 128) throw new Error('Redis lock token is invalid')
    const client = this.requireClientMethod('eval')
    const result = await this.execute('lock_release', client, async (redis) => redis.eval ? redis.eval<unknown>(RELEASE_LOCK_SCRIPT, [this.key(scope, identity)], [token]) : undefined, 1)
    if (result === undefined) return undefined
    return Number(result) === 1
  }

  async enqueueBounded(scope: string, identity: string, value: string, maxItems: number, ttlSeconds: number): Promise<RedisQueueResult> {
    validatePositiveBound(maxItems, 'Redis queue capacity', 10_000)
    validatePositiveBound(ttlSeconds, 'Redis queue TTL', 86_400)
    if (value.length > 8_192) throw new Error('Redis queue value exceeds 8192 characters')
    const client = this.requireClientMethod('eval')
    const result = await this.execute('queue_enqueue', client, async (redis) => redis.eval ? redis.eval<unknown>(ENQUEUE_SCRIPT, [this.key(scope, identity)], [value, maxItems, ttlSeconds]) : undefined)
    if (result === undefined) return { available: false, accepted: false, droppedOldest: false }
    const length = Number(result)
    return { available: true, accepted: Number.isSafeInteger(length), droppedOldest: Number.isSafeInteger(length) && length > maxItems }
  }

  async dequeue(scope: string, identity: string): Promise<string | undefined> {
    const client = this.requireClientMethod('lpop')
    const result = await this.execute('queue_dequeue', client, async (redis) => redis.lpop ? redis.lpop<string>(this.key(scope, identity)) : undefined)
    return result ?? undefined
  }

  async shutdown(): Promise<void> {
    this.config = undefined
    this.health = { status: 'disabled', checkedAt: new Date(this.clock()).toISOString(), attempts: 0 }
  }

  private key(scope: string, identity: string): string {
    validateScope(scope)
    if (!identity || identity.length > 512) throw new Error('Redis identity is invalid')
    return `${this.config?.keyPrefix ?? DEFAULT_KEY_PREFIX}:${scope}:${hashIdentity(identity)}`
  }

  private requireClientMethod(method: keyof UpstashRedisOperationalClient): keyof UpstashRedisOperationalClient {
    if (!this.config) return method
    return method
  }

  private async execute<TData>(
    operation: string,
    _method: keyof UpstashRedisOperationalClient,
    callback: (client: UpstashRedisOperationalClient) => Promise<TData | undefined>,
    maxAttempts?: number,
  ): Promise<TData | undefined> {
    const config = this.config
    if (!config) return undefined
    const attempts = maxAttempts ?? 1
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController()
      try {
        const result = await withTimeout(callback(this.createClient(config, controller.signal)), config.operationTimeoutMs, controller)
        if (result === undefined) throw new Error(`Redis operation ${operation} is unsupported`)
        return result
      } catch (error) {
        this.logger.warn({ operation, attempt, maxAttempts: attempts, errorClass: classifyOperationError(error) }, 'Upstash Redis operation failed')
        if (attempt < attempts) await this.sleep(config.retryDelayMs * attempt)
      } finally {
        controller.abort()
      }
    }
    return undefined
  }
}

class UnexpectedRedisResponseError extends Error {
  constructor() {
    super('Upstash Redis health-check returned an unexpected response')
    this.name = 'UnexpectedRedisResponseError'
  }
}

function classifyHealthError(error: unknown): UpstashRedisHealthError {
  if (error instanceof UnexpectedRedisResponseError) return 'unexpected-response'
  if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('timed out'))) return 'timeout'
  return 'unavailable'
}

function classifyOperationError(error: unknown): UpstashRedisOperationError {
  if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('timed out'))) return 'timeout'
  return 'unavailable'
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`Upstash Redis operation timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
