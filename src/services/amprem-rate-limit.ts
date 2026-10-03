// Hardening !am: rate-limit detection + global cooldown terpusat.
// am-reverse tunggal — rate limit = tunggu, jangan fallback.

let _rateLimitedUntil = 0
let _rateLimitedRetryAfter = 0
// TTL menit → hitungan 429 per jam per jam-sliding-window.
let _tripCount = 0
let _tripWindowStart = 0

export function isRateLimited(): boolean {
  return Date.now() < _rateLimitedUntil
}

export function rateLimitingFor(): number {
  return Math.max(0, Math.ceil((_rateLimitedUntil - Date.now()) / 1000))
}

// Deteksi 429 dari response am-reverse. Return false kalau tidak trip.
// Dipanggil SETELAH fetch selesai, sebelum normalize — layer pemanggil.
export function tripOnRateLimit(
  status: number,
  raw: unknown,
  headers: Headers,
  source: 'send' | 'verify',
): number | null {
  if (status !== 429) return null
  let retryAfter = 0

  const h = headers.get('retry-after')
  if (h) {
    const n = Number(h)
    if (Number.isFinite(n) && n > 0) retryAfter = n
  }

  if (!retryAfter && raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    const ra = r['retryAfter'] ?? r['retry_after'] ?? r['retry-after']
    if (typeof ra === 'number' && ra > 0) retryAfter = ra
    if (!retryAfter) {
      const msg = typeof r['message'] === 'string' ? r['message'] : ''
      if (/rate limit|too many|slow down/i.test(msg)) retryAfter = 60
    }
  }

  if (retryAfter <= 0) retryAfter = 60
  _rateLimitedUntil = Date.now() + retryAfter * 1000
  _rateLimitedRetryAfter = retryAfter

  // Sliding 1 jam.
  const now = Date.now()
  if (now - _tripWindowStart > 3600000) {
    _tripWindowStart = now
    _tripCount = 0
  }
  _tripCount++
  console.log(`[rate-limit] trip, retryAfter=${retryAfter}s, source=${source}`)
  return retryAfter
}

export function rateLimitTripsThisHour(): number {
  const now = Date.now()
  if (now - _tripWindowStart > 3600000) return 0
  return _tripCount
}

export function resetRateLimit(): void {
  _rateLimitedUntil = 0
  _rateLimitedRetryAfter = 0
  _tripCount = 0
}