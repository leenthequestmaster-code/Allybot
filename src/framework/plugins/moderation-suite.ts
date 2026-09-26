import { jidNormalizedUser } from '@whiskeysockets/baileys'
import { permissionNames } from '../../permissions.js'
import type {
  CommandContext,
  CoreMessage,
  Plugin,
  ServiceRegistryLike,
  WhatsAppGroupMetadata,
  WhatsAppPort,
  WhatsAppSendOptions,
} from '../contracts.js'
import { isGroupJid } from '../validation.js'
import { GroupModerationSuiteService } from '../../services/group-moderation-suite-service.js'
import { GroupConfigurationService } from '../../services/group-configuration-service.js'
import { initSqliteDatabase } from '../../storage-helpers.js'

const LINK_PATTERN = /(?:https?:\/\/|www\.)[^\s<>]+/i
const TOXIC_PATTERN = /(?:kontol|memek|jembut|anjing|bangsat|babi|pantek|itil|ngentot|bajingan|pepek|tolol|goblok|fuck|bitch|asshole|pussy)/i

function requireGroup(context: CommandContext): string | undefined {
  if (!isGroupJid(context.message.remoteJid)) {
    context.reply('Command ini cuma bisa dipakai di dalam grup ya~ 👥')
    return undefined
  }
  return context.message.remoteJid
}

function normalizePhone(jid: string): string {
  return jid.split('@')[0].split(':')[0]
}

function resolveTargetJid(context: CommandContext): string | undefined {
  if (context.message.mentionedJids && context.message.mentionedJids.length > 0) {
    return context.message.mentionedJids[0]
  }
  if (context.message.quotedSenderJid) {
    return context.message.quotedSenderJid
  }
  if (context.args[0]) {
    const raw = context.args[0].replace(/[^0-9]/g, '')
    if (raw.length >= 7) {
      return `${raw}@s.whatsapp.net`
    }
  }
  return undefined
}

function getParticipant(metadata: WhatsAppGroupMetadata, jid: string | undefined) {
  if (!jid) return undefined
  const bare = normalizePhone(jid)
  return metadata.participants.find((p) => normalizePhone(p.jid) === bare)
}

function isAdmin(metadata: WhatsAppGroupMetadata, jid: string | undefined): boolean {
  const p = getParticipant(metadata, jid)
  return p?.role === 'admin' || p?.role === 'superadmin'
}

function isGroupOwner(metadata: WhatsAppGroupMetadata, jid: string | undefined): boolean {
  if (!jid) return false
  const bare = normalizePhone(jid)
  if (metadata.ownerJid && normalizePhone(metadata.ownerJid) === bare) return true
  const p = getParticipant(metadata, jid)
  return p?.role === 'superadmin'
}

function parseDuration(input: string): { ms: number; text: string } | undefined {
  const match = input.trim().match(/^(\d+)\s*(s|m|h|d|detik|menit|jam|hari)?$/i)
  if (!match) return undefined
  const value = parseInt(match[1], 10)
  if (!Number.isFinite(value) || value <= 0) return undefined
  const unit = (match[2] ?? 'm').toLowerCase()
  if (unit === 's' || unit === 'detik') return { ms: value * 1000, text: `${value} detik` }
  if (unit === 'm' || unit === 'menit') return { ms: value * 60 * 1000, text: `${value} menit` }
  if (unit === 'h' || unit === 'jam') return { ms: value * 3600 * 1000, text: `${value} jam` }
  if (unit === 'd' || unit === 'hari') return { ms: value * 86400 * 1000, text: `${value} hari` }
  return undefined
}

function getSuiteService(services: ServiceRegistryLike): GroupModerationSuiteService {
  return services.get<GroupModerationSuiteService>('group-moderation-suite')
}

