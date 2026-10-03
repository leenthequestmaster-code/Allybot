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
          await ctx.reply(`Ketik ID atau kategorinya ya.\n\n📚 *Kategori yang ada:*\n_${listKategori}_\n\nContoh: \`!doa sebelum-tidur\` (spesifik) atau \`!doa tidur\` (random dari kategori)`)
          return
        }

        // Cari berdasarkan id pasti dulu
        let matched = DOA_LIST.filter(d => d.id === query)
        
        // Kalau ga ketemu, cari berdasarkan kategori
        if (matched.length === 0) {
          matched = DOA_LIST.filter(d => d.kategori === query)
        }

        if (matched.length === 0) {
          await ctx.reply(`Doa atau kategorinya nggak ketemu nih.\n\n📚 *Kategori yang ada:*\n_${listKategori}_`)
          return
        }

        // Kalau match banyak (kategori), ambil satu random
        const selected = matched[Math.floor(Math.random() * matched.length)]

        const message = [
          '𓏼 *`𝐃𝗼𝗮 𝐇𝗮𝗿𝗶𝗮𝗻`*',
          '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
          `⡇╌ *Judul* : ${selected.judul}`,
          '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
          `${selected.arab}`,
          '',
          `_${selected.latin}_`,
          '',
          `> "${selected.arti}"`,
          '━━━━━━━━━━━━━━━━━━━━',
          `*Sumber* : ${selected.sumber}`,
        ].join('\n')
                        
        await ctx.reply(message)
      },
    })
  },
}
