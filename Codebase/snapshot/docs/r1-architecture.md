# R1 Group Safety — Architecture Brief

## Decision

Implement R1 as a `GroupSafetyService` backed by additive tables in the existing core SQLite database and a `groupSafetyPlugin` that registers commands and a `message.received` listener. The service depends on `platform-guardrails` and uses its feature flags, rate limiter, and audit contract. The plugin does not introduce a second moderation framework and does not alter the existing group foundation plugin.

The first release supports only `off` and `dry-run` safety modes. Enforcement actions that would delete messages or modify participants are intentionally unavailable because the current `WhatsAppPort` contract does not expose those operations. This avoids inventing an API and gives R1 a reversible path.

## Components

### GroupSafetyService

Owns SQLite migrations, safety settings, warnings, cases, and appeals. It validates group JIDs, actor/target JIDs, bounded text, status transitions, revisions, idempotency keys, expiry, and group ownership. It exposes typed methods; it does not send WhatsApp messages or execute actions.

### GroupSafetyPlugin

Owns user-facing commands and event subscription. It reuses existing `group.admin` permission middleware and calls `GroupSafetyService`. It sends only bounded text replies. Its `message.received` listener observes group messages, checks the group safety mode, skips bot-originated messages, applies admin exemption, and performs URL/burst detection in dry-run. It stores only message ID and hash evidence.

### PlatformGuardrailService

R0-S remains the cross-cutting guardrail. The plugin uses the group flag `group-safety` as the opt-in switch and records policy/case/warning decisions through R0-S audit. If R0-S is missing or audit persistence is unavailable, safety state changes fail closed.

## Commands

| Command | Permission | Behavior |
|---|---|---|
| `safety` | group member for read; admin for change | Show mode; `safety dry-run`, `safety off` |
| `warn` | group admin | Warn mentioned/replied target with bounded reason |
| `warnings` | group admin | List bounded recent warnings for group or target |
| `clearwarn` | group admin | Revoke a warning by ID |
| `report` | group member | Create case against a mentioned/replied target or self when no target is supplied |
| `cases` | group admin | List recent open/claimed/appealed cases |
| `case` | group admin | Show one case and state |
| `claimcase` | group admin | Claim open/appealed case with optimistic revision |
| `resolvecase` | group admin | Resolve claimed/appealed case with bounded note |
| `dismisscase` | group admin | Dismiss open/claimed/appealed case with bounded note |
| `appeal` | target member | Appeal own target case with bounded reason |

The exact display strings remain text-only and retain fallback behavior. No button is introduced.

## SQLite schema

The migration creates `group_safety_settings`, `group_safety_warnings`, `group_safety_cases`, and `group_safety_appeals`. Settings use `group_jid` as primary key. Warnings use an auto-generated opaque ID and indexes by group/target/status/expiry. Cases use an opaque ID, group, reporter, target, rule ID, evidence message ID/hash, status, assigned moderator, revision, and timestamps. Appeals use a unique `(case_id, appellant_jid)` constraint. All tables are additive and use WAL, foreign keys, and busy timeout.

## State machines

Warning state is `active` or `revoked`; expiry is evaluated at read time and active expired warnings are reported as expired without deleting history. Case states are `open`, `claimed`, `resolved`, `dismissed`, and `appealed`. Allowed transitions are `open→claimed`, `open→resolved`, `open→dismissed`, `claimed→resolved`, `claimed→dismissed`, `resolved→appealed`, and `dismissed→appealed`; an appeal returns the case to `appealed` and a moderator may resolve or dismiss it. Duplicate report with the same group/message ID returns the existing case.

## Dry-run detection

URL detection uses a conservative regex over the text input and does not fetch or resolve links. Anti-link creates one case per message ID. Anti-spam uses a fixed-window in-memory profile keyed by group and sender; it does not store message bodies and capacity exhaustion fails closed without evicting arbitrary users. Detection is active only when `group-safety` is enabled and mode is `dry-run`.

## Authorization and privacy

Command middleware performs the primary permission check. Service methods repeat ownership and state checks so direct callers cannot bypass command authorization. Case listing is group-scoped. Appeal checks appellant equals target. Audit receives only hashed actor/resource IDs and safe scalar metadata. Evidence message text is hashed with SHA-256 and never rendered by default.

## Failure behavior

Database initialization failure prevents framework startup. A guardrail audit request is persisted before each material state change; if that request cannot be recorded, the mutation fails closed. State transition conflict returns a safe “state changed, reload” result rather than overwriting. Completion audit is attempted after a successful local commit and logs only a safe error name if the separate audit store is temporarily unavailable; the prior request event remains the durable intent evidence. Detector failures emit safe error names and do not send punitive messages. A missing flag or unsupported mode is treated as disabled. No background timers are required; expiry and rate windows are evaluated on access.

## Rollout and rollback

The plugin is registered after the service and loads at startup. New groups default off. Deployment is CI artifact only. A failed release rolls back to the previous artifact; additive tables remain unused. If R1 behavior misfires, an admin can set the group mode to off, and an operator can roll back the artifact without deleting R1 tables.

## Review triggers

Before enabling destructive enforcement, add and review additive `WhatsAppPort` capabilities for message deletion and participant updates, verify current bot-admin status immediately before each action, test LID/PN normalization, add timeout/idempotency handling, and complete final WhatsApp black-box acceptance. Do not turn dry-run into enforcement by changing a string flag alone.
