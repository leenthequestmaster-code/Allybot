import * as Sentry from '@sentry/node'
import type { ErrorEvent } from '@sentry/node'
import type { AppConfig } from './config.js'
import type { AppLogger } from './logger.js'

const SAFE_LABEL = /^[A-Za-z0-9_.:-]{1,96}$/
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const SAFE_ERROR_CODE = /^[A-Z0-9][A-Z0-9_.-]{0,63}$/
const SENTRY_FLUSH_TIMEOUT_MS = 2_000

function safeLabel(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() ?? ''
  return SAFE_LABEL.test(normalized) ? normalized : fallback
}

function safeErrorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && SAFE_ERROR_NAME.test(name)) return name
  }
  return 'UnknownError'
}

function safeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : undefined
}

function redactErrorEvent(event: ErrorEvent): ErrorEvent {
  const tags = event.tags
    ? Object.fromEntries(Object.entries(event.tags)
      .filter(([key, value]) => SAFE_LABEL.test(key) && typeof value === 'string' && SAFE_LABEL.test(value)))
    : undefined

  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    platform: 'node',
    release: event.release,
    environment: event.environment,
    tags,
    message: 'Allybot operational event',
  }
}

export interface SentryReporter {
  readonly isEnabled: boolean
  captureError(operation: string, error: unknown): void
  captureMessage(operation: string, message: 'started' | 'completed' | 'failed'): void
  close(): Promise<void>
}

const disabledReporter: SentryReporter = {
  isEnabled: false,
  captureError: () => undefined,
  captureMessage: () => undefined,
  close: async () => undefined,
}

export function createSentryReporter(config: AppConfig, logger: AppLogger): SentryReporter {
  if (!config.SENTRY_ENABLED || !config.SENTRY_DSN) return disabledReporter

  try {
    Sentry.init({
      dsn: config.SENTRY_DSN,
      environment: config.SENTRY_ENVIRONMENT,
      release: config.SENTRY_RELEASE,
      sendDefaultPii: false,
      tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
      integrations: [],
      beforeSend: redactErrorEvent,
    })
  } catch (error) {
    logger.error({ errorName: safeErrorName(error) }, 'Sentry initialization failed; telemetry disabled')
    return disabledReporter
  }

  logger.info({ environment: config.SENTRY_ENVIRONMENT }, 'Sentry telemetry initialized')

  return {
    isEnabled: true,

    captureError(operation, error): void {
      try {
        const safeOperation = safeLabel(operation, 'unknown')
        const errorName = safeErrorName(error)
        const errorCode = safeErrorCode(error)
        Sentry.withScope((scope) => {
          scope.setTag('operation', safeOperation)
          scope.setTag('error_class', errorName)
          if (errorCode) scope.setTag('error_code', errorCode)
          Sentry.captureMessage('Allybot operational error', 'error')
        })
      } catch (captureError) {
        logger.warn({ errorName: safeErrorName(captureError) }, 'Sentry error capture failed safely')
      }
    },

    captureMessage(operation, message): void {
      try {
        const safeOperation = safeLabel(operation, 'unknown')
        Sentry.withScope((scope) => {
          scope.setTag('operation', safeOperation)
          scope.setTag('status', message)
          Sentry.captureMessage('Allybot operational checkpoint', 'info')
        })
      } catch (captureError) {
        logger.warn({ errorName: safeErrorName(captureError) }, 'Sentry checkpoint capture failed safely')
      }
    },

    async close(): Promise<void> {
      try {
        await Sentry.close(SENTRY_FLUSH_TIMEOUT_MS)
      } catch (error) {
        logger.warn({ errorName: safeErrorName(error) }, 'Sentry telemetry flush failed during shutdown')
      }
    },
  }
}
