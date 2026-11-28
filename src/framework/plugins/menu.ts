import { readFile } from 'node:fs/promises'
import { COMMAND_HELP_MAP, formatCommandHelp } from '../command-help-registry.js'
import { proto, prepareWAMessageMedia, type WASocket } from '@whiskeysockets/baileys'
import type { CommandContext, CommandDefinition, Plugin } from '../contracts.js'
import type { DeveloperModeService } from '../../services/developer-mode-service.js'
import { permissionNames } from '../../permissions.js'
import { commandDescription } from '../command-copy.js'
import { MsgBuilder } from '../msg-builder.js'
import { isGroupJid } from '../validation.js'

type MenuCategory = {
  readonly name: string
  readonly commands: readonly CommandDefinition[]
}

type CategoryPresentation = {
  readonly label: string
  readonly icon: string
}

const BOT_NAME = 'Allybot'
const BOT_VERSION = '0.1.0'
const MENU_THUMBNAIL_MIME_TYPE = 'image/jpeg'
const ROADMAP_CATEGORY_NAMES = [
  'group',
  'moderation',
  'tools',
  'fun',
  'developer',
  'owner',
] as const

const categoryPresentation: Record<string, CategoryPresentation> = {
  group: { label: 'GROUP', icon: '👥' },
  moderation: { label: 'ADMIN TOOLS', icon: '🛡️' },
  tools: { label: 'TOOLS', icon: '🧰' },
  fun: { label: 'FUN', icon: '🎲' },
  developer: { label: 'DEVELOPER', icon: '🛠️' },
  owner: { label: 'OWNER', icon: '👑' },
}

const CATEGORY_ALIASES: Record<string, string> = {
  admin: 'moderation',
  'admin-tools': 'moderation',
  admintools: 'moderation',
  ai: 'tools',
  creativity: 'fun',
  download: 'tools',
  governance: 'moderation',
  media: 'tools',
  moderation: 'moderation',
  search: 'tools',
  sticker: 'tools',
  tools: 'tools',
  'tools-ai': 'tools',
  'tools-media': 'tools',
  'tools-search': 'tools',
  'tools-sticker': 'tools',
}

let menuThumbnailPromise: Promise<Uint8Array | undefined> | undefined
let cachedMenuImageMessage: proto.Message.IImageMessage | undefined

async function loadMenuThumbnail(): Promise<Uint8Array | undefined> {
  menuThumbnailPromise ??= readFile(new URL('../../assets/allybot-menu-thumbnail.jpg', import.meta.url))
    .then((data) => new Uint8Array(data))
    .catch(() => undefined)
  return menuThumbnailPromise
}

async function getOrPrepareMenuThumbnail(
  whatsapp: CommandContext['whatsapp'],
  thumbnail: Uint8Array | undefined,
): Promise<proto.Message.IImageMessage | Uint8Array | undefined> {
  if (!thumbnail) return undefined
  const socket = (whatsapp as { socket?: WASocket }).socket
  if (!socket?.waUploadToServer) return thumbnail
  if (cachedMenuImageMessage) return cachedMenuImageMessage

  try {
    const media = await prepareWAMessageMedia(
      { image: Buffer.from(thumbnail), mimetype: MENU_THUMBNAIL_MIME_TYPE },
      { upload: socket.waUploadToServer },
    )
    if (media.imageMessage) {
      cachedMenuImageMessage = media.imageMessage
      return media.imageMessage
    }
  } catch {
    // fallback to thumbnail buffer directly
  }
  return thumbnail
}

function normalizeCategory(command: CommandDefinition): string {
  if (
    command.permission === permissionNames.groupAdmin ||
    command.permission === permissionNames.groupAdminOrBotOwner ||
    command.permission === permissionNames.groupOwner
  ) {
    return 'moderation'
  }
  const category = command.category?.trim().toLowerCase()
  if (!category || !/^[a-z][a-z0-9_-]{0,31}$/.test(category)) return 'tools'
  return CATEGORY_ALIASES[category] ?? (category in categoryPresentation ? category : 'tools')
}

