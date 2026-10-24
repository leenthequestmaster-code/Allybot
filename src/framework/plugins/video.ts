import type { CommandContext, Plugin, WhatsAppPort } from '../contracts.js'
import { VideoService } from '../../services/video-service.js'

export interface VideoPluginOptions {
  readonly videoService?: VideoService
}

export function createVideoPlugin(whatsapp?: WhatsAppPort, options: VideoPluginOptions = {}): Plugin {
  return {
    name: 'video-commands',
    version: '0.1.0',
    load(context) {
      const videoService =
        options.videoService ??
        context.services.get<VideoService>('video') ??
        new VideoService()

      // 1. Core Video Generation Command (!vid)
      context.commands.register({
        name: 'vid',
        aliases: ['video', 'veo', 'generatevideo'],
        description: 'Generate video AI cinematic menggunakan Google Flow (Veo 3.1)',
        category: 'tools',
        scope: 'both',
        menuOrder: 15,
        cooldownMs: 15_000,
        handler: async (cmdContext: CommandContext) => {
          const rawPrompt = cmdContext.args.join(' ').trim()
          if (!rawPrompt || rawPrompt.length < 5) {
            await cmdContext.reply(
              `🎬 *Chlona Video Studio (Google Flow / Veo 3.1)*\n\n` +
              `Format:\n` +
              `• \`${cmdContext.prefix}vid <deskripsi video>\`\n\n` +
              `Contoh:\n` +
              `• \`${cmdContext.prefix}vid seekor naga es terbang di atas puncak gunung bersalju, cinematic 4k\`\n` +
              `• \`${cmdContext.prefix}vid pemandangan kota tokyo di malam hari hujan dengan lampu neon cyber\`\n\n` +
              `_Tips: Deskripsikan objek, suasana cahaya, dan pergerakan kamera untuk hasil terbaik!_ ✨`
            )
            return
          }

          if (rawPrompt.length > 500) {
            await cmdContext.reply('⚠️ Deskripsi video terlalu panjang nih. Maksimal 500 karakter ya~')
            return
          }

          // Check sender quota
          const senderJid = cmdContext.message.senderJid ?? cmdContext.message.remoteJid
          const quota = videoService.checkQuota(senderJid)
          if (!quota.allowed) {
            await cmdContext.reply(quota.reason ?? '⚠️ Batas kuota pembuatan video tercapai.')
            return
          }

          // Immediate reaction & status acknowledgement
          await cmdContext.react('⏳')
          await cmdContext.reply(
            `🎬 *Chlona Video Studio*\n\n` +
            `Permintaan videomu sudah masuk antrean render!\n\n` +
            `📝 *Prompt:* "_${rawPrompt}_"\n` +
            `🤖 *Engine:* Veo 3.1 Lite (Google Flow)\n` +
            `⏳ *Estimasi:* ~30-60 detik\n` +
            `📊 *Sisa Kuota Hari Ini:* ${quota.remaining - 1} video\n\n` +
            `_Mohon tunggu sebentar ya, video sedang diproses..._ ☕`
          )

          try {
            const result = await videoService.enqueue(senderJid, {
              prompt: rawPrompt,
              model: 'veo-lite',
            })

            if (cmdContext.whatsapp.sendMedia) {
              await cmdContext.whatsapp.sendMedia(cmdContext.message.remoteJid, {
                kind: 'video',
                data: result.buffer,
                mimeType: result.mimeType,
                fileName: result.fileName,
                caption:
                  `✨ *Hasil Video Chlona Video Studio*\n\n` +
                  `📝 *Prompt:* _${rawPrompt}_\n` +
                  `🤖 *Model:* Google Veo 3.1\n` +
                  `⏱️ *Durasi:* ${result.durationSeconds} Detik\n` +
                  `© Allyssea Creative Lab`,
              })
              await cmdContext.react('✨')
            } else {
              await cmdContext.reply('Waduh, adapter media WhatsApp sedang tidak aktif nih~ 🙏')
            }
          } catch (error) {
            cmdContext.logger.error(
              { errorName: error instanceof Error ? error.name : 'UnknownError' },
              'Video generation failed',
            )
            await cmdContext.react('❌')
            await cmdContext.reply(
              `⚠️ Maaf, pembuatan videomu gagal diproses: ${
                error instanceof Error ? error.message : 'Terjadi kesalahan sistem'
              }.\nKuota harianmu tidak terpotong, silakan coba lagi sesaat lagi ya~ 🙏`
            )
          }
        },
      })

      // 2. Video Status Command (!vidstatus)
      context.commands.register({
        name: 'vidstatus',
        aliases: ['videostatus'],
        description: 'Cek status antrean & sisa limit harian pembuatan video',
        category: 'tools',
        scope: 'both',
        menuOrder: 16,
        cooldownMs: 5_000,
        handler: async (cmdContext: CommandContext) => {
          const senderJid = cmdContext.message.senderJid ?? cmdContext.message.remoteJid
          const quota = videoService.checkQuota(senderJid)
          const qSize = videoService.queueSize

          await cmdContext.reply(
            `📊 *Status Chlona Video Studio*\n\n` +
            `• Antrean Aktif  : *${qSize} job*\n` +
            `• Sisa Limitmu   : *${quota.remaining} video hari ini*\n` +
            `• Status Sistem  : *Online (Google Flow Veo 3.1)* 🟢\n\n` +
            `Ketik \`${cmdContext.prefix}vid <prompt>\` untuk mulai merender video!`
          )
        },
      })

      // 3. Video Models Info Command (!vidmodels)
      context.commands.register({
        name: 'vidmodels',
        aliases: ['videomodels'],
        description: 'Lihat daftar model video AI yang tersedia di Google Flow',
        category: 'tools',
        scope: 'both',
        menuOrder: 17,
        cooldownMs: 5_000,
        handler: async (cmdContext: CommandContext) => {
          await cmdContext.reply(
            `🎬 *Katalog Model Google Flow Studio*\n\n` +
            `1. 🌟 *Veo 3.1 - Lite* (Default)\n` +
            `   • Model cepat & hemat kredit\n` +
            `   • Resolusi 720p HD @ 24fps\n` +
            `   • Cocok untuk visual sinematik & animasi\n\n` +
            `2. ⚡ *Omni 1.1 Flash*\n` +
            `   • Video super responsif dengan audio/sound effect bawaan\n\n` +
            `3. 💎 *Veo 3.1 - Fast / Quality*\n` +
            `   • Mode resolusi tinggi untuk kebutuhan detail visual tingkat lanjut\n\n` +
            `_Gunakan \`${cmdContext.prefix}vid <prompt>\` untuk langsung mencoba!_`
          )
        },
      })
    },
  }
}
