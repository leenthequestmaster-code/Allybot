import {
  createPostgresVerifier,
  redactPostgresError,
  type PostgresVerificationConfig,
  type PostgresVerificationResult,
} from './postgres-verifier.js'

export type PostgresMonitorStatus = 'pass' | 'fail'

export interface PostgresMonitorEvent {
  status: PostgresMonitorStatus
  checkedAt: string
  checked?: PostgresVerificationResult['checked']
  error?: string
}

export interface PostgresMonitorVerifier {
  verify: () => Promise<PostgresVerificationResult>
  close: () => Promise<void>
}

export interface PostgresReadOnlyMonitorOptions {
  intervalMs: number
  timeoutMs: number
  createVerifier?: (config: PostgresVerificationConfig) => PostgresMonitorVerifier
  onEvent: (event: PostgresMonitorEvent) => void
}

const DEFAULT_CREATE_VERIFIER = createPostgresVerifier

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  assertPositiveInteger(timeoutMs, 'timeoutMs')
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`PostgreSQL verification timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

export class PostgresReadOnlyMonitor {
  private timer?: ReturnType<typeof setInterval>
  private inFlight?: Promise<PostgresMonitorEvent>
  private stopped = false

  constructor(
    private readonly config: PostgresVerificationConfig,
    private readonly options: PostgresReadOnlyMonitorOptions,
  ) {
    assertPositiveInteger(options.intervalMs, 'intervalMs')
    assertPositiveInteger(options.timeoutMs, 'timeoutMs')
  }

  start(): void {
    if (this.timer || this.stopped) return
    void this.checkNow()
    this.timer = setInterval(() => {
      void this.checkNow()
    }, this.options.intervalMs)
    this.timer.unref?.()
  }

  async checkNow(): Promise<PostgresMonitorEvent> {
    if (this.stopped) throw new Error('PostgreSQL monitor has been stopped')
    if (this.inFlight) return this.inFlight

    this.inFlight = this.executeCheck().finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.inFlight) await this.inFlight
  }

  private async executeCheck(): Promise<PostgresMonitorEvent> {
    const checkedAt = new Date().toISOString()
    let verifier: PostgresMonitorVerifier | undefined
    let event: PostgresMonitorEvent

    try {
      verifier = (this.options.createVerifier ?? DEFAULT_CREATE_VERIFIER)(this.config)
      const result = await withTimeout(verifier.verify(), this.options.timeoutMs)
      event = { status: 'pass', checkedAt, checked: result.checked }
    } catch (error) {
      event = { status: 'fail', checkedAt, error: redactPostgresError(error) }
    }

    if (verifier) {
      try {
        await verifier.close()
      } catch (error) {
        event = {
          status: 'fail',
          checkedAt,
          error: `PostgreSQL verifier cleanup failed: ${redactPostgresError(error)}`,
        }
      }
    }

    this.options.onEvent(event)
    return event
  }
}
