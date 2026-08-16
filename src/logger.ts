import pino, { type Logger } from 'pino'
import type { AppConfig } from './config.js'

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: {
      service: 'allybot',
      accountId: config.AUTH_ACCOUNT_ID,
    },
    redact: {
      paths: [
        'qr',
        'pairingCode',
        'code',
        'auth',
        'authState',
        'creds',
        'keys',
        'token',
        'accessToken',
        'message',
        'messages',
        'body',
        'phoneNumber',
      ],
      censor: '[REDACTED]',
    },
  })
}

export type AppLogger = ReturnType<typeof createLogger>
