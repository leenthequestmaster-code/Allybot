import type { CommandDefinition, CoreMessage } from '../framework/contracts.js'
import type {
  InteractionMenu,
  InteractionPort,
  InteractionSelection,
  PlatformClock,
} from './contracts.js'

export interface FrameworkMenuOptions {
  readonly id: string
  readonly version?: number
  readonly title: string
  readonly body: string
  readonly fallbackText: string
  readonly expiresAt?: number
}

export class FrameworkInteractionAdapter {
  constructor(
    private readonly interaction: InteractionPort,
    private readonly botJid?: string,
  ) {}

  toInteractionMessage(message: CoreMessage): Parameters<InteractionPort['parseSelection']>[0] {
    return {
      text: message.text,
      buttonId: message.buttonId,
      quotedText: message.quotedText,
      quotedSenderJid: message.quotedSenderJid,
      remoteJid: message.remoteJid,
      senderJid: message.senderJid,
    }
  }

  parseSelection(message: CoreMessage, menu: InteractionMenu): InteractionSelection | undefined {
    if (message.fromMe) return undefined
    if (this.botJid !== undefined && message.quotedText !== undefined && message.quotedSenderJid !== this.botJid) {
      return undefined
    }
    return this.interaction.parseSelection(this.toInteractionMessage(message), menu)
  }

  render(menu: InteractionMenu): Promise<string> {
    return this.interaction.render(menu)
  }
}

export function menuFromCommands(
  commands: readonly CommandDefinition[],
  options: FrameworkMenuOptions,
): InteractionMenu {
  const sorted = [...commands].sort((left, right) => {
    const order = (left.menuOrder ?? Number.MAX_SAFE_INTEGER) - (right.menuOrder ?? Number.MAX_SAFE_INTEGER)
    return order || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })

  const items = sorted.map((command) => ({
    id: command.name,
    label: command.name,
    description: command.description,
    availability: 'active' as const,
  }))

  return {
    id: options.id,
    version: options.version ?? 1,
    kind: 'menu',
    title: options.title,
    body: options.body,
    items,
    fallbackText: options.fallbackText,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  }
}

export function createFrameworkMenuAdapter(options: {
  readonly interaction: InteractionPort
  readonly botJid?: string
  readonly clock?: PlatformClock
}): FrameworkInteractionAdapter {
  void options.clock
  return new FrameworkInteractionAdapter(options.interaction, options.botJid)
}
