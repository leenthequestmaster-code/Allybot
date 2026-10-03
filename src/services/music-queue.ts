import type { Config } from './music-config.js'

interface InflightEntry<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

interface QueueItem {
  key: string
  fn: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

// Active running jobs (key → promise)
const inflight = new Map<string, InflightEntry<unknown>>()
// FIFO queue when at concurrency cap
const waitQueue: QueueItem[] = []
// Count of truly active (running) jobs
let activeCount = 0

// ─── Internal runner ──────────────────────────────────────────────────────────

async function runJob(key: string, fn: () => Promise<unknown>): Promise<unknown> {
  activeCount++
  try {
    const result = await fn()
    return result
  } finally {
    activeCount--
    inflight.delete(key)
    drainQueue()
  }
}

function drainQueue(): void {
  if (waitQueue.length === 0) return
  // We'll drain up to whatever headroom we have (config captured per-item)
  const item = waitQueue.shift()
  if (!item) return

  const promise = runJob(item.key, item.fn)
  promise.then(item.resolve, item.reject)
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function runOnce<T>(key: string, fn: () => Promise<T>, config: Config): Promise<T> {
  // Dedup: if same key is already in-flight, return its promise
  const existing = inflight.get(key)
  if (existing) return existing.promise as Promise<T>

  if (activeCount < config.max_concurrent) {
    // Slot available — run immediately
    let resolveFn!: (value: T) => void
    let rejectFn!: (reason: unknown) => void
    const outerPromise = new Promise<T>((res, rej) => {
      resolveFn = res
      rejectFn = rej
    })

    const entry: InflightEntry<unknown> = {
      promise: outerPromise as Promise<unknown>,
      resolve: (v: unknown) => resolveFn(v as T),
      reject: rejectFn,
    }
    inflight.set(key, entry)

    const jobPromise = runJob(key, fn as () => Promise<unknown>)
    jobPromise.then((v) => resolveFn(v as T), rejectFn)

    return outerPromise
  } else {
    // Enqueue
    let resolveFn!: (value: unknown) => void
    let rejectFn!: (reason: unknown) => void
    const outerPromise = new Promise<T>((res, rej) => {
      resolveFn = res as (v: unknown) => void
      rejectFn = rej
    })

    waitQueue.push({ key, fn: fn as () => Promise<unknown>, resolve: resolveFn, reject: rejectFn })

    // Also track as in-flight for dedup purposes
    const entry: InflightEntry<unknown> = {
      promise: outerPromise as Promise<unknown>,
      resolve: resolveFn,
      reject: rejectFn,
    }
    inflight.set(key, entry)

    return outerPromise
  }
}

export function stats(): { active: number; waiting: number; inflight: number } {
  return {
    active: activeCount,
    waiting: waitQueue.length,
    inflight: inflight.size,
  }
}
