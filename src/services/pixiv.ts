/**
 * Pixiv App API Service for Allybot
 * Integrates with Pixiv mobile App API via OAuth refresh_token.
 * Uses i.pixiv.re proxy for hotlinking images and zero external dependencies.
 */

export interface PixivItem {
  readonly id: string
  readonly title: string
  readonly author: string
  readonly tags: readonly string[]
  readonly imageUrls: readonly string[]
  readonly pageCount: number
}

export interface PixivSearchResult {
  readonly items: readonly PixivItem[]
  readonly nextPage: string | null
}

export class PixivError extends Error {
  constructor(message: string, public readonly code?: string | number) {
    super(message)
    this.name = 'PixivError'
  }
}

const CLIENT_ID = 'MOBrBDS8blbauoSck0ZfDbtuzpyT'
const CLIENT_SECRET = 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj'
const AUTH_TOKEN_URL = 'https://oauth.secure.pixiv.net/auth/token'
const API_BASE = 'https://app-api.pixiv.net'
const API_USER_AGENT = 'PixivIOSApp/7.13.3 (iOS 14.6; iPhone13,2)'

export function proxyImageUrl(url: string): string {
  return url.replace(/i\.pximg\.net/g, 'i.pixiv.re')
}

export class AppPixivAPI {
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private tokenExpiresAt = 0
  private authPromise: Promise<void> | null = null

  constructor(refreshToken?: string) {
    this.refreshToken = refreshToken || process.env.PIXIV_REFRESH_TOKEN || null
  }

  setRefreshToken(token: string | null): void {
    this.refreshToken = token
    this.accessToken = null
    this.tokenExpiresAt = 0
  }

  getRefreshToken(): string | null {
    return this.refreshToken || process.env.PIXIV_REFRESH_TOKEN || null
  }

  async auth(): Promise<void> {
    const token = this.getRefreshToken()
    if (!token) {
      throw new PixivError('PIXIV_REFRESH_TOKEN tidak dikonfigurasi')
    }

    if (this.authPromise) return this.authPromise

    this.authPromise = (async () => {
      try {
        const body = new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: token,
          include_policy: 'true',
        })

        const res = await fetch(AUTH_TOKEN_URL, {
          method: 'POST',
          headers: {
            'User-Agent': API_USER_AGENT,
            'App-OS': 'ios',
            'App-OS-Version': '14.6',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(15_000),
        })

        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new PixivError(`Pixiv authentication failed (${res.status}): ${text}`, res.status)
        }

        const data = (await res.json()) as any
        if (!data.access_token) {
          throw new PixivError('No access_token returned by Pixiv OAuth')
        }

        this.accessToken = data.access_token
        if (data.refresh_token) {
          this.refreshToken = data.refresh_token
        }
        const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600
        this.tokenExpiresAt = Date.now() + (expiresIn - 60) * 1000
      } catch (err) {
        if (err instanceof PixivError) throw err
        throw new PixivError(`Gagal autentikasi Pixiv: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        this.authPromise = null
      }
    })()

    return this.authPromise
  }

  async ensureAuth(): Promise<string> {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      await this.auth()
    }
    return this.accessToken!
  }

  async searchIllust(query: string, page = 1): Promise<PixivSearchResult> {
    return this._executeSearchWithRetry(query, page, 0)
  }

  private async _executeSearchWithRetry(query: string, page: number, attempt: number): Promise<PixivSearchResult> {
    try {
      const token = await this.ensureAuth()
      const offset = Math.max(0, (page - 1) * 5)
      const params = new URLSearchParams({
        word: query,
        search_target: 'partial_match_for_tags',
        filter: 'for_android',
        offset: String(offset),
      })
      const searchUrl = `${API_BASE}/v1/search/illust?${params.toString()}`

      const res = await fetch(searchUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': API_USER_AGENT,
          'App-OS': 'ios',
          'App-OS-Version': '14.6',
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (res.status === 400 || res.status === 401 || res.status === 403) {
        const errorText = await res.text().catch(() => '')
        this.accessToken = null
        this.tokenExpiresAt = 0
        if (attempt < 1) {
          await this.auth()
          return this._executeSearchWithRetry(query, page, attempt + 1)
        }
        throw new PixivError(`Pixiv API auth error (${res.status}): ${errorText}`, res.status)
      }

      if (!res.ok) {
        const errorText = await res.text().catch(() => '')
        throw new PixivError(`Pixiv search error (${res.status}): ${errorText}`, res.status)
      }

      const data = (await res.json()) as any
      const rawIllusts: any[] = Array.isArray(data.illusts) ? data.illusts : []
      // Cap results to 5 per page for WA (bandwidth)
      const capped = rawIllusts.slice(0, 5)

      const items: PixivItem[] = capped.map((ill) => {
        const id = String(ill.id || '')
        const title = String(ill.title || '').trim() || 'Untitled'
        const author = String(ill.user?.name || ill.user?.account || 'Unknown')
        const tags: string[] = Array.isArray(ill.tags) ? ill.tags.map((t: any) => String(t.name || '')) : []
        const pageCount = typeof ill.page_count === 'number' ? ill.page_count : 1

        const imageUrls: string[] = []
        if (Array.isArray(ill.meta_pages) && ill.meta_pages.length > 0) {
          for (const p of ill.meta_pages) {
            const rawUrl = p.image_urls?.large || p.image_urls?.medium || p.image_urls?.original || ''
            if (rawUrl) imageUrls.push(proxyImageUrl(rawUrl))
          }
        } else {
          const rawUrl = ill.image_urls?.large || ill.image_urls?.medium || ill.meta_single_page?.original_image_url || ''
          if (rawUrl) imageUrls.push(proxyImageUrl(rawUrl))
        }

        return {
          id,
          title,
          author,
          tags,
          imageUrls,
          pageCount,
        }
      })

      const hasNext = (rawIllusts.length > 5) || Boolean(data.next_url)
      const nextPage = hasNext ? String(page + 1) : null

      return { items, nextPage }
    } catch (err) {
      if (err instanceof PixivError) throw err
      if (attempt < 1) {
        this.accessToken = null
        this.tokenExpiresAt = 0
        try {
          await this.auth()
          return this._executeSearchWithRetry(query, page, attempt + 1)
        } catch {
          // Fall through to raise typed error
        }
      }
      throw new PixivError(`Pixiv search error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

// Single AppPixivAPI instance, reused across bot lifecycle
export const pixivApi = new AppPixivAPI()

export async function searchIllust(query: string, page = 1): Promise<PixivSearchResult> {
  return pixivApi.searchIllust(query, page)
}

export async function fetchImage(
  url: string,
  options?: { logger?: { warn: (obj: any, msg: string) => void }; illustId?: string },
): Promise<Buffer | null> {
  const proxiedUrl = proxyImageUrl(url)
  try {
    const res = await fetch(proxiedUrl, {
      headers: {
        Referer: 'https://www.pixiv.net/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      if (options?.logger) {
        options.logger.warn({ id: options.illustId, status: res.status, url: proxiedUrl }, 'Non-200 response downloading Pixiv image')
      }
      return null
    }

    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (err) {
    if (options?.logger) {
      options.logger.warn({ id: options.illustId, error: err instanceof Error ? err.message : String(err) }, 'Failed to fetch Pixiv image')
    }
    return null
  }
}
