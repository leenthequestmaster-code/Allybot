/**
 * Downloader facade: adapter registry, platform detection, circuit breakers.
 * @module services/downloader/index
 */

import type { DownloaderAdapter, ResolveOptions, ResolveResult } from './types.js'
import { CircuitBreaker, CircuitOpenError } from './circuit.js'
import { assertPublicHttpUrl, MAX_MEDIA_BYTES } from './safe-fetch.js'

import { instagramAdapter } from './adapters/instagram.js'
import { facebookAdapter } from './adapters/facebook.js'
import { twitterAdapter } from './adapters/twitter.js'
import { threadsAdapter } from './adapters/threads.js'
import { redditAdapter } from './adapters/reddit.js'
import { pinterestAdapter } from './adapters/pinterest.js'
import { douyinAdapter } from './adapters/douyin.js'
import { bilibiliAdapter } from './adapters/bilibili.js'
import { rednoteAdapter } from './adapters/rednote.js'
import { bandcampAdapter } from './adapters/bandcamp.js'
import { mediafireAdapter } from './adapters/mediafire.js'
import { sfileAdapter } from './adapters/sfile.js'
import { soundcloudAdapter } from './adapters/soundcloud.js'
import { videyAdapter } from './adapters/videy.js'
import { pixeldrainAdapter } from './adapters/pixeldrain.js'
import { teraboxAdapter } from './adapters/terabox.js'

export { CircuitOpenError } from './circuit.js'
export type { DownloaderAdapter, ResolveOptions, ResolveResult, MediaItem, SearchResult } from './types.js'
export { searchYouTube } from './adapters/youtube-search.js'
export { searchSoundCloud } from './adapters/soundcloud.js'
export { resolveUnshorten } from './resolvers/unshorten.js'
export { resolveSafelinku } from './resolvers/safelinku.js'
export { resolveSub2Unlock } from './resolvers/sub2unlock.js'
export { resolveRekonise } from './resolvers/rekonise.js'
export { resolveBypass } from './resolvers/index.js'

/** All registered adapters (order matters for detection priority) */
const adapters: readonly DownloaderAdapter[] = [
  instagramAdapter,
  facebookAdapter,
  twitterAdapter,
  threadsAdapter,
  redditAdapter,
  pinterestAdapter,
  douyinAdapter,
  bilibiliAdapter,
  rednoteAdapter,
  bandcampAdapter,
  mediafireAdapter,
  sfileAdapter,
  soundcloudAdapter,
  videyAdapter,
  pixeldrainAdapter,
  teraboxAdapter,
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

/** Hostname allowlist is independent of adapter path regexes. */
const HOSTS: Record<string, readonly string[]> = {
  instagram: ['instagram.com'], facebook: ['facebook.com', 'fb.watch'],
  twitter: ['twitter.com', 'x.com'], threads: ['threads.net', 'threads.com'],
  reddit: ['reddit.com'], douyin: ['douyin.com', 'iesdouyin.com'],
  bilibili: ['bilibili.com', 'bilibili.tv'], rednote: ['xiaohongshu.com', 'xhslink.com', 'xhslink.cn', 'rednote.com'],
  bandcamp: ['bandcamp.com'], mediafire: ['mediafire.com'], sfile: ['sfile.co', 'sfile.mobi'],
  soundcloud: ['soundcloud.com'], videy: ['videy.co'], pixeldrain: ['pixeldrain.com'],
  terabox: ['terabox.app', 'terabox.com', '1024tera.com', 'freeterabox.com', '4shared.com'],
}
function hostMatches(adapter: string, host: string): boolean {
  if (adapter === 'pinterest') return /^(?:[a-z0-9-]+\.)?pinterest\.(?:com|[a-z]{2,3}(?:\.[a-z]{2})?)$/.test(host)
  return (HOSTS[adapter] ?? []).some(domain => host === domain || host.endsWith('.' + domain))
}
function parseInput(raw: string): URL | null {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url
  } catch { return null }
}
export function detectPlatform(raw: string): DownloaderAdapter | null {
  const url = parseInput(raw)
  if (!url) return null
  for (const adapter of adapters) {
    if (hostMatches(adapter.name, url.hostname) && adapter.match?.test(url.href)) return adapter
  }
  return null
}
export function boundedResolveOptions(opts?: ResolveOptions): ResolveOptions {
  const requested = opts?.maxSizeMB
  const maxSizeMB = requested !== undefined && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, MAX_MEDIA_BYTES / 1024 / 1024) : MAX_MEDIA_BYTES / 1024 / 1024
  return { ...opts, maxSizeMB }
}
export function enforceResultLimit(result: ResolveResult, opts: ResolveOptions): ResolveResult {
  const maxBytes = opts.maxSizeMB! * 1024 * 1024
  // MediaFire/Sfile expose known sizes as formatted metadata.
  const label = typeof result.meta?.size === 'string' ? result.meta.size.trim() : ''
  const match = /^(\d+(?:\.\d+)?)\s*(B|[KMGT](?:i)?B)$/i.exec(label)
  if (match && result.media.length === 1) {
    const exponent = 'BKMGT'.indexOf(match[2][0].toUpperCase())
    const knownBytes = Number(match[1]) * 1024 ** exponent
    if (knownBytes > maxBytes) throw new Error(`File melebihi batas ${opts.maxSizeMB} MB.`)
  }
  for (const item of result.media) {
    if ((item.size !== null && (!Number.isFinite(item.size) || item.size < 0 || item.size > maxBytes))
      || (item.buffer && item.buffer.byteLength > maxBytes)) throw new Error(`File melebihi batas ${opts.maxSizeMB} MB.`)
  }
  return result
}
export async function resolveDownload(url: string, opts?: ResolveOptions): Promise<ResolveResult> {
  const adapter = detectPlatform(url)
  if (!adapter) throw new Error('PLATFORM_UNSUPPORTED')
  const validated = await assertPublicHttpUrl(url)
  const limits = boundedResolveOptions(opts)
  return getBreaker(adapter.name).execute(async () => enforceResultLimit(await adapter.resolve(validated.href, limits), limits))
}
export async function resolveWith(adapterName: string, url: string, opts?: ResolveOptions): Promise<ResolveResult> {
  const adapter = adapters.find(a => a.name === adapterName)
  if (!adapter) throw new Error(`Adapter '${adapterName}' not found`)
  const parsed = parseInput(url)
  if (!parsed || !hostMatches(adapterName, parsed.hostname)) throw new Error('PLATFORM_UNSUPPORTED')
  const validated = await assertPublicHttpUrl(url)
  const limits = boundedResolveOptions(opts)
  return getBreaker(adapter.name).execute(async () => enforceResultLimit(await adapter.resolve(validated.href, limits), limits))
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
