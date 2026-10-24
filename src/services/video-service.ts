import fs from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

export interface VideoGenerationOptions {
  readonly prompt: string
  readonly model?: 'veo-lite' | 'veo-fast' | 'omni-flash'
  readonly timeoutMs?: number
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
    // Generate a minimal dummy MP4 binary container (128 bytes)
    const dummyMp4 = Buffer.from(
      '00000018667479706d7034320000000069736f6d6d7034320000000866726565000000106d6461740000000000000000',
      'hex',
    )
    return {
      buffer: dummyMp4,
      mimeType: 'video/mp4',
      durationSeconds: 8,
      modelName: options.model ?? 'veo-lite',
      fileName: 'mock-video.mp4',
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
      throw new Error(`FLOW_COOKIE_MISSING: Cookie file not found at ${this.cookiesPath}`)
    }

    const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf8'))
    let browser: Browser | undefined
    let context: BrowserContext | undefined

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

      // Listen for video CDN download stream
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

      // Open Settings popup
      const settingsBtn = page.locator('button.settings-trigger-button')
      await settingsBtn.click()
      await page.waitForTimeout(500)

      // Switch to Video mode
      const videoToggle = page.locator('button[role=radio]:has-text("Video")')
      await videoToggle.click()
      await page.waitForTimeout(500)

      // Select model if requested
      if (options.model === 'omni-flash') {
        const modelSelectBtn = page.locator('button:has(.model-select-trigger-content)')
        await modelSelectBtn.click()
        await page.waitForTimeout(400)
        await page.locator('[role=menuitem]:has-text("Omni 1.1 Flash"), mat-option:has-text("Omni 1.1 Flash")').first().click()
        await page.waitForTimeout(400)
      } else if (options.model === 'veo-fast') {
        const modelSelectBtn = page.locator('button:has(.model-select-trigger-content)')
        await modelSelectBtn.click()
        await page.waitForTimeout(400)
        await page.locator('[role=menuitem]:has-text("Veo 3.1 - Fast"), mat-option:has-text("Veo 3.1 - Fast")').first().click()
        await page.waitForTimeout(400)
      }

      // Close settings menu
      await page.locator('button.settings-trigger-button').click()
      await page.waitForTimeout(500)

      // Fill prompt in editor
      const editor = page.locator('div.ProseMirror[aria-label*="Apa yang ingin Anda buat"]')
      await editor.waitFor({ state: 'visible', timeout: 10_000 })
      await editor.click()
      await editor.fill(options.prompt)
      await page.waitForTimeout(800)

      // Click Generate Button
      const genBtn = page.locator('button.generate-icon-button')
      await genBtn.click()

      // Poll until video finishes rendering (typically 25 - 60s)
      const startTime = Date.now()
      const maxWaitMs = options.timeoutMs ?? this.timeoutMs

      while (Date.now() - startTime < maxWaitMs) {
        await page.waitForTimeout(4_000)

        // Try clicking latest video tile
        try {
          const tile = page.locator('flow-video-tile').first()
          if (await tile.isVisible()) {
            await tile.click({ timeout: 2_000 })
            await page.waitForTimeout(2_000)

            // Click Download media button to trigger signed CDN URL
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
          // keep polling
        }
      }

      if (!capturedVideoUrl) {
        throw new Error('VIDEO_RENDER_TIMEOUT: Timed out waiting for Google Flow video generation.')
      }

      // Fetch video buffer directly via authenticated page context
      const res = await page.request.get(capturedVideoUrl)
      if (!res.ok()) {
        throw new Error(`VIDEO_FETCH_FAILED: Failed to download video stream (${res.status()})`)
      }

      const buffer = await res.body()
      return {
        buffer,
        mimeType: 'video/mp4',
        durationSeconds: 8,
        modelName: options.model ?? 'veo-lite',
        fileName: `veo-${Date.now()}.mp4`,
      }
    } finally {
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

    // Check cooldown
    const lastUse = this.userCooldowns.get(senderJid) ?? 0
    const diff = now - lastUse
    if (diff < this.cooldownMs) {
      const waitSec = Math.ceil((this.cooldownMs - diff) / 1_000)
      return {
        allowed: false,
        reason: `⏳ Masih cooldown nih! Tunggu sekitar *${waitSec} detik* lagi ya~`,
        remaining: 0,
      }
    }

    // Check daily limit
    const daily = this.userDailyCounts.get(senderJid)
    if (!daily || daily.date !== today) {
      return { allowed: true, remaining: this.dailyLimit }
    }

    if (daily.count >= this.dailyLimit) {
      return {
        allowed: false,
        reason: `⚠️ Kamu sudah mencapai batas harian (*${this.dailyLimit} video/hari*). Kuota reset besok ya!`,
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
      throw new Error(quota.reason ?? 'Quota exceeded')
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
          // task errors handled via individual promise reject
        }
      }
    }

    this.isProcessing = false
  }
}
