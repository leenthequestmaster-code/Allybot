import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

function runFfmpegVideoCli(args: string[], inputBuffer: Buffer, isOpus = false): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const tmpInput = path.join(os.tmpdir(), `vid-in-${crypto.randomUUID()}.mp4`)
    const tmpOutput = path.join(os.tmpdir(), `vid-out-${crypto.randomUUID()}${isOpus ? '.opus' : '.mp4'}`)

    fs.writeFileSync(tmpInput, inputBuffer)

    const finalArgs = ['-y', '-i', tmpInput, ...args, tmpOutput]
    const child = spawn('ffmpeg', finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

    const stderrChunks: Buffer[] = []
    child.stderr.on('data', (c) => stderrChunks.push(c))

    child.on('close', (code) => {
      try {
        if (code === 0 && fs.existsSync(tmpOutput)) {
          const out = fs.readFileSync(tmpOutput)
          resolve(out)
        } else {
          const err = Buffer.concat(stderrChunks).toString('utf8')
          reject(new Error(`FFMPEG_ERROR: code ${code} - ${err.slice(-200)}`))
        }
      } finally {
        fs.unlink(tmpInput, () => {})
        fs.unlink(tmpOutput, () => {})
      }
    })

    child.on('error', (err) => {
      fs.unlink(tmpInput, () => {})
      fs.unlink(tmpOutput, () => {})
      reject(err)
    })
  })
}

function isValidMp4Buffer(buf: Buffer): boolean {
  if (!buf || buf.length < 32) return false
  // Check for 'ftyp' box signature at byte offset 4
  const ftyp = buf.toString('ascii', 4, 8)
  return ftyp === 'ftyp'
}

export interface VideoGenerationOptions {
  readonly prompt: string
  readonly model?: 'veo-lite' | 'veo-fast' | 'omni-flash'
  readonly timeoutMs?: number
  readonly imageBuffer?: Buffer
}

export interface VideoGenerationResult {
  readonly buffer: Buffer
  readonly mimeType: string
  readonly durationSeconds: number
  readonly modelName: string
  readonly fileName: string
}

export interface VideoProvider {
  readonly name: string
  generate(options: VideoGenerationOptions): Promise<VideoGenerationResult>
}

export class MockVideoProvider implements VideoProvider {
  readonly name = 'mock'

  async generate(options: VideoGenerationOptions): Promise<VideoGenerationResult> {
    if (options.imageBuffer && options.imageBuffer.length === 0) {
      throw new Error('INVALID_IMAGE: Ukuran file gambar tidak boleh kosong.')
    }

    // Standard minimal MP4 binary header with ftyp box
    const dummyMp4 = Buffer.from(
      '00000018667479706d7034320000000069736f6d6d7034320000000866726565000000106d6461740000000000000000',
      'hex',
    )
    return {
      buffer: dummyMp4,
      mimeType: 'video/mp4',
      durationSeconds: 8,
      modelName: options.imageBuffer ? 'omni-flash' : (options.model ?? 'veo-lite'),
      fileName: `video-${Date.now()}.mp4`,
    }
  }
}

export interface FlowProviderOptions {
  readonly cookiesPath?: string
  readonly projectUrl?: string
  readonly timeoutMs?: number
}

export class FlowVideoProvider implements VideoProvider {
  readonly name = 'flow'
  private readonly cookiesPath: string
  private readonly projectUrl: string
  private readonly timeoutMs: number

  constructor(options: FlowProviderOptions = {}) {
    this.cookiesPath = options.cookiesPath ?? './data/flow-cookies.json'
    this.projectUrl =
      options.projectUrl ??
      'https://flow.google.com/project/3cab9aef-ddc7-4d9b-bc81-e79de3726581'
    this.timeoutMs = options.timeoutMs ?? 180_000
  }

