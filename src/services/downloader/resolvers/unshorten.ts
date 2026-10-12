import { scrapeMediaFire } from "../scrapr-core/mediafire.js"
import { scrapeSfile } from "../scrapr-core/sfile.js"

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

export interface UnshortenResult {
  readonly originalUrl: string
  readonly destinationUrl: string
  readonly hops: readonly string[]
  readonly directFile?: {
    readonly filename: string
    readonly size: string
    readonly url: string
  }
}

function extractCleanUrl(text: string): string {
  if (!text || typeof text !== "string") return ""
  const match = text.match(/https?:\/\/[^\s]+/i)
  let clean = match ? match[0] : text.trim()
  if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
    clean = "https://" + clean
  }
  return clean
}

export async function resolveUnshorten(url: string, autoResolveFiles = true): Promise<UnshortenResult> {
  const initialUrl = extractCleanUrl(url)
  if (!initialUrl) throw new Error("Invalid URL provided.")

  let currentUrl = initialUrl
  const visited = new Set<string>()
  const hops: string[] = [currentUrl]
  const maxHops = 10

  for (let i = 0; i < maxHops; i++) {
    if (visited.has(currentUrl)) break
    visited.add(currentUrl)

    try {
      const res = await fetch(currentUrl, {
        method: "GET",
        headers: {
          "User-Agent": DEFAULT_UA,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      })

      const loc = res.headers.get("location")
      if (loc) {
        const nextUrl = new URL(loc, currentUrl).href
        currentUrl = nextUrl
        hops.push(currentUrl)
        continue
      }

      const html = await res.text()
      const metaRefresh = html.match(
        /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i
      )
      if (metaRefresh && metaRefresh[1]) {
        const nextUrl = new URL(metaRefresh[1].trim(), currentUrl).href
        currentUrl = nextUrl
        hops.push(currentUrl)
        continue
      }

      break
    } catch {
      break
    }
  }

  let directFile: UnshortenResult["directFile"] = undefined

  if (autoResolveFiles) {
    if (/https?:\/\/(?:www\.)?mediafire\.com\//i.test(currentUrl)) {
      try {
        const mf = await scrapeMediaFire(currentUrl)
        directFile = {
          filename: mf.filename,
          size: mf.size,
          url: mf.url,
        }
      } catch {}
    } else if (/https?:\/\/(?:www\.)?sfile\.(?:co|mobi)\//i.test(currentUrl)) {
      try {
        const sf = await scrapeSfile(currentUrl)
        directFile = {
          filename: sf.filename,
          size: sf.size,
          url: sf.url,
        }
      } catch {}
    }
  }

  return {
    originalUrl: initialUrl,
    destinationUrl: currentUrl,
    hops,
    directFile,
  }
}
