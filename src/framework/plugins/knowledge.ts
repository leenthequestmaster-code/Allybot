import type { CommandContext, CoreMessage, Plugin, ServiceRegistryLike, WhatsAppPort } from '../../framework/contracts.js'
import { permissionNames } from '../../permissions.js'
import { KnowledgeService, type KnowledgeRecord } from '../../services/knowledge-service.js'

function groupJid(message: CoreMessage): string | undefined {
  return message.remoteJid.endsWith('@g.us') ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function knowledge(context: { services: ServiceRegistryLike }): KnowledgeService {
  return context.services.get<KnowledgeService>('knowledge')
}

function requireGroup(context: CommandContext): string | undefined {
  const group = groupJid(context.message)
  if (!group) void context.reply('Command Knowledge ini hanya dapat digunakan di dalam grup WhatsApp.')
  return group
}

function requireEnabled(context: CommandContext, group: string): boolean {
  if (knowledge(context).isEnabled(group)) return true
  void context.reply(`Fitur Knowledge belum aktif untuk grup ini. Admin dapat mengaktifkannya dengan ${context.prefix}setknowledge on.`)
  return false
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function normalizeTitle(args: readonly string[]): { title?: string; visibility: 'group' | 'private' } {
  const values = [...args]
  let visibility: 'group' | 'private' = 'group'
  const privateIndex = values.findIndex((value) => value.toLowerCase() === 'private')
  if (privateIndex >= 0) {
    visibility = 'private'
    values.splice(privateIndex, 1)
  }
  const title = values.join(' ').trim()
  return title ? { title, visibility } : { visibility }
}

function renderRecord(record: KnowledgeRecord): string {
  return [
    `🔖 *Source ${shortId(record.id)}*`,
    `Judul: ${record.title}`,
    `Scope: ${record.visibility}`,
    `Status: ${record.status}`,
    `Isi eksplisit: ${record.excerpt}`,
    `Dibuat: ${new Date(record.createdAt).toISOString()}`,
    `Retensi sampai: ${new Date(record.retentionUntil).toISOString()}`,
    `Hash source: ${record.sourceMessageHash ?? 'tidak tersedia pada CoreMessage'}`,
  ].join('\n')
}

function renderList(records: readonly KnowledgeRecord[]): string {
  return records.length
    ? ['🔖 *Bookmarks*', ...records.map((record) => `• ${shortId(record.id)} — ${record.title} [${record.visibility}]`)].join('\n')
    : 'Belum ada bookmark aktif yang terlihat pada scope ini.'
}

function exportText(records: readonly KnowledgeRecord[]): string {
  return records.length
    ? ['# Allybot Knowledge Export', '', ...records.map((record) => `## ${record.title} [${shortId(record.id)}]\n${record.excerpt}`)].join('\n\n')
    : 'Knowledge export kosong untuk scope ini.'
}

export function createKnowledgePlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'knowledge',
    version: '0.1.0',
    load(context) {
      context.commands.register({
        name: 'knowledge',
        aliases: ['know'],
        description: 'Show explicit knowledge status',
        category: 'knowledge',
        menuOrder: 1,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return
          const enabled = knowledge(commandContext).isEnabled(group)
          await commandContext.reply(`📚 Knowledge: *${enabled ? 'aktif' : 'off'}*\nSumber hanya disimpan melalui reply/bookmark eksplisit.\nAktifkan: ${commandContext.prefix}setknowledge on`)
        },
      })

      context.commands.register({
        name: 'setknowledge',
        description: 'Enable or disable explicit knowledge capture',
        category: 'knowledge',
        menuOrder: 2,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return
          const actor = actorJid(commandContext.message, whatsapp)
          const mode = commandContext.args[0]?.toLowerCase()
          if (!actor || (mode !== 'on' && mode !== 'off')) {
            await commandContext.reply(`Format: ${commandContext.prefix}setknowledge <on|off>`)
            return
          }
          knowledge(commandContext).setEnabled(group, mode === 'on', actor)
          await commandContext.reply(`✅ Knowledge eksplisit untuk grup ini: *${mode}*.`)
        },
      })

      context.commands.register({
        name: 'quote',
        description: 'Show explicitly quoted message text without saving it',
        category: 'knowledge',
        menuOrder: 3,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const quoted = commandContext.message.quotedText?.trim()
          if (!quoted) {
            await commandContext.reply(`Reply pesan yang ingin ditampilkan, lalu ketik ${commandContext.prefix}quote. Command ini tidak menyimpan pesan.`)
            return
          }
          const excerpt = quoted.length > 2_000 ? `${quoted.slice(0, 1_997)}...` : quoted
          await commandContext.reply(`💬 *Quote eksplisit*\n${excerpt}`)
        },
      })

      context.commands.register({
        name: 'bookmark',
        description: 'Bookmark an explicitly quoted message as a bounded source',
        category: 'knowledge',
        menuOrder: 4,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          const quoted = commandContext.message.quotedText?.trim()
          if (!actor || !quoted) {
            await commandContext.reply(`Reply pesan sumber lalu ketik ${commandContext.prefix}bookmark <judul> [private]. Tidak ada passive capture.`)
            return
          }
          const metadata = normalizeTitle(commandContext.args)
          try {
            const record = knowledge(commandContext).createBookmark({
              groupJid: group,
              creatorJid: actor,
              title: metadata.title,
              excerpt: quoted,
              visibility: metadata.visibility,
              sourceSenderJid: commandContext.message.quotedSenderJid,
            })
            await commandContext.reply(`✅ Bookmark ${shortId(record.id)} disimpan sebagai source *${record.title}* dengan scope *${record.visibility}*.\nGunakan ${commandContext.prefix}source ${shortId(record.id)} untuk melihatnya.`)
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'Bookmark ditolak oleh validasi.')
          }
        },
      })

      context.commands.register({
        name: 'bookmarks',
        description: 'List explicit bookmarks visible in the group',
        category: 'knowledge',
        menuOrder: 5,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas pembaca tidak tersedia; daftar source ditolak.')
            return
          }
          await commandContext.reply(renderList(knowledge(commandContext).listSources(group, actor)))
        },
      })

      context.commands.register({
        name: 'source',
        aliases: ['sourceinfo'],
        description: 'Read one explicit source by short id',
        category: 'knowledge',
        menuOrder: 6,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          const id = commandContext.args[0]
          if (!actor || !id) {
            await commandContext.reply(`Format: ${commandContext.prefix}source <id>`)
            return
          }
          const record = knowledge(commandContext).findSource(group, id, actor)
          await commandContext.reply(record ? renderRecord(record) : 'Source tidak ditemukan, sudah retired, atau tidak terlihat pada scope kamu.')
        },
      })

      context.commands.register({
        name: 'forget',
        aliases: ['knowledgeforget'],
        description: 'Delete your explicit source record',
        category: 'knowledge',
        menuOrder: 7,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          const id = commandContext.args[0]
          if (!actor || !id) {
            await commandContext.reply(`Format: ${commandContext.prefix}forget <id>`)
            return
          }
          const deleted = knowledge(commandContext).deleteSource(group, id, actor)
          await commandContext.reply(deleted ? `✅ Source ${shortId(deleted.id)} dihapus dari hot record.` : 'Source tidak ditemukan atau bukan milikmu.')
        },
      })

      context.commands.register({
        name: 'knowledgeexport',
        aliases: ['knowexport'],
        description: 'Export visible explicit knowledge records',
        category: 'knowledge',
        menuOrder: 8,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas export tidak tersedia; export ditolak.')
            return
          }
          const records = knowledge(commandContext).exportSources(group, actor)
          await commandContext.reply(exportText(records))
        },
      })
    },
  }
}
