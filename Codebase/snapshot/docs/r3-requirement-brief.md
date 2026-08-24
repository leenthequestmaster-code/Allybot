# R3 Collaboration Suite — Requirement Brief

## Outcome

Allybot menyediakan workflow kolaborasi group yang persistent dan text-first: poll/decision, vote idempotent, reminder, task, agenda, dan decision log. Native WhatsApp poll hanya optional presentation; pencatatan resmi tetap melalui domain state dan command `!vote`.

## Scope implemented

| Capability | Command | State |
|---|---|---|
| Feature status | `!collab` | Read-only |
| Group flag | `!setcollab on|off` | Admin-only, default-off |
| Native poll presentation | `!setnativepoll on|off` | Admin-only, optional, default-off |
| Poll | `!poll`, `!poll status`, `!poll close` | Persistent, 24-hour expiry |
| Vote | `!vote <id> <option>` | One vote per voter/poll, no replay |
| Reminder | `!remind`, `!reminders`, `!remindcancel` | Persistent, bounded 30-day window |
| Task | `!task`, `!tasks`, `!taskdone` | Creator/assignee completion |
| Decision | `!decision`, `!decisions` | Explicit record |
| Agenda | `!agenda` | Read-only aggregate |

## Invariants

1. Group-scoped state cannot be queried or mutated through another group.
2. All state-changing collaboration commands require the `group-collaboration` feature flag; the default is off.
3. Admin-only flag commands use the existing group-admin permission resolver; domain records remain bounded and validated.
4. A voter can create only one vote per poll; duplicate command/message replay does not alter the first vote.
5. Poll close and native transport status updates use revision compare-and-set semantics.
6. Reminders are persistent and are claimed atomically before transport. A transport timeout is not retried automatically and is recorded as failed/expired.
7. Reminder dispatch checks the group feature flag immediately before side effect; disabling the flag prevents delivery while preserving scheduled state.
8. Text and numeric fallback is always available. Native poll absence/failure does not remove the domain poll.
9. Audit metadata contains bounded IDs/counts/lengths only; raw message content and raw identifiers are not placed in audit metadata.
10. No passive history ingestion, presence tracking, arbitrary code execution, public HTTP trigger, or account-global command is introduced.

## Known limitation

Baileys poll event aggregation is not yet wired into `CoreMessage`/storage. Native poll is therefore presentation-only in this slice; the official tally uses `!vote`. Automatic native poll update ingestion remains a future capability gated by a message-key/event storage contract and black-box acceptance.
