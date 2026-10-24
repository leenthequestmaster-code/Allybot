/**
 * @module plugins/exif
 * Camera Metadata Inspector Plugin for Allybot.
 */

import type { CommandContext, Plugin, PluginContext } from '../contracts.js'
import { inspectExif } from '../../services/exif-inspector.js'

export const exifPlugin: Plugin = {
  name: 'exif',

  load(context: PluginContext) {
    context.commands.register({
      name: 'exif',
      aliases: ['camera', 'kamera'],
      description: 'Cek metadata EXIF kamera dari foto yang dikirim atau dibalas',
      category: 'tools',
      menuOrder: 29,
      cooldownMs: 3_000,

      handler: async (ctx: CommandContext) => {
        if (!ctx.whatsapp.downloadMedia) {
          await ctx.reply('Fitur download media tidak didukung pada adapter ini.')
          return
        }

        const hasMedia = Boolean(ctx.message.media || ctx.message.quotedMedia)
        if (!hasMedia) {
          await ctx.reply('Kirim foto atau balas sebuah foto dengan perintah `!exif` untuk memeriksa spesifikasi kamera.')
          return
        }

        const source = ctx.message.quotedMedia ? 'quoted' : 'direct'
        let media
        try {
          media = await ctx.whatsapp.downloadMedia(ctx.message, source, { maxBytes: 15 * 1024 * 1024 })
        } catch {
          await ctx.reply('Gagal mengunduh foto untuk analisis EXIF.')
          return
        }

        if (!media || media.kind !== 'image') {
          await ctx.reply('Media yang dikirim harus berupa foto/gambar.')
          return
        }

        await ctx.react('🔍')

        try {
          const info = await inspectExif(Buffer.from(media.data))
          if (!info || (!info.camera && !info.lens && !info.iso && !info.aperture && !info.shutterSpeed)) {
            await ctx.react('✅')
            await ctx.reply('🛡️ *Status Foto: Bersih (Nol Jejak)*\n\nFoto ini tidak memuat metadata kamera atau data lokasi GPS. Privasi foto aman!')
            return
          }

          const lines = [
            '📷 *Informasi Metadata Kamera (EXIF)*',
            '',
            info.camera ? `• Kamera       : *${info.camera}*` : null,
            info.lens ? `• Lensa        : *${info.lens}*` : null,
            info.focalLength ? `• Focal Length : *${info.focalLength}*` : null,
            info.aperture ? `• Aperture     : *${info.aperture}*` : null,
            info.shutterSpeed ? `• Shutter Speed: *${info.shutterSpeed}*` : null,
            info.iso !== undefined ? `• ISO          : *${info.iso}*` : null,
            info.takenAt ? `• Waktu Jepret : *${info.takenAt} WIB*` : null,
            info.hasGps ? `• GPS Lokasi   : ⚠️ *Terdeteksi* (Koordinat disembunyikan)` : `• GPS Lokasi   : ✅ *Bersih (Nol Jejak GPS)*`,
          ].filter(Boolean)

          await ctx.reply(lines.join('\n'))
          await ctx.react('✅')
        } catch (err) {
          ctx.logger.error({ err }, 'failed inspecting exif')
          await ctx.react('❌')
          await ctx.reply('Gagal membaca data EXIF foto.')
        }
      },
    })
  },
}
