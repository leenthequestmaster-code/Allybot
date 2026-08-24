# R2 Moderation Actions — Mini Threat Model

## Scope and assets

Scope is the R2 command/plugin → domain service → WhatsAppPort → Baileys path for participant actions and group settings. Assets are group membership/roles, group settings, operation state, audit integrity, user privacy, bot session stability, and the ability to disable the feature safely.

## Actors and trust boundaries

| Actor | Capability | Boundary |
|---|---|---|
| Regular group member | Can send commands and mention/quote targets | Untrusted message input |
| Group admin | Can request moderation action subject to policy and feature flag | Authenticated but not fully trusted for other groups |
| Bot identity | Must be current group admin/superadmin at side-effect time | WhatsApp transport privilege |
| Baileys/WhatsApp | Executes or rejects protocol mutation | External protocol boundary |
| SQLite/runtime | Stores bounded operation/audit state | Local persistence boundary |

## Abuse cases and controls

| Abuse case | Control | Verification |
|---|---|---|
| Regular member invokes moderation | Existing `group.admin` permission plus domain live role recheck | Negative command and service tests |
| Admin from group A targets group B | Group is derived from current message; operation/flag/metadata all use same group | Cross-group isolation test |
| Actor loses admin between check and call | Metadata recheck immediately before adapter call; WhatsApp remains final authority | Stale metadata fixture and adapter failure test |
| Bot is not admin | Bot role must be admin/superadmin before mutator | Negative bot-role test |
| Target is malformed or cross-identity | Canonical JID validation and adapter LID/PN normalization; bounded target count | Invalid JID, LID fixture, and duplicate target tests |
| Duplicate command/replay | Unique group+correlation operation key and completed/started short circuit | Duplicate and restart-state tests |
| Partial participant mutation | Typed per-target result; no automatic retry; aggregate status persisted | Mixed result fixture |
| Timeout/retry storm | 20-second timeout and no automatic mutator retry by default | Timeout fault injection |
| Feature flag bypass | Default-off flag and safe action/policy check before adapter | Disabled-flag test |
| Audit leaks JID/content/token | Hash-only identifiers and sanitizer-safe metadata; no raw upstream error | Secret/JID lexical and runtime assertion |
| Resource exhaustion | Maximum target count, bounded rate profile, bounded operation rows/query | Capacity and burst tests |
| Malicious setting input | Closed union of four settings; no free-form value passed to adapter | Invalid setting test |
| Rollback causes data loss | Additive schema and previous artifact compatibility; no destructive migration | Migration/restart rehearsal |

## Residual risks

WhatsApp may accept a mutation partially or reject it based on current protocol state; the bot cannot make participant mutation transactional across multiple targets. Live client compatibility and real group behavior remain unverified until final black-box acceptance by user decision. Delete-message remains outside scope because the current storage/contract cannot guarantee a correct full message key without passive history expansion.

## Security decision

R2 must fail closed when policy, feature flag, permission, bot role, adapter capability, audit, or operation state is unavailable. A stable generic response is preferable to exposing upstream transport details. No evaluation, shell, raw logs, database dump, credential, or session control is introduced.
