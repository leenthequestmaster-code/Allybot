import { Redis } from '@upstash/redis'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from './framework/contracts.js'

export type UpstashRedisHealthStatus = 'disabled' | 'healthy' | 'unhealthy'
export type UpstashRedisHealthError = 'timeout' | 'unavailable' | 'unexpected-response'

export interface UpstashRedisConfig {
  readonly url: string
  readonly token: string
  readonly timeoutMs: number
  readonly maxAttempts: number
  readonly retryDelayMs: number
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

export interface UpstashRedisServiceOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly createClient?: (config: UpstashRedisConfig, signal: AbortSignal) => UpstashRedisProbeClient
  readonly sleep?: (delayMs: number) => Promise<void>
  readonly clock?: () => number
}

const UPSTASH_URL_PATTERN = /^https:\/\//i
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_ATTEMPTS = 2
const DEFAULT_RETRY_DELAY_MS = 100

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback
  if (!/^\d+$/.test(value.trim())) throw new Error(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be between ${min} and ${max}`)
  }
  return parsed
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

  return {
    url,
    token,
    timeoutMs: boundedInteger(env.UPSTASH_REDIS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 10_000, 'UPSTASH_REDIS_TIMEOUT_MS'),
    maxAttempts: boundedInteger(env.UPSTASH_REDIS_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 1, 3, 'UPSTASH_REDIS_MAX_ATTEMPTS'),
    retryDelayMs: boundedInteger(env.UPSTASH_REDIS_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS, 50, 2_000, 'UPSTASH_REDIS_RETRY_DELAY_MS'),
  }
}

export function createUpstashRedisClient(config: UpstashRedisConfig, signal: AbortSignal): UpstashRedisProbeClient {
  return new Redis({
    url: config.url,
    token: config.token,
    signal,
    retry: false,
    enableTelemetry: false,
    keepAlive: true,
  })
}

export class UpstashRedisService implements Service {
  readonly name = 'upstash-redis'

  private readonly env: NodeJS.ProcessEnv
  private readonly createClient: (config: UpstashRedisConfig, signal: AbortSignal) => UpstashRedisProbeClient
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

  async shutdown(): Promise<void> {
    this.config = undefined
    this.health = { status: 'disabled', checkedAt: new Date(this.clock()).toISOString(), attempts: 0 }
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new Error(`Upstash Redis health-check timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
