import type { AppConfig } from '../../config.js'
import type { Logger } from 'pino'
import type { CommandContext, Plugin } from '../contracts.js'
import { permissionNames } from '../../permissions.js'
import { isGroupJid } from '../../platform/validation.js'
import { NeonClientService } from '../../neon-client.js'
import { NeonChatLogWriter, type NeonChatLogWriterOptions } from '../../neon-chat-log-writer.js'
import type { PlatformGuardrailService } from '../../services/platform-guardrail-service.js'

const GROUP_JID_PATTERN = /^[^\s@,]+@g\.us$/
export const NEON_CHAT_LOG_SUPPRESSION_FEATURE_ID = 'neon-chat-log-suppressed'
const CONTROL_CORRELATION_ID = 'neon-chat-log-control'

export function parseNeonChatLogGroups(value: string): ReadonlySet<string> {
  const groups = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))]
  if (groups.length === 0 || groups.some((group) => !GROUP_JID_PATTERN.test(group))) {
    throw new Error('NEON_CHAT_LOG_GROUPS must contain comma-separated WhatsApp group JIDs')
  }
  return new Set(groups)
}

function validateChatLogCommand(context: CommandContext): string | undefined {
  if (context.args.length > 1) return `Gunakan ${context.prefix}chatlog on, ${context.prefix}chatlog off, atau ${context.prefix}chatlog status.`
  const action = context.args[0]?.toLowerCase()
  if (action && !['on', 'off', 'status', 'help'].includes(action)) {
    return `Pilihan tidak dikenal. Gunakan ${context.prefix}chatlog on, ${context.prefix}chatlog off, atau ${context.prefix}chatlog status.`
  }
  return undefined
}

function renderChatLogStatus(groupAllowed: boolean, suppressed: boolean, prefix: string): string {
  const transfer = groupAllowed && !suppressed
  return [
    '🗄️ *Status Chat-log Neon*',
    `↳ Capture grup : ${suppressed ? 'Nonaktif (opt-out)' : groupAllowed ? 'Aktif' : 'Tidak diizinkan'}`,
    `↳ Transfer pesan baru : ${transfer ? 'Aktif' : 'Tidak aktif'}`,
    '',
    groupAllowed
      ? `Gunakan ${prefix}chatlog off untuk menghentikan transfer atau ${prefix}chatlog on untuk mengaktifkannya kembali.`
      : 'Grup ini belum tercantum dalam allowlist Neon, sehingga pesan tidak ditransfer.',
  ].join('\n')
}

export function createNeonChatLogPlugin(config: AppConfig): Plugin {
  let writer: NeonChatLogWriter | undefined
  let unbind: (() => void) | undefined
  let logger: Logger | undefined
  let suppressedGroupJids: Set<string> | undefined

  return {
    name: 'neon-chat-log',

    initialize(context): void {
      if (!config.NEON_CHAT_LOG_ENABLED) return
      const neon = context.services.get<NeonClientService>('neon-client')
      if (!neon.isEnabled) throw new Error('Neon client must be enabled when chat-log writer is enabled')

      const groupJids = parseNeonChatLogGroups(config.NEON_CHAT_LOG_GROUPS)
      const guardrails = context.services.get<PlatformGuardrailService>('platform-guardrails')
      suppressedGroupJids = new Set([...groupJids].filter((groupJid) => guardrails.isFeatureEnabled(groupJid, NEON_CHAT_LOG_SUPPRESSION_FEATURE_ID)))
      const componentLogger = context.logger.child({ component: 'neon-chat-log' })
      logger = componentLogger
      const options: NeonChatLogWriterOptions = {
        groupJids,
        queueCapacity: config.NEON_CHAT_LOG_QUEUE_CAPACITY,
        maxAttempts: config.NEON_CHAT_LOG_MAX_ATTEMPTS,
        retryDelayMs: config.NEON_CHAT_LOG_RETRY_DELAY_MS,
        maxRetryDelayMs: config.NEON_CHAT_LOG_MAX_RETRY_DELAY_MS,
        drainTimeoutMs: config.NEON_CHAT_LOG_DRAIN_TIMEOUT_MS,
      }
      writer = new NeonChatLogWriter(neon.getClient(), componentLogger, options)
      unbind = context.events.on('message.received', (message) => {
        const currentWriter = writer
        if (!currentWriter || suppressedGroupJids?.has(message.remoteJid)) return
        const result = currentWriter.enqueue(message)
        if (result === 'queue-full') logger?.warn({ queueDepth: currentWriter.getStats().queueDepth }, 'Neon chat-log queue is full; message dropped')
      })


    },

    async unload(): Promise<void> {
      unbind?.()
      unbind = undefined
      if (!writer) return
      const result = await writer.close()
      if (!result.drained) logger?.warn({ remaining: result.remaining }, 'Neon chat-log writer stopped before queue drained')
      writer = undefined
      suppressedGroupJids = undefined
      logger = undefined
    },
  }
}
