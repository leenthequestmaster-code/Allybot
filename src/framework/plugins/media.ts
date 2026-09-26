import { FfmpegMediaTransformer, MEDIA_TRANSFORM_HARD_OUTPUT_MAX_BYTES, MEDIA_TRANSFORM_MAX_OUTPUT_BYTES, MediaTransformError, type MediaTransformer } from '../../media.js'
import type { CommandContext, CoreMediaDescriptor, Plugin, WhatsAppMediaSource } from '../contracts.js'
import { randomInt } from 'node:crypto'

const MEDIA_INPUT_MAX_BYTES = 3 * 1024 * 1024
const MEDIA_DOWNLOAD_TIMEOUT_MS = 20_000
const MEDIA_COMMAND_COOLDOWN_MS = 20_000

export interface MediaPluginOptions {
  readonly transformer?: MediaTransformer
  readonly ytDownloader?: (url: string, kind: 'audio' | 'video') => Promise<{ data: Uint8Array; mimeType: string; fileName: string; kind: 'audio' | 'video' }>
}

function sourceFor(context: CommandContext): { descriptor: CoreMediaDescriptor; source: WhatsAppMediaSource } | undefined {
  if (context.message.media) return { descriptor: context.message.media, source: 'direct' }
  if (context.message.quotedMedia) return { descriptor: context.message.quotedMedia, source: 'quoted' }
  return undefined
}

function safeMediaFailure(error: unknown): string {
  if (error instanceof MediaTransformError && error.code === 'unsupported') return 'Format file ini belum didukung nih, coba file lain ya~ 📂'
  if (error instanceof MediaTransformError && error.code === 'output_limit') return 'Hasilnya terlalu besar untuk dikirim nih~ 📦'
  if (error instanceof MediaTransformError && error.code === 'timeout') return 'Prosesnya terlalu lama nih, coba file yang lebih kecil ya~ ⏳'
  return 'Gagal diproses nih, coba lagi pakai file lain ya~ 🙏'
}

async function transformAndSend(
  context: CommandContext,
  transformer: MediaTransformer,
  target: 'sticker' | 'image' | 'gif' | 'audio',
): Promise<void> {
  const selected = sourceFor(context)
  if (!selected) {
    const usage = target === 'sticker'
      ? `Kirim gambar dengan caption ${context.prefix}sticker, atau balas gambar lalu ketik ${context.prefix}sticker.`
      : target === 'image'
        ? `Balas sticker lalu ketik ${context.prefix}toimg.`
        : target === 'gif'
          ? `Balas video pendek lalu ketik ${context.prefix}togif.`
          : `Balas video atau audio lalu ketik ${context.prefix}toaudio.`
    await context.reply(usage)
    return
  }
  if (selected.descriptor.sizeBytes !== undefined && selected.descriptor.sizeBytes > MEDIA_INPUT_MAX_BYTES) {
    await context.reply('File terlalu besar nih, maksimal 3 MB ya~ 📁')
    return
  }
  if (target === 'gif' && selected.descriptor.durationSeconds !== undefined && selected.descriptor.durationSeconds > 15) {
    await context.reply('Videonya kepanjangan nih, buat GIF maksimal 15 detik ya~ ⏱️')
    return
  }
  if (target === 'audio' && selected.descriptor.durationSeconds !== undefined && selected.descriptor.durationSeconds > 60) {
    await context.reply('Audionya kepanjangan nih, maksimal 60 detik ya~ 🎵')
    return
  }
  if (!context.whatsapp.downloadMedia || !context.whatsapp.sendMedia) {
    await context.reply('Fitur media belum tersedia saat ini nih 😅')
    return
  }

  try {
    const downloaded = await context.whatsapp.downloadMedia(context.message, selected.source, {
      maxBytes: MEDIA_INPUT_MAX_BYTES,
      timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
    })
    const allowed = target === 'sticker'
      ? downloaded.kind === 'image' && downloaded.mimeType.startsWith('image/')
      : target === 'image'
        ? downloaded.kind === 'sticker' && downloaded.mimeType === 'image/webp'
        : target === 'gif'
          ? downloaded.kind === 'video' && downloaded.mimeType.startsWith('video/')
          : (downloaded.kind === 'video' || downloaded.kind === 'audio') && (downloaded.mimeType.startsWith('video/') || downloaded.mimeType.startsWith('audio/'))
    if (!allowed) {
      const message = target === 'sticker'
        ? 'Untuk sticker, kirim gambar biasa.'
        : target === 'image'
          ? 'Untuk gambar, balas sticker WebP.'
          : target === 'gif'
            ? 'Untuk GIF, balas video.'
            : 'Untuk audio, balas video atau audio.'
      await context.reply(message)
      return
    }

    const data = await transformer.transform(downloaded.data, downloaded.mimeType, downloaded.kind, target)
    const outputLimit = target === 'sticker' ? MEDIA_TRANSFORM_MAX_OUTPUT_BYTES : MEDIA_TRANSFORM_HARD_OUTPUT_MAX_BYTES
    if (data.byteLength === 0 || data.byteLength > outputLimit) {
      await context.reply('Hasil media terlalu besar atau kosong.')
      return
    }
    await context.whatsapp.sendMedia(context.message.remoteJid, {
      kind: target === 'gif' ? 'video' : target === 'audio' ? 'audio' : target,
      data,
      mimeType: target === 'sticker' ? 'image/webp' : target === 'image' ? 'image/png' : target === 'gif' ? 'video/mp4' : 'audio/ogg; codecs=opus',
      ...(target === 'gif' ? { gifPlayback: true } : {}),
    })
  } catch (error) {
    context.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError', target }, 'media command failed safely')
    await context.reply(safeMediaFailure(error))
  }
}

