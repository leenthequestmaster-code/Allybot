import type { Plugin, PluginContext, CommandContext } from '../contracts.js'
import { getAyat } from '../../services/quran-api.js'

export const quranPlugin: Plugin = {
  name: 'quran',
  version: '1.0.0',
  
  load: (context: PluginContext) => {
    context.commands.register({
      name: 'quran',
      description: 'Baca ayat Quran beserta terjemahannya',
      category: 'utility',
      
      handler: async (ctx: CommandContext) => {
        const query = ctx.args.join(' ').trim()
        
        if (!query) {
          await ctx.reply('Ketik surah sama ayatnya ya. Contoh: `!quran 2:255`')
          return
        }
        
        const match = query.match(/^(\d+):(\d+)$/)
        if (!match) {
          await ctx.reply('Formatnya kurang pas. Pake titik dua ya, contoh: `!quran 2:255`')
          return
        }

        const surah = parseInt(match[1]!, 10)
        const ayat = parseInt(match[2]!, 10)

        try {
          const result = await getAyat(surah, ayat)
          
          const message = `📖 *${result.surah_name} : ${result.nomor_ayat}*\n` +
                          `━━━━━━━━━━━━━━━━━━\n` +
                          `${result.arab}\n\n` +
                          `_${result.latin}_\n\n` +
                          `> "${result.arti}"\n` +
                          `━━━━━━━━━━━━━━━━━━`
                          
          await ctx.reply(message)
        } catch (err: any) {
          // Send specific validation error to user or generic network error
          await ctx.reply(err.message || 'Waduh, servernya lagi penuh nih. Coba tes bentar lagi ya.')
        }
      },
    })
  },
}
