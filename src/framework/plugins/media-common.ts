import type { CommandContext, CoreMediaDescriptor, WhatsAppMediaSource } from '../contracts.js'
import { FfmpegMediaTransformer, MEDIA_TRANSFORM_HARD_OUTPUT_MAX_BYTES, MEDIA_TRANSFORM_MAX_OUTPUT_BYTES, MediaTransformError, type MediaTransformer } from '../../media.js'
import { setStickerExif } from '../../services/sticker-exif.js'
import { unlink } from 'node:fs/promises'

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

export {
  MEDIA_INPUT_MAX_BYTES,
  MEDIA_VIDEO_INPUT_MAX_BYTES,
  MEDIA_DOWNLOAD_TIMEOUT_MS,
  MEDIA_COMMAND_COOLDOWN_MS,
  maxInputBytesFor,
  sourceFor,
  safeMediaFailure,
  runPythonScript,
  transformAndSend,
  defaultDownloadYouTubeMedia,
}
