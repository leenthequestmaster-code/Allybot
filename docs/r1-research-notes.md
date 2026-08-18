# R1 Group Safety — Evidence Notes

## Decision question

What can R1 safely implement now in the current Allybot adapter, and which enforcement capabilities require an additive WhatsAppPort contract and a separate verification gate?

## Local evidence

| Claim | Evidence | Confidence |
|---|---|---|
| Group plugin already has group-only guard and `group.admin` permission boundary | `src/framework/plugins/group.ts` and `tests/permissions.test.js` | High |
| Current `WhatsAppPort` can send text and fetch group metadata but has no delete-message or participant-mutation method | `src/framework/contracts.ts` lines 70–90 | High |
| Framework emits `message.received` before command dispatch and supports plugin/service lifecycle | `src/framework/application.ts` | High |
| R0-S service is available through the service registry after the previous release | `src/index.ts`, `PlatformGuardrailService` | High |

## Versioned upstream evidence

| Claim | Source | Scope/limitation |
|---|---|---|
| Baileys deletes a message for everyone by sending `{ delete: msg.key }` through `sock.sendMessage` | [Baileys Message Actions](https://baileys.wiki/messaging/message-actions), retrieved 2026-08-18 | Establishes upstream capability, not current Allybot adapter exposure |
| Baileys group participant changes use `groupParticipantsUpdate(jid, jids, action)` and require admin privileges for most group mutations | [Baileys Groups](https://baileys.wiki/features/groups), retrieved 2026-08-18 | Live compatibility with this account/client remains unverified until final WhatsApp acceptance |
| Baileys recommends group metadata caching for group-heavy workloads and emits group participant update events | [Baileys Groups](https://baileys.wiki/features/groups), retrieved 2026-08-18 | Does not prove current cache freshness or LID/PN mapping behavior |
| Installed package is `@whiskeysockets/baileys 7.0.0-rc14` | [npm package page](https://www.npmjs.com/package/@whiskeysockets/baileys), retrieved 2026-08-18 | Release is a v7 release candidate; official migration caveats remain relevant |

## R1 scope decision

The first R1 vertical slice will implement a durable warning ledger and moderation case management with audit linkage. Anti-link and anti-spam policy definitions will be represented as disabled/dry-run-capable group policies, not silently enforced against live groups. Message deletion and participant removal will not be invoked until an additive adapter capability exists, current bot-admin status is rechecked, and the final WhatsApp black-box gate is available.

This scope follows the roadmap instruction to start with warning plus auditable cases and to defer anti-link/anti-spam enforcement until thresholds and false-positive policy are explicit. It also avoids inventing a delete API in the current `WhatsAppPort`.

## Security interpretation

A warning is a moderation state transition, not merely a message reply. It needs actor/target/group ownership, reason length limits, expiry, idempotency, bounded history, and explicit clear/revoke semantics. Case evidence must store message identifiers and redacted metadata rather than full chat payload by default. The case state machine must reject unauthorized transitions and stale revisions.

## Unknowns and refresh triggers

The live account’s admin capability, exact LID/PN identity returned for moderation targets, delete-message compatibility, and WhatsApp client rendering are not established by local tests. Refresh this evidence after Baileys rc14 changes, adapter capability expansion, or final production black-box acceptance.
