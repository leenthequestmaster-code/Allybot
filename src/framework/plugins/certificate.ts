/**
 * @module plugins/certificate
 * Official Allyssea Certificate & Award Generator Plugin.
 */

import type { CommandContext, Plugin, PluginContext } from '../contracts.js'
import { generateAllysseaCertificate } from '../../services/certificate-generator.js'

export const certificatePlugin: Plugin = {
  name: 'certificate',

  load(context: PluginContext) {
    context.commands.register({
      name: 'piagam',
      aliases: ['sertifikat', 'cert'],
      description: 'Terbitkan Piagam Penghargaan PDF resmi Allyssea. Contoh: !piagam Cyrus | Juara 1 Turnamen Catur',
      category: 'tools',
      menuOrder: 28,
      cooldownMs: 5_000,

      handler: async (ctx: CommandContext) => {
        const input = ctx.args.join(' ').trim()
        if (!input || !input.includes('|')) {
          await ctx.reply(
            [
              '📜 *Format Pembuatan Piagam Penghargaan Allyssea*',
              '',
              'Ketik nama penerima dan alasan penghargaan dipisahkan dengan tanda `|`.',
              'Contoh:',
              '• `!piagam Cyrus | Juara 1 Turnamen Catur Akbar Allyssea`',
              '• `!piagam Valerius | Prajurit Kehormatan Faksi Aethelgard`',
              '• `!piagam Elena | Kontributor Terbaik Acara Musim Semi`',
            ].join('\n'),
          )
          return
        }

        const [recipient, ...reasonParts] = input.split('|')
        const recipientName = recipient?.trim()
        const achievementText = reasonParts.join('|').trim()

        if (!recipientName || recipientName.length < 2) {
          await ctx.reply('Nama penerima piagam tidak boleh kosong.')
          return
        }
        if (!achievementText || achievementText.length < 3) {
          await ctx.reply('Pencapaian atau alasan penghargaan tidak boleh kosong.')
          return
        }

        await ctx.react('⏳')

        try {
          const certBytes = await generateAllysseaCertificate({
            recipientName,
            achievementText,
            signatoryName: 'Cyrus',
            signatoryRole: 'Founder & System Lead',
          })

          if (!ctx.whatsapp.sendMedia) {
            throw new Error('sendMedia is not available on this WhatsApp adapter')
          }

          const fileName = `Piagam_${recipientName.replace(/\s+/g, '_')}.pdf`
          await ctx.whatsapp.sendMedia(ctx.message.remoteJid, {
            kind: 'document',
            data: certBytes,
            mimeType: 'application/pdf',
            fileName,
            caption: `🎓 *Piagam Penghargaan Resmi Allyssea*\nDiterbitkan dengan penuh kehormatan untuk *${recipientName}*.`,
          })

          await ctx.react('✅')
        } catch (err) {
          ctx.logger.error({ err }, 'failed generating certificate pdf')
          await ctx.react('❌')
          await ctx.reply('Gagal menerbitkan piagam penghargaan. Silakan coba lagi.')
        }
      },
    })
  },
}
