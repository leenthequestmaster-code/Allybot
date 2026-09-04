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
  ECONOMY_ENABLED: booleanFromEnv.default(false),
  CHARACTER_GUIDE_ENABLED: booleanFromEnv.default(false),
  GROUP_CONTEXT_ENABLED: booleanFromEnv.default(false),
  CHARACTER_GUIDE_SESSION_TTL_SECONDS: boundedInt(300, 86_400).default(1_800),
  GROUP_CONTEXT_OOC_COOLDOWN_MS: boundedInt(1_000, 3_600_000).default(30_000),
  GROUP_CONTEXT_OOC_WINDOW_MS: boundedInt(60_000, 3_600_000).default(600_000),
  GROUP_CONTEXT_OOC_MAX_PER_WINDOW: boundedInt(1, 20).default(3),
  MONGODB_ENABLED: booleanFromEnv.default(false),
  MONGODB_URI: z.string().min(1).optional(),
  MONGODB_DB_NAME: z.string().min(1).default('allybot'),
  MONGODB_TIMEOUT_MS: boundedInt(1_000, 30_000).default(5_000),
  REDIS_ENABLED: booleanFromEnv.default(false),
  REDIS_URL: z.string().min(1).optional(),
  REDIS_TIMEOUT_MS: boundedInt(1_000, 10_000).default(5_000),
  REDIS_OPERATION_TIMEOUT_MS: boundedInt(100, 2_000).default(1_000),
  REDIS_MAX_ATTEMPTS: boundedInt(1, 3).default(2),
  REDIS_RETRY_DELAY_MS: boundedInt(50, 2_000).default(100),
  REDIS_KEY_PREFIX: z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,39}$/i).default('allybot:v1'),
  CODEBASE_EXPORT_ENABLED: booleanFromEnv.default(false),
  CODEBASE_EXPORT_PATH: z.string().min(1).default('./Codebase/allybot-codebase-latest.zip'),
  CODEBASE_EXPORT_MAX_BYTES: boundedInt(1, 4 * 1024 * 1024).default(3 * 1024 * 1024),
  SENTRY_ENABLED: booleanFromEnv.default(false),
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().regex(/^[a-zA-Z0-9._-]{1,32}$/).default('production'),
  SENTRY_RELEASE: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/).optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.string().regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/).default('0').transform(Number),
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
  if (parsed.data.CHARACTER_GUIDE_ENABLED && !parsed.data.MONGODB_URI) {
    throw new Error('MONGODB_URI is required when CHARACTER_GUIDE_ENABLED=true')
  }
  if (parsed.data.GROUP_CONTEXT_ENABLED && !parsed.data.MONGODB_URI) {
    throw new Error('MONGODB_URI is required when GROUP_CONTEXT_ENABLED=true')
  }
  if (parsed.data.MONGODB_ENABLED && !parsed.data.MONGODB_URI) {
    throw new Error('MONGODB_URI is required when MONGODB_ENABLED=true')
  }
  if (parsed.data.REDIS_ENABLED && !parsed.data.REDIS_URL) {
    throw new Error('REDIS_URL is required when REDIS_ENABLED=true')
  }
  if (parsed.data.CODEBASE_EXPORT_PATH.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(parsed.data.CODEBASE_EXPORT_PATH) || parsed.data.CODEBASE_EXPORT_PATH.split(/[\\/]/u).includes('..')) {
    throw new Error('CODEBASE_EXPORT_PATH must remain inside the application directory')
  }
  if (parsed.data.SENTRY_ENABLED && !parsed.data.SENTRY_DSN) {
    throw new Error('SENTRY_DSN is required when SENTRY_ENABLED=true')
  }
  if (parsed.data.SENTRY_DSN && !/^https:\/\//i.test(parsed.data.SENTRY_DSN)) {
    throw new Error('SENTRY_DSN must use https://')
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
    characterGuideEnabled: config.CHARACTER_GUIDE_ENABLED,
    groupContextEnabled: config.GROUP_CONTEXT_ENABLED,
    mongoEnabled: config.MONGODB_ENABLED,
    redisEnabled: config.REDIS_ENABLED,
    codebaseExportEnabled: config.CODEBASE_EXPORT_ENABLED,
    codebaseExportMaxBytes: config.CODEBASE_EXPORT_MAX_BYTES,
    sentryEnabled: config.SENTRY_ENABLED,
    sentryEnvironment: config.SENTRY_ENVIRONMENT,
    sentryReleaseConfigured: Boolean(config.SENTRY_RELEASE),
    sentryTracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
  }
}
