/**
 * Dual-layer cache: in-memory metadata + disk-based file cache.
 * @module services/downloader/cache
 */

import { readdir, readFile, writeFile, unlink, stat, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from 'pino'

const METADATA_TTL_MS = 6 * 60 * 60_000        // 6 hours
const METADATA_MAX_ENTRIES = 500
const FILE_TTL_MS = 24 * 60 * 60_000           // 24 hours
const FILE_CAP_BYTES = 5 * 1024 ** 3           // 5 GB
const GC_INTERVAL_MS = 6 * 60 * 60_000        // 6 hours

const CACHE_DIR = join(process.cwd(), 'data', 'dl_cache')

interface MetadataEntry {
  value: unknown
  expiresAt: number
}

export interface CacheStats {
  metadataEntries: number
  fileCount: number
  fileSizeBytes: number
}

export class DownloaderCache {
  private metadata = new Map<string, MetadataEntry>()
  private gcTimer: ReturnType<typeof setInterval> | null = null
  private logger: Logger | null = null

  async start(logger?: Logger): Promise<void> {
    this.logger = logger ?? null
    await mkdir(CACHE_DIR, { recursive: true })
    this.gcTimer = setInterval(() => void this.gc(), GC_INTERVAL_MS)
    // Don't prevent process exit
    if (this.gcTimer.unref) this.gcTimer.unref()
  }

  stop(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer)
      this.gcTimer = null
    }
  }

  /* ── Metadata (in-memory) ── */

  getMetadata<T = unknown>(key: string): T | null {
    const entry = this.metadata.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      this.metadata.delete(key)
      return null
    }
    return entry.value as T
  }

  setMetadata(key: string, value: unknown): void {
    // Evict oldest if at capacity
    if (this.metadata.size >= METADATA_MAX_ENTRIES) {
      const oldest = this.metadata.keys().next().value
      if (oldest !== undefined) this.metadata.delete(oldest)
    }
    this.metadata.set(key, { value, expiresAt: Date.now() + METADATA_TTL_MS })
  }

  /* ── File (disk) ── */

  async getFile(key: string): Promise<Buffer | null> {
    try {
      const files = await readdir(CACHE_DIR)
      const match = files.find(f => f.startsWith(key + '.'))
      if (!match) return null
      const filepath = join(CACHE_DIR, match)
      const info = await stat(filepath)
      if (Date.now() - info.mtimeMs > FILE_TTL_MS) {
        await unlink(filepath).catch(() => {})
        return null
      }
      return await readFile(filepath)
    } catch {
      return null
    }
  }

  async setFile(key: string, buffer: Buffer, ext: string): Promise<string> {
    await mkdir(CACHE_DIR, { recursive: true })
    const filename = `${key}.${ext}`
    const filepath = join(CACHE_DIR, filename)
    await writeFile(filepath, buffer)
    return filepath
  }

  /* ── Garbage collection ── */

  async gc(): Promise<void> {
    this.logger?.debug('dl-cache: running GC')

    // Metadata GC
    const now = Date.now()
    for (const [k, v] of this.metadata) {
      if (now > v.expiresAt) this.metadata.delete(k)
    }

    // File GC – evict expired, then oldest until under cap
    try {
      const files = await readdir(CACHE_DIR)
      const entries: { name: string; path: string; size: number; mtime: number }[] = []

      for (const name of files) {
        const filepath = join(CACHE_DIR, name)
        try {
          const info = await stat(filepath)
          if (now - info.mtimeMs > FILE_TTL_MS) {
            await unlink(filepath).catch(() => {})
          } else {
            entries.push({ name, path: filepath, size: info.size, mtime: info.mtimeMs })
          }
        } catch { /* skip */ }
      }

      // Sort oldest first, evict until under cap
      entries.sort((a, b) => a.mtime - b.mtime)
      let totalSize = entries.reduce((s, e) => s + e.size, 0)
      while (totalSize > FILE_CAP_BYTES && entries.length > 0) {
        const oldest = entries.shift()!
        await unlink(oldest.path).catch(() => {})
        totalSize -= oldest.size
      }

      this.logger?.debug({ metadataEntries: this.metadata.size, fileCount: entries.length, totalSize }, 'dl-cache: GC done')
    } catch (err) {
      this.logger?.warn({ err }, 'dl-cache: GC error')
    }
  }

  async stats(): Promise<CacheStats> {
    let fileCount = 0
    let fileSizeBytes = 0
    try {
      const files = await readdir(CACHE_DIR)
      for (const name of files) {
        try {
          const info = await stat(join(CACHE_DIR, name))
          fileCount++
          fileSizeBytes += info.size
        } catch { /* skip */ }
      }
    } catch { /* dir may not exist */ }

    return {
      metadataEntries: this.metadata.size,
      fileCount,
      fileSizeBytes,
    }
  }
}
