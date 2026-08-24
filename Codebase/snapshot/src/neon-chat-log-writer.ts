import { createHash } from 'node:crypto'
import type { Logger } from 'pino'
import type { Sql } from 'postgres'
import type { CoreMessage } from './framework/contracts.js'

export interface NeonChatLogRecord {
  readonly eventKey: string
  readonly groupJid: string
  readonly groupName: string | null
  readonly senderJid: string | null
  readonly messageId: string
  readonly messageTimestamp: number
  readonly receivedAt: number | null
  readonly fromMe: boolean
  readonly messageType: 'text' | 'button' | 'text_button' | 'other'
  readonly text: string | null
  readonly buttonId: string | null
  readonly quotedText: string | null
  readonly quotedSenderJid: string | null
  readonly mentionedJidsJson: string
  readonly contentSha256: string
}

export type NeonChatLogEnqueueResult = 'queued' | 'group-disabled' | 'queue-full' | 'invalid' | 'closed'

export interface NeonChatLogWriterOptions {
  readonly groupJids: ReadonlySet<string>
  readonly queueCapacity: number
  readonly maxAttempts: number
  readonly retryDelayMs: number
  readonly maxRetryDelayMs: number
  readonly drainTimeoutMs: number
  readonly sleep?: (delayMs: number) => Promise<void>
}

export interface NeonChatLogWriterStats {
  readonly queueDepth: number
  readonly accepted: number
  readonly persisted: number
  readonly failed: number
  readonly dropped: number
  readonly retries: number
}

export interface NeonChatLogCloseResult {
  readonly drained: boolean
  readonly remaining: number
}

const MAX_TEXT_LENGTH = 128_000
const MAX_IDENTIFIER_LENGTH = 512
const MAX_MENTION_COUNT = 100

const INSERT_CHAT_LOG_SQL = `
  INSERT INTO public.whatsapp_chat_logs (
    event_key,
    group_jid,
    group_name,
    sender_jid,
    message_id,
    message_timestamp,
    received_at,
    from_me,
    message_type,
    content_text,
    button_id,
    quoted_text,
    quoted_sender_jid,
    mentioned_jids_json,
    content_sha256
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  ON CONFLICT (event_key) DO NOTHING
`

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function boundedText(value: string | undefined, field: string, maxLength = MAX_TEXT_LENGTH): string | null {
  if (value === undefined || value === '') return null
  if (value.length > maxLength) throw new Error(`${field} exceeds bounded length`)
  return value
}

function boundedRequired(value: string, field: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
  if (!value || value.length > maxLength) throw new Error(`${field} is invalid or exceeds bounded length`)
  return value
}

export function isRetryableNeonError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : ''
  if (/^(08|40|53|57)/.test(code)) return true
  if (code === 'ENETUNREACH' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN') return true
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return /connection|connect|timeout|temporarily unavailable|too many clients|server closed/i.test(message)
}

export function toNeonChatLogRecord(message: CoreMessage): NeonChatLogRecord {
  const messageId = boundedRequired(message.id, 'message id')
  const groupJid = boundedRequired(message.remoteJid, 'group jid')
  const senderJid = boundedText(message.senderJid, 'sender jid', MAX_IDENTIFIER_LENGTH)
  const groupName = boundedText(message.groupName, 'group name', MAX_IDENTIFIER_LENGTH)
  const text = boundedText(message.text, 'message text')
  const buttonId = boundedText(message.buttonId, 'button id', MAX_IDENTIFIER_LENGTH)
  const quotedText = boundedText(message.quotedText, 'quoted text')
  const quotedSenderJid = boundedText(message.quotedSenderJid, 'quoted sender jid', MAX_IDENTIFIER_LENGTH)
  if (!Number.isSafeInteger(message.timestamp) || message.timestamp <= 0) throw new Error('message timestamp is invalid')
  if (message.receivedAt !== undefined && (!Number.isSafeInteger(message.receivedAt) || message.receivedAt <= 0)) {
    throw new Error('message receivedAt is invalid')
  }

  const mentionedJids = message.mentionedJids ? [...message.mentionedJids] : []
  if (mentionedJids.length > MAX_MENTION_COUNT || mentionedJids.some((jid) => jid.length > MAX_IDENTIFIER_LENGTH)) {
    throw new Error('mentioned JIDs exceed bounded limits')
  }

  const messageType: NeonChatLogRecord['messageType'] = text && buttonId
    ? 'text_button'
    : text
      ? 'text'
      : buttonId
        ? 'button'
        : 'other'
  const eventKey = `${groupJid}:${messageId}`
  const canonical = JSON.stringify({
    eventKey,
    groupJid,
    senderJid,
    messageTimestamp: message.timestamp,
    fromMe: message.fromMe,
    messageType,
    text,
    buttonId,
    quotedText,
    quotedSenderJid,
    mentionedJids,
  })

  return {
    eventKey,
    groupJid,
    groupName,
    senderJid,
    messageId,
    messageTimestamp: message.timestamp,
    receivedAt: message.receivedAt ?? null,
    fromMe: message.fromMe,
    messageType,
    text,
    buttonId,
    quotedText,
    quotedSenderJid,
    mentionedJidsJson: JSON.stringify(mentionedJids),
    contentSha256: createHash('sha256').update(canonical).digest('hex'),
  }
}

