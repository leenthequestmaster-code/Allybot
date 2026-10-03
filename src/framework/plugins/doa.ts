import type { Plugin, PluginContext, CommandContext } from '../contracts.js'
import { DOA_LIST } from '../../services/doa-data.js'

export const doaPlugin: Plugin = {
  name: 'doa',
  version: '1.0.0',
  
  load: (context: PluginContext) => {
    context.commands.register({
      name: 'doa',
      description: 'Baca doa harian berdasarkan kategori',
      category: 'utility',
      
      handler: async (ctx: CommandContext) => {
        const query = ctx.args.join(' ').trim().toLowerCase()
        
        // Ambil semua kategori unik
        const kategoriSet = new Set<string>()
        DOA_LIST.forEach(d => kategoriSet.add(d.kategori))
        const listKategori = Array.from(kategoriSet).join(', ')

        if (!query) {
          await ctx.reply(`Ketik ID doa atau kategorinya.\n\nKategori yang ada: ${listKategori}\n\nContoh: !doa sebelum-tidur (spesifik) atau !doa tidur (random dari kategori)`)
          return
        }

        // Cari berdasarkan id pasti dulu
        let matched = DOA_LIST.filter(d => d.id === query)
        
        // Kalau ga ketemu, cari berdasarkan kategori
        if (matched.length === 0) {
          matched = DOA_LIST.filter(d => d.kategori === query)
        }

        if (matched.length === 0) {
          await ctx.reply(`Doa atau kategori itu nggak ketemu.\n\nKategori yang ada: ${listKategori}`)
          return
        }

        // Kalau match banyak (kategori), ambil satu random
        const selected = matched[Math.floor(Math.random() * matched.length)]

        const message = `🤲 *${selected.judul}*\n\n` +
                        `${selected.arab}\n\n` +
                        `_${selected.latin}_\n\n` +
                        `"${selected.arti}"\n\n` +
                        `📚 Sumber: ${selected.sumber}`
                        
        await ctx.reply(message)
      },
    })
  },
}
