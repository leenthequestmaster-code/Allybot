# R3 Collaboration Suite — Threat Model

## Trust boundaries

| Boundary | Threat |
|---|---|
| WhatsApp command → plugin | Malformed input, command replay, unauthorized actor |
| Plugin → collaboration service | Bypass feature flag or group scope |
| Service → SQLite | Cross-group query, duplicate state, stale revision |
| Scheduler → WhatsApp transport | Duplicate delivery, stale policy, timeout |
| Native poll API → domain | Untrusted/out-of-order transport update |
| Service → audit | Raw identifiers/content leakage |

## Primary abuse cases and controls

| Abuse case | Control | Residual limitation |
|---|---|---|
| Member uses collaboration while off | Domain-level default-off check plus stable fallback | Admin must explicitly enable |
| Member uses admin flag command | Existing live group-admin permission resolver | Live WhatsApp acceptance deferred |
| Replay `!vote` or same message | Primary key `(poll_id, voter_jid)` and correlation hash | One-vote policy only; future multi-select needs schema change |
| Cross-group poll/task/reminder ID | Group predicate and `require...InGroup` lookup | IDs are opaque UUID prefixes in reply |
| Close race | Poll revision CAS | Conflicting actor receives stable changed state |
| Reminder duplicate after restart | Atomic claim `scheduled → sent` before side effect | Delivery provider can still fail after claim; failure transitions to expired |
| Reminder delivery while feature disabled | Flag recheck immediately before claim/transport | Scheduled record remains until re-enabled or explicit cancel |
| Native poll missing/failing | Optional port capability and text fallback | Native tally is not automatic in this slice |
| Timeout/retry amplification | 20-second production timeout, maxAttempts=1 | Dead transport can delay one bounded dispatch cycle |
| Audit leaks content/JID | Audit metadata only IDs/counts/lengths; guardrail sanitizer hashes JIDs | Collaboration domain DB retains owner/creator JIDs for operation ownership |
| Large input/rate abuse | bounded text/options/list sizes and R0-S fixed-window profile | Global throughput depends on existing process capacity |

## Non-goals

R3 does not add native delete/edit/pin/star/reaction/read mutation, passive chat memory, passive presence, generic URL downloader, AI context access, broadcast, account-global privacy changes, arbitrary automation, eval/exec/shell, or RPG mechanics.

## Verification requirements

Focused suite covers default-off, group isolation, poll expiry/CAS close, duplicate vote, invalid input, native capability failure, restart-safe reminder dispatch, timeout without retry, task ownership, decision isolation, and plugin admin/text fallback. Full CI must additionally verify typecheck, clean build, source–dist parity, syntax, all existing R0-S/R1/R2 regression suites, artifact hygiene, and deploy smoke.
