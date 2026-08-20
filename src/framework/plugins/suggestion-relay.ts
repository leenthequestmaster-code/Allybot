import type { CoreMessage, Plugin, ServiceRegistryLike, WhatsAppPort } from '../contracts.js'
import { SuggestionRelayService, type SuggestionOutcomeCode, type SuggestionRecord } from '../../services/suggestion-relay-service.js'
import { isGroupJid } from '../../platform/validation.js'

function groupJid(message: CoreMessage): string | undefined {
  return isGroupJid(message.remoteJid) ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function service(context: { services: ServiceRegistryLike }): SuggestionRelayService {
  return context.services.get<SuggestionRelayService>('suggestion-relay')
}

function correlationId(message: CoreMessage): string {
  const id = message.id.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().slice(0, 80) || 'message'
  return `r11-suggestion-${id}`
}

function shortId(value: string): string {
  return value.slice(0, 8)
}

function usage(prefix: string): string {
  return [
    `Format: ${prefix}suggest request <scene-id> <source-id>[,<source-id>] <permintaan>`,
    `Admin: ${prefix}suggest enable|disable`,
    'Sumber harus berasal dari bookmark Knowledge yang dipilih secara eksplisit.',
  ].join('\n')
}

function renderCode(code: SuggestionOutcomeCode): string {
  switch (code) {
    case 'feature_disabled': return 'Typed Suggestion Relay belum diaktifkan untuk grup ini.'
    case 'consent_required': return 'Consent scene untuk menerima bantuan atau membagikan context belum aktif/berlaku.'
    case 'scene_unavailable': return 'Scene tidak tersedia atau consent tidak dapat diverifikasi; suggestion tidak dibuat.'
    case 'knowledge_unavailable': return 'Knowledge source belum diaktifkan untuk grup ini.'
    case 'source_not_found': return 'Approved source tidak ditemukan, tidak terlihat, atau sudah kedaluwarsa.'
    case 'provider_unavailable': return 'Provider suggestion sedang tidak tersedia; tidak ada retry otomatis.'
    case 'rate_limited': return 'Terlalu banyak permintaan suggestion. Coba lagi nanti.'
    case 'duplicate': return 'Permintaan dengan correlation yang sama sudah pernah diproses.'
    case 'in_progress': return 'Permintaan suggestion sebelumnya masih diproses; jangan kirim ulang.'
    case 'expired': return 'Permintaan suggestion sudah kedaluwarsa.'
    case 'recovery_required': return 'Permintaan memerlukan recovery aman dan tidak dijalankan ulang otomatis.'
    default: return 'Suggestion tidak dapat dibuat dengan aman.'
  }
}

function renderRecord(record: SuggestionRecord): string {
  return [
    `Suggestion ${shortId(record.id)}`,
    `Status: ${record.status}`,
    `Context approved: ${record.contextCount} source`,
    `Berlaku sampai: ${record.expiresAt}`,
    ...(record.suggestion ? [`\n*Draft suggestion:*\n${record.suggestion}`, '\nSuggestion ini hanya rekomendasi. Tidak ada pengumuman, canon, atau side effect otomatis.'] : []),
  ].join('\n')
}

export const suggestionRelayPlugin: Plugin = {
  name: 'suggestion-relay',
  version: '0.1.0',
  load(context) {
    const suggestions = service(context)
    context.commands.register({
      name: 'suggest',
      aliases: ['suggestion'],
      description: 'Typed suggestion from explicit approved context',
      category: 'ai',
      menuOrder: 85,
      handler: async (commandContext) => {
        const group = groupJid(commandContext.message)
        if (!group) {
          await commandContext.reply('Suggestion Relay hanya dapat digunakan di dalam grup WhatsApp.')
          return
        }
        const actor = actorJid(commandContext.message, commandContext.whatsapp)
        if (!actor) {
          await commandContext.reply('Identitas requester tidak tersedia; operasi dibatalkan.')
          return
        }
        const action = commandContext.args[0]?.toLowerCase()
        if (action === 'enable' || action === 'disable') {
          const result = await suggestions.setEnabled(group, actor, action === 'enable', commandContext.whatsapp, commandContext.message.timestamp)
          if ('code' in result) {
            await commandContext.reply(renderCode(result.code))
            return
          }
          await commandContext.reply(`Typed Suggestion Relay grup sekarang *${result.enabled ? 'on' : 'off'}*.`)
          return
        }
        if (action !== 'request') {
          await commandContext.reply(usage(commandContext.prefix))
          return
        }
        const sceneReference = commandContext.args[1]
        const sourceArgument = commandContext.args[2]
        const requestText = commandContext.args.slice(3).join(' ').trim()
        if (!sceneReference || !sourceArgument || !requestText) {
          await commandContext.reply(usage(commandContext.prefix))
          return
        }
        const sourceReferences = sourceArgument.split(',').map((value) => value.trim()).filter(Boolean)
        const result = await suggestions.request({ groupJid: group, actorJid: actor, sceneReference, requestText, sourceReferences, correlationId: correlationId(commandContext.message) }, commandContext.message.timestamp)
        if (result.kind === 'denied') {
          await commandContext.reply(renderCode(result.code))
          return
        }
        await commandContext.reply(renderRecord(result.record))
      },
    })
  },
}
