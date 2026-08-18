import type { CoreMessage, Plugin, ServiceRegistryLike, WhatsAppGroupMetadata, WhatsAppPort } from '../contracts.js'
import { permissionNames } from '../../permissions.js'
import { GroupSafetyService, type ModerationCaseRecord, type WarningRecord } from '../../services/group-safety-service.js'

const LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<>]+/i
const MAX_RENDERED_REASON = 160

function groupJid(message: CoreMessage): string | undefined {
  return message.remoteJid.endsWith('@g.us') ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function targetJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.mentionedJids?.[0] ?? message.quotedSenderJid ?? actorJid(message, whatsapp)
}

function requireGroup(message: CoreMessage): string | undefined {
  return groupJid(message)
}

function normalizeReason(args: readonly string[]): string {
  return args.join(' ').trim()
}

function shorten(value: string): string {
  return value.length > MAX_RENDERED_REASON ? `${value.slice(0, MAX_RENDERED_REASON - 3)}...` : value
}

function formatWarning(warning: WarningRecord): string {
  return `⚠️ ${warning.id.slice(0, 8)} — @${warning.targetJid.split('@')[0]} — ${warning.status} — ${shorten(warning.reason)}`
}

function formatCase(record: ModerationCaseRecord): string {
  return `🛡️ ${record.id.slice(0, 8)} — ${record.status} — rule=${record.ruleId} — target=@${record.targetJid.split('@')[0]} — ${shorten(record.reason)}`
}

function isAdmin(metadata: WhatsAppGroupMetadata, jid: string | undefined): boolean {
  if (!jid) return false
  const bare = jid.split(':')[0]
  return metadata.participants.some((participant) => {
    const participantBare = participant.jid.split(':')[0]
    return participantBare === bare && (participant.role === 'admin' || participant.role === 'superadmin')
  })
}

function safetyService(context: { services: ServiceRegistryLike }): GroupSafetyService {
  return context.services.get<GroupSafetyService>('group-safety')
}

function findCaseByPrefix(service: GroupSafetyService, group: string, prefix: string): ModerationCaseRecord | undefined {
  return service.listCases(group, undefined, 25).find((record) => record.id.startsWith(prefix))
}

function modeHelp(prefix: string): string {
  return `Format: ${prefix}setsafety <dry-run|off>\nDry-run hanya mencatat deteksi dan tidak menghapus pesan atau mengubah member.`
}

