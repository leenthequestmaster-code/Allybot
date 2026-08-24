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
        category: 'ai',
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
        category: 'ai',
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
        category: 'ai',
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
    },
  }
}

export const aiPlugin = createAiPlugin()
export default aiPlugin