export function createModerationSuitePlugin(whatsapp: WhatsAppPort): Plugin {
  const tagCooldowns = new Map<string, number>()

  return {
    name: 'moderation-suite',
    version: '0.1.0',
    load(context) {
      // 1. /kick @user
      context.commands.register({
        name: 'kick',
        aliases: ['tendang'],
        description: 'Keluarkan member dari grup',
        category: 'moderation',
        menuOrder: 1,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const target = resolveTargetJid(commandContext)
          if (!target) {
            await commandContext.reply(`Format: ${commandContext.prefix}kick @user atau reply pesan member.`)
            return
          }

          let metadata: WhatsAppGroupMetadata
          try {
            metadata = await commandContext.whatsapp.getGroupMetadata(group)
          } catch {
            await commandContext.reply('Info grupnya lagi susah diambil nih, coba sebentar lagi ya~ 😅')
            return
          }

          const botJid = commandContext.whatsapp.userJid
          if (!isAdmin(metadata, botJid)) {
            await commandContext.reply('Jadikan bot admin dulu ya biar bisa ngeluarin member~ 👑')
            return
          }

          const actor = commandContext.message.senderJid
          if (!isAdmin(metadata, actor)) {
            await commandContext.reply('Cuma admin grup yang boleh pakai perintah ini ya~ 🛡️')
            return
          }

          if (isGroupOwner(metadata, target)) {
            await commandContext.reply('Owner grup tidak dapat dikeluarkan nih~ 👑😅')
            return
          }

          const p = getParticipant(metadata, target)
          if (!p) {
            await commandContext.reply('Orangnya udah bukan anggota grup ini lagi kok~ 👀')
            return
          }

          try {
            await commandContext.whatsapp.groupParticipantsUpdate!(group, [target], 'remove')
            await commandContext.reply(`👋 @${normalizePhone(target)} telah dikeluarkan dari grup.`, { mentions: [target] })
          } catch (error) {
            commandContext.logger.warn({ error }, 'failed to kick member')
            await commandContext.reply('Waduh, belum berhasil ngeluarin dia nih. Coba lagi ya~ 🙏')
          }
        },
      })

      // 2. /ban @user [alasan]
      context.commands.register({
        name: 'ban',
        description: 'Kick dan masukkan user ke daftar blacklist permanen grup',
        category: 'moderation',
        menuOrder: 2,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const target = resolveTargetJid(commandContext)
          if (!target) {
            await commandContext.reply(`Format: ${commandContext.prefix}ban @user [alasan]`)
            return
          }

          let metadata: WhatsAppGroupMetadata
          try {
            metadata = await commandContext.whatsapp.getGroupMetadata(group)
          } catch {
            await commandContext.reply('Info grupnya lagi susah diambil nih, coba sebentar lagi ya~ 😅')
            return
          }

          const botJid = commandContext.whatsapp.userJid
          if (!isAdmin(metadata, botJid)) {
            await commandContext.reply('Jadikan bot admin dulu ya biar bisa nge-ban member~ 👑')
            return
          }

          if (isGroupOwner(metadata, target)) {
            await commandContext.reply('Owner grup tidak dapat di-ban nih~ 👑😅')
            return
          }

          const reason = commandContext.args.slice(1).join(' ').trim() || 'Melanggar aturan grup'
          const suite = getSuiteService(commandContext.services)
          const actor = commandContext.message.senderJid ?? botJid ?? 'system'

          suite.ban(group, target, actor, reason)

          try {
            const p = getParticipant(metadata, target)
            if (p) {
              await commandContext.whatsapp.groupParticipantsUpdate!(group, [target], 'remove')
            }
            await commandContext.reply(`🔨 [BAN] @${normalizePhone(target)} dikeluarkan dan masuk daftar blacklist grup.\nAlasan: ${reason}`, { mentions: [target] })
          } catch (error) {
            commandContext.logger.warn({ error }, 'ban participant kick failed')
            await commandContext.reply(`🔨 [BAN] @${normalizePhone(target)} telah dicatat di blacklist grup.\nAlasan: ${reason}`, { mentions: [target] })
          }
        },
      })

      // 3. /unban [nomor]
      context.commands.register({
        name: 'unban',
        description: 'Hapus nomor dari daftar blacklist grup',
        category: 'moderation',
        menuOrder: 3,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return
          const input = commandContext.args[0]?.trim()
          if (!input) {
            await commandContext.reply(`Format: ${commandContext.prefix}unban <nomor|@user>`)
            return
          }

          const suite = getSuiteService(commandContext.services)
          const removed = suite.unban(group, input)
          if (removed) {
            await commandContext.reply(`✅ Nomor ${input} berhasil dihapus dari blacklist grup.`)
          } else {
            await commandContext.reply(`Nomor ${input} nggak ada di daftar blacklist grup ini kok~ 👌`)
          }
        },
      })

      // 4. /mute @user [durasi]
      context.commands.register({
        name: 'mute',
        description: 'Mute member dalam durasi tertentu (pesan dihapus otomatis)',
        category: 'moderation',
        menuOrder: 4,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const target = resolveTargetJid(commandContext)
          const rawDuration = commandContext.args[1] ?? commandContext.args[0]
          const duration = rawDuration ? parseDuration(rawDuration) : undefined

          if (!target || !duration) {
            await commandContext.reply(`Format: ${commandContext.prefix}mute @user <durasi>\nContoh: ${commandContext.prefix}mute @user 10m (10 menit), 1h (1 jam), 1d (1 hari)`)
            return
          }

          let metadata: WhatsAppGroupMetadata
          try {
            metadata = await commandContext.whatsapp.getGroupMetadata(group)
          } catch {
            await commandContext.reply('Info grupnya lagi susah diambil nih, coba sebentar lagi ya~ 😅')
            return
          }

          if (isGroupOwner(metadata, target)) {
            await commandContext.reply('Owner grup tidak dapat di-mute nih~ 👑😅')
            return
          }

          const suite = getSuiteService(commandContext.services)
          const actor = commandContext.message.senderJid ?? commandContext.whatsapp.userJid ?? 'system'
          suite.mute(group, target, actor, duration.ms)

          await commandContext.reply(`🔇 @${normalizePhone(target)} berhasil di-mute selama ${duration.text}. Setiap pesannya akan dihapus otomatis.`, { mentions: [target] })
        },
      })

      // 5. /unmute @user
      context.commands.register({
        name: 'unmute',
        description: 'Hapus status mute sebelum waktunya habis',
        category: 'moderation',
        menuOrder: 5,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const target = resolveTargetJid(commandContext)
          if (!target) {
            await commandContext.reply(`Format: ${commandContext.prefix}unmute @user`)
            return
          }

          const suite = getSuiteService(commandContext.services)
          const unmuted = suite.unmute(group, target)
          if (unmuted) {
            await commandContext.reply(`🔊 Status mute untuk @${normalizePhone(target)} telah dicabut.`, { mentions: [target] })
          } else {
            await commandContext.reply(`@${normalizePhone(target)} lagi nggak di-mute kok~ 👌`, { mentions: [target] })
          }
        },
      })

      // 6. /promote @user
      context.commands.register({
        name: 'promote',
        description: 'Jadikan member sebagai admin grup',
        category: 'moderation',
        menuOrder: 6,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const target = resolveTargetJid(commandContext)
          if (!target) {
            await commandContext.reply(`Format: ${commandContext.prefix}promote @user`)
            return
          }

          let metadata: WhatsAppGroupMetadata
          try {
            metadata = await commandContext.whatsapp.getGroupMetadata(group)
          } catch {
            await commandContext.reply('Info grupnya lagi susah diambil nih, coba sebentar lagi ya~ 😅')
            return
          }

          const botJid = commandContext.whatsapp.userJid
          if (!isAdmin(metadata, botJid)) {
            await commandContext.reply('Jadikan bot admin dulu ya biar bisa naikin admin~ 👑')
            return
          }

          if (isAdmin(metadata, target)) {
            await commandContext.reply(`@${normalizePhone(target)} kan udah jadi admin grup~ ⭐`, { mentions: [target] })
            return
          }

          try {
            await commandContext.whatsapp.groupParticipantsUpdate!(group, [target], 'promote')
            await commandContext.reply(`⭐ @${normalizePhone(target)} berhasil dipromosikan menjadi admin grup.`, { mentions: [target] })
          } catch (error) {
            commandContext.logger.warn({ error }, 'failed to promote member')
            await commandContext.reply('Waduh, belum berhasil naikin jadi admin nih. Coba lagi ya~ 🙏')
          }
        },
      })

      // 7. /demote @user
      context.commands.register({
        name: 'demote',
        description: 'Cabut status admin dari member',
        category: 'moderation',
        menuOrder: 7,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const target = resolveTargetJid(commandContext)
          if (!target) {
            await commandContext.reply(`Format: ${commandContext.prefix}demote @user`)
            return
          }

          let metadata: WhatsAppGroupMetadata
          try {
            metadata = await commandContext.whatsapp.getGroupMetadata(group)
          } catch {
            await commandContext.reply('Info grupnya lagi susah diambil nih, coba sebentar lagi ya~ 😅')
            return
          }

          const botJid = commandContext.whatsapp.userJid
          if (!isAdmin(metadata, botJid)) {
            await commandContext.reply('Jadikan bot admin dulu ya biar bisa nurunin admin~ 👑')
            return
          }

          if (isGroupOwner(metadata, target)) {
            await commandContext.reply('Owner grup tidak dapat di-demote nih~ 👑😅')
            return
          }

          if (!isAdmin(metadata, target)) {
            await commandContext.reply(`@${normalizePhone(target)} bukan admin grup kok~ 👌`, { mentions: [target] })
            return
          }

          try {
            await commandContext.whatsapp.groupParticipantsUpdate!(group, [target], 'demote')
            await commandContext.reply(`🔻 Status admin @${normalizePhone(target)} telah dicabut.`, { mentions: [target] })
          } catch (error) {
            commandContext.logger.warn({ error }, 'failed to demote member')
            await commandContext.reply('Waduh, belum berhasil nurunin admin nih. Coba lagi ya~ 🙏')
          }
        },
      })

      // 8. /tagall [pesan]
      context.commands.register({
        name: 'tagall',
        description: 'Sebut semua member grup dalam satu pesan',
        category: 'moderation',
        menuOrder: 8,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const now = Date.now()
          const lastTag = tagCooldowns.get(group) ?? 0
          if (now - lastTag < 30_000) {
            await commandContext.reply('Sabar ya, tagall ada jeda 30 detik biar nggak spam~ ⏳')
            return
          }
          tagCooldowns.set(group, now)

          let metadata: WhatsAppGroupMetadata
          try {
            metadata = await commandContext.whatsapp.getGroupMetadata(group)
          } catch {
            await commandContext.reply('Info grupnya lagi susah diambil nih, coba sebentar lagi ya~ 😅')
            return
          }

          const custom = commandContext.args.join(' ').trim()
          const participants = metadata.participants.map((p) => p.jid)
          const chunkSize = 80

          for (let i = 0; i < participants.length; i += chunkSize) {
            const chunk = participants.slice(i, i + chunkSize)
            const mentionLines = chunk.map((jid) => `@${normalizePhone(jid)}`).join(' ')
            const body = [
              '📢 *TAG ALL PANGGILAN ANGGOTA*',
              custom ? `Pesan: ${custom}\n` : '',
              mentionLines,
            ].filter(Boolean).join('\n')

            await commandContext.reply(body, { mentions: chunk })
          }
        },
      })

      // 9. /hidetag [pesan]
      context.commands.register({
        name: 'hidetag',
        description: 'Kirim notifikasi mention ke semua member tanpa menampilkan daftar teks',
        category: 'moderation',
        menuOrder: 9,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const now = Date.now()
          const lastTag = tagCooldowns.get(group) ?? 0
          if (now - lastTag < 30_000) {
            await commandContext.reply('Sabar ya, hidetag ada jeda 30 detik biar nggak spam~ ⏳')
            return
          }
          tagCooldowns.set(group, now)

          let metadata: WhatsAppGroupMetadata
          try {
            metadata = await commandContext.whatsapp.getGroupMetadata(group)
          } catch {
            await commandContext.reply('Info grupnya lagi susah diambil nih, coba sebentar lagi ya~ 😅')
            return
          }

          const custom = commandContext.args.join(' ').trim() || 'Pemberitahuan untuk semua anggota grup.'
          const participants = metadata.participants.map((p) => p.jid)

          await commandContext.reply(custom, { mentions: participants })
        },
      })

      // 10. /del (reply)
      context.commands.register({
        name: 'del',
        aliases: ['delete'],
        description: 'Hapus pesan yang di-reply',
        category: 'moderation',
        menuOrder: 10,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          if (!commandContext.message.quotedMessageId) {
            await commandContext.reply(`Balas (reply) pesan yang ingin dihapus lalu ketik ${commandContext.prefix}del.`)
            return
          }

          if (!commandContext.whatsapp.deleteMessage) {
            await commandContext.reply('Belum bisa hapus pesan saat ini nih~ 😅')
            return
          }

          try {
            await commandContext.whatsapp.deleteMessage(commandContext.message.remoteJid, {
              id: commandContext.message.quotedMessageId,
              remoteJid: commandContext.message.remoteJid,
              participant: commandContext.message.quotedSenderJid,
              fromMe: commandContext.message.quotedSenderJid === commandContext.whatsapp.userJid,
            })
            // Hapus juga pesan command-nya
            await commandContext.whatsapp.deleteMessage(commandContext.message.remoteJid, {
              id: commandContext.message.id,
              remoteJid: commandContext.message.remoteJid,
              fromMe: commandContext.message.fromMe,
            })
          } catch (error) {
            commandContext.logger.warn({ error }, 'failed to delete quoted message')
            await commandContext.reply('Waduh, pesannya nggak bisa dihapus nih. Pastiin bot udah jadi admin ya~ 🙏')
          }
        },
      })

      // 11. /clear [jumlah]
      context.commands.register({
        name: 'clear',
        description: 'Hapus N pesan terakhir dari riwayat lokal bot',
        category: 'moderation',
        menuOrder: 11,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const count = Math.min(Math.max(parseInt(commandContext.args[0] || '5', 10), 1), 30)
          if (isNaN(count)) {
            await commandContext.reply(`Format: ${commandContext.prefix}clear [jumlah (1-30)]`)
            return
          }

          if (!commandContext.whatsapp.deleteMessage) {
            await commandContext.reply('Belum bisa hapus pesan saat ini nih~ 😅')
            return
          }

          let deleted = 0
          try {
            const db = initSqliteDatabase(commandContext.config.databasePath || './data/allyssea.sqlite')
            const rows = db
              .prepare('SELECT message_id FROM messages WHERE remote_jid = ? ORDER BY timestamp DESC LIMIT ?')
              .all(group, count) as Array<{ message_id: string }>

            for (const r of rows) {
              try {
                await commandContext.whatsapp.deleteMessage(group, { id: r.message_id, remoteJid: group })
                deleted++
                await new Promise((resolve) => setTimeout(resolve, 300))
              } catch {}
            }
            await commandContext.reply(`🧹 Berhasil menghapus ${deleted} pesan dari riwayat.`)
          } catch (error) {
            commandContext.logger.warn({ error }, 'clear history messages failed')
            await commandContext.reply('Gagal membaca riwayat pesan untuk pembersihan.')
          }
        },
      })

      // 12. /lock & /unlock
      context.commands.register({
        name: 'lock',
        description: 'Kunci grup (hanya admin yang dapat mengirim pesan)',
        category: 'moderation',
        menuOrder: 12,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          if (!commandContext.whatsapp.groupSettingUpdate) {
            await commandContext.reply('Koneksi WhatsApp belum mendukung pengubahan setting grup.')
            return
          }

          try {
            await commandContext.whatsapp.groupSettingUpdate(group, 'announcement')
            await commandContext.reply('🔒 Grup telah dikunci. Sekarang hanya admin yang dapat mengirim pesan.')
          } catch (error) {
            commandContext.logger.warn({ error }, 'failed to lock group')
            await commandContext.reply('Gagal mengunci grup. Pastikan bot adalah admin.')
          }
        },
      })

      context.commands.register({
        name: 'unlock',
        description: 'Buka kunci grup (semua anggota dapat mengirim pesan)',
        category: 'moderation',
        menuOrder: 13,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          if (!commandContext.whatsapp.groupSettingUpdate) {
            await commandContext.reply('Koneksi WhatsApp belum mendukung pengubahan setting grup.')
            return
          }

          try {
            await commandContext.whatsapp.groupSettingUpdate(group, 'not_announcement')
            await commandContext.reply('🔓 Kunci grup telah dibuka. Semua anggota dapat mengirim pesan.')
          } catch (error) {
            commandContext.logger.warn({ error }, 'failed to unlock group')
            await commandContext.reply('Gagal membuka kunci grup. Pastikan bot adalah admin.')
          }
        },
      })

      // 13. /antilink on/off
      context.commands.register({
        name: 'antilink',
        description: 'Aktifkan atau nonaktifkan filter link otomatis',
        category: 'moderation',
        menuOrder: 14,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const state = commandContext.args[0]?.toLowerCase()
          if (state !== 'on' && state !== 'off') {
            await commandContext.reply(`Format: ${commandContext.prefix}antilink <on|off>`)
            return
          }

          const suite = getSuiteService(commandContext.services)
          suite.setAutomod(group, 'antilink', state === 'on')
          await commandContext.reply(`🛡️ Filter antilink sekarang: *${state.toUpperCase()}*.`)
        },
      })

      // 14. /antispam on/off
      context.commands.register({
        name: 'antispam',
        description: 'Aktifkan atau nonaktifkan filter anti-spam otomatis',
        category: 'moderation',
        menuOrder: 15,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const state = commandContext.args[0]?.toLowerCase()
          if (state !== 'on' && state !== 'off') {
            await commandContext.reply(`Format: ${commandContext.prefix}antispam <on|off>`)
            return
          }

          const suite = getSuiteService(commandContext.services)
          suite.setAutomod(group, 'antispam', state === 'on')
          await commandContext.reply(`🛡️ Filter antispam sekarang: *${state.toUpperCase()}*.`)
        },
      })

      // 15. /antitoxic on/off
      context.commands.register({
        name: 'antitoxic',
        description: 'Aktifkan atau nonaktifkan filter kata kasar otomatis',
        category: 'moderation',
        menuOrder: 16,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const state = commandContext.args[0]?.toLowerCase()
          if (state !== 'on' && state !== 'off') {
            await commandContext.reply(`Format: ${commandContext.prefix}antitoxic <on|off>`)
            return
          }

          const suite = getSuiteService(commandContext.services)
          suite.setAutomod(group, 'antitoxic', state === 'on')
          await commandContext.reply(`🛡️ Filter antitoxic sekarang: *${state.toUpperCase()}*.`)
        },
      })

      // 16. /setlimit [jumlah]
      context.commands.register({
        name: 'setlimit',
        description: 'Ubah ambang batas warning sebelum auto-kick',
        category: 'moderation',
        menuOrder: 17,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const limit = parseInt(commandContext.args[0] ?? '', 10)
          if (!Number.isInteger(limit) || limit <= 0) {
            await commandContext.reply(`Format: ${commandContext.prefix}setlimit <jumlah>\nJumlah harus angka positif lebih dari 0.`)
            return
          }

          const suite = getSuiteService(commandContext.services)
          suite.setWarnLimit(group, limit)
          await commandContext.reply(`⚙️ Batas warning sebelum auto-kick diatur menjadi *${limit}* kali.`)
        },
      })

      // 17. /welcome on/off [pesan]
      context.commands.register({
        name: 'welcome',
        description: 'Aktif/nonaktifkan pesan sambutan member masuk',
        category: 'moderation',
        menuOrder: 18,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const state = commandContext.args[0]?.toLowerCase()
          if (state !== 'on' && state !== 'off') {
            await commandContext.reply(`Format: ${commandContext.prefix}welcome <on|off> [pesan kustom]`)
            return
          }

          const suite = getSuiteService(commandContext.services)
          suite.setWelcomeToggle(group, state === 'on')

          const custom = commandContext.args.slice(1).join(' ').trim()
          if (state === 'on' && custom) {
            const config = commandContext.services.get<GroupConfigurationService>('group-configuration')
            config.setWelcome(group, custom, commandContext.message.senderJid ?? 'admin')
          }

          await commandContext.reply(`🌸 Pesan welcome grup sekarang: *${state.toUpperCase()}*${custom ? ' (template kustom tersimpan)' : ''}.`)
        },
      })

      // 18. /left on/off [pesan]
      context.commands.register({
        name: 'left',
        aliases: ['leave'],
        description: 'Aktif/nonaktifkan pesan perpisahan member keluar',
        category: 'moderation',
        menuOrder: 19,
        permission: permissionNames.groupAdmin,
        handler: async (commandContext) => {
          const group = requireGroup(commandContext)
          if (!group) return

          const state = commandContext.args[0]?.toLowerCase()
          if (state !== 'on' && state !== 'off') {
            await commandContext.reply(`Format: ${commandContext.prefix}left <on|off> [pesan kustom]`)
            return
          }

          const suite = getSuiteService(commandContext.services)
          suite.setLeaveToggle(group, state === 'on')

          const custom = commandContext.args.slice(1).join(' ').trim()
          if (state === 'on' && custom) {
            const config = commandContext.services.get<GroupConfigurationService>('group-configuration')
            config.setLeave(group, custom, commandContext.message.senderJid ?? 'admin')
          }

          await commandContext.reply(`🍂 Pesan leave grup sekarang: *${state.toUpperCase()}*${custom ? ' (template kustom tersimpan)' : ''}.`)
        },
      })

      // 19. /info [@user]
      context.commands.register({
        name: 'info',
        description: 'Lihat info profil pengguna (nama, nomor, role)',
        category: 'group',
        menuOrder: 25,
        handler: async (commandContext) => {
          const target = resolveTargetJid(commandContext) ?? commandContext.message.senderJid
          if (!target) {
            await commandContext.reply('Target pengguna tidak ditemukan.')
            return
          }

          const phone = normalizePhone(target)
          let role = 'Member'

          if (isGroupJid(commandContext.message.remoteJid)) {
            try {
              const metadata = await commandContext.whatsapp.getGroupMetadata(commandContext.message.remoteJid)
              const p = getParticipant(metadata, target)
              if (p?.role === 'superadmin') role = 'Owner Grup'
              else if (p?.role === 'admin') role = 'Admin Grup'
            } catch {}
          }

          await commandContext.reply([
            '𓏼 *`𝐈𝗻𝗳𝗼𝗿𝗺𝗮𝘀𝗶 𝐏𝗲𝗻𝗴𝗴𝘂𝗻𝗮`*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ *Nomor* : +${phone}`,
            `⡇╌ *Role*  : ${role}`,
            `⡇╌ *JID*   : ${target}`,
            '━━━━━━━━━━━━━━━━━━━━',
            '*© Allyssea Roleplay Community*',
          ].join('\n'))
        },
      })

      // 20. /tagme
      context.commands.register({
        name: 'tagme',
        description: 'Sebut diri sendiri di chat grup',
        category: 'group',
        menuOrder: 26,
        handler: async (commandContext) => {
          const sender = commandContext.message.senderJid
          if (!sender) return
          const phone = normalizePhone(sender)
          await commandContext.reply(`Halo @${phone}!`, { mentions: [sender] })
        },
      })

      // --- Inbound Event Listeners ---
      // 1. Blacklist auto-kick on join
      context.events.on('group.participants.changed', async (event) => {
        if (event.action !== 'add') return
        const suite = getSuiteService(context.services)

        for (const jid of event.participantJids) {
          if (suite.isBanned(event.groupJid, jid)) {
            try {
              if (whatsapp.groupParticipantsUpdate) {
                await whatsapp.groupParticipantsUpdate(event.groupJid, [jid], 'remove')
              }
              const phone = normalizePhone(jid)
              await whatsapp.sendText(
                event.groupJid,
                `🔨 [BLACKLIST] @${phone} terdaftar di blacklist permanen grup ini dan otomatis dikeluarkan.`,
                { mentions: [jid] },
              )
            } catch (err) {
              context.logger.warn({ err, jid }, 'failed to auto-kick banned participant')
            }
          }
        }
      })

      // 2. Inbound Message Filters: Mute, Antilink, Antispam, Antitoxic
      context.events.on('message.received', async (message: CoreMessage) => {
        const group = message.remoteJid
        if (!isGroupJid(group) || message.fromMe || !message.senderJid) return

        const suite = getSuiteService(context.services)
        const sender = message.senderJid
        const text = message.text?.trim()

        // Cek Mute
        if (suite.isMuted(group, sender)) {
          if (whatsapp.deleteMessage) {
            try {
              await whatsapp.deleteMessage(group, {
                id: message.id,
                remoteJid: group,
                participant: sender,
                fromMe: false,
              })
            } catch {}
          }
          return
        }

        // Cek automod settings dulu (SQLite lookup cepat)
        const automod = suite.getAutomod(group)
        if (!automod.antispam && !automod.antilink && !automod.antitoxic) return

        const isSpam = automod.antispam ? suite.checkAndRecordSpam(group, sender, 5, 5000) : false
        const isLink = automod.antilink && text ? LINK_PATTERN.test(text) : false
        const isToxic = automod.antitoxic && text ? TOXIC_PATTERN.test(text) : false

        if (!isSpam && !isLink && !isToxic) return

        // Jika ada potensi pelanggaran, baru periksa apakah sender adalah admin
        let senderIsAdmin = false
        try {
          const metadata = await whatsapp.getGroupMetadata(group)
          senderIsAdmin = isAdmin(metadata, sender)
        } catch {}

        if (senderIsAdmin) return

        // Cek Antispam
        if (isSpam) {
          suite.mute(group, sender, whatsapp.userJid ?? 'system', 5 * 60 * 1000)
          if (whatsapp.deleteMessage) {
            try {
              await whatsapp.deleteMessage(group, { id: message.id, remoteJid: group, participant: sender })
            } catch {}
          }
          const phone = normalizePhone(sender)
          await whatsapp.sendText(
            group,
            `⚠️ @${phone} terdeteksi mengirim pesan terlalu cepat (spam) dan di-mute otomatis selama 5 menit.`,
            { mentions: [sender] },
          )
          return
        }

        // Cek Antilink
        if (isLink) {
          let isWhitelisted = false
          try {
            const inviteLink = await whatsapp.getGroupInviteLink(group)
            if (inviteLink && text && text.includes(inviteLink)) isWhitelisted = true
          } catch {}

          if (!isWhitelisted) {
            if (whatsapp.deleteMessage) {
              try {
                await whatsapp.deleteMessage(group, { id: message.id, remoteJid: group, participant: sender })
              } catch {}
            }
            const phone = normalizePhone(sender)
            await whatsapp.sendText(
              group,
              `⚠️ Dilarang mengirim tautan/link di grup ini, @${phone}. Pesanmu telah dihapus.`,
              { mentions: [sender] },
            )
            return
          }
        }

        // Cek Antitoxic
        if (isToxic) {
          try {
            if (whatsapp.deleteMessage) {
              await whatsapp.deleteMessage(group, { id: message.id, remoteJid: group, participant: sender })
            }
          } catch {}
          return
        }
      })
    },
  }
}
