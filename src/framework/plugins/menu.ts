import { randomUUID } from 'node:crypto'
import { CapabilityAwareButtonAdapter } from '../../platform/buttons.js'
import { TextInteractionAdapter } from '../../platform/interaction.js'
import type { CommandContext, CommandDefinition, Plugin } from '../contracts.js'
import type { DeveloperModeService } from '../../services/developer-mode-service.js'

type MenuCategory = {
  readonly name: string
  readonly commands: readonly CommandDefinition[]
}

type CategoryPresentation = {
  readonly label: string
  readonly icon: string
}

const PAGE_SIZE = 8
const MAIN_MENU_BUTTON_CATEGORY_COUNT = 2

const categoryPresentation: Record<string, CategoryPresentation> = {
  group: { label: 'GROUP', icon: '👥' },
  moderation: { label: 'MODERATION', icon: '🛡️' },
  roleplay: { label: 'ROLEPLAY', icon: '🎭' },
  personal: { label: 'PERSONAL', icon: '🪪' },
  tools: { label: 'TOOLS', icon: '🧰' },
  fun: { label: 'FUN', icon: '🎲' },
  developer: { label: 'DEVELOPER', icon: '🛠️' },
  owner: { label: 'OWNER', icon: '👑' },
}

const CATEGORY_ALIASES: Record<string, string> = {
  ai: 'tools',
  collaboration: 'group',
  community: 'group',
  creativity: 'fun',
  download: 'tools',
  economy: 'roleplay',
  events: 'group',
  general: 'personal',
  governance: 'moderation',
  knowledge: 'roleplay',
  media: 'tools',
  personalization: 'personal',
  rpg: 'roleplay',
  search: 'tools',
  system: 'tools',
  utility: 'tools',
}

const ROADMAP_CATEGORY_NAMES = [
  'group',
  'moderation',
  'roleplay',
  'personal',
  'tools',
  'fun',
  'developer',
  'owner',
] as const

function normalizeCategory(command: CommandDefinition): string {
  const category = command.category?.trim().toLowerCase()
  if (!category || !/^[a-z][a-z0-9_-]{0,31}$/.test(category)) return 'personal'
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
    const category = normalizeCategory(command)
    const existing = grouped.get(category)
    if (existing) existing.push(command)
    else grouped.set(category, [command])
  }

  for (const name of ROADMAP_CATEGORY_NAMES) {
    if (!grouped.has(name)) grouped.set(name, [])
  }

  return [...grouped.entries()]
    .map(([name, categoryCommands]) => ({ name, commands: sortCommands(categoryCommands) }))
    .sort((left, right) => ROADMAP_CATEGORY_NAMES.indexOf(left.name as typeof ROADMAP_CATEGORY_NAMES[number]) - ROADMAP_CATEGORY_NAMES.indexOf(right.name as typeof ROADMAP_CATEGORY_NAMES[number]))
}

function presentationFor(category: string): CategoryPresentation {
  return categoryPresentation[category] ?? { label: category.toUpperCase(), icon: '📂' }
}

function categoryLabel(category: MenuCategory): string {
  return presentationFor(category.name).label
}

function formatCommand(command: CommandDefinition, prefix: string, position: number): string {
  const aliases = command.aliases?.length
    ? ` (${command.aliases.map((alias) => `${prefix}${alias}`).join(', ')})`
    : ''
  const accessMarker = command.permission ? ' 🔒' : ''
  const description = command.description ?? 'Tidak ada deskripsi.'
  return `𖥻 ׁ ׅ *${position}.* ${prefix}${command.name}${aliases}${accessMarker} — _${description}_`
}

function renderNativeMainMenuBody(
  categories: readonly MenuCategory[],
  page: number,
  totalPages: number,
  pageCategories: readonly MenuCategory[],
  prefix: string,
): string {
  const lines = [
    `📚 *Listmenu* · Halaman ${page}/${totalPages}`,
    `Kategori pada tombol ini: ${pageCategories.map(categoryLabel).join(' · ')}`,
    '',
    ...categories.map((category, index) => {
      const { icon } = presentationFor(category.name)
      const availability = category.commands.length > 0
        ? `${category.commands.length} command tersedia`
        : 'Coming Soon'
      return `${index + 1}. ${icon} ${categoryLabel(category)} — _${availability}_`
    }),
    '',
    'Tekan tombol untuk membuka submenu kategori. Tombol hanya untuk navigasi; command tetap diketik sesuai kebutuhan.',
    `Fallback teks: ketik \`${prefix}menu <angka>\` atau balas menu dengan angka.`,
  ]
  return lines.join('\n')
}

