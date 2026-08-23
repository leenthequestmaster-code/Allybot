import type {
  CommandContext,
  CoreMessage,
  Plugin,
  ServiceRegistryLike,
  WhatsAppGroupMetadata,
  WhatsAppPort,
} from '../../framework/contracts.js'
import { permissionNames } from '../../permissions.js'
import { isGroupJid } from '../../platform/validation.js'
import {
  CollaborationService,
  type CollaborationPollStatus,
  type DecisionRecord,
  type PollRecord,
  type ReminderRecord,
  type TaskRecord,
} from '../../services/collaboration-service.js'

function groupJid(message: CoreMessage): string | undefined {
  return isGroupJid(message.remoteJid) ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function collaboration(context: { services: ServiceRegistryLike }): CollaborationService {
  return context.services.get<CollaborationService>('collaboration')
}

function isAdmin(metadata: WhatsAppGroupMetadata, jid: string | undefined): boolean {
  if (!jid) return false
  const normalized = jid.split(':')[0]
  return metadata.participants.some((participant) => participant.jid.split(':')[0] === normalized && (participant.role === 'admin' || participant.role === 'superadmin'))
}

function requireGroup(context: CommandContext): string | undefined {
  const group = groupJid(context.message)
  if (!group) void context.reply('Command Collaboration hanya dapat digunakan di dalam grup WhatsApp.')
  return group
}

function requireEnabled(context: CommandContext, group: string): boolean {
  if (collaboration(context).isEnabled(group)) return true
  void context.reply(`Fitur Collaboration belum aktif untuk grup ini. Admin dapat mengaktifkannya dengan ${context.prefix}setcollab on.`)
  return false
}

function normalizeText(args: readonly string[]): string {
  return args.join(' ').trim()
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function findByPrefix<T extends { id: string }>(records: readonly T[], prefix: string): T | undefined {
  return records.find((record) => record.id.startsWith(prefix))
}

function pollHelp(prefix: string): string {
  return [
    `Format: ${prefix}poll <pertanyaan> | <opsi 1> | <opsi 2>`,
    `Vote resmi: ${prefix}vote <id> <nomor opsi>`,
    `Contoh: ${prefix}poll Lokasi scene? | Pelabuhan | Kota Tua`,
  ].join('\n')
}

function renderPoll(poll: PollRecord, results?: readonly { optionIndex: number; option: string; votes: number }[]): string {
  const options = poll.options.map((option, index) => {
    const count = results?.find((result) => result.optionIndex === index)?.votes
    return `${index + 1}. ${option}${count === undefined ? '' : ` — ${count} vote`}`
  })
  return [
    `📊 *Poll ${shortId(poll.id)}*`,
    poll.question,
    ...options,
    `Status: ${poll.status} | Transport: ${poll.transportStatus}`,
    `Berlaku sampai: ${new Date(poll.expiresAt).toISOString()}`,
    `Gunakan !vote ${shortId(poll.id)} <nomor> untuk pencatatan resmi.`,
  ].join('\n')
}

function renderReminder(reminder: ReminderRecord): string {
  return `⏰ ${shortId(reminder.id)} — ${reminder.status} — ${new Date(reminder.dueAt).toISOString()} — ${reminder.text}`
}

function renderTask(task: TaskRecord): string {
  return `✅ ${shortId(task.id)} — ${task.status} — ${task.text}${task.assigneeJid ? ` — assignee @${task.assigneeJid.split('@')[0]}` : ''}`
}

function renderDecision(decision: DecisionRecord): string {
  return `📝 ${shortId(decision.id)} — ${decision.text}`
}

async function canManagePoll(context: CommandContext, poll: PollRecord, actor: string): Promise<boolean> {
  if (poll.creatorJid === actor) return true
  try {
    return isAdmin(await context.whatsapp.getGroupMetadata(poll.groupJid), actor)
  } catch {
    return false
  }
}

export function createCollaborationPlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'collaboration',
    version: '0.1.0',
    load(context) {
      collaboration(context).startReminderDispatcher(whatsapp)
      context.commands.register({
        name: 'collab',
        description: 'Show Collaboration status',
        category: 'collaboration',
        menuOrder: 1,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return
          const service = collaboration(commandContext)
          await commandContext.reply(`🤝 Collaboration: *${service.isEnabled(group) ? 'aktif' : 'off'}*\nNative poll presentation: *${service.isNativePollEnabled(group) ? 'aktif' : 'off'}*\nAktifkan: ${commandContext.prefix}setcollab on`)
        },
      })

      context.commands.register({
        name: 'setcollab',
        aliases: ['collabmode'],
        description: 'Enable or disable Collaboration per group',
        category: 'collaboration',
        menuOrder: 2,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return
          const actor = actorJid(commandContext.message, whatsapp)
          const mode = commandContext.args[0]?.toLowerCase()
          if (!actor || (mode !== 'on' && mode !== 'off')) {
            await commandContext.reply(`Format: ${commandContext.prefix}setcollab <on|off>`)
            return
          }
          collaboration(commandContext).setEnabled(group, mode === 'on', actor)
          await commandContext.reply(`✅ Collaboration untuk grup ini: *${mode}*.`)
        },
      })

      context.commands.register({
        name: 'setnativepoll',
        aliases: ['pollmode'],
        description: 'Enable optional native poll presentation',
        category: 'collaboration',
        menuOrder: 3,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return
          const actor = actorJid(commandContext.message, whatsapp)
          const mode = commandContext.args[0]?.toLowerCase()
          if (!actor || (mode !== 'on' && mode !== 'off')) {
            await commandContext.reply(`Format: ${commandContext.prefix}setnativepoll <on|off>`)
            return
          }
          collaboration(commandContext).setNativePollEnabled(group, mode === 'on', actor)
          await commandContext.reply(`✅ Native poll presentation: *${mode}*. Vote resmi tetap menggunakan command ${commandContext.prefix}vote.`)
        },
      })

      context.commands.register({
        name: 'poll',
        aliases: ['jajak'],
        description: 'Create, inspect, or close a collaboration poll',
        category: 'collaboration',
        menuOrder: 4,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const service = collaboration(commandContext)
          const first = commandContext.args[0]?.toLowerCase()
          if (first === 'status') {
            const id = commandContext.args[1]
            if (!id) {
              await commandContext.reply(`Format: ${commandContext.prefix}poll status <id>`)
              return
            }
            const poll = findByPrefix(service.listPolls(group, undefined, 25), id)
            await commandContext.reply(poll ? renderPoll(poll, service.getPollResults(group, poll.id)) : 'Poll tidak ditemukan di grup ini.')
            return
          }
          if (first === 'close') {
            const id = commandContext.args[1]
            const actor = actorJid(commandContext.message, whatsapp)
            if (!id || !actor) {
              await commandContext.reply(`Format: ${commandContext.prefix}poll close <id>`)
              return
            }
            const poll = findByPrefix(service.listPolls(group, 'open', 25), id)
            if (!poll || !(await canManagePoll(commandContext, poll, actor))) {
              await commandContext.reply('Poll tidak ditemukan, sudah ditutup, atau kamu tidak memiliki izin menutupnya.')
              return
            }
            const closed = service.closePoll(group, poll.id, actor)
            await commandContext.reply(closed ? `✅ Poll ${shortId(closed.id)} ditutup.` : 'Poll berubah sebelum dapat ditutup.')
            return
          }
          const parts = normalizeText(commandContext.args).split('|').map((part) => part.trim()).filter(Boolean)
          if (parts.length < 3) {
            await commandContext.reply(pollHelp(commandContext.prefix))
            return
          }
          const actor = actorJid(commandContext.message, whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas pembuat poll tidak tersedia; poll ditolak.')
            return
          }
          const poll = service.createPoll(group, actor, parts[0], parts.slice(1))
          let transportNote = 'text fallback'
          if (service.isNativePollEnabled(group) && whatsapp.sendNativePoll) {
            const pending = service.markPollNativePending(group, poll.id, actor)
            if (pending) {
              try {
                await whatsapp.sendNativePoll(group, { name: pending.question, values: pending.options, selectableCount: pending.selectableCount })
                service.markPollNativeSent(group, pending.id, actor)
                transportNote = 'native presentation + text vote fallback'
              } catch (error) {
                service.markPollNativeFailed(group, pending.id, actor)
                transportNote = 'native unavailable; text fallback'
                context.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'native poll presentation failed')
              }
            }
          }
          await commandContext.reply(`${renderPoll(service.getPoll(poll.id) ?? poll)}\nTransport aktif: ${transportNote}`)
        },
      })

      context.commands.register({
        name: 'vote',
        description: 'Record one vote in a collaboration poll',
        category: 'collaboration',
        menuOrder: 5,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          const id = commandContext.args[0]
          const option = Number(commandContext.args[1])
          if (!actor || !id || !Number.isInteger(option)) {
            await commandContext.reply(`Format: ${commandContext.prefix}vote <poll-id> <nomor opsi>`)
            return
          }
          const service = collaboration(commandContext)
          const poll = findByPrefix(service.listPolls(group, 'open', 25), id)
          if (!poll) {
            await commandContext.reply('Poll tidak ditemukan atau sudah ditutup.')
            return
          }
          try {
            const result = service.vote(group, poll.id, actor, option - 1, commandContext.message.id)
            await commandContext.reply(result.duplicate ? 'Vote sudah tercatat sebelumnya; tidak direplay.' : `✅ Vote tercatat untuk poll ${shortId(result.poll.id)}.`)
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'Vote ditolak oleh validasi.')
          }
        },
      })

      context.commands.register({
        name: 'remind',
        aliases: ['ingatkan'],
        description: 'Schedule a persistent group reminder',
        category: 'collaboration',
        menuOrder: 6,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          const minutes = Number(commandContext.args[0])
          const text = normalizeText(commandContext.args.slice(1))
          if (!actor || !Number.isInteger(minutes) || minutes < 1 || !text) {
            await commandContext.reply(`Format: ${commandContext.prefix}remind <menit> <pesan>\nContoh: ${commandContext.prefix}remind 30 briefing scene dimulai.`)
            return
          }
          try {
            const reminder = collaboration(commandContext).createReminder(group, actor, text, Date.now() + minutes * 60_000)
            await commandContext.reply(`✅ Reminder ${shortId(reminder.id)} dibuat untuk ${new Date(reminder.dueAt).toISOString()}.`)
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'Reminder ditolak oleh validasi.')
          }
        },
      })

      context.commands.register({
        name: 'reminders',
        aliases: ['reminder'],
        description: 'List active group reminders',
        category: 'collaboration',
        menuOrder: 7,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const records = collaboration(commandContext).listReminders(group, 'scheduled')
          await commandContext.reply(records.length ? ['⏰ *Reminders*', ...records.map(renderReminder)].join('\n') : 'Belum ada reminder aktif.')
        },
      })

      context.commands.register({
        name: 'remindcancel',
        description: 'Cancel a group reminder created by you',
        category: 'collaboration',
        menuOrder: 8,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          const id = commandContext.args[0]
          if (!actor || !id) {
            await commandContext.reply(`Format: ${commandContext.prefix}remindcancel <id>`)
            return
          }
          const record = findByPrefix(collaboration(commandContext).listReminders(group, undefined, 25), id)
          const cancelled = record?.creatorJid === actor ? collaboration(commandContext).cancelReminder(group, record.id, actor) : undefined
          await commandContext.reply(cancelled ? `✅ Reminder ${shortId(cancelled.id)} dibatalkan.` : 'Reminder tidak ditemukan atau bukan milikmu.')
        },
      })

      context.commands.register({
        name: 'task',
        aliases: ['tugas'],
        description: 'Create a collaboration task',
        category: 'collaboration',
        menuOrder: 9,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          const text = normalizeText(commandContext.args)
          const assignee = commandContext.message.mentionedJids?.[0]
          if (!actor || !text) {
            await commandContext.reply(`Format: ${commandContext.prefix}task <deskripsi> [mention assignee]`)
            return
          }
          try {
            const task = collaboration(commandContext).createTask(group, actor, text, assignee)
            await commandContext.reply(`✅ Task ${shortId(task.id)} dibuat. Gunakan ${commandContext.prefix}taskdone ${shortId(task.id)} setelah selesai.`)
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'Task ditolak oleh validasi.')
          }
        },
      })

      context.commands.register({
        name: 'tasks',
        description: 'List collaboration tasks',
        category: 'collaboration',
        menuOrder: 10,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const records = collaboration(commandContext).listTasks(group, 'open')
          await commandContext.reply(records.length ? ['📋 *Tasks*', ...records.map(renderTask)].join('\n') : 'Belum ada task terbuka.')
        },
      })

      context.commands.register({
        name: 'taskdone',
        description: 'Complete your assigned or created task',
        category: 'collaboration',
        menuOrder: 11,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          const id = commandContext.args[0]
          if (!actor || !id) {
            await commandContext.reply(`Format: ${commandContext.prefix}taskdone <id>`)
            return
          }
          const record = findByPrefix(collaboration(commandContext).listTasks(group, 'open'), id)
          const completed = record ? collaboration(commandContext).completeTask(group, record.id, actor) : undefined
          await commandContext.reply(completed ? `✅ Task ${shortId(completed.id)} selesai.` : 'Task tidak ditemukan atau kamu bukan creator/assignee-nya.')
        },
      })

      context.commands.register({
        name: 'decision',
        aliases: ['putuskan'],
        description: 'Record an explicit group decision',
        category: 'collaboration',
        menuOrder: 12,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          const text = normalizeText(commandContext.args)
          if (!actor || !text) {
            await commandContext.reply(`Format: ${commandContext.prefix}decision <keputusan yang ingin dicatat>`)
            return
          }
          const decision = collaboration(commandContext).createDecision(group, actor, text)
          await commandContext.reply(`✅ Decision ${shortId(decision.id)} tercatat sebagai catatan eksplisit.`)
        },
      })

      context.commands.register({
        name: 'decisions',
        description: 'List explicit group decisions',
        category: 'collaboration',
        menuOrder: 13,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const records = collaboration(commandContext).listDecisions(group)
          await commandContext.reply(records.length ? ['📝 *Decisions*', ...records.map(renderDecision)].join('\n') : 'Belum ada decision yang tercatat.')
        },
      })

      context.commands.register({
        name: 'agenda',
        description: 'Show collaboration agenda',
        category: 'collaboration',
        menuOrder: 14,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const service = collaboration(commandContext)
          const polls = service.listPolls(group, 'open', 10)
          const reminders = service.listReminders(group, 'scheduled', 10)
          const tasks = service.listTasks(group, 'open', 10)
          await commandContext.reply([
            '🤝 *Agenda Collaboration*',
            `Poll terbuka: ${polls.length}`,
            ...polls.slice(0, 3).map((poll) => `• Poll ${shortId(poll.id)}: ${poll.question}`),
            `Reminder aktif: ${reminders.length}`,
            ...reminders.slice(0, 3).map((reminder) => `• ${renderReminder(reminder)}`),
            `Task terbuka: ${tasks.length}`,
            ...tasks.slice(0, 3).map((task) => `• ${renderTask(task)}`),
          ].join('\n'))
        },
      })

      void whatsapp
    },
  }
}