export function createGroupSafetyPlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'group-safety',
    version: '0.1.0',
    load(context) {
      context.commands.register({
        name: 'safety',
        description: 'Show group safety mode',
        category: 'moderation',
        menuOrder: 1,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext.message)
          if (!group) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const settings = safetyService(commandContext).getMode(group)
          await commandContext.reply(`🛡️ Group Safety: *${settings.mode}*\nAktifkan dengan ${commandContext.prefix}setsafety dry-run (admin).`)
        },
      })

      context.commands.register({
        name: 'setsafety',
        description: 'Enable or disable group safety dry-run',
        category: 'moderation',
        menuOrder: 2,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext.message)
          if (!group) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const mode = commandContext.args[0]?.toLowerCase()
          if (mode !== 'dry-run' && mode !== 'off') {
            await commandContext.reply(modeHelp(commandContext.prefix))
            return
          }
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas actor tidak tersedia; perubahan safety ditolak.')
            return
          }
          const record = safetyService(commandContext).setMode(group, mode, actor)
          await commandContext.reply(`✅ Group Safety untuk grup ini sekarang: *${record.mode}*.\nMode enforcement destructive belum tersedia.`)
        },
      })

      context.commands.register({
        name: 'warn',
        description: 'Issue an auditable warning to a group member',
        category: 'moderation',
        menuOrder: 3,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext.message)
          if (!group) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const target = targetJid(commandContext.message, commandContext.whatsapp)
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          const reason = normalizeReason(commandContext.args)
          if (!target || !actor || !reason) {
            await commandContext.reply(`Format: ${commandContext.prefix}warn @member <alasan> atau reply pesan member.`)
            return
          }
          const warning = safetyService(commandContext).issueWarning(group, target, actor, reason)
          await commandContext.reply(`✅ Warning tercatat. ID: ${warning.id.slice(0, 8)}\nTarget: @${target.split('@')[0]}\nBerlaku sampai: ${new Date(warning.expiresAt).toISOString()}`, { mentions: [target] })
        },
      })

      context.commands.register({
        name: 'warnings',
        aliases: ['warns'],
        description: 'List recent group warnings',
        category: 'moderation',
        menuOrder: 4,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext.message)
          if (!group) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const target = commandContext.message.mentionedJids?.[0] ?? commandContext.message.quotedSenderJid
          const warnings = safetyService(commandContext).listWarnings(group, target)
          await commandContext.reply(warnings.length === 0 ? 'Belum ada warning tercatat.' : ['⚠️ *Recent Warnings*', ...warnings.map(formatWarning)].join('\n'))
        },
      })

      context.commands.register({
        name: 'clearwarn',
        description: 'Revoke a warning by id prefix',
        category: 'moderation',
        menuOrder: 5,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext.message)
          if (!group) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const idPrefix = commandContext.args[0]
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          if (!idPrefix || !actor) {
            await commandContext.reply(`Format: ${commandContext.prefix}clearwarn <id>`)
            return
          }
          const warning = safetyService(commandContext).listWarnings(group, undefined, 25).find((item) => item.id.startsWith(idPrefix))
          const warningId = warning?.id.slice(0, 8)
          const revoked = warning ? safetyService(commandContext).revokeWarning(group, warning.id, actor) : undefined
          await commandContext.reply(revoked && warningId ? `✅ Warning ${warningId} dicabut.` : 'Warning tidak ditemukan, sudah expired, atau sudah dicabut.')
        },
      })

      context.commands.register({
        name: 'report',
        description: 'Report a group safety case',
        category: 'moderation',
        menuOrder: 6,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext.message)
          if (!group) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const reporter = actorJid(commandContext.message, commandContext.whatsapp)
          const target = targetJid(commandContext.message, commandContext.whatsapp)
          const reason = normalizeReason(commandContext.args)
          if (!reporter || !target || !reason) {
            await commandContext.reply(`Format: ${commandContext.prefix}report @member <alasan> atau reply pesan.`)
            return
          }
          const result = safetyService(commandContext).reportCase(group, reporter, target, 'member.report', reason, commandContext.message.id, commandContext.message.text)
          await commandContext.reply(result.created ? `✅ Laporan dibuat. Case ID: ${result.record.id.slice(0, 8)}\nModerator dapat meninjau melalui ${commandContext.prefix}cases.` : `Laporan ini sudah memiliki case ${result.record.id.slice(0, 8)}.`)
        },
      })

      context.commands.register({
        name: 'cases',
        description: 'List recent group safety cases',
        category: 'moderation',
        menuOrder: 7,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext.message)
          if (!group) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const cases = safetyService(commandContext).listCases(group, ['open', 'claimed', 'appealed'])
          await commandContext.reply(cases.length === 0 ? 'Tidak ada case terbuka.' : ['🛡️ *Open Safety Cases*', ...cases.map(formatCase)].join('\n'))
        },
      })

      context.commands.register({
        name: 'case',
        description: 'Show one group safety case',
        category: 'moderation',
        menuOrder: 8,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext.message)
          if (!group) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const id = commandContext.args[0]
          if (!id) {
            await commandContext.reply(`Format: ${commandContext.prefix}case <id>`)
            return
          }
          const record = findCaseByPrefix(safetyService(commandContext), group, id)
          await commandContext.reply(record ? [formatCase(record), `Reporter: @${record.reporterJid.split('@')[0]}`, `Evidence: ${record.evidenceMessageId ? 'message id tersimpan' : 'tidak ada'}`, `Revision: ${record.revision}`].join('\n') : 'Case tidak ditemukan di grup ini.')
        },
      })

      context.commands.register({
        name: 'claimcase',
        description: 'Claim an open safety case',
        category: 'moderation',
        menuOrder: 9,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext.message)
          if (!group) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const id = commandContext.args[0]
          const expectedRevision = Number(commandContext.args[1])
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          if (!id || !Number.isInteger(expectedRevision) || !actor) {
            await commandContext.reply(`Format: ${commandContext.prefix}claimcase <id> <revision>`)
            return
          }
          const targetCase = findCaseByPrefix(safetyService(commandContext), group, id)
          const record = targetCase ? safetyService(commandContext).claimCase(group, targetCase.id, actor, expectedRevision) : undefined
          await commandContext.reply(record ? `✅ Case ${record.id.slice(0, 8)} di-claim. Revision: ${record.revision}` : 'Case tidak ditemukan, bukan status yang dapat di-claim, atau revision sudah berubah.')
        },
      })

      for (const [name, status, label] of [['resolvecase', 'resolved', 'diselesaikan'], ['dismisscase', 'dismissed', 'ditutup']] as const) {
        context.commands.register({
          name,
          description: `${label} a group safety case`,
          category: 'moderation',
          menuOrder: name === 'resolvecase' ? 10 : 11,
          permission: permissionNames.groupAdmin,
          handler: async (commandContext) => {
            const group = requireGroup(commandContext.message)
            if (!group) {
              await commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
              return
            }
            const id = commandContext.args[0]
            const expectedRevision = Number(commandContext.args[1])
            const note = normalizeReason(commandContext.args.slice(2))
            const actor = actorJid(commandContext.message, commandContext.whatsapp)
            if (!id || !Number.isInteger(expectedRevision) || !note || !actor) {
              await commandContext.reply(`Format: ${commandContext.prefix}${name} <id> <revision> <catatan>`)
              return
            }
            const targetCase = findCaseByPrefix(safetyService(commandContext), group, id)
            const record = targetCase && (status === 'resolved'
              ? safetyService(commandContext).resolveCase(group, targetCase.id, actor, note, expectedRevision)
              : safetyService(commandContext).dismissCase(group, targetCase.id, actor, note, expectedRevision))
            await commandContext.reply(record ? `✅ Case ${record.id.slice(0, 8)} berhasil ${label}.` : 'Case tidak ditemukan, status tidak sesuai, atau revision sudah berubah.')
          },
        })
      }

      context.commands.register({
        name: 'appeal',
        description: 'Appeal your own resolved or dismissed case',
        category: 'moderation',
        menuOrder: 12,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext.message)
          if (!group) {
            await commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const id = commandContext.args[0]
          const reason = normalizeReason(commandContext.args.slice(1))
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          if (!id || !reason || !actor) {
            await commandContext.reply(`Format: ${commandContext.prefix}appeal <id> <alasan>`)
            return
          }
          const targetCase = findCaseByPrefix(safetyService(commandContext), group, id)
          const result = targetCase ? safetyService(commandContext).appealCase(group, targetCase.id, actor, reason) : undefined
          await commandContext.reply(result ? result.created ? `✅ Appeal dibuat untuk case ${result.record.id.slice(0, 8)}.` : `Appeal untuk case ${result.record.id.slice(0, 8)} sudah tercatat.` : 'Appeal ditolak: case tidak ditemukan, bukan milikmu, atau status belum dapat di-appeal.')
        },
      })

      context.events.on('message.received', async (message) => {
        await inspectMessage(context.logger, message, whatsapp, context.services)
      })
    },
  }
}

