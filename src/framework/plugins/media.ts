import QRCode from 'qrcode'
import { FfmpegMediaTransformer, MEDIA_TRANSFORM_HARD_OUTPUT_MAX_BYTES, MEDIA_TRANSFORM_MAX_OUTPUT_BYTES, MediaTransformError, type MediaTransformer } from '../../media.js'
import type { CommandContext, CoreMediaDescriptor, Plugin, WhatsAppMediaSource } from '../contracts.js'
import { randomInt } from 'node:crypto'
import { resolveTikWm, resolveMedia, fetchMediaBuffer, extractMediaUrl } from '../../services/multidl.js'
import { upscaleImage } from '../../services/upscaler.js'
import { findEmojiMix, fetchEmojiMixBuffer } from '../../services/emojimix.js'
import { setStickerExif } from '../../services/sticker-exif.js'
import { VisualCardService } from '../../services/visual-card-service.js'
import {
  startSpackSession,
  getSpackSession,
  addImageToSpack,
  finishSpackSession,
  cancelSpackSession,
} from '../../services/spack-session.js'
import type { QuotaService } from '../../services/quota-service.js'

const MEDIA_INPUT_MAX_BYTES = 3 * 1024 * 1024
const MEDIA_VIDEO_INPUT_MAX_BYTES = 10 * 1024 * 1024
const MEDIA_DOWNLOAD_TIMEOUT_MS = 20_000
const MEDIA_COMMAND_COOLDOWN_MS = 3_000

function maxInputBytesFor(descriptor: CoreMediaDescriptor): number {
  return descriptor.kind === 'video' ? MEDIA_VIDEO_INPUT_MAX_BYTES : MEDIA_INPUT_MAX_BYTES
}

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

function runPythonScript(
  scriptPath: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 25_000
  return new Promise<void>((resolve, reject) => {
    import('node:child_process').then(({ spawn }) => {
      const py = spawn('python3', [scriptPath, ...args])
      let stderr = ''
      let settled = false
      let timer: NodeJS.Timeout | undefined

      const cleanup = () => {
        if (timer) clearTimeout(timer)
        py.stderr?.removeAllListeners()
        py.removeAllListeners('error')
        py.removeAllListeners('close')
      }

      const fail = (err: Error) => {
        if (settled) return
        settled = true
        cleanup()
        py.kill('SIGKILL')
        reject(err)
      }

      timer = setTimeout(() => {
        fail(new Error(`Python script execution timed out after ${timeoutMs}ms: ${scriptPath}`))
      }, timeoutMs)

      py.stderr?.on('data', (d) => {
        stderr = (stderr + d.toString()).slice(-4096)
      })
      py.once('error', (err) => {
        fail(err)
      })
      py.once('close', (code) => {
        if (settled) return
        settled = true
        cleanup()
        if (code === 0) resolve()
        else reject(new Error(`Python script exited with code ${code}: ${stderr}`))
      })
      py.stdin?.end()
    }).catch(reject)
  })
}

