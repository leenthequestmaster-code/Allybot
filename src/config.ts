import 'dotenv/config'
import { z } from 'zod'

const booleanFromEnv = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true')

const positiveInt = z
  .string()
  .regex(/^\d+$/, 'must be a positive integer')
  .transform(Number)
  .refine((value) => value > 0, 'must be greater than zero')

function boundedInt(min: number, max: number) {
  return z
    .string()
    .regex(/^\d+$/, 'must be a positive integer')
    .transform(Number)
    .refine((value) => value >= min && value <= max, `must be between ${min} and ${max}`)
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_PATH: z.string().min(1).default('./data/allyssea.sqlite'),
  AUTH_ACCOUNT_ID: z.string().min(1).default('primary'),
  LOCAL_MESSAGE_CACHE_TTL_MS: boundedInt(60_000, 7 * 24 * 60 * 60 * 1_000).default(24 * 60 * 60 * 1_000),
  LOCAL_MESSAGE_CACHE_MAX_ROWS: boundedInt(1, 100_000).default(10_000),
  LOCAL_MESSAGE_CACHE_MAX_BYTES: boundedInt(1_024, 256 * 1024 * 1_024).default(64 * 1024 * 1_024),
  BOT_OWNER_JID: z.string().regex(/^\d+(?:@s\.whatsapp\.net)?$/, 'must be a phone-number JID or digits only').optional(),
  WHATSAPP_ENABLED: booleanFromEnv.default(true),
  QR_ENABLED: booleanFromEnv,
  PAIRING_ENABLED: booleanFromEnv,
  PAIRING_PHONE_NUMBER: z.string().regex(/^\d+$/, 'must contain digits only').optional(),
  ENABLE_HISTORY_SYNC: booleanFromEnv,
  MAX_RECONNECT_DELAY_MS: positiveInt.default(300000),
  SHUTDOWN_TIMEOUT_MS: positiveInt.default(15000),
  COMMAND_PREFIX: z.string().min(1).max(4).default('!'),
  DEFAULT_COMMAND_COOLDOWN_MS: positiveInt.default(3000),
  DIAGNOSTICS_ENABLED: booleanFromEnv.default(false),
  XKIRO_AI_ENABLED: booleanFromEnv.default(false),
  XKIRO_AI_FALLBACK_ENABLED: booleanFromEnv.default(false),
  SUPABASE_ECONOMY_ENABLED: booleanFromEnv.default(false),
  SUPABASE_URL: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_ECONOMY_CACHE_TTL_SECONDS: boundedInt(5, 300).default(15),
  NEON_ENABLED: booleanFromEnv.default(false),
  NEON_DATABASE_URL: z.string().min(1).optional(),
  NEON_POOL_MODE: z.enum(['direct', 'transaction']).default('transaction'),
  NEON_CHAT_LOG_ENABLED: booleanFromEnv.default(false),
  NEON_CHAT_LOG_GROUPS: z.string().default(''),
  NEON_CHAT_LOG_QUEUE_CAPACITY: boundedInt(1, 10_000).default(1000),
  NEON_CHAT_LOG_MAX_ATTEMPTS: boundedInt(1, 5).default(3),
  NEON_CHAT_LOG_RETRY_DELAY_MS: boundedInt(50, 5_000).default(250),
  NEON_CHAT_LOG_MAX_RETRY_DELAY_MS: boundedInt(100, 60_000).default(5_000),
  NEON_CHAT_LOG_WRITE_TIMEOUT_MS: boundedInt(1_000, 60_000).default(10_000),
  NEON_CHAT_LOG_DRAIN_TIMEOUT_MS: boundedInt(1_000, 60_000).default(10_000),
  UPSTASH_REDIS_ENABLED: booleanFromEnv.default(false),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
  UPSTASH_REDIS_TIMEOUT_MS: boundedInt(1_000, 10_000).default(5_000),
  UPSTASH_REDIS_OPERATION_TIMEOUT_MS: boundedInt(100, 2_000).default(1_000),
  UPSTASH_REDIS_MAX_ATTEMPTS: boundedInt(1, 3).default(2),
  UPSTASH_REDIS_RETRY_DELAY_MS: boundedInt(50, 2_000).default(100),
  UPSTASH_REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,39}$/i).default('allybot:v1'),
})

