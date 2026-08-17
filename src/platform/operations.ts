import type {
  PermissionPort,
  PermissionRequest,
  PlatformClock,
  PlatformEventSink,
} from './contracts.js'

export interface OperationRetryPolicy {
  readonly maxAttempts?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly shouldRetry?: (error: unknown, attempt: number) => boolean
}

export interface OperationOptions<T> {
  readonly operationId: string
  readonly permission?: PermissionRequest
  readonly permissionPort?: PermissionPort
  readonly events?: PlatformEventSink
  readonly clock?: PlatformClock
  readonly timeoutMs?: number
  readonly retry?: OperationRetryPolicy
  readonly execute: (attempt: number) => Promise<T> | T
}

export type OperationResult<T> =
  | { readonly ok: true; readonly value: T; readonly attempts: number }
  | { readonly ok: false; readonly error: unknown; readonly attempts: number }

export async function runPlatformOperation<T>(options: OperationOptions<T>): Promise<OperationResult<T>> {
  const clock = options.clock ?? { now: () => Date.now() }
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 1)
  const baseDelayMs = Math.max(0, options.retry?.baseDelayMs ?? 100)
  const maxDelayMs = Math.max(baseDelayMs, options.retry?.maxDelayMs ?? 2_000)
  const startedAt = clock.now()

  if (options.permission && options.permissionPort) {
    const decision = await options.permissionPort.evaluate(options.permission)
    if (!decision.allowed) {
      await options.events?.emit({ name: 'permission.denied', at: clock.now(), payload: { operationId: options.operationId, reason: decision.reason, policy: decision.policy ?? 'unknown' } })
      return { ok: false, error: new Error(`Permission denied: ${decision.reason}`), attempts: 0 }
    }
  }

  await options.events?.emit({ name: 'operation.started', at: startedAt, payload: { operationId: options.operationId } })
  let attempt = 0
  while (attempt < maxAttempts) {
    attempt += 1
    try {
      const value = await withTimeout(Promise.resolve(options.execute(attempt)), options.timeoutMs, options.operationId)
      await options.events?.emit({ name: 'operation.succeeded', at: clock.now(), payload: { operationId: options.operationId, attempts: attempt } })
      return { ok: true, value, attempts: attempt }
    } catch (error) {
      const retry = attempt < maxAttempts && (options.retry?.shouldRetry?.(error, attempt) ?? isRetryableError(error))
      if (!retry) {
        await options.events?.emit({ name: 'operation.failed', at: clock.now(), payload: { operationId: options.operationId, attempts: attempt, error: safeErrorName(error) } })
        return { ok: false, error, attempts: attempt }
      }
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      await sleep(delay)
    }
  }

  return { ok: false, error: new Error(`Operation exhausted attempts: ${options.operationId}`), attempts: maxAttempts }
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { retryable?: unknown; category?: unknown }
  return candidate.retryable === true || candidate.category === 'network' || candidate.category === 'protocol'
}

function safeErrorName(error: unknown): string {
  if (error instanceof Error) return error.name
  return typeof error
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number | undefined, operationId: string): Promise<T> {
  if (timeoutMs === undefined) return promise
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`Invalid timeout for operation: ${operationId}`)
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation timed out: ${operationId}`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function sleep(delayMs: number): Promise<void> {
  if (delayMs <= 0) return
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}
