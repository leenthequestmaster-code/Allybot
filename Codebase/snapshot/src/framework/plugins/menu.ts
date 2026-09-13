import { readFile } from 'node:fs/promises'
import type { CommandContext, CommandDefinition, Plugin } from '../contracts.js'
import type { DeveloperModeService } from '../../services/developer-mode-service.js'
import { commandDescription } from '../command-copy.js'

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
  'your-character',
  'economy',
  'tools-media',
  'tools-search',
  'tools-sticker',
  'tools-ai',
  'fun',
  'developer',
  'owner',
] as const

const categoryPresentation: Record<string, CategoryPresentation> = {
  group: { label: 'GROUP', icon: '👥' },
  moderation: { label: 'MODERATION', icon: '🛡️' },
  'your-character': { label: 'YOUR CHARACTER', icon: '🎭' },
  economy: { label: 'EKONOMI', icon: '💰' },
  'tools-media': { label: 'TOOLS: MEDIA', icon: '🖼️' },
  'tools-search': { label: 'TOOLS: SEARCH', icon: '🔍' },
  'tools-sticker': { label: 'TOOLS: STICKER', icon: '🎨' },
  'tools-ai': { label: 'TOOLS: AI', icon: '🤖' },
  fun: { label: 'FUN', icon: '🎲' },
  developer: { label: 'DEVELOPER', icon: '🛠️' },
  owner: { label: 'OWNER', icon: '👑' },
}

const CATEGORY_ALIASES: Record<string, string> = {
  ai: 'tools-ai',
  creativity: 'fun',
  download: 'tools-media',
  general: 'your-character',
  governance: 'moderation',
  media: 'tools-media',
  personalization: 'your-character',
  roleplay: 'your-character',
  yourcharacter: 'your-character',
  search: 'tools-search',
  sticker: 'tools-sticker',
}

let menuThumbnailPromise: Promise<Uint8Array | undefined> | undefined

async function loadMenuThumbnail(): Promise<Uint8Array | undefined> {
  menuThumbnailPromise ??= readFile(new URL('../../assets/allybot-menu-thumbnail.jpg', import.meta.url))
    .then((data) => new Uint8Array(data))
    .catch(() => undefined)
  return menuThumbnailPromise
}

