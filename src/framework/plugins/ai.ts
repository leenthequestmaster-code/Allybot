import type { CommandContext, Plugin } from '../contracts.js'
import {
  AiHandlerError,
  MAX_AI_INPUT_LENGTH,
  createAiHandler,
  describeImageWithAi,
  type AiTransport,
} from '../../ai-handler.js'

const AI_COMMAND_COOLDOWN_MS = 3_000

function usage(context: CommandContext): string {
  return [
    "𓏼 *`𝐀𝗹𝗹𝘆𝗯𝗼𝘁 𝐀𝐈 (𝐎𝗺𝗻𝗶)`*",
    "─꯭──꯭──    .  .  .    ▭▬▭▬▭",
    `Format: ${context.prefix}ai <pertanyaan atau instruksi>`,
    `Atau reply pesan teks / foto lalu ketik ${context.prefix}ai`,
    "─͜──͜──͜─  · • ·  ─͜──͜──͜─",
    "Semua fungsi AI sudah disatukan di sini:",
    "• Tanya Jawab : `!ai apa itu black hole?`",
    "• Terjemahan  : `!ai terjemahkan ke Jepang: Halo`",
    "• Ringkas     : reply pesan + `!ai ringkas intinya`",
    "• Ekstrak Teks: reply foto dokumen + `!ai salin teks ini`",
    "• Analisis    : kirim foto + `!ai foto ini tentang apa?`",
    "• Deteksi AI  : reply teks + `!ai apakah ini buatan AI?`",
    "━━━━━━━━━━━━━━━━━━━━",
    "*© Allyssea Roleplay Community*",
  ].join("\n")
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
  if (error instanceof AiHandlerError && error.code === 'missing_api_key') return 'Fitur AI belum siap dipakai nih, colek owner ya~ 🙏'
  return 'Lagi pusing nih, coba tanya lagi beberapa saat ya~ 🤖🙏'
}

