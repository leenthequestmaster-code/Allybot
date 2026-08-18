import type {
  CommandContext,
  Plugin,
  WhatsAppGroupMetadata,
  WhatsAppGroupParticipant,
} from '../contracts.js'
import { permissionNames } from '../../permissions.js'
import {
  GroupConfigurationService,
  MAX_GROUP_MESSAGE_LENGTH,
  MAX_GROUP_RULES_LENGTH,
  SUPPORTED_GROUP_LANGUAGES,
  isValidGroupTimezone,
} from '../../services/group-configuration-service.js'

const PAGE_SIZE = 25

function userLabel(jid: string): string {
  const user = jid.split('@')[0]?.split(':')[0] ?? jid
  return `@${user}`
}

function mentionOptions(jids: readonly string[]) {
  const mentions = [...new Set(jids)]
  return mentions.length > 0 ? { mentions } : undefined
}

function isGroup(context: CommandContext): boolean {
  return context.message.remoteJid.endsWith('@g.us')
}

async function requireGroup(context: CommandContext): Promise<boolean> {
  if (isGroup(context)) return true
  await context.reply('Command ini hanya dapat digunakan di dalam grup WhatsApp.')
  return false
}

function participantRoleLabel(role: WhatsAppGroupParticipant['role']): string {
  if (role === 'superadmin') return 'Creator'
  if (role === 'admin') return 'Admin'
  return 'Member'
}

function bareJid(jid: string): string {
  return jid.split(':')[0] ?? jid
}

function isBotOwner(context: CommandContext, jid: string | undefined): boolean {
  if (!context.config.botOwnerJid || !jid) return false
  return bareJid(context.config.botOwnerJid) === bareJid(jid)
}

function roleLabel(context: CommandContext, participant: WhatsAppGroupParticipant): string {
  return isBotOwner(context, participant.jid) ? 'Bot Owner' : participantRoleLabel(participant.role)
}

function findParticipant(metadata: WhatsAppGroupMetadata, jid: string | undefined): WhatsAppGroupParticipant | undefined {
  if (!jid) return undefined
  const normalized = jid.split(':')[0]
  return metadata.participants.find((participant) => participant.jid.split(':')[0] === normalized)
}

function groupConfiguration(context: CommandContext): GroupConfigurationService {
  return context.services.get<GroupConfigurationService>('group-configuration')
}

function updateActor(context: CommandContext): string {
  return context.message.senderJid ?? context.whatsapp.userJid ?? 'unknown'
}

function renderHeader(title: string): string[] {
  return [
    '𖥦 ׂׅ─── ꫶֗ ୨ 👥 ୧ ꫶֗ ───ׂׅ',
    `⿴⃟۪۪⃕᎒⃟ *${title}* ꕤꪆ`,
    '᠂᠂᠂ ───┈ ⸼ ⚝ ⸼ ┈─── ᠂᠂᠂',
  ]
}

function renderFooter(): string[] {
  return ['━━━━━━━━━━━━━━━━━━━━', '*© Allyssea Roleplay Community*']
}

function parseHistoryLimit(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 10
  return Math.min(Math.max(Number(value), 1), 10)
}

function historyPreview(value: string): string {
  return value.length > 300 ? `${value.slice(0, 297)}...` : value
}

function formatHistoryTime(timestamp: number, timezone: string, language: 'id' | 'en'): string {
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'id-ID', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(timestamp))
}

function renderGroupInfo(metadata: WhatsAppGroupMetadata, botJid?: string): string {
  const adminCount = metadata.participants.filter((participant) => participant.role === 'admin' || participant.role === 'superadmin').length
  const bot = findParticipant(metadata, botJid)
  return [
    ...renderHeader('𝐆𝗿𝗼𝘂𝗽 𝐈𝗻𝗳𝗼'),
    '',
    `↳ *Nama* : ${metadata.subject}`,
    `↳ *Group ID* : ${metadata.jid}`,
    `↳ *Member* : ${metadata.participants.length} orang`,
    `↳ *Admin* : ${adminCount} orang`,
    `↳ *Status Bot* : ${bot ? participantRoleLabel(bot.role) : 'Tidak terdeteksi'}`,
    ...(metadata.ownerJid ? [`↳ *Creator* : ${userLabel(metadata.ownerJid)}`] : []),
    ...(metadata.description ? ['', `↳ *Deskripsi* : ${metadata.description}`] : []),
    '',
    ...renderFooter(),
  ].join('\n')
}

