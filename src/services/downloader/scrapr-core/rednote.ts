import { safeFetch as fetch } from "../safe-fetch.js"
import * as cheerio from "cheerio"

export interface RedNoteResult {
  title: string
  thumbnail: string
  type: "video" | "image"
  author: { name: string }
  downloads: {
    type: "video" | "image"
    quality: string
    url: string
  }[]
}

const CHROME_MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1"
const CHROME_DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

function isLandingOrErrorPage(title: string, imgUrl: string): boolean {
  const invalidTitles = [
    "你的生活兴趣社区",
    "你访问的页面不见了",
    "页面不见了",
    "404 Not Found",
    "Page Not Found",
  ]
  if (title && invalidTitles.some((t) => title.includes(t))) return true
  if (
    imgUrl &&
    (imgUrl.includes("e6214e4fbfae2cf14d634d4296916e8a5eaefdf4") ||
      imgUrl.includes("fe-platform"))
  ) {
    return true
  }
  return false
}

function findNoteObjectFromState(state: any): any {
  if (!state) return null
  if (state.noteData?.data?.noteData) {
    const nd = state.noteData.data.noteData
    if (nd.title || nd.desc || nd.imageList || nd.video) return nd
  }
  if (state.note?.noteDetailMap) {
    const map = state.note.noteDetailMap
    for (const k of Object.keys(map)) {
      const item = map[k]?.note || map[k]
      if (item && !Array.isArray(item) && (item.title || item.desc || item.imageList || item.video)) {
        return item
      }
    }
  }
  const alt = [
    state.noteData?.note,
    state.noteData,
    state.note?.firstNote,
    state.feed?.note,
    state.firstNote,
  ]
  for (const cand of alt) {
    if (cand && !Array.isArray(cand) && (cand.title || cand.desc || cand.imageList || cand.video)) {
      return cand
    }
  }
  return null
}

function extractMediaFromHtml(htmlContent: string): RedNoteResult | null {
  const htmlStr = typeof htmlContent === "string" ? htmlContent : ""

  const matchState =
    htmlStr.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});?<\/script>/) ||
    htmlStr.match(/window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]+?\});?<\/script>/) ||
    htmlStr.match(/__INITIAL_STATE__\s*=\s*(\{[\s\S]+?\});?<\/script>/) ||
    htmlStr.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]+?\});?<\/script>/)

  if (matchState) {
    try {
      const rawJson = matchState[1]
        .replace(/;\s*$/, "")
        .replace(/:\s*undefined/g, ":null")
      const state = JSON.parse(rawJson)
      const noteData = findNoteObjectFromState(state)

      if (noteData) {
        const title = noteData.title || noteData.desc || "RedNote Post"
        const author =
          noteData.user?.nickname ||
          noteData.user?.nickName ||
          "RedNote Creator"
        let thumbnail = ""
        const downloads: RedNoteResult["downloads"] = []

        if (noteData.imageList && noteData.imageList.length > 0) {
          const firstImg =
            noteData.imageList[0].urlDefault ||
            noteData.imageList[0].urlOriginal ||
            noteData.imageList[0].url
          if (firstImg) thumbnail = firstImg.startsWith("//") ? `https:${firstImg}` : firstImg
        }

        if (!isLandingOrErrorPage(title, thumbnail)) {
          if (noteData.video && noteData.video.media) {
            const streamObj = noteData.video.media.stream || {}
            let videoUrl: string | null = null
            const codecs = ["h264", "h265", "h266", "av1"]

            for (const c of codecs) {
              if (Array.isArray(streamObj[c]) && streamObj[c].length > 0) {
                const firstStream = streamObj[c][0]
                videoUrl =
                  firstStream.masterUrl ||
                  firstStream.backupUrls?.[0] ||
                  firstStream.url
                if (videoUrl) break
              }
            }

            if (!videoUrl && noteData.video.media.video) {
              videoUrl = noteData.video.media.video.masterUrl
            }

            if (videoUrl) {
              if (videoUrl.startsWith("//")) videoUrl = `https:${videoUrl}`
              downloads.push({
                type: "video",
                quality: "HD Video",
                url: videoUrl,
              })
            }
          }

          if (noteData.imageList && noteData.imageList.length > 0) {
            noteData.imageList.forEach((img: any, i: number) => {
              let u = img.urlOriginal || img.urlDefault || img.url
              if (u) {
                if (u.startsWith("//")) u = `https:${u}`
                downloads.push({
                  type: "image",
                  quality: `Photo ${i + 1}`,
                  url: u,
                })
              }
            })
          }

          if (downloads.length > 0) {
            return {
              title,
              thumbnail: thumbnail || downloads[0].url,
              type: noteData.video ? "video" : "image",
              author: { name: author },
              downloads,
            }
          }
        }
      }
    } catch {}
  }

  // Fallback Cheerio
  const $ = cheerio.load(htmlStr)
  const ogTitle = $('meta[property="og:title"]').attr("content") || $("title").text()
  const ogImage = $('meta[property="og:image"]').attr("content")
  const ogVideo = $('meta[property="og:video"]').attr("content") || $('meta[property="og:video:url"]').attr("content")

  if ((ogImage || ogVideo) && ogTitle && !isLandingOrErrorPage(ogTitle, ogImage || "")) {
    const downloads: RedNoteResult["downloads"] = []
    if (ogVideo) {
      downloads.push({ type: "video", quality: "HD Video", url: ogVideo.startsWith("//") ? `https:${ogVideo}` : ogVideo })
    }
    if (ogImage) {
      downloads.push({ type: "image", quality: "Photo", url: ogImage.startsWith("//") ? `https:${ogImage}` : ogImage })
    }
    if (downloads.length > 0) {
      return {
        title: ogTitle.replace(/ - (?:小红书|RedNote).*/i, "").trim() || "RedNote Post",
        thumbnail: ogImage || downloads[0].url,
        type: ogVideo ? "video" : "image",
        author: { name: "RedNote Creator" },
        downloads,
      }
    }
  }

  return null
}

