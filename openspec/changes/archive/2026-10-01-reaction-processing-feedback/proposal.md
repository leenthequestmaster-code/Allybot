# Proposal: Reaction-Based Processing Feedback

## Why

Commands that fetch or process media (e.g., `!compress`, `!pin`, `!pixiv`, `!igstalk`, `!ttstalk`, `!ytmp3`, `!google`, `!tik`, `!dl`, `!hd`, `!bratvid`) previously sent redundant chat text bubbles such as "⏳ Lagi nyari dan ngambil gambar..." or "⏳ Sedang mencari profil...".
These text messages clutter the chat interface and remain permanently after media is delivered.

Using WhatsApp emoji reactions (`⏳`) directly on the user's incoming message bubble provides instant, non-intrusive processing feedback without polluting the chat history with disposable text bubbles.

## What Changes

1. **Contracts & WhatsApp Port**:
   - Add `sendReaction?` method to `WhatsAppPort`.
   - Add `react(emoji: string): Promise<void>` to `CommandContext`.
2. **WhatsApp Connection**:
   - Implement `sendReaction(remoteJid, key, emoji)` in `WhatsAppConnection` using Baileys `{ react: { text, key } }`.
3. **Command Registry**:
   - Bind `react` in `CommandContext` to trigger `whatsapp.sendReaction` using the incoming message's ID, remoteJid, and senderJid.
4. **Plugin Migration**:
   - Replace temporary processing text replies in `media.ts` and `tools-search.ts` with `await commandContext.react('⏳')`.
