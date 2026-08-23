import type { CoreMessage, Plugin, ServiceRegistryLike, WhatsAppPort } from '../contracts.js'
import { EventService, type EventPhaseInput } from '../../services/event-service.js'
import { isGroupJid } from '../../platform/validation.js'

function groupJid(message: CoreMessage): string | undefined {
  return isGroupJid(message.remoteJid) ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function eventService(context: { services: ServiceRegistryLike }): EventService {
  return context.services.get<EventService>('event')
}

function groupOnlyReply(context: { reply(text: string): Promise<void> }): Promise<void> {
  return context.reply('Command event hanya dapat digunakan di dalam grup WhatsApp.')
}

async function isGroupAdmin(whatsapp: WhatsAppPort, groupJid: string, actorJid: string): Promise<boolean> {
  try {
    const metadata = await whatsapp.getGroupMetadata(groupJid)
    const normalizedActor = actorJid.split(':')[0]
    const participant = metadata.participants.find((item) => item.jid.split(':')[0] === normalizedActor)
    return participant?.role === 'admin' || participant?.role === 'superadmin'
  } catch {
    return false
  }
}

function fields(args: readonly string[]): string[] {
  return args.join(' ').split('|').map((value) => value.trim()).filter(Boolean)
}

function shortId(value: string): string {
  return value.slice(0, 8)
}

function parseTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value.trim())
  if (!Number.isFinite(timestamp)) throw new Error(`${field} tidak valid`)
  return timestamp
}

function parsePhase(value: string, index: number): EventPhaseInput {
  const parts = value.split('@').map((part) => part.trim())
  if (parts.length < 2 || parts.length > 3 || !parts[0]) throw new Error(`Fase ${index} tidak valid`)
  return {
    order: index,
    title: parts[0],
    startAt: parseTimestamp(parts[1], `start fase ${index}`),
    ...(parts[2] ? { endAt: parseTimestamp(parts[2], `end fase ${index}`) } : {}),
  }
}

function formatAt(timestamp: number, timezone: string): string {
  return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(timestamp)
}

function help(prefix: string): string {
  return [
    `Format: ${prefix}event enable|disable`,
    `Format: ${prefix}event create judul | deskripsi | start RFC3339 | IANA/UTC | fase @ start RFC3339 [@ end] ; fase berikutnya`,
    `Format: ${prefix}event publish|join|leave|status|recap <id>`,
    `Format: ${prefix}event phase <id> <nomor>`,
    `Format: ${prefix}event pause|resume|close <id>`,
    `Format: ${prefix}event poll <id> pertanyaan | opsi 1 | opsi 2`,
    `Format: ${prefix}event location <id> label | latitude | longitude`,
    `Format: ${prefix}event contact <id>`,
    `Format: ${prefix}calendar [id]`,
    'Contact-card dan location native belum dipanggil; fallback teks tetap tersedia.',
  ].join('\n')
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.includes('disabled')) return 'Fitur event belum diaktifkan untuk grup ini.'
  if (message.includes('creator')) return 'Hanya creator event yang dapat melakukan perubahan ini.'
  if (message.includes('admin')) return 'Hanya admin grup yang dapat menjalankan command ini.'
  if (message.includes('not found')) return 'Event tidak ditemukan di grup ini.'
  if (message.includes('ambiguous')) return 'ID event terlalu pendek atau ambigu; gunakan ID yang lebih panjang.'
  if (message.includes('not accepting')) return 'Event tidak sedang menerima peserta.'
  if (message.includes('participant limit')) return 'Batas peserta event sudah tercapai.'
  if (message.includes('Collaboration poll')) return 'Poll event memerlukan Collaboration aktif pada grup ini.'
  if (message.includes('valid') || message.includes('Format') || message.includes('Phase') || message.includes('fase')) return `Input event tidak valid: ${message}`
  return 'Operasi event tidak dapat dijalankan dengan aman.'
}

