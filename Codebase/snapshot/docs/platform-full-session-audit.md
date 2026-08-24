# Allybot Platform Full-Session Audit

## Snapshot repository

The working tree is `main` and currently contains only untracked platform package files and platform tests; no existing tracked source file has been modified by the platform work so far. The repository uses Node.js 22+, ESM, TypeScript 5.9, strict compilation, `@whiskeysockets/baileys` 7.0.0-rc14, SQLite via better-sqlite3, and Node's built-in test runner. CI currently runs typecheck, a clean build, compiled entrypoint checks, tests, and uploads the dist artifact on main pushes.

The blueprint and Mission Engine specification named in inherited context are not present in this working tree. The implementation baseline therefore comes from the actual source tree, existing documentation, and the contracts already created under `src/platform`.

## Existing integration boundary

`src/framework/contracts.ts` defines `CoreMessage`, `WhatsAppPort`, `WhatsAppSendOptions`, `CommandRegistryLike`, `EventBusLike`, `Plugin`, and the framework lifecycle. The current transport port exposes `sendText` only; it has no button/list send method and no generic message-content abstraction. `src/framework/plugins/menu.ts` already owns menu rendering and reply-number navigation using quoted text. The current command framework dispatches `CoreMessage` and routes replies through `WhatsAppPort.sendText`.

The safest integration point is a new optional platform adapter that consumes the existing `CoreMessage` shape and can render or parse platform interactions without changing `CommandDefinition`, `WhatsAppPort`, or the existing menu behavior. Button sending must remain capability-gated and must have a text fallback.

## Upstream button finding

The official Baileys README for 7.0.0-rc14 documents `AnyMessageContent` and normal `sendMessage` content, but its current sending guide does not document buttons or lists as a stable supported feature. The upstream GitHub issue #2465, updated in June 2026, reports that list messages may execute without errors but fail to deliver or display as interactive lists, and explicitly raises server-side deprecation of interactive buttons/lists for Web Multi-Device. The issue mentions `relayMessage` and a third-party workaround, but this is not an upstream stability guarantee.

Engineering implication: the core package must not assume native WhatsApp buttons are reliable. The button adapter should be an optional transport capability, should never be required for menu correctness, and should fall back to text/reply-number rendering. No third-party fork is adopted.

## Current platform package

Implemented files are `contracts.ts`, `feature-registry.ts`, `lifecycle.ts`, `interaction.ts`, `permission.ts`, `events.ts`, `validation.ts`, `kernel.ts`, and `index.ts`. The package currently provides feature definitions and registry, lifecycle dependency ordering and rollback, text menu/reply-number interaction, default-deny permissions, bounded event sink, validation helpers, and a composition root. Existing validation result before this audit was 38 tests passing.

## Backlog derived from evidence

1. Review and harden current core package.
2. Add a non-breaking integration adapter around the existing menu/command framework.
3. Add transport-neutral button model and a capability-gated optional renderer with text fallback; do not claim native buttons work until a real connected-account test validates them.
4. Add persistent interaction sessions with expiry, actor/chat ownership, cancellation, resume, and idempotency using the existing SQLite conventions.
5. Integrate permission and audit events at the adapter boundary.
6. Add a generic Mission Engine only after these primitives are stable.
7. Implement Group Setup Mission last.
8. Extend tests and CI checks; never upload auth/session/database/secrets.
