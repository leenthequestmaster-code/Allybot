import { permissionNames } from '../../permissions.js'
import type {
  CoreMessage,
  GroupModerationAction,
  GroupSettingValue,
  Plugin,
  ServiceRegistryLike,
  WhatsAppPort,
} from '../contracts.js'
import { GroupModerationService } from '../../services/group-moderation-service.js'
import { isGroupJid } from '../../platform/validation.js'

const ACTIONS: readonly GroupModerationAction[] = ['add', 'remove', 'promote', 'demote']
const SETTINGS: readonly GroupSettingValue[] = ['announcement', 'not_announcement', 'locked', 'unlocked']

function groupJid(message: CoreMessage): string | undefined {
  return isGroupJid(message.remoteJid) ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function moderationService(context: { services: ServiceRegistryLike }): GroupModerationService {
  return context.services.get<GroupModerationService>('group-moderation')
}

function correlationId(message: CoreMessage, kind: string): string {
  const safeMessageId = message.id.replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 96) || 'message'
  return `r2-${kind}-${safeMessageId.replace(/:/g, '-')}`
}

function groupOnlyReply(commandContext: { reply(text: string): Promise<void> }): Promise<void> {
  return commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
}

function renderDenied(code: string): string {
  switch (code) {
    case 'in_progress': return 'Operasi moderation masih berjalan; jangan ulangi command yang sama.'
    case 'feature_disabled': return 'Fitur moderation actions belum diaktifkan untuk grup ini.'
    case 'policy_denied': return 'Aksi moderation ditolak oleh policy grup.'
    case 'rate_limited': return 'Terlalu banyak aksi moderation. Coba lagi setelah beberapa saat.'
    case 'actor_not_admin': return 'Hanya admin grup yang dapat menjalankan aksi ini.'
    case 'bot_not_admin': return 'Bot harus menjadi admin grup sebelum menjalankan aksi ini.'
    case 'role_check_unavailable': return 'Status admin belum dapat diverifikasi; aksi tidak dijalankan.'
    case 'capability_unavailable': return 'Capability WhatsApp untuk aksi ini belum tersedia pada adapter saat ini.'
    case 'transport_timeout': return 'WhatsApp tidak merespons dalam batas waktu; tidak ada retry otomatis.'
    case 'transport_failed': return 'WhatsApp menolak atau gagal menjalankan aksi moderation.'
    case 'partial': return 'Sebagian target berhasil diproses; periksa status operasi sebelum mengulang.'
    case 'recovery_required': return 'Status operasi tidak dapat dipulihkan dengan aman; jangan ulangi otomatis.'
    default: return 'Aksi moderation tidak dapat dijalankan dengan aman.'
  }
}

function help(prefix: string): string {
  return [
    `Format: ${prefix}modaction <add|remove|promote|demote> @member`,
    `Format: ${prefix}groupmode <announcement|not_announcement|locked|unlocked>`,
    `Mode dry-run/live diatur oleh service/feature flag dan tidak diaktifkan diam-diam oleh command.`,
  ].join('\n')
}

export function createGroupModerationPlugin(_whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'group-moderation',
    version: '0.1.0',
    load(context) {
      context.commands.register({
        name: 'modaction',
        description: 'Run a guarded participant moderation action',
        category: 'moderation',
        menuOrder: 20,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) return groupOnlyReply(commandContext)
          const action = commandContext.args[0]?.toLowerCase() as GroupModerationAction | undefined
          const target = commandContext.message.mentionedJids?.[0] ?? commandContext.message.quotedSenderJid
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          const bot = commandContext.whatsapp.userJid
          if (!action || !ACTIONS.includes(action) || !target || !actor || !bot) {
            await commandContext.reply(help(commandContext.prefix))
            return
          }
          const service = moderationService(commandContext)
          const configuredMode = service.getMode(group).mode
          if (configuredMode === 'off') {
            await commandContext.reply('Fitur moderation actions belum diaktifkan untuk grup ini.')
            return
          }
          const planned = await service.planAction({
            groupJid: group,
            actorJid: actor,
            botJid: bot,
            correlationId: correlationId(commandContext.message, `participant-${action}`),
            mode: configuredMode,
            action,
            targetJids: [target],
          }, commandContext.whatsapp)
          if (planned.kind === 'denied') {
            await commandContext.reply(renderDenied(planned.code))
            return
          }
          if (planned.kind === 'duplicate') {
            await commandContext.reply(`Operasi ini sudah diproses atau sedang berjalan. ID: ${planned.record.operationId.slice(0, 8)}`)
            return
          }
          const result = await service.executeAction(planned.record.operationId, commandContext.whatsapp)
          if (result.kind === 'denied') {
            await commandContext.reply(`${renderDenied(result.code)}\nID: ${result.record?.operationId.slice(0, 8) ?? planned.record.operationId.slice(0, 8)}`)
            return
          }
          const statuses = result.participantResults ?? []
          const okCount = statuses.filter((item) => item.status === 'ok').length
          await commandContext.reply(`✅ Aksi *${action}* selesai dalam mode *${result.record.mode}*.\nTarget diproses: ${okCount}/${planned.record.targetCount}\nID: ${result.record.operationId.slice(0, 8)}`)
        },
      })

      context.commands.register({
        name: 'groupmode',
        description: 'Update guarded group settings',
        category: 'moderation',
        menuOrder: 21,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) return groupOnlyReply(commandContext)
          const setting = commandContext.args[0]?.toLowerCase() as GroupSettingValue | undefined
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          const bot = commandContext.whatsapp.userJid
          if (!setting || !SETTINGS.includes(setting) || !actor || !bot) {
            await commandContext.reply(`Format: ${commandContext.prefix}groupmode <${SETTINGS.join('|')}>`)
            return
          }
          const service = moderationService(commandContext)
          const configuredMode = service.getMode(group).mode
          if (configuredMode === 'off') {
            await commandContext.reply('Fitur moderation actions belum diaktifkan untuk grup ini.')
            return
          }
          const planned = await service.planAction({
            groupJid: group,
            actorJid: actor,
            botJid: bot,
            correlationId: correlationId(commandContext.message, `setting-${setting}`),
            mode: configuredMode,
            setting,
          }, commandContext.whatsapp)
          if (planned.kind === 'denied') {
            await commandContext.reply(renderDenied(planned.code))
            return
          }
          if (planned.kind === 'duplicate') {
            await commandContext.reply(`Operasi ini sudah diproses atau sedang berjalan. ID: ${planned.record.operationId.slice(0, 8)}`)
            return
          }
          const result = await service.executeAction(planned.record.operationId, commandContext.whatsapp)
          await commandContext.reply(result.kind === 'denied'
            ? `${renderDenied(result.code)}\nID: ${result.record?.operationId.slice(0, 8) ?? planned.record.operationId.slice(0, 8)}`
            : `✅ Group mode berubah menjadi *${setting}*.\nID: ${result.record.operationId.slice(0, 8)}`)
        },
      })

      context.commands.register({
        name: 'modstatus',
        description: 'Show guarded moderation action status',
        category: 'moderation',
        menuOrder: 22,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) return groupOnlyReply(commandContext)
          const service = moderationService(commandContext)
          const mode = service.getMode(group).mode
          const recent = service.listOperations(group, undefined, 5)
          await commandContext.reply([
            `🛡️ Moderation actions: *${mode}*`,
            `Operasi tercatat: ${recent.length}`,
            'Perintah live tetap memerlukan actor dan bot admin serta capability adapter.',
          ].join('\n'))
        },
      })
    },
  }
}
