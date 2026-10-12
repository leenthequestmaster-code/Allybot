import * as cheerio from "cheerio"
import { scrapeMediaFire } from "../scrapr-core/mediafire.js"
import { scrapeSfile } from "../scrapr-core/sfile.js"

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

function extractCleanUrl(text: string): string {
  if (!text || typeof text !== "string") return ""
  const match = text.match(/https?:\/\/[^\s]+/i)
  let clean = match ? match[0] : text.trim()
  if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
    clean = "https://" + clean
  }
  return clean
}

function extractUnlockedLink(html: string): { title: string; unlockedUrl: string } | null {
  const $ = cheerio.load(html)

  const nextDataScript = $("#__NEXT_DATA__").html()
  if (nextDataScript) {
    try {
      const parsed = JSON.parse(nextDataScript)
      const sinkData = parsed?.props?.pageProps?.sink?.data
      if (sinkData?.unlocked_link) {
        return {
          title: sinkData.title || "Sub2Unlock Link",
          unlockedUrl: sinkData.unlocked_link,
        }
      }
    } catch {}
  }

  const rawMatch = html.match(
    /["'](?:unlocked_link|destination|target_link|unlockedUrl)["']\s*:\s*["'](https?:\/\/[^"']+)["']/i
  )
  if (rawMatch) {
    return {
      title: $("title").text().trim() || "Sub2Unlock Link",
      unlockedUrl: rawMatch[1].replace(/\\\//g, "/"),
    }
  }

  const atobMatch = html.match(/atob\(["']([A-Za-z0-9+/=]{16,})["']\)/)
  if (atobMatch) {
    try {
      const decoded = Buffer.from(atobMatch[1], "base64").toString("utf-8")
      if (/^https?:\/\//i.test(decoded)) {
        return {
          title: $("title").text().trim() || "Sub2Unlock Link",
          unlockedUrl: decoded,
        }
      }
    } catch {}
  }

  const btnLink = $(
    "a#btn-download, a.unlocked-btn, a[href*='mediafire.com'], a[href*='drive.google.com']"
  ).attr("href")
  if (btnLink && /^https?:\/\//i.test(btnLink)) {
    return {
      title: $("title").text().trim() || "Sub2Unlock Link",
      unlockedUrl: btnLink,
    }
  }

  return null
}

export async function resolveSub2Unlock(url: string, autoResolveFiles = true): Promise<any> {
  const cleanUrl = extractCleanUrl(url)
  let targetFetchUrl = cleanUrl

  let res: Response
  try {
    res = await fetch(targetFetchUrl, {
      headers: {
        "User-Agent": DEFAULT_UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    if (cleanUrl.includes("sub2unlock.com")) {
      targetFetchUrl = cleanUrl.replace("sub2unlock.com", "sub2unlock.io")
      res = await fetch(targetFetchUrl, {
        headers: {
          "User-Agent": DEFAULT_UA,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      })
    } else {
      throw e
    }
  }

  const html = await res.text()
  const extracted = extractUnlockedLink(html)

  if (!extracted || !extracted.unlockedUrl) {
    throw new Error("Could not find unlocked target link on Sub2Unlock page.")
  }

  const destinationUrl = extracted.unlockedUrl
  let directFile: any = undefined

  if (autoResolveFiles) {
    if (/https?:\/\/(?:www\.)?mediafire\.com\//i.test(destinationUrl)) {
      try {
        const mf = await scrapeMediaFire(destinationUrl)
        directFile = {
          filename: mf.filename,
          size: mf.size,
          url: mf.url,
        }
      } catch {}
    } else if (/https?:\/\/(?:www\.)?sfile\.(?:co|mobi)\//i.test(destinationUrl)) {
      try {
        const sf = await scrapeSfile(destinationUrl)
        directFile = {
          filename: sf.filename,
          size: sf.size,
          url: sf.url,
        }
      } catch {}
    }
  }

  return {
    originalUrl: cleanUrl,
    destinationUrl,
    hops: [cleanUrl, destinationUrl],
    directFile,
  }
}
