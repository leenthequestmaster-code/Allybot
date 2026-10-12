import crypto from "crypto"
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

class SimpleCookieJar {
  private cookies = new Map<string, string>()

  setFromHeaders(headers: Headers) {
    const raw = headers.get("set-cookie")
    if (!raw) return
    const list = raw.split(",")
    for (const item of list) {
      if (!item) continue
      const part = item.split(";")[0].trim()
      const eqIdx = part.indexOf("=")
      if (eqIdx !== -1) {
        const name = part.slice(0, eqIdx).trim()
        const value = part.slice(eqIdx + 1).trim()
        if (name) this.cookies.set(name, value)
      }
    }
  }

  getCookieHeader(): string {
    const pairs: string[] = []
    for (const [k, v] of this.cookies.entries()) {
      pairs.push(`${k}=${v}`)
    }
    return pairs.join("; ")
  }

  get(name: string): string | undefined {
    return this.cookies.get(name)
  }
}

function generateSessionToken(rawXsrfCookie: string): string {
  const unquotedXsrf = decodeURIComponent(rawXsrfCookie)
  const dummyFp = crypto
    .createHash("sha256")
    .update(
      "webgl:ANGLE (Intel, Intel(R) UHD Graphics Direct3D11)||canvas:abc12345||env:Asia/Jakarta,1920,1080"
    )
    .digest("hex")

  const hashPart = "#" + Buffer.from(dummyFp).toString("base64")
  return unquotedXsrf.slice(0, 128 - hashPart.length) + hashPart
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function fetchHttp(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
  jar?: SimpleCookieJar
): Promise<{ url: string; status: number; headers: Headers; text: string }> {
  let currentUrl = url
  let method = options.method || "GET"
  let body = options.body
  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    ...(options.headers || {}),
  }

  const maxHops = 10
  for (let hop = 0; hop < maxHops; hop++) {
    const cookieHeader = jar ? jar.getCookieHeader() : ""
    if (cookieHeader) headers["Cookie"] = cookieHeader

    const res = await fetch(currentUrl, {
      method,
      body,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })

    if (jar) jar.setFromHeaders(res.headers)

    const loc = res.headers.get("location")
    if (res.status >= 300 && res.status < 400 && loc) {
      headers["Referer"] = currentUrl
      currentUrl = new URL(loc, currentUrl).href
      method = "GET"
      body = undefined
      continue
    }

    const text = await res.text()
    return { url: currentUrl, status: res.status, headers: res.headers, text }
  }

  throw new Error("Too many redirects")
}

