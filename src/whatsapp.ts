import NodeCache from '@cacheable/node-cache'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  type BaileysEventMap,
  type CacheStore,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import type { AppConfig } from './config.js'
import type {
  CoreConnectionState,
  CoreConnectionStatus,
  CoreGroupParticipantUpdate,
  CoreMessage,
  GroupParticipantRole,
  WhatsAppGroupMetadata,
  WhatsAppPort,
  WhatsAppSendOptions,
} from './framework/contracts.js'
import { AllybotError, errorMessage, statusCodeFromError } from './errors.js'
import type { AppLogger } from './logger.js'
import { SqliteStorage } from './storage.js'

function extractMessageText(message: WAMessage['message'] | null | undefined): string | undefined {
  const text = (
    message?.conversation ??
    message?.extendedTextMessage?.text ??
    message?.imageMessage?.caption ??
    message?.videoMessage?.caption
  )
  return text ?? undefined
}

function extractText(message: WAMessage): string | undefined {
  return extractMessageText(message.message)
}

function extractContextInfo(message: WAMessage) {
  return (
    message.message?.extendedTextMessage?.contextInfo ??
    message.message?.imageMessage?.contextInfo ??
    message.message?.videoMessage?.contextInfo
  )
}

function extractMentionedJids(message: WAMessage): readonly string[] {
  const contextInfo = extractContextInfo(message)
  return [...new Set(contextInfo?.mentionedJid?.filter((jid): jid is string => Boolean(jid)) ?? [])]
}

export async function normalizeContactJid(
  jid: string,
  resolvePnForLid?: (lid: string) => Promise<string | null>,
): Promise<string> {
  const normalized = jidNormalizedUser(jid)
  if (!normalized.endsWith('@lid') || !resolvePnForLid) return normalized

  try {
    const phoneJid = await resolvePnForLid(normalized)
    return phoneJid ? jidNormalizedUser(phoneJid) : normalized
  } catch {
    return normalized
  }
}

function extractQuotedText(message: WAMessage): string | undefined {
  return extractMessageText(extractContextInfo(message)?.quotedMessage)
}

function extractQuotedSenderJid(message: WAMessage): string | undefined {
  const participant = extractContextInfo(message)?.participant
  return participant || undefined
}

export function normalizeMessageTimestamp(value: unknown, fallback = Date.now()): number {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return fallback
  return timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp
}

function formatQr(qr: string): void {
  qrcode.generate(qr, { small: true })
}

function formatUptime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = totalSeconds % 60
  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours || days) parts.push(`${hours}h`)
  if (minutes || hours || days) parts.push(`${minutes}m`)
  parts.push(`${remainingSeconds}s`)
  return parts.join(' ')
}

