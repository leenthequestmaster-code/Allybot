import { safeFetch as fetch } from "../safe-fetch.js"
import * as cheerio from "cheerio"

export interface PinterestResult {
  readonly title: string
  readonly thumbnail?: string
  readonly type: "video" | "image"
  readonly downloads: readonly { quality: string; type: "video" | "image"; url: string }[]
}

const isSiteAsset = (u: string) =>
  u.includes("s.pinimg.com") ||
  u.includes("/avatars/") ||
  u.includes("/profile/") ||
  u.includes("sprite") ||
  u.includes("favicon") ||
  u.includes("placeholder")

export async function scrapePinterest(url: string): Promise<PinterestResult> {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    throw new Error(`Pinterest returned status ${res.status}`)
  }

  const html = await res.text()

  let title = "Pinterest Pin"
  const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)
  if (ogTitle && ogTitle[1]) {
    title = ogTitle[1].replace(/\s*\|\s*Pinterest$/i, "").trim()
  }

  const downloads: { quality: string; type: "video" | "image"; url: string }[] = []
  const videoMatches =
    html.match(
      /https:\/\/(?:v1\.pinimg\.com|7\.pinimg\.com|v\.pinimg\.com)\/[^"'\s]+\.mp4/gi
    ) ||
    html.match(/https:\/\/[^"'\s]+\.mp4[^\s"']*/gi) ||
    []

  let rawImageMatches =
    html.match(
      /https:\/\/i\.pinimg\.com\/originals\/[a-zA-Z0-9\/._-]+\.(?:jpg|jpeg|png|webp)/gi
    ) || []

  if (rawImageMatches.length === 0) {
    rawImageMatches =
      html.match(
        /https:\/\/i\.pinimg\.com\/736x\/[a-zA-Z0-9\/._-]+\.(?:jpg|jpeg|png|webp)/gi
      ) || []
  }

  const uniqueVideos = [...new Set(videoMatches)]
  const uniqueImages = [...new Set(rawImageMatches.filter((u) => !isSiteAsset(u)))]

  uniqueVideos.forEach((vUrl) => {
    downloads.push({ quality: "HD Video", type: "video", url: vUrl })
  })
  uniqueImages.forEach((iUrl) => {
    downloads.push({ quality: "Original Image", type: "image", url: iUrl })
  })

  if (downloads.length === 0) {
    throw new Error("Could not find pin media links directly from Pinterest.")
  }

  return {
    title,
    thumbnail: uniqueImages[0] || (uniqueVideos[0] ? downloads[0].url : undefined),
    type: uniqueVideos.length > 0 ? "video" : "image",
    downloads,
  }
}
