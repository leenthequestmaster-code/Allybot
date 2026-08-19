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
        name: 'ai',
        aliases: ['ally'],
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