function sortCommands(commands: readonly CommandDefinition[]): CommandDefinition[] {
  return [...commands].sort((left, right) => {
    const orderDifference = (left.menuOrder ?? Number.MAX_SAFE_INTEGER) - (right.menuOrder ?? Number.MAX_SAFE_INTEGER)
    return orderDifference || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function collectCategories(commands: readonly CommandDefinition[]): MenuCategory[] {
  const grouped = new Map<string, CommandDefinition[]>()
  for (const command of commands) {
    const name = normalizeCategory(command)
    grouped.set(name, [...(grouped.get(name) ?? []), command])
  }

  return [...grouped.entries()]
    .map(([name, categoryCommands]) => ({ name, commands: sortCommands(categoryCommands) }))
    .sort((left, right) => {
      const leftOrder = ROADMAP_CATEGORY_NAMES.indexOf(left.name as typeof ROADMAP_CATEGORY_NAMES[number])
      const rightOrder = ROADMAP_CATEGORY_NAMES.indexOf(right.name as typeof ROADMAP_CATEGORY_NAMES[number])
      return (leftOrder === -1 ? ROADMAP_CATEGORY_NAMES.length : leftOrder) - (rightOrder === -1 ? ROADMAP_CATEGORY_NAMES.length : rightOrder)
        || left.name.localeCompare(right.name)
    })
}

function presentationFor(category: string): CategoryPresentation {
  return categoryPresentation[category] ?? { label: category.toUpperCase(), icon: '📂' }
}

function isSameJid(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  return left.split(':')[0] === right.split(':')[0]
}

function isBotOwner(commandContext: Pick<CommandContext, 'message' | 'config'>): boolean {
  return isSameJid(commandContext.message.senderJid, commandContext.config.botOwnerJid)
}

async function isGroupAdminOrOwner(commandContext: CommandContext): Promise<boolean> {
  if (isBotOwner(commandContext)) return true
  const remoteJid = commandContext.message.remoteJid
  if (!isGroupJid(remoteJid)) {
    return false
  }
  const senderJid = commandContext.message.senderJid
  if (!senderJid) return false
  try {
    const metadata = await commandContext.whatsapp.getGroupMetadata(remoteJid)
    if (!metadata || !metadata.participants) return false
    const bareSender = senderJid.split('@')[0].split(':')[0]
    if (metadata.ownerJid && metadata.ownerJid.split('@')[0].split(':')[0] === bareSender) return true
    const participant = metadata.participants.find((p) => p.jid.split('@')[0].split(':')[0] === bareSender)
    return participant?.role === 'admin' || participant?.role === 'superadmin'
  } catch {
    return false
  }
}

async function canSeePrivilegedCategory(
  category: MenuCategory,
  commandContext: CommandContext,
): Promise<boolean> {
  if (category.name === 'owner') return isBotOwner(commandContext)
  if (category.name === 'developer') {
    if (isBotOwner(commandContext)) return true
    const sender = commandContext.message.senderJid
    if (!sender || !commandContext.services.has('developer-mode')) return false
    try {
      return commandContext.services.get<DeveloperModeService>('developer-mode').listVisibleActivations(sender, false).length > 0
    } catch {
      return false
    }
  }
  if (category.name === 'moderation') {
    return isGroupAdminOrOwner(commandContext)
  }
  return true
}

const SUBCAT_DESCRIPTIONS: Record<string, string> = {
  // Tools
  'Artificial Intelligence': 'Tanya asisten pintar, buat & edit gambar otomatis, dan ubah teks jadi suara',
  'Video Tools': 'Buat video sinematik, animasikan foto, dan edit video secara instan',
  'Media & Sticker': 'Buat stiker WhatsApp, ubah format media, dan jernihkan foto',
  'Visual Card & Stalk': 'Buat gambar kutipan percakapan dan intip profil media sosial',
  'Search & Download': 'Cari informasi dan simpan media dari internet langsung ke WhatsApp',
  'System & Info': 'Cek kondisi bot, waktu saat ini, dan alat bantu hitung praktis',

  // Group
  'Member & Profil': 'Lihat daftar anggota, pengurus grup, dan profil obrolan',
  'Peraturan Grup': 'Baca tata tertib dan riwayat aturan yang berlaku di grup',
  'Interaksi & Komunitas': 'Izin istirahat santai, kirim masukan, dan sapa teman obrolan',

  // Moderation
  'Quick Action': 'Tindak cepat penertiban anggota yang melanggar aturan',
  'Warning & Case System': 'Catat peringatan pelanggaran dan kelola permohonan banding',
  'Automod Protection': 'Jaga obrolan dari kiriman tautan asing, pesan beruntun, dan kata kasar',
  'Chat & Member Control': 'Atur izin kirim pesan, kunci obrolan, dan kelola admin grup',
  'Group Rules & Settings': 'Atur pesan sambutan anggota baru dan setelan dasar bot di grup',
  'Feedback & Reports': 'Terima pesan kendala dan dengarkan saran dari anggota grup',

  // Fallback
  'Other Commands': 'Perintah pendukung dan fungsi tambahan sistem',
}

function formatCommand(command: CommandDefinition, prefix: string, position: number): string {
  const aliasPart = command.aliases && command.aliases.length > 0
    ? ` (${command.aliases.slice(0, 3).join(', ')})`
    : ''
  const desc = commandDescription(command)
  return `${position}. *${prefix}${command.name}*${aliasPart}\n   _${desc}_`
}

function formatUptime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const remainingSeconds = totalSeconds % 60
  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours || days) parts.push(`${hours}h`)
  if (minutes || hours || days) parts.push(`${minutes}m`)
  parts.push(`${remainingSeconds}s`)
  return parts.join(' ')
}

function resolveUserDisplay(commandContext: CommandContext): string {
  const pushName = commandContext.message.pushName?.trim()
  if (pushName) return pushName
  const senderJid = commandContext.message.senderJid ?? commandContext.message.remoteJid
  const contactName = commandContext.whatsapp.getDisplayName?.(senderJid)?.trim()
  if (contactName) return contactName
  const bare = senderJid.split('@')[0]?.split(':')[0]
  return bare || 'Member'
}

function renderMainMenu(
  _categories: readonly MenuCategory[],
  prefix: string,
  commandContext: CommandContext,
  userRoleLabel: string,
): string {
  const userName = resolveUserDisplay(commandContext)
  let oocNote = ''
  if (typeof commandContext.services?.has === 'function' && commandContext.services.has('gatekeeper')) {
    try {
      const gk = commandContext.services.get('gatekeeper') as { getContextPolicy?: (jid: string) => string }
      if (gk.getContextPolicy?.(commandContext.message.remoteJid) === 'ooc_limited') {
        oocNote = '\n⚠️ _Grup OOC mode terbatas: untuk Game, Media & Downloader lengkap, gunakan *Voice & Bot Room*._'
      }
    } catch {}
  }

  return [
    '✦ • • `𝐀𝗹𝗹𝘆𝗯𝗼𝘁 𝐌𝗲𝗻𝘂`',
    '─֪──໋࣭─𝆭──꫶',
    `> ⟐┃ User : *${userName}* (${userRoleLabel})`,
    `> ⟐┃ Nama : *${BOT_NAME}*`,
    `> ⟐┃ Uptime : *${formatUptime(process.uptime())}*`,
    `> ⟐┃ Versi : *v${BOT_VERSION}*`,
    '',
    `_Buka tombol *Menu* di bawah atau ketik *${prefix}menu <kata kunci>*_${oocNote}`,
  ].join('\n')
}

function resolveCategory(categories: readonly MenuCategory[], identifier: string | undefined): MenuCategory | undefined {
  if (!identifier) return undefined
  const trimmed = identifier.trim().toLowerCase()
  if (/^\d+$/.test(trimmed)) {
    return categories[Number(trimmed) - 1]
  }
  const aliased = CATEGORY_ALIASES[trimmed] ?? trimmed
  return categories.find((c) => c.name.toLowerCase() === aliased || c.name.toLowerCase() === trimmed)
}

type SubCategoryDef = {
  readonly title: string
  readonly commands: readonly string[]
}

const CATEGORY_SUB_GROUPS: Record<string, readonly SubCategoryDef[]> = {
  group: [
    {
      title: 'Member & Profil',
      commands: ['groupinfo', 'ginfo', 'membercount', 'admins', 'adminlist', 'members', 'memberlist', 'memberinfo', 'info'],
    },
    {
      title: 'Peraturan Grup',
      commands: ['rules', 'ruleshistory'],
    },
    {
      title: 'Interaksi & Komunitas',
      commands: ['afk', 'away', 'tagme', 'role', 'permissions', 'ooc', 'suggest', 'report'],
    },
  ],
  moderation: [
    {
      title: 'Quick Action',
      commands: ['kick', 'tendang', 'ban', 'unban', 'mute', 'unmute', 'modaction', 'moderate'],
    },
    {
      title: 'Warning & Case System',
      commands: ['warn', 'warnings', 'warns', 'unwarn', 'clearwarn', 'setlimit', 'cases', 'case', 'claimcase', 'appeal', 'auditverify'],
    },
    {
      title: 'Automod Protection',
      commands: ['safety', 'setsafety', 'antilink', 'antispam', 'antitoxic'],
    },
    {
      title: 'Chat & Member Control',
      commands: ['lock', 'unlock', 'groupmode', 'promote', 'demote', 'tagall', 'hidetag', 'del', 'delete', 'clear'],
    },
    {
      title: 'Group Rules & Settings',
      commands: ['link', 'invite', 'setprefix', 'setrules', 'clearrules', 'welcome', 'left', 'leavetoggle', 'setwelcome', 'clearwelcome', 'setleave', 'clearleave', 'leave', 'botleave'],
    },
    {
      title: 'Feedback & Reports',
      commands: ['setkotaksaran', 'setreportbox', 'replysaran', 'replyreport', 'blocksaran', 'blockreport', 'modstatus'],
    },
  ],
  tools: [
    {
      title: 'Artificial Intelligence',
      commands: [
        'ai', 'ally', 'tanya', 'translate', 'summarize', 'aidetection', 'tts', 'suara',
        'img', 'draw', 'text2img', 'i2i', 'anime', 'logo', 'bgchange', 'restore', 'cosplay', 'remix',
        'img2text', 'ocr',
      ],
    },
    {
      title: 'Video Tools',
      commands: [
        'vid', 'video', 'omnivid', 'vidomni', 'i2v',
        'vcompress', 'vshrink', 'vtrim', 'vcut', 'vspeed', 'vtempo', 'vmute', 'vsilence',
        'vvn', 'videotovn', 'vidstatus', 'vidmodels',
      ],
    },
    {
      title: 'Media & Sticker',
      commands: ['sticker', 's', 'stiker', 'toimg', 'togambar', 'togif', 'gif', 'toaudio', 'audio', 'tomp3', 'tovideo', 'tomp4', 'compress', 'kompres', 'kecilkan', 'removebg', 'nobg', 'hd', 'remini', 'upscale', 'stickerwm', 'swm', 'smeme', 'emojimix', 'mixemoji', 'spack', 'stickerpack', 'pack', 'tourl', 'brat', 'brats', 'bratsticker', 'bratvid', 'bvid', 'bratvideo', 'bratanim'],
    },
    {
      title: 'Visual Card & Stalk',
      commands: ['qc', 'quotly', 'qchat', 'iqc', 'iosqc', 'fakechat', 'iqcs', 'iosqcs', 'iqcsticker', 'fakechatsticker', 'x', 'tweet', 'faketweet', 'xpost', 'ttstalk', 'tiktokstalk', 'igstalk', 'instagramstalk'],
    },
    {
      title: 'Search & Download',
      commands: ['google', 'search', 'image', 'gambar', 'wiki', 'wikipedia', 'cuaca', 'weather', 'lirik', 'lyrics', 'pin', 'pinterest', 'pixiv', 'ss', 'screenshot', 'qr', 'ytmp3', 'yta', 'ytaudio', 'yt2mp3', 'ytmp4', 'ytv', 'ytvideo', 'yt2', 'tik', 'tt', 'tiktok', 'tik2mp3', 'ttmp3', 'tiktokaudio', 'tikmp3', 'dl', 'download', 'viddl', 'multidl', 'terabox', 'tb', 'bypass', 'unshort', 'yts', 'sc', 'dlstats', 'spotify', 'play', 'lagu'],
    },
    {
      title: 'System & Info',
      commands: ['botprofile', 'bprofile', 'ping', 'health', 'diag', 'diagnostics', 'about', 'version', 'support', 'commands', 'cmds', 'searchcmd', 'calc', 'convert', 'time', 'date'],
    },
  ],
}

function renderCategoryMenu(category: MenuCategory, prefix: string): string {
  const { icon, label } = presentationFor(category.name)
  const header = [
    `${icon} *${label}*`,
    `_${category.commands.length} command tersedia_`,
    '──────── · ✦ · ────────',
  ]

  const subDefs = CATEGORY_SUB_GROUPS[category.name]
  let content: string

  if (subDefs && subDefs.length > 0) {
    const assigned = new Set<string>()
    const groups: Array<{ title: string; commands: CommandDefinition[] }> = []

    for (const subDef of subDefs) {
      const matchSet = new Set(subDef.commands.map((c) => c.toLowerCase()))
      const matched = category.commands.filter((cmd) => matchSet.has(cmd.name.toLowerCase()))
      matched.forEach((cmd) => assigned.add(cmd.name.toLowerCase()))
      if (matched.length > 0) {
        groups.push({ title: subDef.title, commands: matched })
      }
    }

    const remainder = category.commands.filter((cmd) => !assigned.has(cmd.name.toLowerCase()))
    if (remainder.length > 0) {
      groups.push({ title: 'Other Commands', commands: remainder })
    }

    const renderedGroups = groups.map((g) => {
      const desc = SUBCAT_DESCRIPTIONS[g.title] || 'Kumpulan perintah pendukung operasional bot'
      const subHeader = [
        `𓏼 *\`${g.title}\`*`,
        '─͜──͜──͜─ · ✦ · ─͜──͜──͜─',
        `_${desc}_`,
      ].join('\n')

      let subIndex = 0
      const cmdList = g.commands.map((cmd) => {
        subIndex += 1
        return formatCommand(cmd, prefix, subIndex)
      }).join('\n')
      return `${subHeader}\n${cmdList}`
    })

    content = renderedGroups.join('\n\n')
  } else {
    const desc = SUBCAT_DESCRIPTIONS[label] || 'Kumpulan perintah pendukung operasional bot'
    const subHeader = [
      `𓏼 *\`${label}\`*`,
      '─͜──͜──͜─ · ✦ · ─͜──͜──͜─',
      `_${desc}_`,
    ].join('\n')

    let subIndex = 0
    const cmdList = category.commands.map((cmd) => {
      subIndex += 1
      return formatCommand(cmd, prefix, subIndex)
    }).join('\n')

    content = `${subHeader}\n${cmdList}`
  }

  const footer = [
    '',
    '° ° ──────────── · · ·',
    `*© ${BOT_NAME}*`,
  ]
  return [...header, content, ...footer].join('\n')
}

function searchAllowedCommands(
  categories: readonly MenuCategory[],
  rawQuery: string,
): readonly CommandDefinition[] {
  const needle = rawQuery.trim().toLowerCase()
  if (!needle) return []
  const matches: CommandDefinition[] = []
  const seen = new Set<string>()

  for (const cat of categories) {
    for (const cmd of cat.commands) {
      if (seen.has(cmd.name)) continue
      const help = COMMAND_HELP_MAP[cmd.name]
      const haystack = [
        cmd.name,
        ...(cmd.aliases ?? []),
        commandDescription(cmd),
        cmd.description ?? '',
        help?.summary ?? '',
        help?.description ?? '',
      ]
        .join(' ')
        .toLowerCase()
      if (haystack.includes(needle)) {
        seen.add(cmd.name)
        matches.push(cmd)
        if (matches.length >= 10) return matches
      }
    }
  }
  return matches
}

function renderKeywordSearchMenu(
  query: string,
  matches: readonly CommandDefinition[],
  prefix: string,
): string {
  const lines = matches.map((cmd, idx) => {
    const aliasPart = cmd.aliases && cmd.aliases.length > 0
      ? ` (${cmd.aliases.slice(0, 3).join(', ')})`
      : ''
    const desc = commandDescription(cmd)
    const example = COMMAND_HELP_MAP[cmd.name]?.examples?.[0]
    const exampleLine = example
      ? `\n   Contoh: \`${example.replace(/^!/, prefix)}\``
      : ''
    return `${idx + 1}. *${prefix}${cmd.name}*${aliasPart}\n   _${desc}_${exampleLine}`
  })

  return [
    `🔍 *Hasil Pencarian: "${query}"*`,
    `_${matches.length} command ditemukan_`,
    '──────── · ✦ · ────────',
    lines.join('\n\n'),
    '',
    `*© ${BOT_NAME}*`,
  ].join('\n')
}

function buildOwnerChatUrl(botOwnerJid?: string): string | undefined {
  if (!botOwnerJid) return undefined
  const localPart = botOwnerJid.split('@')[0]?.split(':')[0] ?? ''
  const digits = localPart.replace(/[^0-9]/g, '')
  if (digits.length < 8) return undefined
  return `https://wa.me/${digits}`
}

function buildCategoryListOptions(
  buttonText: string,
  sectionTitle: string,
  categories: readonly MenuCategory[],
  prefix: string,
) {
  return {
    buttonText,
    sections: [
      {
        title: sectionTitle,
        rows: categories.slice(0, 10).map((cat, idx) => {
          const { icon, label } = presentationFor(cat.name)
          return {
            id: `${prefix}menu ${idx + 1}`,
            title: `[${idx + 1}] ${icon} ${label}`.slice(0, 24),
            description: `${cat.commands.length} command tersedia`,
          }
        }),
      },
    ],
  }
}

async function sendMenu(
  commandContext: CommandContext,
  body: string,
  options?: {
    readonly isMain?: boolean
    readonly isSearch?: boolean
    readonly prefix?: string
    readonly category?: MenuCategory
    readonly categories?: readonly MenuCategory[]
    readonly thumbnail?: Uint8Array
  },
): Promise<void> {
  const jid = commandContext.message.remoteJid
  const prefix = options?.prefix ?? commandContext.prefix

  if (options?.isMain) {
    const thumbnailRaw = options.thumbnail ?? (commandContext.whatsapp.sendMedia ? await loadMenuThumbnail() : undefined)
    const thumbnail = await getOrPrepareMenuThumbnail(commandContext.whatsapp, thumbnailRaw)
    const builder = MsgBuilder.to(jid)
      .text(body)
      .footer(BOT_NAME)

    if (thumbnail) {
      builder.image(thumbnail, MENU_THUMBNAIL_MIME_TYPE)
    }

    const availableCategories = options.categories ?? []
    const categoryRows = availableCategories.slice(0, 10).map((cat, idx) => {
      const { icon, label } = presentationFor(cat.name)
      return {
        id: `${prefix}menu ${idx + 1}`,
        title: `[${idx + 1}] ${icon} ${label}`.slice(0, 24),
        description: `${cat.commands.length} command tersedia`,
      }
    })
    const infoRows = [
      { id: `${prefix}about`, title: 'ℹ️ Info Bot', description: 'Profil dan fitur utama Allybot' },
      { id: `${prefix}botprofile`, title: '🤖 Profil Bot', description: 'Identitas resmi & kontak pengembang' },
      { id: `${prefix}support`, title: '🛟 Bantuan & Support', description: 'Pusat bantuan kendala bot' },
      { id: `${prefix}ping`, title: '⚡ Ping & Latensi', description: 'Cek kecepatan respons bot' },
    ].slice(0, Math.max(0, 10 - categoryRows.length))

    const listSections = [
      ...(categoryRows.length > 0 ? [{ title: 'Pilih Kategori Menu', rows: categoryRows }] : []),
      ...(infoRows.length > 0 ? [{ title: 'Informasi & Utilitas Bot', rows: infoRows }] : []),
    ]
    if (listSections.length > 0) {
      builder.list({
        buttonText: '📋 Daftar Menu',
        sections: listSections,
      })
    }

    const ownerUrl = buildOwnerChatUrl(commandContext.config.botOwnerJid)
    if (ownerUrl) {
      builder.button({
        type: 'url',
        text: '👤 Chat Owner',
        url: ownerUrl,
      })
    }

    let inviteUrl = commandContext.config.officialOocInviteLink?.trim()
    if ((!inviteUrl || !inviteUrl.startsWith('https://')) && commandContext.services.has('gatekeeper')) {
      try {
        const gk = (commandContext.services.get('gatekeeper') as { resolveLiveOocLink?: (wa?: unknown) => Promise<string> })
        const resolved = await gk.resolveLiveOocLink?.(commandContext.whatsapp)
        if (resolved && resolved.startsWith('https://') && !resolved.includes('Placeholder')) {
          inviteUrl = resolved
        }
      } catch {}
    }
    if (inviteUrl && inviteUrl.startsWith('https://')) {
      builder.button({
        type: 'url',
        text: '💬 Grup Official Allyssea',
        url: inviteUrl,
      })
    }

    await builder.send(commandContext.whatsapp as any)
    return
  }

  if (options?.category) {
    const builder = MsgBuilder.to(jid)
      .text(body)
      .footer(BOT_NAME)

    const availableCategories = options.categories ?? []
    if (availableCategories.length > 0) {
      builder.list(buildCategoryListOptions('📋 Ganti Kategori', 'Kategori Tersedia', availableCategories, prefix))
    }
    builder.button({
      type: 'reply',
      id: `${prefix}menu`,
      text: '⬅️ Menu Utama',
    })

    await builder.send(commandContext.whatsapp as any)
    return
  }

  if (options?.isSearch) {
    const builder = MsgBuilder.to(jid)
      .text(body)
      .footer(BOT_NAME)
      .button({
        type: 'reply',
        id: `${prefix}menu`,
        text: '⬅️ Menu Utama',
      })

    await builder.send(commandContext.whatsapp as any)
    return
  }

  const builder = MsgBuilder.to(jid).text(body)
  await builder.send(commandContext.whatsapp as any)
}

export const menuPlugin: Plugin = {
  name: 'menu',
  version: '0.6.0',
  load(context) {
    const handleMenu = async (commandContext: CommandContext): Promise<void> => {
      const visibleCommands = context.commands.list().filter((command) => command.name !== 'menu' && !command.hidden)
      const allCategories = collectCategories(visibleCommands)
      const allowedCategories: MenuCategory[] = []
      for (const cat of allCategories) {
        if (await canSeePrivilegedCategory(cat, commandContext)) {
          allowedCategories.push(cat)
        }
      }
      const categories = allowedCategories
      const rawArgText = commandContext.args.join(' ').trim()

      if (rawArgText) {
        if (/^\d+$/.test(rawArgText)) {
          const category = resolveCategory(categories, rawArgText)
          if (category) {
            const body = renderCategoryMenu(category, commandContext.prefix)
            await sendMenu(commandContext, body, { category, categories, prefix: commandContext.prefix })
            return
          }
          const body = `Kategori nomor *${rawArgText}* tidak ditemukan.\nBalas *${commandContext.prefix}menu* untuk melihat daftar kategori.`
          await sendMenu(commandContext, body)
          return
        }

        const categoryByName = commandContext.args.length === 1
          ? resolveCategory(categories, rawArgText)
          : undefined
        if (categoryByName) {
          const body = renderCategoryMenu(categoryByName, commandContext.prefix)
          await sendMenu(commandContext, body, { category: categoryByName, categories, prefix: commandContext.prefix })
          return
        }

        const allowedCommandSet = new Set(categories.flatMap((c) => c.commands.map((cmd) => cmd.name)))
        if (commandContext.args.length === 1) {
          const query = rawArgText.toLowerCase()
          const targetCmd = context.commands.get(query)
          if (targetCmd && !targetCmd.hidden && allowedCommandSet.has(targetCmd.name)) {
            const helpText = formatCommandHelp(targetCmd.name, targetCmd.aliases, commandContext.prefix)
            if (helpText) {
              await commandContext.reply(helpText)
              return
            }
          }
        }

        const matches = searchAllowedCommands(categories, rawArgText)
        if (matches.length > 0) {
          const body = renderKeywordSearchMenu(rawArgText, matches, commandContext.prefix)
          await sendMenu(commandContext, body, { isSearch: true, prefix: commandContext.prefix })
          return
        }

        const body = `Kategori atau command untuk *"${rawArgText}"* tidak ditemukan.\nBalas *${commandContext.prefix}menu* untuk melihat daftar kategori.`
        await sendMenu(commandContext, body, { isSearch: true, prefix: commandContext.prefix })
        return
      }

      const isOwner = isBotOwner(commandContext)
      const isAdmin = !isOwner && await isGroupAdminOrOwner(commandContext)
      const userRoleLabel = isOwner ? 'Owner' : isAdmin ? 'Admin Grup' : 'Member'

      const thumbnail = await loadMenuThumbnail()
      const body = renderMainMenu(categories, commandContext.prefix, commandContext, userRoleLabel)
      await sendMenu(commandContext, body, { isMain: true, prefix: commandContext.prefix, categories, thumbnail })
    }

    context.commands.register({
      name: 'menu',
      aliases: ['m', 'help', 'bantuan'],
      description: 'Tampilkan menu kategori, pencarian, atau bantuan perintah',
      category: 'system',
      menuOrder: 1,
      hidden: true,
      cooldownMs: 0,
      handler: handleMenu,
    })
  },
}

export default menuPlugin
