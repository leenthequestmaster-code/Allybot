import type { Logger } from 'pino'
import type { Service, ServiceContext } from '../framework/contracts.js'
import type { RedisService } from '../redis.js'

export interface AiTurn {
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly at: number
}

export interface AiMemoryOptions {
  readonly redis?: RedisService
  readonly maxTurns?: number
  readonly ttlSeconds?: number
  readonly clock?: () => number
}

interface MemoryBucket {
  turns: AiTurn[]
  expiresAt: number
}

const DEFAULT_MAX_TURNS = 8
const DEFAULT_TTL_SECONDS = 30 * 60 // 30 minutes
const MAX_LOCAL_BUCKETS = 1_000

export class AiMemoryService implements Service {
  readonly name = 'ai-memory'
  private readonly redis?: RedisService
  private readonly maxTurns: number
  private readonly ttlSeconds: number
  private readonly clock: () => number
  private readonly localStore = new Map<string, MemoryBucket>()
  private logger?: Logger

  constructor(options: AiMemoryOptions = {}) {
    this.redis = options.redis
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS
    this.clock = options.clock ?? (() => Date.now())
  }

  initialize(context: ServiceContext): void {
    this.logger = context.logger
  }

  shutdown(): void {
    this.localStore.clear()
  }

  private buildKey(remoteJid: string, senderJid: string): string {
    const cleanRemote = remoteJid.split(':')[0] ?? remoteJid
    const cleanSender = senderJid.split(':')[0] ?? senderJid
    return `ai-mem:${cleanRemote}:${cleanSender}`
  }

  private pruneExpired(now: number): void {
    for (const [key, bucket] of this.localStore) {
      if (now >= bucket.expiresAt) {
        this.localStore.delete(key)
      }
    }
    while (this.localStore.size > MAX_LOCAL_BUCKETS) {
      const oldestKey = this.localStore.keys().next().value
      if (!oldestKey) break
      this.localStore.delete(oldestKey)
    }
  }

  async getHistory(remoteJid: string, senderJid: string): Promise<readonly AiTurn[]> {
    const key = this.buildKey(remoteJid, senderJid)
    const now = this.clock()

    if (this.redis?.isEnabled) {
      const stored = await this.redis.get<AiTurn[]>(key)
      if (Array.isArray(stored)) {
        return stored.slice(-this.maxTurns)
      }
    }

    const bucket = this.localStore.get(key)
    if (!bucket) return []
    if (now >= bucket.expiresAt) {
      this.localStore.delete(key)
      return []
    }
    return bucket.turns.slice(-this.maxTurns)
  }

  async appendExchange(
    remoteJid: string,
    senderJid: string,
    userContent: string,
    assistantContent: string,
  ): Promise<void> {
    const key = this.buildKey(remoteJid, senderJid)
    const now = this.clock()
    this.pruneExpired(now)

    const existing = await this.getHistory(remoteJid, senderJid)
    const updated: AiTurn[] = [
      ...existing,
      { role: 'user' as const, content: userContent.trim().slice(0, 600), at: now },
      { role: 'assistant' as const, content: assistantContent.trim().slice(0, 1_000), at: now },
    ].slice(-this.maxTurns)

    this.localStore.set(key, {
      turns: updated,
      expiresAt: now + this.ttlSeconds * 1_000,
    })

    if (this.redis?.isEnabled) {
      await this.redis.set(key, updated, this.ttlSeconds).catch((err: unknown) => {
        this.logger?.debug({ err }, 'failed to persist AI memory turn to Redis')
      })
    }
  }

  async clearHistory(remoteJid: string, senderJid: string): Promise<void> {
    const key = this.buildKey(remoteJid, senderJid)
    this.localStore.delete(key)
    if (this.redis?.isEnabled) {
      await this.redis.del(key).catch(() => {})
    }
  }
}
