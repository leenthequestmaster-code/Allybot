# Design: Reaction Processing Feedback

## 1. Contracts & Port Design
- `WhatsAppPort.sendReaction?(remoteJid: string, key: { readonly id: string; readonly remoteJid?: string; readonly fromMe?: boolean; readonly participant?: string }, emoji: string): Promise<void>`
- `CommandContext.react(emoji: string): Promise<void>`
- In `CommandRegistry`, implement `react` by extracting message key attributes (`id`, `remoteJid`, `fromMe`, `participant: message.senderJid`) and invoking `this.whatsapp.sendReaction`.

## 2. Baileys Stanza Implementation
- In `src/whatsapp.ts`, use `socket.sendMessage(remoteJid, { react: { text: emoji, key: messageKey } })`.
- Wrapped with a 10s timeout and safe error logging.

## 3. Command Handler Updates
- Migrate all asynchronous commands in `src/framework/plugins/media.ts` and `src/framework/plugins/tools-search.ts` to `await commandContext.react('⏳')`:
  - `bratvid`
  - `compress`
  - `ttstalk`
  - `igstalk`
  - `spack`
  - `removebg`
  - `ytmp3`, `ytmp4`, `yt2`
  - `tik`, `tik2mp3`
  - `multidl` / `dl`
  - `hd`
  - `google`
  - `pin`
  - `pixiv`
