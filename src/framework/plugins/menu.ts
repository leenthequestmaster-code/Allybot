import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { CapabilityAwareButtonAdapter } from '../../platform/buttons.js'
import { TextInteractionAdapter } from '../../platform/interaction.js'
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

const PAGE_SIZE = 8
const MAIN_MENU_BUTTON_CATEGORY_COUNT = 2
const MENU_THUMBNAIL_MIME_TYPE = 'image/jpeg'
const MENU_THUMBNAIL_CAPTION = "Allybot's Menu — pilih kategori lewat tombol atau gunakan perintah teks."
const NATIVE_MENU_EXPIRY_MS = 5 * 60 * 1000

let menuThumbnailPromise: Promise<Uint8Array | undefined> | undefined

async function loadMenuThumbnail(): Promise<Uint8Array | undefined> {
  menuThumbnailPromise ??= readFile(new URL('../../assets/allybot-menu-thumbnail.jpg', import.meta.url))
    .then((data) => new Uint8Array(data))
    .catch(() => undefined)
  return menuThumbnailPromise
}

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
  economy: 'economy',
  general: 'your-character',
  governance: 'moderation',
  media: 'tools-media',
  personalization: 'your-character',
  roleplay: 'your-character',
  yourcharacter: 'your-character',
  search: 'tools-search',
  system: 'tools-media',
  utility: 'tools-media',
  sticker: 'tools-sticker',
}

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
  const description = commandDescription(command)
  return `𖥻 ׁ ׅ *${position}.* ${prefix}${command.name}${aliases}${accessMarker} — _${description}_`
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

