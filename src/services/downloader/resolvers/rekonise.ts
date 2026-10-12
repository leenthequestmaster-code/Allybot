import { safeFetch as fetch, assertPublicHttpUrl } from "../safe-fetch.js"
import { scrapeMediaFire } from "../scrapr-core/mediafire.js"
import { scrapeSfile } from "../scrapr-core/sfile.js"

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

function extractSlug(input: string): string {
  if (!input || typeof input !== "string") return ""
  let clean = input.trim()
  const match = clean.match(/rekonise\.com\/([a-zA-Z0-9_-]+)/i)
  if (match) return match[1]
  clean = clean.replace(/^https?:\/\//i, "").replace(/\/$/, "")
  return clean.split("/").pop() || clean
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function resolveRekonise(url: string, autoResolveFiles = true): Promise<any> {
  const slug = extractSlug(url)
  if (!slug) throw new Error("Could not extract Rekonise slug from URL.")

  const pageUrl = `https://rekonise.com/${slug}`
  const headers = {
    "User-Agent": DEFAULT_UA,
    Origin: "https://rekonise.com",
    Referer: pageUrl,
    Accept: "application/json, text/plain, */*",
  }

  const infoRes = await fetch(`https://api.rekonise.com/social-unlocks/${slug}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  })

  if (!infoRes.ok) {
    throw new Error(`Rekonise info returned status ${infoRes.status}`)
  }

  const data = (await infoRes.json()) as any
  if (!data || !data.unlock_token) {
    throw new Error("Invalid response or missing unlock token from Rekonise API.")
  }

  const title = data.title || "Rekonise Unlock"
  const token = data.unlock_token
  const actions = Array.isArray(data.actions) ? data.actions.slice(0, 10) : []

  for (const a of actions) {
    if (a.type && a.value) {
      try {
        await fetch("https://api.rekonise.com/traffic/action-completed", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            actionType: a.type,
            actionValue: a.value,
            slug,
          }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch {}
    }
  }

  let waitMs = 11000
  try {
    const parts = token.split(".")
    if (parts.length > 1) {
      const payload = JSON.parse(
        Buffer.from(parts[0], "base64").toString("utf-8")
      )
      if (payload.issuedAt) {
        const elapsed = Date.now() - payload.issuedAt
        waitMs = Math.min(11000, Math.max(0, 11000 - elapsed))
      }
    }
  } catch {}

  if (waitMs > 0) {
    await sleep(waitMs)
  }

  const unlockRes = await fetch(
    `https://api.rekonise.com/social-unlocks/${slug}/unlock?token=${encodeURIComponent(token)}`,
    { headers, signal: AbortSignal.timeout(15_000) }
  )

  if (!unlockRes.ok) {
    throw new Error(`Rekonise unlock returned status ${unlockRes.status}`)
  }

  const unlockData = (await unlockRes.json()) as any
  const destUrl = unlockData?.url
  if (!destUrl) {
    throw new Error("Could not retrieve destination URL from Rekonise.")
  }

  await assertPublicHttpUrl(destUrl)

  let directFile: any = undefined
  if (autoResolveFiles) {
    if (/https?:\/\/(?:www\.)?mediafire\.com\//i.test(destUrl)) {
      try {
        const mf = await scrapeMediaFire(destUrl)
        directFile = {
          filename: mf.filename,
          size: mf.size,
          url: mf.url,
        }
      } catch {}
    } else if (/https?:\/\/(?:www\.)?sfile\.(?:co|mobi)\//i.test(destUrl)) {
      try {
        const sf = await scrapeSfile(destUrl)
        directFile = {
          filename: sf.filename,
          size: sf.size,
          url: sf.url,
        }
      } catch {}
    }
  }

  return {
    title,
    originalUrl: pageUrl,
    destinationUrl: destUrl,
    hops: [pageUrl, destUrl],
    directFile,
  }
}
