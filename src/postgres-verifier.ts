import postgres, { type Sql } from 'postgres'

export type PostgresPoolMode = 'direct' | 'session' | 'transaction'

export interface PostgresVerificationConfig {
  url: string
  poolMode: PostgresPoolMode
}

export interface PostgresVerificationResult {
  ok: true
  checked: 'read-only-select-1'
}

const POSTGRES_URL_PATTERN = /^postgres(?:ql)?:\/\//i
const POSTGRES_POOL_MODES: readonly PostgresPoolMode[] = ['direct', 'session', 'transaction']

function isPostgresPoolMode(value: string): value is PostgresPoolMode {
  return POSTGRES_POOL_MODES.includes(value as PostgresPoolMode)
}

export function readPostgresVerificationConfig(
  env: NodeJS.ProcessEnv = process.env,
): PostgresVerificationConfig | undefined {
  const url = env.POSTGRES_URL?.trim()
  if (!url) return undefined
  if (!POSTGRES_URL_PATTERN.test(url)) {
    throw new Error('POSTGRES_URL must use postgres:// or postgresql://')
  }

  const poolMode = env.POSTGRES_POOL_MODE?.trim() || 'session'
  if (!isPostgresPoolMode(poolMode)) {
    throw new Error('POSTGRES_POOL_MODE must be direct, session, or transaction')
  }

  return { url, poolMode }
}

export function createPostgresVerifier(config: PostgresVerificationConfig): {
  verify: () => Promise<PostgresVerificationResult>
  close: () => Promise<void>
} {
  const sql: Sql = postgres(config.url, {
    ssl: 'require',
    prepare: config.poolMode !== 'transaction',
    max: 1,
    connect_timeout: 10,
    idle_timeout: 10,
    max_lifetime: 60,
  })

  return {
    async verify(): Promise<PostgresVerificationResult> {
      const rows = await sql.unsafe<Array<{ ok: number }>>('SELECT 1 AS ok LIMIT 1')
      if (rows.length !== 1 || rows[0]?.ok !== 1) {
        throw new Error('PostgreSQL read-only verification returned an unexpected result')
      }
      return { ok: true, checked: 'read-only-select-1' }
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 })
    },
  }
}

export function redactPostgresError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown PostgreSQL verification failure'
  return message
    .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, 'postgresql://***@')
    .replace(/(password|passwd|pwd)\s*[=:]\s*[^\s,;]+/gi, '$1=***')
}
