export type FeatureStatus = 'active' | 'experimental' | 'coming_soon' | 'disabled' | 'deprecated'

export type FeatureScope = 'global' | 'user' | 'chat' | 'group'

export interface FeatureDefinition {
  readonly id: string
  readonly version: number
  readonly name: string
  readonly description: string
  readonly category: string
  readonly status: FeatureStatus
  readonly scope: FeatureScope
  readonly dependencies?: readonly string[]
}

export interface FeatureRegistry {
  register(feature: FeatureDefinition): () => void
  get(id: string): FeatureDefinition | undefined
  list(options?: { readonly includeDisabled?: boolean }): readonly FeatureDefinition[]
  has(id: string): boolean
}

export interface FeatureLifecycle {
  load(feature: FeatureDefinition): Promise<void> | void
  initialize(feature: FeatureDefinition): Promise<void> | void
  ready(feature: FeatureDefinition): Promise<void> | void
  unload(feature: FeatureDefinition): Promise<void> | void
}

export type InteractionKind = 'menu' | 'selection' | 'confirmation' | 'text_input'

export type InteractionItemAvailability = 'active' | 'coming_soon' | 'disabled'

export interface InteractionItem {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly availability: InteractionItemAvailability
}

export interface InteractionMenu {
  readonly id: string
  readonly version: number
  readonly kind: InteractionKind
  readonly title: string
  readonly body: string
  readonly items: readonly InteractionItem[]
  readonly fallbackText: string
  readonly expiresAt?: number
}

export interface InteractionContext {
  readonly interactionId: string
  readonly menuId: string
  readonly menuVersion: number
  readonly remoteJid: string
  readonly actorJid: string
  readonly createdAt: number
  readonly expiresAt?: number
}

export interface InteractionSelection {
  readonly context: InteractionContext
  readonly itemId: string
  readonly rawInput: string
}

export interface InteractionMessage {
  readonly text?: string
  readonly buttonId?: string
  readonly quotedText?: string
  readonly quotedSenderJid?: string
  readonly remoteJid: string
  readonly senderJid?: string
}

export interface InteractionPort {
  render(menu: InteractionMenu): Promise<string>
  parseSelection(message: InteractionMessage, menu: InteractionMenu): InteractionSelection | undefined
}

export interface PermissionRequest {
  readonly subjectJid: string
  readonly action: string
  readonly resourceJid?: string
  readonly scope: FeatureScope
}

export interface PermissionDecision {
  readonly allowed: boolean
  readonly reason: string
  readonly policy?: string
}

export interface PermissionPort {
  evaluate(request: PermissionRequest): PermissionDecision | Promise<PermissionDecision>
}

export type PlatformEventName =
  | 'feature.registered'
  | 'feature.loaded'
  | 'feature.ready'
  | 'feature.unloaded'
  | 'interaction.created'
  | 'interaction.selected'
  | 'interaction.expired'
  | 'permission.denied'
  | 'operation.started'
  | 'operation.succeeded'
  | 'operation.failed'
  | 'platform.error'

export interface PlatformEvent<TPayload extends object = Record<string, unknown>> {
  readonly name: PlatformEventName
  readonly at: number
  readonly payload: TPayload
}

export interface PlatformEventSink {
  emit(event: PlatformEvent): Promise<void> | void
}

export interface PlatformClock {
  now(): number
}

export interface PlatformLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface PlatformContext {
  readonly clock: PlatformClock
  readonly logger: PlatformLogger
  readonly features: FeatureRegistry
  readonly events: PlatformEventSink
}