async function transformAndSend(
  context: CommandContext,
  transformer: MediaTransformer,
  target: 'sticker' | 'image' | 'gif' | 'audio',
  customPack?: string,
  customAuthor?: string,
): Promise<void> {
  const selected = sourceFor(context)
  if (!selected) {
    const usage = target === 'sticker'
      ? `Kirim gambar/video pendek dengan caption ${context.prefix}sticker, atau balas media lalu ketik ${context.prefix}sticker.`
      : target === 'image'
        ? `Balas sticker lalu ketik ${context.prefix}toimg.`
        : target === 'gif'
          ? `Balas video pendek atau stiker animasi lalu ketik ${context.prefix}togif.`
          : `Balas video atau audio lalu ketik ${context.prefix}toaudio.`
    await context.reply(usage)
    return
  }
  const limitBytes = maxInputBytesFor(selected.descriptor)
  if (selected.descriptor.sizeBytes !== undefined && selected.descriptor.sizeBytes > limitBytes) {
    const limitMb = Math.round(limitBytes / (1024 * 1024))
    await context.reply(`File terlalu besar nih, maksimal ${limitMb} MB ya~ 📁`)
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
      maxBytes: limitBytes,
      timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
    })
    const allowed = target === 'sticker'
      ? (downloaded.kind === 'image' && downloaded.mimeType.startsWith('image/')) ||
        (downloaded.kind === 'video' && downloaded.mimeType.startsWith('video/')) ||
        (downloaded.kind === 'sticker' && downloaded.mimeType === 'image/webp')
      : target === 'image'
        ? downloaded.kind === 'sticker' && downloaded.mimeType === 'image/webp'
        : target === 'gif'
          ? (downloaded.kind === 'video' && downloaded.mimeType.startsWith('video/')) || (downloaded.kind === 'sticker' && downloaded.mimeType === 'image/webp')
          : (downloaded.kind === 'video' || downloaded.kind === 'audio') && (downloaded.mimeType.startsWith('video/') || downloaded.mimeType.startsWith('audio/'))
    if (!allowed) {
      const message = target === 'sticker'
        ? 'Untuk sticker, kirim gambar, video pendek, atau balas stiker.'
        : target === 'image'
          ? 'Untuk gambar, balas sticker WebP.'
          : target === 'gif'
            ? 'Untuk GIF, balas video atau stiker animasi.'
            : 'Untuk audio, balas video atau audio.'
      await context.reply(message)
      return
    }

    let data = await transformer.transform(downloaded.data, downloaded.mimeType, downloaded.kind, target)
    if (target === 'sticker') {
      const defaultPack = 'Allybot Stickers'
      const defaultAuthor = context.message.pushName || 'Cyrus'
      data = setStickerExif(Buffer.from(data), customPack || defaultPack, customAuthor || defaultAuthor)
    }
    const outputLimit = target === 'sticker' ? MEDIA_TRANSFORM_MAX_OUTPUT_BYTES : MEDIA_TRANSFORM_HARD_OUTPUT_MAX_BYTES
    if (data.byteLength === 0 || data.byteLength > outputLimit) {
      await context.reply('Hasil media terlalu besar atau kosong.')
      return
    }

    const isAnimatedSticker =
      target === 'sticker' &&
      (downloaded.kind === 'video' ||
        downloaded.mimeType === 'image/gif' ||
        (downloaded.kind === 'sticker' &&
          (Buffer.from(downloaded.data).includes('ANIM') || Buffer.from(downloaded.data).includes('ANMF'))))

    await context.whatsapp.sendMedia(context.message.remoteJid, {
      kind: target === 'gif' ? 'video' : target === 'audio' ? 'audio' : target,
      data,
      mimeType: target === 'sticker' ? 'image/webp' : target === 'image' ? 'image/png' : target === 'gif' ? 'video/mp4' : 'audio/ogg; codecs=opus',
      ...(target === 'gif' ? { gifPlayback: true } : {}),
      ...(isAnimatedSticker ? { isAnimated: true } : {}),
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
  const formatArgs = kind === 'audio'
    ? ['-f', 'ba/b', '-x', '--audio-format', 'm4a', '--max-filesize', '30M', '-o', tmpOut, url]
    : ['-S', 'res:480,vcodec:h264,acodec:m4a', '-f', 'bv*[vcodec^=avc]+ba[acodec^=mp4a]/b[vcodec^=avc]/bv*+ba/b', '--merge-output-format', 'mp4', '--max-filesize', '45M', '-o', tmpOut, url]

  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { readdir, readFile, unlink } = await import('node:fs/promises')
  const execFileAsync = promisify(execFile)

  const runYtDlp = async (useProxy: boolean): Promise<void> => {
    const args = [
      '--no-warnings',
      '--no-playlist',
      '--js-runtimes',
      'node',
      ...(useProxy ? ['--proxy', 'socks5://127.0.0.1:10808'] : []),
      ...formatArgs,
    ]
    await execFileAsync('yt-dlp', args, { timeout: 90_000 })
  }

  try {
    try {
      await runYtDlp(true)
    } catch {
      await runYtDlp(false)
    }

    const files = await readdir('/tmp')
    const match = files.find((f) => f.startsWith(tmpId))
    if (!match) throw new Error('File not generated by yt-dlp')
    const fullPath = `/tmp/${match}`

    if (kind === 'video') {
      let codec = 'unknown'
      try {
        const { stdout } = await execFileAsync('ffprobe', [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream=codec_name',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          fullPath,
        ])
        codec = stdout.trim().toLowerCase()
      } catch {}

      const processedPath = `/tmp/${tmpId}_final.mp4`
      let transcodeSuccess = false

      if (codec === 'h264') {
        try {
          await execFileAsync('ffmpeg', [
            '-y', '-i', fullPath,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-movflags', '+faststart',
            processedPath,
          ], { timeout: 30_000 })
          transcodeSuccess = true
        } catch {
          transcodeSuccess = false
        }
      }

      if (!transcodeSuccess) {
        try {
          await execFileAsync('ffmpeg', [
            '-y', '-i', fullPath,
            '-c:v', 'libx264',
            '-pix_fmt', 'yuv420p',
            '-preset', 'veryfast',
            '-crf', '24',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-movflags', '+faststart',
            processedPath,
          ], { timeout: 45_000 })
          transcodeSuccess = true
        } catch {
          transcodeSuccess = false
        }
      }

      if (transcodeSuccess) {
        // Stage 2: Second-stage ffprobe compatibility verification gate
        try {
          const { stdout: probeOut } = await execFileAsync('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            processedPath,
          ], { timeout: 10_000 })
          const finalCodec = probeOut.trim().toLowerCase()
          if (finalCodec === 'h264') {
            await unlink(fullPath).catch(() => {})
            const buffer = await readFile(processedPath)
            await unlink(processedPath).catch(() => {})
            return {
              data: new Uint8Array(buffer),
              mimeType: 'video/mp4',
              fileName: `${tmpId}.mp4`,
              kind: 'video',
            }
          }
        } catch {
          // If gate inspection fails, fall back to reading processed or source
        }
      }
    }

    const buffer = await readFile(fullPath)
    await unlink(fullPath).catch(() => {})

    return {
      data: new Uint8Array(buffer),
      mimeType: kind === 'audio' ? 'audio/mp4' : 'video/mp4',
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
        aliases: ['stiker', 's'],
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

      // smeme - sticker meme generator with top and bottom text
      context.commands.register({
        name: 'smeme',
        aliases: [],
        description: 'Buat stiker meme dari gambar + teks atas dan bawah',
        category: 'tools',
        menuOrder: 15,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected) {
            await commandContext.reply(`Kirim gambar dengan caption ${commandContext.prefix}smeme <teks atas> | <teks bawah>, atau balas gambar lalu ketik command.`)
            return
          }
          const inputLimit = maxInputBytesFor(selected.descriptor)
          if (selected.descriptor.sizeBytes !== undefined && selected.descriptor.sizeBytes > inputLimit) {
            const limitMb = Math.round(inputLimit / (1024 * 1024))
            await commandContext.reply(`File terlalu besar nih, maksimal ${limitMb} MB ya~ 📁`)
            return
          }
          if (!commandContext.whatsapp.downloadMedia || !commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          const rawText = commandContext.args.join(' ').trim()
          let text = rawText
          let sizePercent = 50

          // Check if trailing size is specified: e.g. | 70% or "70%" or 70% or | 70
          const pipeParts = text.split('|').map((s) => s.trim())
          if (pipeParts.length >= 3) {
            const last = pipeParts[pipeParts.length - 1]?.replace(/["']/g, '').trim() ?? ''
            const match = last.match(/^(\d{1,2})%?$/)
            if (match) {
              sizePercent = Math.max(10, Math.min(90, parseInt(match[1], 10)))
              pipeParts.pop()
              text = pipeParts.join(' | ')
            }
          } else {
            const endMatch =
              text.match(/(?:[\s|]+)["']?(\d{1,2})%["']?\s*$/i) || text.match(/(?:[\s|]+)["'](\d{1,2})["']\s*$/)
            if (endMatch) {
              sizePercent = Math.max(10, Math.min(90, parseInt(endMatch[1], 10)))
              text = text.slice(0, endMatch.index).trim()
            }
          }

          let topText = ''
          let bottomText = ''
          if (text.includes('|')) {
            const parts = text.split('|')
            topText = parts[0]?.trim() ?? ''
            bottomText = parts.slice(1).join('|').trim()
          } else {
            topText = text
          }

          if (!topText && !bottomText) {
            await commandContext.reply(
              `Format: ${commandContext.prefix}smeme <teks atas> | <teks bawah> [ukuran%]\nContoh: ${commandContext.prefix}smeme ketika bot | berhasil diperbaiki | 70%\n(Ukuran default 50%, rentang 10-90%)`,
            )
            return
          }

          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: inputLimit,
              timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
            })

            const { writeFile, unlink, readFile } = await import('node:fs/promises')
            const { spawn } = await import('node:child_process')
            const { join } = await import('node:path')

            const tmpId = `smeme_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            const outPath = `/tmp/${tmpId}_out.webp`
            const scriptPath = join(process.cwd(), 'scripts', 'generate-smeme.py')

            const isAnimated =
              downloaded.kind === 'video' ||
              downloaded.mimeType === 'image/gif' ||
              (downloaded.kind === 'sticker' &&
                (Buffer.from(downloaded.data).includes('ANIM') || Buffer.from(downloaded.data).includes('ANMF')))

            let dataWithExif: Buffer | null = null

            try {
              if (isAnimated) {
                const overlayPath = `/tmp/${tmpId}_overlay.png`
                try {
                  await runPythonScript(scriptPath, ['--overlay', overlayPath, topText, bottomText, String(sizePercent)], { timeoutMs: 25_000 })

                  const ext = downloaded.kind === 'video' ? 'mp4' : (downloaded.mimeType === 'image/gif' ? 'gif' : 'webp')
                  const animInPath = `/tmp/${tmpId}_in.${ext}`
                  await writeFile(animInPath, downloaded.data)
                  try {
                    await new Promise<void>((resolve, reject) => {
                      const ffmpeg = spawn('ffmpeg', [
                        '-y',
                        '-i', animInPath,
                        '-loop', '1',
                        '-i', overlayPath,
                        '-t', '6',
                        '-filter_complex',
                        '[0:v]fps=10,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0.0,format=rgba[base];[base][1:v]overlay=0:0:shortest=1[v]',
                        '-map', '[v]',
                        '-an',
                        '-c:v', 'libwebp',
                        '-lossless', '0',
                        '-compression_level', '4',
                        '-q:v', '45',
                        '-loop', '0',
                        '-f', 'webp',
                        outPath,
                      ])
                      let settled = false
                      const timer = setTimeout(() => {
                        if (!settled) {
                          settled = true
                          ffmpeg.kill('SIGKILL')
                          reject(new Error('ffmpeg timeout'))
                        }
                      }, 25_000)
                      ffmpeg.once('error', (err) => {
                        if (!settled) {
                          settled = true
                          clearTimeout(timer)
                          reject(err)
                        }
                      })
                      ffmpeg.once('close', (code) => {
                        if (!settled) {
                          settled = true
                          clearTimeout(timer)
                          if (code === 0) resolve()
                          else reject(new Error(`ffmpeg exited with code ${code}`))
                        }
                      })
                    })
                    const rawData = await readFile(outPath)
                    dataWithExif = setStickerExif(rawData, 'Meme Stickers', 'Allybot')
                  } finally {
                    await unlink(animInPath).catch(() => {})
                  }
                } finally {
                  await unlink(overlayPath).catch(() => {})
                  await unlink(outPath).catch(() => {})
                }
              } else {
                // Static image
                const inPath = `/tmp/${tmpId}_in.png`
                try {
                  await writeFile(inPath, downloaded.data)
                  await runPythonScript(scriptPath, [inPath, outPath, topText, bottomText, String(sizePercent)], { timeoutMs: 25_000 })
                  const rawData = await readFile(outPath)
                  dataWithExif = setStickerExif(rawData, 'Meme Stickers', 'Allybot')
                } finally {
                  await unlink(inPath).catch(() => {})
                  await unlink(outPath).catch(() => {})
                }
              }
            } catch {
              const rawData = await transformer.transform(downloaded.data, downloaded.mimeType, downloaded.kind, 'sticker')
              dataWithExif = setStickerExif(Buffer.from(rawData), 'Meme Stickers', 'Allybot')
            }

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'sticker',
              data: new Uint8Array(dataWithExif),
              mimeType: 'image/webp',
              ...(isAnimated ? { isAnimated: true } : {}),
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'smeme command failed')
            await commandContext.reply(safeMediaFailure(error))
          }
        },
      })

      // brat - Satori + Resvg powered Brat album cover generator
      context.commands.register({
        name: 'brat',
        description: 'Buat gambar cover album brat teks hitam background putih dengan efek buram khas',
        category: 'tools',
        menuOrder: 16,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args
          const wantsSticker = rawArgs.some((a) => a === '--sticker' || a === '-s')
          const text = rawArgs.filter((a) => !a.startsWith('--') && !a.startsWith('-')).join(' ').trim() ||
            commandContext.message.quotedText?.trim() || ''

          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}brat <teks>\nContoh: ${commandContext.prefix}brat i'm so brat`)
            return
          }
          if (text.length > 200) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 200 karakter ya~ ✍️')
            return
          }
          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          await commandContext.react('⏳')

          try {
            const png = await VisualCardService.renderBrat(text)

            if (wantsSticker) {
              const webp = await VisualCardService.pngToWebpSticker(png, 512)
              const finalWebp = setStickerExif(webp, 'Brat', commandContext.message.pushName || 'Cyrus')
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'sticker',
                data: new Uint8Array(finalWebp),
                mimeType: 'image/webp',
              })
            } else {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'image',
                data: new Uint8Array(png),
                mimeType: 'image/png',
                caption: 'brat',
              })
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'brat command failed')
            await commandContext.reply(safeMediaFailure(error))
          }
        },
      })

      // brats - direct sticker version of brat
      context.commands.register({
        name: 'brats',
        aliases: ['bratsticker'],
        description: 'Buat stiker brat teks hitam background putih dengan efek buram khas',
        category: 'tools',
        menuOrder: 17,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.args.join(' ').trim() || commandContext.message.quotedText?.trim() || ''
          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}brats <teks>\nContoh: ${commandContext.prefix}brats i'm so brat`)
            return
          }
          if (text.length > 200) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 200 karakter ya~ ✍️')
            return
          }
          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          await commandContext.react('⏳')

          try {
            const png = await VisualCardService.renderBrat(text)
            const webp = await VisualCardService.pngToWebpSticker(png, 512)
            const finalWebp = setStickerExif(webp, 'Brat', commandContext.message.pushName || 'Cyrus')
            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'sticker',
              data: new Uint8Array(finalWebp),
              mimeType: 'image/webp',
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'brats command failed')
            await commandContext.reply(safeMediaFailure(error))
          }
        },
      })

      // bratvid - animated word-by-word kinetic typography sticker / video
      context.commands.register({
        name: 'bratvid',
        aliases: ['bvid', 'bratvideo', 'bratanim'],
        description: 'Buat stiker animasi atau video teks brat kata demi kata',
        category: 'tools',
        menuOrder: 17,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args
          const wantsVideo = rawArgs.some((a) => a === '--video' || a === '--mp4' || a === '-v')
          const text = rawArgs.filter((a) => !a.startsWith('--') && !a.startsWith('-')).join(' ').trim()

          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}bratvid <teks>\nContoh: ${commandContext.prefix}bratvid i am so brat\nOpsi: Tambahkan --green, --black, atau --video`)
            return
          }
          if (text.length > 150) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 150 karakter ya~ ✍️')
            return
          }
          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          await commandContext.react('⏳')

          try {
            const ext = wantsVideo ? 'mp4' : 'webp'
            const tmpId = `bvid_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
            const outPath = `/tmp/${tmpId}.${ext}`

            const { spawn } = await import('node:child_process')
            const { readFile, unlink } = await import('node:fs/promises')
            const { join } = await import('node:path')

            const scriptPath = join(process.cwd(), 'scripts', 'generate-bratvid.py')
            await runPythonScript(scriptPath, [outPath, ...commandContext.args], { timeoutMs: 45_000 })

            const data = await readFile(outPath)
            await unlink(outPath).catch(() => {})

            if (data.byteLength === 0 || data.byteLength > 15 * 1024 * 1024) {
              await commandContext.reply('Hasil media terlalu besar atau gagal dibuat.')
              return
            }

            if (wantsVideo) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'video',
                data: new Uint8Array(data),
                mimeType: 'video/mp4',
                gifPlayback: true,
              })
            } else {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'sticker',
                data: new Uint8Array(data),
                mimeType: 'image/webp',
              })
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'bratvid command failed')
            await commandContext.reply('Waduh, gagal ngerender stiker brat nih. Coba lagi nanti ya~ 🙏')
          }
        },
      })

      // stickerwm - sticker with custom pack/author watermark
      context.commands.register({
        name: 'stickerwm',
        aliases: ['swm'],
        description: 'Ubah gambar menjadi sticker dengan pack dan author custom',
        category: 'tools',
        menuOrder: 17,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const rawWm = commandContext.args.join(' ').trim()
          let packName = ''
          let authorName = ''

          if (rawWm.includes('|')) {
            const parts = rawWm.split('|')
            packName = parts[0]?.trim() || ''
            authorName = parts[1]?.trim() || ''
          } else if (rawWm) {
            packName = rawWm
            authorName = rawWm
          }

          if (packName.length > 50 || authorName.length > 50) {
            await commandContext.reply('Teks pack/author terlalu panjang. Maksimal 50 karakter.')
            return
          }

          const selected = sourceFor(commandContext)
          if (!selected) {
            await commandContext.reply(`Format: ${commandContext.prefix}stickerwm <pack> | <author>\nAtau: ${commandContext.prefix}stickerwm <nama>\nContoh: ${commandContext.prefix}swm Stiker Keren | Cyrus`)
            return
          }
          await transformAndSend(commandContext, transformer, 'sticker', packName, authorName)
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

      // compress - compress image or video with customizable percentage (1-90%)
      context.commands.register({
        name: 'compress',
        aliases: ['kompres', 'kecilkan'],
        description: 'Perkecil ukuran gambar atau video (opsional: !compress 1-90%)',
        category: 'tools',
        menuOrder: 19,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected) {
            await commandContext.reply(`Balas gambar atau video lalu ketik ${commandContext.prefix}compress (atau ${commandContext.prefix}compress 70 untuk kompresi 70%).`)
            return
          }
          if (!commandContext.whatsapp.downloadMedia || !commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum bisa dipakai nih 😅')
            return
          }

          let percent = 50
          const argNum = parseInt(commandContext.args[0]?.replace('%', '') ?? '', 10)
          if (!isNaN(argNum) && argNum >= 1 && argNum <= 90) {
            percent = argNum
          }

          await commandContext.react('⏳')

          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: MEDIA_INPUT_MAX_BYTES,
              timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
            })

            const { writeFile, unlink, readFile } = await import('node:fs/promises')
            const { spawn } = await import('node:child_process')
            const { join } = await import('node:path')

            const isVid = downloaded.kind === 'video'
            const inExt = isVid ? 'mp4' : 'png'
            const outExt = isVid ? 'mp4' : 'jpg'
            const tmpId = `comp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            const inPath = `/tmp/${tmpId}_in.${inExt}`
            const outPath = `/tmp/${tmpId}_out.${outExt}`

            let compressed: Uint8Array | null = null
            let savedPct = percent
            try {
              await writeFile(inPath, downloaded.data)
              const scriptPath = join(process.cwd(), 'scripts', 'compress-media.py')
              await new Promise<void>((resolve, reject) => {
                const py = spawn('python3', [scriptPath, inPath, outPath, String(percent)])
                let stderr = ''
                py.stderr.on('data', (d) => { stderr += d.toString() })
                py.on('error', reject)
                py.on('close', (code) => {
                  if (code === 0) resolve()
                  else reject(new Error(`compress-media.py exited with ${code}: ${stderr}`))
                })
              })
              const rawComp = await readFile(outPath)
              compressed = new Uint8Array(rawComp)
              savedPct = Math.max(0, Math.round((1 - compressed.byteLength / downloaded.data.byteLength) * 100))
            } catch {
              compressed = await transformer.transform(downloaded.data, downloaded.mimeType, downloaded.kind, isVid ? 'gif' : 'image')
            } finally {
              await unlink(inPath).catch(() => {})
              await unlink(outPath).catch(() => {})
            }

            const origKb = (downloaded.data.byteLength / 1024).toFixed(1)
            const compKb = (compressed.byteLength / 1024).toFixed(1)

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: isVid ? 'video' : 'image',
              data: compressed,
              mimeType: isVid ? 'video/mp4' : 'image/jpeg',
              caption: `📦 *Kompresi ${percent}% Berhasil!*\nUkuran: *${origKb} KB* ➔ *${compKb} KB* (Hemat ~${savedPct}%)`,
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
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const raw = commandContext.args.join('').trim()
          let emoji1 = ''
          let emoji2 = ''

          if (raw.includes('+')) {
            const parts = raw.split('+')
            emoji1 = parts[0]?.trim() || ''
            emoji2 = parts[1]?.trim() || ''
          } else {
            const matches = Array.from(raw.matchAll(/(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})/gu)).map((m) => m[0])
            if (matches.length >= 2) {
              emoji1 = matches[0]
              emoji2 = matches[1]
            }
          }

          if (!emoji1 || !emoji2) {
            await commandContext.reply(`Format: ${commandContext.prefix}emojimix <emoji1>+<emoji2>\nContoh: ${commandContext.prefix}emojimix 😂+😎`)
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          try {
            const url = await findEmojiMix(emoji1, emoji2)
            if (!url) {
              await commandContext.reply(`Kombinasi ${emoji1} + ${emoji2} belum ada di Google Emoji Kitchen nih~ 🍳`)
              return
            }

            const pngBuf = await fetchEmojiMixBuffer(url)
            if (!pngBuf) {
              await commandContext.reply('Waduh, gagal mengunduh gambar kombinasi emoji nih~ 🙏')
              return
            }

            const webpSticker = await transformer.transform(new Uint8Array(pngBuf), 'image/png', 'image', 'sticker')
            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'sticker',
              data: webpSticker,
              mimeType: 'image/webp',
            })
          } catch (error) {
            commandContext.logger.warn({ error }, 'emojimix command failed')
            await commandContext.reply('Gagal menggabungkan emoji nih, coba kombinasi emoji yang lain ya~ 🙏')
          }
        },
      })

      // qc - quote chat to sticker (Satori + Resvg Powered)
      context.commands.register({
        name: 'qc',
        aliases: ['quotly', 'qchat'],
        description: 'Ubah teks atau pesan yang dibalas menjadi stiker bubble chat',
        category: 'tools',
        menuOrder: 22,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args.join(' ').trim()
          const quotedText = commandContext.message.quotedText?.trim()
          const quotedSenderJid = commandContext.message.quotedSenderJid

          let targetText = ''
          let targetSenderJid = ''

          if (quotedText) {
            targetText = quotedText
            targetSenderJid = quotedSenderJid || commandContext.message.senderJid || ''
          } else if (rawArgs) {
            targetText = rawArgs
            targetSenderJid = commandContext.message.senderJid || ''
          } else {
            await commandContext.reply(`Balas pesan teks dengan ${commandContext.prefix}qc, atau ketik ${commandContext.prefix}qc <teks>`)
            return
          }

          if (targetText.length > 250) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 250 karakter ya~ ✍️')
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          // Format name and target text
          let senderName = ''
          if (quotedText && rawArgs) {
            senderName = rawArgs
          } else if (!quotedText && rawArgs.includes('|')) {
            const split = rawArgs.split('|')
            senderName = split[0].trim()
            targetText = split.slice(1).join('|').trim()
          }

          if (!senderName) {
            if (targetSenderJid === commandContext.message.senderJid && commandContext.message.pushName) {
              senderName = commandContext.message.pushName
            } else if (commandContext.message.pushName && !quotedText) {
              senderName = commandContext.message.pushName
            } else if (targetSenderJid) {
              const num = targetSenderJid.split('@')[0].split(':')[0]
              senderName = num ? `+${num}` : 'User'
            } else {
              senderName = 'User'
            }
          }

          // Format time
          const now = new Date()
          const hours = String(now.getHours()).padStart(2, '0')
          const minutes = String(now.getMinutes()).padStart(2, '0')
          const timeStr = `${hours}:${minutes}`

          // Fetch avatar in-memory
          let avatarBuffer: Buffer | undefined
          if (targetSenderJid && commandContext.whatsapp.getProfilePictureUrl) {
            try {
              const ppUrl = await commandContext.whatsapp.getProfilePictureUrl(targetSenderJid, 'image', 3000)
              if (ppUrl) {
                const ppRes = await fetch(ppUrl, { signal: AbortSignal.timeout(4000) })
                if (ppRes.ok) {
                  avatarBuffer = Buffer.from(await ppRes.arrayBuffer())
                }
              }
            } catch {
              // ignore avatar errors
            }
          }

          try {
            const png = await VisualCardService.renderQc({
              text: targetText,
              senderName,
              time: timeStr,
              avatarBuffer,
            })

            const rawWebp = await VisualCardService.pngToWebpSticker(png, 512)
            const finalWebp = setStickerExif(rawWebp, 'Quote Chat', senderName)

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'sticker',
              data: new Uint8Array(finalWebp),
              mimeType: 'image/webp',
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'qc command failed')
            await commandContext.reply('Waduh, gagal bikin quote chat stiker nih. Coba lagi ya~ 🙏')
          }
        },
      })

      // iqc - iPhone style context-menu quote chat
      context.commands.register({
        name: 'iqc',
        aliases: ['iosqc', 'fakechat'],
        description: 'Buat fake chat aesthetic bergaya WhatsApp iOS context menu',
        category: 'tools',
        menuOrder: 23,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args.join(' ').trim()
          const quotedText = commandContext.message.quotedText?.trim()
          const quotedSenderJid = commandContext.message.quotedSenderJid

          let targetText = ''
          let targetSenderJid = ''

          if (quotedText) {
            targetText = quotedText
            targetSenderJid = quotedSenderJid || commandContext.message.senderJid || ''
          } else if (rawArgs) {
            targetText = rawArgs
            targetSenderJid = commandContext.message.senderJid || ''
          } else {
            await commandContext.reply(`Balas pesan teks dengan ${commandContext.prefix}iqc, atau ketik ${commandContext.prefix}iqc <teks>`)
            return
          }

          if (targetText.length > 250) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 250 karakter ya~ ✍️')
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          let senderName = ''
          if (quotedText && rawArgs && !rawArgs.startsWith('--')) {
            senderName = rawArgs
          } else if (!quotedText && rawArgs.includes('|')) {
            const split = rawArgs.split('|')
            senderName = split[0].trim()
            targetText = split.slice(1).join('|').trim()
          }

          if (!senderName) {
            if (targetSenderJid === commandContext.message.senderJid && commandContext.message.pushName) {
              senderName = commandContext.message.pushName
            } else if (commandContext.message.pushName && !quotedText) {
              senderName = commandContext.message.pushName
            } else if (targetSenderJid) {
              const num = targetSenderJid.split('@')[0].split(':')[0]
              senderName = num ? `+${num}` : 'User'
            } else {
              senderName = 'User'
            }
          }

          const now = new Date()
          const hours = String(now.getHours()).padStart(2, '0')
          const minutes = String(now.getMinutes()).padStart(2, '0')
          const timeStr = `${hours}:${minutes}`

          let avatarBuffer: Buffer | undefined
          if (targetSenderJid && commandContext.whatsapp.getProfilePictureUrl) {
            try {
              const ppUrl = await commandContext.whatsapp.getProfilePictureUrl(targetSenderJid, 'image', 3000)
              if (ppUrl) {
                const ppRes = await fetch(ppUrl, { signal: AbortSignal.timeout(4000) })
                if (ppRes.ok) {
                  avatarBuffer = Buffer.from(await ppRes.arrayBuffer())
                }
              }
            } catch {
              // ignore avatar errors
            }
          }

          try {
            const png = await VisualCardService.renderIqc({
              text: targetText,
              senderName,
              time: timeStr,
              avatarBuffer,
            })

            const asSticker = commandContext.args.includes('--sticker') || commandContext.args.includes('-s')
            if (asSticker) {
              const webp = await VisualCardService.pngToWebpSticker(png, 512)
              const finalWebp = setStickerExif(webp, 'iOS Quote Chat', senderName)
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'sticker',
                data: new Uint8Array(finalWebp),
                mimeType: 'image/webp',
              })
            } else {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'image',
                data: new Uint8Array(png),
                mimeType: 'image/png',
                caption: `*iOS Quote Chat* — ${senderName}`,
              })
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'iqc command failed')
            await commandContext.reply('Waduh, gagal bikin iOS quote chat nih. Coba lagi ya~ 🙏')
          }
        },
      })

      // iqcs - iPhone style context-menu quote chat STICKER
      context.commands.register({
        name: 'iqcs',
        aliases: ['iosqcs', 'iqcsticker', 'fakechatsticker'],
        description: 'Buat stiker fake chat aesthetic bergaya WhatsApp iOS context menu',
        category: 'tools',
        menuOrder: 24,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args.join(' ').trim()
          const quotedText = commandContext.message.quotedText?.trim()
          const quotedSenderJid = commandContext.message.quotedSenderJid

          let targetText = ''
          let targetSenderJid = ''

          if (quotedText) {
            targetText = quotedText
            targetSenderJid = quotedSenderJid || commandContext.message.senderJid || ''
          } else if (rawArgs) {
            targetText = rawArgs
            targetSenderJid = commandContext.message.senderJid || ''
          } else {
            await commandContext.reply(`Balas pesan teks dengan ${commandContext.prefix}iqcs, atau ketik ${commandContext.prefix}iqcs <teks>`)
            return
          }

          if (targetText.length > 250) {
            await commandContext.reply('Teksnya kepanjangan nih, maksimal 250 karakter ya~ ✍️')
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          let senderName = ''
          if (quotedText && rawArgs && !rawArgs.startsWith('--')) {
            senderName = rawArgs
          } else if (!quotedText && rawArgs.includes('|')) {
            const split = rawArgs.split('|')
            senderName = split[0].trim()
            targetText = split.slice(1).join('|').trim()
          }

          if (!senderName) {
            if (targetSenderJid === commandContext.message.senderJid && commandContext.message.pushName) {
              senderName = commandContext.message.pushName
            } else if (commandContext.message.pushName && !quotedText) {
              senderName = commandContext.message.pushName
            } else if (targetSenderJid) {
              const num = targetSenderJid.split('@')[0].split(':')[0]
              senderName = num ? `+${num}` : 'User'
            } else {
              senderName = 'User'
            }
          }

          const now = new Date()
          const hours = String(now.getHours()).padStart(2, '0')
          const minutes = String(now.getMinutes()).padStart(2, '0')
          const timeStr = `${hours}:${minutes}`

          let avatarBuffer: Buffer | undefined
          if (targetSenderJid && commandContext.whatsapp.getProfilePictureUrl) {
            try {
              const ppUrl = await commandContext.whatsapp.getProfilePictureUrl(targetSenderJid, 'image', 3000)
              if (ppUrl) {
                const ppRes = await fetch(ppUrl, { signal: AbortSignal.timeout(4000) })
                if (ppRes.ok) {
                  avatarBuffer = Buffer.from(await ppRes.arrayBuffer())
                }
              }
            } catch {
              // ignore avatar errors
            }
          }

          try {
            const png = await VisualCardService.renderIqc({
              text: targetText,
              senderName,
              time: timeStr,
              avatarBuffer,
            })

            const asImage = commandContext.args.includes('--img') || commandContext.args.includes('-i')
            if (asImage) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'image',
                data: new Uint8Array(png),
                mimeType: 'image/png',
                caption: `*iOS Quote Chat* — ${senderName}`,
              })
            } else {
              const webp = await VisualCardService.pngToWebpSticker(png, 512)
              const finalWebp = setStickerExif(webp, 'iOS Quote Chat', senderName)
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'sticker',
                data: new Uint8Array(finalWebp),
                mimeType: 'image/webp',
              })
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'iqcs command failed')
            await commandContext.reply('Waduh, gagal bikin stiker iOS quote chat nih. Coba lagi ya~ 🙏')
          }
        },
      })

      // x - Twitter/X Mockup Card
      context.commands.register({
        name: 'x',
        aliases: ['tweet', 'faketweet', 'xpost'],
        description: 'Buat kartu postingan Twitter/X mockup yang elegan',
        category: 'tools',
        menuOrder: 25,
        cooldownMs: 4_000,
        handler: async (commandContext) => {
          const rawArgs = commandContext.args.join(' ').trim()
          const quotedText = commandContext.message.quotedText?.trim()
          const quotedSenderJid = commandContext.message.quotedSenderJid

          let tweetText = ''
          let targetSenderJid = ''

          if (quotedText) {
            tweetText = quotedText
            targetSenderJid = quotedSenderJid || commandContext.message.senderJid || ''
          } else if (rawArgs) {
            tweetText = rawArgs
            targetSenderJid = commandContext.message.senderJid || ''
          } else {
            await commandContext.reply(`Balas pesan teks dengan ${commandContext.prefix}x, atau ketik ${commandContext.prefix}x <teks>`)
            return
          }

          if (tweetText.length > 280) {
            await commandContext.reply('Teks postingan X maksimal 280 karakter ya~ ✍️')
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          let name = ''
          let handle = ''

          if (rawArgs.includes('|')) {
            const parts = rawArgs.split('|').map((s) => s.trim())
            if (parts.length >= 3) {
              name = parts[0]
              handle = parts[1].replace(/^@/, '')
              tweetText = parts.slice(2).join('|')
            } else if (parts.length === 2) {
              name = parts[0]
              handle = name.toLowerCase().replace(/[^a-z0-9_]/g, '')
              tweetText = parts[1]
            }
          }

          if (!name) {
            name = commandContext.message.pushName || 'User'
          }
          if (!handle) {
            const rawNum = targetSenderJid.split('@')[0].split(':')[0]
            handle = name.toLowerCase().replace(/[^a-z0-9_]/g, '') || rawNum || 'user'
          }

          let avatarBuffer: Buffer | undefined
          if (targetSenderJid && commandContext.whatsapp.getProfilePictureUrl) {
            try {
              const ppUrl = await commandContext.whatsapp.getProfilePictureUrl(targetSenderJid, 'image', 3000)
              if (ppUrl) {
                const ppRes = await fetch(ppUrl, { signal: AbortSignal.timeout(4000) })
                if (ppRes.ok) {
                  avatarBuffer = Buffer.from(await ppRes.arrayBuffer())
                }
              }
            } catch {}
          }

          try {
            const png = await VisualCardService.renderTweet({
              name,
              handle,
              text: tweetText,
              avatarBuffer,
              verified: true,
            })

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'image',
              data: new Uint8Array(png),
              mimeType: 'image/png',
              caption: `*Postingan X* — @${handle}`,
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'tweet command failed')
            await commandContext.reply('Waduh, gagal bikin tweet card nih. Coba lagi ya~ 🙏')
          }
        },
      })

      // ttstalk - TikTok Profile Card Stalker
      context.commands.register({
        name: 'ttstalk',
        aliases: ['tiktokstalk'],
        description: 'Lihat profil dan statistik akun TikTok secara visual',
        category: 'tools',
        menuOrder: 25,
        cooldownMs: 6_000,
        handler: async (commandContext) => {
          const username = commandContext.args[0]?.trim().replace(/^@/, '')
          if (!username) {
            await commandContext.reply(`Format: ${commandContext.prefix}ttstalk <username>\nContoh: ${commandContext.prefix}ttstalk tiktok`)
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          await commandContext.react('⏳')

          try {
            const res = await fetch(`https://www.tiktok.com/@${encodeURIComponent(username)}`, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9',
              },
              signal: AbortSignal.timeout(10_000),
            })

            if (!res.ok) {
              await commandContext.reply(`Profil TikTok @${username} tidak ditemukan atau privat nih 🥺`)
              return
            }

            const html = await res.text()
            const match = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([^<]+)<\/script>/)
            if (!match || !match[1]) {
              await commandContext.reply(`Gagal membaca profil TikTok @${username}. Coba beberapa saat lagi ya~`)
              return
            }

            const data = JSON.parse(match[1])
            const userDetail = data['__DEFAULT_SCOPE__']?.['webapp.user-detail']
            const userInfo = userDetail?.userInfo?.user
            const stats = userDetail?.userInfo?.stats

            if (!userInfo) {
              await commandContext.reply(`Akun TikTok @${username} tidak ditemukan nih 🥺`)
              return
            }

            const formatNum = (num: number | undefined) => {
              if (num === undefined || num === null) return '0'
              if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M'
              if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K'
              return num.toLocaleString('id-ID')
            }

            let avatarBuffer: Buffer | undefined
            const avatarUrl = userInfo.avatarLarger || userInfo.avatarMedium || userInfo.avatarThumb
            if (avatarUrl) {
              try {
                const avRes = await fetch(avatarUrl, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                  signal: AbortSignal.timeout(5_000),
                })
                if (avRes.ok) {
                  avatarBuffer = Buffer.from(await avRes.arrayBuffer())
                }
              } catch {}
            }

            const png = await VisualCardService.renderProfileCard({
              platform: 'tiktok',
              username: userInfo.uniqueId || username,
              nickname: userInfo.nickname || username,
              bio: userInfo.signature || '',
              avatarBuffer,
              verified: Boolean(userInfo.verified),
              stats: {
                followers: formatNum(stats?.followerCount),
                following: formatNum(stats?.followingCount),
                thirdStat: formatNum(stats?.heartCount ?? stats?.heart),
                thirdStatLabel: 'Total Likes',
              },
            })

            const caption = [
              '𓏼 *`𝐓𝐈𝐊𝐓𝐎𝐊 𝐏𝐑𝐎𝐅𝐈𝐋𝐄`*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              `⡇╌ *Nama* : ${userInfo.nickname || username}`,
              `⡇╌ *Username* : @${userInfo.uniqueId || username} ${userInfo.verified ? '✓' : ''}`,
              `⡇╌ *Followers* : ${formatNum(stats?.followerCount)}`,
              `⡇╌ *Following* : ${formatNum(stats?.followingCount)}`,
              `⡇╌ *Total Suka* : ${formatNum(stats?.heartCount ?? stats?.heart)}`,
              `⡇╌ *Video* : ${formatNum(stats?.videoCount)}`,
              '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
              userInfo.signature ? `📝 *Bio:*\n${userInfo.signature}\n─͜──͜──͜─  · • ·  ─͜──͜──͜─` : '',
              `🔗 https://tiktok.com/@${userInfo.uniqueId || username}`,
              '━━━━━━━━━━━━━━━━━━━━',
              '*© Allyssea Stalker Suite*',
            ].filter(Boolean).join('\n')

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'image',
              data: new Uint8Array(png),
              mimeType: 'image/png',
              caption,
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'ttstalk command failed')
            await commandContext.reply('Waduh, gagal mengambil profil TikTok. Coba lagi nanti ya~ 🙏')
          }
        },
      })

      // igstalk - Instagram Profile Card Stalker
      context.commands.register({
        name: 'igstalk',
        aliases: ['instagramstalk'],
        description: 'Lihat profil dan statistik akun Instagram secara visual',
        category: 'tools',
        menuOrder: 26,
        cooldownMs: 6_000,
        handler: async (commandContext) => {
          const username = commandContext.args[0]?.trim().replace(/^@/, '')
          if (!username) {
            await commandContext.reply(`Format: ${commandContext.prefix}igstalk <username>\nContoh: ${commandContext.prefix}igstalk instagram`)
            return
          }

          if (!commandContext.whatsapp.sendMedia) {
            await commandContext.reply('Fitur media belum tersedia saat ini nih 😅')
            return
          }

          await commandContext.react('⏳')

          try {
            let profileData: {
              fullName: string
              username: string
              bio: string
              followers: string
              following: string
              posts: string
              avatarUrl?: string
              verified?: boolean
            } | null = null

            // Try direct web_profile_info
            try {
              const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
                headers: {
                  'x-ig-app-id': '936619743392459',
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
                },
                signal: AbortSignal.timeout(6_000),
              })
              if (res.ok) {
                const data = (await res.json()) as any
                const user = data?.data?.user
                if (user) {
                  profileData = {
                    fullName: user.full_name || username,
                    username: user.username || username,
                    bio: user.biography || '',
                    followers: (user.edge_followed_by?.count ?? 0).toLocaleString('id-ID'),
                    following: (user.edge_follow?.count ?? 0).toLocaleString('id-ID'),
                    posts: (user.edge_owner_to_timeline_media?.count ?? 0).toLocaleString('id-ID'),
                    avatarUrl: user.profile_pic_url_hd || user.profile_pic_url,
                    verified: Boolean(user.is_verified),
                  }
                }
              }
            } catch {}

            // Fallback: DuckDuckGo search query for site:instagram.com/${username}
            if (!profileData) {
              try {
                const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=site:instagram.com/${encodeURIComponent(username)}`, {
                  headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
                  signal: AbortSignal.timeout(6_000),
                })
                if (ddgRes.ok) {
                  const html = await ddgRes.text()
                  const descMatch = html.match(/([0-9,.]+[KMBkmb]?)\s+Followers,\s*([0-9,.]+[KMBkmb]?)\s+Following,\s*([0-9,.]+[KMBkmb]?)\s+Posts\s*-\s*([^(@]+)\s*\(@([^)]+)\)\s*(?:on Instagram)?(?::\s*\"?([^\"]*)\"?)?/i)
                  if (descMatch) {
                    profileData = {
                      fullName: descMatch[4].trim(),
                      username: descMatch[5].trim(),
                      bio: descMatch[6]?.trim() || '',
                      followers: descMatch[1].trim(),
                      following: descMatch[2].trim(),
                      posts: descMatch[3].trim(),
                      verified: false,
                    }
                  }
                }
              } catch {}
            }

            if (!profileData) {
              await commandContext.reply(`Profil Instagram @${username} tidak ditemukan atau privat nih 🥺`)
              return
            }

            let avatarBuffer: Buffer | undefined
            if (profileData.avatarUrl) {
              try {
                const avRes = await fetch(profileData.avatarUrl, {
                  headers: { 'User-Agent': 'Mozilla/5.0' },
                  signal: AbortSignal.timeout(4_000),
                })
                if (avRes.ok) {
                  avatarBuffer = Buffer.from(await avRes.arrayBuffer())
                }
              } catch {}
            }

            const png = await VisualCardService.renderProfileCard({
              platform: 'instagram',
              username: profileData.username,
              nickname: profileData.fullName,
              bio: profileData.bio,
              avatarBuffer,
              verified: profileData.verified,
              stats: {
                followers: profileData.followers,
                following: profileData.following,
                thirdStat: profileData.posts,
                thirdStatLabel: 'Posts',
              },
            })

            const caption = [
              '𓏼 *`𝐈𝐍𝐒𝐓𝐀𝐆𝐑𝐀𝐌 𝐏𝐑𝐎𝐅𝐈𝐋𝐄`*',
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              `⡇╌ *Nama* : ${profileData.fullName}`,
              `⡇╌ *Username* : @${profileData.username} ${profileData.verified ? '✓' : ''}`,
              `⡇╌ *Followers* : ${profileData.followers}`,
              `⡇╌ *Following* : ${profileData.following}`,
              `⡇╌ *Postingan* : ${profileData.posts}`,
              '─͜──͜──͜─  · • ·  ─͜──͜──͜─',
              profileData.bio ? `📝 *Bio:*\n${profileData.bio}\n─͜──͜──͜─  · • ·  ─͜──͜──͜─` : '',
              `🔗 https://instagram.com/${profileData.username}`,
              '━━━━━━━━━━━━━━━━━━━━',
              '*© Allyssea Stalker Suite*',
            ].filter(Boolean).join('\n')

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'image',
              data: new Uint8Array(png),
              mimeType: 'image/png',
              caption,
            })
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'igstalk command failed')
            await commandContext.reply('Waduh, gagal mengambil profil Instagram. Coba lagi nanti ya~ 🙏')
          }
        },
      })

      // spack - multi-image sticker pack maker
      context.commands.register({
        name: 'spack',
        aliases: ['stickerpack', 'pack'],
        description: 'Kumpulkan beberapa gambar menjadi paket stiker (.wastickers)',
        category: 'tools',
        menuOrder: 23,
        cooldownMs: 3_000,
        handler: async (commandContext) => {
          const sub = commandContext.args[0]?.toLowerCase()
          const remoteJid = commandContext.message.remoteJid

          if (sub === 'done') {
            const active = getSpackSession(remoteJid)
            if (!active) {
              await commandContext.reply(`Nggak ada sesi pack yang aktif nih. Mulai dengan:\n${commandContext.prefix}spack <nama pack>`)
              return
            }
            await commandContext.react('⏳')
            const result = await finishSpackSession(remoteJid)
            if ('error' in result) {
              if (result.error.startsWith('too_few')) {
                const parts = result.error.split(':')
                await commandContext.reply(`Jumlah stiker kurang nih! Minimal butuh ${parts[2]} stiker, sekarang baru ada ${parts[1]}. Tambah gambar lagi ya~ 🖼️`)
              } else {
                await commandContext.reply('Gagal menyelesaikan sticker pack. Coba mulai sesi baru ya~ 🙏')
              }
              return
            }

            if (!commandContext.whatsapp.sendMedia) {
              await commandContext.reply('Fitur media tidak tersedia.')
              return
            }

            // 1. Send .wastickers document for import to Sticker Maker / WAStickerApps
            const safeFileName = `${result.packName.replace(/[^a-zA-Z0-9_-]/g, '_')}.wastickers`
            await commandContext.whatsapp.sendMedia(remoteJid, {
              kind: 'document',
              data: new Uint8Array(result.wastickersBuffer),
              mimeType: 'application/zip',
              fileName: safeFileName,
              caption: `📦 *${result.packName}* (${result.count} stiker)\nFile pack ini berformat *.wastickers*. Bisa kamu buka langsung di app *Sticker Maker* (Viko & Co) atau *WAStickerApps* untuk import ke WhatsApp!\n\nStikernya juga kukirimkan satu per satu di bawah ini ya~ ✨`,
            })

            // 2. Also send the stickers directly to the chat
            const author = commandContext.message.pushName || 'Cyrus'
            for (let i = 0; i < result.stickerBuffers.length; i++) {
              const stickerData = setStickerExif(result.stickerBuffers[i], result.packName, author)
              await commandContext.whatsapp.sendMedia(remoteJid, {
                kind: 'sticker',
                data: new Uint8Array(stickerData),
                mimeType: 'image/webp',
              })
              if (i < result.stickerBuffers.length - 1) {
                await new Promise((r) => setTimeout(r, 600))
              }
            }
            return
          }

          if (sub === 'cancel' || sub === 'batal') {
            const cancelled = await cancelSpackSession(remoteJid)
            if (cancelled) {
              await commandContext.reply('Sesi pembuatan sticker pack berhasil dibatalkan. 👍')
            } else {
              await commandContext.reply('Nggak ada sesi sticker pack yang aktif.')
            }
            return
          }

          if (sub === 'status') {
            const active = getSpackSession(remoteJid)
            if (!active) {
              await commandContext.reply('Nggak ada sesi sticker pack yang aktif.')
              return
            }
            const { readdir } = await import('node:fs/promises')
            const { join } = await import('node:path')
            const dir = join('/tmp', `spack_${remoteJid.replace(/[^a-zA-Z0-9_-]/g, '_')}`)
            const files = (await readdir(dir).catch(() => [])).filter((f) => f.startsWith('img_'))
            await commandContext.reply(`📦 Pack: *${active.packName}*\nTotal terkumpul: *${files.length}/30* stiker\n\nKirim atau balas gambar dengan *${commandContext.prefix}spack add* untuk menambah, atau *${commandContext.prefix}spack done* jika sudah selesai.`)
            return
          }

          if (sub === 'add') {
            const active = getSpackSession(remoteJid)
            if (!active) {
              await commandContext.reply(`Belum ada sesi pack nih. Buka sesi dulu dengan:\n${commandContext.prefix}spack <nama pack>`)
              return
            }
            const selected = sourceFor(commandContext)
            if (!selected || selected.descriptor.kind !== 'image') {
              await commandContext.reply(`Balas gambar atau kirim gambar dengan caption *${commandContext.prefix}spack add* ya~ 🖼️`)
              return
            }
            if (!commandContext.whatsapp.downloadMedia) {
              await commandContext.reply('Fitur unduh media belum tersedia.')
              return
            }
            try {
              const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
                maxBytes: MEDIA_INPUT_MAX_BYTES,
                timeoutMs: MEDIA_DOWNLOAD_TIMEOUT_MS,
              })
              const addRes = await addImageToSpack(remoteJid, Buffer.from(downloaded.data))
              if ('error' in addRes) {
                if (addRes.error === 'full') {
                  await commandContext.reply('Koleksi sudah penuh (maksimal 30 stiker). Ketik *!spack done* untuk memproses!')
                } else {
                  await commandContext.reply('Gagal menambahkan gambar. Coba lagi ya~')
                }
                return
              }
              await commandContext.reply(`✅ Gambar ke-${addRes.count}/${addRes.max} berhasil disimpan! Balas gambar berikutnya dengan *${commandContext.prefix}spack add*, atau ketik *${commandContext.prefix}spack done* kalau sudah cukup.`)
            } catch {
              await commandContext.reply('Gagal mengunduh gambar nih, coba lagi ya~ 🙏')
            }
            return
          }

          // Otherwise, start a new session
          const packName = commandContext.args.join(' ').trim()
          if (!packName) {
            await commandContext.reply(
              `Format pembuatan Sticker Pack:\n` +
              `• *${commandContext.prefix}spack <nama pack>* : Buka sesi baru\n` +
              `• Balas gambar + *${commandContext.prefix}spack add* : Tambah ke pack (min 3, maks 30)\n` +
              `• *${commandContext.prefix}spack status* : Cek jumlah stiker\n` +
              `• *${commandContext.prefix}spack done* : Selesai & kirim pack\n` +
              `• *${commandContext.prefix}spack cancel* : Batalkan sesi`
            )
            return
          }

          startSpackSession(remoteJid, commandContext.message.senderJid || '', packName)
          await commandContext.reply(
            `📦 Sesi pembuatan pack *${packName}* dibuka!\n\n` +
            `Silakan reply gambar satu per satu dengan *${commandContext.prefix}spack add*.\n` +
            `Minimal 3 stiker, maksimal 30 stiker.\n` +
            `Ketik *${commandContext.prefix}spack done* jika sudah selesai!`
          )
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
          await commandContext.react('⏳')
        },
      })

      // ss - website screenshot
      context.commands.register({
        name: 'ss',
        aliases: ['screenshot'],
        description: 'Ambil tangkapan layar sebuah website',
        category: 'tools',
        menuOrder: 22,
        cooldownMs: 5_000,
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

      // qr - generate QR code from text
      context.commands.register({
        name: 'qr',
        description: 'Buat kode QR dari teks',
        category: 'tools',
        menuOrder: 24,
        cooldownMs: 3_000,
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
            const pngBuffer = await QRCode.toBuffer(text, {
              width: 512,
              margin: 2,
              errorCorrectionLevel: "M",
            })
            const buffer = new Uint8Array(pngBuffer)
            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: "image",
                data: buffer,
                mimeType: "image/png",
              })
            } else {
              await commandContext.reply("Kode QR berhasil dibuat.")
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : "UnknownError" }, "qr generation failed")
            await commandContext.reply("Gagal bikin kode QR nih, coba teks yang lebih pendek ya~ 😅")
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

          const quotaService = commandContext.services.has('quota')
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

          const quotaService = commandContext.services.has('quota')
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

      // 29. !tik / !tt / !tiktok
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

          const quotaService = commandContext.services.has('quota')
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

      // 30. !tik2mp3 / !ttmp3 / !tiktokaudio
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


      // 32. !hd / !remini / !upscale
      context.commands.register({
        name: 'hd',
        aliases: ['remini', 'upscale'],
        description: 'Tingkatkan kualitas gambar menjadi HD / jernih',
        category: 'tools',
        menuOrder: 32,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const selected = sourceFor(commandContext)
          if (!selected || (selected.descriptor.kind !== 'image' && selected.descriptor.kind !== 'sticker')) {
            await commandContext.reply(`Kirim gambar dengan caption ${commandContext.prefix}hd, atau balas gambar lalu ketik ${commandContext.prefix}hd ya~ ✨`)
            return
          }

          if (selected.descriptor.sizeBytes && selected.descriptor.sizeBytes > 10 * 1024 * 1024) {
            await commandContext.reply('Ukuran gambar terlalu besar nih, maksimal 10 MB ya~ 📁')
            return
          }

          if (!commandContext.whatsapp.downloadMedia || !commandContext.whatsapp.sendMedia) return
          await commandContext.react('⏳')

          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: 10 * 1024 * 1024,
              timeoutMs: 30_000,
            })

            const upscaled = await upscaleImage(Buffer.from(downloaded.data), {
              mimeType: downloaded.mimeType,
            })

            await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
              kind: 'image',
              data: new Uint8Array(upscaled.buffer),
              mimeType: 'image/jpeg',
              caption: `HD • ${(upscaled.latencyMs / 1000).toFixed(1)}s`,
            })
          } catch (error) {
            commandContext.logger.warn({ error }, 'hd upscale failed')
            const msg = error instanceof Error ? error.message : 'Gagal memproses gambar.'
            await commandContext.reply(`Waduh, proses HD belum berhasil nih: ${msg} 🙏`)
          }
        },
      })
    },
  }
}

export const mediaPlugin = createMediaPlugin()
export default mediaPlugin