function renderParticipantList(
  metadata: WhatsAppGroupMetadata,
  participants: readonly WhatsAppGroupParticipant[],
  title: string,
  nextCommand: 'admins' | 'members',
  page: number,
  prefix: string,
): { text: string; mentions: readonly string[] } {
  const totalPages = Math.max(1, Math.ceil(participants.length / PAGE_SIZE))
  const currentPage = Math.min(Math.max(page, 1), totalPages)
  const start = (currentPage - 1) * PAGE_SIZE
  const visible = participants.slice(start, start + PAGE_SIZE)
  const lines = [
    ...renderHeader(title),
    '',
    `*Grup* : ${metadata.subject}`,
    `*Halaman* : ${currentPage}/${totalPages}`,
    '',
  ]
  if (visible.length === 0) lines.push('Belum ada data member.')
  else {
    for (const [index, participant] of visible.entries()) {
      lines.push(`${start + index + 1}. ${userLabel(participant.jid)} — ${participantRoleLabel(participant.role)}`)
    }
  }
  if (totalPages > 1) lines.push('', `Ketik ${prefix}${nextCommand} ${currentPage < totalPages ? currentPage + 1 : 1} untuk halaman berikutnya.`)
  lines.push('', ...renderFooter())
  return { text: lines.join('\n'), mentions: visible.map((participant) => participant.jid) }
}

function parsePage(value: string | undefined): number {
  return value && /^\d+$/.test(value) ? Math.max(1, Number(value)) : 1
}

function memberTargetJid(context: CommandContext): string | undefined {
  return context.message.mentionedJids?.[0] ?? context.message.quotedSenderJid
}

function targetJid(context: CommandContext): string | undefined {
  return memberTargetJid(context) ?? context.message.senderJid
}

