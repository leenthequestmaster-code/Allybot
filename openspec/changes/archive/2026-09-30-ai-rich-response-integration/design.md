# Design: AI Rich Response Integration

## Context

Allybot provides an Omni-AI command (`!ai`) that responds to text and visual queries. Currently, responses are sent via `commandContext.reply()`, displaying plain text. `MsgBuilder` contains partial `AIRich` support. Aligning this with WhatsApp's native Meta-AI response structure (`botForwardedMessage` + `unifiedResponse`) enables interactive client-side rendering.

## Goals / Non-Goals

**Goals:**
- Construct valid `botForwardedMessage` payloads with `unifiedResponse` sections in `MsgBuilder`.
- Use `MsgBuilder` with `{ rich: true }` in `src/framework/plugins/ai.ts`.
- Ensure 100% backward compatibility and seamless fallback for environments without active sockets (e.g. test harnesses).

**Non-Goals:**
- Combining rich responses with interactive button menus in the same message.

## Decisions

### 1. Protobuf Stanza Format
- Use `botForwardedMessage` with `richResponseMessage`.
- Attach `forwardedAiBotMessageInfo: { botJid: '0@bot' }` and `forwardOrigin: 4` under `contextInfo`.
- Include `messageContextInfo.botMetadata` with `messageDisclaimerText: 'Allybot AI'`.
- Generate `unifiedResponse.data` as base64-encoded JSON with `response_id` and formatted UI sections.

### 2. Plug-in Layer Integration
- In `src/framework/plugins/ai.ts`, replace `commandContext.reply(\`🤖 *Allybot AI*\\n\\n\${response}\`)` with:
  ```ts
  await MsgBuilder.to(commandContext.message.remoteJid)
    .header('Allybot AI')
    .text(response, { rich: true })
    .send(commandContext.whatsapp)
  ```
- If `whatsapp.socket` is unavailable (e.g., in unit tests or offline transport), `MsgBuilder`'s existing fallback logic directly invokes `whatsapp.sendText`, ensuring no breaking changes.

## Risks / Trade-offs

- [Risk]: Certain WhatsApp client versions may not render `botForwardedMessage`.
  → Mitigation: `_relayWithAckGuard` monitors ACK and error code 479, triggering automatic plain-text re-transmission within the 12s window.
