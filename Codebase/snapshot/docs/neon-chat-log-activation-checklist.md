# Neon Chat-Log Activation Checklist

**Status:** preparation-only; no production schema or data mutation has been performed.

## Purpose and boundary

The Neon writer is a separate asynchronous data path from Allybot's SQLite runtime. It is disabled unless both `NEON_ENABLED=true` and `NEON_CHAT_LOG_ENABLED=true` are supplied, and it accepts records only for group JIDs explicitly listed in `NEON_CHAT_LOG_GROUPS`.

This checklist governs the future activation of permanent group chat retention for roleplay provenance and community continuity. It does not authorize migration execution or activation by itself.

## Required operator decisions

Before capture is enabled, the owner/operator must record the approved group scope, policy version, effective timestamp, retention/deletion policy, authorized readers, incident contact, and rollback owner. The group must receive a clear notice explaining that messages may be stored permanently in Neon, why they are stored, who can access them, how corrections/deletions are requested, and what content should not be sent.

The allowlist must contain only explicit WhatsApp group JIDs. A blank allowlist, a personal-chat JID, or an unreviewed group must fail closed. Adding a group later requires a new policy decision and a new effective timestamp; it must not be inferred from observed traffic.

## Schema readiness

The proposed migration is `migrations/neon/0001_whatsapp_chat_logs.sql`. It is review-only and is not called by Allybot startup, CI deployment, or the verifier. Before execution, apply it first to an isolated Neon branch or staging database, inspect the resulting constraints and indexes, and rehearse rollback/restore using synthetic records only.

The writer expects `public.whatsapp_chat_logs` and a unique primary key on `event_key`. The writer's `ON CONFLICT (event_key) DO NOTHING` is idempotent only when that uniqueness invariant exists.

## Security and privacy controls

The Neon connection string remains a server-side secret. It must not appear in source, GitHub, sanitized artifacts, logs, screenshots, or chat. The service must use TLS, least-privileged database credentials where operationally possible, restricted database role grants, and separate operator/read access from writer access.

Raw message content is sensitive. It must not appear in application logs, error messages, test output, CI evidence, traces, or metrics. The current writer stores normalized message fields and a SHA-256 integrity hash; the hash does not provide confidentiality or replace access control.

## Canary procedure

After migration and policy approval, use one approved group only. Start with `NEON_CHAT_LOG_ENABLED=false`, verify configuration, then enable the flag during a controlled maintenance window. Observe bounded counters for accepted, persisted, failed, dropped, retries, and queue depth. Send a synthetic test message only if the group policy permits it, verify one persisted row through an authorized read-only query, and verify that replaying the same event does not create a duplicate.

If the queue grows, failures repeat, or authorization/consent is disputed, disable the feature flag and preserve the evidence without exporting raw content. Disabling capture stops new enqueues; it does not delete already persisted records. Deletion or correction requires a separately approved, auditable data-governance operation.

## Exit criteria for future activation

Activation is not ready until all of the following are true: the migration has been reviewed and applied in an isolated branch; schema constraints and indexes have been checked; consent/notice has been delivered; group allowlist is recorded; authorized readers and deletion procedure are documented; backup/recovery expectations are known; a canary test passes; no raw content is emitted by logs or evidence; and rollback ownership is explicit.

## Current evidence

At preparation time, the following are true: Neon client connectivity has been verified with `SELECT 1`; the writer is deployed but default-off; no migration has been executed; no `INSERT`, `UPDATE`, or `DELETE` has been issued by this preparation task; no chat capture has been enabled; and SQLite remains the runtime database.
