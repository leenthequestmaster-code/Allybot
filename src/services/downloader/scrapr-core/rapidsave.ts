import * as cheerio from "cheerio"

export interface RapidSaveResult {
  readonly title: string
  readonly thumbnail?: string
  readonly videoUrl: string
  readonly audioUrl?: string
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

async function resolveCanonicalUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    const loc = res.headers.get("location")
    if (loc) return loc
  } catch {}
  return url
}

export async function scrapeRapidSave(url: string): Promise<RapidSaveResult> {
  const cleanUrl = extractCleanUrl(url)
  let targetUrl = cleanUrl
  if (cleanUrl.includes("/s/")) {
    targetUrl = await resolveCanonicalUrl(cleanUrl)
  }

  const rapidUrl = `https://rapidsave.com/info?url=${encodeURIComponent(targetUrl)}`
  const res = await fetch(rapidUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      Referer: "https://rapidsave.com/",
    },
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    throw new Error(`RapidSave returned HTTP ${res.status}`)
  }

  const html = await res.text()

  const dlMatch =
    html.match(/class="downloadbutton"[^>]*href="([^"]+)"/i) ||
    html.match(/href="([^"]*sd\.rapidsave\.com\/download\.php[^"]*)"/i) ||
    html.match(/href="([^"]*download[^"]*)"/i)

  if (!dlMatch) {
    if (html.includes("alert-info") && html.includes("Reddit is limiting")) {
      throw new Error("Reddit is limiting upstream access on RapidSave.")
    }
    throw new Error("Could not extract video download link from RapidSave.")
  }

  let title = "Reddit Video"
  const titleMatch =
    html.match(/class="text-center">([^<]+)<\/p>/i) ||
    html.match(/<h2>([\s\S]*?)<\/h2>/i) ||
    html.match(/<strong>([\s\S]*?)<\/strong>/i)

  if (titleMatch && titleMatch[1].trim()) {
    title = titleMatch[1].trim()
  } else {
    const slugMatch = targetUrl.match(/comments\/[^\/]+\/([^\/\?#]+)/)
    if (slugMatch && slugMatch[1]) {
      title = decodeURIComponent(slugMatch[1].replace(/_/g, " "))
    }
  }

  const thumbMatch = html.match(/<img[^>]+src="([^">]*thumbs\.rapidsave\.com[^">]*)"/i)
  const thumbnail = thumbMatch ? thumbMatch[1] : undefined

  const videoUrl = dlMatch[1].replace(/&amp;/g, "&")

  let audioUrl: string | undefined = undefined
  try {
    const parsed = new URL(videoUrl)
    const audioParam = parsed.searchParams.get("audio_url")
    if (audioParam && audioParam.startsWith("http")) {
      audioUrl = audioParam
    }
  } catch {}

  return {
    title,
    thumbnail,
    videoUrl,
    audioUrl,
  }
}
