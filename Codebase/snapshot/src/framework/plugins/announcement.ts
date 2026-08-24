import type { CoreMessage, Plugin, ServiceRegistryLike, WhatsAppPort } from '../contracts.js'
import { AnnouncementService, type AnnouncementOutcomeCode, type AnnouncementRecord } from '../../services/announcement-service.js'
import { isGroupJid } from '../../platform/validation.js'

function groupJid(message: CoreMessage): string | undefined {
  return isGroupJid(message.remoteJid) ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function service(context: { services: ServiceRegistryLike }): AnnouncementService {
  return context.services.get<AnnouncementService>('announcement')
}

function correlationId(message: CoreMessage, action: string): string {
  const id = message.id.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().slice(0, 80) || 'message'
  return `r11-announcement-${action}-${id}`
}

function shortId(value: string): string {
  return value.slice(0, 8)
}

function usage(prefix: string): string {
  return [
    `Format: ${prefix}announce preview <pesan> dengan mention target eksplisit`,
    `Format: ${prefix}announce approve <id> <revision>`,
    `Format: ${prefix}announce cancel <id> <revision>`,
    `Format: ${prefix}announce status <id>`,
    `Format: ${prefix}announce list`,
    `Admin: ${prefix}announce enable|disable`,
  ].join('\n')
}

function renderCode(code: AnnouncementOutcomeCode): string {
  switch (code) {
    case 'feature_disabled': return 'Consent Window Announcement belum diaktifkan untuk grup ini.'
    case 'actor_not_admin': return 'Hanya admin grup yang dapat mengelola announcement.'
    case 'role_check_unavailable': return 'Status admin belum dapat diverifikasi; operasi dibatalkan.'
    case 'rate_limited': return 'Terlalu banyak operasi announcement. Coba lagi nanti.'
    case 'duplicate': return 'Operasi announcement dengan pesan yang sama sudah tercatat.'
    case 'stale_operation': return 'Revision sudah berubah. Gunakan status/list untuk mengambil revision terbaru.'
    case 'invalid_state': return 'Status announcement tidak mengizinkan operasi tersebut.'
    case 'expired': return 'Preview atau announcement sudah kedaluwarsa.'
    case 'not_found': return 'Announcement tidak ditemukan pada grup ini.'
    case 'quiet_hours': return 'Announcement ditunda karena quiet hours grup.'
    case 'policy_disabled': return 'Announcement dibatasi karena notifikasi grup dinonaktifkan.'
    case 'recovery_required': return 'Announcement memerlukan recovery aman dan tidak dijalankan ulang otomatis.'
    default: return 'Operasi announcement tidak dapat dijalankan dengan aman.'
  }
}

function renderRecord(record: AnnouncementRecord, includeBody: boolean): string {
  return [
    `Announcement ${shortId(record.id)}`,
    `Status: ${record.status}`,
    `Revision: ${record.revision}`,
    `Target eksplisit: ${record.targetCount}`,
    `Fingerprint: ${record.targetFingerprint.slice(0, 12)}`,
    `Berlaku sampai: ${record.expiresAt}`,
    ...(includeBody && record.body ? [`Preview: ${record.body}`] : []),
  ].join('\n')
}

export function createAnnouncementPlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'announcement',
    version: '0.1.0',
    load(context) {
      const announcements = service(context)
      announcements.startDispatcher(whatsapp)
      context.commands.register({
        name: 'announce',
        aliases: ['announcement', 'pengumuman'],
        description: 'Explicit-target consent window announcement',
        category: 'community',
        menuOrder: 75,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) {
            await commandContext.reply('Announcement hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas operator tidak tersedia; operasi dibatalkan.')
            return
          }
          const action = commandContext.args[0]?.toLowerCase()
          if (action === 'enable' || action === 'disable') {
            const result = await announcements.setEnabled(group, actor, action === 'enable', commandContext.whatsapp, commandContext.message.timestamp)
            if ('code' in result) {
              await commandContext.reply(renderCode(result.code))
              return
            }
            await commandContext.reply(`Consent Window Announcement grup sekarang *${result.enabled ? 'on' : 'off'}*.`)
            return
          }
          if (!action || action === 'help') {
            await commandContext.reply(usage(commandContext.prefix))
            return
          }
          if (action === 'preview') {
            const body = commandContext.args.slice(1).join(' ').trim()
            const targets = commandContext.message.mentionedJids ?? []
            if (!body || targets.length === 0) {
              await commandContext.reply(`Preview membutuhkan pesan dan minimal satu mention target eksplisit.\n${usage(commandContext.prefix)}`)
              return
            }
            const result = await announcements.preview({ groupJid: group, actorJid: actor, body, targetJids: targets, correlationId: correlationId(commandContext.message, 'preview') }, commandContext.whatsapp, commandContext.message.timestamp)
            if (result.kind === 'denied') {
              await commandContext.reply(renderCode(result.code ?? 'policy_denied'))
              return
            }
            await commandContext.reply(`${renderRecord(result.record, true)}\n\nSetujui dengan: ${commandContext.prefix}announce approve ${shortId(result.record.id)} ${result.record.revision}`)
            return
          }
          const id = commandContext.args[1]
          const revision = commandContext.args[2] ? Number(commandContext.args[2]) : undefined
          if (action === 'approve' || action === 'cancel') {
            if (!id || revision === undefined || !Number.isInteger(revision)) {
              await commandContext.reply(usage(commandContext.prefix))
              return
            }
            const input = { groupJid: group, actorJid: actor, announcementId: id, expectedRevision: revision, correlationId: correlationId(commandContext.message, action) }
            const result = action === 'approve'
              ? await announcements.approve(input, commandContext.whatsapp, commandContext.message.timestamp)
              : await announcements.cancel(input, commandContext.whatsapp, commandContext.message.timestamp)
            if (result.kind === 'denied') {
              await commandContext.reply(renderCode(result.code ?? 'policy_denied'))
              return
            }
            await commandContext.reply(renderRecord(result.record as AnnouncementRecord, false))
            return
          }
          if (action === 'status') {
            if (!id) {
              await commandContext.reply(usage(commandContext.prefix))
              return
            }
            const result = await announcements.getForReview(group, actor, id, commandContext.whatsapp, commandContext.message.timestamp)
            if (result.kind === 'denied') {
              await commandContext.reply(renderCode(result.code ?? 'policy_denied'))
              return
            }
            await commandContext.reply(renderRecord(result.record as AnnouncementRecord, true))
            return
          }
          if (action === 'list') {
            const result = await announcements.listForReview(group, actor, commandContext.whatsapp, undefined, commandContext.message.timestamp)
            if (result.kind === 'denied') {
              await commandContext.reply(renderCode(result.code))
              return
            }
            await commandContext.reply(result.records.length === 0 ? 'Belum ada announcement.' : result.records.map((record) => renderRecord(record, false)).join('\n\n'))
            return
          }
          await commandContext.reply(usage(commandContext.prefix))
        },
      })
    },
    unload(context) {
      service(context).stopDispatcher()
    },
  }
}
