import type { CommandContext, Plugin } from '../contracts.js'
import { FfmpegMediaTransformer, MediaTransformError, type MediaTransformer } from '../../media.js'
import { setStickerExif } from '../../services/sticker-exif.js'
import {
  MEDIA_INPUT_MAX_BYTES,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MEDIA_COMMAND_COOLDOWN_MS,
  maxInputBytesFor,
  sourceFor,
  safeMediaFailure,
  runPythonScript,
  transformAndSend,
  defaultDownloadYouTubeMedia,
} from './media-common.js'
import { registerMediaCardCommands } from './media-cards.js'
import { registerMediaDownloaderCommands, type YouTubeDownloaderFn } from './media-downloader.js'
import { registerMediaToolCommands } from './media-tools.js'

export interface MediaPluginOptions {
  readonly transformer?: MediaTransformer
  readonly ytDownloader?: YouTubeDownloaderFn
}

export function createMediaPlugin(options: MediaPluginOptions = {}): Plugin {
  const transformer = options.transformer ?? new FfmpegMediaTransformer()
  const ytDownloader = options.ytDownloader ?? defaultDownloadYouTubeMedia

  return {
    name: 'media-commands',
    version: '0.1.0',
    load(context) {
      // ── Core Media Format Transformers ──────────────────────────────────
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

      // ── Specialized Media Domain Modules ─────────────────────────────────
      registerMediaCardCommands(context)
      registerMediaDownloaderCommands(context, ytDownloader)
      registerMediaToolCommands(context, transformer)
    },
  }
}

export const mediaPlugin = createMediaPlugin()
export default mediaPlugin
