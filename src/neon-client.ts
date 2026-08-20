import postgres, { type Sql } from 'postgres'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from './framework/contracts.js'

export type NeonPoolMode = 'direct' | 'transaction'

export interface NeonClientConfig {
  url: string
  poolMode: NeonPoolMode
  statementTimeoutMs: number
}

const NEON_URL_PATTERN = /^postgres(?:ql)?:\/\//i
const NEON_POOL_MODES: readonly NeonPoolMode[] = ['direct', 'transaction']

function isNeonPoolMode(value: string): value is NeonPoolMode {
  return NEON_POOL_MODES.includes(value as NeonPoolMode)
}

export function readNeonClientConfig(
  env: NodeJS.ProcessEnv = process.env,
): NeonClientConfig | undefined {
  const enabled = env.NEON_ENABLED?.trim().toLowerCase() === 'true'
  if (!enabled) return undefined

  const url = env.NEON_DATABASE_URL?.trim()
  if (!url) throw new Error('NEON_DATABASE_URL is required when NEON_ENABLED=true')
  if (!NEON_URL_PATTERN.test(url)) throw new Error('NEON_DATABASE_URL must use postgres:// or postgresql://')

  const poolMode = env.NEON_POOL_MODE?.trim() || 'transaction'
  if (!isNeonPoolMode(poolMode)) throw new Error('NEON_POOL_MODE must be direct or transaction')

  const statementTimeoutMs = Number(env.NEON_CHAT_LOG_WRITE_TIMEOUT_MS ?? 10_000)
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 1_000 || statementTimeoutMs > 60_000) {
    throw new Error('NEON_CHAT_LOG_WRITE_TIMEOUT_MS must be between 1000 and 60000')
  }

  return { url, poolMode, statementTimeoutMs }
}

export function createNeonClient(config: NeonClientConfig): Sql {
  return postgres(config.url, {
    ssl: 'require',
    prepare: config.poolMode === 'direct',
    max: 2,
    connect_timeout: 10,
    idle_timeout: 30,
    max_lifetime: 300,
    connection: { statement_timeout: config.statementTimeoutMs },
  })
}

export function redactNeonError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown Neon PostgreSQL failure'
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s'\")]+/gi, 'postgresql://***')
    .replace(/(password|passwd|pwd)\s*[=:]\s*[^\s,;]+/gi, '$1=***')
}

export class NeonClientService implements Service {
  readonly name = 'neon-client'

  private client: Sql | undefined

  constructor(
    private readonly logger: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  initialize(_context: ServiceContext): void {
    const config = readNeonClientConfig(this.env)
    if (!config) return
    this.client = createNeonClient(config)
    this.logger.info({ poolMode: config.poolMode }, 'Neon PostgreSQL client initialized')
  }

  get isEnabled(): boolean {
    return this.client !== undefined
  }

  getClient(): Sql {
    if (!this.client) throw new Error('Neon PostgreSQL client is not enabled')
    return this.client
  }

  async shutdown(): Promise<void> {
    const client = this.client
    this.client = undefined
    if (!client) return
    await client.end({ timeout: 5 })
  }
}
