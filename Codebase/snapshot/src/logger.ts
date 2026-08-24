import { createHash } from 'node:crypto'
import pino, { type Logger } from 'pino'
import type { AppConfig } from './config.js'

const SAFE_LABEL = /^[a-zA-Z0-9._-]{1,64}$/
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const SAFE_ERROR_CODE = /^[A-Z0-9][A-Z0-9_.-]{0,63}$/

function hashLabel(value: string): string {
  return `account-${createHash('sha256').update(value).digest('hex').slice(0, 16)}`
}

function safeAccountLabel(value: string): string {
  const normalized = value.trim()
  if (!normalized) return 'unknown'
  if (/^[^\s@]+@[^\s@]+$/.test(normalized) || /^\+?\d{7,15}$/.test(normalized)) return hashLabel(normalized)
  return SAFE_LABEL.test(normalized) ? normalized : hashLabel(normalized)
}

function safeErrorSerializer(error: unknown): Record<string, string> {
  if (!error || typeof error !== 'object') return { name: 'UnknownError' }
  const candidate = error as { name?: unknown; code?: unknown }
  const name = typeof candidate.name === 'string' && SAFE_ERROR_NAME.test(candidate.name)
    ? candidate.name
    : 'Error'
  const code = typeof candidate.code === 'string' && SAFE_ERROR_CODE.test(candidate.code)
    ? candidate.code
    : undefined
  return code ? { name, code } : { name }
}

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.LOG_LEVEL,
    base: {
      service: 'allybot',
      accountId: safeAccountLabel(config.AUTH_ACCOUNT_ID),
    },
    serializers: {
      err: safeErrorSerializer,
      error: safeErrorSerializer,
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
        'authorization',
        'cookie',
        'session',
        'secret',
        'password',
        'message',
        'messages',
        'body',
        'payload',
        'phone',
        'phoneNumber',
        'remoteJid',
        'groupJid',
        'senderJid',
        'quotedSenderJid',
        'userJid',
        'actorJid',
        'resourceJid',
        'targetJid',
        'recipientJid',
        'jid',
        'err.message',
        'err.stack',
        'err.cause',
        'error.message',
        'error.stack',
        'error.cause',
      ],
      censor: '[REDACTED]',
    },
  })
}

export type AppLogger = ReturnType<typeof createLogger>
