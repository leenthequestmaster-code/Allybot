# Tasks

## 1. MsgBuilder Enhancement

- [x] 1.1 Upgrade AIRich payload in `src/framework/msg-builder.ts` with `botForwardedMessage`, `unifiedResponse`, and bot metadata.
- [x] 1.2 Update `src/framework/msg-builder.test.ts` to assert the new `botForwardedMessage` payload structure.

## 2. AI Plugin Integration

- [x] 2.1 Update `src/framework/plugins/ai.ts` to dispatch AI responses via `MsgBuilder` with `{ rich: true }`.
- [x] 2.2 Verify `tests/omni-ai.test.js` passes cleanly.

## 3. Verification & Deployment

- [x] 3.1 Run TypeScript compilation `npm run build` and ensure clean output.
- [x] 3.2 Run test suite across PRoot and VPS.
