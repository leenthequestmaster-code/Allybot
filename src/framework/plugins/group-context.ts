import type { CommandContext, CoreMessage, Plugin, WhatsAppPort } from '../contracts.js'
import { UpstashRedisService } from '../../upstash-redis.js'
import { permissionNames } from '../../permissions.js'
import { isGroupJid } from '../../platform/validation.js'
import {
  GROUP_MODES,
  IC_SUBTYPES,
  GroupContextService,
  type GroupContextRecord,
  type GroupMode,
  type IcSubtype,
} from '../../services/group-context-service.js'
import { isCanonicalNarrativeText } from '../../services/character-sheet-parser.js'

const GUIDE_CONFIRM_TTL_MS = 2 * 60 * 1000
const DEFAULT_OOC_COOLDOWN_MS = 30_000
const DEFAULT_OOC_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_OOC_MAX_PER_WINDOW = 3
const CUT_WARNING_COOLDOWN_MS = 30_000

function contextService(ctx: CommandContext | { services: CommandContext['services'] }): GroupContextService {
  return ctx.services.get<GroupContextService>('group-context')
}

function groupJid(context: CommandContext): string | undefined {
  return isGroupJid(context.message.remoteJid) ? context.message.remoteJid : undefined
}

function actorJid(context: CommandContext): string | undefined {
  return context.message.senderJid ?? context.whatsapp.userJid
}

function userLabel(jid: string): string {
  return `@${jid.split('@')[0]?.split(':')[0] ?? jid}`
}

