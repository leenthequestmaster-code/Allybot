import type { CoreMessage, Plugin, ServiceRegistryLike, WhatsAppPort } from '../contracts.js'
import { OnboardingService, type OnboardingOutcomeCode, type OnboardingStatus } from '../../services/onboarding-service.js'

function groupJid(message: CoreMessage): string | undefined {
  return message.remoteJid.endsWith('@g.us') ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function onboardingService(context: { services: ServiceRegistryLike }): OnboardingService {
  return context.services.get<OnboardingService>('onboarding')
}

function groupOnlyReply(commandContext: { reply(text: string): Promise<void> }): Promise<void> {
  return commandContext.reply('Onboarding hanya dapat digunakan di dalam grup WhatsApp.')
}

function correlationId(message: CoreMessage, kind: string): string {
  const safeMessageId = message.id.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().slice(0, 80) || 'message'
  return `r10-onboarding-${kind}-${safeMessageId}`
}

function shortId(value: string): string {
  return value.slice(0, 8)
}

function help(prefix: string): string {
  return [
    `Format: ${prefix}onboarding apply <keterangan singkat>`,
    `Format: ${prefix}onboarding status`,
    `Format: ${prefix}onboarding list [applied|approved|denied|expired]`,
    `Format: ${prefix}onboarding review <id> approve|deny [revision]`,
    `Format: ${prefix}onboarding review <id> reopen [revision]`,
    `Admin: ${prefix}onboarding enable|disable`,
  ].join('\n')
}

function renderDenied(code: OnboardingOutcomeCode): string {
  switch (code) {
    case 'feature_disabled': return 'Fitur onboarding belum diaktifkan untuk grup ini.'
    case 'policy_denied': return 'Operasi onboarding ditolak oleh policy grup.'
    case 'rate_limited': return 'Terlalu banyak operasi onboarding. Coba lagi setelah beberapa saat.'
    case 'actor_not_admin': return 'Hanya admin grup yang dapat melakukan review atau mengubah pengaturan onboarding.'
    case 'role_check_unavailable': return 'Status admin belum dapat diverifikasi; operasi tidak dijalankan.'
    case 'not_found': return 'Application onboarding tidak ditemukan pada grup ini.'
    case 'duplicate': return 'Anda masih memiliki application onboarding yang aktif.'
    case 'stale_application': return 'Application sudah berubah. Muat ulang daftar lalu gunakan revision terbaru.'
    case 'invalid_state': return 'Status application tidak mengizinkan transisi tersebut.'
    case 'expired': return 'Application sudah kedaluwarsa dan tidak dapat direview lagi.'
    default: return 'Operasi onboarding tidak dapat dijalankan dengan aman.'
  }
}

export const onboardingPlugin: Plugin = {
  name: 'onboarding',
  version: '0.1.0',
  load(context) {
    context.commands.register({
      name: 'onboarding',
      aliases: ['onboard'],
      description: 'Bounded group onboarding workflow',
      category: 'community',
      menuOrder: 60,
      handler: async (commandContext) => {
        const group = groupJid(commandContext.message)
        if (!group) return groupOnlyReply(commandContext)
        const actor = actorJid(commandContext.message, commandContext.whatsapp)
        if (!actor) return commandContext.reply('Identitas actor tidak tersedia; operasi dibatalkan.')
        const service = onboardingService(commandContext)
        const action = commandContext.args[0]?.toLowerCase()

        if (action === 'enable' || action === 'disable') {
          const allowed = await service.setEnabled(group, actor, action === 'enable', commandContext.whatsapp, commandContext.message.timestamp)
          if ('code' in allowed) return commandContext.reply(renderDenied(allowed.code))
          return commandContext.reply(`Onboarding grup sekarang *${allowed.enabled ? 'on' : 'off'}*.`)
        }

        if (action === 'help' || !action) return commandContext.reply(help(commandContext.prefix))
        if (!service.isFeatureEnabled(group)) return commandContext.reply('Fitur onboarding belum diaktifkan untuk grup ini.')

        if (action === 'apply') {
          const applicationText = commandContext.args.slice(1).join(' ').trim()
          if (!applicationText) return commandContext.reply(help(commandContext.prefix))
          const result = service.apply({ groupJid: group, actorJid: actor, applicationText, correlationId: correlationId(commandContext.message, 'apply') }, commandContext.message.timestamp)
          if (result.kind === 'denied') return commandContext.reply(renderDenied(result.code))
          return commandContext.reply(`Application onboarding dibuat. ID: ${shortId(result.record.id)}\nStatus: ${result.record.status}\nRevision: ${result.record.revision}\nBerlaku sampai: ${result.record.expiresAt}`)
        }

        if (action === 'status') {
          const record = service.getOwnApplication(group, actor, commandContext.message.timestamp)
          if (!record) return commandContext.reply('Anda belum memiliki application onboarding pada grup ini.')
          return commandContext.reply(`Application Anda: ${shortId(record.id)}\nStatus: ${record.status}\nRevision: ${record.revision}\nBerlaku sampai: ${record.expiresAt}`)
        }

        if (action === 'list') {
          const statusArg = commandContext.args[1]?.toLowerCase()
          if (statusArg && !isOnboardingStatus(statusArg)) return commandContext.reply(help(commandContext.prefix))
          const status = statusArg as OnboardingStatus | undefined
          const result = await service.listForReview({ groupJid: group, actorJid: actor, ...(status ? { status } : {}), correlationId: correlationId(commandContext.message, 'list') }, commandContext.whatsapp, commandContext.message.timestamp)
          if (result.kind === 'denied') return commandContext.reply(renderDenied(result.code))
          if (result.records.length === 0) return commandContext.reply('Tidak ada application onboarding pada filter tersebut.')
          return commandContext.reply(result.records.map((record) => `${shortId(record.id)} · ${record.status} · rev ${record.revision} · ${record.applicationText ?? '[keterangan sudah tidak tersedia]'}`).join('\n'))
        }

        if (action === 'review') {
          const id = commandContext.args[1]
          const target = commandContext.args[2]?.toLowerCase()
          const expectedRevision = commandContext.args[3] ? Number(commandContext.args[3]) : undefined
          if (!id || (target !== 'approve' && target !== 'deny' && target !== 'reopen') || (expectedRevision !== undefined && !Number.isInteger(expectedRevision))) return commandContext.reply(help(commandContext.prefix))
          const result = await service.review({ groupJid: group, actorJid: actor, applicationId: id, target: target === 'approve' ? 'approved' : target === 'deny' ? 'denied' : 'reopen', ...(expectedRevision !== undefined ? { expectedRevision } : {}), correlationId: correlationId(commandContext.message, `review-${id}`) }, commandContext.whatsapp, commandContext.message.timestamp)
          if (result.kind === 'denied') return commandContext.reply(renderDenied(result.code))
          return commandContext.reply(`Application ${shortId(result.record.id)} sekarang *${result.record.status}* pada revision ${result.record.revision}.`)
        }

        return commandContext.reply(help(commandContext.prefix))
      },
    })

  },
}

function isOnboardingStatus(value: string): value is OnboardingStatus {
  return ['applied', 'approved', 'denied', 'expired'].includes(value)
}
