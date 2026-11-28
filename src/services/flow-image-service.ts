import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Cookie } from 'playwright'
import sharp from 'sharp'

export interface FlowImageOptions {
  readonly prompt: string
  readonly imageBuffer?: Buffer
  readonly cookiesPath?: string
  readonly projectUrl?: string
  readonly timeoutMs?: number
}

export interface FlowGeneratedImage {
  readonly buffer: Buffer
  readonly mimeType: 'image/png'
}

export interface FlowImageResult {
  readonly images: readonly FlowGeneratedImage[]
}

export function normalizeFlowCookies(rawCookies: unknown[]): Cookie[] {
  return (rawCookies as Cookie[]).map((c) => ({
    ...c,
    sameSite: !c.secure && c.sameSite === 'None' ? 'Lax' : c.sameSite,
  }))
}

export async function generateFlowImage(options: FlowImageOptions): Promise<FlowImageResult> {
  const cookiesPath = options.cookiesPath ?? process.env.FLOW_COOKIES_PATH ?? './data/flow-cookies.json'
  const projectUrl =
    options.projectUrl ??
    process.env.FLOW_PROJECT_URL ??
    'https://flow.google.com/project/3cab9aef-ddc7-4d9b-bc81-e79de3726581'
  const timeoutMs = options.timeoutMs ?? 90_000

  if (!fs.existsSync(cookiesPath)) {
    throw new Error('FLOW_AUTH_MISSING: Cookies Google Flow tidak ditemukan.')
  }

  const rawCookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'))
  const cookies = normalizeFlowCookies(Array.isArray(rawCookies) ? rawCookies : [])

  let browser: Browser | undefined
  let context: BrowserContext | undefined
  let tempImagePath: string | undefined

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    })

    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    })
    await context.addCookies(cookies)

    const page = await context.newPage()
    page.setDefaultTimeout(timeoutMs)

    await page.goto(projectUrl, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {})
    await page.waitForTimeout(2_000)

    if (page.url().includes('/about')) {
      throw new Error('FLOW_AUTH_EXPIRED: Sesi login Google Flow telah berakhir.')
    }

    await page.locator('.glue-cookie-notification-bar__accept').first().click({ timeout: 2_000 }).catch(() => {})
    await page.waitForTimeout(400)

    let baselineTileCount = await page.locator('flow-image-tile').count()

    if (options.imageBuffer && options.imageBuffer.length > 0) {
      tempImagePath = path.join(os.tmpdir(), `flow-i2i-${crypto.randomUUID()}.png`)
      const pngBuffer = await sharp(options.imageBuffer).png().toBuffer()
      fs.writeFileSync(tempImagePath, pngBuffer)

      const addRefBtn = page
        .locator("button[aria-label*='Tambahkan bahan ke kotak perintah'], button[aria-label*='Menu tambahkan media']")
        .first()
      await addRefBtn.waitFor({ state: 'visible', timeout: 10_000 })
      await addRefBtn.click()
      await page.waitForTimeout(600)

      const uploadBtn = page
        .locator(".cdk-overlay-container :is(button, [role=menuitem]):has-text('Upload')")
        .first()
      await uploadBtn.waitFor({ state: 'visible', timeout: 8_000 })

      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 10_000 }),
        uploadBtn.click(),
      ])
      await fileChooser.setFiles(tempImagePath)
      await page.waitForTimeout(4_500)
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(500)

      baselineTileCount = await page.locator('flow-image-tile').count()
    }

    const editor = page.locator('div.ProseMirror[role="textbox"], div.ProseMirror').first()
    await editor.waitFor({ state: 'visible', timeout: 10_000 })
    await editor.click()
    const directive = `${options.prompt.trim()} (generate image with Nano Banana 2.1)`
    await editor.fill(directive)
    await page.waitForTimeout(600)

    const genBtn = page.locator("button[aria-label='Mulai pembuatan'], button.generate-icon-button").first()
    await genBtn.waitFor({ state: 'visible', timeout: 6_000 })
    await genBtn.click()

    const startTime = Date.now()
    let readyUrls: string[] = []

    while (Date.now() - startTime < timeoutMs) {
      await page.waitForTimeout(3_000)

      const approveBtn = page
        .locator("button:has-text('Selalu setujui di project'), button:has-text('Setujui')")
        .first()
      if (await approveBtn.isVisible().catch(() => false)) {
        await approveBtn.click().catch(() => {})
      }

      const currentCount = await page.locator('flow-image-tile').count()
      const newCount = currentCount - baselineTileCount
      if (newCount <= 0) continue

      const stopVisible = await page.locator("button[aria-label='Hentikan']").first().isVisible().catch(() => false)

      const tileStates = await page.evaluate((count) => {
        const tiles = Array.from((globalThis as any).document.querySelectorAll('flow-image-tile')).slice(0, count)
        return tiles.map((tile: any) => {
          const img = tile.querySelector('img')
          const src = img?.getAttribute('src') ?? ''
          const ready = Boolean(img && img.complete && img.naturalWidth >= 256 && src.startsWith('http'))
          return { ready, src }
        })
      }, newCount)

      const validUrls = tileStates.filter((t) => t.ready).map((t) => t.src)
      if (!stopVisible && validUrls.length > 0 && validUrls.length >= newCount) {
        readyUrls = validUrls
        break
      }
    }

    if (readyUrls.length === 0) {
      throw new Error('FLOW_IMAGE_TIMEOUT: Hasil gambar Nano Banana 2.1 belum selesai tepat waktu.')
    }

    const images: FlowGeneratedImage[] = []
    for (const url of readyUrls) {
      const res = await page.request.get(url)
      if (!res.ok()) continue
      const rawBuf = await res.body()
      if (rawBuf.length < 500) continue
      const pngBuf = await sharp(rawBuf).png().toBuffer()
      images.push({ buffer: pngBuf, mimeType: 'image/png' })
    }

    if (images.length === 0) {
      throw new Error('FLOW_IMAGE_DOWNLOAD_FAILED: Gagal mengunduh hasil gambar dari Google Flow.')
    }

    return { images }
  } finally {
    if (tempImagePath && fs.existsSync(tempImagePath)) {
      fs.unlink(tempImagePath, () => {})
    }
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
  }
}