function renderMainMenu(categories: readonly MenuCategory[], prefix: string): string {
  const lines = [
    '𖥦 ׂׅ─── ꫶֗ ୨ 🤖 ୧ ꫶֗ ───ׂׅ',
    "⿴⃟۪۪⃕᎒⃟ *𝐀𝗹𝗹𝘆𝗯𝗼𝘁'𝘀 𝐌𝗲𝗻𝘂* ꕤꪆ",
    '᠂᠂᠂ ───┈ ⸼ ⚝ ⸼ ┈─── ᠂᠂᠂',
    '',
    '_"Nyahoo~!! Allybot disini. Ada yang bisa dibantu tuan atau nona penyintas?"_',
    '',
    '⑅ ⃞📚 *Listmenu* ::',
  ]

  if (categories.length === 0) {
    lines.push('𖥻 ׁ ׅ *Belum ada kategori* — _Belum ada command yang tersedia._')
  } else {
    for (const [index, category] of categories.entries()) {
      const { icon } = presentationFor(category.name)
      const commandCount = category.commands.length
      lines.push(
        commandCount > 0
          ? `𖥻 ׁ ׅ *${index + 1}.* ${icon} ${categoryLabel(category)} — _${commandCount} command tersedia_`
          : `𖥻 ׁ ׅ *${index + 1}.* ${icon} ${categoryLabel(category)} — _Coming Soon_`,
      )
    }
  }

  lines.push(
    '─͜──͜──͜─ · ✦ · ─͜──͜──͜─',
    `📖◌ㅤ\`\`\`${prefix}help\`\`\``,
    `> _Ketik \`\`\`${prefix}menu <angka>\`\`\` atau \`\`\`${prefix}menu <kategori> untuk memilih sub menu._`,
    '> _Atau balas pesan menu ini dengan angka kategorinya._',
    '━━━━━━━━━━━━━━━━━━━━',
    '*© Allyssea Roleplay Community*',
  )
  return lines.join('\n')
}

function renderCategoryMenu(category: MenuCategory, requestedPage: number, prefix: string): string {
  const { icon, label } = presentationFor(category.name)
  const totalPages = Math.max(1, Math.ceil(category.commands.length / PAGE_SIZE))
  const page = Math.min(Math.max(requestedPage, 1), totalPages)
  const start = (page - 1) * PAGE_SIZE
  const pageCommands = category.commands.slice(start, start + PAGE_SIZE)
  const lines = [
    `𖥦 ׂׅ─── ꫶֗ ୨ ${icon} ୧ ꫶֗ ───ׂׅ`,
    `⿴⃟۪۪⃕᎒⃟ *𝐒𝘂𝗯𝗺𝗲𝗻𝘂: ${label}* ꕤꪆ`,
    '᠂᠂᠂ ───┈ ⸼ ⚝ ⸼ ┈─── ᠂᠂᠂',
    '',
    '_"Kamu ada di sini~ pilih salah satu ya!"_',
    '',
    `⑅ ⃞📄 *Pilihan* :: ${totalPages > 1 ? `_Halaman ${page}/${totalPages}_` : ''}`.trim(),
    ...(pageCommands.length > 0
      ? pageCommands.map((command, index) => formatCommand(command, prefix, start + index + 1))
      : ['🚧 _Coming Soon — command untuk kategori ini belum tersedia._']),
    '─͜──͜──͜─ · ✦ · ─͜──͜──͜─',
    `📖◌ㅤ\`\`\`${prefix}menu\`\`\` ㅤkembali ke menu utama`,
    `📖◌ㅤ\`\`\`${prefix}help\`\`\` ㅤuntuk bantuan`,
  ]

  if (totalPages > 1) {
    lines.push(`📖◌ㅤ\`\`\`${prefix}menu ${category.name} ${page < totalPages ? page + 1 : 1}\`\`\` ㅤhalaman ${page < totalPages ? page + 1 : 1}/${totalPages}`)
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━', '*© Allyssea Roleplay Community*')
  return lines.join('\n')
}

function parsePage(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) return 1
  return Math.max(1, Number(value))
}

function isMainMenuQuote(value: string | undefined): value is string {
  if (!value) return false
  return value.includes("𝐀𝗹𝗹𝘆𝗯𝗼𝘁'𝘀 𝐌𝗲𝗻𝘂") && value.includes('Listmenu') && !value.includes('𝐒𝘂𝗯𝗺𝗲𝗻𝘂:')
}

