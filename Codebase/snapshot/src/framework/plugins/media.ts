import { FfmpegMediaTransformer, MEDIA_TRANSFORM_HARD_OUTPUT_MAX_BYTES, MEDIA_TRANSFORM_MAX_OUTPUT_BYTES, MediaTransformError, type MediaTransformer } from '../../media.js'
import type { CommandContext, CoreMediaDescriptor, Plugin, WhatsAppMediaSource } from '../contracts.js'

const MEDIA_INPUT_MAX_BYTES = 3 * 1024 * 1024
const MEDIA_DOWNLOAD_TIMEOUT_MS = 20_000
const MEDIA_COMMAND_COOLDOWN_MS = 20_000

export interface MediaPluginOptions {
  readonly transformer?: MediaTransformer
}

function sourceFor(context: CommandContext): { descriptor: CoreMediaDescriptor; source: WhatsAppMediaSource } | undefined {
  if (context.message.media) return { descriptor: context.message.media, source: 'direct' }
  if (context.message.quotedMedia) return { descriptor: context.message.quotedMedia, source: 'quoted' }
  return undefined
}

function safeMediaFailure(error: unknown): string {
  if (error instanceof MediaTransformError && error.code === 'unsupported') return 'Format media itu belum didukung untuk perintah ini.'
  if (error instanceof MediaTransformError && error.code === 'output_limit') return 'Hasil media terlalu besar untuk dikirim.'
  if (error instanceof MediaTransformError && error.code === 'timeout') return 'Pengolahan media terlalu lama. Coba file yang lebih kecil.'
  return 'Media tidak dapat diproses sekarang. Coba lagi dengan file lain.'
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
    await context.reply('File terlalu besar. Gunakan media maksimal 3 MB.')
    return
  }
  if (target === 'gif' && selected.descriptor.durationSeconds !== undefined && selected.descriptor.durationSeconds > 15) {
    await context.reply('Video terlalu panjang. Untuk GIF, gunakan video maksimal 15 detik.')
    return
  }
  if (target === 'audio' && selected.descriptor.durationSeconds !== undefined && selected.descriptor.durationSeconds > 60) {
    await context.reply('Media terlalu panjang. Untuk audio, gunakan media maksimal 60 detik.')
    return
  }
  if (!context.whatsapp.downloadMedia || !context.whatsapp.sendMedia) {
    await context.reply('Fitur media belum tersedia di server ini.')
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

export function createMediaPlugin(options: MediaPluginOptions = {}): Plugin {
  return {
    name: 'media-commands',
    version: '0.1.0',
    load(context) {
      const transformer = options.transformer ?? new FfmpegMediaTransformer()
      context.commands.register({
        name: 'sticker',
        aliases: ['stiker'],
        description: 'Ubah gambar menjadi sticker',
        category: 'media',
        menuOrder: 11,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => transformAndSend(commandContext, transformer, 'sticker'),
      })
      context.commands.register({
        name: 'toimg',
        aliases: ['togambar'],
        description: 'Ubah sticker menjadi gambar',
        category: 'media',
        menuOrder: 12,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => transformAndSend(commandContext, transformer, 'image'),
      })
      context.commands.register({
        name: 'togif',
        aliases: ['gif'],
        description: 'Ubah video pendek menjadi GIF',
        category: 'media',
        menuOrder: 13,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => transformAndSend(commandContext, transformer, 'gif'),
      })
      context.commands.register({
        name: 'toaudio',
        aliases: ['audio'],
        description: 'Ambil audio dari video atau audio',
        category: 'media',
        menuOrder: 14,
        cooldownMs: MEDIA_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => transformAndSend(commandContext, transformer, 'audio'),
      })
    },
  }
}

export const mediaPlugin = createMediaPlugin()
export default mediaPlugin
