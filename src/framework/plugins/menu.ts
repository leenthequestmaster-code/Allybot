import { readFile } from 'node:fs/promises'
import { proto, prepareWAMessageMedia, type WASocket } from '@whiskeysockets/baileys'
import type { CommandContext, CommandDefinition, Plugin } from '../contracts.js'
import type { DeveloperModeService } from '../../services/developer-mode-service.js'
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
  roleplay: { label: 'ROLEPLAY', icon: '🎭' },
  'your-character': { label: 'YOUR CHARACTER', icon: '🎭' },
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
  bank: 'your-character',
  creativity: 'fun',
  download: 'tools-media',
  economy: 'your-character',
  general: 'your-character',
  governance: 'moderation',
  media: 'tools-media',
  personalization: 'your-character',
  roleplay: 'roleplay',
  rpg: 'roleplay',
  scene: 'roleplay',
  search: 'tools-search',
  sticker: 'tools-sticker',
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

function renderCategoryMenu(category: MenuCategory, prefix: string, commandContext: Pick<CommandContext, 'config'>): string {
  const { icon } = presentationFor(category.name)
  const lines = [
    `${icon} *${categoryLabel(category)}*`,
    `_${category.commands.length} command tersedia_`,
    '',
  ]
  category.commands.forEach((command, index) => lines.push(formatCommand(command, prefix, index + 1)))
  lines.push(
    '',
    ':::tip',
    `Ketik nama command dengan prefix ${prefix} untuk menggunakannya. Balas ${prefix}menu untuk kembali ke menu utama.`,
    ':::',
    '',
    ':::suggest',
    `${prefix}menu | ${prefix}commands | ${prefix}help`,
    ':::',
    '',
    `Balas *${prefix}menu* untuk kembali ke menu utama.`,
  )
  return [renderBotProfile(), '', ...lines].join('\n')
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

    if (buttonLimit < 10) {
      builder.button({
        type: 'reply',
        id: `${prefix}commands`,
        text: '📚 Semua Command',
      })
    }

    await builder.send(commandContext.whatsapp as any)
    return
  }

  if (options?.category) {
    // In group chats, WhatsApp servers reject botInvokeMessage with 479, so we deliver
    // interactive messages with action buttons and thumbnail. In private chats, AIRich delivers
    // structured presentation with chips/tips natively.
    if (isGroupJid(jid)) {
      const { icon } = presentationFor(options.category.name)
      const builder = MsgBuilder.to(jid)
        .header(`${icon} ${categoryLabel(options.category)}`, `${options.category.commands.length} command tersedia`)
        .text(body)
        .footer(`Balas ${prefix}menu untuk kembali ke menu utama`)
        .button({ type: 'reply', id: `${prefix}menu`, text: '📋 Menu Utama' })
        .button({ type: 'reply', id: `${prefix}commands`, text: '📚 Semua Command' })

      if (thumbnail) {
        builder.image(thumbnail, MENU_THUMBNAIL_MIME_TYPE)
      }

      await builder.send(commandContext.whatsapp as any)
      return
    }

    const builder = MsgBuilder.to(jid).text(body, { rich: true })
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
      const categories = collectCategories(visibleCommands).filter((category) => canSeePrivilegedCategory(category, commandContext))
      const category = resolveCategory(categories, commandContext.args[0])
      const thumbnail = await loadMenuThumbnail()

      if (category) {
        const body = renderCategoryMenu(category, commandContext.prefix, commandContext)
        await sendMenu(commandContext, body, { category, prefix: commandContext.prefix, thumbnail })
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
