/**
 * Per-adapter metrics monitor.
 * @module services/downloader/monitor
 */

export interface AdapterMetrics {
  total: number
  success: number
  fail: number
  avgLatencyMs: number
  lastError?: string
  lastErrorAt?: number
}

export class Monitor {
  private metrics = new Map<string, {
    total: number
    success: number
    fail: number
    totalLatency: number
    lastError?: string
    lastErrorAt?: number
  }>()

  record(adapter: string, success: boolean, latencyMs: number, error?: string): void {
    let m = this.metrics.get(adapter)
    if (!m) {
      m = { total: 0, success: 0, fail: 0, totalLatency: 0 }
      this.metrics.set(adapter, m)
    }
    m.total++
    m.totalLatency += latencyMs
    if (success) {
      m.success++
    } else {
      m.fail++
      if (error) {
        m.lastError = error
        m.lastErrorAt = Date.now()
      }
    }
  }

  getMetrics(adapter?: string): Record<string, AdapterMetrics> {
    const result: Record<string, AdapterMetrics> = {}
    const entries = adapter
      ? ([[adapter, this.metrics.get(adapter)] as const].filter(([, v]) => v !== undefined))
      : this.metrics.entries()

    for (const [name, m] of entries) {
      if (!m) continue
      result[name] = {
        total: m.total,
        success: m.success,
        fail: m.fail,
        avgLatencyMs: m.total > 0 ? Math.round(m.totalLatency / m.total) : 0,
        lastError: m.lastError,
        lastErrorAt: m.lastErrorAt,
      }
    }
    return result
  }

  reset(): void {
    this.metrics.clear()
  }
}