export class NeonChatLogWriter {
  private readonly queue: NeonChatLogRecord[] = []
  private readonly sleep: (delayMs: number) => Promise<void>
  private readonly idleWaiters = new Set<() => void>()
  private processing = false
  private closing = false
  private accepted = 0
  private persisted = 0
  private failed = 0
  private dropped = 0
  private retries = 0

  constructor(
    private readonly sql: Sql,
    private readonly logger: Logger,
    private readonly options: NeonChatLogWriterOptions,
  ) {
    if (options.groupJids.size === 0) throw new Error('NEON_CHAT_LOG_GROUPS must contain at least one group JID')
    if (!Number.isInteger(options.queueCapacity) || options.queueCapacity < 1) throw new Error('queueCapacity must be positive')
    if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1) throw new Error('maxAttempts must be positive')
    if (!Number.isInteger(options.retryDelayMs) || options.retryDelayMs < 1) throw new Error('retryDelayMs must be positive')
    if (!Number.isInteger(options.maxRetryDelayMs) || options.maxRetryDelayMs < options.retryDelayMs) throw new Error('maxRetryDelayMs is invalid')
    if (!Number.isInteger(options.drainTimeoutMs) || options.drainTimeoutMs < 1) throw new Error('drainTimeoutMs must be positive')
    this.sleep = options.sleep ?? defaultSleep
  }

  enqueue(message: CoreMessage): NeonChatLogEnqueueResult {
    if (this.closing) return 'closed'
    if (!this.options.groupJids.has(message.remoteJid)) return 'group-disabled'
    if (this.queue.length + (this.processing ? 1 : 0) >= this.options.queueCapacity) {
      this.dropped += 1
      return 'queue-full'
    }

    let record: NeonChatLogRecord
    try {
      record = toNeonChatLogRecord(message)
    } catch {
      this.dropped += 1
      return 'invalid'
    }
    this.queue.push(record)
    this.accepted += 1
    void this.pump()
    return 'queued'
  }

  getStats(): NeonChatLogWriterStats {
    return {
      queueDepth: this.queue.length,
      accepted: this.accepted,
      persisted: this.persisted,
      failed: this.failed,
      dropped: this.dropped,
      retries: this.retries,
    }
  }

  async close(): Promise<NeonChatLogCloseResult> {
    if (this.closing) {
      return {
        drained: !this.processing && this.queue.length === 0,
        remaining: this.queue.length + (this.processing ? 1 : 0),
      }
    }
    this.closing = true
    const drained = await this.waitForIdle(this.options.drainTimeoutMs)
    const queuedRemaining = this.queue.length
    const inFlight = this.processing ? 1 : 0
    const remaining = queuedRemaining + inFlight
    if (!drained && queuedRemaining > 0) {
      this.dropped += queuedRemaining
      this.queue.length = 0
      this.logger.warn({ remaining, queuedRemaining, inFlight }, 'Neon chat-log queue drain timed out; queued records dropped')
    }
    return { drained, remaining }
  }

  private async pump(): Promise<void> {
    if (this.processing) return
    this.processing = true
    try {
      while (this.queue.length > 0) {
        const record = this.queue.shift()
        if (!record) continue
        try {
          await this.writeWithRetry(record)
          this.persisted += 1
        } catch (error) {
          this.failed += 1
          this.logger.error({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'Neon chat-log write failed')
        }
      }
    } finally {
      this.processing = false
      this.notifyIdle()
      if (!this.closing && this.queue.length > 0) void this.pump()
    }
  }

  private async writeWithRetry(record: NeonChatLogRecord): Promise<void> {
    let attempt = 0
    while (attempt < this.options.maxAttempts) {
      attempt += 1
      try {
        await this.sql.unsafe(INSERT_CHAT_LOG_SQL, [
          record.eventKey,
          record.groupJid,
          record.groupName,
          record.senderJid,
          record.messageId,
          record.messageTimestamp,
          record.receivedAt,
          record.fromMe,
          record.messageType,
          record.text,
          record.buttonId,
          record.quotedText,
          record.quotedSenderJid,
          record.mentionedJidsJson,
          record.contentSha256,
        ])
        return
      } catch (error) {
        if (attempt >= this.options.maxAttempts || !isRetryableNeonError(error)) throw error
        this.retries += 1
        const delay = Math.min(this.options.maxRetryDelayMs, this.options.retryDelayMs * 2 ** (attempt - 1))
        await this.sleep(delay)
      }
    }
  }

  private waitForIdle(timeoutMs: number): Promise<boolean> {
    if (!this.processing && this.queue.length === 0) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const finish = (drained: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.idleWaiters.delete(onIdle)
        resolve(drained)
      }
      const onIdle = () => finish(true)
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.idleWaiters.add(onIdle)
    })
  }

  private notifyIdle(): void {
    if (this.processing || this.queue.length > 0) return
    for (const onIdle of [...this.idleWaiters]) onIdle()
  }
}
