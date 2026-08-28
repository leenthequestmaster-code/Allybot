import type { CommandContext, Plugin } from '../contracts.js'

const SEARCH_COOLDOWN_MS = 5_000
const MAX_QUERY_LENGTH = 100

function usage(context: CommandContext, command: string, example: string): string {
  return `Format: ${context.prefix}${command} ${example}`
}

function boundText(value: string, max = MAX_QUERY_LENGTH): string | undefined {
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

export const toolsSearchPlugin: Plugin = {
  name: 'tools-search',
  version: '0.1.0',
  load(context) {
    context.commands.register({
      name: 'pin',
      aliases: ['pinterest'],
      description: 'Cari gambar di Pinterest',
      category: 'tools-search',
      menuOrder: 1,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '))
        if (!query) {
          await commandContext.reply(usage(commandContext, 'pin', '<kata kunci>') + '\nContoh: `!pin anime girl`')
          return
        }
        await commandContext.reply(`🔍 *Pinterest Search*\nQuery: ${query}\n\n⚠️ Fitur pencarian Pinterest memerlukan API key. Silakan gunakan browser untuk mencari: https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`)
      },
    })

    context.commands.register({
      name: 'pixiv',
      description: 'Cari ilustrasi di Pixiv',
      category: 'tools-search',
      menuOrder: 2,
      cooldownMs: SEARCH_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '))
        if (!query) {
          await commandContext.reply(usage(commandContext, 'pixiv', '<kata kunci>') + '\nContoh: `!pixiv fate saber`')
          return
        }
        await commandContext.reply(`🎨 *Pixiv Search*\nQuery: ${query}\n\n⚠️ Fitur pencarian Pixiv memerlukan API key. Silakan gunakan browser untuk mencari: https://www.pixiv.net/tags.php?tag=${encodeURIComponent(query)}`)
      },
    })
  },
}

export default toolsSearchPlugin