import { safeFetch as fetch } from "../safe-fetch.js"
import crypto from "crypto"

export interface DouyinResult {
  title: string
  author: string
  thumbnail: string
  type: "video" | "image"
  downloads: {
    type: "video" | "image" | "audio"
    quality: string
    url: string
  }[]
}

async function getTtwid(): Promise<string | null> {
  try {
    const postData = {
      region: "cn",
      aid: 1768,
      needFparam: "0",
      unionHost: "https://ttwid.bytedance.com",
      service: "www.ixigua.com",
      migrate_info: { ticket: "", src: "ucp" },
      cbUrlProtocol: "https",
    }
    const res = await fetch("https://ttwid.bytedance.com/ttwid/union/register/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      body: JSON.stringify(postData),
      signal: AbortSignal.timeout(8_000),
    })
    const rawCookie = res.headers.get("set-cookie")
    if (rawCookie) {
      return rawCookie.split(";")[0]
    }
  } catch {}
  return null
}

function solveWafChallenge(html: string): string | null {
  try {
    const csMatch = html.match(/cs\s*=\s*"([^"]+)"/)
    if (!csMatch) return null
    const c = JSON.parse(Buffer.from(csMatch[1], "base64").toString("utf8"))
    const prefixBuf = Buffer.from(c.v.a, "base64")
    const expectHex = Buffer.from(c.v.c, "base64").toString("hex")
    for (let i = 0; i <= 1000000; i++) {
      const hash = crypto
        .createHash("sha256")
        .update(Buffer.concat([prefixBuf, Buffer.from(String(i))]))
        .digest("hex")
      if (hash === expectHex) {
        c.d = Buffer.from(String(i)).toString("base64")
        return Buffer.from(JSON.stringify(c)).toString("base64")
      }
    }
  } catch {}
  return null
}

function extractDouyinItemId(text: string): string | null {
  if (!text || typeof text !== "string") return null
  const match =
    text.match(/(?:video|note|share\/(?:video|slides))\b[\/?](\d{15,22})/i) ||
    text.match(/modal_id=(\d{15,22})/i) ||
    text.match(/group_id=(\d{15,22})/i) ||
    text.match(/aweme_id=(\d{15,22})/i) ||
    text.match(/\/(\d{18,20})\b/)
  return match ? match[1] : null
}

function parseJSObject(slice: string): any {
  let braceCount = 0,
    inStr = false,
    strChar: string | null = null,
    escape = false,
    endIdx = -1
  for (let i = 0; i < slice.length; i++) {
    const c = slice[i]
    if (escape) {
      escape = false
      continue
    }
    if (c === "\\") {
      escape = true
      continue
    }
    if (inStr) {
      if (c === strChar) inStr = false
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      strChar = c
      continue
    }
    if (c === "{") braceCount++
    else if (c === "}") {
      braceCount--
      if (braceCount === 0) {
        endIdx = i + 1
        break
      }
    }
  }
  if (endIdx !== -1) {
    try {
      return JSON.parse(slice.substring(0, endIdx))
    } catch {}
  }
  return null
}

function extractRouterOrSSRData(htmlStr: string): any {
  if (!htmlStr || typeof htmlStr !== "string") return null

  const markers = [
    "window._ROUTER_DATA =",
    "window._SSR_DATA =",
    "window._RENDER_DATA =",
    "window.__INIT_PROPS__ =",
    "window.SSR_HYDRATED_DATA =",
  ]

  for (const marker of markers) {
    const startIdx = htmlStr.indexOf(marker)
    if (startIdx === -1) continue

    let slice = htmlStr.substring(startIdx + marker.length).trim()
    if (slice.startsWith('"') && slice.includes("%7B")) {
      try {
        const matchStr = slice.match(/^"([^"]+)"/)
        if (matchStr) slice = decodeURIComponent(matchStr[1])
      } catch {}
    } else if (slice.startsWith("%7B")) {
      try {
        slice = decodeURIComponent(slice)
      } catch {}
    }

    const data = parseJSObject(slice)
    if (data) return data
  }

  const scriptMatches = htmlStr.matchAll(
    /<script[^>]*id="RENDER_DATA"[^>]*>([\s\S]*?)<\/script>/gi
  )
  for (const m of scriptMatches) {
    try {
      const decoded = decodeURIComponent(m[1].trim())
      return JSON.parse(decoded)
    } catch {}
  }

  return null
}

function getItemFromData(data: any): any {
  if (!data) return null
  const loaderData = data.loaderData || {}
  for (const key in loaderData) {
    if (loaderData[key] && loaderData[key].videoInfoRes) {
      const itemList = loaderData[key].videoInfoRes.item_list
      if (itemList && itemList.length > 0) return itemList[0]
    }
  }
  if (data.aweme && data.aweme.detail) return data.aweme.detail
  if (data.item_list && data.item_list.length > 0) return data.item_list[0]
  if (data.aweme_detail) return data.aweme_detail
  return null
}

