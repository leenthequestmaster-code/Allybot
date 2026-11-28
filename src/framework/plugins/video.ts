import type { CommandContext, Plugin, WhatsAppPort } from '../contracts.js'
import { VideoService } from '../../services/video-service.js'

export interface VideoPluginOptions {
  readonly videoService?: VideoService
}


export function parseVideoArgs(args: readonly string[]): {
  readonly prompt: string
  readonly durationSeconds: number
  readonly invalidDurationError?: string
} {
  let durationSeconds = 8
  const remaining: string[] = []

  for (let i = 0; i < args.length; i++) {
    const token = args[i] ?? ''
    let rawNum: string | undefined

    const eqMatch = token.match(/^--?(?:dur|duration|d)=(\d+)$/i)
    if (eqMatch) {
      rawNum = eqMatch[1]
    } else if (/^--?(?:dur|duration|d)$/i.test(token) && i + 1 < args.length && /^\d+$/.test(args[i + 1] ?? '')) {
      rawNum = args[++i]
    } else {
      const suffixMatch = token.match(/^(\d+)(?:s|sec|dtk|detik)$/i)
      if (suffixMatch) rawNum = suffixMatch[1]
    }

    if (rawNum !== undefined) {
      const val = Number.parseInt(rawNum, 10)
      if (!Number.isFinite(val) || val < 4 || val > 10) {
        return {
          prompt: '',
          durationSeconds: 8,
          invalidDurationError: 'Status: Gagal\nDurasi video harus antara 4 sampai 10 detik (contoh: !vid --dur=6 pemandangan senja).',
        }
      }
      durationSeconds = val
    } else {
      remaining.push(token)
    }
  }

  return { prompt: remaining.join(' ').trim(), durationSeconds }
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
    version: '0.3.0',
    load(context) {
      const videoService =
        options.videoService ??
        context.services.get<VideoService>('video') ??
        new VideoService()

      // ── 1. Pembuatan Video dari Teks atau Gambar (!vid / !omnivid) ───────
      context.commands.register({
        name: 'vid',
        aliases: ['video', 'omnivid', 'i2v', 'vidomni'],
        description: 'Membuat video dari teks atau gambar',
        category: 'tools',
        scope: 'both',
        menuOrder: 15,
        cooldownMs: 15_000,
        handler: async (cmdContext: CommandContext) => {
          const imgTarget = sourceImage(cmdContext)
          const mediaPort = whatsapp ?? cmdContext.whatsapp
          const parsedArgs = parseVideoArgs(cmdContext.args)
          if (parsedArgs.invalidDurationError) {
            await cmdContext.reply(parsedArgs.invalidDurationError)
            return
          }
          const rawPrompt = parsedArgs.prompt
          const durationSeconds = parsedArgs.durationSeconds

          if (imgTarget && mediaPort?.downloadMedia) {
            if (rawPrompt.length > 500) {
              await cmdContext.reply(
                'Status: Gagal\nDeskripsi terlalu panjang. Maksimal 500 karakter.',
              )
              return
            }

            const promptText = rawPrompt || 'Gerakkan objek secara alami dan halus'
            const senderJid = cmdContext.message.senderJid ?? cmdContext.message.remoteJid
            const quota = videoService.checkQuota(senderJid)
            if (!quota.allowed) {
              await cmdContext.reply(quota.reason ?? 'Status: Gagal\nBatas kuota pembuatan video tercapai.')
              return
            }

            await cmdContext.react('⏳')
            await cmdContext.reply(
              'Status: Diproses\nGambar sedang diunggah dan diproses menjadi video.',
            )

            try {
              const downloaded = await mediaPort.downloadMedia(cmdContext.message, imgTarget.source, {
                maxBytes: 15 * 1024 * 1024,
                timeoutMs: 30_000,
              })

              const result = await videoService.enqueue(senderJid, {
                prompt: promptText,
                model: 'omni-flash',
                durationSeconds,
                imageBuffer: Buffer.from(downloaded.data),
              })

              if (mediaPort.sendMedia) {
                await mediaPort.sendMedia(cmdContext.message.remoteJid, {
                  kind: 'video',
                  data: result.buffer,
                  mimeType: result.mimeType,
                  fileName: result.fileName,
                  caption:
                    'Status: Berhasil\n' +
                    'Video dari gambar berhasil dibuat.\n' +
                    `Durasi: ${result.durationSeconds} detik`,
                })
                await cmdContext.react('✅')
              } else {
                await cmdContext.reply('Status: Gagal\nLayanan pengiriman media sedang tidak tersedia.')
              }
            } catch (error) {
              cmdContext.logger.error(
                { errorName: error instanceof Error ? error.name : 'UnknownError' },
                'Image to video animation failed',
              )
              await cmdContext.react('❌')
              await cmdContext.reply(
                'Status: Gagal\n' +
                'Gagal memproses gambar menjadi video. Pastikan format gambar valid dan coba lagi.',
              )
            }
            return
          }

          if (!rawPrompt || rawPrompt.length < 5) {
            await cmdContext.reply(
              'Status: Gagal\n' +
              'Format perintah:\n' +
              `${cmdContext.prefix}vid <deskripsi> (teks ke video)\n` +
              `• Kirim/balas gambar dengan ${cmdContext.prefix}vid [deskripsi gerakan] (gambar ke video)\n\n` +
              'Contoh:\n' +
              `${cmdContext.prefix}vid pemandangan pegunungan saat fajar`,
            )
            return
          }

          if (rawPrompt.length > 500) {
            await cmdContext.reply(
              'Status: Gagal\nDeskripsi terlalu panjang. Maksimal 500 karakter.',
            )
            return
          }

          const senderJid = cmdContext.message.senderJid ?? cmdContext.message.remoteJid
          const quota = videoService.checkQuota(senderJid)
          if (!quota.allowed) {
            await cmdContext.reply(quota.reason ?? 'Status: Gagal\nBatas kuota pembuatan video tercapai.')
            return
          }

          await cmdContext.react('⏳')
          await cmdContext.reply(
            'Status: Diproses\nVideo sedang dibuat. Estimasi selesai dalam 1 menit.',
          )

          try {
            const result = await videoService.enqueue(senderJid, {
              prompt: rawPrompt,
              model: 'veo-lite',
              durationSeconds,
            })

            if (mediaPort?.sendMedia) {
              await mediaPort.sendMedia(cmdContext.message.remoteJid, {
                kind: 'video',
                data: result.buffer,
                mimeType: result.mimeType,
                fileName: result.fileName,
                caption:
                  'Status: Berhasil\n' +
                  'Video selesai dibuat.\n' +
                  `Durasi: ${result.durationSeconds} detik`,
              })
              await cmdContext.react('✅')
            } else {
              await cmdContext.reply('Status: Gagal\nLayanan pengiriman media sedang tidak tersedia.')
            }
          } catch (error) {
            cmdContext.logger.error(
              { errorName: error instanceof Error ? error.name : 'UnknownError' },
              'Text to video generation failed',
            )
            await cmdContext.react('❌')
            await cmdContext.reply(
              'Status: Gagal\n' +
              'Pembuatan video tidak dapat diproses saat ini. Silakan coba beberapa saat lagi.',
            )
          }
        },
      })

      // ── 3. Kompresi Video (!vcompress) ────────────────────────────────
      context.commands.register({
        name: 'vcompress',
        aliases: ['vshrink'],
        description: 'Mengecilkan ukuran file video',
        category: 'tools',
        scope: 'both',
        menuOrder: 17,
        cooldownMs: 5_000,
        handler: async (cmdContext: CommandContext) => {
          const videoTarget = sourceVideo(cmdContext)
          const mediaPort = whatsapp ?? cmdContext.whatsapp
          if (!videoTarget || !mediaPort?.downloadMedia || !mediaPort?.sendMedia) {
            await cmdContext.reply(
              `Status: Gagal\nBalas video dengan ${cmdContext.prefix}vcompress untuk mengecilkan ukuran.`
            )
            return
          }

          await cmdContext.react('⏳')
          await cmdContext.reply(`Status: Diproses\nVideo sedang dikompres.`)

          try {
            const downloaded = await mediaPort.downloadMedia(cmdContext.message, videoTarget.source, {
              maxBytes: 30 * 1024 * 1024,
              timeoutMs: 30_000,
            })
            const originalBytes = downloaded.data.length
            const compressedBuffer = await videoService.compressVideo(Buffer.from(downloaded.data))
            const newBytes = compressedBuffer.length
            const pct = Math.max(1, Math.round((1 - newBytes / originalBytes) * 100))
            const origMb = (originalBytes / (1024 * 1024)).toFixed(1)
            const newMb = (newBytes / (1024 * 1024)).toFixed(1)

            await mediaPort.sendMedia(cmdContext.message.remoteJid, {
              kind: 'video',
              data: compressedBuffer,
              mimeType: 'video/mp4',
              fileName: 'compressed.mp4',
              caption:
                `Status: Berhasil\n` +
                `Ukuran video dikompres dari ${origMb} MB menjadi ${newMb} MB (-${pct}%).`,
            })
            await cmdContext.react('✅')
          } catch (err) {
            await cmdContext.react('❌')
            await cmdContext.reply(`Status: Gagal\nKompresi video tidak dapat diproses. Pastikan file video valid.`)
          }
        },
      })

      // ── 4. Potong Durasi Video (!vtrim) ───────────────────────────────
      context.commands.register({
        name: 'vtrim',
        aliases: ['vcut'],
        description: 'Memotong rentang durasi video',
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
              `Status: Gagal\n` +
              `Format perintah: ${cmdContext.prefix}vtrim <mulai> [selesai]\n` +
              `Contoh: ${cmdContext.prefix}vtrim 00:02 00:08`
            )
            return
          }

          await cmdContext.react('⏳')
          await cmdContext.reply(`Status: Diproses\nVideo sedang dipotong.`)

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
              caption:
                `Status: Berhasil\n` +
                `Video dipotong ke rentang ${start} s/d ${end ?? 'akhir'}.`,
            })
            await cmdContext.react('✅')
          } catch (err) {
            await cmdContext.react('❌')
            await cmdContext.reply(`Status: Gagal\nPemotongan video tidak dapat diproses. Periksa format waktu yang dimasukkan.`)
          }
        },
      })

      // ── 5. Pengaturan Kecepatan Video (!vspeed) ───────────────────────
      context.commands.register({
        name: 'vspeed',
        aliases: ['vtempo'],
        description: 'Mengubah kecepatan pemutaran video',
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
              `Status: Gagal\n` +
              `Format perintah: ${cmdContext.prefix}vspeed <angka>x\n` +
              `Contoh: ${cmdContext.prefix}vspeed 1.5x (antara 0.25x hingga 4.0x)`
            )
            return
          }

          await cmdContext.react('⏳')
          await cmdContext.reply(`Status: Diproses\nKecepatan video sedang diubah.`)

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
              caption:
                `Status: Berhasil\n` +
                `Kecepatan video diubah menjadi ${speedRaw}x.`,
            })
            await cmdContext.react('✅')
          } catch (err) {
            await cmdContext.react('❌')
            await cmdContext.reply(`Status: Gagal\nPengubahan kecepatan video tidak dapat diproses.`)
          }
        },
      })

      // ── 6. Hilangkan Suara Video (!vmute) ─────────────────────────────
      context.commands.register({
        name: 'vmute',
        aliases: ['vsilence'],
        description: 'Menghilangkan audio dari video',
        category: 'tools',
        scope: 'both',
        menuOrder: 20,
        cooldownMs: 3_000,
        handler: async (cmdContext: CommandContext) => {
          const videoTarget = sourceVideo(cmdContext)
          const mediaPort = whatsapp ?? cmdContext.whatsapp

          if (!videoTarget || !mediaPort?.downloadMedia || !mediaPort?.sendMedia) {
            await cmdContext.reply(
              `Status: Gagal\nBalas video dengan ${cmdContext.prefix}vmute untuk menghilangkan audio.`
            )
            return
          }

          await cmdContext.react('⏳')
          await cmdContext.reply(`Status: Diproses\nAudio video sedang dihilangkan.`)

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
              caption:
                `Status: Berhasil\n` +
                `Audio video berhasil dihilangkan.`,
            })
            await cmdContext.react('✅')
          } catch (err) {
            await cmdContext.react('❌')
            await cmdContext.reply(`Status: Gagal\nPenghilangan audio video tidak dapat diproses.`)
          }
        },
      })

      // ── 7. Ekstraksi Audio ke Pesan Suara (!vvn) ──────────────────────
      context.commands.register({
        name: 'vvn',
        aliases: ['videotovn'],
        description: 'Mengekstrak audio video menjadi pesan suara',
        category: 'tools',
        scope: 'both',
        menuOrder: 21,
        cooldownMs: 3_000,
        handler: async (cmdContext: CommandContext) => {
          const videoTarget = sourceVideo(cmdContext)
          const mediaPort = whatsapp ?? cmdContext.whatsapp

          if (!videoTarget || !mediaPort?.downloadMedia || !mediaPort?.sendMedia) {
            await cmdContext.reply(
              `Status: Gagal\nBalas video dengan ${cmdContext.prefix}vvn untuk mengekstrak pesan suara.`
            )
            return
          }

          await cmdContext.react('⏳')
          await cmdContext.reply(`Status: Diproses\nAudio video sedang diekstrak.`)

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
            await cmdContext.react('✅')
          } catch (err) {
            await cmdContext.react('❌')
            await cmdContext.reply(`Status: Gagal\nEkstraksi audio video tidak dapat diproses.`)
          }
        },
      })

      // ── 8. Status Antrean Video (!vidstatus) ───────────────────────────
      context.commands.register({
        name: 'vidstatus',
        aliases: ['videostatus'],
        description: 'Cek status antrean dan sisa kuota harian video',
        category: 'tools',
        scope: 'both',
        menuOrder: 22,
        cooldownMs: 5_000,
        handler: async (cmdContext: CommandContext) => {
          const senderJid = cmdContext.message.senderJid ?? cmdContext.message.remoteJid
          const quota = videoService.checkQuota(senderJid)
          const qSize = videoService.queueSize

          await cmdContext.reply(
            `Status: Berhasil\n` +
            `Antrean aktif: ${qSize} job\n` +
            `Sisa kuota harian: ${quota.remaining} video`
          )
        },
      })

      // ── 9. Daftar Perintah Video (!vidmodels) ──────────────────────────
      context.commands.register({
        name: 'vidmodels',
        aliases: ['videomodels'],
        description: 'Daftar perintah pengolahan video',
        category: 'tools',
        scope: 'both',
        menuOrder: 23,
        cooldownMs: 5_000,
        handler: async (cmdContext: CommandContext) => {
          await cmdContext.reply(
            `Status: Berhasil\n` +
            `Daftar perintah video:\n` +
            `• ${cmdContext.prefix}vid <deskripsi> - Membuat video dari teks atau gambar\n` +
            `• ${cmdContext.prefix}vcompress - Mengecilkan ukuran video\n` +
            `• ${cmdContext.prefix}vtrim <mulai> [selesai] - Memotong durasi video\n` +
            `• ${cmdContext.prefix}vspeed <angka>x - Mengatur kecepatan video\n` +
            `• ${cmdContext.prefix}vmute - Menghilangkan audio video\n` +
            `• ${cmdContext.prefix}vvn - Mengekstrak audio video menjadi pesan suara`
          )
        },
      })
    },
  }
}
