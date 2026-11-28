import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { chromium, type Browser, type BrowserContext, type Cookie } from 'playwright'
import sharp from 'sharp'

export interface FlowImageOptions {
  readonly prompt: string
  readonly imageBuffer?: Buffer
  readonly imageBuffers?: readonly Buffer[]
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

    await page.goto(projectUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.locator('div.ProseMirror').first().waitFor({ state: 'visible', timeout: 25_000 })
    await page.waitForTimeout(500)

    if (page.url().includes('/about')) {
      throw new Error('FLOW_AUTH_EXPIRED: Sesi login Google Flow telah berakhir.')
    }

    await page.addStyleTag({ content: '.glue-cookie-notification-bar { display: none !important; pointer-events: none !important; }' }).catch(() => {})
    await page.locator('.glue-cookie-notification-bar__accept').first().click({ timeout: 1_500 }).catch(() => {})
    await page.waitForTimeout(400)

    const refBuffers: Buffer[] = []
    if (options.imageBuffers && options.imageBuffers.length > 0) {
      for (const b of options.imageBuffers.slice(0, 4)) {
        if (b && b.length > 0) refBuffers.push(b)
      }
    } else if (options.imageBuffer && options.imageBuffer.length > 0) {
      refBuffers.push(options.imageBuffer)
    }

    const tempImagePaths: string[] = []
    try {
      if (refBuffers.length > 0) {
        const addRefBtn = page
          .locator("button[aria-label*='Tambahkan bahan ke kotak perintah']")
          .first()
        await addRefBtn.waitFor({ state: 'visible', timeout: 10_000 })

        for (const buf of refBuffers) {
          const tmpPath = path.join(os.tmpdir(), `flow-i2i-${crypto.randomUUID()}.png`)
          const pngBuffer = await sharp(buf).png().toBuffer()
          fs.writeFileSync(tmpPath, pngBuffer)
          tempImagePaths.push(tmpPath)

          await addRefBtn.click()
          await page.waitForTimeout(400)

          const uploadBtn = page
            .locator(".cdk-overlay-container :is(button, [role=menuitem]):has-text('Upload')")
            .first()
          await uploadBtn.waitFor({ state: 'visible', timeout: 8_000 })

          const [fileChooser] = await Promise.all([
            page.waitForEvent('filechooser', { timeout: 10_000 }),
            uploadBtn.click(),
          ])
          await fileChooser.setFiles(tmpPath)
          const uploadedName = path.basename(tmpPath)
          const targetItem = page.locator(`.cdk-overlay-container .asset-item:has-text("${uploadedName}")`).first()
          await targetItem.waitFor({ state: 'visible', timeout: 12_000 }).catch(async () => {
            await addRefBtn.click().catch(() => {})
            await targetItem.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {})
          })
          if (await targetItem.isVisible().catch(() => false)) {
            await targetItem.click()
            await page.waitForTimeout(250)
          } else {
            throw new Error('UPLOAD_FAILED: Asset hasil upload tidak muncul di daftar media Flow.')
          }
          const addToPromptBtn = page.locator(".cdk-overlay-container button:has-text('Tambahkan ke perintah')").first()
          await addToPromptBtn.waitFor({ state: 'visible', timeout: 6_000 })
          await addToPromptBtn.click()
          await page.waitForTimeout(300)
          await page.keyboard.press('Escape').catch(() => {})
          await page.waitForTimeout(200)
        }
      }

    // Capture baseline src URLs (handles virtualized/capped tile lists cleanly)
    const baselineSrcs: string[] = await page.evaluate(() =>
      Array.from((globalThis as any).document.querySelectorAll('flow-image-tile img'))
        .map((img: any) => img.getAttribute('src') ?? '')
        .filter((s: string) => s.startsWith('http')),
    )
    const baselineSet = new Set<string>(baselineSrcs)

    const editor = page.locator('div.ProseMirror[role="textbox"], div.ProseMirror').first()
    await editor.waitFor({ state: 'visible', timeout: 10_000 })
    await editor.click()
    const directive = refBuffers.length > 1
      ? `Using all ${refBuffers.length} uploaded reference images, ${options.prompt.trim()} (generate image with Nano Banana 2.1)`
      : refBuffers.length === 1
        ? `Using the uploaded reference image, ${options.prompt.trim()} (generate image with Nano Banana 2.1)`
        : `${options.prompt.trim()} (generate image with Nano Banana 2.1)`
    await editor.fill(directive)
    await page.waitForTimeout(600)

    const genBtn = page.locator("button[aria-label='Mulai pembuatan'], button.generate-icon-button").first()
    await genBtn.waitFor({ state: 'visible', timeout: 6_000 })
    await genBtn.click()

    const startTime = Date.now()
    let sawStopButton = false
    let readyUrls: string[] = []

    while (Date.now() - startTime < timeoutMs) {
      await page.waitForTimeout(1_500)

      const approveBtn = page
        .locator("[role='radio']:not(.read-only):has-text('Selalu setujui di project'), [role='radio']:not(.read-only):has-text('Setujui')")
        .first()
      if (await approveBtn.isVisible().catch(() => false)) {
        await approveBtn.click({ force: true }).catch(() => {})
      }

      const stopVisible = await page.locator("button[aria-label='Hentikan']").first().isVisible().catch(() => false)
      if (stopVisible) {
        sawStopButton = true
        continue
      }

      // Wait until generation has started and finished
      if (!sawStopButton && Date.now() - startTime < 5_000) {
        continue
      }

      const currentTiles: Array<{ src: string; ready: boolean }> = await page.evaluate(() =>
        Array.from((globalThis as any).document.querySelectorAll('flow-image-tile img')).map((img: any) => {
          const src = img.getAttribute('src') ?? ''
          const ready = Boolean(img.complete && img.naturalWidth >= 256 && src.startsWith('http'))
          return { src, ready }
        }),
      )

      const newReadyUrls = currentTiles.filter((t) => t.ready && !baselineSet.has(t.src)).map((t) => t.src)
      if (newReadyUrls.length > 0) {
        readyUrls = newReadyUrls
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

    // Refresh cookies on disk silently
    try {
      const refreshed = normalizeFlowCookies(await context.cookies())
      if (refreshed.length > 0) {
        fs.writeFileSync(cookiesPath, JSON.stringify(refreshed, null, 2), { mode: 0o600 })
      }
    } catch {}

    return { images }
    } finally {
      for (const p of tempImagePaths) {
        if (fs.existsSync(p)) fs.unlink(p, () => {})
      }
    }
  } finally {
    if (tempImagePath && fs.existsSync(tempImagePath)) {
      fs.unlink(tempImagePath, () => {})
    }
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
  }
}