  async generate(options: VideoGenerationOptions): Promise<VideoGenerationResult> {
    if (!fs.existsSync(this.cookiesPath)) {
      throw new Error('AUTH_ERROR: Sesi autentikasi tidak ditemukan.')
    }

    if (options.imageBuffer && options.imageBuffer.length < 100) {
      throw new Error('INVALID_IMAGE: Format atau ukuran gambar tidak valid.')
    }

    const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'))
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
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      })
      await context.addCookies(cookies)

      const page: Page = await context.newPage()
      page.setDefaultTimeout(this.timeoutMs)

      let capturedVideoUrl: string | undefined
      page.on('request', (req) => {
        const u = req.url()
        if (
          u.includes('flow-content.google/video/') ||
          u.includes('googlevideo.com/videoplayback')
        ) {
          capturedVideoUrl = u
        }
      })

      await page.goto(this.projectUrl, { waitUntil: 'networkidle', timeout: 45_000 })

      // Check if redirected to landing/about page (auth expired)
      const currentUrl = page.url()
      if (currentUrl.includes('/about')) {
        throw new Error('AUTH_EXPIRED: Sesi login telah berakhir. Diperlukan pembaruan sesi.')
      }

      // Dismiss cookie consent banner if present
      try {
        const agreeBtn = page.locator('.glue-cookie-notification-bar__accept')
        if (await agreeBtn.isVisible()) {
          await agreeBtn.click({ timeout: 3_000 })
        }
      } catch {
        // ignore banner errors
      }

      await page.waitForTimeout(1_000)

      // ── Step 1: Upload User Image (Mandatory for Image-to-Video) ──
      if (options.imageBuffer) {
        tempImagePath = path.join(os.tmpdir(), `flow-i2v-${crypto.randomUUID()}.png`)
        fs.writeFileSync(tempImagePath, options.imageBuffer)

        let uploadSuccess = false
        const maxRetries = 2

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            const addMediaBtn = page.locator('button[aria-label*="Menu tambahkan media"], button.add-menu-trigger').first()
            await addMediaBtn.waitFor({ state: 'visible', timeout: 8_000 })
            await addMediaBtn.click()
            await page.waitForTimeout(500)

            const uploadBtn = page.locator('button:has-text("Upload"), [role=menuitem]:has-text("Upload")').first()
            await uploadBtn.waitFor({ state: 'visible', timeout: 5_000 })

            const [fileChooser] = await Promise.all([
              page.waitForEvent('filechooser', { timeout: 10_000 }),
              uploadBtn.click(),
            ])

            await fileChooser.setFiles(tempImagePath)
            await page.waitForTimeout(5_000)

            // Validate that an image asset tile exists in the project
            const assetTileCount = await page.locator('flow-image-tile, .container:has(img)').count()
            if (assetTileCount > 0) {
              uploadSuccess = true
              break
            }
          } catch {
            await page.waitForTimeout(1_000)
          }
        }

        if (!uploadSuccess) {
          throw new Error('UPLOAD_FAILED: Gagal mengunggah gambar ke antarmuka video.')
        }

        // Trigger animation action on uploaded image tile
        try {
          const animateBtn = page.locator('button[aria-label*="Animasikan gambar ini"]').first()
          if (await animateBtn.isVisible({ timeout: 4_000 })) {
            await animateBtn.click({ force: true })
            await page.waitForTimeout(1_000)
          }
        } catch {
          // fallback to manual video mode
        }
      }

      // ── Step 2: Configure Mode & Settings ─────────────────────────
      try {
        const settingsBtn = page.locator('button.settings-trigger-button')
        if (await settingsBtn.isVisible()) {
          await settingsBtn.click()
          await page.waitForTimeout(500)

          const videoToggle = page.locator('button[role=radio]:has-text("Video")')
          if (await videoToggle.isVisible()) {
            await videoToggle.click()
            await page.waitForTimeout(500)
          }

          if (options.model === 'omni-flash') {
            const modelSelectBtn = page.locator('button:has(.model-select-trigger-content)')
            if (await modelSelectBtn.isVisible()) {
              await modelSelectBtn.click()
              await page.waitForTimeout(400)
              await page.locator('[role=menuitem]:has-text("Omni 1.1 Flash"), mat-option:has-text("Omni 1.1 Flash")').first().click()
              await page.waitForTimeout(400)
            }
          }

          await page.locator('button.settings-trigger-button').click()
          await page.waitForTimeout(500)
        }
      } catch {
        // continue if settings already aligned
      }

      // ── Step 3: Enter Prompt & Trigger Generation ────────────────
      const editor = page.locator('div.ProseMirror[aria-label*="Apa yang ingin Anda buat"]')
      await editor.waitFor({ state: 'visible', timeout: 10_000 })
      await editor.click()
      await editor.fill(options.prompt)
      await page.waitForTimeout(800)

      const genBtn = page.locator('button.generate-icon-button')
      await genBtn.waitFor({ state: 'visible', timeout: 5_000 })
      await genBtn.click()

      // ── Step 4: Poll & Download Generated Video ──────────────────
      const startTime = Date.now()
      const maxWaitMs = options.timeoutMs ?? this.timeoutMs

      while (Date.now() - startTime < maxWaitMs) {
        await page.waitForTimeout(4_000)
        try {
          const tile = page.locator('flow-video-tile').first()
          if (await tile.isVisible()) {
            await tile.click({ timeout: 2_000 })
            await page.waitForTimeout(2_000)

            const dlBtn = page.locator('button[aria-label="Download media"]')
            if (await dlBtn.isVisible()) {
              await dlBtn.click({ timeout: 2_000 })
              await page.waitForTimeout(3_000)
            }

            if (capturedVideoUrl) {
              break
            }
          }
        } catch {
          // continue polling
        }
      }

      if (!capturedVideoUrl) {
        throw new Error('TIMEOUT: Waktu proses pembuatan video habis sebelum hasil tersedia.')
      }

      const res = await page.request.get(capturedVideoUrl)
      if (!res.ok()) {
        throw new Error(`FETCH_FAILED: Gagal mengunduh file video (${res.status()}).`)
      }

      const buffer = await res.body()
      if (!isValidMp4Buffer(buffer)) {
        throw new Error('INVALID_OUTPUT: Format file video yang diterima tidak valid.')
      }

      return {
        buffer,
        mimeType: 'video/mp4',
        durationSeconds: 8,
        modelName: options.model ?? 'veo-lite',
        fileName: `video-${Date.now()}.mp4`,
      }
    } finally {
      if (tempImagePath && fs.existsSync(tempImagePath)) {
        fs.unlink(tempImagePath, () => {})
      }
      if (context) await context.close().catch(() => {})
      if (browser) await browser.close().catch(() => {})
    }
  }
}

