# Technical Plan: Natural Typing Indicator for Allybot WhatsApp

## 1. Overview & Problem Statement
Currently, Allybot remains completely silent while processing heavy asynchronous tasks (LLM completions via 9Router, FFmpeg media conversions, Questism status card canvas renders, and media downloads). From the user's perspective, this creates an impression that the bot is frozen, dead, or unresponsive.

This plan details the implementation of a native, resilient, and non-blocking **Natural Typing Indicator** using Baileys' `sendPresenceUpdate` method.

---

## 2. Architecture & Design Principles

### A. WhatsApp Protocol Lifecycle & Heartbeat
- **WhatsApp Client TTL:** The official WhatsApp client automatically expires the "typing..." indicator after approximately 10–12 seconds if no message is received.
- **Heartbeat Interval:** For long-running operations (>1.5s), an internal interval must refresh `sendPresenceUpdate('composing', jid)` every **8 seconds**.
- **Anti-Stuck Guarantee:** The typing state MUST be enclosed in a strict `try ... finally` block that invokes `sendPresenceUpdate('paused', jid)` upon task completion or error.

### B. Transport Contract Integration (`src/framework/contracts.ts`)
Extend `WhatsAppPort` interface:
```typescript
export type WhatsAppPresenceType = 'composing' | 'recording' | 'paused'

export interface WhatsAppPort {
  // Existing methods...
  sendPresenceUpdate?(remoteJid: string, type: WhatsAppPresenceType): Promise<void>
}
```

### C. Adapter Implementation (`src/whatsapp.ts`)
Implement `sendPresenceUpdate` on `WhatsAppConnection`:
```typescript
async sendPresenceUpdate(remoteJid: string, type: WhatsAppPresenceType): Promise<void> {
  const socket = this.requireSocket()
  try {
    await socket.sendPresenceUpdate(type, remoteJid)
  } catch (err) {
    this.logger.debug({ err, remoteJid, type }, 'failed to send presence update')
  }
}
```

### D. Framework Helper (`src/framework/typing-helper.ts`)
```typescript
import type { CommandContext } from './contracts.js'

export interface TypingOptions {
  type?: 'composing' | 'recording'
  heartbeatIntervalMs?: number
}

export async function withTyping<T>(
  ctx: CommandContext,
  action: () => Promise<T>,
  options?: TypingOptions,
): Promise<T> {
  const remoteJid = ctx.message.remoteJid
  const whatsapp = ctx.whatsapp
  const type = options?.type ?? 'composing'
  const intervalMs = options?.heartbeatIntervalMs ?? 8_000

  if (!whatsapp.sendPresenceUpdate) {
    return action()
  }

  // 1. Fire initial presence update
  try {
    await whatsapp.sendPresenceUpdate(remoteJid, type)
  } catch {
    // Fail-soft: presence failure must never block core command execution
  }

  // 2. Setup periodic heartbeat
  const timer = setInterval(() => {
    whatsapp.sendPresenceUpdate?.(remoteJid, type).catch(() => {})
  }, intervalMs)

  try {
    return await action()
  } finally {
    clearInterval(timer)
    try {
      await whatsapp.sendPresenceUpdate(remoteJid, 'paused')
    } catch {
      // Best-effort cleanup
    }
  }
}
```

---

## 3. High-Value Integration Targets
Only heavy operations (>1.5s) will utilize `withTyping`:
1. **AI Operations (`src/framework/plugins/ai.ts`):** Chat completions, vision analysis, TTS audio generation (`type: 'recording'`).
2. **Media Processing (`src/framework/plugins/media.ts`):** Stikers (`!s`, `!smeme`, `!brat`), video conversions.
3. **Music Pipeline (`src/framework/plugins/spotify.ts`):** `!play` / `!lagu` music downloads.
4. **Media Downloader (`src/framework/plugins/downloader.ts`):** `!dl`, `!sc` fetching.
5. **Character Status Render (`src/services/visual-card-service.ts`):** Satori/Resvg canvas rendering.

---

## 4. Safety Guardrails & Anti-Ban Invariants
- **No-Op on Instant Commands:** Never trigger presence for `!ping`, `!menu`, `!help`, or pure database reads.
- **Fail-Soft Isolation:** Presence socket errors are caught and logged at debug level; an unreachable presence socket will never crash command handlers.
- **Group Rate-Limit Discipline:** In groups with >100 members, presence updates are only dispatched for explicit command triggers, never on ambient incoming chatter.
