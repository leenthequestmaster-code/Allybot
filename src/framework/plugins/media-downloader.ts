import type { CommandContext, PluginContext } from '../contracts.js'
import type { QuotaService } from '../../services/quota-service.js'
import {
  MEDIA_COMMAND_COOLDOWN_MS,
  defaultDownloadYouTubeMedia,
} from './media-common.js'
import { resolveTikWm, resolveMedia, fetchMediaBuffer, extractMediaUrl } from '../../services/multidl.js'

export type YouTubeDownloaderFn = (url: string, kind: 'audio' | 'video') => Promise<{ data: Uint8Array; mimeType: string; fileName: string; kind: 'audio' | 'video' }>

export function registerMediaDownloaderCommands(
  context: PluginContext,
  ytDownloader: YouTubeDownloaderFn = defaultDownloadYouTubeMedia,
): void {
      context.commands.register({
        name: 'ytmp3',
        aliases: ['yta', 'ytaudio', 'yt2mp3'],
        description: 'Unduh audio dari YouTube',
        category: 'tools',
        menuOrder: 26,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const url = commandContext.args[0]?.trim()
          if (!url || !/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i.test(url)) {
            await commandContext.reply(`Format: ${commandContext.prefix}ytmp3 <url youtube>\nContoh: ${commandContext.prefix}ytmp3 https://youtu.be/dQw4w9WgXcQ`)
            return
          }

          const quotaService = Boolean(commandContext.services?.has?.('quota'))
            ? commandContext.services.get<QuotaService>('quota')
            : undefined
          const senderJid = commandContext.message.senderJid ?? commandContext.message.remoteJid
          const reservation = quotaService?.reserveQuota(senderJid, 'downloader')
          if (reservation && !reservation.ok) {
            await commandContext.reply(`Limit harian download kamu sudah habis (0/${reservation.limit}). Donasi seikhlasnya via !donasi untuk menaikkan limit hingga 50x/hari seumur hidup!`)
            return
          }

          await commandContext.react('⏳')
          if (!commandContext.whatsapp.sendMedia) return
          try {
            const result = await ytDownloader(url, 'audio')
            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'audio',
              data: result.data,
              mimeType: result.mimeType,
              fileName: 'audio.m4a',
            })
            quotaService?.commitQuota(senderJid, 'downloader')
          } catch (error) {
            quotaService?.refundQuota(senderJid, 'downloader')
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'ytmp3 download failed')
            await commandContext.reply('Waduh, audio-nya gagal diambil nih. Mungkin videonya kepanjangan atau diproteksi ya~ 🙏')
          }
        },
      })

      context.commands.register({
        name: 'ytmp4',
        aliases: ['ytv', 'ytvideo'],
        description: 'Unduh video dari YouTube',
        category: 'tools',
        menuOrder: 27,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const url = commandContext.args[0]?.trim()
          if (!url || !/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i.test(url)) {
            await commandContext.reply(`Format: ${commandContext.prefix}ytmp4 <url youtube>\nContoh: ${commandContext.prefix}ytmp4 https://youtu.be/dQw4w9WgXcQ`)
            return
          }

          const quotaService = Boolean(commandContext.services?.has?.('quota'))
            ? commandContext.services.get<QuotaService>('quota')
            : undefined
          const senderJid = commandContext.message.senderJid ?? commandContext.message.remoteJid
          const reservation = quotaService?.reserveQuota(senderJid, 'downloader')
          if (reservation && !reservation.ok) {
            await commandContext.reply(`Limit harian download kamu sudah habis (0/${reservation.limit}). Donasi seikhlasnya via !donasi untuk menaikkan limit hingga 50x/hari seumur hidup!`)
            return
          }

          await commandContext.react('⏳')
          if (!commandContext.whatsapp.sendMedia) return
          try {
            const result = await ytDownloader(url, 'video')
            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'video',
              data: result.data,
              mimeType: result.mimeType,
              fileName: 'video.mp4',
            })
            quotaService?.commitQuota(senderJid, 'downloader')
          } catch (error) {
            quotaService?.refundQuota(senderJid, 'downloader')
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'ytmp4 download failed')
            await commandContext.reply('Waduh, videonya gagal diambil nih. Mungkin durasinya kepanjangan atau ukurannya terlalu besar ya~ 🙏')
          }
        },
      })

      context.commands.register({
        name: 'yt2',
        aliases: ['youtube2', 'yt'],
        description: 'Unduh video atau audio dari YouTube via yt-dlp',
        category: 'tools',
        hidden: true,
        menuOrder: 28,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          let kind: 'audio' | 'video' = 'video'
          let url = commandContext.args[0]?.trim()
          if (url === 'audio' || url === 'mp3') {
            kind = 'audio'
            url = commandContext.args[1]?.trim()
          } else if (url === 'video' || url === 'mp4') {
            kind = 'video'
            url = commandContext.args[1]?.trim()
          }
          if (!url || !/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i.test(url)) {
            await commandContext.reply(`Format: ${commandContext.prefix}yt2 [mp3|mp4] <url youtube>\nContoh:\n• ${commandContext.prefix}yt2 https://youtu.be/dQw4w9WgXcQ (video)\n• ${commandContext.prefix}yt2 mp3 https://youtu.be/dQw4w9WgXcQ (audio)`)
            return
          }
          await commandContext.react('⏳')
          if (!commandContext.whatsapp.sendMedia) return
          try {
            const result = await ytDownloader(url, kind)
            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind,
              data: result.data,
              mimeType: result.mimeType,
              fileName: kind === 'audio' ? 'audio.mp3' : 'video.mp4',
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'yt2 download failed')
            await commandContext.reply(`Waduh, ${kind === 'audio' ? 'audio' : 'video'}-nya gagal diambil nih. Coba link yang lain ya~ 🙏`)
          }
        },
      })

      context.commands.register({
        name: 'tik',
        aliases: ['tt', 'tiktok'],
        description: 'Unduh video TikTok tanpa watermark',
        category: 'tools',
        menuOrder: 29,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const rawText = commandContext.args.join(' ')
          const detected = extractMediaUrl(rawText)
          const targetUrl = detected?.url || commandContext.args[0]?.trim()

          if (!targetUrl || !/tiktok\.com/i.test(targetUrl)) {
            await commandContext.reply(`Format: ${commandContext.prefix}tik <url tiktok>\nContoh: ${commandContext.prefix}tik https://vt.tiktok.com/xxxx/`)
            return
          }

          const quotaService = Boolean(commandContext.services?.has?.('quota'))
            ? commandContext.services.get<QuotaService>('quota')
            : undefined
          const senderJid = commandContext.message.senderJid ?? commandContext.message.remoteJid
          const reservation = quotaService?.reserveQuota(senderJid, 'downloader')
          if (reservation && !reservation.ok) {
            await commandContext.reply(`Limit harian download kamu sudah habis (0/${reservation.limit}). Donasi seikhlasnya via !donasi untuk menaikkan limit hingga 50x/hari seumur hidup!`)
            return
          }

          if (!commandContext.whatsapp.sendMedia) return
          await commandContext.react('⏳')

          try {
            const info = await resolveTikWm(targetUrl)
            if (!info || !info.playUrl) {
              await commandContext.reply('Waduh, video TikTok ini nggak bisa diambil nih. Pastikan linknya publik ya~ 🙏')
              return
            }

            const buf = await fetchMediaBuffer(info.playUrl, 25 * 1024 * 1024)
            if (!buf) {
              await commandContext.reply('Waduh, ukuran video TikTok terlalu besar (maksimal 25 MB) atau gagal diunduh ya~ 🙏')
              return
            }

            const captionParts: string[] = []
            if (info.title) captionParts.push(info.title.slice(0, 100))
            if (info.author) captionParts.push(`@${info.author}`)
            if (info.id) captionParts.push(`tiktok.com/video/${info.id}`)

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'video',
              data: new Uint8Array(buf),
              mimeType: 'video/mp4',
              caption: captionParts.join('\n'),
            })
            quotaService?.commitQuota(senderJid, 'downloader')
          } catch (error) {
            quotaService?.refundQuota(senderJid, 'downloader')
            commandContext.logger.warn({ error }, 'tiktok video download failed')
            await commandContext.reply('Waduh, gagal ngambil video TikTok nih. Coba sebentar lagi ya~ 🙏')
          }
        },
      })

      context.commands.register({
        name: 'tik2mp3',
        aliases: ['ttmp3', 'tiktokaudio', 'tikmp3'],
        description: 'Unduh audio/musik dari TikTok',
        category: 'tools',
        menuOrder: 30,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const rawText = commandContext.args.join(' ')
          const detected = extractMediaUrl(rawText)
          const targetUrl = detected?.url || commandContext.args[0]?.trim()

          if (!targetUrl || !/tiktok\.com/i.test(targetUrl)) {
            await commandContext.reply(`Format: ${commandContext.prefix}tik2mp3 <url tiktok>\nContoh: ${commandContext.prefix}tik2mp3 https://vt.tiktok.com/xxxx/`)
            return
          }

          if (!commandContext.whatsapp.sendMedia) return
          await commandContext.react('⏳')

          try {
            const info = await resolveTikWm(targetUrl)
            if (!info || !info.musicUrl) {
              await commandContext.reply('Waduh, audio TikTok ini nggak tersedia atau linknya tidak valid ya~ 🙏')
              return
            }

            const buf = await fetchMediaBuffer(info.musicUrl, 10 * 1024 * 1024)
            if (!buf) {
              await commandContext.reply('Waduh, audio TikTok gagal diunduh atau ukurannya terlalu besar ya~ 🙏')
              return
            }

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'audio',
              data: new Uint8Array(buf),
              mimeType: 'audio/mp4',
              fileName: `${info.id || 'tiktok_audio'}.mp3`,
            })
          } catch (error) {
            commandContext.logger.warn({ error }, 'tiktok audio download failed')
            await commandContext.reply('Waduh, gagal ngambil audio TikTok nih. Coba sebentar lagi ya~ 🙏')
          }
        },
      })
}