export interface VideoServiceOptions {
  readonly provider?: VideoProvider
  readonly cooldownMs?: number
  readonly dailyLimit?: number
}

export class VideoService {
  readonly name = 'video'
  private readonly provider: VideoProvider
  private readonly cooldownMs: number
  private readonly dailyLimit: number
  private readonly userCooldowns = new Map<string, number>()
  private readonly userDailyCounts = new Map<string, { count: number; date: string }>()
  private queue: Array<() => Promise<void>> = []
  private isProcessing = false

  constructor(options: VideoServiceOptions = {}) {
    this.provider = options.provider ?? new MockVideoProvider()
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.dailyLimit = options.dailyLimit ?? 10
  }

  get queueSize(): number {
    return this.queue.length + (this.isProcessing ? 1 : 0)
  }

  checkQuota(senderJid: string): { allowed: boolean; reason?: string; remaining: number } {
    const now = Date.now()
    const today = new Date().toISOString().slice(0, 10)

    const lastUse = this.userCooldowns.get(senderJid) ?? 0
    const diff = now - lastUse
    if (diff < this.cooldownMs) {
      const waitSec = Math.ceil((this.cooldownMs - diff) / 1_000)
      return {
        allowed: false,
        reason: `Status: Diproses\nTunggu ${waitSec} detik sebelum membuat video berikutnya.`,
        remaining: 0,
      }
    }

    const daily = this.userDailyCounts.get(senderJid)
    if (!daily || daily.date !== today) {
      return { allowed: true, remaining: this.dailyLimit }
    }

    if (daily.count >= this.dailyLimit) {
      return {
        allowed: false,
        reason: `Status: Gagal\nBatas harian ${this.dailyLimit} video telah tercapai. Kuota diperbarui besok.`,
        remaining: 0,
      }
    }

    return { allowed: true, remaining: this.dailyLimit - daily.count }
  }