async function inspectMessage(logger: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void }, message: CoreMessage, whatsapp: WhatsAppPort, services: ServiceRegistryLike): Promise<void> {
  const group = groupJid(message)
  const text = message.text?.trim()
  const sender = message.senderJid
  if (!group || !text || message.fromMe || !sender) return
  const safety = services.get<GroupSafetyService>('group-safety')
  if (!safety.isDryRun(group)) return

  const linkDetected = LINK_PATTERN.test(text)
  const spamAllowed = safety.consumeAntiSpam(group, sender, message.receivedAt ?? message.timestamp)
  if (!linkDetected && spamAllowed) return

  let metadata: WhatsAppGroupMetadata
  try {
    metadata = await whatsapp.getGroupMetadata(group)
  } catch (error) {
    logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError', group }, 'group safety metadata lookup failed')
    return
  }
  if (isAdmin(metadata, sender)) return

  const detectionNow = message.receivedAt ?? message.timestamp
  if (linkDetected && safety.shouldCreateDryRunCase(group, sender, 'anti-link', detectionNow)) {
    const result = safety.reportCase(group, sender, sender, 'anti-link', 'Link terdeteksi pada mode dry-run.', message.id, text, detectionNow)
    if (result.created) logger.info({ caseId: result.record.id, ruleId: 'anti-link' }, 'group safety dry-run case created')
  }
  if (!spamAllowed && safety.shouldCreateDryRunCase(group, sender, 'anti-spam', detectionNow)) {
    const result = safety.reportCase(group, sender, sender, 'anti-spam', 'Burst pesan terdeteksi pada mode dry-run.', message.id, text, detectionNow)
    if (result.created) logger.info({ caseId: result.record.id, ruleId: 'anti-spam' }, 'group safety dry-run case created')
  }
}
