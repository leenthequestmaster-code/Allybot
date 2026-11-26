import type { Logger } from 'pino'
import type { Service, ServiceContext, CoreMessage } from '../framework/contracts.js'
import { isGroupJid } from '../framework/validation.js'
import type { RedisService } from '../redis.js'
import type { AllybotMemoryService } from './allybot-memory-service.js'

export interface ChatHistoryEntry {
  readonly messageId?: string
  readonly quotedMessageId?: string
  readonly senderJid: string
  readonly pushName: string
  readonly text: string
  readonly timestamp: number
}

export interface ChatHistoryServiceOptions {
  readonly redis?: RedisService
  readonly allybotMemory?: AllybotMemoryService
  readonly maxItems?: number
  readonly ttlSeconds?: number
}

const DEFAULT_MAX_ITEMS = 400
const DEFAULT_TTL_SECONDS = 86_400 // 24 hours

export class ChatHistoryService implements Service {
  readonly name = 'chat-history'
  readonly id = 'chat-history'

  private logger?: Logger
  private redis?: RedisService
  private allybotMemory?: AllybotMemoryService
  private readonly maxItems: number
  private readonly ttlSeconds: number
  private readonly memoryBuffer = new Map<string, ChatHistoryEntry[]>()

  constructor(logger?: Logger, options: ChatHistoryServiceOptions = {}) {
    this.logger = logger
    this.redis = options.redis
    this.allybotMemory = options.allybotMemory
    this.maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS
  }

  async initialize(context: ServiceContext): Promise<void> {
    this.logger = context.logger
    if (!this.redis && context.services.has('redis')) {
      this.redis = context.services.get<RedisService>('redis')
    }
    if (!this.allybotMemory && context.services.has('allybot-memory')) {
      this.allybotMemory = context.services.get<AllybotMemoryService>('allybot-memory')
    }
  }

  async shutdown(): Promise<void> {
    this.memoryBuffer.clear()
  }

  async recordMessage(message: CoreMessage): Promise<void> {
    if (!isGroupJid(message.remoteJid)) return
    if (message.fromMe) return

    const text = message.text?.trim()
    if (!text) return

    // Ignore command messages (prefixed with !, ., /, #)
    if (/^[!/.#]/.test(text)) return

    const senderJid = message.senderJid ?? message.remoteJid
    const pushName = (message.pushName || 'Member').trim().slice(0, 50)
    const timestamp = message.timestamp || Date.now()
    const entry: ChatHistoryEntry = {
      ...(message.id ? { messageId: message.id } : {}),
      ...(message.quotedMessageId ? { quotedMessageId: message.quotedMessageId } : {}),
      senderJid,
      pushName,
      text: text.slice(0, 2_000),
      timestamp,
    }

    const groupJid = message.remoteJid
    const redisKey = `chat:history:${groupJid}`

    const current = this.memoryBuffer.get(groupJid) ?? []
    current.push(entry)
    if (current.length > this.maxItems) {
      current.splice(0, current.length - this.maxItems)
    }
    this.memoryBuffer.set(groupJid, current)

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

    if (this.allybotMemory?.isEnabled && message.id) {
      void this.allybotMemory.recordGroupArchiveMessage({
        groupJid,
        messageId: message.id,
        senderJid,
        pushName,
        text: entry.text,
        ...(message.quotedMessageId ? { quotedMessageId: message.quotedMessageId } : {}),
        timestampMs: timestamp,
      })
    }
  }

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