export async function scrapeRedNote(url: string): Promise<RedNoteResult> {
  const match = url.match(/https?:\/\/[^\s]+/i)
  let cleanUrl = match ? match[0] : url.trim()
  let extractedNoteId: string | null = null

  if (cleanUrl.includes("xhslink.com") || cleanUrl.includes("xhslink.cn")) {
    try {
      const res = await fetch(cleanUrl, {
        headers: { "User-Agent": CHROME_MOBILE_UA },
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      })
      const text = await res.text()
      const extracted = extractMediaFromHtml(text)
      if (extracted) return extracted

      const targetUrl = res.url || ""
      const m = targetUrl.match(/\/([a-f0-9]{24})/i)
      if (m) extractedNoteId = m[1]
      cleanUrl = targetUrl
    } catch {}
  }

  if (!extractedNoteId) {
    const m =
      cleanUrl.match(/\/(?:explore|discovery\/item|red_video)\/([a-f0-9]{24})/i) ||
      cleanUrl.match(/\/([a-f0-9]{24})/i)
    if (m) extractedNoteId = m[1]
  }

  const targets: string[] = []
  if (cleanUrl && !cleanUrl.includes("xhslink")) targets.push(cleanUrl)
  if (extractedNoteId) {
    targets.push(`https://www.xiaohongshu.com/discovery/item/${extractedNoteId}`)
    targets.push(`https://www.xiaohongshu.com/explore/${extractedNoteId}`)
  }

  for (const t of targets) {
    try {
      const res = await fetch(t, {
        headers: {
          "User-Agent": CHROME_DESKTOP_UA,
          Cookie: "a1=18a1234567890abcdef1234567890abc; webId=1234567890abcdef",
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
        signal: AbortSignal.timeout(10_000),
      })
      const html = await res.text()
      const extracted = extractMediaFromHtml(html)
      if (extracted) return extracted
    } catch {}
  }

  throw new Error("Gagal mengekstrak media RedNote / Xiaohongshu.")
}