export function createEventPlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'event',
    version: '0.1.0',
    load(context) {
      const service = eventService(context)
      service.startEventDispatcher(whatsapp)

      context.commands.register({
        name: 'event',
        aliases: ['events', 'acara'],
        description: 'Event Conductor multi-phase',
        category: 'events',
        menuOrder: 60,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) return groupOnlyReply(commandContext)
          const actor = actorJid(commandContext.message, whatsapp)
          if (!actor) return commandContext.reply('Identitas actor tidak tersedia; operasi dibatalkan.')
          const action = commandContext.args[0]?.toLowerCase()
          try {
            if (action === 'enable' || action === 'disable') {
              if (!(await isGroupAdmin(whatsapp, group, actor))) {
                await commandContext.reply('Hanya admin grup yang dapat mengubah toggle Event Conductor.')
                return
              }
              const enabled = service.setEnabled(group, action === 'enable', actor)
              await commandContext.reply(`Event Conductor grup sekarang *${enabled ? 'on' : 'off'}*.`)
              return
            }
            if (!service.isEnabled(group)) {
              await commandContext.reply(`Fitur event belum aktif. Admin dapat menjalankan ${commandContext.prefix}event enable.`)
              return
            }
            const adminMutation = new Set(['create', 'publish', 'phase', 'pause', 'resume', 'close'])
            if (action && adminMutation.has(action) && !(await isGroupAdmin(whatsapp, group, actor))) {
              await commandContext.reply('Hanya admin grup yang dapat menjalankan lifecycle mutation event.')
              return
            }
            if (!action) {
              const events = service.listEvents(group)
              await commandContext.reply(events.length === 0 ? help(commandContext.prefix) : renderCalendar(events, commandContext.prefix))
              return
            }
            if (action === 'create') {
              const values = fields(commandContext.args.slice(1))
              if (values.length < 5) return commandContext.reply(help(commandContext.prefix))
              const phases = values.slice(4).join('|').split(';').map((value, index) => parsePhase(value, index + 1))
              const record = service.createEvent(group, actor, values[0], values[1], values[3], parseTimestamp(values[2], 'start event'), undefined, phases)
              await commandContext.reply(`Draft event dibuat. ID: ${shortId(record.id)}\nStatus: *${record.status}*\nPublikasikan dengan ${commandContext.prefix}event publish ${shortId(record.id)}.`)
              return
            }
            const id = commandContext.args[1]
            if (action === 'join' || action === 'leave') {
              if (!id) return commandContext.reply(help(commandContext.prefix))
              const changed = action === 'join' ? service.joinEvent(group, id, actor) : service.leaveEvent(group, id, actor)
              await commandContext.reply(changed ? `Event ${shortId(id)} berhasil di-${action === 'join' ? 'ikuti' : 'tinggalkan'}.` : `Tidak ada perubahan; status peserta sudah sesuai.`)
              return
            }
            if (action === 'status') {
              if (!id) {
                const events = service.listEvents(group)
                await commandContext.reply(events.length === 0 ? 'Belum ada event terbuka.' : renderCalendar(events, commandContext.prefix))
                return
              }
              const event = service.getEvent(group, id)
              await commandContext.reply(event ? renderStatus(event) : 'Event tidak ditemukan di grup ini.')
              return
            }
            if (action === 'recap') {
              if (!id) return commandContext.reply(help(commandContext.prefix))
              const event = service.getEvent(group, id)
              if (!event) return commandContext.reply('Event tidak ditemukan di grup ini.')
              const participants = service.getParticipants(group, id)
              await commandContext.reply(`${renderStatus(event)}\nPeserta aktif: ${participants.length}\nParticipant refs: ${participants.map((item) => item.participantRef).join(', ') || 'belum ada'}`)
              return
            }
            if (action === 'publish' || action === 'pause' || action === 'resume' || action === 'close') {
              if (!id) return commandContext.reply(help(commandContext.prefix))
              const record = action === 'publish'
                ? service.publishEvent(group, id, actor)
                : action === 'pause'
                  ? service.pauseEvent(group, id, actor)
                  : action === 'resume'
                    ? service.resumeEvent(group, id, actor)
                    : service.closeEvent(group, id, actor)
              await commandContext.reply(record ? `Event ${shortId(record.id)} sekarang *${record.status}*.` : 'Event tidak ditemukan atau transition stale.')
              return
            }
            if (action === 'phase') {
              const phaseOrder = Number(commandContext.args[2])
              if (!id || !Number.isInteger(phaseOrder)) return commandContext.reply(help(commandContext.prefix))
              const record = service.setPhase(group, id, actor, phaseOrder)
              await commandContext.reply(record ? `Fase ${phaseOrder} event ${shortId(record.id)} sekarang aktif.` : 'Event tidak ditemukan atau transition stale.')
              return
            }
            if (action === 'poll') {
              const values = fields(commandContext.args.slice(2))
              if (!id || values.length < 3) return commandContext.reply(help(commandContext.prefix))
              const record = service.linkPoll(group, id, actor, values[0], values.slice(1))
              await commandContext.reply(record?.pollId ? `Poll berhasil ditautkan ke event ${shortId(record.id)}. Poll ID: ${shortId(record.pollId)}.` : 'Poll tidak berhasil ditautkan.')
              return
            }
            if (action === 'location') {
              const values = fields(commandContext.args.slice(2))
              if (!id || values.length !== 3) return commandContext.reply(help(commandContext.prefix))
              const record = service.setLocation(group, id, actor, values[0], Number(values[1]), Number(values[2]))
              await commandContext.reply(record ? `Lokasi teks event ${shortId(record.id)} disimpan: ${record.locationLabel} (${record.locationLatitude}, ${record.locationLongitude}). Native location tidak digunakan.` : 'Lokasi tidak berhasil disimpan.')
              return
            }
            if (action === 'contact') {
              const event = id ? service.getEvent(group, id) : undefined
              await commandContext.reply(event ? `Contact-card native belum tersedia pada adapter. Creator event ${shortId(event.id)} tetap terikat pada ownership internal; gunakan koordinasi langsung di grup.` : 'Event tidak ditemukan di grup ini.')
              return
            }
            await commandContext.reply(help(commandContext.prefix))
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError', command: action ?? 'event' }, 'event command rejected')
            await commandContext.reply(safeError(error))
          }
        },
      })

      context.commands.register({
        name: 'calendar',
        aliases: ['kalender'],
        description: 'Show event calendar',
        category: 'events',
        menuOrder: 61,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) return groupOnlyReply(commandContext)
          try {
            if (!service.isEnabled(group)) return commandContext.reply(`Kalender event belum aktif. Admin dapat menjalankan ${commandContext.prefix}event enable.`)
            const id = commandContext.args[0]
            if (id) {
              const event = service.getEvent(group, id)
              return commandContext.reply(event ? renderStatus(event) : 'Event tidak ditemukan di grup ini.')
            }
            const events = service.listEvents(group)
            return commandContext.reply(events.length === 0 ? 'Belum ada event terbuka.' : renderCalendar(events, commandContext.prefix))
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'calendar command rejected')
            return commandContext.reply(safeError(error))
          }
        },
      })
    },
  }
}

function renderCalendar(events: readonly ReturnType<EventService['getEvent']>[], prefix: string): string {
  const records = events.filter((event): event is NonNullable<typeof event> => Boolean(event))
  return ['📅 *Event Calendar*', ...records.map((event) => `• ${shortId(event.id)} — *${event.title}* — ${event.status} — ${formatAt(event.startAt, event.timezone)}`), `Detail: ${prefix}calendar <id>`].join('\n')
}

function renderStatus(event: NonNullable<ReturnType<EventService['getEvent']>>): string {
  const phases = event.phases.map((phase) => `${phase.order}. ${phase.title} — ${phase.status} — ${formatAt(phase.startAt, event.timezone)}`).join('\n')
  const location = event.locationLabel ? `\nLokasi teks: ${event.locationLabel} (${event.locationLatitude}, ${event.locationLongitude})` : ''
  return `📅 *${event.title}*\nID: ${shortId(event.id)}\nStatus: *${event.status}*\nWaktu: ${formatAt(event.startAt, event.timezone)} (${event.timezone})\nPeserta: ${event.participantCount}${event.pollId ? `\nPoll: ${shortId(event.pollId)}` : ''}${location}\nFase:\n${phases}`
}
