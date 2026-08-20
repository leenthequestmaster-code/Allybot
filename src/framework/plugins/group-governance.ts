import type { CoreMessage, Plugin, ServiceRegistryLike, WhatsAppPort } from '../contracts.js'
import { permissionNames } from '../../permissions.js'
import { isGroupJid } from '../../platform/validation.js'
import { GroupGovernanceService, type GovernanceJoinRequestStatus, type GovernanceRetconStatus } from '../../services/group-governance-service.js'

function groupJid(message: CoreMessage): string | undefined {
  return isGroupJid(message.remoteJid) ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function governanceService(context: { services: ServiceRegistryLike }): GroupGovernanceService {
  return context.services.get<GroupGovernanceService>('group-governance')
}

function groupOnlyReply(commandContext: { reply(text: string): Promise<void> }): Promise<void> {
  return commandContext.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
}

function correlationId(message: CoreMessage, kind: string): string {
  const safeMessageId = message.id.replace(/[^a-zA-Z0-9._:-]/g, '-').slice(0, 96) || 'message'
  return `r8-${kind}-${safeMessageId.replace(/:/g, '-')}`
}

function shortId(value: string): string {
  return value.slice(0, 8)
}

function fields(args: readonly string[]): string[] {
  return args.join(' ').split('|').map((value) => value.trim()).filter(Boolean)
}

function help(prefix: string): string {
  return [
    `Format: ${prefix}retcon propose target | replacement | rationale [| source]`,
    `Format: ${prefix}retcon preview target | replacement | rationale`,
    `Format: ${prefix}retcon approve|reject <id> [revision]`,
    `Format: ${prefix}retcon history <id>`,
    `Format: ${prefix}handoff offer <scope> [evidenceCount]`,
    `Format: ${prefix}handoff claim|decline|close <id> [revision]`,
    `Format: ${prefix}handoff status`,
    `Format: ${prefix}continuity check`,
    `Format: ${prefix}joinrequests [pending|approving|approved|rejected]`,
    `Format: ${prefix}join approve|reject <requestId> [revision]`,
    `Format: ${prefix}invite info`,
    `Format: ${prefix}invite revoke preview|confirm <token>`,
    `Admin: ${prefix}retcon enable|disable`,
  ].join('\n')
}

function renderDenied(code: string): string {
  switch (code) {
    case 'feature_disabled': return 'Fitur governance belum diaktifkan untuk grup ini.'
    case 'policy_denied': return 'Operasi governance ditolak oleh policy grup.'
    case 'rate_limited': return 'Terlalu banyak operasi governance. Coba lagi setelah beberapa saat.'
    case 'actor_not_admin': return 'Hanya admin grup yang dapat menjalankan operasi governance ini.'
    case 'bot_not_admin': return 'Bot harus menjadi admin grup sebelum menjalankan mutation ini.'
    case 'role_check_unavailable': return 'Status admin belum dapat diverifikasi; operasi tidak dijalankan.'
    case 'capability_unavailable': return 'Capability WhatsApp untuk operasi ini belum tersedia pada adapter.'
    case 'transport_timeout': return 'WhatsApp tidak merespons dalam batas waktu; operasi tidak diulang otomatis.'
    case 'transport_failed': return 'WhatsApp menolak atau gagal menjalankan operasi.'
    case 'stale_request': return 'Request sudah berubah atau tidak lagi valid; refresh status sebelum mencoba lagi.'
    case 'duplicate': return 'Operasi tersebut sudah diproses atau sedang berjalan.'
    case 'in_progress': return 'Operasi masih berjalan; jangan mengirim ulang command yang sama.'
    case 'invalid_confirmation': return 'Token confirmation tidak valid.'
    case 'confirmation_expired': return 'Token confirmation sudah kedaluwarsa; buat preview baru.'
    case 'recovery_required': return 'Status operasi tidak dapat dipulihkan dengan aman; jangan ulangi otomatis.'
    default: return 'Operasi governance tidak dapat dijalankan dengan aman.'
  }
}

export function createGroupGovernancePlugin(_whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'group-governance',
    version: '0.1.0',
    load(context) {
      context.commands.register({
        name: 'retcon',
        description: 'Review bounded retcon proposals',
        category: 'governance',
        menuOrder: 50,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) return groupOnlyReply(commandContext)
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          if (!actor) return commandContext.reply('Identitas actor tidak tersedia; operasi dibatalkan.')
          const service = governanceService(commandContext)
          const action = commandContext.args[0]?.toLowerCase()
          if (action === 'enable' || action === 'disable') {
            const settings = service.setEnabled(group, action === 'enable', actor)
            await commandContext.reply(`Governance grup sekarang *${settings.enabled ? 'on' : 'off'}*.`)
            return
          }
          if (!service.isFeatureEnabled(group)) return commandContext.reply('Fitur governance belum diaktifkan untuk grup ini.')
          if (action === 'preview') {
            const values = fields(commandContext.args.slice(1))
            if (values.length < 3) return commandContext.reply(help(commandContext.prefix))
            await commandContext.reply(`Preview retcon — target: ${values[0]}\nReplacement: ${values[1]}\nRationale: ${values[2]}\nBelum ada perubahan canon.`)
            return
          }
          if (action === 'propose') {
            const values = fields(commandContext.args.slice(1))
            if (values.length < 3) return commandContext.reply(help(commandContext.prefix))
            const record = await service.createRetcon({ groupJid: group, actorJid: actor, target: values[0], replacement: values[1], rationale: values[2], ...(values[3] ? { sourceRef: values[3] } : {}) }, commandContext.whatsapp)
            if (!record) return commandContext.reply('Retcon proposal ditolak oleh policy atau role check.')
            await commandContext.reply(`Retcon draft dibuat. ID: ${shortId(record.id)}\nStatus: ${record.status}\nGunakan ${commandContext.prefix}retcon propose-status <id> untuk mengajukan review.`)
            return
          }
          if (action === 'propose-status') {
            const id = commandContext.args[1]
            if (!id) return commandContext.reply(help(commandContext.prefix))
            const record = await service.transitionRetcon({ groupJid: group, actorJid: actor, retconId: id, target: 'proposed' }, commandContext.whatsapp)
            await commandContext.reply(record ? `Retcon ${shortId(record.id)} berstatus *proposed* pada revision ${record.revision}.` : 'Retcon tidak ditemukan, stale, atau transition ditolak.')
            return
          }
          if (action === 'approve' || action === 'reject') {
            const id = commandContext.args[1]
            const expectedRevision = commandContext.args[2] ? Number(commandContext.args[2]) : undefined
            if (!id || (expectedRevision !== undefined && !Number.isInteger(expectedRevision))) return commandContext.reply(help(commandContext.prefix))
            const target = action === 'approve' ? 'approved' : 'rejected'
            const record = await service.transitionRetcon({ groupJid: group, actorJid: actor, retconId: id, target, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }, commandContext.whatsapp)
            await commandContext.reply(record ? `Retcon ${shortId(record.id)} sekarang *${record.status}* pada revision ${record.revision}.` : 'Retcon tidak ditemukan, stale, atau transition ditolak.')
            return
          }
          if (action === 'history') {
            const id = commandContext.args[1]
            if (!id) return commandContext.reply(help(commandContext.prefix))
            const history = service.listRetconHistory(group, id)
            await commandContext.reply(history.length ? history.map((item) => `${item.revision}. ${item.action} (${item.at})`).join('\n') : 'History retcon tidak ditemukan.')
            return
          }
          const status = action === 'lore' ? 'approved' : ['draft', 'proposed', 'approved', 'rejected'].includes(action ?? '') ? action as GovernanceRetconStatus : undefined
          if (!status && action) return commandContext.reply(help(commandContext.prefix))
          const records = service.listRetcons(group, status, 10)
          await commandContext.reply(records.length ? records.map((record) => `${shortId(record.id)} · ${record.status} · rev ${record.revision}`).join('\n') : help(commandContext.prefix))
        },
      })

      context.commands.register({
        name: 'handoff',
        description: 'Manage bounded moderator handoff',
        category: 'governance',
        menuOrder: 51,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) return groupOnlyReply(commandContext)
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          if (!actor) return commandContext.reply('Identitas actor tidak tersedia; operasi dibatalkan.')
          const service = governanceService(commandContext)
          if (!service.isFeatureEnabled(group)) return commandContext.reply('Fitur governance belum diaktifkan untuk grup ini.')
          const action = commandContext.args[0]?.toLowerCase()
          if (action === 'offer') {
            if (commandContext.args.length < 2) return commandContext.reply(help(commandContext.prefix))
            const scope = commandContext.args.slice(1, -1).join(' ') || commandContext.args.slice(1).join(' ')
            const last = commandContext.args.at(-1)
            const evidenceCount = last && /^\d+$/.test(last) ? Number(last) : 0
            const record = await service.createHandoff({ groupJid: group, actorJid: actor, scope, evidenceCount }, commandContext.whatsapp)
            await commandContext.reply(record ? `Handoff ditawarkan. ID: ${shortId(record.id)} · expiry ${record.expiresAt}` : 'Handoff ditolak oleh policy atau role check.')
            return
          }
          if (action === 'claim' || action === 'decline' || action === 'close') {
            const id = commandContext.args[1]
            const expectedRevision = commandContext.args[2] ? Number(commandContext.args[2]) : undefined
            if (!id || (expectedRevision !== undefined && !Number.isInteger(expectedRevision))) return commandContext.reply(help(commandContext.prefix))
            const target = action === 'claim' ? 'claimed' : action === 'decline' ? 'declined' : 'closed'
            const record = await service.transitionHandoff({ groupJid: group, actorJid: actor, handoffId: id, target, ...(expectedRevision !== undefined ? { expectedRevision } : {}) }, commandContext.whatsapp)
            await commandContext.reply(record ? `Handoff ${shortId(record.id)} sekarang *${record.status}* pada revision ${record.revision}.` : 'Handoff tidak ditemukan, expired, stale, atau transition ditolak.')
            return
          }
          const records = service.listHandoffs(group, 10)
          await commandContext.reply(action === 'status' && records.length ? records.map((record) => `${shortId(record.id)} · ${record.status} · rev ${record.revision}`).join('\n') : help(commandContext.prefix))
        },
      })

      context.commands.register({
        name: 'continuity',
        description: 'Check bounded governance continuity',
        category: 'governance',
        menuOrder: 52,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) return groupOnlyReply(commandContext)
          if (!governanceService(commandContext).isFeatureEnabled(group)) return commandContext.reply('Fitur governance belum diaktifkan untuk grup ini.')
          if (commandContext.args[0]?.toLowerCase() !== 'check') return commandContext.reply(`Format: ${commandContext.prefix}continuity check`)
          const result = governanceService(commandContext).continuityCheck(group)
          await commandContext.reply(`Continuity check\nRetcon pending: ${result.pendingRetcons}\nHandoff aktif: ${result.activeHandoffs}\nJoin request pending: ${result.pendingJoinRequests}\nOperasi yang perlu dipulihkan: ${result.recoverableOperations}`)
        },
      })

      context.commands.register({
        name: 'joinrequests',
        description: 'List bounded group join requests',
        category: 'governance',
        menuOrder: 53,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) return groupOnlyReply(commandContext)
          const service = governanceService(commandContext)
          if (!service.isFeatureEnabled(group)) return commandContext.reply('Fitur governance belum diaktifkan untuk grup ini.')
          const requestedStatus = commandContext.args[0]?.toLowerCase()
          if (requestedStatus && !['pending', 'approving', 'approved', 'rejected'].includes(requestedStatus)) return commandContext.reply(help(commandContext.prefix))
          const status = requestedStatus as GovernanceJoinRequestStatus | undefined
          const records = service.listJoinRequests(group, status, 10)
          await commandContext.reply(records.length ? records.map((record) => `${shortId(record.id)} · ${record.status} · requester ${record.requesterRefHash}`).join('\n') : 'Tidak ada join request pada filter tersebut.')
        },
      })

      context.commands.register({
        name: 'join',
        description: 'Approve or reject a bounded join request',
        category: 'governance',
        menuOrder: 54,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) return groupOnlyReply(commandContext)
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          const bot = commandContext.whatsapp.userJid
          const action = commandContext.args[0]?.toLowerCase()
          const id = commandContext.args[1]
          const expectedRevision = commandContext.args[2] ? Number(commandContext.args[2]) : undefined
          if (!actor || !bot || !id || (action !== 'approve' && action !== 'reject') || (expectedRevision !== undefined && !Number.isInteger(expectedRevision))) return commandContext.reply(help(commandContext.prefix))
          const service = governanceService(commandContext)
          const result = action === 'approve'
            ? await service.approveJoinRequest({ groupJid: group, actorJid: actor, botJid: bot, requestId: id, correlationId: correlationId(commandContext.message, `join-approve-${id}`), ...(expectedRevision !== undefined ? { expectedRevision } : {}) }, commandContext.whatsapp)
            : await service.rejectJoinRequest({ groupJid: group, actorJid: actor, botJid: bot, requestId: id, correlationId: correlationId(commandContext.message, `join-reject-${id}`), ...(expectedRevision !== undefined ? { expectedRevision } : {}) }, commandContext.whatsapp)
          await commandContext.reply(result.kind === 'completed' ? `Join request ${shortId(id)} berhasil ${action}. Operation: ${shortId(result.record.operationId)}` : renderDenied(result.code))
        },
      })

      context.commands.register({
        name: 'invite',
        description: 'Inspect or revoke the group invite safely',
        category: 'governance',
        menuOrder: 55,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) return groupOnlyReply(commandContext)
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          const bot = commandContext.whatsapp.userJid
          if (!actor || !bot) return commandContext.reply('Identitas actor atau bot tidak tersedia; operasi dibatalkan.')
          const service = governanceService(commandContext)
          if (!service.isFeatureEnabled(group)) return commandContext.reply('Fitur governance belum diaktifkan untuk grup ini.')
          const action = commandContext.args[0]?.toLowerCase()
          if (action === 'info') {
            const link = await service.getInviteLink(group, actor, commandContext.whatsapp)
            await commandContext.reply(link ? `Invite link aktif:\n${link}` : 'Invite link tidak tersedia.')
            return
          }
          if (action === 'revoke' && commandContext.args[1]?.toLowerCase() === 'preview') {
            const preview = await service.previewInviteRevoke({ groupJid: group, actorJid: actor }, commandContext.whatsapp)
            await commandContext.reply(preview ? `Preview revoke dibuat. Balas: ${commandContext.prefix}invite revoke confirm ${preview.confirmationToken}\nBerlaku sampai: ${preview.expiresAt}` : 'Preview revoke ditolak oleh policy atau role check.')
            return
          }
          if (action === 'revoke' && commandContext.args[1]?.toLowerCase() === 'confirm' && commandContext.args[2]) {
            const result = await service.confirmInviteRevoke({ groupJid: group, actorJid: actor, botJid: bot, confirmationToken: commandContext.args[2], correlationId: correlationId(commandContext.message, 'invite-revoke') }, commandContext.whatsapp)
            await commandContext.reply(result.kind === 'completed' ? `Invite berhasil di-revoke. Operation: ${shortId(result.record.operationId)}` : renderDenied(result.code))
            return
          }
          await commandContext.reply(help(commandContext.prefix))
        },
      })
    },
  }
}