function subtypeLabel(value: IcSubtype | undefined): string {
  if (!value) return 'Tidak ada'
  if (value === 'story_event') return 'Story/Event'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function modeLabel(context: GroupContextRecord): string {
  return context.mode === 'ic' ? `IC - ${subtypeLabel(context.icSubtype)}` : context.mode.toUpperCase()
}

export function renderGroupContextStatus(context: GroupContextRecord): string[] {
  return [
    `Mode: ${modeLabel(context)}`,
    `Autodetect OOC/IC: ${context.mode === 'ic' ? (context.oocPolicy === 'permissive' ? 'Permissive' : 'Strict') : 'Tidak digunakan'}`,
    `Welcome/Leave: ${context.mode === 'ooc' ? 'Tersedia' : 'Terkunci'}`,
    `Character Guide: ${context.mode === 'guide' ? 'Aktif' : 'Tidak aktif'}`,
  ]
}

function usage(prefix: string): string {
  return [
    `Format: ${prefix}setgroup <normal|ooc|guide|ic> [subtype]`,
    `Contoh: ${prefix}setgroup guide`,
    `Contoh: ${prefix}setgroup ic bank`,
    `Konteks IC: ${IC_SUBTYPES.join(', ')}`,
  ].join('\n')
}

function whitelistUsage(prefix: string): string {
  return [
    `Format: ${prefix}whitelistooc <add|remove|list|clear>`,
    `Contoh: ${prefix}whitelistooc add @narator`,
    `Contoh: ${prefix}whitelistooc list`,
  ].join('\n')
}

function targetFromMessage(context: CommandContext): string | undefined {
  const mentioned = context.message.mentionedJids?.find((jid) => jid.includes('@'))
  return mentioned ?? context.message.quotedSenderJid
}

function isManualOocMarker(text: string): boolean {
  return /(?:^|\n)\s*(?:\(\(|\[\s*ooc\s*\]|ooc\s*:)/iu.test(text)
    || /\)\)\s*$/u.test(text.trim())
}

function commandNameFromMessage(text: string | undefined, prefix: string): string | undefined {
  const trimmed = text?.trimStart()
  if (!trimmed?.startsWith(prefix)) return undefined
  const token = trimmed.slice(prefix.length).trimStart().match(/^[^\s]+/u)?.[0]
  return token?.toLowerCase()
}

function formatOocCooldown(remainingMs: number): string {
  return `Tunggu ${Math.max(1, Math.ceil(remainingMs / 1000))} detik sebelum menggunakan !ooc lagi.`
}

interface PendingGuideConfirmation {
  readonly expiresAt: number
}

interface OocUsage {
  readonly lastAt: number
  readonly timestamps: readonly number[]
}

export function createGroupContextPlugin(whatsapp: WhatsAppPort): Plugin {
  const pendingGuide = new Map<string, PendingGuideConfirmation>()
  const oocUsage = new Map<string, OocUsage>()
  const cutWarnings = new Map<string, number>()

  return {
    name: 'group-context',
    version: '0.1.0',
    dependencies: ['group-foundation'],
    load(context) {
      const service = context.services.get<GroupContextService>('group-context')
      const oocCooldownMs = context.config.groupContextOocCooldownMs ?? DEFAULT_OOC_COOLDOWN_MS
      const oocWindowMs = context.config.groupContextOocWindowMs ?? DEFAULT_OOC_WINDOW_MS
      const oocMaxPerWindow = context.config.groupContextOocMaxPerWindow ?? DEFAULT_OOC_MAX_PER_WINDOW

      context.messageGates.register('group-context-ic-ooc', async (message: CoreMessage) => {
        if (!service.isEnabled || message.fromMe || !isGroupJid(message.remoteJid)) return { allowed: true }
        const groupContext = await service.get(message.remoteJid)
        if (groupContext.mode !== 'ic') return { allowed: true }

        const sender = message.senderJid
        if (sender && await service.isOocAllowed(message.remoteJid, sender)) return { allowed: true }
        if (commandNameFromMessage(message.text, context.config.commandPrefix)) {
          const commandName = commandNameFromMessage(message.text, context.config.commandPrefix)
          if (commandName && context.commands.get(commandName)) return { allowed: true }
        }

        const text = message.text?.trim() ?? ''
        const isSticker = message.media?.kind === 'sticker'
        const hasAnyMedia = Boolean(message.media)
        const isNarrative = text.length > 0 && !isManualOocMarker(text) && isCanonicalNarrativeText(text)
        if (isNarrative && !hasAnyMedia) return { allowed: true }

        const warningKey = `${message.remoteJid}:${sender ?? 'unknown'}`
        const now = Date.now()
        const lastWarning = cutWarnings.get(warningKey) ?? 0
        if (now - lastWarning >= CUT_WARNING_COOLDOWN_MS) {
          cutWarnings.set(warningKey, now)
          try {
            await whatsapp.sendText(message.remoteJid, '*CUT OOC*')
          } catch {
            context.logger.warn({ groupKey: groupContext.groupKey }, 'failed to send CUT OOC warning')
          }
        }
        for (const [key, timestamp] of cutWarnings) if (now - timestamp > CUT_WARNING_COOLDOWN_MS * 4) cutWarnings.delete(key)
        return { allowed: false, reason: isSticker ? 'sticker_ooc_in_ic' : 'non_narrative_ooc_in_ic' }
      })

      context.commands.register({
        name: 'setgroup',
        aliases: ['groupmode'],
        description: 'Atur mode dan konteks sebuah grup',
        category: 'group',
        menuOrder: 50,
        permission: permissionNames.groupAdminOrBotOwner,
        handler: async (commandContext) => {
          const group = groupJid(commandContext)
          const actor = actorJid(commandContext)
          if (!group || !actor) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup.')
            return
          }
          const requestedMode = commandContext.args[0]?.toLowerCase()
          const aliases: Record<string, GroupMode> = { default: 'normal', umum: 'normal', panduan: 'guide' }
          if (!requestedMode || requestedMode === 'status') {
            const current = await service.get(group)
            await commandContext.reply(renderGroupContextStatus(current).join('\n'))
            return
          }
          const first = aliases[requestedMode] ?? requestedMode
          if (!(GROUP_MODES as readonly string[]).includes(first)) {
            await commandContext.reply(usage(commandContext.prefix))
            return
          }
          const mode = first as GroupMode
          const isGuideConfirm = mode === 'guide' && commandContext.args[1]?.toLowerCase() === 'confirm'
          let subtype: IcSubtype | undefined
          if (mode === 'ic') {
            const candidate = commandContext.args[1]?.toLowerCase() as IcSubtype | undefined
            if (!candidate || !(IC_SUBTYPES as readonly string[]).includes(candidate)) {
              await commandContext.reply(usage(commandContext.prefix))
              return
            }
            subtype = candidate
          } else if (commandContext.args[1] && !isGuideConfirm) {
            await commandContext.reply(`Mode ${mode.toUpperCase()} tidak memiliki subtype.`)
            return
          }

          const confirmationKey = `${group}:${actor}`
          if (mode === 'guide' && !isGuideConfirm) {
            pendingGuide.set(confirmationKey, { expiresAt: Date.now() + GUIDE_CONFIRM_TTL_MS })
            await commandContext.reply([
              'Mode Guide akan mengaktifkan onboarding dan pendaftaran Character Sheet.',
              `Konfirmasi dengan: ${commandContext.prefix}setgroup guide confirm`,
            ].join('\n'))
            return
          }
          if (isGuideConfirm) {
            const pending = pendingGuide.get(confirmationKey)
            pendingGuide.delete(confirmationKey)
            if (!pending || pending.expiresAt <= Date.now()) {
              await commandContext.reply('Konfirmasi Guide sudah kedaluwarsa. Jalankan !setgroup guide terlebih dahulu.')
              return
            }
          }

          try {
            const updated = await service.set(group, mode, subtype, mode === 'ic' ? 'strict' : 'disabled', actor)
            await commandContext.reply(renderGroupContextStatus(updated).join('\n'))
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'Mode grup belum dapat diubah.')
          }
        },
      })

      context.commands.register({
        name: 'ooc',
        description: 'Kirim pesan di luar karakter pada grup IC',
        category: 'group',
        menuOrder: 51,
        cooldownMs: 0,
        handler: async (commandContext) => {
          const group = groupJid(commandContext)
          const actor = actorJid(commandContext)
          if (!group || !actor) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup.')
            return
          }
          const current = await service.get(group)
          const content = commandContext.args.join(' ').trim()
          if (current.mode !== 'ic') {
            await commandContext.reply('Grup ini tidak sedang berada dalam mode IC. Pesan OOC tidak memerlukan command !ooc.')
            return
          }
          if (!content || content.length > 500) {
            await commandContext.reply(`Format: ${commandContext.prefix}ooc <pesan>\nContoh: ${commandContext.prefix}ooc izin off sebentar`)
            return
          }
          const now = Date.now()
          const key = `${group}:${actor}`
          const redis = context.services.has('upstash-redis') ? context.services.get<UpstashRedisService>('upstash-redis') : undefined
          let rateDecision: { allowed: boolean; resetAt: number; reason: 'cooldown' | 'window' } | undefined
          if (redis?.isEnabled) {
            const [cooldown, window] = await Promise.all([
              redis.consumeFixedWindow('group-context:ooc-cooldown', key, 1, oocCooldownMs, now),
              redis.consumeFixedWindow('group-context:ooc-window', key, oocMaxPerWindow, oocWindowMs, now),
            ])
            if (cooldown && window) {
              if (!cooldown.allowed) rateDecision = { allowed: false, resetAt: cooldown.resetAt, reason: 'cooldown' }
              else if (!window.allowed) rateDecision = { allowed: false, resetAt: window.resetAt, reason: 'window' }
              else rateDecision = { allowed: true, resetAt: Math.min(cooldown.resetAt, window.resetAt), reason: 'cooldown' }
            }
          }
          if (!rateDecision) {
            const previous = oocUsage.get(key) ?? { lastAt: 0, timestamps: [] }
            const timestamps = previous.timestamps.filter((timestamp) => now - timestamp < oocWindowMs)
            if (now - previous.lastAt < oocCooldownMs) {
              rateDecision = { allowed: false, resetAt: previous.lastAt + oocCooldownMs, reason: 'cooldown' }
            } else if (timestamps.length >= oocMaxPerWindow) {
              const firstAt = timestamps[0] ?? now
              rateDecision = { allowed: false, resetAt: firstAt + oocWindowMs, reason: 'window' }
            } else {
              oocUsage.set(key, { lastAt: now, timestamps: [...timestamps, now] })
              rateDecision = { allowed: true, resetAt: Math.min(now + oocCooldownMs, (timestamps[0] ?? now) + oocWindowMs), reason: 'cooldown' }
            }
          }
          if (!rateDecision.allowed) {
            if (rateDecision.reason === 'cooldown') await commandContext.reply(formatOocCooldown(Math.max(0, rateDecision.resetAt - now)))
            else await commandContext.reply(`Batas !ooc tercapai. Coba lagi dalam ${Math.max(1, Math.ceil((rateDecision.resetAt - now) / 60_000))} menit.`)
            return
          }
          // The original command message is already the user's OOC bubble; valid !ooc is intentionally silent.
          for (const [usageKey, usage] of oocUsage) if (now - usage.lastAt > oocWindowMs * 2) oocUsage.delete(usageKey)
        },
      })

      context.commands.register({
        name: 'whitelistooc',
        aliases: ['oocwhitelist'],
        description: 'Kelola daftar user yang boleh OOC di grup IC',
        category: 'group',
        menuOrder: 52,
        permission: permissionNames.groupAdminOrBotOwner,
        handler: async (commandContext) => {
          const group = groupJid(commandContext)
          const actor = actorJid(commandContext)
          if (!group || !actor) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup.')
            return
          }
          const action = commandContext.args[0]?.toLowerCase() ?? 'list'
          try {
            if (action === 'list') {
              const entries = await service.listAllowlist(group)
              const metadata = await whatsapp.getGroupMetadata(group)
              const lines = entries.map((entry) => {
                const participant = metadata.participants.find((candidate) => service.memberKeyForJid(candidate.jid) === entry.memberKey)
                return `${participant ? userLabel(participant.jid) : '[member tidak ditemukan]'} (${entry.role})`
              })
              await commandContext.reply(lines.length ? ['OOC Whitelist', ...lines].join('\n') : 'OOC Whitelist kosong.')
              return
            }
            if (action === 'clear') {
              await service.clearAllowlist(group, actor)
              await commandContext.reply('OOC Whitelist sudah dikosongkan.')
              return
            }
            const target = targetFromMessage(commandContext)
            if (!target) {
              await commandContext.reply(`${whitelistUsage(commandContext.prefix)}\nTarget harus berupa mention WhatsApp atau reply.`)
              return
            }
            const metadata = await whatsapp.getGroupMetadata(group)
            if (!metadata.participants.some((participant) => participant.jid.split(':')[0]?.toLowerCase() === target.split(':')[0]?.toLowerCase())) {
              await commandContext.reply('Target harus merupakan member grup saat ini.')
              return
            }
            if (target === actor || target.split(':')[0]?.toLowerCase() === actor.split(':')[0]?.toLowerCase()) {
              await commandContext.reply('Kamu tidak dapat menambahkan diri sendiri ke OOC Whitelist.')
              return
            }
            if (action === 'add') {
              await service.addAllowlist(group, target, actor, 'narrator')
              await commandContext.reply(`OOC Whitelist diperbarui untuk ${userLabel(target)}.`)
              return
            }
            if (action === 'remove') {
              await service.removeAllowlist(group, target, actor)
              await commandContext.reply(`OOC Whitelist dihapus untuk ${userLabel(target)}.`)
              return
            }
            await commandContext.reply(whitelistUsage(commandContext.prefix))
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'OOC Whitelist belum dapat diproses.')
          }
        },
      })
    },
  }
}
