/**
 * Downloader service: framework Service wrapper around the downloader facade.
 * @module services/downloader-service
 */

import type { Logger } from 'pino'
import { DownloaderCache } from './downloader/cache.js'
import { Monitor } from './downloader/monitor.js'
import {
  detectPlatform,
  resolveDownload,
  resolveWith,
  getAdapters,
  getCircuitStates,
  searchYouTube,
  searchSoundCloud,
  CircuitOpenError,
} from './downloader/index.js'
import type { ResolveOptions, ResolveResult, SearchResult } from './downloader/types.js'

/** ServiceContext subset to avoid importing framework internals */
interface ServiceContext {
  readonly logger: Logger
  readonly config: unknown
  readonly services: unknown
}

export class DownloaderService {
  readonly name = 'downloader' as const
  readonly dependencies = [] as const

  readonly cache = new DownloaderCache()
  readonly monitor = new Monitor()

  private logger: Logger | null = null

  async initialize(context: ServiceContext): Promise<void> {
    this.logger = context.logger.child({ service: 'downloader' })
    await this.cache.start(this.logger)
    this.logger.info('Downloader service initialized')
  }

  async shutdown(_context: ServiceContext): Promise<void> {
    this.cache.stop()
    this.logger?.info('Downloader service shut down')
  }

  async resolve(url: string, opts?: ResolveOptions): Promise<ResolveResult> {
    const adapter = detectPlatform(url)
    const adapterName = adapter?.name ?? 'unknown'
    const start = Date.now()

    try {
      const result = await resolveDownload(url, opts)
      this.monitor.record(adapterName, true, Date.now() - start)
      return result
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.monitor.record(adapterName, false, Date.now() - start, errMsg)
      throw err
    }
  }

  async resolveWith(adapterName: string, url: string, opts?: ResolveOptions): Promise<ResolveResult> {
    const start = Date.now()
    try {
      const result = await resolveWith(adapterName, url, opts)
      this.monitor.record(adapterName, true, Date.now() - start)
      return result
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.monitor.record(adapterName, false, Date.now() - start, errMsg)
      throw err
    }
  }

  async searchYouTube(query: string): Promise<SearchResult[]> {
    return searchYouTube(query)
  }

  async searchSoundCloud(query: string): Promise<SearchResult[]> {
    return searchSoundCloud(query)
  }

  getMetrics(adapter?: string) {
    return this.monitor.getMetrics(adapter)
  }

  getCircuitStates() {
    return getCircuitStates()
  }

  getAdapters() {
    return getAdapters()
  }
}
