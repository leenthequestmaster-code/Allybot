/**
 * Per-adapter circuit breaker.
 * 5 failures in 10 min → open 30 min → half-open probe → reset or re-open.
 * @module services/downloader/circuit
 */

export type CircuitState = 'closed' | 'open' | 'half-open'

export interface CircuitStatus {
  readonly state: CircuitState
  readonly failures: number
  readonly lastFailure: number | null
  readonly openUntil: number | null
}

const FAILURE_THRESHOLD = 5
const FAILURE_WINDOW_MS = 10 * 60_000   // 10 minutes
const OPEN_DURATION_MS  = 30 * 60_000   // 30 minutes

export class CircuitBreaker {
  private state: CircuitState = 'closed'
  private failures: { ts: number }[] = []
  private openUntil: number | null = null
  private lastFailure: number | null = null

  /** Execute `fn` through the breaker. Throws if circuit is open. */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkState()

    if (this.state === 'open') {
      throw new CircuitOpenError(this.openUntil ?? Date.now())
    }

    const start = Date.now()
    try {
      const result = await fn()
      this.onSuccess()
      return result
    } catch (err) {
      this.onFailure(start)
      throw err
    }
  }

  getState(): CircuitStatus {
    this.checkState()
    return {
      state: this.state,
      failures: this.failures.length,
      lastFailure: this.lastFailure,
      openUntil: this.openUntil,
    }
  }

  /** Transition open → half-open when timeout expires */
  private checkState(): void {
    if (this.state === 'open' && this.openUntil !== null && Date.now() >= this.openUntil) {
      this.state = 'half-open'
      this.openUntil = null
    }
  }

  private onSuccess(): void {
    if (this.state === 'half-open' || this.state === 'closed') {
      this.state = 'closed'
      this.failures = []
      this.openUntil = null
    }
  }

  private onFailure(ts: number): void {
    this.lastFailure = ts
    const windowStart = ts - FAILURE_WINDOW_MS
    this.failures = this.failures.filter(f => f.ts > windowStart)
    this.failures.push({ ts })

    if (this.state === 'half-open' || this.failures.length >= FAILURE_THRESHOLD) {
      this.state = 'open'
      this.openUntil = Date.now() + OPEN_DURATION_MS
      this.failures = []
    }
  }
}

export class CircuitOpenError extends Error {
  readonly openUntil: number
  constructor(openUntil: number) {
    super('Circuit breaker is open')
    this.name = 'CircuitOpenError'
    this.openUntil = openUntil
  }
}
