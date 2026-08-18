import type { Logger } from 'pino'

export type CoreConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'needs_auth'
  | 'reconnecting'
  | 'stopping'
  | 'failed'

export interface CoreMessage {
  readonly id: string
  readonly remoteJid: string
  readonly senderJid?: string
  readonly mentionedJids?: readonly string[]
  readonly text?: string
  readonly buttonId?: string
  readonly quotedText?: string
  readonly quotedSenderJid?: string
  readonly groupName?: string
  /** Epoch timestamp in milliseconds from the message payload. */
  readonly timestamp: number
  /** Local adapter arrival time in milliseconds, when available. */
  readonly receivedAt?: number
  readonly fromMe: boolean
}

export interface CoreConnectionState {
  readonly status: CoreConnectionStatus
  readonly reason?: string
  readonly at: number
}

export type GroupParticipantAction = 'add' | 'remove' | 'promote' | 'demote' | 'modify'
export type GroupModerationAction = 'add' | 'remove' | 'promote' | 'demote'
export type GroupSettingValue = 'announcement' | 'not_announcement' | 'locked' | 'unlocked'

export interface WhatsAppGroupParticipantActionResult {
  readonly participantJid: string
  readonly status: string
}

export interface CoreGroupParticipantUpdate {
  readonly groupJid: string
  readonly groupName?: string
  readonly action: GroupParticipantAction
  readonly participantJids: readonly string[]
  readonly at: number
}

export interface WhatsAppSendOptions {
  readonly mentions?: readonly string[]
}

export type GroupParticipantRole = 'member' | 'admin' | 'superadmin' | 'unknown'

export interface WhatsAppGroupParticipant {
  readonly jid: string
  readonly role: GroupParticipantRole
}

export interface WhatsAppGroupMetadata {
  readonly jid: string
  readonly subject: string
  readonly ownerJid?: string
  readonly description?: string
  readonly participants: readonly WhatsAppGroupParticipant[]
}

export interface RuntimeCacheClearResult {
  readonly duplicateMessages: number
  readonly groupNames: number
  readonly retryCounters: number
}

export interface WhatsAppPort {
  readonly isConnected: boolean
  readonly currentStatus?: CoreConnectionStatus
  readonly userJid?: string
  onMessage(listener: (message: CoreMessage) => Promise<void> | void): () => void
  onGroupParticipantUpdate(listener: (event: CoreGroupParticipantUpdate) => Promise<void> | void): () => void
  onConnectionState(listener: (event: CoreConnectionState) => Promise<void> | void): () => void
  sendText(remoteJid: string, text: string, options?: WhatsAppSendOptions): Promise<void>
  sendNativeQuickReplies?(remoteJid: string, payload: {
    readonly type: 'native_quick_reply'
    readonly body: string
    readonly footer?: string
    readonly buttons: readonly { readonly id: string; readonly title: string }[]
  }): Promise<void>
  getGroupMetadata(groupJid: string): Promise<WhatsAppGroupMetadata>
  groupParticipantsUpdate?(groupJid: string, participantJids: readonly string[], action: GroupModerationAction): Promise<readonly WhatsAppGroupParticipantActionResult[]>
  groupSettingUpdate?(groupJid: string, setting: GroupSettingValue): Promise<void>
  getGroupInviteLink(groupJid: string): Promise<string | undefined>
  clearRuntimeCaches?(): RuntimeCacheClearResult
  getProfilePictureUrl?(jid: string, type?: 'preview' | 'image', timeoutMs?: number): Promise<string | undefined>
  sendImage?(remoteJid: string, imageUrl: string, caption?: string): Promise<void>
  start(): Promise<void>
  close(): Promise<void>
}

export interface FrameworkConfig {
  readonly commandPrefix: string
  readonly defaultCooldownMs: number
  readonly botOwnerJid?: string
  readonly databasePath?: string
}

export interface CommandContext {
  readonly message: CoreMessage
  readonly args: readonly string[]
  readonly commandName: string
  readonly prefix: string
  readonly config: FrameworkConfig
  readonly logger: Logger
  readonly services: ServiceRegistryLike
  readonly whatsapp: WhatsAppPort
  reply(text: string, options?: WhatsAppSendOptions): Promise<void>
}

export interface CommandDefinition {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly description?: string
  readonly category?: string
  readonly menuOrder?: number
  readonly hidden?: boolean
  readonly permission?: string
  readonly cooldownMs?: number
  readonly validate?: (ctx: CommandContext) => string | undefined
  readonly handler: (ctx: CommandContext) => Promise<void> | void
}

export interface MiddlewareContext {
  readonly command: CommandDefinition
  readonly context: CommandContext
}

export type CommandMiddleware = (
  input: MiddlewareContext,
  next: () => Promise<void>,
) => Promise<void>

export interface CommandRegistryLike {
  register(command: CommandDefinition): () => void
  get(nameOrAlias: string): CommandDefinition | undefined
  dispatch(message: CoreMessage): Promise<boolean>
  list(): readonly CommandDefinition[]
}

export interface EventMap {
  'connection.changed': CoreConnectionState
  'message.received': CoreMessage
  'group.participants.changed': CoreGroupParticipantUpdate
  'command.before': { command: string; context: CommandContext }
  'command.executed': { command: string; context: CommandContext }
  'command.failed': { command: string; context: CommandContext; error: unknown }
  'plugin.loaded': { name: string }
  'plugin.failed': { name: string; error: unknown }
  'framework.error': { source: string; error: unknown }
  'framework.ready': { at: number }
}

export type EventName = keyof EventMap
export type EventListener<K extends EventName> = (
  event: EventMap[K],
) => Promise<void> | void

export interface EventBusLike {
  on<K extends EventName>(name: K, listener: EventListener<K>): () => void
  emit<K extends EventName>(name: K, event: EventMap[K]): Promise<void>
}

export interface ServiceContext {
  readonly logger: Logger
  readonly config: FrameworkConfig
  readonly services: ServiceRegistryLike
}

export interface Service {
  readonly name: string
  readonly dependencies?: readonly string[]
  initialize?(context: ServiceContext): Promise<void> | void
  shutdown?(context: ServiceContext): Promise<void> | void
}

export interface ServiceRegistryLike {
  register(service: Service): void
  get<T extends Service = Service>(name: string): T
  has(name: string): boolean
  initialize(context: Omit<ServiceContext, 'services'>): Promise<void>
  shutdown(context: Omit<ServiceContext, 'services'>): Promise<void>
  list(): readonly string[]
}

export type CommandPrefixResolver = (
  message: CoreMessage,
  services: ServiceRegistryLike,
  fallback: string,
) => string

export interface PluginContext {
  readonly logger: Logger
  readonly config: FrameworkConfig
  readonly events: EventBusLike
  readonly commands: CommandRegistryLike
  readonly services: ServiceRegistryLike
}

export interface Plugin {
  readonly name: string
  readonly version?: string
  readonly dependencies?: readonly string[]
  load?(context: PluginContext): Promise<void> | void
  initialize?(context: PluginContext): Promise<void> | void
  ready?(context: PluginContext): Promise<void> | void
  unload?(context: PluginContext): Promise<void> | void
}

export interface FrameworkState {
  readonly phase: 'created' | 'bootstrapping' | 'services' | 'plugins' | 'ready' | 'stopping' | 'stopped' | 'failed'
  readonly startedAt?: number
  readonly readyAt?: number
  readonly connected: boolean
}
