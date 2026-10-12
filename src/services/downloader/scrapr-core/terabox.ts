import { safeFetch as fetch, assertPublicHttpUrl } from "../safe-fetch.js"
export interface TeraBoxResult {
  readonly title: string
  readonly thumbnail?: string
  readonly downloads: readonly {
    readonly type: "video" | "file"
    readonly filename: string
    readonly size: string
    readonly url: string
  }[]
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

export async function scrapeTeraBox(url: string): Promise<TeraBoxResult> {
  const parsed = await assertPublicHttpUrl(extractCleanUrl(url))
  if (!/(^|\.)(?:terabox\.app|terabox\.com|1024tera\.com|freeterabox\.com|4shared\.com)$/.test(parsed.hostname)) throw new Error("Invalid TeraBox hostname")
  const cleanUrl = parsed.href
  const apiUrl = "https://sechno.com/api/terabox"

  const res = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      Referer: "https://sechno.com/tools/terabox-downloader",
    },
    body: JSON.stringify({ url: cleanUrl }),
    signal: AbortSignal.timeout(20_000),
  })

  if (!res.ok) {
    throw new Error(`TeraBox API returned status ${res.status}`)
  }

  const data = (await res.json()) as any
  if (!data || !data.success) {
    throw new Error(data?.error || "Failed to resolve TeraBox link.")
  }

  const title = data.title || "TeraBox Shared Files"
  const files = Array.isArray(data.files) ? data.files : []
  if (files.length === 0) {
    throw new Error("No files found in TeraBox share.")
  }

  const downloads: { type: "video" | "file"; filename: string; size: string; url: string }[] = []

  files.forEach((f: any) => {
    if (f.isDir) return

    if (f.downloadUrl) {
      downloads.push({
        type: "file",
        filename: f.filename,
        size: f.sizeFormatted || `${f.size} B`,
        url: f.downloadUrl,
      })
    }

    if (f.streamUrl) {
      downloads.push({
        type: "video",
        filename: f.filename,
        size: f.sizeFormatted || `${f.size} B`,
        url: f.streamUrl,
      })
    }
  })

  const firstThumb = files.find((f: any) => f.thumbUrl)?.thumbUrl

  return {
    title,
    thumbnail: firstThumb,
    downloads,
  }
}
