/**
 * Downloader adapter contract types.
 * @module services/downloader/types
 */

/** Options passed to adapter resolve */
export interface ResolveOptions {
  readonly quality?: 'hd' | 'sd'
  readonly maxSizeMB?: number
}

/** A single downloadable media item */
export interface MediaItem {
  readonly url: string
  readonly mime: string
  readonly ext: string
  readonly size: number | null
  /** Optional in-memory payload — avoid holding large files; prefer streaming/url. Enforce maxSizeMB from ResolveOptions. */
  readonly buffer?: Uint8Array
}

/** Result of resolving a URL */
export interface ResolveResult {
  readonly type: 'video' | 'image' | 'carousel' | 'audio' | 'search'
  readonly title: string
  readonly author: string
  readonly thumbnail: string | null
  readonly media: readonly MediaItem[]
  readonly meta: Record<string, unknown>
}

/** YouTube / SoundCloud search result */
export interface SearchResult {
  readonly title: string
  readonly channel?: string
  readonly duration?: string
  readonly url: string
  readonly thumbnail?: string
}

/** Contract every platform adapter must implement */
export interface DownloaderAdapter {
  readonly name: string
  readonly match: RegExp | null
  resolve(url: string, opts?: ResolveOptions): Promise<ResolveResult>
  postProcess?(media: MediaItem, opts?: ResolveOptions): Promise<MediaItem>
}
