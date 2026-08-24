# R2 Moderation Actions — Research Notes

## Version lock

The repository pins `@whiskeysockets/baileys` `7.0.0-rc14`. The official npm page identifies this exact release and warns that v7 contains breaking changes. The GitHub release page identifies `v7.0.0-rc14` as the current release in scope.

## Evidence matrix

| Claim | Source | Evidence | Scope / limitation |
|---|---|---|---|
| Group participant mutation is a single socket method | [Baileys Groups](https://baileys.wiki/features/groups) | `sock.groupParticipantsUpdate(jid, jids, action)` with action `add|remove|demote|promote` | Official docs; actual local type/signature must still be checked |
| Group mutations generally require admin privileges | [Baileys Groups](https://baileys.wiki/features/groups) | Docs state most modifying operations require the account to be a group admin and regular members receive an error | WhatsApp-side authorization; Allybot must pre-check too |
| Delete-for-everyone uses message key | [Baileys Message Actions](https://baileys.wiki/messaging/message-actions) | `sock.sendMessage(jid, { delete: msg.key })` | Requires complete/canonical message key; current CoreMessage does not expose one yet |
| Pinned package is v7 rc14 | [npm package](https://www.npmjs.com/package/@whiskeysockets/baileys), [GitHub releases](https://github.com/WhiskeySockets/Baileys/releases) | npm and release metadata identify `7.0.0-rc14` | Release candidate; API behavior needs local type/fixture verification |
| Existing adapter has no mutator contract | local `src/framework/contracts.ts`, `src/whatsapp.ts` | `WhatsAppPort` exposes send/read primitives and group metadata only; no delete or participant mutation | Directly observed local ground truth |

## R2 decision

R2 should add a narrow, additive adapter capability contract and a domain service. It must not expose raw socket methods. The first executable slice should support explicit admin-gated actions with live metadata recheck, bot-admin precondition, target validation, idempotency/correlation ID, bounded timeout, redacted failure, and audit request/completion. Destructive action defaults remain off until CI and deployment gates pass.

## Unknowns to retire before implementation

The exact local TypeScript signature for `groupParticipantsUpdate`, the available message-key fields in current `CoreMessage`, and whether the adapter can reconstruct a valid delete key without storing full chat history must be confirmed from installed types/source. If the key contract is insufficient, delete-message stays deferred while participant actions proceed as a separate capability.
