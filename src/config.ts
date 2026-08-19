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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_PATH: z.string().min(1).default('./data/allyssea.sqlite'),
  AUTH_ACCOUNT_ID: z.string().min(1).default('primary'),
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
  AI_COMMANDS_ENABLED: booleanFromEnv.default(false),
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

  return parsed.data
}

export function publicConfig(config: AppConfig) {
  return {
    nodeEnv: config.NODE_ENV,
    logLevel: config.LOG_LEVEL,
    databasePath: config.DATABASE_PATH,
    accountId: config.AUTH_ACCOUNT_ID,
    whatsappEnabled: config.WHATSAPP_ENABLED,
    qrEnabled: config.QR_ENABLED,
    pairingEnabled: config.PAIRING_ENABLED,
    historySyncEnabled: config.ENABLE_HISTORY_SYNC,
    maxReconnectDelayMs: config.MAX_RECONNECT_DELAY_MS,
    commandPrefix: config.COMMAND_PREFIX,
    defaultCommandCooldownMs: config.DEFAULT_COMMAND_COOLDOWN_MS,
    diagnosticsEnabled: config.DIAGNOSTICS_ENABLED,
    aiCommandsEnabled: config.AI_COMMANDS_ENABLED,
  }
}
