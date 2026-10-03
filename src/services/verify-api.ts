import { readFileSync, existsSync } from 'fs'
import { tripOnRateLimit, isRateLimited, rateLimitingFor, rateLimitTripsThisHour } from './amprem-rate-limit.js'
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
      typeof obj['verify_api_url'] === 'string' ? obj['verify_api_url'] : 'http://localhost:3300',
    verify_timeout_ms:
      typeof obj['verify_timeout_ms'] === 'number' ? obj['verify_timeout_ms'] : 10000,
    verify_retry_count:
      typeof obj['verify_retry_count'] === 'number' ? obj['verify_retry_count'] : 2,
  }
}

// Normalized response shape — abstrak dari shape service produksi.
export interface ApiResponse {
  status: boolean
  message: string
  data: unknown
}

// am-reverse response shape (raw dari service)
interface AmReverseResponse {
  success?: boolean
  status?: boolean
  message?: string
  [key: string]: unknown
}

// Normalize am-reverse shape ke ApiResponse standar plugin.
// am-reverse pakai field 'success', plugin kita pakai 'status'.
function normalize(raw: AmReverseResponse): ApiResponse {
  const status = typeof raw.success === 'boolean' ? raw.success : (raw.status ?? false)
  const message = typeof raw.message === 'string' ? raw.message : ''
  const { success: _s, status: _st, message: _m, ...rest } = raw
  return { status, message, data: Object.keys(rest).length ? rest : null }
}

const BACKOFF_DELAYS_MS = [1000, 3000]

async function postWithRetry(
  endpoint: string,
  body: Record<string, string>,
): Promise<ApiResponse> {
  const cfg = loadVerifyConfig()
  const url = `${cfg.verify_api_url}${endpoint}`
  const maxRetries = cfg.verify_retry_count

  // Global cooldown aktif → tolak tanpa hit service.
  if (isRateLimited()) {
    const secs = rateLimitingFor()
    return { status: false, message: `Service sedang sibuk. Coba lagi dalam ${secs}s.`, data: null }
  }

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

      // 4xx/5xx: parse dan return WITHOUT retrying
      const raw = (await res.json()) as AmReverseResponse
      tripOnRateLimit(res.status, raw, res.headers, endpoint.startsWith('/api/verify') ? 'verify' : 'send')
      return normalize(raw)
    } catch (err) {
      clearTimeout(timer)

      if (err instanceof Error && err.name === 'AbortError') {
        throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' })
      }

      if (attempt < maxRetries) {
        const delay = BACKOFF_DELAYS_MS[attempt] ?? 1000
        await new Promise<void>((r) => setTimeout(r, delay))
      }
    }
  }

  throw Object.assign(new Error('network after retry'), { code: 'NETWORK_RETRY' })
}

// POST /api/send-link — { email }
export async function sendLink(email: string): Promise<ApiResponse> {
  return postWithRetry('/api/send-link', { email })
}

// POST /api/verify-link — { email, magicLink }
// 'link' di-map ke field 'magicLink' yang diexpect am-reverse.
export async function verifyLink(email: string, link: string): Promise<ApiResponse> {
  return postWithRetry('/api/verify-link', { email, magicLink: link })
}

/// Notif owner: expose counter dari amprem-rate-limit.
export function ampremRateLimitTrips(): number {
  return rateLimitTripsThisHour()
}
