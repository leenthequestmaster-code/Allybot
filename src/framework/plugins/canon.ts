import type { CommandContext, CoreMessage, Plugin, ServiceRegistryLike, WhatsAppPort } from '../../framework/contracts.js'
import { permissionNames } from '../../permissions.js'
import { CanonService, type CanonRecord } from '../../services/canon-service.js'

function groupJid(message: CoreMessage): string | undefined {
  return message.remoteJid.endsWith('@g.us') ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function canon(context: { services: ServiceRegistryLike }): CanonService {
  return context.services.get<CanonService>('canon')
}

function requireGroup(context: CommandContext): string | undefined {
  const group = groupJid(context.message)
  if (!group) void context.reply('Command Canon hanya dapat digunakan di dalam grup WhatsApp.')
  return group
}

function requireEnabled(context: CommandContext, group: string): boolean {
  if (canon(context).isEnabled(group)) return true
  void context.reply(`Fitur Canon belum aktif untuk grup ini. Admin dapat mengaktifkannya dengan ${context.prefix}setcanon on.`)
  return false
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function renderRecord(record: CanonRecord): string {
  return [
    `📜 *Canon ${shortId(record.id)}*`,
    `Judul: ${record.title}`,
    `Status: ${record.status}`,
    `Revision: ${record.revision}`,
    `Isi: ${record.content}`,
    `Source reference: ${record.sourceId ? shortId(record.sourceId) : 'tidak ada'}`,
    `Updated: ${new Date(record.updatedAt).toISOString()}`,
  ].join('\n')
}

function renderList(records: readonly CanonRecord[]): string {
  return records.length
    ? ['📜 *Canon visible*', ...records.map((record) => `• ${shortId(record.id)} — ${record.title} [${record.status}]`)].join('\n')
    : 'Belum ada canon yang terlihat pada scope kamu.'
}

function help(prefix: string): string {
  return [
    `${prefix}canon`,
    `${prefix}canon add <judul> :: <isi> [source=<id>]`,
    `${prefix}canon propose <id>`,
    `${prefix}canon approve|reject|retire <id>`,
    `${prefix}canon search <kata kunci>`,
    `${prefix}canon history <id>`,
    `${prefix}lore`,
    `Aktifkan admin: ${prefix}setcanon on|off`,
    'Draft/proposed tidak tampil pada lookup anggota lain; approved conflict ditandai sebagai uncertainty.',
  ].join('\n')
}

function parseAdd(args: readonly string[]): { title: string; content: string; sourceId?: string } {
  const raw = args.join(' ').trim()
  const separator = raw.indexOf('::')
  if (separator < 1) throw new Error('Format: !canon add <judul> :: <isi> [source=<id>]')
  const title = raw.slice(0, separator).trim()
  let content = raw.slice(separator + 2).trim()
  let sourceId: string | undefined
  const sourceMatch = content.match(/(?:^|\s)source=([a-f0-9-]+)$/i)
  if (sourceMatch) {
    sourceId = sourceMatch[1]
    content = content.slice(0, sourceMatch.index).trim()
  }
  if (!title || !content) throw new Error('Judul dan isi canon harus diisi')
  return { title, content, ...(sourceId ? { sourceId } : {}) }
}

async function isGroupAdmin(context: CommandContext, group: string, actor: string): Promise<boolean> {
  try {
    const metadata = await context.whatsapp.getGroupMetadata(group)
    const normalized = actor.split(':')[0]
    const participant = metadata.participants.find((candidate) => candidate.jid.split(':')[0] === normalized)
    return participant?.role === 'admin' || participant?.role === 'superadmin'
  } catch {
    return false
  }
}

export function createCanonPlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'canon',
    version: '0.1.0',
    load(context) {
      context.commands.register({
        name: 'canon',
        description: 'Manage bounded community canon',
        category: 'roleplay',
        menuOrder: 7,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas pengguna tidak tersedia; command Canon ditolak.')
            return
          }
          const action = commandContext.args[0]?.toLowerCase()
          if (!action) {
            await commandContext.reply(renderList(canon(commandContext).listVisible(group, actor)))
            return
          }
          try {
            const service = canon(commandContext)
            if (action === 'add') {
              const created = service.addCanon({ groupJid: group, creatorJid: actor, ...parseAdd(commandContext.args.slice(1)) })
              await commandContext.reply(`✅ Draft canon dibuat.\n${renderRecord(created)}\nGunakan ${commandContext.prefix}canon propose ${shortId(created.id)} setelah ditinjau.`)
            } else if (action === 'propose') {
              const updated = service.propose(group, commandContext.args[1] ?? '', actor)
              await commandContext.reply(`✅ Draft diajukan untuk review.\n${renderRecord(updated)}`)
            } else if (action === 'approve' || action === 'reject' || action === 'retire') {
              if (!(await isGroupAdmin(commandContext, group, actor))) {
                await commandContext.reply('Action Canon ini hanya dapat dilakukan oleh admin grup.')
                return
              }
              const updated = action === 'approve'
                ? service.approve(group, commandContext.args[1] ?? '', actor)
                : action === 'reject'
                  ? service.reject(group, commandContext.args[1] ?? '', actor)
                  : service.retire(group, commandContext.args[1] ?? '', actor)
              await commandContext.reply(`✅ Canon diperbarui.\n${renderRecord(updated)}`)
            } else if (action === 'search') {
              const result = service.search(group, actor, commandContext.args.slice(1).join(' '))
              const marker = result.uncertainty === 'none' ? '' : '\n⚠️ UNCERTAINTY: terdapat approved records dengan judul sama dan isi berbeda; bot tidak memilih salah satunya otomatis.'
              await commandContext.reply(`${renderList(result.records)}${marker}`)
            } else if (action === 'history') {
              const history = service.history(group, commandContext.args[1] ?? '', actor)
              await commandContext.reply(history.length ? ['📚 *Canon history*', ...history.map((entry) => `• r${entry.revision} ${entry.action} → ${entry.toStatus} (${new Date(entry.createdAt).toISOString()})`)].join('\n') : 'History tidak ditemukan atau tidak terlihat pada scope kamu.')
            } else {
              await commandContext.reply(help(commandContext.prefix))
            }
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'Operasi Canon ditolak oleh validasi.')
          }
        },
      })

      context.commands.register({
        name: 'setcanon',
        description: 'Enable or disable Canon per group',
        category: 'roleplay',
        menuOrder: 8,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return
          const actor = actorJid(commandContext.message, whatsapp)
          const mode = commandContext.args[0]?.toLowerCase()
          if (!actor || (mode !== 'on' && mode !== 'off')) {
            await commandContext.reply(`Format: ${commandContext.prefix}setcanon <on|off>`)
            return
          }
          canon(commandContext).setEnabled(group, mode === 'on', actor)
          await commandContext.reply(`✅ Canon untuk grup ini: *${mode}*.`)
        },
      })

      context.commands.register({
        name: 'lore',
        description: 'Show approved lore/canon entries',
        category: 'roleplay',
        menuOrder: 9,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group || !requireEnabled(commandContext, group)) return
          const actor = actorJid(commandContext.message, whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas pengguna tidak tersedia; lore ditolak.')
            return
          }
          await commandContext.reply(renderList(canon(commandContext).listVisible(group, actor).filter((record) => record.status === 'approved')))
        },
      })
    },
  }
}