function normalizeCategory(command: CommandDefinition): string {
  const category = command.category?.trim().toLowerCase()
  if (!category || !/^[a-z][a-z0-9_-]{0,31}$/.test(category)) return 'your-character'
  return CATEGORY_ALIASES[category] ?? (category in categoryPresentation ? category : 'tools-media')
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

function canSeePrivilegedCategory(
  category: MenuCategory,
  commandContext: Pick<CommandContext, 'message' | 'config' | 'services'>,
): boolean {
  if (category.name === 'owner') return isBotOwner(commandContext)
  if (category.name !== 'developer') return true
  if (isBotOwner(commandContext)) return true
  const sender = commandContext.message.senderJid
  if (!sender || !commandContext.services.has('developer-mode')) return false
  try {
    return commandContext.services.get<DeveloperModeService>('developer-mode').listVisibleActivations(sender, false).length > 0
  } catch {
    return false
  }
}

function formatCommand(command: CommandDefinition, prefix: string, position: number): string {
  const aliases = command.aliases?.length
    ? ` · alias: ${command.aliases.map((alias) => `${prefix}${alias}`).join(', ')}`
    : ''
  const accessMarker = command.permission ? ' 🔒' : ''
  return `*${position}.* ${prefix}${command.name}${accessMarker}${aliases}\n   _${commandDescription(command)}_`
}

function renderBotProfile(commandContext: Pick<CommandContext, 'config'>): string {
  return [
    '╭─〔 *PROFILE BOT* 〕',
    `│ Nama   : *${BOT_NAME}*`,
    `│ Uptime : *${formatUptime(process.uptime())}*`,
    `│ Owner  : *${formatOwner(commandContext.config.botOwnerJid)}*`,
    `│ Versi  : *v${BOT_VERSION}*`,
    '╰────────────────────',
  ].join('\n')
}

function renderMainMenu(
  categories: readonly MenuCategory[],
  prefix: string,
  commandContext: Pick<CommandContext, 'config'>,
): string {
  const lines = [
    '╭━━━━━━━━━━━━━━━━━━━━╮',
    '│  *ALLYBOT MENU*  🤖  │',
    '╰━━━━━━━━━━━━━━━━━━━━╯',
    '',
    renderBotProfile(commandContext),
    '',
    'Hai! Pilih kategori dengan membalas angka di bawah ini:',
    '',
  ]

  if (categories.length === 0) {
    lines.push('_Belum ada command yang tersedia._')
  } else {
    categories.forEach((category, index) => {
      const { icon } = presentationFor(category.name)
      lines.push(`*${index + 1}.* ${icon} *${categoryLabel(category)}* — ${category.commands.length} command`)
    })
  }

  lines.push(
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    `Balas dengan *${prefix}menu 1*, *${prefix}menu 2*, dan seterusnya.`,
    `Ketik *${prefix}menu* kapan saja untuk kembali ke daftar ini.`,
  )
  return lines.join('\n')
}

function resolveCategory(categories: readonly MenuCategory[], identifier: string | undefined): MenuCategory | undefined {
  if (!identifier || !/^\d+$/.test(identifier)) return undefined
  return categories[Number(identifier) - 1]
}

function renderCategoryMenu(category: MenuCategory, prefix: string, commandContext: Pick<CommandContext, 'config'>): string {
  const { icon } = presentationFor(category.name)
  const lines = [
    `╭─〔 ${icon} *${categoryLabel(category)}* 〕`,
    `│ ${category.commands.length} command tersedia`,
    '╰────────────────────',
    '',
  ]
  category.commands.forEach((command, index) => lines.push(formatCommand(command, prefix, index + 1)))
  lines.push('', '━━━━━━━━━━━━━━━━━━━━', `Balas *${prefix}menu* untuk kembali ke menu utama.`)
  return [renderBotProfile(commandContext), '', ...lines].join('\n')
}

async function sendMenu(commandContext: CommandContext, body: string): Promise<void> {
  const sendMedia = commandContext.whatsapp.sendMedia
  const thumbnail = sendMedia ? await loadMenuThumbnail() : undefined
  if (sendMedia && thumbnail) {
    try {
      await sendMedia.call(commandContext.whatsapp, commandContext.message.remoteJid, {
        kind: 'image',
        data: thumbnail,
        mimeType: MENU_THUMBNAIL_MIME_TYPE,
        fileName: 'allybot-menu.jpg',
        caption: `${MENU_THUMBNAIL_CAPTION}\n\n${body}`,
      })
      return
    } catch (error) {
      commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'menu thumbnail delivery failed; using text fallback')
    }
  }
  await commandContext.reply(body)
}

export const menuPlugin: Plugin = {
  name: 'menu',
  version: '0.5.0',
  load(context) {
    const handleMenu = async (commandContext: CommandContext): Promise<void> => {
      const visibleCommands = context.commands.list().filter((command) => command.name !== 'menu' && !command.hidden)
      const categories = collectCategories(visibleCommands).filter((category) => canSeePrivilegedCategory(category, commandContext))
      const category = resolveCategory(categories, commandContext.args[0])
      const body = category
        ? renderCategoryMenu(category, commandContext.prefix, commandContext)
        : commandContext.args[0]
          ? `Kategori nomor *${commandContext.args[0]}* tidak ditemukan.\nBalas *${commandContext.prefix}menu* untuk melihat daftar kategori.`
          : renderMainMenu(categories, commandContext.prefix, commandContext)
      await sendMenu(commandContext, body)
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
