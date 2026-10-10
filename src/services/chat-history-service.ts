import type { Logger } from 'pino'
import type { Service, ServiceContext, CoreMessage } from '../framework/contracts.js'
import { isGroupJid } from '../framework/validation.js'
import type { RedisService } from '../redis.js'

export interface ChatHistoryEntry {
  readonly senderJid: string
  readonly pushName: string
  readonly text: string
  readonly timestamp: number
}

export interface ChatHistoryServiceOptions {
  readonly redis?: RedisService
  readonly maxItems?: number
  readonly ttlSeconds?: number
}

const DEFAULT_MAX_ITEMS = 100
const DEFAULT_TTL_SECONDS = 86_400 // 24 hours

export class ChatHistoryService implements Service {
  readonly name = 'chat-history'
  readonly id = 'chat-history'

  private logger?: Logger
  private redis?: RedisService
  private readonly maxItems: number
  private readonly ttlSeconds: number
  private readonly memoryBuffer = new Map<string, ChatHistoryEntry[]>()

  constructor(logger?: Logger, options: ChatHistoryServiceOptions = {}) {
    this.logger = logger
    this.redis = options.redis
    this.maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS
  }

  async initialize(context: ServiceContext): Promise<void> {
    this.logger = context.logger
    if (!this.redis && context.services.has('redis')) {
      this.redis = context.services.get<RedisService>('redis')
    }
  }

  async shutdown(): Promise<void> {
    this.memoryBuffer.clear()
  }

  /**
   * Filter and record message into group history.
   */
  async recordMessage(message: CoreMessage): Promise<void> {
    if (!isGroupJid(message.remoteJid)) return
    if (message.fromMe) return

    const text = message.text?.trim()
    if (!text) return

    // Ignore command messages (prefixed with !, ., /, #)
    if (/^[!/.#]/.test(text)) return

    const senderJid = message.senderJid ?? message.remoteJid
    const pushName = (message.pushName || 'Member').trim().slice(0, 50)
    const entry: ChatHistoryEntry = {
      senderJid,
      pushName,
      text: text.slice(0, 1000),
      timestamp: message.timestamp || Date.now(),
    }

    const groupJid = message.remoteJid
    const redisKey = `chat:history:${groupJid}`

    // Update in-memory ring buffer
    const current = this.memoryBuffer.get(groupJid) ?? []
    current.push(entry)
    if (current.length > this.maxItems) {
      current.splice(0, current.length - this.maxItems)
    }
    this.memoryBuffer.set(groupJid, current)

    // Primary: Redis persistence if available
    if (this.redis?.isEnabled) {
      try {
        await this.redis.enqueueBounded(redisKey, entry, this.maxItems, this.ttlSeconds)
      } catch (error) {
        this.logger?.warn(
          { err: error instanceof Error ? error.message : 'UnknownError', groupJid },
          'Failed to record chat history to Redis',
        )
      }
    }
  }

  /**
   * Retrieve recent messages for a group.
   * Returns items in chronological order (oldest to newest).
   */
  async getRecentMessages(groupJid: string, limit = 30): Promise<readonly ChatHistoryEntry[]> {
    const cappedLimit = Math.min(Math.max(limit, 1), this.maxItems)
    const redisKey = `chat:history:${groupJid}`

    if (this.redis?.isEnabled) {
      try {
        const fromRedis = await this.redis.getBoundedList<ChatHistoryEntry>(redisKey, cappedLimit)
        if (fromRedis && fromRedis.length > 0) {
          return fromRedis
        }
      } catch (error) {
        this.logger?.warn(
          { err: error instanceof Error ? error.message : 'UnknownError', groupJid },
          'Failed to fetch chat history from Redis, falling back to memory buffer',
        )
      }
    }

    const fromMemory = this.memoryBuffer.get(groupJid) ?? []
    return fromMemory.slice(-cappedLimit)
  }
}