async function resolveGateway(html: string, currentUrl: string, jar: SimpleCookieJar): Promise<string | null> {
  const formMatch = html.match(
    /<form[^>]+action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i
  )
  const rayMatch = html.match(/name=["']ray_id["']\s+value=["']([^"']+)["']/i)
  const aliasMatch = html.match(/name=["']alias["']\s+value=["']([^"']+)["']/i)

  if (!formMatch || !rayMatch || !aliasMatch) return null

  const actionUrl = formMatch[1]
  const rayId = rayMatch[1]
  const alias = aliasMatch[1]

  const parsedAction = new URL(actionUrl, currentUrl)
  const blogOrigin = `${parsedAction.protocol}//${parsedAction.host}`
  const redirectUrl = `${blogOrigin}/redirect.php?ray_id=${encodeURIComponent(
    rayId
  )}&alias=${encodeURIComponent(alias)}`

  const r2 = await fetchHttp(redirectUrl, { headers: { Referer: currentUrl } }, jar)
  const step1PageUrl = r2.url

  const xsrf1 = jar.get("XSRF-TOKEN")
  if (!xsrf1) return null

  const tokenPayload1 = generateSessionToken(xsrf1)
  const sessionHeaders: Record<string, string> = {
    Origin: blogOrigin,
    Referer: step1PageUrl,
    "Content-Type": "application/json",
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
  }

  const sessionRes1 = await fetchHttp(
    `${blogOrigin}/api/session`,
    {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ _token: tokenPayload1 }),
    },
    jar
  )

  let sessionData1: any = {}
  try {
    sessionData1 = JSON.parse(sessionRes1.text)
  } catch {}

  const step = sessionData1.step || 1
  let step2PageUrl = step1PageUrl

  if (step === 1) {
    await sleep(800)
    const verifyRes = await fetchHttp(
      `${blogOrigin}/api/verify`,
      {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ _a: 0, captcha: null, passcode: null }),
      },
      jar
    )

    let verifyData: any = {}
    try {
      verifyData = JSON.parse(verifyRes.text)
    } catch {}

    let target = verifyData.target || "/redirect.php"
    if (target.startsWith("/")) target = `${blogOrigin}${target}`

    const r3 = await fetchHttp(target, { headers: { Referer: step1PageUrl } }, jar)
    step2PageUrl = r3.url

    const xsrf2 = jar.get("XSRF-TOKEN") || xsrf1
    sessionHeaders["Referer"] = step2PageUrl
    await fetchHttp(
      `${blogOrigin}/api/session`,
      {
        method: "POST",
        headers: sessionHeaders,
        body: JSON.stringify({ _token: generateSessionToken(xsrf2) }),
      },
      jar
    )
  }

  await sleep(1500)
  const key = 500
  const size = `${(1920 + key) * 2}.${(1080 + key) * 2}`

  sessionHeaders["Referer"] = step2PageUrl
  const goRes = await fetchHttp(
    `${blogOrigin}/api/go`,
    {
      method: "POST",
      headers: sessionHeaders,
      body: JSON.stringify({ key, size }),
    },
    jar
  )

  let goData: any = {}
  try {
    goData = JSON.parse(goRes.text)
  } catch {
    return null
  }

  let readyUrl = goData.url
  if (!readyUrl) return null
  if (!/^https?:\/\//i.test(readyUrl)) {
    readyUrl = new URL(readyUrl, blogOrigin).href
  }

  const rReady = await fetchHttp(readyUrl, { headers: { Referer: step2PageUrl } }, jar)
  const htmlReady = rReady.text

  const destMatch = htmlReady.match(
    /window\.location\.href\s*=\s*["']([^"']+)["']/i
  )
  if (destMatch) {
    return destMatch[1].replace(/\\\//g, "/").replace(/\\u0026/g, "&")
  }

  return readyUrl
}

export async function resolveSafelinku(url: string, autoResolveFiles = true): Promise<any> {
  const initialUrl = extractCleanUrl(url)
  const jar = new SimpleCookieJar()
  const visited = new Set<string>()
  let currentUrl = initialUrl
  const maxChain = 8

  for (let hop = 0; hop < maxChain; hop++) {
    if (visited.has(currentUrl)) break
    visited.add(currentUrl)

    const res = await fetchHttp(currentUrl, {}, jar)
    currentUrl = res.url
    const html = res.text

    if (
      html.includes('name="ray_id"') ||
      html.includes("name='ray_id'") ||
      html.includes("redirect.php")
    ) {
      const resolved = await resolveGateway(html, currentUrl, jar)
      if (resolved && resolved !== currentUrl) {
        currentUrl = resolved
        break
      }
    }

    const metaRefresh = html.match(
      /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"']+)["']/i
    )
    if (metaRefresh && metaRefresh[1]) {
      currentUrl = new URL(metaRefresh[1].trim(), currentUrl).href
      continue
    }

    const scriptRedirect = html.match(
      /window\.location(?:\.href)?\s*=\s*["'](https?:\/\/[^"']+)["']/i
    )
    if (scriptRedirect && scriptRedirect[1] && scriptRedirect[1] !== currentUrl) {
      currentUrl = scriptRedirect[1].replace(/\\\//g, "/")
      continue
    }

    break
  }

  let directFile: any = undefined

  if (autoResolveFiles) {
    if (/https?:\/\/(?:www\.)?mediafire\.com\//i.test(currentUrl)) {
      try {
        const mf = await scrapeMediaFire(currentUrl)
        directFile = {
          filename: mf.filename,
          size: mf.size,
          url: mf.url,
        }
      } catch {}
    } else if (/https?:\/\/(?:www\.)?sfile\.(?:co|mobi)\//i.test(currentUrl)) {
      try {
        const sf = await scrapeSfile(currentUrl)
        directFile = {
          filename: sf.filename,
          size: sf.size,
          url: sf.url,
        }
      } catch {}
    }
  }

  return {
    originalUrl: initialUrl,
    destinationUrl: currentUrl,
    hops: [initialUrl, currentUrl],
    directFile,
  }
}
