# Proposal: AI Rich Response Integration

## Why

WhatsApp Meta-AI rich responses provide native UI rendering for tables, code blocks with syntax highlighting, and suggestion pills on recipient devices. Integrating this into Allybot's `!ai` command elevates user experience from monospaced plain text to native interactive cards, backed by graceful fallback.

## What Changes

- **Meta-AI Protobuf Structure in MsgBuilder**: Upgrade `MsgBuilder`'s AIRich payload to emit `botForwardedMessage` with `forwardedAiBotMessageInfo: { botJid: '0@bot' }`, unified response layout data, and bot metadata.
- **Rich Mode for `!ai` Plugin**: Wire the `!ai` response handler in `src/framework/plugins/ai.ts` to deliver responses via `MsgBuilder` with `{ rich: true }`.
- **Reliable Fallback**: Ensure that when the recipient device or transport does not support rich stanzas, messages cleanly fall back to plain text.

## Capabilities

### New Capabilities
- `ai-rich-responses`: Interactive Meta-AI rich rendering for AI assistant replies in WhatsApp.

### Modified Capabilities
<!-- None -->

## Impact

- `src/framework/msg-builder.ts`
- `src/framework/plugins/ai.ts`
- `tests/omni-ai.test.js`
