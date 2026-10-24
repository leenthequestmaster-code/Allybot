/**
 * @module opengraph-extractor
 * Resilient OpenGraph and HTML metadata scraper powered by cheerio.
 * Extracts Title, Description, Image/Thumbnail, Site Name, and Canonical URL.
 */

import * as cheerio from 'cheerio'

export interface OpenGraphMetadata {
  readonly title?: string
  readonly description?: string
  readonly image?: string
  readonly siteName?: string
  readonly url?: string
  readonly favicon?: string
}

/**
 * Parses raw HTML string and extracts OpenGraph and Twitter Card metadata.
 */
export function parseOpenGraphHtml(html: string, baseUrl?: string): OpenGraphMetadata {
  if (!html || html.length < 10) return {}

  const $ = cheerio.load(html)

  // 1. Title: og:title -> twitter:title -> <title>
  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('meta[name="twitter:title"]').attr('content')?.trim() ||
    $('title').first().text().trim() ||
    undefined

  // 2. Description: og:description -> twitter:description -> meta description
  const description =
    $('meta[property="og:description"]').attr('content')?.trim() ||
    $('meta[name="twitter:description"]').attr('content')?.trim() ||
    $('meta[name="description"]').attr('content')?.trim() ||
    undefined

  // 3. Image: og:image -> twitter:image -> link image_src
  let image =
    $('meta[property="og:image"]').attr('content')?.trim() ||
    $('meta[name="twitter:image"]').attr('content')?.trim() ||
    $('link[rel="image_src"]').attr('href')?.trim() ||
    undefined

  // Resolve relative image URL if baseUrl is provided
  if (image && baseUrl && !/^https?:\/\//i.test(image)) {
    try {
      image = new URL(image, baseUrl).href
    } catch {}
  }

  // 4. Site Name
  const siteName =
    $('meta[property="og:site_name"]').attr('content')?.trim() ||
    $('meta[name="application-name"]').attr('content')?.trim() ||
    undefined

  // 5. Canonical URL
  const url =
    $('meta[property="og:url"]').attr('content')?.trim() ||
    $('link[rel="canonical"]').attr('href')?.trim() ||
    baseUrl ||
    undefined

  // 6. Favicon
  let favicon =
    $('link[rel="icon"]').attr('href')?.trim() ||
    $('link[rel="shortcut icon"]').attr('href')?.trim() ||
    undefined

  if (favicon && baseUrl && !/^https?:\/\//i.test(favicon)) {
    try {
      favicon = new URL(favicon, baseUrl).href
    } catch {}
  }

  return {
    title,
    description,
    image,
    siteName,
    url,
    favicon,
  }
}

/**
 * Fetches and parses OpenGraph metadata from a public URL with timeout and size cap.
 */
export async function fetchOpenGraphMetadata(
  url: string,
  timeoutMs = 8_000,
): Promise<OpenGraphMetadata> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 (compatible; Allybot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
    clearTimeout(timer)

    if (!res.ok) return { url }

    // Read at most 512KB of HTML header to save memory and time
    const text = await res.text()
    const headChunk = text.slice(0, 512 * 1024)
    return parseOpenGraphHtml(headChunk, url)
  } catch {
    return { url }
  }
}
