import { randomUUID } from 'node:crypto'
import type {
  InteractionContext,
  InteractionMessage,
  InteractionMenu,
  InteractionPort,
  InteractionSelection,
  PlatformClock,
} from './contracts.js'

export interface ButtonCapabilities {
  readonly nativeQuickReply: boolean
}

export interface NativeQuickReplyButton {
  readonly id: string
  readonly title: string
}

export interface NativeQuickReplyPayload {
  readonly type: 'native_quick_reply'
  readonly body: string
  readonly footer?: string
  readonly buttons: readonly NativeQuickReplyButton[]
}

export interface NativeQuickReplyTransport {
  sendNativeQuickReplies(remoteJid: string, payload: NativeQuickReplyPayload): Promise<void>
}

export type ButtonRenderResult =
  | { readonly mode: 'native'; readonly payload: NativeQuickReplyPayload }
  | { readonly mode: 'text'; readonly text: string }

export interface ButtonInteractionOptions {
  readonly clock?: PlatformClock
  readonly interactionId?: () => string
  readonly maxButtons?: number
  readonly maxButtonTitleLength?: number
}

export class CapabilityAwareButtonAdapter {
  private readonly clock: PlatformClock
  private readonly interactionId: () => string
  private readonly maxButtons: number
  private readonly maxButtonTitleLength: number

  constructor(
    private readonly textInteraction: InteractionPort,
    options: ButtonInteractionOptions = {},
  ) {
    this.clock = options.clock ?? { now: () => Date.now() }
    this.interactionId = options.interactionId ?? (() => `interaction-${this.clock.now()}-${randomUUID()}`)
    this.maxButtons = options.maxButtons ?? 3
    this.maxButtonTitleLength = options.maxButtonTitleLength ?? 32
    if (!Number.isInteger(this.maxButtons) || this.maxButtons < 1) throw new Error('maxButtons must be a positive integer')
    if (!Number.isInteger(this.maxButtonTitleLength) || this.maxButtonTitleLength < 1) throw new Error('maxButtonTitleLength must be a positive integer')
  }

  async render(menu: InteractionMenu, capabilities: ButtonCapabilities): Promise<ButtonRenderResult> {
    const activeItems = menu.items.filter((item) => item.availability === 'active')
    const nativeSupported = capabilities.nativeQuickReply
      && activeItems.length > 0
      && activeItems.length <= this.maxButtons
      && activeItems.every((item) => isSafeButtonId(item.id) && item.label.trim().length <= this.maxButtonTitleLength)

    if (!nativeSupported) return { mode: 'text', text: await this.textInteraction.render(menu) }

    return {
      mode: 'native',
      payload: {
        type: 'native_quick_reply',
        body: [menu.title.trim(), menu.body.trim()].filter(Boolean).join('\n\n'),
        buttons: activeItems.map((item) => ({ id: item.id, title: item.label.trim() })),
      },
    }
  }

  parseSelection(message: InteractionMessage, menu: InteractionMenu): InteractionSelection | undefined {
    const buttonId = message.buttonId?.trim()
    if (buttonId) {
      const item = menu.items.find((candidate) => candidate.id === buttonId)
      if (!item || item.availability !== 'active') return undefined
      if (menu.expiresAt !== undefined && this.clock.now() >= menu.expiresAt) return undefined
      const actorJid = message.senderJid ?? message.remoteJid
      const context: InteractionContext = {
        interactionId: this.interactionId(),
        menuId: menu.id,
        menuVersion: menu.version,
        remoteJid: message.remoteJid,
        actorJid,
        createdAt: this.clock.now(),
        ...(menu.expiresAt === undefined ? {} : { expiresAt: menu.expiresAt }),
      }
      return { context, itemId: item.id, rawInput: buttonId }
    }
    return this.textInteraction.parseSelection(message, menu)
  }
}

function isSafeButtonId(value: string): boolean {
  return /^[a-z0-9][a-z0-9:_-]{0,63}$/.test(value)
}
