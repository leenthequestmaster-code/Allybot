import type { CommandContext, WhatsAppPresenceType } from './contracts.js'

export interface TypingOptions {
  type?: WhatsAppPresenceType
  intervalMs?: number
}

/**
 * Wraps an asynchronous command handler with an automatic WhatsApp typing / recording indicator.
 * Handles TTL refresh every 8 seconds and ensures 'paused' presence cleanup via try...finally.
 */
export async function withTyping<T>(
  ctx: CommandContext,
  action: () => Promise<T>,
  options?: TypingOptions,
): Promise<T> {
  const remoteJid = ctx.message.remoteJid
  const whatsapp = ctx.whatsapp
  const type: WhatsAppPresenceType = options?.type ?? 'composing'
  const intervalMs = options?.intervalMs ?? 8_000

  const sendPresence = async (presence: WhatsAppPresenceType): Promise<void> => {
    try {
      if (ctx.sendPresence) {
        await ctx.sendPresence(presence)
      } else if (whatsapp.sendPresenceUpdate) {
        await whatsapp.sendPresenceUpdate(remoteJid, presence)
      }
    } catch {
      // Fail-soft: presence errors never interrupt command flow
    }
  }

  // 1. Initial presence notification (non-blocking for fast response)
  void sendPresence(type)

  // 2. Periodic heartbeat to prevent WhatsApp client TTL expiry (~10-12s)
  const timer = setInterval(() => {
    void sendPresence(type)
  }, intervalMs)

  try {
    return await action()
  } finally {
    clearInterval(timer)
    void sendPresence('paused')
  }
}
