import type { CommandContext, Plugin } from '../contracts.js'
import {
  AiHandlerError,
  MAX_AI_INPUT_LENGTH,
  createAiHandler,
  type AiTransport,
} from '../../ai-handler.js'

const AI_COMMAND_COOLDOWN_MS = 15_000

function usage(context: CommandContext): string {
  return `Format: ${context.prefix}ai <pertanyaan>\nAlias: ${context.prefix}ally <pertanyaan>`
}

function pipeInput(context: CommandContext): { target: string; text: string } | undefined {
  const separator = context.args.join(' ').indexOf('|')
  if (separator < 0) return undefined
  const target = context.args.join(' ').slice(0, separator).trim()
  const text = context.args.join(' ').slice(separator + 1).trim()
  return target && text ? { target, text } : undefined
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof AiHandlerError && error.code === 'invalid_input') return error.message
  if (error instanceof AiHandlerError && error.code === 'missing_api_key') return 'Allybot AI belum dikonfigurasi oleh operator.'
  return 'Maaf, Allybot AI sedang tidak tersedia. Coba lagi nanti.'
}

export interface AiPluginOptions {
  readonly transport?: AiTransport
  readonly fallbackEnabled?: boolean
}

export function createAiPlugin(options: AiPluginOptions = {}): Plugin {
  return {
    name: 'ai-commands',
    version: '0.1.0',
    load(context) {
      const handler = createAiHandler({
        transport: options.transport,
        logger: context.logger,
        fallbackEnabled: options.fallbackEnabled,
      })

      context.commands.register({
        name: 'translate',
        aliases: ['terjemah', 'trans'],
        description: 'Terjemahkan teks yang kamu kirim secara langsung',
        category: 'tools-ai',
        menuOrder: 2,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const input = pipeInput(commandContext)
          if (!input || input.target.length > 40 || input.text.length > MAX_AI_INPUT_LENGTH - 120) {
            await commandContext.reply(`Format: ${commandContext.prefix}translate <bahasa> | <teks>\nContoh: ${commandContext.prefix}translate Inggris | Selamat datang di grup.`)
            return
          }
          try {
            const response = await handler(`Terjemahkan teks berikut ke bahasa ${input.target}. Pertahankan makna dan jangan menambahkan penjelasan:\n${input.text}`)
            await commandContext.reply(`🌐 *Terjemahan*\n${response}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'translate command failed safely')
            await commandContext.reply(safeFailureMessage(error))
          }
        },
      })

      context.commands.register({
        name: 'summarize',
        aliases: ['ringkas'],
        description: 'Ringkas teks yang kamu kirim secara langsung',
        category: 'tools-ai',
        menuOrder: 3,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.args.join(' ').trim()
          if (!text || text.length > MAX_AI_INPUT_LENGTH) {
            await commandContext.reply(`Format: ${commandContext.prefix}summarize <teks>\nContoh: ${commandContext.prefix}summarize [tempel teks di sini]`)
            return
          }
          try {
            const response = await handler(`Ringkas teks berikut menjadi beberapa kalimat singkat dalam bahasa Indonesia. Jangan menambahkan fakta baru:\n${text}`)
            await commandContext.reply(`📝 *Ringkasan*\n${response}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'summarize command failed safely')
            await commandContext.reply(safeFailureMessage(error))
          }
        },
      })

      context.commands.register({
        name: 'ai',
        aliases: ['ally', 'tanya'],
        description: 'Ask Allybot AI without conversation memory',
        category: 'tools-ai',
        menuOrder: 1,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const prompt = commandContext.args.join(' ').trim()
          if (!prompt) {
            await commandContext.reply(usage(commandContext))
            return
          }
          if (prompt.length > MAX_AI_INPUT_LENGTH) {
            await commandContext.reply(`Pertanyaan terlalu panjang. Batasnya ${MAX_AI_INPUT_LENGTH} karakter.`)
            return
          }

          try {
            const response = await handler(prompt)
            await commandContext.reply(`🤖 *Allybot AI*\n\n${response}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'AI command failed safely')
            await commandContext.reply(safeFailureMessage(error))
          }
        },
      })

      context.commands.register({
        name: 'aidetection',
        aliases: ['deteksiai', 'aidetect'],
        description: 'Deteksi teks AI via reply message atau teks input',
        category: 'tools-ai',
        menuOrder: 4,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.message.quotedText ?? commandContext.args.join(' ').trim()
          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}aidetection <teks>\nAtau reply pesan lalu ketik ${commandContext.prefix}aidetection`)
            return
          }
          if (text.length > MAX_AI_INPUT_LENGTH) {
            await commandContext.reply(`Teks terlalu panjang. Batasnya ${MAX_AI_INPUT_LENGTH} karakter.`)
            return
          }
          try {
            const response = await handler(`Analisis teks berikut dan tentukan apakah ditulis oleh AI atau manusia. Berikan skor kepercayaan 0-100% dan alasan singkat:\n\n${text}`)
            await commandContext.reply(`🔍 *AI Detection*\n${response}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'AI detection failed safely')
            await commandContext.reply(safeFailureMessage(error))
          }
        },
      })

      // tts - text to speech
      context.commands.register({
        name: 'tts',
        aliases: ['suara'],
        description: 'Ubah teks menjadi pesan suara',
        category: 'tools-ai',
        menuOrder: 5,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.args.join(' ').trim()
          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}tts <teks>\nContoh: ${commandContext.prefix}tts Halo, selamat pagi`)
            return
          }
          if (text.length > 300) {
            await commandContext.reply('Teks terlalu panjang untuk audio TTS. Maksimal 300 karakter.')
            return
          }
          try {
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=id&client=tw-ob`
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const buffer = new Uint8Array(await res.arrayBuffer())
            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'audio',
                data: buffer,
                mimeType: 'audio/mp3',
              })
            } else {
              await commandContext.reply('Koneksi WhatsApp belum mendukung pengiriman media suara.')
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'tts command failed')
            await commandContext.reply('Gagal membuat pesan suara saat ini.')
          }
        },
      })

      // text2img - generate image from text prompt
      context.commands.register({
        name: 'text2img',
        aliases: ['buatgambar', 't2i'],
        description: 'Hasilkan gambar dari deskripsi teks',
        category: 'tools-ai',
        menuOrder: 6,
        cooldownMs: 20_000,
        handler: async (commandContext) => {
          const prompt = commandContext.args.join(' ').trim()
          if (!prompt) {
            await commandContext.reply(`Format: ${commandContext.prefix}text2img <deskripsi gambar>\nContoh: ${commandContext.prefix}text2img a cute anime cat in space`)
            return
          }
          if (prompt.length > 300) {
            await commandContext.reply('Deskripsi terlalu panjang. Maksimal 300 karakter.')
            return
          }
          try {
            const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true`
            const res = await fetch(url, { signal: AbortSignal.timeout(25_000) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const buffer = new Uint8Array(await res.arrayBuffer())
            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'image',
                data: buffer,
                mimeType: 'image/jpeg',
              })
            } else {
              await commandContext.reply(`Gambar hasil: ${url}`)
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'text2img command failed')
            await commandContext.reply('Gagal menghasilkan gambar dari teks saat ini.')
          }
        },
      })

      // img2text - describe image
      context.commands.register({
        name: 'img2text',
        aliases: ['deskripsigambar'],
        description: 'Deskripsikan isi gambar menggunakan AI',
        category: 'tools-ai',
        menuOrder: 7,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          if (!commandContext.message.quotedMedia && !commandContext.message.media) {
            await commandContext.reply(`Balas gambar lalu ketik ${commandContext.prefix}img2text.`)
            return
          }
          await commandContext.reply('🤖 *Analisis Visual:*\nFitur vision AI memerlukan API key penyedia multi-modal yang aktif pada server.')
        },
      })
    },
  }
}

export const aiPlugin = createAiPlugin()
export default aiPlugin