function renderCategoryMenu(category: MenuCategory, prefix: string): string {
  const { icon, label } = presentationFor(category.name)
  const lines = [
    `𖥦 ׂׅ─── ꫶֗ ୨ ${icon} ୧ ꫶֗ ───ׂׅ`,
    `⿴⃟۪۪⃕᎒⃟ *𝐒𝘂𝗯𝗺𝗲𝗻𝘂: ${label}* ꕤꪆ`,
    '᠂᠂᠂ ───┈ ⸼ ⚝ ⸼ ┈─── ᠂᠂᠂',
    '',
    '_"Kamu ada di sini~ pilih salah satu ya!"_',
    '',
    `⑅ ⃞📄 *Pilihan* ::`,
    ...(category.commands.length > 0
      ? category.commands.map((command, index) => formatCommand(command, prefix, index + 1))
      : ['🚧 _Coming Soon — command untuk kategori ini belum tersedia._']),
    '─͜──͜──͜─ · ✦ · ─͜──͜──͜─',
    `📖◌ㅤ\`\`\`${prefix}menu\`\`\` ㅤkembali ke menu utama`,
    `📖◌ㅤ\`\`\`${prefix}help\`\`\` ㅤuntuk bantuan`,
    '━━━━━━━━━━━━━━━━━━━━',
    '*© Allyssea Roleplay Community*',
  ]
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

type MainMenuTarget =
  | { readonly kind: 'category'; readonly value: string }
  | { readonly kind: 'page'; readonly value: number }

type ActiveNativeMenu = {
  readonly expiresAt: number
  readonly prefix: string
  readonly page: number
  readonly totalPages: number
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

function buildLocationMenuBody(
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

function createCategoryButtons(
  pageCategories: readonly MenuCategory[],
  prefix: string,
): Array<{ id: string; label: string; description: string; availability: 'active' | 'disabled' }> {
  const buttons: Array<{ id: string; label: string; description: string; availability: 'active' | 'disabled' }> = []

  for (const category of pageCategories) {
    const token = randomUUID().replaceAll('-', '').slice(0, 16)
    const buttonId = `menu:${token}:${category.name}`
    const presentation = presentationFor(category.name)
    buttons.push({
      id: buttonId,
      label: `${presentation.icon} ${categoryLabel(category)}`,
      description: category.commands.length > 0
        ? `${category.commands.length} command tersedia`
        : 'Coming Soon',
      availability: 'active' as const,
    })
  }

  return buttons
}

function createNavigationButtons(
  page: number,
  totalPages: number,
  prefix: string,
): Array<{ id: string; label: string; description: string; availability: 'active' | 'disabled' }> {
  const buttons: Array<{ id: string; label: string; description: string; availability: 'active' | 'disabled' }> = []

  // Prev button - disabled on page 1
  if (page > 1) {
    const prevPage = page - 1
    const token = randomUUID().replaceAll('-', '').slice(0, 16)
    const buttonId = `menu:${token}:page:${prevPage}`
    buttons.push({
      id: buttonId,
      label: 'PREV',
      description: `Halaman ${prevPage}/${totalPages}`,
      availability: 'active' as const,
    })
  } else {
    const token = randomUUID().replaceAll('-', '').slice(0, 16)
    const buttonId = `menu:${token}:page:disabled:prev`
    buttons.push({
      id: buttonId,
      label: 'PREV',
      description: 'Halaman pertama',
      availability: 'disabled' as const,
    })
  }

  // Next button - disabled on last page
  if (page < totalPages) {
    const nextPage = page + 1
    const token = randomUUID().replaceAll('-', '').slice(0, 16)
    const buttonId = `menu:${token}:page:${nextPage}`
    buttons.push({
      id: buttonId,
      label: 'NEXT',
      description: `Halaman ${nextPage}/${totalPages}`,
      availability: 'active' as const,
    })
  } else {
    const token = randomUUID().replaceAll('-', '').slice(0, 16)
    const buttonId = `menu:${token}:page:disabled:next`
    buttons.push({
      id: buttonId,
      label: 'NEXT',
      description: 'Halaman terakhir',
      availability: 'disabled' as const,
    })
  }

  // Back button - disabled on page 1
  if (page > 1) {
    const token = randomUUID().replaceAll('-', '').slice(0, 16)
    const buttonId = `menu:${token}:page:1`
    buttons.push({
      id: buttonId,
      label: 'BACK',
      description: 'Kembali ke halaman 1',
      availability: 'active' as const,
    })
  } else {
    const token = randomUUID().replaceAll('-', '').slice(0, 16)
    const buttonId = `menu:${token}:page:disabled:back`
    buttons.push({
      id: buttonId,
      label: 'BACK',
      description: 'Sudah di halaman pertama',
      availability: 'disabled' as const,
    })
  }

  return buttons
}

export const menuPlugin: Plugin = {
  name: 'menu',
  version: '0.4.0',
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
      const sendMedia = commandContext.whatsapp.sendMedia
      const sendLocation = commandContext.whatsapp.sendLocation
      const thumbnail = sendMedia ? await loadMenuThumbnail() : undefined

      const sendThumbnail = async (caption: string): Promise<boolean> => {
        if (!sendMedia || !thumbnail) return false
        try {
          await sendMedia.call(commandContext.whatsapp, commandContext.message.remoteJid, {
            kind: 'image',
            data: thumbnail,
            mimeType: MENU_THUMBNAIL_MIME_TYPE,
            caption,
          })
          return true
        } catch (error) {
          commandContext.logger.warn({ err: error }, 'menu thumbnail unavailable; continuing with text/native menu')
          return false
        }
      }

      const orderedCategories = mainMenuButtonCategories(categories)
      const { page, totalPages, pageCategories } = mainMenuPage(orderedCategories, requestedPage)

      if (pageCategories.length === 0) {
        await commandContext.reply(fallbackText)
        return
      }

      // Try Location Type message first (single bubble with thumbnail + text)
      if (sendLocation) {
        try {
          const locationBody = buildLocationMenuBody(categories, page, totalPages, pageCategories, commandContext.prefix)

          await sendLocation.call(commandContext.whatsapp, commandContext.message.remoteJid, {
            degreesLatitude: -6.2088, // Jakarta coordinates as placeholder
            degreesLongitude: 106.8456,
            name: "Allybot's Menu",
            address: locationBody,
            contextInfo: {
              externalAdReply: {
                showAdAttribution: false,
                title: "𝐀𝗹𝗹𝘆𝗯𝗼𝘁'𝘀 𝐌𝗲𝗻𝘂",
                body: `_\"Nyahoo~!! Allybot disini. Ada yang bisa dibantu tuan atau nona penyintas?\"_`,
                mediaType: 1, // Image
                thumbnail,
                thumbnailUrl: undefined,
                sourceUrl: undefined,
              },
            },
          })

          // Send navigation buttons as native quick replies
          if (sendNativeQuickReplies) {
            const categoryButtons = createCategoryButtons(pageCategories, commandContext.prefix)
            const navButtons = createNavigationButtons(page, totalPages, commandContext.prefix)
            const allButtons = [...categoryButtons, ...navButtons]

            const targets = new Map<string, MainMenuTarget>()
            for (const [index, btn] of categoryButtons.entries()) {
              const category = pageCategories[index]
              if (category) targets.set(btn.id, { kind: 'category', value: category.name })
            }
            for (const btn of navButtons) {
              if (btn.id.includes('page:')) {
                const pageMatch = btn.id.match(/page:(\d+|disabled:(prev|next|back))/)
                if (pageMatch) {
                  const pageValue = pageMatch[1]
                  if (pageValue.startsWith('disabled')) {
                    targets.set(btn.id, { kind: 'page', value: page }) // stays on current page
                  } else {
                    targets.set(btn.id, { kind: 'page', value: Number(pageValue) })
                  }
                }
              }
            }

            const expiresAt = Date.now() + NATIVE_MENU_EXPIRY_MS

            await sendNativeQuickReplies.call(commandContext.whatsapp, commandContext.message.remoteJid, {
              type: 'native_quick_reply',
              body: `Halaman ${page}/${totalPages}`,
              footer: `Ketik ${commandContext.prefix}menu <angka> untuk navigasi manual`,
              buttons: allButtons.map(b => ({ id: b.id, title: b.label })),
            })

            activeNativeMenus.set(commandContext.message.remoteJid, {
              expiresAt,
              prefix: commandContext.prefix,
              page,
              totalPages,
              targets,
            })

            while (activeNativeMenus.size > 1000) {
              const oldest = activeNativeMenus.keys().next().value
              if (!oldest) break
              activeNativeMenus.delete(oldest)
            }

            return
          }
        } catch (error) {
          commandContext.logger.warn({ err: error }, 'Location menu failed; falling back to native quick replies')
        }
      }

      // Fallback to native quick replies with thumbnail
      if (sendNativeQuickReplies) {
        const categoryButtons = createCategoryButtons(pageCategories, commandContext.prefix)
        const navButtons = createNavigationButtons(page, totalPages, commandContext.prefix)
        const allButtons = [...categoryButtons, ...navButtons]

        const targets = new Map<string, MainMenuTarget>()
        for (let i = 0; i < categoryButtons.length; i++) {
          const btn = categoryButtons[i]
          const category = pageCategories[i]
          if (category) {
            targets.set(btn.id, { kind: 'category', value: category.name })
          }
        }
        for (const btn of navButtons) {
          if (btn.id.includes('page:')) {
            const pageMatch = btn.id.match(/page:(\d+|disabled:(prev|next|back))/)
            if (pageMatch) {
              const pageValue = pageMatch[1]
              if (pageValue.startsWith('disabled')) {
                targets.set(btn.id, { kind: 'page', value: page })
              } else {
                targets.set(btn.id, { kind: 'page', value: Number(pageValue) })
              }
            }
          }
        }

        const expiresAt = Date.now() + NATIVE_MENU_EXPIRY_MS

        try {
          await sendThumbnail(MENU_THUMBNAIL_CAPTION)

          await sendNativeQuickReplies.call(commandContext.whatsapp, commandContext.message.remoteJid, {
            type: 'native_quick_reply',
            body: buildLocationMenuBody(categories, page, totalPages, pageCategories, commandContext.prefix),
            footer: `Ketik ${commandContext.prefix}menu <angka> untuk navigasi manual`,
            buttons: allButtons.map(b => ({ id: b.id, title: b.label })),
          })

          activeNativeMenus.set(commandContext.message.remoteJid, {
            expiresAt,
            prefix: commandContext.prefix,
            page,
            totalPages,
            targets,
          })

          while (activeNativeMenus.size > 1000) {
            const oldest = activeNativeMenus.keys().next().value
            if (!oldest) break
            activeNativeMenus.delete(oldest)
          }

          return
        } catch (error) {
          activeNativeMenus.delete(commandContext.message.remoteJid)
          commandContext.logger.warn({ err: error }, 'native menu send failed; using text fallback')
        }
      }

      // Final fallback: text menu
      if (!(await sendThumbnail(fallbackText))) {
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
          "⿴⃟۪۪⃕᎒⃟ *𝐀𝗹𝗹𝘆𝗯𝗼𝘁'𝐌𝐞𝐧𝐮* ꕤꪆ",
          '',
          `Kategori *${args[0]}* tidak ditemukan.`,
          `Ketik \`\`\`${prefix}menu\`\`\` untuk melihat Listmenu.`,
          '━━━━━━━━━━━━━━━━━━━━',
          '*© Allyssea Roleplay Community*',
        ].join('\n'))
        return
      }

      // Sub-menu: single bubble, full text, no pagination
      await reply(renderCategoryMenu(category, prefix))
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

        // Handle disabled buttons - they just stay on current page
        if (buttonId.includes('disabled')) {
          return
        }

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