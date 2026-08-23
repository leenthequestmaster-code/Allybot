import type { CommandContext, CoreMessage, Plugin, WhatsAppPort } from '../contracts.js'
import { isGroupJid } from '../../platform/validation.js'
import { CharacterService, type CharacterRecord } from '../../services/character-service.js'

function characterService(context: CommandContext): CharacterService {
  return context.services.get<CharacterService>('character')
}

function groupJid(message: CoreMessage): string | undefined {
  return isGroupJid(message.remoteJid) ? message.remoteJid : undefined
}

function actorJid(message: CoreMessage, whatsapp: WhatsAppPort): string | undefined {
  return message.senderJid ?? whatsapp.userJid
}

function shortId(id: string): string {
  return id.slice(0, 8)
}

function displayText(value: string, maxLength: number): string {
  return value.replace(/[\\`*_~]/g, '').slice(0, maxLength)
}

function help(prefix: string): string {
  return [
    '🎭 *Character*',
    '',
    `• ${prefix}character create <nama> | <deskripsi> — buat character`,
    `• ${prefix}character view [id] — lihat character milikmu atau id tertentu`,
    `• ${prefix}character list — lihat character aktif di grup`,
    `• ${prefix}character edit <id> <nama> | <deskripsi> — ubah character milikmu`,
    `• ${prefix}character delete <id> — arsipkan character milikmu`,
    `• ${prefix}mood <suasana> — simpan mood character aktif`,
    '',
    `Contoh: ${prefix}character create Aruna | Penjaga mercusuar yang tenang.`,
  ].join('\n')
}

function renderCharacter(record: CharacterRecord): string {
  return [
    `🎭 *Character ${shortId(record.id)}*`,
    `Nama: ${displayText(record.name, 60)}`,
    `Deskripsi: ${displayText(record.profile || 'Belum ada deskripsi.', 500)}`,
    `Mood: ${record.mood ? displayText(record.mood, 40) : 'belum diatur'}`,
    `Status: ${record.status}`,
    `Revision: ${record.revision}`,
    '',
    `Edit: !character edit ${shortId(record.id)} <nama> | <deskripsi>`,
  ].join('\n')
}

function renderList(records: readonly CharacterRecord[], prefix: string): string {
  if (records.length === 0) return `Belum ada character aktif di grup ini. Buat dengan ${prefix}character create <nama> | <deskripsi>.`
  return [
    '🎭 *Character aktif di grup*',
    '',
    ...records.map((record) => `• ${shortId(record.id)} — ${displayText(record.name, 60)}${record.mood ? ` · mood: ${displayText(record.mood, 40)}` : ''}`),
    '',
    `Lihat detail: ${prefix}character view <id>`,
  ].join('\n')
}

function splitProfile(args: readonly string[]): { name?: string; profile: string } {
  const raw = args.join(' ').trim()
  const separator = raw.indexOf('|')
  if (separator < 0) return { name: raw, profile: '' }
  return { name: raw.slice(0, separator).trim(), profile: raw.slice(separator + 1).trim() }
}

export function createCharacterPlugin(_whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'character',
    version: '0.1.0',
    load(context) {
      context.commands.register({
        name: 'character',
        aliases: ['char'],
        description: 'Buat dan kelola character roleplay sosial',
        category: 'roleplay',
        menuOrder: 20,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) {
            await commandContext.reply('Command character hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas pengguna tidak tersedia; character ditolak.')
            return
          }

          const service = characterService(commandContext)
          const action = commandContext.args[0]?.toLowerCase() ?? 'view'
          try {
            if (action === 'create') {
              const payload = splitProfile(commandContext.args.slice(1))
              if (!payload.name) {
                await commandContext.reply(help(commandContext.prefix))
                return
              }
              const record = service.create(group, actor, payload.name, payload.profile)
              await commandContext.reply(`✅ Character *${displayText(record.name, 60)}* dibuat. ID: \`${shortId(record.id)}\`.\nGunakan ${commandContext.prefix}character view ${shortId(record.id)} untuk melihatnya.`)
              return
            }

            if (action === 'view') {
              const reference = commandContext.args[1]
              const record = reference ? service.findVisible(group, reference) : service.getOwnActive(group, actor)
              await commandContext.reply(record ? renderCharacter(record) : `Character belum ditemukan. Buat dengan ${commandContext.prefix}character create <nama> | <deskripsi>.`)
              return
            }

            if (action === 'list') {
              await commandContext.reply(renderList(service.listVisible(group), commandContext.prefix))
              return
            }

            if (action === 'edit') {
              const reference = commandContext.args[1]
              const payload = splitProfile(commandContext.args.slice(2))
              if (!reference || !payload.name) {
                await commandContext.reply(help(commandContext.prefix))
                return
              }
              const record = service.update(group, actor, reference, payload.name, payload.profile)
              await commandContext.reply(`✅ Character ${shortId(record.id)} diperbarui pada revision ${record.revision}.`)
              return
            }

            if (action === 'delete' || action === 'retire') {
              const reference = commandContext.args[1]
              if (!reference) {
                await commandContext.reply(`Format: ${commandContext.prefix}character delete <id>`)
                return
              }
              service.retire(group, actor, reference)
              await commandContext.reply(`✅ Character ${reference.slice(0, 8)} diarsipkan. Riwayat tidak dihapus dari audit/storage.`)
              return
            }

            await commandContext.reply(help(commandContext.prefix))
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'Character ditolak oleh validasi.')
          }
        },
      })

      context.commands.register({
        name: 'mood',
        description: 'Atur mood character aktif',
        category: 'roleplay',
        menuOrder: 21,
        handler: async (commandContext) => {
          const group = groupJid(commandContext.message)
          if (!group) {
            await commandContext.reply('Command mood hanya dapat digunakan di dalam grup WhatsApp.')
            return
          }
          const actor = actorJid(commandContext.message, commandContext.whatsapp)
          if (!actor) {
            await commandContext.reply('Identitas pengguna tidak tersedia; mood ditolak.')
            return
          }
          const mood = commandContext.args.join(' ').trim()
          if (!mood) {
            await commandContext.reply(`Format: ${commandContext.prefix}mood <suasana> atau ${commandContext.prefix}mood off`)
            return
          }
          try {
            const record = characterService(commandContext).setMood(group, actor, mood)
            await commandContext.reply(record.mood ? `✅ Mood character *${displayText(record.mood, 40)}*.` : '✅ Mood character dihapus.')
          } catch (error) {
            await commandContext.reply(error instanceof Error ? error.message : 'Mood ditolak oleh validasi.')
          }
        },
      })
    },
  }
}

export default createCharacterPlugin
