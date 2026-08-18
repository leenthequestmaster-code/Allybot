# R0-S Safety Core — Architecture Decision Brief

## Decision

Implement R0-S as an additive modular-monolith capability. Pure, deterministic guardrails live in `src/platform/guardrails.ts`; persistent group flags and audit storage live in `src/services/platform-guardrail-service.ts`; the service is registered during normal framework boot. No new dependency, process, queue, or database file is introduced.

The service opens the existing core SQLite path with the same WAL, synchronous, foreign-key, and busy-timeout conventions already used by storage and Developer Mode. All new tables are namespaced and additive. Existing command handlers remain unchanged until later batches explicitly consume these contracts.

## Why this boundary

The current code already has platform contracts, a default-deny permission evaluator, bounded in-memory event sink, operation timeout/retry helper, and additive SQLite services. A separate service preserves ownership and lifecycle while avoiding a speculative microservice. Pure guardrails are kept independent from SQLite so unit tests can exercise policy, rate, circuit, and action invariants without production state.

## Alternatives rejected

| Alternative | Rejection reason |
|---|---|
| New external policy/rate-limit dependency | Adds supply-chain and deployment risk without a verified scale requirement |
| New database or Redis | R0-S workload is single-process and existing SQLite already provides durable state; a second store would create consistency and backup burden |
| Wire every existing command immediately | Expands blast radius and mixes guardrail foundation with behavior changes; later batches will opt in through explicit contracts |
| Keep all audit only in logger | Logs are not a durable queryable audit source and raw-error leakage is harder to prevent consistently |
| Delete old audit rows after a fixed period | Conflicts with the user requirement; archive-first is safer and reversible, with future retention as a separate policy |

## Components

### `GuardrailPolicyRegistry`

An in-memory, code-owned registry of versioned policy metadata. IDs, actions, scope, optional feature flag, and optional rate profile are validated. Unknown policy, action mismatch, or disabled policy returns a denial decision. User input can reference an ID but cannot register code or a callback.

### `FeatureFlagStore`

The service exposes group-scoped flags. A missing flag is disabled. Group JIDs and feature IDs are validated. Updates are idempotent by `(group, feature)` and store only a hash of the actor in audit metadata; the group identifier is retained in the configuration table because it is required for lookup and follows the existing group configuration pattern.

### `AuditStore`

Audit records use a fixed schema: `event_id`, `event_type`, `schema_version`, `namespace`, `occurred_at`, `actor_hash`, `resource_hash`, `outcome`, `correlation_id`, `metadata_json`. Metadata is a bounded scalar allowlist; raw error message/stack, arbitrary objects, credentials, tokens, and message payloads are rejected. Hot records and archive records share the same primary event ID, preventing duplicates.

When hot capacity is exceeded, the oldest records move to archive inside the same SQLite transaction as the new event. If archive insertion fails, the transaction rolls back and the hot record remains. Archive queries are read-only and archive rows are never automatically deleted.

### `RateLimiter`

A deterministic fixed-window limiter with named finite profiles, injectable clock, and bounded key capacity. No timers are created. A key that would exceed the state capacity is denied rather than evicting another identity silently. This protects memory and makes overload behavior explicit.

### `SafeActionRegistry`

A code-owned allowlist of action metadata. It resolves only registered, enabled actions and validates action IDs. It has no executor and no path to `eval`, `exec`, shell, dynamic import, or user-supplied callback. Later automation work will map actions to explicit internal handlers.

### `ProviderCircuitBreaker`

A synchronous state machine with `closed`, `open`, and `half-open` states. Failure threshold, cooldown, and probe limit are finite and validated. There is no background timer; state transitions occur on calls. Open state prevents provider execution, half-open allows a bounded probe, success closes the circuit, and failure reopens it.

## Data flow

1. A future command or automation handler resolves a code-owned policy ID.
2. The policy registry validates policy/action/scope.
3. Caller performs existing permission resolution; R0-S does not bypass or replace Owner/group authorization.
4. Caller checks the group feature flag and consumes the named rate/resource profile.
5. If any check denies, the caller emits a structured audit event and does not execute the action.
6. If the operation uses an external provider, the caller asks the circuit breaker before the provider call and reports success/failure afterward.
7. Audit writes pass through the service sanitizer and hot/archive transaction.

## SQLite schema

The migration creates four additive tables: `platform_guardrail_feature_flags`, `platform_guardrail_audit_hot`, `platform_guardrail_audit_archive`, and `platform_guardrail_archive_meta`. Both audit tables use `event_id` as primary key. Feature flags use `(group_jid, feature_id)` as primary key. The archive metadata table is reserved for future migration markers and does not imply deletion.

## Failure behavior

| Failure | Behavior |
|---|---|
| Invalid policy/feature/action/profile | Throw during registration/configuration; runtime request returns a safe denial where applicable |
| Unknown policy/action | Deny and audit safe reason |
| Missing group flag | Treat as disabled |
| Rate state capacity exhausted | Deny with bounded reason; never evict another key implicitly |
| Provider circuit open | Do not call provider; return circuit-open decision |
| Audit archive insert fails | Roll back the complete audit transaction; do not delete hot record |
| SQLite busy/locked | Existing SQLite busy timeout applies; caller receives failure and can retry through existing operation helper |
| Guardrail service initialization fails | Framework startup fails before WhatsApp traffic is accepted; rollback to prior artifact is safe because schema is additive |

## Observability

Operational logs contain component, policy/action IDs, event type, outcome, and safe error name only. JIDs used in audit are hashed with SHA-256 and truncated to a fixed length. No audit method accepts raw error objects or arbitrary payload objects.

## Rollout

The first release creates schema and exposes contracts but does not enable new user-facing enforcement. Existing commands remain behaviorally unchanged. Later batches opt in one feature at a time through group flags, beginning disabled. Rollback is artifact rollback; new tables remain harmless and can be read by a later forward release.

## Review triggers

Review this decision before R1 if archive growth, SQLite write contention, privacy requirements, or multi-process deployment appears in runtime evidence. A change to archive retention must be an explicit policy migration with backup/restore verification.