export const groupPlugin: Plugin = {
  name: 'group-foundation',
  version: '0.1.0',
  load(context) {
    context.commands.register({
      name: 'groupid',
      description: 'Show the current WhatsApp group ID',
      category: 'group',
      menuOrder: 1,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        await commandContext.reply(`Group ID grup ini:\n${commandContext.message.remoteJid}`)
      },
    })

    context.commands.register({
      name: 'groupinfo',
      aliases: ['ginfo'],
      description: 'Show group metadata and bot status',
      category: 'group',
      menuOrder: 2,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const metadata = await commandContext.whatsapp.getGroupMetadata(commandContext.message.remoteJid)
        await commandContext.reply(renderGroupInfo(metadata, commandContext.whatsapp.userJid))
      },
    })

    context.commands.register({
      name: 'membercount',
      description: 'Show total members and administrators',
      category: 'group',
      menuOrder: 3,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const metadata = await commandContext.whatsapp.getGroupMetadata(commandContext.message.remoteJid)
        const adminCount = metadata.participants.filter((participant) => participant.role === 'admin' || participant.role === 'superadmin').length
        await commandContext.reply(`👥 *${metadata.subject}*\n↳ Member : ${metadata.participants.length}\n↳ Admin : ${adminCount}`)
      },
    })

    context.commands.register({
      name: 'admins',
      aliases: ['adminlist'],
      description: 'List group administrators with clickable mentions',
      category: 'group',
      menuOrder: 4,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const metadata = await commandContext.whatsapp.getGroupMetadata(commandContext.message.remoteJid)
        const admins = metadata.participants.filter((participant) => participant.role === 'admin' || participant.role === 'superadmin')
        const result = renderParticipantList(metadata, admins, '𝐆𝗿𝗼𝘂𝗽 𝐀𝗱𝗺𝗶𝗻', 'admins', parsePage(commandContext.args[0]), commandContext.prefix)
        await commandContext.reply(result.text, mentionOptions(result.mentions))
      },
    })

    context.commands.register({
      name: 'members',
      aliases: ['memberlist'],
      description: 'List group members with pagination',
      category: 'group',
      menuOrder: 5,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const metadata = await commandContext.whatsapp.getGroupMetadata(commandContext.message.remoteJid)
        const result = renderParticipantList(metadata, metadata.participants, '𝐆𝗿𝗼𝘂𝗽 𝐌𝗲𝗺𝗯𝗲𝗿', 'members', parsePage(commandContext.args[0]), commandContext.prefix)
        await commandContext.reply(result.text, mentionOptions(result.mentions))
      },
    })

    context.commands.register({
      name: 'memberinfo',
      description: 'Show role information for a mentioned member',
      category: 'group',
      menuOrder: 6,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const target = memberTargetJid(commandContext)
        if (!target) {
          await commandContext.reply('Reply atau mention satu member. Contoh: !memberinfo @user')
          return
        }
        const metadata = await commandContext.whatsapp.getGroupMetadata(commandContext.message.remoteJid)
        const participant = findParticipant(metadata, target)
        if (!participant) {
          await commandContext.reply('Member tersebut tidak ditemukan di metadata grup.')
          return
        }
        await commandContext.reply(
          `👤 *Member Info*\n↳ Pengguna : ${userLabel(participant.jid)}\n↳ Role : ${roleLabel(commandContext, participant)}`,
          mentionOptions([participant.jid]),
        )
      },
    })

    context.commands.register({
      name: 'link',
      description: 'Show the group invite link for administrators',
      category: 'group',
      menuOrder: 7,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const link = await commandContext.whatsapp.getGroupInviteLink(commandContext.message.remoteJid)
        await commandContext.reply(link
          ? `🔗 *Invite Link Grup*\n${link}`
          : 'Invite link grup tidak tersedia saat ini.')
      },
    })

    context.commands.register({
      name: 'rules',
      description: 'Show the current group rules',
      category: 'group',
      menuOrder: 8,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const metadata = await commandContext.whatsapp.getGroupMetadata(commandContext.message.remoteJid)
        const record = groupConfiguration(commandContext).getRules(commandContext.message.remoteJid)
        await commandContext.reply([
          '📖 ⑅【 𝐑𝘂𝗹𝗲𝘀 𝐆𝗿𝘂𝗽 】',
          '⏜ׄ꤮᷼⌒︵',
          `↳ *Grup* : ${metadata.subject}`,
          '',
          record?.rules ?? 'Aturan grup belum dikonfigurasi.',
          ...(record ? [] : [`Gunakan ${commandContext.prefix}setrules <aturan> untuk menambahkannya.`]),
          '',
          ...renderFooter(),
        ].join('\n'))
      },
    })

    context.commands.register({
      name: 'ruleshistory',
      description: 'Show recent group rules changes',
      category: 'group',
      menuOrder: 21,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const configuration = groupConfiguration(commandContext)
        const settings = configuration.getSettings(commandContext.message.remoteJid)
        const history = configuration.getRulesHistory(
          commandContext.message.remoteJid,
          parseHistoryLimit(commandContext.args[0]),
        )
        if (history.length === 0) {
          await commandContext.reply([
            '📜 ⑅【 𝐑𝘂𝗹𝗲𝘀 𝐇𝗶𝘀𝘁𝗼𝗿𝘆 】',
            '⏜ׄ꤮᷼⌒︵',
            'Belum ada perubahan rules yang tercatat.',
            '',
            ...renderFooter(),
          ].join('\n'))
          return
        }

        const timezone = settings.timezone?.timezone ?? 'UTC'
        const language = settings.language?.language ?? 'id'
        const mentions = [...new Set(history.map((entry) => entry.updatedBy))]
        const lines = [
          '📜 ⑅【 𝐑𝘂𝗹𝗲𝘀 𝐇𝗶𝘀𝘁𝗼𝗿𝘆 】',
          '⏜ׄ꤮᷼⌒︵',
          `↳ *Timezone* : ${timezone}`,
          '',
        ]
        history.forEach((entry, index) => {
          lines.push(
            `*${index + 1}. ${entry.action === 'set' ? 'Rules disimpan' : 'Rules dihapus'}*`,
            `↳ *Waktu* : ${formatHistoryTime(entry.updatedAt, timezone, language)}`,
            `↳ *Oleh* : ${userLabel(entry.updatedBy)}`,
          )
          if (entry.rules) lines.push(`↳ *Isi* : ${historyPreview(entry.rules)}`)
          if (index < history.length - 1) lines.push('')
        })
        lines.push('', ...renderFooter())
        await commandContext.reply(lines.join('\n'), mentionOptions(mentions))
      },
    })

    context.commands.register({
      name: 'setrules',
      description: 'Set the rules for the current group',
      category: 'group',
      menuOrder: 11,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const rules = commandContext.args.join(' ').trim()
        if (!rules) {
          await commandContext.reply(`Format: ${commandContext.prefix}setrules <aturan grup>\nContoh: ${commandContext.prefix}setrules Saling menghormati sesama member.`)
          return
        }
        if (rules.length > MAX_GROUP_RULES_LENGTH) {
          await commandContext.reply(`Aturan grup terlalu panjang. Maksimal ${MAX_GROUP_RULES_LENGTH} karakter.`)
          return
        }
        const record = groupConfiguration(commandContext).setRules(
          commandContext.message.remoteJid,
          rules,
          updateActor(commandContext),
        )
        await commandContext.reply([
          '✅ *Aturan grup berhasil disimpan.*',
          '',
          record.rules,
        ].join('\n'))
      },
    })

    context.commands.register({
      name: 'clearrules',
      description: 'Clear the rules for the current group',
      category: 'group',
      menuOrder: 12,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const removed = groupConfiguration(commandContext).clearRules(
          commandContext.message.remoteJid,
          updateActor(commandContext),
        )
        await commandContext.reply(
          removed
            ? '✅ Aturan grup berhasil dihapus.'
            : 'Belum ada aturan grup yang tersimpan.',
        )
      },
    })

    context.commands.register({
      name: 'setwelcome',
      description: 'Set a custom welcome message for the current group',
      category: 'group',
      menuOrder: 13,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const text = commandContext.args.join(' ').trim()
        if (!text) {
          await commandContext.reply(`Format: ${commandContext.prefix}setwelcome <pesan>\nPlaceholder: {{user}}, {{group}}, dan {{count}}.`)
          return
        }
        if (text.length > MAX_GROUP_MESSAGE_LENGTH) {
          await commandContext.reply(`Pesan welcome terlalu panjang. Maksimal ${MAX_GROUP_MESSAGE_LENGTH} karakter.`)
          return
        }
        groupConfiguration(commandContext).setWelcome(
          commandContext.message.remoteJid,
          text,
          updateActor(commandContext),
        )
        await commandContext.reply('✅ Pesan welcome custom berhasil disimpan.')
      },
    })

    context.commands.register({
      name: 'clearwelcome',
      description: 'Clear the custom welcome message for the current group',
      category: 'group',
      menuOrder: 14,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const removed = groupConfiguration(commandContext).clearWelcome(commandContext.message.remoteJid)
        await commandContext.reply(
          removed
            ? '✅ Pesan welcome custom berhasil dihapus. Allybot kembali memakai pesan default.'
            : 'Belum ada pesan welcome custom yang tersimpan.',
        )
      },
    })

    context.commands.register({
      name: 'setleave',
      description: 'Set a custom leave message for the current group',
      category: 'group',
      menuOrder: 15,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const text = commandContext.args.join(' ').trim()
        if (!text) {
          await commandContext.reply(`Format: ${commandContext.prefix}setleave <pesan>\nPlaceholder: {{user}}, {{group}}, dan {{count}}.`)
          return
        }
        if (text.length > MAX_GROUP_MESSAGE_LENGTH) {
          await commandContext.reply(`Pesan leave terlalu panjang. Maksimal ${MAX_GROUP_MESSAGE_LENGTH} karakter.`)
          return
        }
        groupConfiguration(commandContext).setLeave(
          commandContext.message.remoteJid,
          text,
          updateActor(commandContext),
        )
        await commandContext.reply('✅ Pesan leave custom berhasil disimpan.')
      },
    })

    context.commands.register({
      name: 'clearleave',
      description: 'Clear the custom leave message for the current group',
      category: 'group',
      menuOrder: 16,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const removed = groupConfiguration(commandContext).clearLeave(commandContext.message.remoteJid)
        await commandContext.reply(
          removed
            ? '✅ Pesan leave custom berhasil dihapus. Allybot kembali memakai pesan default.'
            : 'Belum ada pesan leave custom yang tersimpan.',
        )
      },
    })

    context.commands.register({
      name: 'groupsettings',
      description: 'Show active group configuration',
      category: 'group',
      menuOrder: 17,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const settings = groupConfiguration(commandContext).getSettings(commandContext.message.remoteJid)
        await commandContext.reply([
          '⚙️ ⑅【 𝐆𝗿𝗼𝘂𝗽 𝐒𝗲𝘁𝘁𝗶𝗻𝗴𝘀 】',
          '⏜ׄ꤮᷼⌒︵',
          `↳ *Rules* : ${settings.rules ? 'Custom' : 'Default / belum diatur'}`,
          `↳ *Welcome* : ${settings.welcome ? 'Custom' : 'Default'}`,
          `↳ *Leave* : ${settings.leave ? 'Custom' : 'Default'}`,
          `↳ *Prefix* : \`${commandContext.prefix}\``,
          `↳ *Language* : ${settings.language?.language ?? 'id'}`,
          `↳ *Timezone* : ${settings.timezone?.timezone ?? 'UTC'}`,
          '',
          ...renderFooter(),
        ].join('\n'))
      },
    })

    context.commands.register({
      name: 'prefix',
      description: 'Show the active command prefix for the current group',
      category: 'group',
      menuOrder: 18,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const configuration = groupConfiguration(commandContext)
        const settings = configuration.getSettings(commandContext.message.remoteJid)
        const override = configuration.getPrefix(commandContext.message.remoteJid)
        await commandContext.reply([
          '⚙️ ⑅【 𝐏𝗿𝗲𝗳𝗶𝘅 𝐆𝗿𝘂𝗽 】',
          '⏜ׄ꤮᷼⌒︵',
          `↳ *Prefix aktif* : \`${commandContext.prefix}\``,
          `↳ *Sumber* : ${override ? 'Override grup' : 'Prefix global'}`,
          `↳ *Prefix global* : \`${commandContext.config.commandPrefix}\``,
          `↳ *Language* : ${settings.language?.language ?? 'id'}`,
          '',
          `Gunakan \`${commandContext.prefix}setprefix <simbol>\` untuk mengubahnya.`,
          `Reset ke global: \`${commandContext.prefix}setprefix default\``,
          ...renderFooter(),
        ].join('\n'), override ? mentionOptions([override.updatedBy]) : undefined)
      },
    })

    context.commands.register({
      name: 'setprefix',
      description: 'Set the command prefix for the current group',
      category: 'group',
      menuOrder: 19,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const prefix = commandContext.args.join(' ').trim()
        if (!prefix) {
          await commandContext.reply(`Format: ${commandContext.prefix}setprefix <simbol>\nContoh: ${commandContext.prefix}setprefix ##`)
          return
        }
        if (prefix.toLowerCase() === 'default') {
          const removed = groupConfiguration(commandContext).clearPrefix(commandContext.message.remoteJid)
          await commandContext.reply(
            removed
              ? `✅ Prefix grup dikembalikan ke prefix global \`${commandContext.config.commandPrefix}\`.`
              : 'Prefix grup sudah menggunakan prefix global.',
          )
          return
        }
        if (!/^[!#$%&*+./?@~_\-]{1,4}$/.test(prefix)) {
          await commandContext.reply('Prefix harus terdiri dari 1 sampai 4 simbol yang didukung, tanpa huruf atau spasi.')
          return
        }
        groupConfiguration(commandContext).setPrefix(
          commandContext.message.remoteJid,
          prefix,
          updateActor(commandContext),
        )
        await commandContext.reply([
          `✅ Prefix grup berhasil diubah menjadi \`${prefix}\`.`,
          `Gunakan \`${prefix}prefix\` untuk memeriksa statusnya.`,
          `Reset ke global dengan \`${prefix}setprefix default\`.`,
        ].join('\n'))
      },
    })

    context.commands.register({
      name: 'setlanguage',
      description: 'Set the language preference for the current group',
      category: 'group',
      menuOrder: 20,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const language = commandContext.args[0]?.toLowerCase()
        if (!language || !SUPPORTED_GROUP_LANGUAGES.includes(language as typeof SUPPORTED_GROUP_LANGUAGES[number])) {
          await commandContext.reply(`Format: ${commandContext.prefix}setlanguage <${SUPPORTED_GROUP_LANGUAGES.join('|')}>`)
          return
        }
        const record = groupConfiguration(commandContext).setLanguage(
          commandContext.message.remoteJid,
          language,
          updateActor(commandContext),
        )
        await commandContext.reply(`✅ Bahasa grup berhasil diubah menjadi \`${record.language}\`.`)
      },
    })

    context.commands.register({
      name: 'settimezone',
      description: 'Set the IANA timezone for the current group',
      category: 'group',
      menuOrder: 22,
      permission: permissionNames.groupAdmin,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const timezone = commandContext.args.join(' ').trim()
        if (!timezone || !isValidGroupTimezone(timezone)) {
          await commandContext.reply([
            `Format: ${commandContext.prefix}settimezone <IANA timezone>`,
            `Contoh: ${commandContext.prefix}settimezone Asia/Jakarta`,
          ].join('\n'))
          return
        }
        const record = groupConfiguration(commandContext).setTimezone(
          commandContext.message.remoteJid,
          timezone,
          updateActor(commandContext),
        )
        await commandContext.reply(`✅ Timezone grup berhasil diubah menjadi \`${record.timezone}\`.`)
      },
    })

    context.commands.register({
      name: 'role',
      description: 'Show your role or the role of a mentioned member',
      category: 'group',
      menuOrder: 9,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const metadata = await commandContext.whatsapp.getGroupMetadata(commandContext.message.remoteJid)
        const target = targetJid(commandContext)
        const participant = findParticipant(metadata, target)
        if (!participant) {
          await commandContext.reply('Role pengguna tidak ditemukan di metadata grup.')
          return
        }
        await commandContext.reply(`↳ ${userLabel(participant.jid)} memiliki role *${roleLabel(commandContext, participant)}*.`)
      },
    })

    context.commands.register({
      name: 'permissions',
      description: 'Show the basic permissions associated with your group role',
      category: 'group',
      menuOrder: 10,
      handler: async (commandContext) => {
        if (!(await requireGroup(commandContext))) return
        const metadata = await commandContext.whatsapp.getGroupMetadata(commandContext.message.remoteJid)
        const participant = findParticipant(metadata, commandContext.message.senderJid)
        const role = participant?.role ?? 'member'
        const botOwner = isBotOwner(commandContext, commandContext.message.senderJid)
        const permissions = botOwner
          ? ['Melihat metadata grup', 'Melihat daftar member', 'Menggunakan command bot owner']
          : role === 'admin' || role === 'superadmin'
            ? ['Melihat metadata grup', 'Melihat daftar member', 'Menggunakan command admin setelah policy tersedia']
            : ['Melihat metadata grup', 'Melihat daftar member']
        await commandContext.reply([
          '🔐 *Permissions*',
          `↳ Role : ${botOwner ? 'Bot Owner' : participantRoleLabel(role)}`,
          ...permissions.map((permission) => `✓ ${permission}`),
        ].join('\n'))
      },
    })
  },
}

export default groupPlugin
