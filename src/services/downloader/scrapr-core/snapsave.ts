import * as cheerio from "cheerio"

export interface SnapSaveMedia {
  readonly quality: string
  readonly url: string
  readonly hasAudio: boolean
  readonly type: "video" | "image"
}

export interface SnapSaveResult {
  readonly title: string
  readonly thumbnail?: string
  readonly downloads: readonly SnapSaveMedia[]
}

function decodeSnapSave(data: string): string {
  try {
    const regex =
      /eval\(function\(h,u,n,t,e,r\)\{.*?\}\("(.*?)",(\d+),"(.*?)",(\d+),(\d+),(\d+)\)\)/
    const match = data.match(regex)

    if (match) {
      const h = match[1]
      const u = parseInt(match[2], 10)
      const n = match[3]
      const t = parseInt(match[4], 10)
      const e = parseInt(match[5], 10)

      const delimiter = n[e]
      const parts = h.split(delimiter)
      let decoded = ""

      for (const s of parts) {
        if (s === "") continue

        let val = 0
        for (let j = 0; j < s.length; j++) {
          val += n.indexOf(s[j]) * Math.pow(e, s.length - 1 - j)
        }

        decoded += String.fromCharCode(val - t)
      }

      return decodeURIComponent(escape(decoded))
    }
    return data
  } catch {
    return data
  }
}

function extractFinalUrl(input: string | null | undefined): { url: string; isRender: boolean } | null {
  if (!input) return null

  let raw = input.trim().replace(/^["'\\]+|["'\\]+$/g, "")
  let isRender = false

  if (raw.includes("get_progressApi")) {
    isRender = true
    const tokenMatch = raw.match(/token=([^&'"]+)/)
    if (tokenMatch) {
      raw = tokenMatch[1]
    }
  }

  if (raw.includes(".") && !raw.startsWith("http")) {
    try {
      const payloadPart = raw.split(".")[1]
      if (payloadPart) {
        const payload = JSON.parse(
          Buffer.from(payloadPart, "base64").toString()
        )
        if (payload.video_url) return { url: payload.video_url, isRender: true }
        if (payload.url) return { url: payload.url, isRender: false }
      }
    } catch {}
  }

  if (raw.startsWith("//")) return { url: "https:" + raw, isRender }
  if (raw.startsWith("/")) return { url: "https://snapsave.app" + raw, isRender }

  return { url: raw, isRender }
}

export async function scrapeSnapSave(url: string): Promise<SnapSaveResult> {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    Origin: "https://snapsave.app",
    Referer: "https://snapsave.app/id",
  }

  let finalUrl = url.trim()
  // Bounded 3s redirect check
  try {
    const redirectCheck = await fetch(finalUrl, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(3_000),
    })
    finalUrl = redirectCheck.url || finalUrl
  } catch {}

  const r1 = await fetch("https://snapsave.app/id", {
    headers,
    signal: AbortSignal.timeout(5_000),
  })
  const cookieHeader = r1.headers.get("set-cookie") || ""
  const cookieStr = cookieHeader
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ")

  const params = new URLSearchParams()
  params.append("url", finalUrl)

  const response = await fetch("https://snapsave.app/action.php?lang=id", {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieStr,
    },
    body: params.toString(),
    signal: AbortSignal.timeout(8_000),
  })

  if (!response.ok) {
    throw new Error(`SnapSave error status ${response.status}`)
  }

  const responseText = await response.text()
  const decodedHtml = decodeSnapSave(responseText)
  const $ = cheerio.load(decodedHtml)

  const downloads: SnapSaveMedia[] = []

  $("table tbody tr").each((_, el) => {
    const quality = $(el).find("td.video-quality").length
      ? $(el).find("td.video-quality").text().trim()
      : $(el).find("td").eq(0).text().trim()
    const renderStatus = $(el).find("td").eq(1).text().trim().toLowerCase()
    const linkAttr =
      $(el).find("a.btn-download").attr("href") ||
      $(el).find("button").attr("onclick") ||
      $(el).find("a").attr("href")

    const extracted = extractFinalUrl(linkAttr)

    if (extracted && extracted.url.startsWith("http")) {
      const hasAudio =
        renderStatus === "no" ||
        renderStatus === "tidak" ||
        !extracted.isRender

      downloads.push({
        quality: quality || "Normal",
        url: extracted.url,
        hasAudio,
        type: "video",
      })
    }
  })

  if (downloads.length === 0) {
    $("a.btn-download").each((_, el) => {
      const href = $(el).attr("href")
      if (href && href.startsWith("http")) {
        downloads.push({
          quality: "Photo",
          url: href,
          hasAudio: false,
          type: "image",
        })
      }
    })
  }

  if (downloads.length === 0) {
    throw new Error("Could not extract download links from SnapSave.")
  }

  const sorted = downloads.sort((a, b) => {
    if (a.hasAudio && !b.hasAudio) return -1
    if (!a.hasAudio && b.hasAudio) return 1
    const aVal = a.quality.toLowerCase()
    const bVal = b.quality.toLowerCase()
    if (aVal.includes("hd") || aVal.includes("720") || aVal.includes("1080")) return -1
    if (bVal.includes("hd") || bVal.includes("720") || bVal.includes("1080")) return 1
    return 0
  })

  return {
    title: "Facebook / Instagram Media",
    downloads: sorted,
  }
}
