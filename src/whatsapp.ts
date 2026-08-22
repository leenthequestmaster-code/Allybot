import NodeCache from '@cacheable/node-cache'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  generateMessageIDV2,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  proto,
  type BaileysEventMap,
  type BinaryNode,
  type CacheStore,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import type { AppConfig } from './config.js'
import type { NativeQuickReplyPayload, NativeQuickReplyTransport } from './platform/buttons.js'
import type {
  CoreConnectionState,
  CoreConnectionStatus,
  CoreGroupParticipantUpdate,
  GroupModerationAction,
  GroupSettingValue,
  RuntimeCacheClearResult,
  WhatsAppGroupParticipantActionResult,
  CoreMessage,
  GroupParticipantRole,
  WhatsAppGroupMetadata,
  WhatsAppGroupSummary,
  WhatsAppPollOptions,
  WhatsAppPort,
  WhatsAppSendOptions,
} from './framework/contracts.js'
import { AllybotError, errorMessage, statusCodeFromError } from './errors.js'
import type { AppLogger } from './logger.js'
import { SqliteStorage } from './storage.js'
import type { UpstashRedisService } from './upstash-redis.js'
import { isGroupJid } from './platform/validation.js'

function extractMessageText(message: WAMessage['message'] | null | undefined): string | undefined {
  const text = (
    message?.conversation ??
    message?.extendedTextMessage?.text ??
    message?.imageMessage?.caption ??
    message?.videoMessage?.caption
  )
  return text ?? undefined
}

const PROFILE_PICTURE_TIMEOUT_MS = 5_000
const PROFILE_PICTURE_CACHE_TTL_MS = 5 * 60_000

function nativeFlowAdditionalNodes(remoteJid: string) {
  const nodes: BinaryNode[] = [
    {
      tag: 'biz',
      attrs: {},
      content: [
        {
          tag: 'interactive',
          attrs: { type: 'native_flow', v: '1' },
          content: [
            { tag: 'native_flow', attrs: { v: '9', name: 'mixed' } },
          ],
        },
      ],
    },
  ]

  if (!isGroupJid(remoteJid)) {
    nodes.push({ tag: 'bot', attrs: { biz_bot: '1' } })
  }

  return nodes
}

export function extractText(message: WAMessage): string | undefined {
  return extractMessageText(message.message)
}