function formatPingResponse(receivedAt: number): string {
  const latencyMs = Math.max(0, Date.now() - receivedAt)
  return [
    '🦊 ⑅【 Allybot 】',
    '─͜──͜──͜─  · ✿ ·  ─͜──͜──͜─',
    '𖥻 ׁ ׅ 🌸𓏳ᩙ :: "Pong~!! Did someone call for Allybot?"',
    'ㅤ  ㅤ﹊﹊﹊﹊﹊﹊﹊﹊﹊',
    `⡇╌ Latency: ${latencyMs} ms`,
    `⡇╌ Uptime: ${formatUptime(process.uptime())}`,
    '° ° ──────────── · · ·',
    '≛⃞🪷 COMMUNITY: Allyssea Roleplay Community',
    '─────────────────',
    '© Allyssea Roleplay Community',
  ].join('\n')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export class WhatsAppConnection implements WhatsAppPort {
  private socket: WASocket | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private starting = false
  private stopping = false
  private failures = 0
  private generation = 0
  private status: CoreConnectionStatus = 'idle'
  private readonly retryCounterCache: CacheStore
  private watchdogTimer: NodeJS.Timeout | undefined
  private lastActivityAt = Date.now()
  private readonly seenMessages = new Map<string, number>()
  private readonly lastReplyAt = new Map<string, number>()
  private readonly groupNameCache = new Map<string, { name: string; expiresAt: number }>()
  private readonly messageListeners = new Set<(message: CoreMessage) => Promise<void> | void>()
  private readonly groupParticipantListeners = new Set<(event: CoreGroupParticipantUpdate) => Promise<void> | void>()
  private readonly connectionListeners = new Set<(event: CoreConnectionState) => Promise<void> | void>()

  constructor(
    private readonly config: AppConfig,
    private readonly storage: SqliteStorage,
    private readonly logger: AppLogger,
  ) {
    this.retryCounterCache = new NodeCache({ stdTTL: 300, useClones: false }) as unknown as CacheStore
  }

  get currentStatus(): CoreConnectionStatus {
    return this.status
  }

  get isConnected(): boolean {
    return this.status === 'connected'
  }

  get userJid(): string | undefined {
    return this.socket?.user?.id
  }

  onMessage(listener: (message: CoreMessage) => Promise<void> | void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onGroupParticipantUpdate(listener: (event: CoreGroupParticipantUpdate) => Promise<void> | void): () => void {
    this.groupParticipantListeners.add(listener)
    return () => this.groupParticipantListeners.delete(listener)
  }

  onConnectionState(listener: (event: CoreConnectionState) => Promise<void> | void): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  async sendText(remoteJid: string, text: string, options?: WhatsAppSendOptions): Promise<void> {
    const socket = this.socket
    if (!socket || !this.isConnected) throw new Error('WhatsApp socket is not connected')
    const content = options?.mentions?.length
      ? { text, mentions: [...options.mentions], linkPreview: null }
      : { text, linkPreview: null }
    await withTimeout(socket.sendMessage(remoteJid, content), 20000, 'framework text response')
  }

  async getGroupMetadata(groupJid: string): Promise<WhatsAppGroupMetadata> {
    if (!groupJid.endsWith('@g.us')) throw new Error('group metadata is only available for WhatsApp groups')
    const socket = this.socket
    if (!socket || !this.isConnected) throw new Error('WhatsApp socket is not connected')

    const metadata = await withTimeout(socket.groupMetadata(groupJid), 10_000, 'group metadata lookup')
    const resolvePnForLid = (lid: string) => socket.signalRepository.lidMapping.getPNForLID(lid)
    const participants = await Promise.all(metadata.participants.map(async (participant) => {
      const jid = await normalizeContactJid(participant.phoneNumber ?? participant.id, resolvePnForLid)
      const role: GroupParticipantRole = participant.admin === 'superadmin'
        ? 'superadmin'
        : participant.admin === 'admin'
          ? 'admin'
          : participant.admin
            ? 'unknown'
            : 'member'
      return { jid, role }
    }))
    const ownerJid = metadata.owner
      ? await normalizeContactJid(metadata.owner, resolvePnForLid)
      : undefined
    const subject = metadata.subject?.trim() || 'Unnamed group'
    const description = metadata.desc?.trim() || undefined
    return {
      jid: groupJid,
      subject,
      ...(ownerJid ? { ownerJid } : {}),
      ...(description ? { description } : {}),
      participants,
    }
  }

  async getGroupInviteLink(groupJid: string): Promise<string | undefined> {
    if (!groupJid.endsWith('@g.us')) throw new Error('group invite link is only available for WhatsApp groups')
    const socket = this.socket
    if (!socket || !this.isConnected) throw new Error('WhatsApp socket is not connected')
    const code = await withTimeout(socket.groupInviteCode(groupJid), 10_000, 'group invite link lookup')
    return code ? `https://chat.whatsapp.com/${code}` : undefined
  }

  private async resolveGroupName(remoteJid: string): Promise<string | undefined> {
    if (!remoteJid.endsWith('@g.us')) return undefined

    const cached = this.groupNameCache.get(remoteJid)
    if (cached && cached.expiresAt > Date.now()) return cached.name

    const socket = this.socket
    if (!socket) return undefined

    try {
      const metadata = await withTimeout(socket.groupMetadata(remoteJid), 10_000, 'group metadata lookup')
      const name = metadata.subject?.trim()
      if (name) this.groupNameCache.set(remoteJid, { name, expiresAt: Date.now() + 300_000 })
      return name || undefined
    } catch (error) {
      this.logger.debug({ err: errorMessage(error), remoteJid }, 'group metadata lookup failed')
      return undefined
    }
  }

  async start(): Promise<void> {
    this.stopping = false
    if (!this.config.WHATSAPP_ENABLED) {
      this.status = 'idle'
      this.logger.warn('WhatsApp integration disabled; Allybot is running in maintenance mode')
      await this.emitConnectionState({ status: 'idle', reason: 'whatsapp_disabled', at: Date.now() })
      return
    }

    this.startWatchdog()
    await this.startSocket()
  }

  async close(): Promise<void> {
    this.stopping = true
    this.status = 'stopping'
    this.stopWatchdog()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    const socket = this.socket
    this.socket = undefined
    if (socket) {
      try {
        await socket.ws.close()
      } catch (error) {
        this.logger.warn({ err: errorMessage(error) }, 'socket close returned an error')
      }
    }
    this.status = 'idle'
    await this.emitConnectionState({ status: 'idle', at: Date.now() })
  }

  private async startSocket(): Promise<void> {
    if (this.stopping || !this.config.WHATSAPP_ENABLED || this.starting || this.socket) return

    this.starting = true
    this.status = 'connecting'
    const generation = ++this.generation
    const childLogger = this.logger.child({ component: 'whatsapp', generation })

    try {
      const creds = this.storage.loadCreds()
      const integrity = this.storage.verifyIntegrity()
      if (!integrity.valid) {
        throw new AllybotError(
          `Authentication state integrity check failed: ${integrity.reason ?? 'unknown reason'}`,
          'authentication',
        )
      }
      childLogger.info({ keyCount: integrity.keyCount }, 'authentication state integrity verified')
      const keys = makeCacheableSignalKeyStore(this.storage.createKeyStore(), childLogger)
      const socket = makeWASocket({
        auth: { creds, keys },
        browser: Browsers.ubuntu('Allybot'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => this.config.ENABLE_HISTORY_SYNC,
        logger: childLogger,
        msgRetryCounterCache: this.retryCounterCache,
        getMessage: (key) => this.storage.getMessage(key),
      })

      this.socket = socket
      this.attachEventProcessor(socket, creds, generation, childLogger)
    } catch (error) {
      this.status = error instanceof AllybotError && error.category === 'authentication' ? 'needs_auth' : 'failed'
      childLogger.error({ err: errorMessage(error) }, 'socket creation failed')
      if (!(error instanceof AllybotError) || error.retryable) {
        this.scheduleReconnect('socket_creation_failed')
      } else {
        childLogger.error('non-retryable core failure; automatic reconnect disabled')
      }
    } finally {
      this.starting = false
    }
  }

  private attachEventProcessor(
    socket: WASocket,
    creds: ReturnType<SqliteStorage['loadCreds']>,
    generation: number,
    logger: AppLogger,
  ): void {
    socket.ev.process(async (events: Partial<BaileysEventMap>) => {
      if (this.socket !== socket || generation !== this.generation) return
      this.lastActivityAt = Date.now()

      const connectionUpdate = events['connection.update']
      if (connectionUpdate) {
        await this.handleConnectionUpdate(socket, creds, connectionUpdate, logger)
        if (connectionUpdate.connection) {
          await this.emitConnectionState({ status: this.status, at: Date.now() })
        }
      }

      const credsUpdate = events['creds.update']
      if (credsUpdate) {
        Object.assign(creds, credsUpdate)
        this.storage.saveCreds(creds)
      }

      const messageUpsert = events['messages.upsert']
      if (messageUpsert) {
        await this.handleMessages(socket, messageUpsert, logger)
        if (messageUpsert.type === 'notify') await this.emitMessages(messageUpsert.messages)
      }

      const participantUpdate = events['group-participants.update']
      if (participantUpdate) await this.emitGroupParticipantUpdate(participantUpdate)
    })
  }

  private async handleConnectionUpdate(
    socket: WASocket,
    creds: ReturnType<SqliteStorage['loadCreds']>,
    update: BaileysEventMap['connection.update'],
    logger: AppLogger,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update

    if (qr && !creds.registered) {
      if (this.config.QR_ENABLED) {
        logger.info('QR received; scan it from WhatsApp Linked Devices')
        formatQr(qr)
      }

      if (this.config.PAIRING_ENABLED && this.config.PAIRING_PHONE_NUMBER) {
        try {
          const code = await withTimeout(
            socket.requestPairingCode(this.config.PAIRING_PHONE_NUMBER),
            30000,
            'pairing code request',
          )
          logger.info({ pairingCode: code }, 'pairing code generated')
        } catch (error) {
          logger.error({ err: errorMessage(error) }, 'pairing code request failed')
        }
      }
    }

    if (connection === 'connecting') {
      this.status = 'connecting'
      logger.info('connecting to WhatsApp')
      return
    }

    if (connection === 'open') {
      this.status = 'connected'
      this.failures = 0
      logger.info({ userJid: socket.user?.id }, 'WhatsApp connection opened')
      return
    }

    if (connection !== 'close') return

    this.socket = undefined
    const statusCode = statusCodeFromError(lastDisconnect?.error)
    logger.warn({ statusCode }, 'WhatsApp connection closed')

    if (this.stopping) return

    if (statusCode === DisconnectReason.loggedOut) {
      this.status = 'needs_auth'
      logger.error('WhatsApp session is logged out; operator re-authentication is required')
      return
    }

    if (statusCode === 408) {
      this.status = 'failed'
      logger.error('WhatsApp connection timed out (408); re-authentication is paused to avoid repeated attempts')
      return
    }

    if (statusCode === DisconnectReason.connectionReplaced) {
      this.status = 'failed'
      logger.error('WhatsApp session was replaced by another connection; manual action is required')
      return
    }

    this.scheduleReconnect(`connection_closed_${statusCode ?? 'unknown'}`)
  }

  private async handleMessages(
    socket: WASocket,
    upsert: BaileysEventMap['messages.upsert'],
    logger: AppLogger,
  ): Promise<void> {
    if (upsert.requestId) {
      logger.warn({ requestId: upsert.requestId }, 'dropping messages.upsert with requestId')
      return
    }

    if (upsert.type !== 'notify') return
    this.storage.saveMessages(upsert.messages)

    for (const message of upsert.messages) {
      const receivedAt = Date.now()
      if (message.key.fromMe || !message.key.remoteJid || !message.key.id) continue
      const dedupKey = `${message.key.remoteJid}:${message.key.id}`
      if (this.isDuplicate(dedupKey)) {
        logger.debug({ remoteJid: message.key.remoteJid }, 'duplicate message ignored')
        continue
      }
      const text = extractText(message)?.trim().toLowerCase()
      if (text !== '!ping') continue
      if (this.isRateLimited(message.key.remoteJid)) {
        logger.warn({ remoteJid: message.key.remoteJid }, 'core ping rate limited')
        continue
      }

      try {
        await withTimeout(
          socket.sendMessage(message.key.remoteJid, {
            text: formatPingResponse(receivedAt),
            linkPreview: null,
          }),
          20000,
          'core ping response',
        )
        logger.info({ remoteJid: message.key.remoteJid }, 'core ping response sent')
      } catch (error) {
        logger.error({ err: errorMessage(error) }, 'core ping response failed')
      }
    }
  }

  private async emitMessages(messages: readonly WAMessage[]): Promise<void> {
    const normalized = (await Promise.all(messages.map(async (message) => {
      const remoteJid = message.key.remoteJid
      const id = message.key.id
      if (!remoteJid || !id) return undefined
      const timestamp = normalizeMessageTimestamp(message.messageTimestamp)
      const resolvePnForLid = (lid: string) => this.socket?.signalRepository.lidMapping.getPNForLID(lid) ?? Promise.resolve(null)
      const rawSenderJid = message.key.participantAlt ?? message.key.participant ?? (message.key.fromMe ? undefined : remoteJid)
      const senderJid = rawSenderJid ? await normalizeContactJid(rawSenderJid, resolvePnForLid) : undefined
      const mentionedJids: readonly string[] = [...new Set(await Promise.all(
        extractMentionedJids(message).map((jid) => normalizeContactJid(jid, resolvePnForLid)),
      ))]
      const text = extractText(message)
      const quotedText = extractQuotedText(message)
      const rawQuotedSenderJid = extractQuotedSenderJid(message)
      const quotedSenderJid = rawQuotedSenderJid
        ? await normalizeContactJid(rawQuotedSenderJid, resolvePnForLid)
        : undefined
      const groupName = mentionedJids.length > 0 || quotedSenderJid
        ? await this.resolveGroupName(remoteJid)
        : undefined
      return {
        id,
        remoteJid,
        ...(senderJid ? { senderJid } : {}),
        ...(mentionedJids.length > 0 ? { mentionedJids } : {}),
        ...(text ? { text } : {}),
        ...(quotedText ? { quotedText } : {}),
        ...(quotedSenderJid ? { quotedSenderJid } : {}),
        ...(groupName ? { groupName } : {}),
        timestamp,
        fromMe: Boolean(message.key.fromMe),
      } satisfies CoreMessage
    }))).filter((message): message is CoreMessage => Boolean(message))

    for (const message of normalized) {
      const results = await Promise.allSettled([...this.messageListeners].map((listener) => listener(message)))
      for (const result of results) {
        if (result.status === 'rejected') {
          this.logger.error({ err: result.reason, messageId: message.id }, 'core message listener failed')
        }
      }
    }
  }

  private async emitGroupParticipantUpdate(
    update: BaileysEventMap['group-participants.update'],
  ): Promise<void> {
    const participantJids = update.participants
      .map((participant) => participant.phoneNumber ?? participant.id)
      .filter((jid): jid is string => Boolean(jid))

    if (!update.id || participantJids.length === 0) return
    const groupName = await this.resolveGroupName(update.id)
    const event: CoreGroupParticipantUpdate = {
      groupJid: update.id,
      ...(groupName ? { groupName } : {}),
      action: update.action,
      participantJids,
      at: Date.now(),
    }

    const results = await Promise.allSettled([...this.groupParticipantListeners].map((listener) => listener(event)))
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error({ err: result.reason, groupJid: update.id, action: update.action }, 'group participant listener failed')
      }
    }
  }

  private async emitConnectionState(event: CoreConnectionState): Promise<void> {
    const results = await Promise.allSettled([...this.connectionListeners].map((listener) => listener(event)))
    for (const result of results) {
      if (result.status === 'rejected') this.logger.error({ err: result.reason, status: event.status }, 'core connection listener failed')
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopping || !this.config.WHATSAPP_ENABLED || this.reconnectTimer) return

    this.failures += 1
    const exponential = Math.min(
      this.config.MAX_RECONNECT_DELAY_MS,
      2000 * 2 ** Math.min(this.failures - 1, 8),
    )
    const jitter = Math.floor(Math.random() * Math.max(250, exponential * 0.2))
    const delay = Math.min(this.config.MAX_RECONNECT_DELAY_MS, exponential + jitter)
    this.status = 'reconnecting'
    this.logger.warn({ reason, failures: this.failures, delayMs: delay }, 'reconnect scheduled')

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.startSocket()
    }, delay)
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) return
    this.watchdogTimer = setInterval(() => {
      void this.watchdogTick()
    }, 30000)
    this.watchdogTimer.unref?.()
  }

  private stopWatchdog(): void {
    if (!this.watchdogTimer) return
    clearInterval(this.watchdogTimer)
    this.watchdogTimer = undefined
  }

  private async watchdogTick(): Promise<void> {
    const socket = this.socket
    if (this.stopping || !socket || this.status !== 'connected') return
    if (socket.ws.isOpen) return

    this.logger.warn({ lastActivityAgeMs: Date.now() - this.lastActivityAt }, 'watchdog found a closed socket')
    this.socket = undefined
    try {
      await socket.ws.close()
    } catch (error) {
      this.logger.debug({ err: errorMessage(error) }, 'watchdog socket close returned an error')
    }
    this.scheduleReconnect('watchdog_closed_socket')
  }

  private isDuplicate(key: string): boolean {
    const now = Date.now()
    for (const [oldKey, seenAt] of this.seenMessages) {
      if (now - seenAt > 10 * 60 * 1000) this.seenMessages.delete(oldKey)
    }
    if (this.seenMessages.has(key)) return true
    this.seenMessages.set(key, now)
    if (this.seenMessages.size > 5000) {
      const oldest = this.seenMessages.keys().next().value
      if (oldest) this.seenMessages.delete(oldest)
    }
    return false
  }

  private isRateLimited(remoteJid: string): boolean {
    const now = Date.now()
    const previous = this.lastReplyAt.get(remoteJid) ?? 0
    for (const [jid, repliedAt] of this.lastReplyAt) {
      if (now - repliedAt > 10 * 60 * 1000) this.lastReplyAt.delete(jid)
    }
    if (now - previous < 3000) return true
    this.lastReplyAt.set(remoteJid, now)
    return false
  }
}
