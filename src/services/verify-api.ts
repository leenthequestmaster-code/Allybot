import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const CONFIG_PATH = resolve('/opt/Allybot/data/config.json')

interface VerifyConfig {
  verify_api_url: string
  verify_timeout_ms: number
  verify_retry_count: number
}

function loadVerifyConfig(): VerifyConfig {
  let obj: Record<string, unknown> = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      if (typeof raw === 'object' && raw !== null) {
        obj = raw as Record<string, unknown>
      }
    } catch {
      // ignore parse errors, fall back to defaults
    }
  }
  return {
    verify_api_url:
      typeof obj['verify_api_url'] === 'string' ? obj['verify_api_url'] : 'http://localhost:3000',
    verify_timeout_ms:
      typeof obj['verify_timeout_ms'] === 'number' ? obj['verify_timeout_ms'] : 10000,
    verify_retry_count:
      typeof obj['verify_retry_count'] === 'number' ? obj['verify_retry_count'] : 2,
  }
}

export interface ApiResponse {
  status: boolean
  message: string
  data: unknown
}

const BACKOFF_DELAYS_MS = [1000, 3000]

async function postWithRetry(
  endpoint: string,
  body: Record<string, string>,
): Promise<ApiResponse> {
  const cfg = loadVerifyConfig()
  const url = `${cfg.verify_api_url}${endpoint}`
  const maxRetries = cfg.verify_retry_count

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.verify_timeout_ms)
    const t0 = Date.now()

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      clearTimeout(timer)

      const elapsed = Date.now() - t0
      console.log(`[verify-api] POST ${endpoint} ${res.status} ${elapsed}ms`)

      // 4xx/5xx: parse and return WITHOUT retrying
      const json = (await res.json()) as ApiResponse
      return json
    } catch (err) {
      clearTimeout(timer)

      if (err instanceof Error && err.name === 'AbortError') {
        throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' })
      }

      // Network error — retry with backoff
      if (attempt < maxRetries) {
        const delay = BACKOFF_DELAYS_MS[attempt] ?? 1000
        await new Promise<void>((r) => setTimeout(r, delay))
      }
    }
  }

  throw Object.assign(new Error('network after retry'), { code: 'NETWORK_RETRY' })
}

export async function sendLink(email: string): Promise<ApiResponse> {
  return postWithRetry('/api/send', { email })
}

export async function verifyLink(email: string, link: string): Promise<ApiResponse> {
  return postWithRetry('/api/verify', { email, link })
}