function buildResult(item: any): DouyinResult {
  const title = item.desc || item.share_info?.share_desc || "Douyin Content"
  const author = item.author ? item.author.nickname : "Douyin User"
  const thumbnail =
    item.video?.cover?.url_list?.[0] || item.images?.[0]?.url_list?.[0] || ""
  const downloads: DouyinResult["downloads"] = []

  if (item.images && item.images.length > 0) {
    item.images.forEach((img: any, i: number) => {
      const imgUrl = img.url_list?.[0] || img.download_url_list?.[0]
      if (imgUrl) {
        downloads.push({
          type: "image",
          quality: `Photo ${i + 1}`,
          url: imgUrl.replace(/^http:/, "https:"),
        })
      }
    })
  } else {
    let videoUrl =
      item.video?.play_addr?.url_list?.[0] ||
      item.video?.download_addr?.url_list?.[0]

    if (videoUrl) {
      videoUrl = videoUrl.replace(/^http:/, "https:").replace("playwm", "play")

      let videoId = null
      try {
        videoId = new URL(videoUrl).searchParams.get("video_id")
      } catch {}
      if (!videoId) {
        const m = videoUrl.match(/video_id=([^&]+)/)
        if (m) videoId = m[1]
      }

      const noWatermarkUrl = videoId
        ? `https://aweme.snssdk.com/aweme/v1/play/?video_id=${videoId}`
        : videoUrl

      downloads.push({
        type: "video",
        quality: "HD No Watermark",
        url: noWatermarkUrl,
      })
    }
  }

  const musicUrl =
    item.music?.play_url?.url_list?.[0] ||
    item.music?.play_url?.uri ||
    null
  if (musicUrl && typeof musicUrl === "string" && musicUrl.startsWith("http")) {
    downloads.push({
      type: "audio",
      quality: "Original Audio",
      url: musicUrl.replace(/^http:/, "https:"),
    })
  }

  if (downloads.length === 0) {
    throw new Error("No downloadable media found in Douyin item.")
  }

  return {
    title,
    author,
    thumbnail,
    type: item.images?.length ? "image" : "video",
    downloads,
  }
}

export async function scrapeDouyin(url: string): Promise<DouyinResult> {
  const cleanUrl = url.trim()
  const mobileUA =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1"

  const cookieJar = new Map<string, Map<string, string>>()
  const saveCookies = (res: Response, requestUrl: string) => {
    const origin = new URL(res.url || requestUrl).origin
    const cookies = cookieJar.get(origin) ?? new Map<string, string>()
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const part = raw.split(';')[0]
      const eq = part.indexOf('=')
      if (eq > 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
    cookieJar.set(origin, cookies)
  }
  const getCookieHeader = (url: string) => [...(cookieJar.get(new URL(url).origin) ?? [])].map(([k,v]) => `${k}=${v}`).join('; ')

  let targetUrl = cleanUrl
  let itemId = extractDouyinItemId(cleanUrl)
  const initTtwid = await getTtwid()
  // The fixed Bytedance token is intentionally initialized only for known service origins.
  if (initTtwid) {
    const eq = initTtwid.indexOf('=')
    if (eq > 0) for (const origin of ['https://www.douyin.com', 'https://www.iesdouyin.com', 'https://v.douyin.com']) {
      cookieJar.set(origin, new Map([[initTtwid.slice(0, eq), initTtwid.slice(eq + 1)]]))
    }
  }

  if (cleanUrl.includes("v.douyin.com")) {
    try {
      const r1 = await fetch(cleanUrl, {
        headers: {
          "User-Agent": mobileUA,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Cookie: getCookieHeader(cleanUrl),
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      })
      saveCookies(r1, cleanUrl)
      const loc = r1.headers.get("location")
      if (loc) targetUrl = new URL(loc, cleanUrl).href
    } catch {}
  }

  if (!itemId) itemId = extractDouyinItemId(targetUrl)

  const slidesMatch = targetUrl.match(/share\/slides\/([0-9]{15,22})/i)
  if (slidesMatch && slidesMatch[1]) {
    targetUrl = `https://www.iesdouyin.com/share/video/${slidesMatch[1]}/`
    itemId = slidesMatch[1]
  }

  let htmlStr = ""
  try {
    const r2 = await fetch(targetUrl, {
      headers: {
        "User-Agent": mobileUA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Cookie: getCookieHeader(targetUrl),
        Referer: "https://www.douyin.com/",
      },
      signal: AbortSignal.timeout(15_000),
    })
    saveCookies(r2, targetUrl)
    htmlStr = await r2.text()
  } catch {}

  if (htmlStr.includes("_wafchallengeid")) {
    const wafToken = solveWafChallenge(htmlStr)
    if (wafToken) {
      const cookies = cookieJar.get(new URL(targetUrl).origin) ?? new Map<string, string>()
      cookies.set("_wafchallengeid", wafToken)
      cookieJar.set(new URL(targetUrl).origin, cookies)
      try {
        const rWaf = await fetch(targetUrl, {
          headers: {
            "User-Agent": mobileUA,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            Cookie: getCookieHeader(targetUrl),
            Referer: targetUrl,
          },
          signal: AbortSignal.timeout(15_000),
        })
        saveCookies(rWaf, targetUrl)
        htmlStr = await rWaf.text()
      } catch {}
    }
  }

  if (!itemId) itemId = extractDouyinItemId(targetUrl) || extractDouyinItemId(htmlStr)

  let parsedData = extractRouterOrSSRData(htmlStr)
  let item = getItemFromData(parsedData)

  if (!item && itemId) {
    try {
      const apiUrl = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${itemId}`
      const apiRes = await fetch(apiUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1",
          Referer: "https://www.iesdouyin.com/",
          Accept: "application/json",
          Cookie: getCookieHeader(apiUrl),
        },
        signal: AbortSignal.timeout(10_000),
      })
      const d = (await apiRes.json()) as any
      if (d && d.item_list && d.item_list.length > 0) {
        item = d.item_list[0]
      }
    } catch {}
  }

  if (!item) {
    throw new Error("Could not extract Douyin video data.")
  }

  return buildResult(item)
}
