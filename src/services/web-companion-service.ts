import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import type { RedisService } from '../redis.js'
import { CharacterGuideService, calculateTimeRp } from './character-guide-service.js'
import type { EconomyService } from './economy-service.js'

export interface WebCompanionOptions {
  readonly port?: number
  readonly host?: string
  readonly publicUrl?: string
  readonly tokenTtlSeconds?: number
}

interface WebSessionData {
  readonly ownerJid: string
  readonly groupJid?: string
  readonly createdAt: number
  readonly expiresAt: number
}

export class WebCompanionService implements Service {
  readonly name = 'web-companion'
  private server: Server | undefined
  private readonly port: number
  private readonly host: string
  private publicUrl: string
  private readonly tokenTtlSeconds: number
  private readonly memorySessions = new Map<string, WebSessionData>()
  private redis: RedisService | undefined
  private characterService: CharacterGuideService | undefined
  private economyService: EconomyService | undefined

  constructor(
    private readonly logger: Logger,
    options: WebCompanionOptions = {},
  ) {
    this.port = options.port ?? (process.env.WEB_COMPANION_PORT ? Number(process.env.WEB_COMPANION_PORT) : 18088)
    this.host = options.host ?? '0.0.0.0'
    this.publicUrl = options.publicUrl ?? process.env.WEB_COMPANION_URL ?? `http://38.102.126.42:${this.port}`
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? 1800 // 30 mins
  }

  setPublicUrl(url: string): void {
    this.publicUrl = url.replace(/\/+$/, '')
  }

  getPublicUrl(): string {
    return this.publicUrl
  }

  initialize(context: ServiceContext): void {
    if (context.services.has('redis')) {
      this.redis = context.services.get<RedisService>('redis')
    }
    if (context.services.has('character-guide')) {
      this.characterService = context.services.get<CharacterGuideService>('character-guide')
    }
    if (context.services.has('economy')) {
      this.economyService = context.services.get<EconomyService>('economy')
    }

    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error({ err }, 'web companion request handling failed')
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'Internal server error' }))
      })
    })

    this.server.listen(this.port, this.host, () => {
      this.logger.info({ port: this.port, host: this.host, publicUrl: this.publicUrl }, 'Web Companion server listening')
    })
  }

  stopService(_context?: ServiceContext): void {
    if (this.server) {
      this.server.close()
      this.server = undefined
    }
  }

  // Alias for framework Service contract lifecycle
  shutdown(context: ServiceContext): void {
    this.stopService(context)
  }

  async createSession(ownerJid: string, groupJid?: string): Promise<{ token: string; url: string; expiresAt: number }> {
    const token = randomBytes(16).toString('hex')
    const now = Date.now()
    const expiresAt = now + this.tokenTtlSeconds * 1000
    const session: WebSessionData = { ownerJid, groupJid, createdAt: now, expiresAt }

    if (this.redis?.isEnabled) {
      await this.redis.set(`allybot:v1:web-token:${token}`, session, this.tokenTtlSeconds)
    }
    this.memorySessions.set(token, session)

    const url = `${this.publicUrl}/c/${token}`
    return { token, url, expiresAt }
  }

  async getSession(token: string): Promise<WebSessionData | undefined> {
    if (!token || !/^[a-f0-9]{32}$/i.test(token)) return undefined

    if (this.redis?.isEnabled) {
      const stored = await this.redis.get<WebSessionData>(`allybot:v1:web-token:${token}`)
      if (stored) return stored
    }

    const memory = this.memorySessions.get(token)
    if (memory) {
      if (Date.now() > memory.expiresAt) {
        this.memorySessions.delete(token)
        return undefined
      }
      return memory
    }
    return undefined
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    // Static SPA routes: / or /c/:token
    if (pathname === '/' || pathname.startsWith('/c/')) {
      await this.serveSpa(res)
      return
    }

    // API Routes
    if (pathname.startsWith('/api/')) {
      await this.handleApi(pathname, req, res)
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not Found')
  }

  private async serveSpa(res: ServerResponse): Promise<void> {
    try {
      const htmlPath = join(process.cwd(), 'dist', 'web', 'index.html')
      const html = await readFile(htmlPath, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
      })
      res.end(html)
    } catch {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<h1>Allyssea Web Companion Loading...</h1><p>Please refresh in a moment.</p>')
    }
  }

  private async handleApi(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Content-Type', 'application/json')

    if (pathname.startsWith('/api/session/') && req.method === 'GET') {
      const token = pathname.replace('/api/session/', '').trim()
      const session = await this.getSession(token)
      if (!session) {
        res.writeHead(401)
        res.end(JSON.stringify({ ok: false, error: 'Sesi web sudah kedaluwarsa atau tidak valid. Ketik !web di WhatsApp untuk link baru.' }))
        return
      }

      // Fetch character data if available
      let character: any = null
      if (this.characterService?.isEnabled) {
        try {
          character = session.groupJid
            ? await this.characterService.getActive(session.groupJid, session.ownerJid)
            : await this.characterService.getActiveForOwner(session.ownerJid)
        } catch {
          // ignore
        }
      }

      // Fetch economy data if available
      let economy: any = null
      if (this.economyService?.isEnabled && session.groupJid) {
        try {
          const snapshotResult = await this.economyService.getAccountSnapshot(session.groupJid, session.ownerJid)
          economy = {
            wallet: snapshotResult.snapshot.walletBalance,
            safe: snapshotResult.snapshot.safeBalance,
          }
        } catch {
          // ignore
        }
      }

      const phone = session.ownerJid.split('@')[0]?.replace(/\D/g, '') ?? ''
      const phoneDisplay = phone.length > 6 ? `${phone.slice(0, 4)}••••${phone.slice(-4)}` : phone

      const timeRp = calculateTimeRp(Date.now())

      res.writeHead(200)
      res.end(JSON.stringify({
        ok: true,
        user: {
          phone: phoneDisplay,
          jid: session.ownerJid,
          groupJid: session.groupJid,
        },
        character,
        economy,
        timeRp,
        serverTime: Date.now(),
      }))
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ ok: false, error: 'Endpoint API tidak ditemukan' }))
  }
}
