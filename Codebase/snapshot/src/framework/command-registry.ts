import type { Logger } from 'pino'
import type {
  CommandContext,
  CommandDefinition,
  CommandMiddleware,
  CommandRegistryLike,
  CommandPrefixResolver,
  CoreMessage,
  EventBusLike,
  FrameworkConfig,
  ServiceRegistryLike,
  WhatsAppPort,
  WhatsAppSendOptions,
} from './contracts.js'
import {
  composeMiddleware,
  createCooldownMiddleware,
  createPermissionMiddleware,
  type PermissionResolver,
  validationMiddleware,
} from './middleware.js'

function normalizeName(value: string): string {
  return value.trim().toLowerCase()
}

export class CommandRegistry implements CommandRegistryLike {
  private readonly commands = new Map<string, CommandDefinition>()
  private readonly middleware: CommandMiddleware

  constructor(
    private readonly config: FrameworkConfig,
    private readonly logger: Logger,
    private readonly whatsapp: WhatsAppPort,
    private readonly services: ServiceRegistryLike,
    private readonly events: EventBusLike,
    permissionResolver: PermissionResolver = () => false,
    extraMiddleware: readonly CommandMiddleware[] = [],
    private readonly prefixResolver: CommandPrefixResolver = (message, _services, fallback) => fallback,
  ) {
    this.middleware = composeMiddleware([
      createPermissionMiddleware(permissionResolver),
      validationMiddleware,
      createCooldownMiddleware(),
      ...extraMiddleware,
    ])
  }

  register(command: CommandDefinition): () => void {
    const name = normalizeName(command.name)
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
      throw new Error(`Invalid command name: ${command.name}`)
    }
    const aliases = (command.aliases ?? []).map(normalizeName)
    const names = [name, ...aliases]
    if (new Set(names).size !== names.length) throw new Error(`Duplicate command alias: ${name}`)
    for (const candidate of names) {
      if (this.commands.has(candidate)) throw new Error(`Command name already registered: ${candidate}`)
    }
    const normalized = { ...command, name, aliases } satisfies CommandDefinition
    for (const candidate of names) this.commands.set(candidate, normalized)
    return () => {
      for (const candidate of names) {
        if (this.commands.get(candidate) === normalized) this.commands.delete(candidate)
      }
    }
  }

  get(nameOrAlias: string): CommandDefinition | undefined {
    return this.commands.get(normalizeName(nameOrAlias))
  }

  list(): readonly CommandDefinition[] {
    return [...new Set(this.commands.values())]
  }

  async dispatch(message: CoreMessage): Promise<boolean> {
    if (message.fromMe) return false
    const text = message.text?.trim()
    const prefix = this.prefixResolver(message, this.services, this.config.commandPrefix)
    const inputPrefix = [prefix, this.config.commandPrefix].find((candidate, index, candidates) =>
      candidates.indexOf(candidate) === index && Boolean(text?.startsWith(candidate)),
    )
    if (!text || !inputPrefix) return false
    const body = text.slice(inputPrefix.length).trim()
    if (!body) return false

    const [token, ...args] = body.split(/\s+/)
    const command = this.get(token ?? '')
    if (!command) return false

    let replyDelivered = false
    const context: CommandContext = {
      message,
      args,
      commandName: command.name,
      prefix,
      config: this.config,
      logger: this.logger.child({ command: command.name, messageId: message.id }),
      services: this.services,
      whatsapp: this.whatsapp,
      reply: async (replyText, options?: WhatsAppSendOptions) => {
        await this.whatsapp.sendText(message.remoteJid, replyText, options)
        replyDelivered = true
      },
    }

    await this.events.emit('command.before', { command: command.name, context })
    try {
      await this.middleware({ command, context }, async () => command.handler(context))
      await this.events.emit('command.executed', { command: command.name, context })
    } catch (error) {
      context.logger.error({ err: error }, 'command execution failed')
      if (!replyDelivered) {
        try {
          await context.reply('Maaf, command tidak dapat diproses saat ini. Silakan coba lagi.')
        } catch (fallbackError) {
          context.logger.warn({ err: fallbackError }, 'command failure fallback reply failed')
        }
      }
      await this.events.emit('command.failed', { command: command.name, context, error })
      await this.events.emit('framework.error', { source: `command:${command.name}`, error })
    }
    return true
  }
}
