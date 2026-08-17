import { randomUUID } from 'node:crypto'
import type {
  InteractionContext,
  InteractionMessage,
  InteractionMenu,
  InteractionPort,
  InteractionSelection,
  PlatformClock,
} from './contracts.js'

export interface TextInteractionOptions {
  readonly clock?: PlatformClock
  readonly interactionId?: () => string
  readonly botJid?: string
}

export class TextInteractionAdapter implements InteractionPort {
  private readonly clock: PlatformClock
  private readonly interactionId: () => string
  private readonly botJid?: string

  constructor(options: TextInteractionOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() }
    this.interactionId = options.interactionId ?? (() => `interaction-${this.clock.now()}-${randomUUID()}`)
    this.botJid = options.botJid
  }

  async render(menu: InteractionMenu): Promise<string> {
    const lines = [menu.title.trim(), menu.body.trim(), '']
    menu.items.forEach((item, index) => {
      const suffix = item.availability === 'coming_soon' ? ' (Coming Soon)' : item.availability === 'disabled' ? ' (Disabled)' : ''
      lines.push(`${index + 1}. ${item.label}${suffix}`)
    })
    lines.push('', menu.fallbackText.trim())
    return lines.filter((line, index) => line.length > 0 || index === 2).join('\n').trim()
  }

  parseSelection(message: InteractionMessage, menu: InteractionMenu): InteractionSelection | undefined {
    const actorJid = message.senderJid ?? message.remoteJid
    const input = normalizeInput(message.text)
    const quotedInput = normalizeInput(message.quotedText)
    if (input === undefined && quotedInput !== undefined && this.botJid !== undefined && message.quotedSenderJid !== this.botJid) {
      return undefined
    }
    const candidate = input ?? quotedInput
    if (candidate === undefined) return undefined

    const index = parseMenuIndex(candidate)
    if (index === undefined || index >= menu.items.length) return undefined
    if (menu.items[index].availability !== 'active') return undefined
    if (menu.expiresAt !== undefined && this.clock.now() >= menu.expiresAt) return undefined

    const context: InteractionContext = {
      interactionId: this.interactionId(),
      menuId: menu.id,
      menuVersion: menu.version,
      remoteJid: message.remoteJid,
      actorJid,
      createdAt: this.clock.now(),
      ...(menu.expiresAt === undefined ? {} : { expiresAt: menu.expiresAt }),
    }

    return {
      context,
      itemId: menu.items[index].id,
      rawInput: candidate,
    }
  }
}

function normalizeInput(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized ? normalized : undefined
}

function parseMenuIndex(input: string): number | undefined {
  const match = /^(?:!menu\s*)?(\d+)$/.exec(input)
  if (!match) return undefined
  const number = Number(match[1])
  if (!Number.isSafeInteger(number) || number < 1) return undefined
  return number - 1
}