function extractImageSource(context: CommandContext): { descriptor: any; source: 'direct' | 'quoted' } | undefined {
  if (context.message.media?.kind === 'image') {
    return { descriptor: context.message.media, source: 'direct' }
  }
  if (context.message.quotedMedia?.kind === 'image') {
    return { descriptor: context.message.quotedMedia, source: 'quoted' }
  }
  return undefined
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

      // 1. Omni-AI: Single entry point for general chat, contextual reply, and vision
      context.commands.register({
        name: 'ai',
        aliases: ['ally', 'tanya'],
        description: 'Tanya atau perintahkan AI secara serbaguna',
        category: 'tools',
        menuOrder: 1,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const rawPrompt = commandContext.args.join(' ').trim()
          const quotedText = commandContext.message.quotedText?.trim()
          const imageSource = extractImageSource(commandContext)

          // 1A. Multimodal Vision Handling (Direct Image or Quoted Image)
          if (imageSource) {
            if (!commandContext.whatsapp.downloadMedia) {
              await commandContext.reply('Waduh, belum bisa ambil gambarnya nih. Coba kirim ulang ya~ 📥')
              return
            }
            try {
              const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, imageSource.source, {
                maxBytes: 10 * 1024 * 1024,
                timeoutMs: 25_000,
              })
              const base64 = Buffer.from(downloaded.data).toString('base64')
              const mime = downloaded.mimeType || 'image/jpeg'
              const dataUrl = `data:${mime};base64,${base64}`

              const prompt = rawPrompt || (quotedText ? `Perhatikan gambar ini berdasarkan konteks berikut:\n"${quotedText}"` : undefined)
              const result = await describeImageWithAi(dataUrl, prompt)
              await commandContext.reply(`🤖 *Allybot AI:*\n\n${result}`)
            } catch (error) {
              commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'ai vision failed')
              await commandContext.reply('Gambarnya kurang jelas atau lagi gagal diproses nih, coba foto yang lebih terang ya~ 🔍📷')
            }
            return
          }

          // 1B. Text Handling (Standalone or Quoted Message Context)
          let finalPrompt = rawPrompt
          if (quotedText) {
            if (rawPrompt) {
              finalPrompt = `Rujukan pesan yang dibalas:\n"${quotedText}"\n\nInstruksi pengguna:\n${rawPrompt}`
            } else {
              finalPrompt = `Ringkas dan jelaskan inti dari pesan berikut secara singkat dalam bahasa Indonesia:\n"${quotedText}"`
            }
          }

          if (!finalPrompt) {
            await commandContext.reply(usage(commandContext))
            return
          }

          if (finalPrompt.length > MAX_AI_INPUT_LENGTH) {
            await commandContext.reply(`Pertanyaannya kepanjangan nih, maksimal ${MAX_AI_INPUT_LENGTH} karakter ya~ ✍️`)
            return
          }

          try {
            const response = await handler(finalPrompt)
            await commandContext.reply(`🤖 *Allybot AI*\n\n${response}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'AI command failed safely')
            await commandContext.reply(safeFailureMessage(error))
          }
        },
      })

      // 2. Shortcut: Translate
      context.commands.register({
        name: 'translate',
        aliases: ['terjemah', 'trans'],
        description: 'Terjemahkan teks yang kamu kirim secara langsung',
        category: 'tools',
        hidden: true,
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

      // 3. Shortcut: Summarize
      context.commands.register({
        name: 'summarize',
        aliases: ['ringkas'],
        description: 'Ringkas teks yang kamu kirim secara langsung',
        category: 'tools',
        hidden: true,
        menuOrder: 3,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.message.quotedText?.trim() || commandContext.args.join(' ').trim()
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

      // 4. AI Detection
      context.commands.register({
        name: 'aidetection',
        aliases: ['deteksiai', 'aidetect'],
        description: 'Deteksi teks AI via reply message atau teks input',
        category: 'tools',
        hidden: true,
        menuOrder: 4,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.message.quotedText ?? commandContext.args.join(' ').trim()
          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}aidetection <teks>\nAtau reply pesan lalu ketik ${commandContext.prefix}aidetection`)
            return
          }
          if (text.length > MAX_AI_INPUT_LENGTH) {
            await commandContext.reply(`Teksnya kepanjangan nih, maksimal ${MAX_AI_INPUT_LENGTH} karakter ya~ ✍️`)
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

      // 5. Text-to-Speech (Google TTS + FFmpeg OGG Opus PTT)
      context.commands.register({
        name: 'tts',
        aliases: ['suara'],
        description: 'Ubah teks menjadi pesan suara',
        category: 'tools',
        menuOrder: 5,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.args.join(' ').trim()
          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}tts <teks>\nContoh: ${commandContext.prefix}tts Halo, selamat pagi`)
            return
          }
          if (text.length > 300) {
            await commandContext.reply('Teksnya kepanjangan buat pesan suara nih, maksimal 300 karakter ya~ 🎙️')
            return
          }
          try {
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=id&client=tw-ob`
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const mp3Buffer = Buffer.from(await res.arrayBuffer())

            let audioData: Uint8Array = new Uint8Array(mp3Buffer)
            let mimeType = 'audio/mp4'
            const isPtt = true

            try {
              const { spawn } = await import('node:child_process')
              const opus = await new Promise<Buffer>((resolve, reject) => {
                const ff = spawn('ffmpeg', ['-y', '-i', 'pipe:0', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1'])
                const chunks: Buffer[] = []
                ff.stdout.on('data', (d: Buffer) => chunks.push(d))
                ff.on('error', reject)
                ff.on('close', (code) => {
                  if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks))
                  else reject(new Error(`FFmpeg exited with code ${code}`))
                })
                ff.stdin.write(mp3Buffer)
                ff.stdin.end()
              })
              audioData = new Uint8Array(opus)
              mimeType = 'audio/ogg; codecs=opus'
            } catch {
              // fallback to audioData as is
            }

            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'audio',
                data: audioData,
                mimeType,
                ptt: isPtt,
              })
            } else {
              await commandContext.reply('Pesan suara belum bisa kekirim nih, coba lagi nanti ya~ 🎙️')
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'tts command failed')
            await commandContext.reply('Gagal bikin pesan suara nih, coba kalimat lain ya~ 😅')
          }
        },
      })

      // 6. Text-to-Image (Pollinations AI)
      context.commands.register({
        name: 'text2img',
        aliases: ['buatgambar', 't2i'],
        description: 'Hasilkan gambar dari deskripsi teks',
        category: 'tools',
        menuOrder: 6,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const prompt = commandContext.args.join(' ').trim()
          if (!prompt) {
            await commandContext.reply(`Format: ${commandContext.prefix}text2img <deskripsi gambar>\nContoh: ${commandContext.prefix}text2img a cute anime cat in space`)
            return
          }
          if (prompt.length > 300) {
            await commandContext.reply('Deskripsinya kepanjangan nih, maksimal 300 karakter ya~ ✍️')
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
            await commandContext.reply('Gagal bikin gambar nih, coba kata kunci lain ya~ 🎨')
          }
        },
      })

      // 7. Vision Description: img2text
      context.commands.register({
        name: 'img2text',
        aliases: ['deskripsigambar'],
        description: 'Deskripsikan isi gambar menggunakan AI',
        category: 'tools',
        hidden: true,
        menuOrder: 7,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = extractImageSource(commandContext)

          if (!selected) {
            await commandContext.reply(`Kirim gambar dengan caption ${commandContext.prefix}img2text [opsional: instruksi], atau balas gambar lalu ketik ${commandContext.prefix}img2text.`)
            return
          }

          if (!commandContext.whatsapp.downloadMedia) {
            await commandContext.reply('Waduh, belum bisa ambil gambarnya nih. Coba kirim ulang ya~ 📥')
            return
          }

          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: 10 * 1024 * 1024,
              timeoutMs: 25_000,
            })
            const base64 = Buffer.from(downloaded.data).toString('base64')
            const mime = downloaded.mimeType || 'image/jpeg'
            const dataUrl = `data:${mime};base64,${base64}`

            const prompt = commandContext.args.join(' ').trim() || undefined
            const result = await describeImageWithAi(dataUrl, prompt)
            await commandContext.reply(`🤖 *Analisis Gambar (AI Vision):*\n\n${result}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'img2text command failed')
            await commandContext.reply('Gambarnya kurang jelas nih, coba kirim foto yang lebih terang ya~ 🔍📷')
          }
        },
      })

      // 8. OCR: Extract text from image via Multimodal AI
      context.commands.register({
        name: 'ocr',
        description: 'Ekstrak teks dari gambar secara presisi menggunakan AI Vision',
        category: 'tools',
        hidden: true,
        menuOrder: 8,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = extractImageSource(commandContext)

          if (!selected) {
            await commandContext.reply(`Balas gambar lalu ketik ${commandContext.prefix}ocr, atau kirim gambar dengan caption ${commandContext.prefix}ocr.`)
            return
          }

          if (!commandContext.whatsapp.downloadMedia) {
            await commandContext.reply('Waduh, belum bisa ambil gambarnya nih. Coba kirim ulang ya~ 📥')
            return
          }

          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: 10 * 1024 * 1024,
              timeoutMs: 25_000,
            })
            const base64 = Buffer.from(downloaded.data).toString('base64')
            const mime = downloaded.mimeType || 'image/jpeg'
            const dataUrl = `data:${mime};base64,${base64}`

            const result = await describeImageWithAi(
              dataUrl,
              'Ekstrak dan salin seluruh teks yang tertulis di dalam gambar ini secara presisi dan lengkap. Tuliskan ulang teksnya saja tanpa basa-basi atau analisis visual.',
              { maxTokens: 1_200 },
            )
            await commandContext.reply(`🔍 *Hasil Ekstraksi Teks (OCR):*\n\n${result}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'ocr command failed')
            await commandContext.reply('Gagal membaca tulisan di gambar nih, coba foto yang lebih terang dan jelas ya~ 📝📷')
          }
        },
      })
    },
  }
}

export const aiPlugin = createAiPlugin()
export default aiPlugin
