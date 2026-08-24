import 'dotenv/config'
import { createPostgresVerifier, readPostgresVerificationConfig, redactPostgresError } from '../dist/postgres-verifier.js'
import { PostgresReadOnlyMonitor } from '../dist/postgres-monitor.js'

const DEFAULT_INTERVAL_MS = 300_000
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_INTERVAL_MS = 86_400_000
const MAX_TIMEOUT_MS = 60_000

function readBoundedPositiveInt(env, name, fallback, maximum) {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`)
  }
  return value
}

const config = readPostgresVerificationConfig()
if (!config) {
  console.error('POSTGRES_MONITOR=FAIL (POSTGRES_URL is required)')
  process.exitCode = 2
} else {
  try {
    const intervalMs = readBoundedPositiveInt(
      process.env,
      'POSTGRES_MONITOR_INTERVAL_MS',
      DEFAULT_INTERVAL_MS,
      MAX_INTERVAL_MS,
    )
    const timeoutMs = readBoundedPositiveInt(
      process.env,
      'POSTGRES_MONITOR_TIMEOUT_MS',
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    const monitor = new PostgresReadOnlyMonitor(config, {
      intervalMs,
      timeoutMs,
      createVerifier: createPostgresVerifier,
      onEvent: (event) => {
        if (event.status === 'pass') {
          console.log(`POSTGRES_MONITOR=PASS (${event.checked}) checked_at=${event.checkedAt}`)
        } else {
          console.error(`POSTGRES_MONITOR=FAIL (${event.error}) checked_at=${event.checkedAt}`)
        }
      },
    })

    let stopping = false
    const stop = async (signal) => {
      if (stopping) return
      stopping = true
      await monitor.stop()
      console.log(`POSTGRES_MONITOR=STOPPED (${signal})`)
      process.exitCode = 0
    }

    process.once('SIGINT', () => void stop('SIGINT'))
    process.once('SIGTERM', () => void stop('SIGTERM'))
    monitor.start()
  } catch (error) {
    console.error(`POSTGRES_MONITOR=FAIL (${redactPostgresError(error)})`)
    process.exitCode = 1
  }
}
