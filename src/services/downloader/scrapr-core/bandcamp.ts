import * as cheerio from "cheerio"

export interface BandcampResult {
  title: string
  artist: string
  album?: string
  cover?: string
  downloads: {
    type: string
    quality: string
    url: string
  }[]
}

export async function scrapeBandcamp(url: string): Promise<BandcampResult> {
  const cleanUrl = url.trim().split("?")[0]
  const res = await fetch(cleanUrl, {
    headers: {
      "User-Agent": "curl/8.7.1",
      Accept: "*/*",
    },
    signal: AbortSignal.timeout(12_000),
  })

  const html = await res.text()
  const $ = cheerio.load(html)
  const tralbumRaw = $("script[data-tralbum]").attr("data-tralbum")
  if (!tralbumRaw) {
    throw new Error("Could not find track metadata in Bandcamp page.")
  }

  const data = JSON.parse(tralbumRaw)
  const artist =
    data.artist ||
    $("meta[property='og:site_name']").attr("content") ||
    "Bandcamp Artist"
  let cover =
    $("link[rel='image_src']").attr("href") ||
    $("meta[property='og:image']").attr("content") ||
    ""
  if (cover && cover.includes("_16.")) {
    cover = cover.replace("_16.", "_10.")
  }

  const title =
    data.current?.title ||
    $("meta[property='og:title']").attr("content") ||
    "Bandcamp Track"

  const downloads: BandcampResult["downloads"] = []
  const tracks = data.trackinfo || []

  for (const t of tracks) {
    const streamUrl = t.file
      ? t.file["mp3-128"] || Object.values(t.file)[0]
      : null
    if (streamUrl && !downloads.some((d) => d.url === streamUrl)) {
      downloads.push({
        type: "audio",
        quality: "128kbps",
        url: streamUrl,
      })
    }
  }

  if (cover && !downloads.some((d) => d.url === cover)) {
    downloads.push({
      type: "cover",
      quality: "HD Cover",
      url: cover,
    })
  }

  if (downloads.length === 0) {
    throw new Error("No playable or downloadable track found in Bandcamp.")
  }

  return {
    title,
    artist,
    album: data.current?.type === "album" ? title : undefined,
    cover,
    downloads,
  }
}
