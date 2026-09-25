import type { CommandContext, Plugin } from '../contracts.js'
import type { WebCompanionService } from '../../services/web-companion-service.js'

export const webCompanionPlugin: Plugin = {
  name: 'web-companion',
  version: '0.1.0',
  load(context) {
    context.commands.register({
      name: 'web',
      aliases: ['dashboard', 'sheet', 'kartu', 'companion'],
      description: 'Buka Web Companion interaktif di browser HP',
      category: 'your-character',
      menuOrder: 2,
      cooldownMs: 5_000,
      handler: async (commandContext: CommandContext) => {
        const sender = commandContext.message.senderJid
        if (!sender) {
          await commandContext.reply('Identitas pengirim tidak valid.')
          return
        }

        const isGroup = commandContext.message.remoteJid.endsWith('@g.us')
        const groupJid = isGroup ? commandContext.message.remoteJid : undefined

        if (!context.services.has('web-companion')) {
          await commandContext.reply('Web Companion sedang tidak aktif.')
          return
        }

        const webService = context.services.get<WebCompanionService>('web-companion')
        const { url } = await webService.createSession(sender, groupJid)

        const replyLines = [
          '*Allyssea Web Companion* 🌐',
          '',
          'Akses lembar karakter, alokasi stat, atlas medan, dan dompetmu:',
          `🔗 ${url}`,
          '',
          '_Tautan bersifat privat dan aktif selama 30 menit._',
        ]

        await commandContext.reply(replyLines.join('\n'))
      },
    })
  },
}

export default webCompanionPlugin
