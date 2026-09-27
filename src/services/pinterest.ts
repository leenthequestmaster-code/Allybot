/**
 * Pinterest Resource API Service for Allybot
 * Searches Pinterest and fetches image buffers with zero external dependencies.
 */

export interface PinterestPin {
  readonly id: string
  readonly title: string
  readonly author: string
  readonly imageUrl: string
  readonly mediaType: string
  readonly videoUrl?: string | null
}

const RESOURCE_URL = 'https://www.pinterest.com/resource/BaseSearchResource/get/'
const FETCH_HEADERS = {
  'Referer': 'https://www.pinterest.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/javascript, */*, q=0.01',
  'X-Requested-With': 'XMLHttpRequest',
  'X-Pinterest-PWS-Handler': 'www/[username]/search/pins.js',
}

export interface PinterestSearchOptions {
  readonly limit?: number
  readonly randomize?: boolean
}

export async function searchPinterest(
  query: string,
  options?: PinterestSearchOptions | number,
): Promise<PinterestPin[]> {
  const opts: PinterestSearchOptions = typeof options === 'number' ? { limit: options } : (options || {})
  const limit = opts.limit || 5
  const shouldRandomize = Boolean(opts.randomize)
  const pageSize = shouldRandomize ? 25 : Math.min(Math.max(1, limit), 25)
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}`
  const searchOptions = {
    query,
    scope: 'pins',
    page_size: pageSize,
    bookmarks: [],
  }

  const params = new URLSearchParams({
    source_url: sourceUrl,
    data: JSON.stringify({ options: searchOptions, context: {} }),
  })

  const url = `${RESOURCE_URL}?${params.toString()}`

  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    throw new Error(`Pinterest search failed (HTTP ${res.status})`)
  }

  const data = (await res.json()) as any
  const resourceResponse = data?.resource_response

  if (resourceResponse?.status !== 'success') {
    const errorMsg = resourceResponse?.message || resourceResponse?.error?.message || 'Unknown Pinterest API error'
    throw new Error(`Pinterest search error: ${errorMsg}`)
  }

  let results: any[] = Array.isArray(resourceResponse?.data?.results) ? resourceResponse.data.results : []

  if (shouldRandomize && results.length > 1) {
    for (let i = results.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[results[i], results[j]] = [results[j], results[i]]
    }
  }

  const out: PinterestPin[] = []

  for (const pin of results) {
    if (!pin || typeof pin !== 'object') continue
    const pinId = String(pin.id || '')
    if (!pinId) continue

    const images = pin.images || {}
    let orig: string | undefined = images.orig?.url

    if (!orig) {
      for (const size of ['736x', '474x', '236x', '170x']) {
        if (images[size]?.url) {
          orig = images[size].url
          break
        }
      }
    }

    if (!orig) continue

    const title = String(pin.title || pin.grid_title || pin.description || '').trim()
    const pinner = pin.pinner || pin.author || {}
    const author = String(pinner.username || pinner.full_name || '').trim()
    const mediaType = String(pin.media_type || (pin.videos ? 'video' : 'image'))

    out.push({
      id: pinId,
      title,
      author,
      imageUrl: orig,
      mediaType,
    })
  }

  return out
}

export async function fetchBuffer(
  url: string,
  timeoutMs = 15_000,
  options?: { logger?: { warn: (obj: any, msg: string) => void }; pinId?: string },
): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Referer: 'https://www.pinterest.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })

    if (!res.ok) {
      if (options?.logger) {
        options.logger.warn({ id: options.pinId, status: res.status, url }, 'Non-200 response fetching Pinterest image')
      }
      return null
    }

    const arrayBuffer = await res.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (err) {
    if (options?.logger) {
      options.logger.warn({ id: options.pinId, error: err instanceof Error ? err.message : String(err), url }, 'Failed to fetch Pinterest image buffer')
    }
    return null
  }
}
