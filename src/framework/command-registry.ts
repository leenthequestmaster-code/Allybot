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
import { TypoGuard } from './typo-guard.js'
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

const MODERATION_CONTEXT_EXTRA_COMMANDS = new Set([
  'rules', 'ruleshistory', 'groupinfo', 'ginfo', 'admins', 'adminlist',
  'membercount', 'members', 'memberlist', 'memberinfo', 'info', 'role', 'permissions',
  'botleave', 'auth',
])
const OOC_LIMITED_ALLOWED_COMMANDS = new Set([
  'ai', 'ask', 'chlona', 'chat', 'menu', 'help', 'ping', 'about', 'botprofile', 'support',
  'report', 'suggest', 'afk', 'away',
])

export class CommandRegistry implements CommandRegistryLike {
  private readonly commands = new Map<string, CommandDefinition>()
  private readonly middleware: CommandMiddleware
  private readonly typoGuard = new TypoGuard({ prefixes: ['!', '/', '.', '#'] })
  private cachedSuggestionCandidates: string[] | null = null
  private readonly typoRateLimit = new Map<string, number>()

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
      async ({ command, context }, next) => {
        // Explicit help is still subject to permissions, but not argument validation or cooldown.
        const isHelpFlag = context.args.length === 1 && ['help', '--help'].includes(context.args[0].toLowerCase())
        if (isHelpFlag) {
          const { formatCommandHelp } = await import('./command-help-registry.js')
          const helpMsg = formatCommandHelp(command.name, command.aliases, context.prefix)
          if (helpMsg) {
            await context.reply(helpMsg)
            return
          }
        }
        await next()
      },
      createUserRateLimitMiddleware(15, 60_000),
      validationMiddleware,
      createCooldownMiddleware(),
      ...extraMiddleware,
    ])
  }

  register(command: CommandDefinition): () => void {
    this.cachedSuggestionCandidates = null
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
      this.cachedSuggestionCandidates = null
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
    const aliases = this.services.has('gatekeeper')
      ? ((this.services.get('gatekeeper') as { getIdentityAliases?: (jid?: string) => string[] }).getIdentityAliases?.(actorJid) ?? [actorJid])
      : [actorJid]
    try {
      const meta = await this.whatsapp.getGroupMetadata(oocJid)
      if (!meta || !meta.participants) return false
      return meta.participants.some((p) => aliases.some((alias) => isSameJid(p.jid, alias)))
    } catch (err) {
      this.logger.warn({ err, oocJid, actorJid }, 'failed checking OOC group membership')
      if (this.services.has('gatekeeper')) {
        const gk = this.services.get('gatekeeper') as { isOfficialMember?: (jid?: string) => boolean }
        if (typeof gk.isOfficialMember === 'function') {
          return gk.isOfficialMember(actorJid)
        }
      }
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
    const isGroup = isGroupJid(message.remoteJid)
    const isOwner = this.isBotOwner(message.senderJid ?? message.remoteJid)
    const contextPolicy = (isGroup && !isOwner && typeof this.services?.has === 'function' && this.services.has('gatekeeper'))
      ? (this.services.get('gatekeeper') as { getContextPolicy?: (jid: string) => string }).getContextPolicy?.(message.remoteJid)
      : undefined

    const command = this.get(token ?? '')
    if (!command) {
      if (contextPolicy === 'silent' || contextPolicy === 'moderator_only') {
        return false
      }
      if (token && token.length >= 2 && token.length <= 32) {
        await this.handleTypoSuggestion(message, token, inputPrefix)
      }
      return false
    }

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

    const effectiveScope: CommandScope = command.scope ?? (
      command.category === 'your-character'
        ? 'both'
        : command.category
          ? 'group'
          : 'both'
    )

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

      if (contextPolicy === 'silent') {
        return false
      }

      if (contextPolicy === 'moderator_only') {
        const isModerationCmd = command.category === 'moderation' || MODERATION_CONTEXT_EXTRA_COMMANDS.has(command.name.toLowerCase())
        if (!isModerationCmd) {
          return false
        }
      }

      if (contextPolicy === 'ooc_limited') {
        const isAllowedOoc = command.category === 'moderation'
          || command.category === 'group'
          || OOC_LIMITED_ALLOWED_COMMANDS.has(command.name.toLowerCase())
        if (!isAllowedOoc) {
          await this.whatsapp.sendText(
            message.remoteJid,
            `⚠️ Grup *OOC* hanya mengizinkan AI Chlona, *${inputPrefix}menu*, *${inputPrefix}report/${inputPrefix}suggest*, *${inputPrefix}afk*, & moderasi. Untuk Game, Media & Downloader lengkap, silakan gunakan *Voice & Bot Room*.`,
          )
          return true
        }
      }

      if (this.config.officialOocGroupJid) {
        const oocJid = this.config.officialOocGroupJid
        const officialGroups = new Set([oocJid, ...(this.config.officialGroupJids ?? [])])
        const isOfficialGroup = isGroup && officialGroups.has(message.remoteJid)
        const hasActiveGatekeeper = this.services.has('gatekeeper') &&
          (this.services.get('gatekeeper') as { getGateMode?: () => string }).getGateMode?.() !== 'permissive'

        // When Gatekeeper is active on private DMs, 12h Guest Trial + funnel is managed by GatekeeperService
        const skipDmForGatekeeperTrial = !isGroup && hasActiveGatekeeper

        if (!isOfficialGroup && !skipDmForGatekeeperTrial) {
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
    let typingStartTimer: NodeJS.Timeout | null = null
    let heartbeatTimer: NodeJS.Timeout | null = null
    let isTyping = false

    const cleanupTyping = () => {
      if (typingStartTimer) {
        clearTimeout(typingStartTimer)
        typingStartTimer = null
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer)
        heartbeatTimer = null
      }
      if (isTyping && this.whatsapp.sendPresenceUpdate) {
        isTyping = false
        void this.whatsapp.sendPresenceUpdate(message.remoteJid, 'paused')
      }
    }

    // Deferred Auto-Typing: only emit composing if handler takes >800ms
    if (this.whatsapp.sendPresenceUpdate && process.env.NODE_ENV !== 'test') {
      typingStartTimer = setTimeout(() => {
        typingStartTimer = null
        if (replyDelivered) return
        isTyping = true
        void this.whatsapp.sendPresenceUpdate?.(message.remoteJid, 'composing')
        heartbeatTimer = setInterval(() => {
          void this.whatsapp.sendPresenceUpdate?.(message.remoteJid, 'composing')
        }, 8_000)
        heartbeatTimer.unref?.()
      }, 800)
      typingStartTimer.unref?.()
    }

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
        cleanupTyping()
        await this.whatsapp.sendText(message.remoteJid, replyText, options)
        replyDelivered = true
      },
      react: async (emoji: string) => {
        if (this.whatsapp.sendReaction) {
          const isGroup = isGroupJid(message.remoteJid)
          const key = message.rawKey ?? {
            id: message.id,
            remoteJid: message.remoteJid,
            fromMe: message.fromMe,
            ...(isGroup && message.senderJid ? { participant: message.senderJid } : {}),
          }
          await this.whatsapp.sendReaction(
            message.remoteJid,
            key,
            emoji,
          )
        }
      },
      sendPresence: async (type) => {
        if (typingStartTimer) {
          clearTimeout(typingStartTimer)
          typingStartTimer = null
        }
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer)
          heartbeatTimer = null
        }
        if (this.whatsapp.sendPresenceUpdate) {
          isTyping = type !== 'paused'
          await this.whatsapp.sendPresenceUpdate(message.remoteJid, type)
          if (type !== 'paused') {
            heartbeatTimer = setInterval(() => {
              void this.whatsapp.sendPresenceUpdate?.(message.remoteJid, type)
            }, 8_000)
            heartbeatTimer.unref?.()
          }
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
    } finally {
      cleanupTyping()
    }
    return true
  }

  private getSuggestionCandidates(): readonly string[] {
    if (!this.cachedSuggestionCandidates) {
      const candidates = new Set<string>()
      for (const [nameOrAlias, def] of this.commands.entries()) {
        if (def.hidden || def.scope === 'internal') continue
        candidates.add(nameOrAlias)
      }
      this.cachedSuggestionCandidates = [...candidates]
    }
    return this.cachedSuggestionCandidates
  }

  private async handleTypoSuggestion(
    message: CoreMessage,
    token: string,
    inputPrefix: string,
  ): Promise<boolean> {
    const actorJid = message.senderJid ?? message.remoteJid
    const now = Date.now()
    const lastNotice = this.typoRateLimit.get(actorJid) ?? 0

    // Anti-spam: max 1 suggestion per user per 10 seconds
    if (now - lastNotice < 10_000) return false
    this.typoRateLimit.set(actorJid, now)

    // Bounded cleanup to avoid memory growth
    if (this.typoRateLimit.size > 500) {
      for (const [jid, timestamp] of this.typoRateLimit.entries()) {
        if (now - timestamp > 60_000) this.typoRateLimit.delete(jid)
      }
    }

    const candidates = this.getSuggestionCandidates()
    const suggestions = this.typoGuard.suggest(token, candidates, {
      maxDistance: 2,
      minSimilarity: 0.7,
      limit: 3,
    })

    if (suggestions.length === 0) return false

    const formattedList = suggestions.map((s) => `*${inputPrefix}${s.candidate}*`).join(', ')
    const replyText = `Command *${inputPrefix}${token}* tidak ditemukan.\nMungkin maksud kamu: ${formattedList}?`

    try {
      await this.whatsapp.sendText(message.remoteJid, replyText)
      return true
    } catch (err) {
      this.logger.debug({ err, token }, 'failed sending typo suggestion message')
      return false
    }
  }
}
