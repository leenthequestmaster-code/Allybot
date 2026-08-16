import type { CommandDefinition, Plugin } from '../contracts.js'

type MenuCategory = {
  readonly name: string
  readonly commands: readonly CommandDefinition[]
}

type CategoryPresentation = {
  readonly label: string
  readonly icon: string
}

const PAGE_SIZE = 8

const categoryPresentation: Record<string, CategoryPresentation> = {
  general: { label: 'GENERAL', icon: '🏠' },
  system: { label: 'SYSTEM', icon: '⚙️' },
  group: { label: 'GROUP', icon: '👥' },
  tools: { label: 'TOOLS', icon: '🔧' },
  download: { label: 'DOWNLOAD', icon: '📥' },
  ai: { label: 'AI', icon: '🤖' },
  creativity: { label: 'CREATIVITY', icon: '🎨' },
  rpg: { label: 'RPG', icon: '⚔️' },
  search: { label: 'SEARCH', icon: '🔎' },
  owner: { label: 'OWNER', icon: '👑' },
}

function normalizeCategory(command: CommandDefinition): string {
  const category = command.category?.trim().toLowerCase()
  return category && /^[a-z][a-z0-9_-]{0,31}$/.test(category) ? category : 'general'
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

  return [...grouped.entries()]
    .map(([name, categoryCommands]) => ({ name, commands: sortCommands(categoryCommands) }))
    .sort((left, right) => left.name.localeCompare(right.name))
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
        `𖥻 ׁ ׅ *${index + 1}.* ${icon} ${categoryLabel(category)} — _${commandCount} command tersedia_`,
      )
    }
  }

  lines.push(
    '─͜──͜──͜─ · ✦ · ─͜──͜──͜─',
    `📖◌ㅤ\`\`\`${prefix}help\`\`\``,
    `> _Ketik nomor kategori melalui ${prefix}menu <angka> atau ${prefix}menu <kategori> untuk memilih sub menu._`,
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
    ...pageCommands.map((command, index) => formatCommand(command, prefix, start + index + 1)),
    '─͜──͜──͜─ · ✦ · ─͜──͜──͜─',
    `📖◌ㅤ\`\`\`${prefix}back\`\`\` ㅤkembali ke menu utama`,
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

function resolveCategory(categories: readonly MenuCategory[], identifier: string | undefined): MenuCategory | undefined {
  if (!identifier) return undefined
  if (/^\d+$/.test(identifier)) return categories[Number(identifier) - 1]
  return categories.find((category) => category.name === identifier.toLowerCase())
}

export const menuPlugin: Plugin = {
  name: 'menu',
  version: '0.3.0',
  load(context) {
    context.commands.register({
      name: 'menu',
      aliases: ['m', 'help', 'back'],
      description: 'Show Allybot categories and available commands',
      category: 'system',
      menuOrder: 1,
      hidden: true,
      cooldownMs: 3000,
      handler: async ({ args, prefix, reply }) => {
        const commands = context.commands
          .list()
          .filter((command) => command.name !== 'menu' && !command.hidden)
        const categories = collectCategories(commands)
        const category = resolveCategory(categories, args[0])

        if (!args[0]) {
          await reply(renderMainMenu(categories, prefix))
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
      },
    })
  },
}

export default menuPlugin
