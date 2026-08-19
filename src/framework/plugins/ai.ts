import { chatGroq, type ChatGroqOptions } from '../../groq.js'
import type { CommandContext, Plugin } from '../contracts.js'

const MAX_PROMPT_LENGTH = 1_200
const MAX_REPLY_LENGTH = 2_000
const REQUEST_TIMEOUT_MS = 15_000

export type ChatGroq = (message: string, options?: ChatGroqOptions) => Promise<string>

function promptFromArgs(args: readonly string[]): string {
  return args.join(' ').trim()
}

function boundedReply(value: string): string {
  const answer = value.trim()
  if (answer.length <= MAX_REPLY_LENGTH) return answer
  return `${answer.slice(0, MAX_REPLY_LENGTH - 1).trimEnd()}…`
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError'
}

function commandDisabledText(): string {
  return [
    '🤖 *Allybot AI belum diaktifkan.*',
    '',
    'Fitur ini masih dalam mode aman default-off.',
  ].join('\n')
}

function usageText(prefix: string): string {
  return [
    '🤖 *Cara menggunakan Allybot AI:*',
    '',
    `Ketik ${prefix}ask pertanyaan kamu`,
    `atau ${prefix}ai pertanyaan kamu`,
    '',
    `Batas prompt: ${MAX_PROMPT_LENGTH} karakter.`,
  ].join('\n')
}

function createAiCommand(chat: ChatGroq): Plugin {
  return {
    name: 'ai-commands',
    version: '0.1.0',
    load(context) {
      context.commands.register({
        name: 'ask',
        aliases: ['ai'],
        description: 'Ask Allybot AI a bounded one-shot question',
        category: 'ai',
        menuOrder: 1,
        cooldownMs: REQUEST_TIMEOUT_MS,
        handler: async (commandContext: CommandContext) => {
          if (!commandContext.config.aiCommandsEnabled) {
            await commandContext.reply(commandDisabledText())
            return
          }

          const prompt = promptFromArgs(commandContext.args)
          if (!prompt) {
            await commandContext.reply(usageText(commandContext.prefix))
            return
          }

          if (prompt.length > MAX_PROMPT_LENGTH) {
            await commandContext.reply(`Prompt terlalu panjang. Gunakan maksimal ${MAX_PROMPT_LENGTH} karakter.`)
            return
          }

          try {
            const answer = await chat(prompt, { timeoutMs: REQUEST_TIMEOUT_MS })
            const safeAnswer = boundedReply(answer)
            if (!safeAnswer) {
              await commandContext.reply('Maaf, Allybot AI tidak menghasilkan jawaban yang dapat ditampilkan.')
              return
            }
            await commandContext.reply(`🤖 *Allybot AI*\n\n${safeAnswer}`)
          } catch (error) {
            commandContext.logger.warn({
              errorName: errorName(error),
              promptLength: prompt.length,
            }, 'AI provider request unavailable')
            await commandContext.reply('Maaf, Allybot AI sedang tidak tersedia. Coba lagi nanti.')
          }
        },
      })
    },
  }
}

export function createAiPlugin(chat: ChatGroq = chatGroq): Plugin {
  return createAiCommand(chat)
}

export const aiPlugin = createAiPlugin()

export default aiPlugin
