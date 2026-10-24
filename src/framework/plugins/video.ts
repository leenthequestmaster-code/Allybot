import type { CommandContext, Plugin, WhatsAppPort } from '../contracts.js'
import { VideoService } from '../../services/video-service.js'

export interface VideoPluginOptions {
  readonly videoService?: VideoService
}

function sourceVideo(context: CommandContext): { source: 'direct' | 'quoted'; kind: string } | undefined {
  if (context.message.media?.kind === 'video') return { source: 'direct', kind: 'video' }
  if (context.message.quotedMedia?.kind === 'video') return { source: 'quoted', kind: 'video' }
  return undefined
}

function sourceImage(context: CommandContext): { source: 'direct' | 'quoted'; kind: string } | undefined {
  if (context.message.media?.kind === 'image') return { source: 'direct', kind: 'image' }
  if (context.message.quotedMedia?.kind === 'image') return { source: 'quoted', kind: 'image' }
  return undefined
}

export function createVideoPlugin(whatsapp?: WhatsAppPort, options: VideoPluginOptions = {}): Plugin {
  return {
    name: 'video-commands',
    version: '0.2.0',
    load(context) {
      const videoService =
        options.videoService ??
        context.services.get<VideoService>('video') ??
        new VideoService()

      // ── 1. AI Video Generation (Veo 3.1 & Omni 1.1 Flash) ─────────────
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
              `• \`${cmdContext.prefix}vid <deskripsi video>\`\n` +
              `• \`${cmdContext.prefix}vidomni <deskripsi video>\` (dengan audio bawaan Omni)\n\n` +
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

          const senderJid = cmdContext.message.senderJid ?? cmdContext.message.remoteJid
          const quota = videoService.checkQuota(senderJid)
          if (!quota.allowed) {
            await cmdContext.reply(quota.reason ?? '⚠️ Batas kuota pembuatan video tercapai.')
            return
          }

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

            const mediaPort = whatsapp ?? cmdContext.whatsapp
            if (mediaPort?.sendMedia) {
              await mediaPort.sendMedia(cmdContext.message.remoteJid, {
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

      // ── 2. Omni 1.1 Flash Video Generation & Image-to-Video (I2V) ───────
      context.commands.register({
        name: 'omnivid',
        aliases: ['vidomni', 'i2v'],
        description: 'Animasikan gambar/foto menjadi video AI hidup menggunakan Gemini Omni 1.1 Flash',
        category: 'tools',
        scope: 'both',
        menuOrder: 16,
        cooldownMs: 15_000,
        handler: async (cmdContext: CommandContext) => {
          const imgTarget = sourceImage(cmdContext)
          const mediaPort = whatsapp ?? cmdContext.whatsapp

          if (!imgTarget || !mediaPort?.downloadMedia) {
            await cmdContext.reply(
              `🎬 *Chlona Omni Video (Image-to-Video)*\n\n` +
              `Kirim gambar atau balas foto dengan caption:\n` +
              `• \`${cmdContext.prefix}omnivid <deskripsi gerakan>\`\n\n` +
              `Contoh:\n` +
              `• \`${cmdContext.prefix}omnivid buat rambutnya tertiup angin dan tersenyum lembut\`\n` +
              `• \`${cmdContext.prefix}omnivid buat air terjunnya mengalir deras dan ada kabut lembut\`\n\n` +
              `_Engine: Gemini Omni 1.1 Flash (dengan efek suara alami!)_ ✨`
            )
            return
          }

          const rawPrompt = cmdContext.args.join(' ').trim() || 'Animate this image with smooth natural cinematic motion'
          const senderJid = cmdContext.message.senderJid ?? cmdContext.message.remoteJid
          const quota = videoService.checkQuota(senderJid)
          if (!quota.allowed) {
            await cmdContext.reply(quota.reason ?? '⚠️ Batas kuota pembuatan video tercapai.')
            return
          }

          await cmdContext.react('⏳')
          await cmdContext.reply(
            `⚡ *Chlona Omni Video Studio*\n\n` +
            `Gambarmu sedang dianimasikan dengan Gemini Omni 1.1 Flash!\n\n` +
            `📝 *Instruksi Gerak:* "_${rawPrompt}_"\n` +
            `🔊 *Fitur:* Native Ambient Sound\n` +
            `⏳ *Estimasi:* ~30-60 detik\n` +
            `📊 *Sisa Kuota Hari Ini:* ${quota.remaining - 1} video\n\n` +
            `_Mohon tunggu sebentar ya, video sedang diproses..._ ☕`
          )

          try {
            const downloaded = await mediaPort.downloadMedia(cmdContext.message, imgTarget.source, {
              maxBytes: 15 * 1024 * 1024,
              timeoutMs: 30_000,
            })

            const result = await videoService.enqueue(senderJid, {
              prompt: rawPrompt,
              model: 'omni-flash',
              imageBuffer: Buffer.from(downloaded.data),
            })

            if (mediaPort.sendMedia) {
              await mediaPort.sendMedia(cmdContext.message.remoteJid, {
                kind: 'video',
                data: result.buffer,
                mimeType: result.mimeType,
                fileName: result.fileName,
                caption:
                  `✨ *Hasil Animasi Foto (Gemini Omni 1.1 Flash)*\n\n` +
                  `📝 *Gerakan:* _${rawPrompt}_\n` +
                  `🔊 *Audio:* Native Ambient Sound FX\n` +
                  `⏱️ *Durasi:* ${result.durationSeconds} Detik\n` +
                  `© Allyssea Creative Lab`,
              })
              await cmdContext.react('✨')
            }
          } catch (error) {
            cmdContext.logger.error(
              { errorName: error instanceof Error ? error.name : 'UnknownError' },
              'Omni video animation failed',
            )
            await cmdContext.react('❌')
            await cmdContext.reply(
              `⚠️ Gagal menganimasikan gambar: ${error instanceof Error ? error.message : 'Error sistem'}`
            )
          }
        },
      })

      // ── 3. Native Video Editing: Compress (!vcompress) ─────────────────
      context.commands.register({
        name: 'vcompress',
        aliases: ['vshrink', 'kompresvideo'],
        description: 'Kompres ukuran video WhatsApp agar hemat kuota tanpa pecah',
        category: 'tools',
        scope: 'both',
        menuOrder: 17,
        cooldownMs: 5_000,
        handler: async (cmdContext: CommandContext) => {
          const videoTarget = sourceVideo(cmdContext)
          const mediaPort = whatsapp ?? cmdContext.whatsapp
          if (!videoTarget || !mediaPort?.downloadMedia || !mediaPort?.sendMedia) {
            await cmdContext.reply(`Kirim atau balas video dengan \`${cmdContext.prefix}vcompress\` untuk mengecilkan ukurannya ya~ 📹`)
            return
          }

          await cmdContext.react('⏳')
          try {
            const downloaded = await mediaPort.downloadMedia(cmdContext.message, videoTarget.source, {
              maxBytes: 30 * 1024 * 1024,
              timeoutMs: 30_000,
            })
            const originalBytes = downloaded.data.length
            const compressedBuffer = await videoService.compressVideo(Buffer.from(downloaded.data))
            const newBytes = compressedBuffer.length
            const pct = Math.max(1, Math.round((1 - newBytes / originalBytes) * 100))

            await mediaPort.sendMedia(cmdContext.message.remoteJid, {
              kind: 'video',
              data: compressedBuffer,
              mimeType: 'video/mp4',
              fileName: 'compressed.mp4',
              caption:
                `📦 *Video Berhasil Dikompres*\n\n` +
                `• Asli   : ${(originalBytes / (1024 * 1024)).toFixed(1)} MB\n` +
                `• Hasil  : ${(newBytes / (1024 * 1024)).toFixed(1)} MB (-${pct}%)\n` +
                `© Allyssea Video Engine`,
            })
            await cmdContext.react('✨')
          } catch (err) {
            await cmdContext.react('❌')
            await cmdContext.reply(`Gagal mengompres video: ${err instanceof Error ? err.message : 'Error'}`)
          }
        },
      })

      // ── 4. Native Video Editing: Trim (!vtrim) ─────────────────────────
      context.commands.register({
        name: 'vtrim',
        aliases: ['vcut', 'potongvideo'],
        description: 'Potong rentang durasi video (contoh: !vtrim 00:02 00:10)',
        category: 'tools',
        scope: 'both',
        menuOrder: 18,
        cooldownMs: 5_000,
        handler: async (cmdContext: CommandContext) => {
          const videoTarget = sourceVideo(cmdContext)
          const mediaPort = whatsapp ?? cmdContext.whatsapp
          const start = cmdContext.args[0]
          const end = cmdContext.args[1]

          if (!videoTarget || !start || !mediaPort?.downloadMedia || !mediaPort?.sendMedia) {
            await cmdContext.reply(
              `Balas video lalu ketik:\n` +
              `• \`${cmdContext.prefix}vtrim <mulai> [selesai]\`\n\n` +
              `Contoh:\n` +
              `• \`${cmdContext.prefix}vtrim 00:02 00:08\`\n` +
              `• \`${cmdContext.prefix}vtrim 5 15\` (potong dari detik 5 sampai 15)`
            )
            return
          }

          await cmdContext.react('⏳')
          try {
            const downloaded = await mediaPort.downloadMedia(cmdContext.message, videoTarget.source, {
              maxBytes: 30 * 1024 * 1024,
              timeoutMs: 30_000,
            })
            const trimmedBuffer = await videoService.trimVideo(Buffer.from(downloaded.data), start, end)

            await mediaPort.sendMedia(cmdContext.message.remoteJid, {
              kind: 'video',
              data: trimmedBuffer,
              mimeType: 'video/mp4',
              fileName: 'trimmed.mp4',
              caption: `✂️ *Video Berhasil Dipotong*\nDurasi: ${start} s/d ${end ?? 'akhir'}\n© Allyssea Video Engine`,
            })
            await cmdContext.react('✨')
          } catch (err) {
            await cmdContext.react('❌')
            await cmdContext.reply(`Gagal memotong video: ${err instanceof Error ? err.message : 'Error'}`)
          }
        },
      })

      // ── 5. Native Video Editing: Speed (!vspeed) ───────────────────────
      context.commands.register({
        name: 'vspeed',
        aliases: ['vtempo', 'kecepatanvideo'],
        description: 'Ubah kecepatan playback video (contoh: !vspeed 1.5x / 0.5x / 2x)',
        category: 'tools',
        scope: 'both',
        menuOrder: 19,
        cooldownMs: 5_000,
        handler: async (cmdContext: CommandContext) => {
          const videoTarget = sourceVideo(cmdContext)
          const mediaPort = whatsapp ?? cmdContext.whatsapp
          const speedRaw = parseFloat(cmdContext.args[0]?.replace('x', '') || '')

          if (!videoTarget || isNaN(speedRaw) || speedRaw < 0.25 || speedRaw > 4.0 || !mediaPort?.downloadMedia || !mediaPort?.sendMedia) {
            await cmdContext.reply(
              `Balas video lalu ketik:\n` +
              `• \`${cmdContext.prefix}vspeed <angka>x\`\n\n` +
              `Contoh:\n` +
              `• \`${cmdContext.prefix}vspeed 1.5x\` (percepat 1.5 kali)\n` +
              `• \`${cmdContext.prefix}vspeed 0.5x\` (slow-motion)`
            )
            return
          }

          await cmdContext.react('⏳')
          try {
            const downloaded = await mediaPort.downloadMedia(cmdContext.message, videoTarget.source, {
              maxBytes: 30 * 1024 * 1024,
              timeoutMs: 30_000,
            })
            const speedBuffer = await videoService.speedVideo(Buffer.from(downloaded.data), speedRaw)

            await mediaPort.sendMedia(cmdContext.message.remoteJid, {
              kind: 'video',
              data: speedBuffer,
              mimeType: 'video/mp4',
              fileName: 'speed.mp4',
              caption: `⏩ *Kecepatan Diubah: ${speedRaw}x*\n© Allyssea Video Engine`,
            })
            await cmdContext.react('✨')
          } catch (err) {
            await cmdContext.react('❌')
            await cmdContext.reply(`Gagal mengubah kecepatan: ${err instanceof Error ? err.message : 'Error'}`)
          }
        },
      })

      // ── 6. Native Video Editing: Mute (!vmute) ─────────────────────────
      context.commands.register({
        name: 'vmute',
        aliases: ['vsilence', 'hanyavideo'],
        description: 'Hilangkan audio/suara dari video',
        category: 'tools',
        scope: 'both',
        menuOrder: 20,
        cooldownMs: 3_000,
        handler: async (cmdContext: CommandContext) => {
          const videoTarget = sourceVideo(cmdContext)
          const mediaPort = whatsapp ?? cmdContext.whatsapp

          if (!videoTarget || !mediaPort?.downloadMedia || !mediaPort?.sendMedia) {
            await cmdContext.reply(`Balas video lalu ketik \`${cmdContext.prefix}vmute\` untuk membuang suaranya ya~ 🔇`)
            return
          }

          await cmdContext.react('⏳')
          try {
            const downloaded = await mediaPort.downloadMedia(cmdContext.message, videoTarget.source, {
              maxBytes: 30 * 1024 * 1024,
              timeoutMs: 30_000,
            })
            const mutedBuffer = await videoService.muteVideo(Buffer.from(downloaded.data))

            await mediaPort.sendMedia(cmdContext.message.remoteJid, {
              kind: 'video',
              data: mutedBuffer,
              mimeType: 'video/mp4',
              fileName: 'muted.mp4',
              caption: `🔇 *Video Dibisukan (Muted)*\n© Allyssea Video Engine`,
            })
            await cmdContext.react('✨')
          } catch (err) {
            await cmdContext.react('❌')
            await cmdContext.reply(`Gagal membisukan video: ${err instanceof Error ? err.message : 'Error'}`)
          }
        },
      })

      // ── 7. Native Video Editing: Extract VN (!vvn) ─────────────────────
      context.commands.register({
        name: 'vvn',
        aliases: ['videotovn', 'vptt'],
        description: 'Ekstrak audio video menjadi Voice Note (PTT) WhatsApp',
        category: 'tools',
        scope: 'both',
        menuOrder: 21,
        cooldownMs: 3_000,
        handler: async (cmdContext: CommandContext) => {
          const videoTarget = sourceVideo(cmdContext)
          const mediaPort = whatsapp ?? cmdContext.whatsapp

          if (!videoTarget || !mediaPort?.downloadMedia || !mediaPort?.sendMedia) {
            await cmdContext.reply(`Balas video lalu ketik \`${cmdContext.prefix}vvn\` untuk mengubah suaranya jadi Voice Note (VN) ya~ 🎙️`)
            return
          }

          await cmdContext.react('⏳')
          try {
            const downloaded = await mediaPort.downloadMedia(cmdContext.message, videoTarget.source, {
              maxBytes: 30 * 1024 * 1024,
              timeoutMs: 30_000,
            })
            const vnBuffer = await videoService.extractVoiceNote(Buffer.from(downloaded.data))

            await mediaPort.sendMedia(cmdContext.message.remoteJid, {
              kind: 'audio',
              data: vnBuffer,
              mimeType: 'audio/ogg; codecs=opus',
              fileName: 'voice-note.opus',
            })
            await cmdContext.react('✨')
          } catch (err) {
            await cmdContext.react('❌')
            await cmdContext.reply(`Gagal mengekstrak audio: ${err instanceof Error ? err.message : 'Error'}`)
          }
        },
      })

      // ── 8. Status & Info Commands ──────────────────────────────────────
      context.commands.register({
        name: 'vidstatus',
        aliases: ['videostatus'],
        description: 'Cek status antrean & sisa limit harian pembuatan video',
        category: 'tools',
        scope: 'both',
        menuOrder: 22,
        cooldownMs: 5_000,
        handler: async (cmdContext: CommandContext) => {
          const senderJid = cmdContext.message.senderJid ?? cmdContext.message.remoteJid
          const quota = videoService.checkQuota(senderJid)
          const qSize = videoService.queueSize

          await cmdContext.reply(
            `📊 *Status Chlona Video Studio*\n\n` +
            `• Antrean Aktif  : *${qSize} job*\n` +
            `• Sisa Limitmu   : *${quota.remaining} video hari ini*\n` +
            `• Status Sistem  : *Online (Google Flow Veo 3.1 & Omni 1.1)* 🟢\n\n` +
            `Ketik \`${cmdContext.prefix}vid <prompt>\` untuk mulai merender video!`
          )
        },
      })

      context.commands.register({
        name: 'vidmodels',
        aliases: ['videomodels'],
        description: 'Lihat daftar model video AI yang tersedia di Google Flow',
        category: 'tools',
        scope: 'both',
        menuOrder: 23,
        cooldownMs: 5_000,
        handler: async (cmdContext: CommandContext) => {
          await cmdContext.reply(
            `🎬 *Katalog Model Google Flow Studio*\n\n` +
            `1. 🌟 *Veo 3.1 - Lite* (\`${cmdContext.prefix}vid <prompt>\`)\n` +
            `   • Cepat & hemat kuota\n` +
            `   • Resolusi 720p HD @ 24fps\n\n` +
            `2. ⚡ *Omni 1.1 Flash* (\`${cmdContext.prefix}vidomni <prompt>\`)\n` +
            `   • Dilengkapi efek suara / audio bawaan sinkron\n\n` +
            `✂️ *Tools Edit Video Cepat:*\n` +
            `• \`${cmdContext.prefix}vcompress\` : Kecilkan ukuran video\n` +
            `• \`${cmdContext.prefix}vtrim\` : Potong rentang durasi\n` +
            `• \`${cmdContext.prefix}vspeed\` : Ubah kecepatan video\n` +
            `• \`${cmdContext.prefix}vmute\` : Hilangkan suara video\n` +
            `• \`${cmdContext.prefix}vvn\` : Ekstrak audio jadi VN WhatsApp`
          )
        },
      })
    },
  }
}
