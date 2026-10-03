/**
 * Downloader facade: adapter registry, platform detection, circuit breakers.
 * @module services/downloader/index
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult } from './types.js'
import { CircuitBreaker, CircuitOpenError } from './circuit.js'

import { instagramAdapter } from './adapters/instagram.js'
import { facebookAdapter } from './adapters/facebook.js'
import { twitterAdapter } from './adapters/twitter.js'
import { threadsAdapter } from './adapters/threads.js'
import { soundcloudAdapter } from './adapters/soundcloud.js'
import { videyAdapter } from './adapters/videy.js'
import { pixeldrainAdapter } from './adapters/pixeldrain.js'

export { CircuitOpenError } from './circuit.js'
export type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem, SearchResult } from './types.js'
export { searchYouTube } from './adapters/youtube-search.js'
export { searchSoundCloud } from './adapters/soundcloud.js'

/** All registered adapters (order matters for detection priority) */
const adapters: readonly DownloaderAdapter[] = [
  instagramAdapter,
  facebookAdapter,
  twitterAdapter,
  threadsAdapter,
  soundcloudAdapter,
  videyAdapter,
  pixeldrainAdapter,
] as const

/** Per-adapter circuit breakers */
const breakers = new Map<string, CircuitBreaker>()

function getBreaker(name: string): CircuitBreaker {
  let cb = breakers.get(name)
  if (!cb) {
    cb = new CircuitBreaker()
    breakers.set(name, cb)
  }
  return cb
}

/** Detect which adapter can handle a URL. Returns null if none match. */
export function detectPlatform(url: string): DownloaderAdapter | null {
  for (const adapter of adapters) {
    if (adapter.match && adapter.match.test(url)) {
      return adapter
    }
  }
  return null
}

/** Resolve a URL through its matched adapter + circuit breaker. */
export async function resolveDownload(
  url: string,
  opts?: ResolveOptions,
): Promise<ResolveResult> {
  const adapter = detectPlatform(url)
  if (!adapter) {
    throw new Error('PLATFORM_UNSUPPORTED')
  }

  const breaker = getBreaker(adapter.name)
  return breaker.execute(() => adapter.resolve(url, opts))
}

/** Resolve through a specific adapter by name (bypasses URL matching). */
export async function resolveWith(
  adapterName: string,
  url: string,
  opts?: ResolveOptions,
): Promise<ResolveResult> {
  const adapter = adapters.find(a => a.name === adapterName)
  if (!adapter) {
    throw new Error(`Adapter '${adapterName}' not found`)
  }

  const breaker = getBreaker(adapter.name)
  return breaker.execute(() => adapter.resolve(url, opts))
}

/** Get the full adapter list (for display / stats). */
export function getAdapters(): readonly DownloaderAdapter[] {
  return adapters
}

/** Get circuit breaker state for a specific adapter or all. */
export function getCircuitStates(): Record<string, ReturnType<CircuitBreaker['getState']>> {
  const states: Record<string, ReturnType<CircuitBreaker['getState']>> = {}
  for (const adapter of adapters) {
    const cb = breakers.get(adapter.name)
    states[adapter.name] = cb ? cb.getState() : { state: 'closed', failures: 0, lastFailure: null, openUntil: null }
  }
  return states
}