function prefixFromMenuQuote(value: string, fallback: string): string {
  const match = value.match(/```([^`\s]+)help```/)
  return match?.[1] ?? fallback
}

function resolveCategory(categories: readonly MenuCategory[], identifier: string | undefined): MenuCategory | undefined {
  if (!identifier) return undefined
  if (/^\d+$/.test(identifier)) return categories[Number(identifier) - 1]
  const normalized = identifier.toLowerCase()
  const canonical = CATEGORY_ALIASES[normalized] ?? normalized
  return categories.find((category) => category.name === canonical)
}

function normalizeJid(value?: string): string | undefined {
  if (!value) return undefined
  const bare = value.split(':')[0]
  return bare.includes('@') ? bare : `${bare}@s.whatsapp.net`
}

function isBotOwner(commandContext: Pick<CommandContext, 'message' | 'config'>): boolean {
  const sender = normalizeJid(commandContext.message.senderJid)
  const owner = normalizeJid(commandContext.config.botOwnerJid)
  return Boolean(sender && owner && sender === owner)
}

function canSeePrivilegedCategory(category: MenuCategory, commandContext: Pick<CommandContext, 'message' | 'config' | 'services'>): boolean {
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

const NATIVE_MENU_EXPIRY_MS = 5 * 60 * 1000

type MainMenuTarget =
  | { readonly kind: 'category'; readonly value: string }
  | { readonly kind: 'page'; readonly value: number }

type ActiveNativeMenu = {
  readonly expiresAt: number
  readonly prefix: string
  readonly targets: ReadonlyMap<string, MainMenuTarget>
}

function mainMenuButtonCategories(categories: readonly MenuCategory[]): MenuCategory[] {
  return [
    ...categories.filter((category) => category.commands.length > 0),
    ...categories.filter((category) => category.commands.length === 0),
  ]
}

function mainMenuPage(categories: readonly MenuCategory[], requestedPage: number): {
  readonly page: number
  readonly totalPages: number
  readonly pageCategories: readonly MenuCategory[]
} {
  const totalPages = Math.max(1, Math.ceil(categories.length / MAIN_MENU_BUTTON_CATEGORY_COUNT))
  const page = Math.min(Math.max(requestedPage, 1), totalPages)
  const start = (page - 1) * MAIN_MENU_BUTTON_CATEGORY_COUNT
  return {
    page,
    totalPages,
    pageCategories: categories.slice(start, start + MAIN_MENU_BUTTON_CATEGORY_COUNT),
  }
}

export const menuPlugin: Plugin = {
  name: 'menu',
  version: '0.3.0',
  load(context) {
    const textInteraction = new TextInteractionAdapter()
    const buttonInteraction = new CapabilityAwareButtonAdapter(textInteraction)
    const activeNativeMenus = new Map<string, ActiveNativeMenu>()

    const sendMainMenu = async (
      commandContext: CommandContext,
      categories: readonly MenuCategory[],
      fallbackText: string,
      requestedPage = 1,
    ): Promise<void> => {
      const sendNativeQuickReplies = commandContext.whatsapp.sendNativeQuickReplies
      if (!sendNativeQuickReplies) {
        await commandContext.reply(fallbackText)
        return
      }

      const orderedCategories = mainMenuButtonCategories(categories)
      const { page, totalPages, pageCategories } = mainMenuPage(orderedCategories, requestedPage)
      if (pageCategories.length === 0) {
        await commandContext.reply(fallbackText)
        return
      }

      const expiresAt = Date.now() + NATIVE_MENU_EXPIRY_MS
      const targets = new Map<string, MainMenuTarget>()
      const items = pageCategories.map((category) => {
        const token = randomUUID().replaceAll('-', '').slice(0, 16)
        const buttonId = `menu:${token}:${category.name}`
        targets.set(buttonId, { kind: 'category', value: category.name })
        const presentation = presentationFor(category.name)
        return {
          id: buttonId,
          label: `${presentation.icon} ${categoryLabel(category)}`,
          description: category.commands.length > 0
            ? `${category.commands.length} command tersedia`
            : 'Coming Soon',
          availability: 'active' as const,
        }
      })

      if (totalPages > 1) {
        const nextPage = page < totalPages ? page + 1 : 1
        const token = randomUUID().replaceAll('-', '').slice(0, 16)
        const buttonId = `menu:${token}:page:${nextPage}`
        targets.set(buttonId, { kind: 'page', value: nextPage })
        items.push({
          id: buttonId,
          label: 'NEXT',
          description: `Halaman ${nextPage}/${totalPages}`,
          availability: 'active' as const,
        })
      }

      const interactionMenu = {
        id: `menu:main:${page}`,
        version: 1,
        kind: 'menu' as const,
        title: "Allybot's Menu",
        body: renderNativeMainMenuBody(categories, page, totalPages, pageCategories, commandContext.prefix),
        items,
        fallbackText: `Atau ketik ${commandContext.prefix}menu <angka> untuk melihat semua kategori.`,
        expiresAt,
      }

      const rendered = await buttonInteraction.render(interactionMenu, { nativeQuickReply: true })
      if (rendered.mode !== 'native') {
        await commandContext.reply(fallbackText)
        return
      }

      try {
        await sendNativeQuickReplies.call(commandContext.whatsapp, commandContext.message.remoteJid, {
          ...rendered.payload,
          footer: `Fallback: ${commandContext.prefix}menu <angka>`,
        })
        activeNativeMenus.set(commandContext.message.remoteJid, {
          expiresAt,
          prefix: commandContext.prefix,
          targets,
        })
        while (activeNativeMenus.size > 1000) {
          const oldest = activeNativeMenus.keys().next().value
          if (!oldest) break
          activeNativeMenus.delete(oldest)
        }
      } catch (error) {
        activeNativeMenus.delete(commandContext.message.remoteJid)
        commandContext.logger.warn({ err: error }, 'native menu send failed; using text fallback')
        await commandContext.reply(fallbackText)
      }
    }

    const handleMenu = async ({ args, prefix, reply, ...commandContext }: CommandContext): Promise<void> => {
      const commands = context.commands
        .list()
        .filter((command) => command.name !== 'menu' && !command.hidden)
      const categories = collectCategories(commands)
        .filter((category) => canSeePrivilegedCategory(category, commandContext))
      const category = resolveCategory(categories, args[0])
      const fallbackText = renderMainMenu(categories, prefix)

      if (!args[0]) {
        await sendMainMenu({ ...commandContext, args, prefix, reply }, categories, fallbackText)
        return
      }

      if (args[0].toLowerCase() === 'page') {
        await sendMainMenu({ ...commandContext, args, prefix, reply }, categories, fallbackText, parsePage(args[1]))
        return
      }

      if (!category) {
        await reply([
          '𖥦 ׂׅ─── ꫶֗ ୨ 🤖 ୧ ꫶֗ ───ׂׅ',
          "⿴⃟۪۪⃕᎒⃟ *𝐀𝗹𝗹𝘆𝗯𝗼𝘁'𝘀 𝐌𝗲𝗻𝘂* ꕤꪆ",
          '',
          `Kategori *${args[0]}* tidak ditemukan.`,
          `Ketik \`\`\`${prefix}menu\`\`\` untuk melihat Listmenu.`,
          '━━━━━━━━━━━━━━━━━━━━',
          '*© Allyssea Roleplay Community*',
        ].join('\n'))
        return
      }

      await reply(renderCategoryMenu(category, parsePage(args[1]), prefix))
    }

    context.commands.register({
      name: 'menu',
      aliases: ['m', 'help'],
      description: 'Show Allybot categories and available commands',
      category: 'system',
      menuOrder: 1,
      hidden: true,
      cooldownMs: 3000,
      handler: handleMenu,
    })

    context.commands.register({
      name: 'menu-reply',
      description: 'Internal menu reply navigation',
      category: 'system',
      hidden: true,
      cooldownMs: 0,
      handler: handleMenu,
    })

    context.events.on('message.received', async (message) => {
      if (message.fromMe) return

      const buttonId = message.buttonId?.trim()
      if (buttonId) {
        const activeMenu = activeNativeMenus.get(message.remoteJid)
        if (!activeMenu) return
        if (Date.now() >= activeMenu.expiresAt) {
          activeNativeMenus.delete(message.remoteJid)
          return
        }

        const target = activeMenu.targets.get(buttonId)
        if (!target) return
        activeNativeMenus.delete(message.remoteJid)
        const text = target.kind === 'category'
          ? `${activeMenu.prefix}menu-reply ${target.value}`
          : `${activeMenu.prefix}menu-reply page ${target.value}`
        await context.commands.dispatch({
          ...message,
          senderJid: undefined,
          text,
        })
        return
      }

      const selection = message.text?.trim()
      if (!selection || !/^\d+$/.test(selection) || !isMainMenuQuote(message.quotedText)) return

      const prefix = prefixFromMenuQuote(message.quotedText, context.config.commandPrefix)
      await context.commands.dispatch({
        ...message,
        senderJid: undefined,
        text: `${prefix}menu-reply ${selection}`,
      })
    })
  },
}

export default menuPlugin
