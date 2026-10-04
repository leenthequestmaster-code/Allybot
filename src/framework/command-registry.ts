import type { Logger } from 'pino'
import type {
  CommandContext,
  CommandDefinition,
  CommandMiddleware,
  CommandRegistryLike,
  CommandPrefixResolver,
  CommandScope,
  CoreMessage,
  EventBusLike,
  FrameworkConfig,
  ServiceRegistryLike,
  WhatsAppPort,
  WhatsAppSendOptions,
} from './contracts.js'
import { isGroupJid } from './validation.js'
import { isSameJid } from '../permissions.js'
import {
  composeMiddleware,
  createCooldownMiddleware,
  createPermissionMiddleware,
  createUserRateLimitMiddleware,
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
      createUserRateLimitMiddleware(15, 60_000),
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

  private isBotOwner(jid: string | undefined): boolean {
    if (!jid || !this.config.botOwnerJid) return false
    return isSameJid(jid, this.config.botOwnerJid)
  }

  private async isOocMember(oocJid: string, actorJid: string): Promise<boolean> {
    if (!this.whatsapp.getGroupMetadata) return true
    try {
      const meta = await this.whatsapp.getGroupMetadata(oocJid)
      if (!meta || !meta.participants) return false
      return meta.participants.some((p) => isSameJid(p.jid, actorJid))
    } catch (err) {
      this.logger.warn({ err, oocJid, actorJid }, 'failed checking OOC group membership')
      return false
    }
  }

  async dispatch(message: CoreMessage): Promise<boolean> {
    if (message.fromMe) return false
    const text = (message.text ?? message.buttonId)?.trim()
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

    if (command.freshness?.maxAgeMs !== undefined && command.freshness.maxAgeMs > 0) {
      const now = Date.now()
      const messageAge = now - message.timestamp
      if (messageAge > command.freshness.maxAgeMs) {
        this.logger.warn(
          { command: command.name, messageId: message.id, messageAge, maxAgeMs: command.freshness.maxAgeMs },
          'dropping stale command message by freshness policy',
        )
        return false
      }
    }

    const isGroup = isGroupJid(message.remoteJid)
    const effectiveScope: CommandScope = command.scope ?? (
      command.category === 'your-character'
        ? 'both'
        : command.category
          ? 'group'
          : 'both'
    )

    const isOwner = this.isBotOwner(message.senderJid ?? message.remoteJid)

    if (!isOwner) {
      if (effectiveScope === 'group' && !isGroup) {
        await this.whatsapp.sendText(message.remoteJid, 'Perintah ini cuma bisa dijalankan di dalam grup ya~ 🙏')
        return true
      }

      if (effectiveScope === 'private' && isGroup) {
        await this.whatsapp.sendText(message.remoteJid, 'Perintah ini cuma bisa dijalankan di private chat ya~ 🙏')
        return true
      }

      if (effectiveScope === 'internal') {
        return false
      }

      if (this.config.officialOocGroupJid) {
        const oocJid = this.config.officialOocGroupJid
        const officialGroups = new Set([oocJid, ...(this.config.officialGroupJids ?? [])])
        const isOfficialGroup = isGroup && officialGroups.has(message.remoteJid)

        if (!isOfficialGroup) {
          const actorJid = message.senderJid ?? message.remoteJid
          const isMember = await this.isOocMember(oocJid, actorJid)
          if (!isMember) {
            const invite = this.config.officialOocInviteLink
              ? `\n\nGabung di sini: ${this.config.officialOocInviteLink}`
              : ''
            await this.whatsapp.sendText(
              message.remoteJid,
              `Kamu harus bergabung ke grup resmi OOC Allyssea dulu untuk menggunakan fitur Allybot.${invite}`,
            )
            return true
          }
        }
      }
    }

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
      react: async (emoji: string) => {
        if (this.whatsapp.sendReaction) {
          await this.whatsapp.sendReaction(
            message.remoteJid,
            {
              id: message.id,
              remoteJid: message.remoteJid,
              fromMe: message.fromMe,
              ...(message.senderJid ? { participant: message.senderJid } : {}),
            },
            emoji,
          )
        }
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
