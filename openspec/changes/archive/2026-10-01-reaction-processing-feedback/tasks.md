# Tasks

## 1. Port and Contract Foundation
- [x] 1.1 Add `sendReaction` to `WhatsAppPort` and `react` to `CommandContext` in `src/framework/contracts.ts`.
- [x] 1.2 Implement `react` in `CommandRegistry` in `src/framework/command-registry.ts`.
- [x] 1.3 Implement `sendReaction` in `WhatsAppConnection` in `src/whatsapp.ts`.

## 2. Migrate Asynchronous Commands
- [x] 2.1 Update `src/framework/plugins/media.ts` to replace temporary status messages with `react('⏳')`.
- [x] 2.2 Update `src/framework/plugins/tools-search.ts` to replace temporary status messages with `react('⏳')`.

## 3. Verification & Deployment
- [x] 3.1 Update unit tests in `tests/media-plugin.test.js` and verify all tests pass.
- [x] 3.2 Run Alibaba Open Code Review (`ocr`) on changed files.
- [x] 3.3 Deploy to VPS, restart `allybot.service`, and verify logs.