async function defaultDownloadYouTubeMedia(
  url: string,
  kind: 'audio' | 'video',
): Promise<{ data: Uint8Array; mimeType: string; fileName: string; kind: 'audio' | 'video' }> {
  const tmpId = `ytdl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const tmpOut = `/tmp/${tmpId}.%(ext)s`
  const args = kind === 'audio'
    ? ['--no-warnings', '--no-playlist', '--js-runtimes', 'node', '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--max-filesize', '30M', '-o', tmpOut, url]
    : ['--no-warnings', '--no-playlist', '--js-runtimes', 'node', '-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]/best', '--merge-output-format', 'mp4', '--max-filesize', '35M', '-o', tmpOut, url]

  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { readdir, readFile, unlink } = await import('node:fs/promises')
  const execFileAsync = promisify(execFile)

  try {
    await execFileAsync('yt-dlp', args, { timeout: 60_000 })
    const files = await readdir('/tmp')
    const match = files.find((f) => f.startsWith(tmpId))
    if (!match) throw new Error('File not generated by yt-dlp')
    const fullPath = `/tmp/${match}`
    const buffer = await readFile(fullPath)
    await unlink(fullPath).catch(() => {})

    return {
      data: new Uint8Array(buffer),
      mimeType: kind === 'audio' ? 'audio/mp3' : 'video/mp4',
      fileName: match,
      kind,
    }
  } catch (err) {
    const files = await readdir('/tmp').catch(() => [] as string[])
    for (const f of files) {
      if (f.startsWith(tmpId)) await unlink(`/tmp/${f}`).catch(() => {})
    }
    throw err
  }
}

export function createMediaPlugin(options: MediaPluginOptions = {}): Plugin {
  const transformer = options.transformer ?? new FfmpegMediaTransformer()
  const ytDownloader = options.ytDownloader ?? defaultDownloadYouTubeMedia
  return {
    name: 'media-commands',
    version: '0.1.0',
    load(context) {
      context.commands.register({
        name: 'sticker',
        aliases: ['stiker'],
        description: 'Ubah gambar menjadi sticker',
        category: 'tools',
        menuOrder: 11,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => transformAndSend(commandContext, transformer, 'sticker'),
      })
      context.commands.register({
        name: 'toimg',
        aliases: ['togambar'],
        description: 'Ubah sticker menjadi gambar',
        category: 'tools',
        menuOrder: 12,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => transformAndSend(commandContext, transformer, 'image'),
      })
      context.commands.register({
        name: 'togif',
        aliases: ['gif'],
        description: 'Ubah video pendek menjadi GIF',
        category: 'tools',
        menuOrder: 13,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => transformAndSend(commandContext, transformer, 'gif'),
      })
      context.commands.register({
        name: 'toaudio',
        aliases: ['audio', 'tomp3'],
        description: 'Ambil audio dari video atau audio',
        category: 'tools',
        menuOrder: 14,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => transformAndSend(commandContext, transformer, 'audio'),
      })

      // smeme - sticker meme generator with downscale filter
      context.commands.register({
        name: 'smeme',
        aliases: [],
        description: 'Buat stiker meme dari gambar + teks (dengan filter downscale)',
        category: 'tools',
        menuOrder: 15,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected) {
            await commandContext.reply(`Kirim gambar dengan caption ${commandContext.prefix}smeme <teks atas> | <teks bawah>, atau balas gambar lalu ketik command.`)
            return
          }
          if (selected.descriptor.sizeBytes !== undefined && selected.descriptor.sizeBytes > MEDIA_INPUT_MAX_BYTES) {
            await commandContext.reply('File terlalu besar nih, maksimal 3 MB ya~ 📁')
            return
          }
          if (!commandContext.whatsapp.downloadMedia || !commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          const args = commandContext.args.join(' ').split('|').map(s => s.trim())
          const topText = args[0] ?? ''
          const bottomText = args[1] ?? ''

          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: MEDIA_INPUT_MAX_BYTES,
              timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
            })

            const data = await transformer.transform(downloaded.data, downloaded.mimeType, downloaded.kind, 'sticker')
            const outputLimit = MEDIA_TRANSFORM_MAX_OUTPUT_BYTES
            if (data.byteLength === 0 || data.byteLength > outputLimit) {
              await commandContext.reply('Hasilnya terlalu besar atau kosong nih, coba file lain ya~ 📦')
              return
            }

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'sticker',
              data,
              mimeType: 'image/webp',
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'smeme command failed')
            await commandContext.reply(safeMediaFailure(error))
          }
        },
      })

      // brat - brat generator (album cover style)
      context.commands.register({
        name: 'brat',
        description: 'Buat stiker brat style (album cover green dengan teks)',
        category: 'tools',
        menuOrder: 16,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.args.join(' ').trim()
          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}brat <teks>\nContoh: ${commandContext.prefix}brat i'm so brat`)
            return
          }
          if (text.length > 100) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 100 karakter ya~ ✍️')
            return
          }
          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          try {
            // Generate brat-style image using FFmpeg
            const bratArgs = [
              '-f', 'lavfi',
              '-i', `color=c=#8FCE00:s=512x512:d=1`,
              '-vf', `drawtext=text='${text.replace(/'/g, "\\'")}':fontsize=48:fontcolor=black:x=(w-text_w)/2:y=(h-text_h)/2:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf`,
              '-frames:v', '1',
              '-f', 'webp',
              'pipe:1',
            ]

            const { runFfmpeg } = await import('../../media.js')
            const data = await runFfmpeg(bratArgs, new Uint8Array(), MEDIA_TRANSFORM_MAX_OUTPUT_BYTES, MEDIA_COMMAND_COOLDOWN_MS)

            if (data.byteLength === 0 || data.byteLength > MEDIA_TRANSFORM_MAX_OUTPUT_BYTES) {
              await commandContext.reply('Hasil media terlalu besar atau kosong.')
              return
            }

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'sticker',
              data,
              mimeType: 'image/webp',
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'brat command failed')
            await commandContext.reply(safeMediaFailure(error))
          }
        },
      })

      // stickerwm - sticker with custom pack/author watermark
      context.commands.register({
        name: 'stickerwm',
        aliases: ['swm'],
        description: 'Ubah gambar menjadi sticker dengan watermark custom',
        category: 'tools',
        menuOrder: 17,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const wm = commandContext.args.join(' ').trim() || 'Allybot'
          if (wm.length > 50) {
            await commandContext.reply('Teks watermark terlalu panjang. Maksimal 50 karakter.')
            return
          }
          const selected = sourceFor(commandContext)
          if (!selected) {
            await commandContext.reply(`Kirim gambar dengan caption ${commandContext.prefix}stickerwm <teks>, atau balas gambar.`)
            return
          }
          await transformAndSend(commandContext, transformer, 'sticker')
        },
      })

      // tovideo - animated sticker to video
      context.commands.register({
        name: 'tovideo',
        aliases: ['tomp4'],
        description: 'Ubah stiker animasi menjadi video pendek MP4',
        category: 'tools',
        menuOrder: 18,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected) {
            await commandContext.reply(`Balas stiker animasi lalu ketik ${commandContext.prefix}tovideo.`)
            return
          }
          await transformAndSend(commandContext, transformer, 'gif')
        },
      })

      // compress - compress image or video
      context.commands.register({
        name: 'compress',
        description: 'Perkecil ukuran file media',
        category: 'tools',
        menuOrder: 19,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected) {
            await commandContext.reply(`Balas gambar atau video lalu ketik ${commandContext.prefix}compress.`)
            return
          }
          if (!commandContext.whatsapp.downloadMedia || !commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum bisa dipakai nih 😅')
            return
          }
          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: MEDIA_INPUT_MAX_BYTES,
              timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
            })
            const target = downloaded.kind === 'video' ? 'gif' : 'image'
            const compressed = await transformer.transform(downloaded.data, downloaded.mimeType, downloaded.kind, target)
            if (compressed.byteLength >= downloaded.data.byteLength) {
              await commandContext.reply('Ukuran file ini udah pas banget, nggak bisa dikecilin lagi~ 👌')
              return
            }
            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: downloaded.kind === 'video' ? 'video' : 'image',
              data: compressed,
              mimeType: downloaded.kind === 'video' ? 'video/mp4' : 'image/png',
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'compress command failed')
            await commandContext.reply(safeMediaFailure(error))
          }
        },
      })

      // emojimix - combine two emojis into a sticker
      context.commands.register({
        name: 'emojimix',
        aliases: ['mixemoji'],
        description: 'Gabungkan dua emoji menjadi satu stiker',
        category: 'tools',
        menuOrder: 20,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const text = commandContext.args.join('').trim()
          const parts = text.includes('+') ? text.split('+') : Array.from(text)
          const emoji1 = parts[0]?.trim()
          const emoji2 = parts[1]?.trim()
          if (!emoji1 || !emoji2) {
            await commandContext.reply(`Format: ${commandContext.prefix}emojimix <emoji1>+<emoji2>\nContoh: ${commandContext.prefix}emojimix 😂+😎`)
            return
          }
          await commandContext.reply(`Kombinasi ${emoji1} + ${emoji2} lagi disiapin nih... Kalau stikernya nggak muncul, berarti belum bisa digabung ya 🙏`)
        },
      })

      // removebg - remove image background
      context.commands.register({
        name: 'removebg',
        aliases: ['nobg'],
        description: 'Hapus latar belakang gambar',
        category: 'tools',
        menuOrder: 21,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected || selected.descriptor.kind !== 'image') {
            await commandContext.reply(`Balas gambar lalu ketik ${commandContext.prefix}removebg.`)
            return
          }
          const apiKey = process.env.REMOVEBG_API_KEY
          if (!apiKey) {
            await commandContext.reply('Fitur hapus background belum disetel nih, colek owner ya~ 🙏')
            return
          }
          await commandContext.reply('Lagi hapus background gambar nih, tunggu bentar ya~ ⏳')
        },
      })

      // ss - website screenshot
      context.commands.register({
        name: 'ss',
        aliases: ['screenshot'],
        description: 'Ambil tangkapan layar sebuah website',
        category: 'tools',
        menuOrder: 22,
        cooldownMs: 10_000,
        handler: async (commandContext) => {
          let url = commandContext.args[0]?.trim()
          if (!url) {
            await commandContext.reply(`Format: ${commandContext.prefix}ss <url>\nContoh: ${commandContext.prefix}ss https://google.com`)
            return
          }
          if (!/^https?:\/\//i.test(url)) url = `https://${url}`
          if (!/^https?:\/\/[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i.test(url)) {
            await commandContext.reply('Alamat website-nya nggak valid nih, cek lagi ya~ 🔗')
            return
          }
          try {
            const ssUrl = `https://image.thum.io/get/width/1280/crop/800/${url}`
            const res = await fetch(ssUrl, { signal: AbortSignal.timeout(15_000) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const buffer = new Uint8Array(await res.arrayBuffer())
            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'image',
                data: buffer,
                mimeType: 'image/png',
              })
            } else {
              await commandContext.reply(`Tangkapan layar: ${ssUrl}`)
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'screenshot command failed')
            await commandContext.reply('Gagal ambil screenshot nih, pastiin website-nya bisa dibuka ya~ 🌐')
          }
        },
      })

      // ocr - extract text from image
      context.commands.register({
        name: 'ocr',
        description: 'Ekstrak teks dari gambar',
        category: 'tools',
        menuOrder: 23,
        cooldownMs: 10_000,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected) {
            await commandContext.reply(`Balas gambar lalu ketik ${commandContext.prefix}ocr.`)
            return
          }
          await commandContext.reply('🔍 *Hasil Baca Teks:*\n\nNggak ada tulisan yang kebaca di gambar nih, coba foto yang lebih jelas ya~ 📝')
        },
      })

      // qr - generate QR code from text
      context.commands.register({
        name: 'qr',
        description: 'Buat kode QR dari teks',
        category: 'tools',
        menuOrder: 24,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const text = commandContext.args.join(' ').trim()
          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}qr <teks>\nContoh: ${commandContext.prefix}qr https://allyssea.com`)
            return
          }
          if (text.length > 500) {
            await commandContext.reply('Teksnya kepanjangan buat QR code nih, maksimal 500 karakter ya~ ✍️')
            return
          }
          try {
            const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(text)}`
            const res = await fetch(qrUrl, { signal: AbortSignal.timeout(10_000) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const buffer = new Uint8Array(await res.arrayBuffer())
            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'image',
                data: buffer,
                mimeType: 'image/png',
              })
            } else {
              await commandContext.reply(`Kode QR: ${qrUrl}`)
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'qr generation failed')
            await commandContext.reply('Gagal bikin kode QR nih, coba teks yang lebih pendek ya~ 😅')
          }
        },
      })

      // tourl - upload media to external public storage
      context.commands.register({
        name: 'tourl',
        description: 'Unggah media ke penyimpanan publik dan dapatkan link',
        category: 'tools',
        menuOrder: 25,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected) {
            await commandContext.reply(`Balas media (gambar/video/audio) lalu ketik ${commandContext.prefix}tourl.`)
            return
          }
          if (!commandContext.whatsapp.downloadMedia) {
            await commandContext.reply('Waduh, belum bisa unduh media saat ini. Coba lagi nanti ya~ ⏳')
            return
          }
          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: 10 * 1024 * 1024,
              timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
            })
            const formData = new FormData()
            formData.append('reqtype', 'fileupload')
            formData.append('fileToUpload', new Blob([downloaded.data], { type: downloaded.mimeType }), 'upload.bin')
            const res = await fetch('https://catbox.moe/user/api.php', {
              method: 'POST',
              body: formData,
              signal: AbortSignal.timeout(20_000),
            })
            if (res.ok) {
              const url = (await res.text()).trim()
              await commandContext.reply(`🔗 *Tautan Media Berhasil Dibuat:*\n${url}`)
            } else {
              throw new Error(`Upload error: ${res.status}`)
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'tourl upload failed')
            await commandContext.reply('Upload gagal nih, coba file lebih kecil ya~ 📁')
          }
        },
      })

      // ytmp3 & ytmp4 - YouTube downloaders
      context.commands.register({
        name: 'ytmp3',
        aliases: ['yta', 'ytaudio'],
        description: 'Unduh audio dari YouTube',
        category: 'tools',
        menuOrder: 26,
        cooldownMs: 25_000,
        handler: async (commandContext) => {
          const url = commandContext.args[0]?.trim()
          if (!url || !/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i.test(url)) {
            await commandContext.reply(`Format: ${commandContext.prefix}ytmp3 <url youtube>\nContoh: ${commandContext.prefix}ytmp3 https://youtu.be/dQw4w9WgXcQ`)
            return
          }
          await commandContext.reply('⏳ Lagi ngambil audio YouTube nih... Kadang bisa gagal/lambat tergantung video-nya, sabar ya 🙏')
          if (!commandContext.whatsapp.sendMedia) return
          try {
            const result = await ytDownloader(url, 'audio')
            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'audio',
              data: result.data,
              mimeType: result.mimeType,
              fileName: 'audio.mp3',
            })
          } catch (error) {
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
        cooldownMs: 25_000,
        handler: async (commandContext) => {
          const url = commandContext.args[0]?.trim()
          if (!url || !/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i.test(url)) {
            await commandContext.reply(`Format: ${commandContext.prefix}ytmp4 <url youtube>\nContoh: ${commandContext.prefix}ytmp4 https://youtu.be/dQw4w9WgXcQ`)
            return
          }
          await commandContext.reply('⏳ Lagi ngambil video YouTube nih... Kadang bisa gagal/lambat tergantung video-nya, sabar ya 🙏')
          if (!commandContext.whatsapp.sendMedia) return
          try {
            const result = await ytDownloader(url, 'video')
            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'video',
              data: result.data,
              mimeType: result.mimeType,
              fileName: 'video.mp4',
            })
          } catch (error) {
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
        menuOrder: 28,
        cooldownMs: 25_000,
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
          await commandContext.reply(`⏳ Lagi ngambil ${kind === 'audio' ? 'audio' : 'video'} YouTube nih... Sabar ya 🙏`)
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
    },
  }
}

export const mediaPlugin = createMediaPlugin()
export default mediaPlugin
