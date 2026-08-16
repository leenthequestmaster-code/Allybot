export type ErrorCategory =
  | 'configuration'
  | 'storage'
  | 'authentication'
  | 'network'
  | 'protocol'
  | 'message'
  | 'lifecycle'
  | 'unknown'

export class AllybotError extends Error {
  private readonly retryableOverride?: boolean

  constructor(
    message: string,
    public readonly category: ErrorCategory,
    options?: { cause?: unknown; retryable?: boolean },
  ) {
    super(message, { cause: options?.cause })
    this.name = 'AllybotError'
    this.retryableOverride = options?.retryable
  }

  get retryable(): boolean {
    return this.retryableOverride ?? (this.category === 'network' || this.category === 'protocol')
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function statusCodeFromError(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const output = (error as { output?: { statusCode?: unknown } }).output
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined
}