export function extractButtonId(message: WAMessage): string | undefined {
  const content = message.message as unknown as Record<string, unknown> | null | undefined
  const buttonsResponse = content?.buttonsResponseMessage as Record<string, unknown> | null | undefined
  const templateResponse = content?.templateButtonReplyMessage as Record<string, unknown> | null | undefined
  const listResponse = content?.listResponseMessage as Record<string, unknown> | null | undefined
  const singleSelectReply = listResponse?.singleSelectReply as Record<string, unknown> | null | undefined
  const interactiveResponse = content?.interactiveResponseMessage as Record<string, unknown> | null | undefined
  const nativeFlowResponse = interactiveResponse?.nativeFlowResponseMessage as Record<string, unknown> | null | undefined
  const paramsJson = nativeFlowResponse?.paramsJson

  const direct = [buttonsResponse?.selectedButtonId, templateResponse?.selectedId, singleSelectReply?.selectedRowId]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  if (direct) return direct.trim()

  if (typeof paramsJson !== 'string' || paramsJson.length > 4096) return undefined
  try {
    const parsed = JSON.parse(paramsJson) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const candidate = (parsed as Record<string, unknown>).id
      ?? (parsed as Record<string, unknown>).buttonId
      ?? (parsed as Record<string, unknown>).selectedId
    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : undefined
  } catch {
    return undefined
  }
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

export class WhatsAppConnection implements WhatsAppPort, NativeQuickReplyTransport {
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
  private readonly groupNameCache = new Map<string, { name: string; expiresAt: number }>()
  private readonly profilePictureCache = new Map<string, { url?: string; expiresAt: number }>()
  private readonly messageListeners = new Set<(message: CoreMessage) => Promise<void> | void>()
  private readonly groupParticipantListeners = new Set<(event: CoreGroupParticipantUpdate) => Promise<void> | void>()
  private readonly connectionListeners = new Set<(event: CoreConnectionState) => Promise<void> | void>()

  constructor(
    private readonly config: AppConfig,
    private readonly storage: SqliteStorage,
    private readonly logger: AppLogger,
    private readonly redis?: UpstashRedisService,
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

  clearRuntimeCaches(): RuntimeCacheClearResult {
    const retryCache = this.retryCounterCache as unknown as NodeCache<unknown>
    const result = {
      duplicateMessages: this.seenMessages.size,
      groupNames: this.groupNameCache.size,
      retryCounters: retryCache.keys().length,
    }
    this.seenMessages.clear()
    this.groupNameCache.clear()
    this.profilePictureCache.clear()
    retryCache.flushAll()
    return result
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

  async sendNativePoll(remoteJid: string, options: WhatsAppPollOptions): Promise<void> {
    const socket = this.socket
    if (!socket || !this.isConnected) throw new Error('WhatsApp socket is not connected')
    const name = options.name.trim()
    const values = options.values.map((value) => value.trim())
    if (!name || name.length > 200 || values.length < 2 || values.length > 12 || values.some((value) => !value || value.length > 100)) {
      throw new Error('Invalid native poll payload')
    }
    if (!Number.isInteger(options.selectableCount) || options.selectableCount < 1 || options.selectableCount > values.length) {
      throw new Error('Invalid native poll selection count')
    }
    await withTimeout(
      socket.sendMessage(remoteJid, {
        poll: {
          name,
          values,
          selectableCount: options.selectableCount,
        },
      }),
      20_000,
      'native poll response',
    )
  }

  async getProfilePictureUrl(jid: string, type: 'preview' | 'image' = 'image', timeoutMs = PROFILE_PICTURE_TIMEOUT_MS): Promise<string | undefined> {
    const socket = this.socket
    if (!socket || !this.isConnected) return undefined

    let normalizedJid: string
    try {
      normalizedJid = jidNormalizedUser(jid)
    } catch {
      return undefined
    }

    const cacheKey = `${normalizedJid}:${type}`
    const cached = this.profilePictureCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) return cached.url
    this.profilePictureCache.delete(cacheKey)

    const boundedTimeout = Number.isFinite(timeoutMs)
      ? Math.max(1_000, Math.min(Math.floor(timeoutMs), 10_000))
      : PROFILE_PICTURE_TIMEOUT_MS

    try {
      const url = await withTimeout(
        socket.profilePictureUrl(normalizedJid, type, boundedTimeout),
        boundedTimeout,
        'profile picture lookup',
      )
      const parsed = url ? new URL(url) : undefined
      const safeUrl = parsed?.protocol === 'https:' ? parsed.toString() : undefined
      this.profilePictureCache.set(cacheKey, {
        url: safeUrl,
        expiresAt: Date.now() + PROFILE_PICTURE_CACHE_TTL_MS,
      })
      return safeUrl
    } catch (error) {
      this.logger.debug({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'profile picture lookup unavailable')
      this.profilePictureCache.set(cacheKey, {
        expiresAt: Date.now() + 30_000,
      })
      return undefined
    }
  }

  async sendImage(remoteJid: string, imageUrl: string, caption?: string): Promise<void> {
    const socket = this.socket
    if (!socket || !this.isConnected) throw new Error('WhatsApp socket is not connected')
    const parsed = new URL(imageUrl)
    if (parsed.protocol !== 'https:') throw new Error('Image URL must use HTTPS')
    const content = caption ? { image: { url: parsed.toString() }, caption } : { image: { url: parsed.toString() } }
    await withTimeout(socket.sendMessage(remoteJid, content), 20_000, 'framework image response')
  }

  async sendNativeQuickReplies(remoteJid: string, payload: NativeQuickReplyPayload): Promise<void> {
    const socket = this.socket
    if (!socket || !this.isConnected) throw new Error('WhatsApp socket is not connected')
    if (!remoteJid || payload.buttons.length === 0 || payload.buttons.length > 3) throw new Error('Invalid native quick-reply payload')

    const message = proto.Message.create({
      interactiveMessage: proto.Message.InteractiveMessage.create({
        body: proto.Message.InteractiveMessage.Body.create({ text: payload.body }),
        ...(payload.footer ? { footer: proto.Message.InteractiveMessage.Footer.create({ text: payload.footer }) } : {}),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
          messageVersion: 1,
          buttons: payload.buttons.map((button) => proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create({
            name: 'quick_reply',
            buttonParamsJson: JSON.stringify({ display_text: button.title, id: button.id }),
          })),
        }),
      }),
    })

    await withTimeout(
      socket.relayMessage(remoteJid, message, {
        messageId: generateMessageIDV2(socket.user?.id),
        additionalNodes: nativeFlowAdditionalNodes(remoteJid),
      }),
      20_000,
      'native quick-reply response',
    )
  }

  async listParticipatingGroups(): Promise<readonly WhatsAppGroupSummary[]> {
    const socket = this.socket
    if (!socket || !this.isConnected) throw new Error('WhatsApp socket is not connected')

    const groups = await withTimeout(socket.groupFetchAllParticipating(), 10_000, 'participating group lookup')
    return Object.entries(groups)
      .filter(([jid]) => isGroupJid(jid))
      .map(([jid, metadata]) => ({
        jid,
        subject: metadata.subject?.trim() || 'Unnamed group',
      }))
      .sort((left, right) => left.subject.localeCompare(right.subject) || left.jid.localeCompare(right.jid))
  }

  async getGroupMetadata(groupJid: string): Promise<WhatsAppGroupMetadata> {
    if (!isGroupJid(groupJid)) throw new Error('group metadata is only available for WhatsApp groups')
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

  async groupParticipantsUpdate(
    groupJid: string,
    participantJids: readonly string[],
    action: GroupModerationAction,
  ): Promise<readonly WhatsAppGroupParticipantActionResult[]> {
    if (!isGroupJid(groupJid)) throw new Error('group participant update is only available for WhatsApp groups')
    if (participantJids.length < 1 || participantJids.length > 20) throw new Error('group participant update target count is out of bounds')
    const socket = this.socket
    if (!socket || !this.isConnected) throw new Error('WhatsApp socket is not connected')

    const resolvePnForLid = (lid: string) => socket.signalRepository.lidMapping.getPNForLID(lid)
    const normalizedJids = [...new Set(await Promise.all(participantJids.map((jid) => normalizeContactJid(jid, resolvePnForLid))))]
    if (normalizedJids.length === 0) throw new Error('group participant update requires at least one target')

    try {
      const results = await withTimeout(socket.groupParticipantsUpdate(groupJid, normalizedJids, action), 20_000, 'group participant update')
      return Promise.all(results.map(async (result, index) => ({
        participantJid: result.jid
          ? await normalizeContactJid(result.jid, resolvePnForLid)
          : normalizedJids[index] ?? 'unknown',
        status: result.status === '200' ? 'ok' : (typeof result.status === 'string' && result.status ? result.status : 'unknown'),
      })))
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'group participant update failed')
      throw error
    }
  }

  async groupSettingUpdate(groupJid: string, setting: GroupSettingValue): Promise<void> {
    if (!isGroupJid(groupJid)) throw new Error('group setting update is only available for WhatsApp groups')
    const socket = this.socket
    if (!socket || !this.isConnected) throw new Error('WhatsApp socket is not connected')

    try {
      await withTimeout(socket.groupSettingUpdate(groupJid, setting), 20_000, 'group setting update')
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'group setting update failed')
      throw error
    }
  }

  async getGroupInviteLink(groupJid: string): Promise<string | undefined> {
    if (!isGroupJid(groupJid)) throw new Error('group invite link is only available for WhatsApp groups')
    const socket = this.socket
    if (!socket || !this.isConnected) throw new Error('WhatsApp socket is not connected')
    const code = await withTimeout(socket.groupInviteCode(groupJid), 10_000, 'group invite link lookup')
    return code ? `https://chat.whatsapp.com/${code}` : undefined
  }

  async groupRevokeInvite(groupJid: string): Promise<string | undefined> {
    if (!isGroupJid(groupJid)) throw new Error('group invite revoke is only available for WhatsApp groups')
    const socket = this.socket
    if (!socket || !this.isConnected) throw new Error('WhatsApp socket is not connected')
    try {
      return await withTimeout(socket.groupRevokeInvite(groupJid), 20_000, 'group invite revoke')
    } catch (error) {
      this.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'group invite revoke failed')
      throw error
    }
  }

  private async resolveGroupName(remoteJid: string): Promise<string | undefined> {
    if (!isGroupJid(remoteJid)) return undefined

    const cached = this.groupNameCache.get(remoteJid)
    if (cached && cached.expiresAt > Date.now()) return cached.name

    if (this.redis?.isEnabled) {
      const sharedName = await this.redis.cacheGet<string>('group-name', remoteJid)
      if (sharedName) {
        this.groupNameCache.set(remoteJid, { name: sharedName, expiresAt: Date.now() + 300_000 })
        return sharedName
      }
    }

    const socket = this.socket
    if (!socket) return undefined

    try {
      const metadata = await withTimeout(socket.groupMetadata(remoteJid), 10_000, 'group metadata lookup')
      const name = metadata.subject?.trim()
      if (name) {
        this.groupNameCache.set(remoteJid, { name, expiresAt: Date.now() + 300_000 })
        if (this.redis?.isEnabled) await this.redis.cacheSet('group-name', remoteJid, name, 300)
      }
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
    _socket: WASocket,
    upsert: BaileysEventMap['messages.upsert'],
    logger: AppLogger,
  ): Promise<void> {
    if (upsert.requestId) {
      logger.warn({ requestId: upsert.requestId }, 'dropping messages.upsert with requestId')
      return
    }

    if (upsert.type !== 'notify') return
    this.storage.saveMessages(upsert.messages)
  }

  private async emitMessages(messages: readonly WAMessage[]): Promise<void> {
    const normalized = (await Promise.all(messages.map(async (message): Promise<CoreMessage | undefined> => {
      const remoteJid = message.key.remoteJid
      const id = message.key.id
      if (!remoteJid || !id) return undefined
      const dedupKey = `${remoteJid}:${id}`
      if (await this.isDuplicate(dedupKey)) {
        this.logger.debug({ remoteJid }, 'duplicate message ignored')
        return undefined
      }
      const receivedAt = Date.now()
      const timestamp = normalizeMessageTimestamp(message.messageTimestamp)
      const resolvePnForLid = (lid: string) => this.socket?.signalRepository.lidMapping.getPNForLID(lid) ?? Promise.resolve(null)
      const rawSenderJid = message.key.participantAlt ?? message.key.remoteJidAlt ?? message.key.participant ?? (message.key.fromMe ? undefined : remoteJid)
      const senderJid = rawSenderJid ? await normalizeContactJid(rawSenderJid, resolvePnForLid) : undefined
      const mentionedJids: readonly string[] = [...new Set(await Promise.all(
        extractMentionedJids(message).map((jid) => normalizeContactJid(jid, resolvePnForLid)),
      ))]
      const text = extractText(message)
      const buttonId = extractButtonId(message)
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
        ...(buttonId ? { buttonId } : {}),
        ...(quotedText ? { quotedText } : {}),
        ...(quotedSenderJid ? { quotedSenderJid } : {}),
        ...(groupName ? { groupName } : {}),
        timestamp,
        receivedAt,
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

  private async isDuplicate(key: string): Promise<boolean> {
    const now = Date.now()
    for (const [oldKey, seenAt] of this.seenMessages) {
      if (now - seenAt > 10 * 60 * 1000) this.seenMessages.delete(oldKey)
    }
    if (this.seenMessages.has(key)) return true

    if (this.redis?.isEnabled) {
      const remembered = await this.redis.rememberOnce('message-dedupe', key, 600)
      if (remembered === true) {
        this.rememberLocally(key, now)
        return false
      }
      if (remembered === false) return true
    }

    this.rememberLocally(key, now)
    return false
  }

  private rememberLocally(key: string, now: number): void {
    this.seenMessages.set(key, now)
    if (this.seenMessages.size > 5000) {
      const oldest = this.seenMessages.keys().next().value
      if (oldest) this.seenMessages.delete(oldest)
    }
  }
}
