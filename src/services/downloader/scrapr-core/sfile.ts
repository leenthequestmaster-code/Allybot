import * as cheerio from "cheerio"

export interface SfileResult {
  readonly title: string
  readonly filename: string
  readonly size: string
  readonly url: string
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

export async function scrapeSfile(url: string): Promise<SfileResult> {
  const cleanUrl = extractCleanUrl(url)

  const res1 = await fetch(cleanUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(15_000),
  })

  if (!res1.ok) {
    throw new Error(`Sfile status ${res1.status}`)
  }

  const cookieHeader = res1.headers.get("set-cookie") || ""
  const cookieStr = cookieHeader
    .split(",")
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ")

  const html1 = await res1.text()
  const $1 = cheerio.load(html1)

  let title =
    $1('meta[property="og:title"]').attr("content") ||
    $1("h1").first().text().trim() ||
    "Sfile Download"
  title = title.replace(/\s*-\s*Sfile\.co$/i, "").trim()

  let size = ""
  const desc = $1('meta[property="og:description"]').attr("content") || ""
  const sizeMatch = desc.match(/size\s+([0-9.]+\s*[KMGT]?B)/i)
  if (sizeMatch) {
    size = sizeMatch[1]
  } else {
    const rawText = $1("body").text()
    const matchText = rawText.match(/([0-9.]+\s*(?:KB|MB|GB|B))/i)
    if (matchText) size = matchText[1]
  }

  const downloadBtn = $1("#download, a[data-dw-url]")
  const dwUrl = downloadBtn.attr("data-dw-url")

  if (!dwUrl) {
    throw new Error("Could not find download gate link on Sfile page.")
  }

  const gateUrl = dwUrl.startsWith("http")
    ? dwUrl
    : new URL(dwUrl, cleanUrl).href

  const res2 = await fetch(gateUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: cleanUrl,
      Cookie: cookieStr,
    },
    signal: AbortSignal.timeout(15_000),
  })

  const html2 = await res2.text()
  if (html2.includes("download link for this file has expired")) {
    throw new Error("Sfile download session expired.")
  }

  let directUrl = ""
  const fileMatches = html2.match(
    /https?:\\?\/\\?\/download\d*\.sfile\.co\\?\/downloadfile\\?\/[^\s"']+/gi
  )
  if (fileMatches && fileMatches.length > 0) {
    directUrl = fileMatches[0].replace(/\\/g, "")
  }

  if (!directUrl) {
    const directMatch = html2.match(/data-direct-download=["']([^"']+)["']/i)
    if (directMatch) {
      directUrl = directMatch[1].replace(/&amp;/g, "&")
    }
  }

  if (!directUrl) {
    const $2 = cheerio.load(html2)
    directUrl = $2("#download").attr("href") || ""
    if (directUrl === "#" || !directUrl.startsWith("http")) {
      directUrl = ""
    }
  }

  if (!directUrl) {
    throw new Error("Could not extract final direct download URL from Sfile.")
  }

  return {
    title,
    filename: title,
    size: size || "Unknown",
    url: directUrl,
  }
}