  private commitUsage(senderJid: string): void {
    const now = Date.now()
    const today = new Date().toISOString().slice(0, 10)
    this.userCooldowns.set(senderJid, now)

    const daily = this.userDailyCounts.get(senderJid)
    if (!daily || daily.date !== today) {
      this.userDailyCounts.set(senderJid, { count: 1, date: today })
    } else {
      daily.count++
    }
  }

  async enqueue(
    senderJid: string,
    options: VideoGenerationOptions,
  ): Promise<VideoGenerationResult> {
    const quota = this.checkQuota(senderJid)
    if (!quota.allowed) {
      throw new Error(quota.reason ?? 'Status: Gagal\nBatas kuota pembuatan video tercapai.')
    }

    return new Promise<VideoGenerationResult>((resolve, reject) => {
      const task = async () => {
        try {
          const result = await this.provider.generate(options)
          this.commitUsage(senderJid)
          resolve(result)
        } catch (err) {
          reject(err)
        }
      }

      this.queue.push(task)
      this.processQueue().catch(() => {})
    })
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing) return
    this.isProcessing = true

    while (this.queue.length > 0) {
      const task = this.queue.shift()
      if (task) {
        try {
          await task()
        } catch {
          // errors handled in individual promise reject
        }
      }
    }

    this.isProcessing = false
  }

  // ── Native Video Editing via FFmpeg ──────────────────────────────────
  async compressVideo(inputBuffer: Buffer): Promise<Buffer> {
    return runFfmpegVideoCli([
      '-vf', "scale=trunc(iw*0.7/2)*2:trunc(ih*0.7/2)*2",
      '-c:v', 'libx264',
      '-crf', '28',
      '-preset', 'faster',
      '-c:a', 'aac',
      '-b:a', '64k',
      '-movflags', '+faststart',
    ], inputBuffer)
  }

  async trimVideo(inputBuffer: Buffer, start: string, end?: string): Promise<Buffer> {
    const args: string[] = ['-ss', start]
    if (end) {
      args.push('-to', end)
    }
    args.push('-c:v', 'libx264', '-preset', 'faster', '-c:a', 'aac', '-movflags', '+faststart')
    return runFfmpegVideoCli(args, inputBuffer)
  }

  async speedVideo(inputBuffer: Buffer, speed: number): Promise<Buffer> {
    const clamped = Math.max(0.25, Math.min(4.0, speed))
    const setpts = (1 / clamped).toFixed(4)
    return runFfmpegVideoCli([
      '-filter_complex', `[0:v]setpts=${setpts}*PTS[v];[0:a]atempo=${clamped}[a]`,
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264',
      '-preset', 'faster',
      '-movflags', '+faststart',
    ], inputBuffer)
  }

  async muteVideo(inputBuffer: Buffer): Promise<Buffer> {
    return runFfmpegVideoCli([
      '-c:v', 'copy',
      '-an',
      '-movflags', '+faststart',
    ], inputBuffer)
  }

  async extractVoiceNote(inputBuffer: Buffer): Promise<Buffer> {
    return runFfmpegVideoCli([
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '48k',
      '-ar', '48000',
      '-ac', '1',
    ], inputBuffer, true)
  }
}