export type AppConfig = z.infer<typeof envSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid Allybot configuration: ${details}`)
  }

  if (parsed.data.PAIRING_ENABLED && !parsed.data.PAIRING_PHONE_NUMBER) {
    throw new Error('PAIRING_PHONE_NUMBER is required when PAIRING_ENABLED=true')
  }
  if (parsed.data.SUPABASE_ECONOMY_ENABLED) {
    if (!parsed.data.SUPABASE_URL) throw new Error('SUPABASE_URL is required when SUPABASE_ECONOMY_ENABLED=true')
    if (!parsed.data.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required when SUPABASE_ECONOMY_ENABLED=true')
    if (!/^https:\/\//i.test(parsed.data.SUPABASE_URL)) throw new Error('SUPABASE_URL must use https://')
  }
  if (parsed.data.NEON_ENABLED && !parsed.data.NEON_DATABASE_URL) {
    throw new Error('NEON_DATABASE_URL is required when NEON_ENABLED=true')
  }
  if (parsed.data.NEON_DATABASE_URL && !/^postgres(?:ql)?:\/\//i.test(parsed.data.NEON_DATABASE_URL)) {
    throw new Error('NEON_DATABASE_URL must use postgres:// or postgresql://')
  }
  if (parsed.data.NEON_CHAT_LOG_ENABLED && !parsed.data.NEON_ENABLED) {
    throw new Error('NEON_ENABLED must be true when NEON_CHAT_LOG_ENABLED=true')
  }
  if (parsed.data.NEON_CHAT_LOG_ENABLED && !parsed.data.NEON_CHAT_LOG_GROUPS.trim()) {
    throw new Error('NEON_CHAT_LOG_GROUPS is required when NEON_CHAT_LOG_ENABLED=true')
  }
  if (parsed.data.NEON_CHAT_LOG_MAX_RETRY_DELAY_MS < parsed.data.NEON_CHAT_LOG_RETRY_DELAY_MS) {
    throw new Error('NEON_CHAT_LOG_MAX_RETRY_DELAY_MS must be at least NEON_CHAT_LOG_RETRY_DELAY_MS')
  }
  if (parsed.data.UPSTASH_REDIS_ENABLED) {
    if (!parsed.data.UPSTASH_REDIS_REST_URL) throw new Error('UPSTASH_REDIS_REST_URL is required when UPSTASH_REDIS_ENABLED=true')
    if (!parsed.data.UPSTASH_REDIS_REST_TOKEN) throw new Error('UPSTASH_REDIS_REST_TOKEN is required when UPSTASH_REDIS_ENABLED=true')
    if (!/^https:\/\//i.test(parsed.data.UPSTASH_REDIS_REST_URL)) throw new Error('UPSTASH_REDIS_REST_URL must use https://')
  }

  return parsed.data
}

export function publicConfig(config: AppConfig) {
  return {
    nodeEnv: config.NODE_ENV,
    logLevel: config.LOG_LEVEL,
    databasePath: config.DATABASE_PATH,
    accountId: config.AUTH_ACCOUNT_ID === 'primary' ? 'primary' : 'configured',
    localMessageCacheTtlMs: config.LOCAL_MESSAGE_CACHE_TTL_MS,
    localMessageCacheMaxRows: config.LOCAL_MESSAGE_CACHE_MAX_ROWS,
    localMessageCacheMaxBytes: config.LOCAL_MESSAGE_CACHE_MAX_BYTES,
    whatsappEnabled: config.WHATSAPP_ENABLED,
    qrEnabled: config.QR_ENABLED,
    pairingEnabled: config.PAIRING_ENABLED,
    historySyncEnabled: config.ENABLE_HISTORY_SYNC,
    maxReconnectDelayMs: config.MAX_RECONNECT_DELAY_MS,
    commandPrefix: config.COMMAND_PREFIX,
    defaultCommandCooldownMs: config.DEFAULT_COMMAND_COOLDOWN_MS,
    diagnosticsEnabled: config.DIAGNOSTICS_ENABLED,
    xkiroAiEnabled: config.XKIRO_AI_ENABLED,
    xkiroAiFallbackEnabled: config.XKIRO_AI_FALLBACK_ENABLED,
    supabaseEconomyEnabled: config.SUPABASE_ECONOMY_ENABLED,
    supabaseEconomyCacheTtlSeconds: config.SUPABASE_ECONOMY_CACHE_TTL_SECONDS,
    neonEnabled: config.NEON_ENABLED,
    neonChatLogEnabled: config.NEON_CHAT_LOG_ENABLED,
    upstashRedisEnabled: config.UPSTASH_REDIS_ENABLED,
  }
}
