import { readFile } from 'node:fs/promises'
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
const MENU_THUMBNAIL_CAPTION = 'Allybot — menu bantuan'
const ROADMAP_CATEGORY_NAMES = [
  'group',
  'moderation',
  'roleplay',
  'your-character',
  'tools',
  'fun',
  'developer',
  'owner',
] as const

const categoryPresentation: Record<string, CategoryPresentation> = {
  group: { label: 'GROUP', icon: '👥' },
  moderation: { label: 'ADMIN TOOLS', icon: '🛡️' },
  roleplay: { label: 'ROLEPLAY', icon: '🎭' },
  'your-character': { label: 'YOUR CHARACTER', icon: '🎭' },
  tools: { label: 'TOOLS LENGKAP', icon: '🧰' },
  fun: { label: 'FUN', icon: '🎲' },
  developer: { label: 'DEVELOPER', icon: '🛠️' },
  owner: { label: 'OWNER', icon: '👑' },
}

const CATEGORY_ALIASES: Record<string, string> = {
  admin: 'moderation',
  'admin-tools': 'moderation',
  admintools: 'moderation',
  ai: 'tools',
  bank: 'your-character',
  creativity: 'fun',
  download: 'tools',
  economy: 'your-character',
  general: 'your-character',
  governance: 'moderation',
  media: 'tools',
  moderation: 'moderation',
  personalization: 'your-character',
  roleplay: 'roleplay',
  rpg: 'roleplay',
  scene: 'roleplay',
  search: 'tools',
  sticker: 'tools',
  tools: 'tools',
  'tools-ai': 'tools',
  'tools-media': 'tools',
  'tools-search': 'tools',
  'tools-sticker': 'tools',
  vela: 'your-character',
  yourcharacter: 'your-character',
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
  if (!category || !/^[a-z][a-z0-9_-]{0,31}$/.test(category)) return 'your-character'
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

function categoryLabel(category: MenuCategory): string {
  return presentationFor(category.name).label
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

function formatOwner(ownerJid: string | undefined): string {
  if (!ownerJid) return 'Belum dikonfigurasi'
  const phone = ownerJid.split('@')[0]?.replace(/\D/g, '') ?? ''
  if (phone.length < 7) return 'Terkonfigurasi'
  return `${phone.slice(0, 3)}••••${phone.slice(-4)}`
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

function formatCommand(command: CommandDefinition, prefix: string, position: number): string {
  const lines = [`ㅤׄꖑ *${position}.* \`${prefix}${command.name}\``]
  if (command.aliases && command.aliases.length > 0) {
    const aliasStr = command.aliases.map((alias) => `\`${prefix}${alias}\``).join(' ')
    lines.push(`       ⤷ alias: ${aliasStr}`)
  }
  lines.push(`       ⤷ _${commandDescription(command)}_`)
  return lines.join('\n')
}

function renderBotProfile(): string {
  return [
    '✦ • • `𝐀𝗹𝗹𝘆𝗯𝗼𝘁 𝐌𝗲𝗻𝘂`',
    '─֪──໋࣭─𝆭──꫶',
    '> ⟐┃ Nama : *Allybot*',
    '> ⟐┃ Uptime : *-*',
    '> ⟐┃ Owner : *6283197859955*',
    '> ⟐┃ Versi : *v0.1.0*',
    '*─┼────────────────┼─*',
  ].join('\n')
}

function renderMainMenu(
  _categories: readonly MenuCategory[],
  _prefix: string,
  _commandContext: Pick<CommandContext, 'config'>,
): string {
  return renderBotProfile()
}

function resolveCategory(categories: readonly MenuCategory[], identifier: string | undefined): MenuCategory | undefined {
  if (!identifier || !/^\d+$/.test(identifier)) return undefined
  return categories[Number(identifier) - 1]
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
      title: 'Character & Roleplay Admin',
      commands: ['inspectchar', 'charinfo', 'chardebug', 'inspect', 'setlevel', 'chlevel', 'lvl', 'setrank', 'chrank', 'rankset', 'resetstats', 'resetsheet', 'statreset', 'givetoken', 'addtoken', 'tokenreward', 'forceretire', 'killchar', 'wipechar', 'setgroup', 'whitelistooc', 'oocwhitelist'],
    },
    {
      title: 'Feedback & Reports',
      commands: ['setkotaksaran', 'setreportbox', 'replysaran', 'replyreport', 'blocksaran', 'blockreport', 'modstatus'],
    },
  ],
  'your-character': [
    {
      title: 'Status & Profile',
      commands: ['character', 'char', 'yourcharacter', 'stats', 'mystats', 'characterstats'],
    },
    {
      title: 'Progression & Registration',
      commands: ['daftar', 'registercharacter', 'createcharacter', 'confirm', 'next', 'skip', 'lewati', 'prev', 'kembali', 'retry', 'retrycharacter', 'cancel', 'cancelcharacter', 'alokasi', 'addstat', 'upstat', 'allocatestat', 'deletecharacter', 'deletechar', 'offcharacter', 'pensiun', 'savecharacter', 'savechar', 'timerp'],
    },
    {
      title: 'Economy & Vela',
      commands: ['vela', 'wallet', 'bank', 'pay', 'tax', 'taxbayar', 'bayarpajak', 'bankreward', 'bankpolicy', 'banksweep'],
    },
  ],
  tools: [
    {
      title: 'Artificial Intelligence',
      commands: ['ai', 'ally', 'tanya', 'translate', 'summarize', 'aidetection', 'tts', 'suara', 'text2img', 'buatgambar', 't2i', 'img2text', 'ocr'],
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
      commands: ['google', 'search', 'image', 'gambar', 'wiki', 'wikipedia', 'cuaca', 'weather', 'lirik', 'lyrics', 'pin', 'pinterest', 'pixiv', 'ss', 'screenshot', 'qr', 'ytmp3', 'yta', 'ytaudio', 'yt2mp3', 'ytmp4', 'ytv', 'ytvideo', 'yt2', 'tik', 'tt', 'tiktok', 'tik2mp3', 'ttmp3', 'tiktokaudio', 'tikmp3', 'dl', 'download', 'viddl', 'multidl', 'spotify', 'play', 'lagu'],
    },
    {
      title: 'System & Info',
      commands: ['botprofile', 'bprofile', 'ping', 'health', 'diag', 'diagnostics', 'about', 'version', 'support', 'commands', 'cmds', 'searchcmd', 'calc', 'convert', 'time', 'date'],
    },
  ],
}

function renderSubCategoryHeader(title: string): string {
  return [
    `𓏼 *\`${title}\`*`,
    '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
  ].join('\n')
}

function renderCategoryMenu(category: MenuCategory, prefix: string): string {
  const { icon, label } = presentationFor(category.name)
  const categoryTitle = label.replace(/^(TOOLS:\s*|TOOLS\s+)/i, '').trim()
  const header = [
    `⿴⃟۪۪⃕᎒⃟${icon} *𝐓𝗼𝗼𝗹𝘀: ${categoryTitle}*`,
    '. . . ▭▬▭▬▭ ︵⏜︵',
    `⡇╌ *${category.commands.length} command tersedia*`,
    '─͜──͜──͜─ · ✦ · ─͜──͜──͜─',
    '',
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

    let globalIndex = 0
    const renderedGroups = groups.map((g) => {
      const subHeader = renderSubCategoryHeader(g.title)
      const cmdList = g.commands.map((cmd) => {
        globalIndex += 1
        return formatCommand(cmd, prefix, globalIndex)
      }).join('\n\n')
      return `${subHeader}\n${cmdList}`
    })

    content = renderedGroups.join('\n\n')
  } else {
    content = category.commands
      .map((command, index) => formatCommand(command, prefix, index + 1))
      .join('\n\n')
  }

  const footer = [
    '',
    '° ° ──────────── · · ·',
    `*© ${BOT_NAME}*`,
  ]
  return [...header, content, ...footer].join('\n')
}

async function sendMenu(
  commandContext: CommandContext,
  body: string,
  options?: {
    readonly isMain?: boolean
    readonly prefix?: string
    readonly category?: MenuCategory
    readonly categories?: readonly MenuCategory[]
    readonly thumbnail?: Uint8Array
  },
): Promise<void> {
  const thumbnailRaw = options?.thumbnail ?? (commandContext.whatsapp.sendMedia ? await loadMenuThumbnail() : undefined)
  const thumbnail = await getOrPrepareMenuThumbnail(commandContext.whatsapp, thumbnailRaw)
  const jid = commandContext.message.remoteJid
  const prefix = options?.prefix ?? commandContext.prefix

  if (options?.isMain) {
    // Main Menu: structured presentation with thumbnail image header and interactive category buttons
    const builder = MsgBuilder.to(jid)
      .text(body)

    if (thumbnail) {
      builder.image(thumbnail, MENU_THUMBNAIL_MIME_TYPE)
    }

    const availableCategories = options.categories ?? []
    const buttonLimit = Math.min(availableCategories.length, 9)
    for (let idx = 0; idx < buttonLimit; idx++) {
      const cat = availableCategories[idx]
      const { icon, label } = presentationFor(cat.name)
      const buttonText = `${icon} ${label}`.slice(0, 20)
      builder.button({
        type: 'reply',
        id: `${prefix}menu ${idx + 1}`,
        text: buttonText,
      })
    }

    await builder.send(commandContext.whatsapp as any)
    return
  }

  if (options?.category) {
    // Hilangkan button "Menu Utama" atau "Semua Command" HANYA PADA Submenu Kategori saja, bukan menu utama.
    // Profile bot tidak usah ditampilkan lagi pada submenu.
    const builder = MsgBuilder.to(jid).text(body)
    await builder.send(commandContext.whatsapp as any)
    return
  }

  // Fallback for not found or simple notice
  const builder = MsgBuilder.to(jid).text(body)
  await builder.send(commandContext.whatsapp as any)
}

export const menuPlugin: Plugin = {
  name: 'menu',
  version: '0.5.0',
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
      const category = resolveCategory(categories, commandContext.args[0])
      const thumbnail = await loadMenuThumbnail()

      if (category) {
        const body = renderCategoryMenu(category, commandContext.prefix)
        await sendMenu(commandContext, body, { category, prefix: commandContext.prefix })
        return
      }

      if (commandContext.args[0]) {
        const body = `Kategori nomor *${commandContext.args[0]}* tidak ditemukan.\nBalas *${commandContext.prefix}menu* untuk melihat daftar kategori.`
        await sendMenu(commandContext, body)
        return
      }

      const body = renderMainMenu(categories, commandContext.prefix, commandContext)
      await sendMenu(commandContext, body, { isMain: true, prefix: commandContext.prefix, categories, thumbnail })
    }

    context.commands.register({
      name: 'menu',
      aliases: ['m', 'help'],
      description: 'Show Allybot categories and available commands',
      category: 'system',
      menuOrder: 1,
      hidden: true,
      cooldownMs: 0,
      handler: handleMenu,
    })
  },
}

export default menuPlugin
