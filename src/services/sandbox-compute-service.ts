import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Service } from '../framework/contracts.js'

export type SandboxComputeRequest =
  | { readonly mode: 'eval'; readonly expression: string; readonly variables?: Record<string, number | number[] | string> }
  | { readonly mode: 'dice'; readonly spec: string; readonly iterations?: number; readonly target?: number }
  | { readonly mode: 'table'; readonly rows: Record<string, string | number>[]; readonly sortBy?: string; readonly order?: 'asc' | 'desc'; readonly limit?: number; readonly sumField?: string }

export interface SandboxComputeResult {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: string
  readonly durationMs: number
}

const SANDBOX_TIMEOUT_MS = 500
const SANDBOX_MAX_EXPRESSION_LEN = 2_000

export class SandboxComputeService implements Service {
  readonly name = 'sandbox-compute'
  private readonly workerPath: string

  constructor(workerPath?: string) {
    const here = dirname(fileURLToPath(import.meta.url))
    this.workerPath = workerPath ?? join(here, 'sandbox-compute-worker.js')
  }

  async run(request: SandboxComputeRequest): Promise<SandboxComputeResult> {
    if (request.mode === 'eval' && request.expression.length > SANDBOX_MAX_EXPRESSION_LEN) {
      return { ok: false, error: 'Ekspresi terlalu panjang (maks 2000 karakter)', durationMs: 0 }
    }

    const startedAt = Date.now()
    return await new Promise<SandboxComputeResult>((resolve) => {
      let settled = false
      const worker = new Worker(this.workerPath, {
        workerData: request,
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 32,
          maxYoungGenerationSizeMb: 8,
        },
      })

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        void worker.terminate()
        resolve({
          ok: false,
          error: 'Sandbox timeout (melebihi batas 500 ms)',
          durationMs: Date.now() - startedAt,
        })
      }, SANDBOX_TIMEOUT_MS)

      worker.once('message', (payload: { ok: boolean; result?: unknown; error?: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        resolve({
          ok: payload.ok,
          ...(payload.result !== undefined ? { result: payload.result } : {}),
          ...(payload.error ? { error: payload.error } : {}),
          durationMs: Date.now() - startedAt,
        })
      })

      worker.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        resolve({
          ok: false,
          error: err instanceof Error ? err.message : 'Worker error',
          durationMs: Date.now() - startedAt,
        })
      })

      worker.once('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          ok: false,
          error: `Sandbox worker exited unexpectedly (${code})`,
          durationMs: Date.now() - startedAt,
        })
      })
    })
  }
}
