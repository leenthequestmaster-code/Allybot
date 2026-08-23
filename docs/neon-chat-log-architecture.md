# Neon Chat Log Architecture Decision Brief

## Problem statement

Allybot membutuhkan boundary PostgreSQL terpisah untuk World Database dan jejak roleplay komunitas. Neon project `Allyssea Roleplay Database` menjadi target storage terpisah dari SQLite runtime Allybot dan Supabase project yang sudah dipakai untuk verifikasi sebelumnya.

Requirement baru meminta isi pesan grup WhatsApp dipertahankan secara permanen untuk provenance roleplay, deteksi manipulasi informasi, dan memori komunitas yang konsisten. Karena data ini berisi konten komunikasi dan identifier pengguna, koneksi database tidak boleh otomatis berarti seluruh alur pesan langsung direkam. Capture perlu memiliki group scope, notice/consent, authorization, idempotency, bounded queue, audit, dan recovery sebelum diaktifkan.

## Scope slice ini

Slice ini menginisialisasi **client PostgreSQL Neon yang terpisah** dan writer chat-log yang feature-flagged. Tidak ada tabel, schema, migration, `INSERT`, `UPDATE`, `DELETE`, atau backfill yang dijalankan oleh deployment ini. Writer hanya akan enqueue dan mencoba persistence ketika `NEON_CHAT_LOG_ENABLED=true` serta group JID tercantum eksplisit di `NEON_CHAT_LOG_GROUPS`. SQLite tetap menjadi database runtime dan `POSTGRES_URL` tetap menjadi jalur verifier Supabase sebelumnya.

Client membaca `NEON_DATABASE_URL` dari environment server. Feature flag `NEON_ENABLED` default `false`; ketika false, tidak ada client Neon yang dibuat. Connection string tidak disimpan di source code, GitHub, sanitized artifact, log, atau project files.

## Boundary and data ownership

| Boundary | Owner | Purpose | Current state |
|---|---|---|---|
| SQLite | Allybot runtime | Session, command, operational state | Existing runtime; unchanged |
| `POSTGRES_URL` | Supabase verifier | Read-only `SELECT 1` verification | Existing verifier; unchanged |
| `NEON_DATABASE_URL` | Neon client + bounded writer | Future durable roleplay/chat-log storage | Integrated, default-off; schema migration still separate |

Neon uses the pooled connection string returned by the connector. The client uses TLS required, a bounded connection count, transaction-safe prepared-statement settings, connection timeout, idle timeout, and max lifetime. Neon documents pooled endpoints for higher concurrency and requires SSL/TLS for connections.[^1][^2]

## Writer design; schema migration and policy remain separate

The writer consumes `message.received` asynchronously and returns immediately after enqueue, so it does not wait for Neon before command dispatch continues. It writes only messages from explicitly enabled group scopes, preserves epoch milliseconds as the source-of-truth timestamp, and uses an idempotency key based on `(group_jid, message_id)`. Payload fields have bounded lengths, content receives a SHA-256 integrity hash, and malformed/oversized records are dropped without throwing into the WhatsApp event path.

The queue is single-worker and bounded. When full, new records are dropped with a counter and redacted warning. Transient connection/availability/serialization failures receive bounded exponential backoff up to the configured attempt count; authentication and schema failures are not retried. Shutdown first unregisters the event listener, then drains the queue up to a fixed deadline and reports any in-flight or queued remainder.

The schema target is `public.whatsapp_chat_logs`, with an immutable event identifier, group scope, sender reference, WhatsApp message identifier, epoch timestamp, message type, content, quoted-message reference, ingestion time, source adapter, integrity hash, and audit state. The writer expects a unique constraint on `event_key` for idempotency. The schema and indexes require a separate migration review; this slice deliberately does not create them, so enabling the writer before that migration exists will fail closed on the non-retryable missing-table error.

Permanent retention is an explicit product decision, not an implicit side effect. Before capture is enabled, the group must receive a clear notice and an owner/admin-controlled opt-in policy. The implementation must define who can enable/disable capture, what happens to messages sent before opt-in, export/delete policy, incident response, and how members can request correction or removal. These controls remain open design items and are not silently assumed by the writer.

## Group-scoped opt-out control

When the global feature flag and Neon allowlist are active, the `!chatlog` command provides a reversible group-scoped control. `!chatlog off` suppresses new records for the current group, `!chatlog on` removes the suppression, and `!chatlog status` reports the effective state. The command is group-only and is authorized through the canonical permission resolver for either the configured bot Owner or a group administrator; ordinary members cannot mutate the state.

The suppression state is persisted through the existing `PlatformGuardrailService` feature-flag table in SQLite under feature ID `neon-chat-log-suppressed`. No new table, schema, dependency, Neon migration, or second persistence abstraction is introduced. Audit records use the existing hashed actor/resource fields and contain no raw JID, message content, or credentials. The plugin loads suppressed allowlisted groups at startup into a mutable in-memory set, checks it before `NeonChatLogWriter.enqueue()`, and clears it on unload. If SQLite persistence fails, the in-memory mutation is rolled back; if the process restarts, the persisted suppression is reloaded before message capture resumes.

The opt-out applies to messages received after the state transition. Because the framework emits `message.received` before dispatching the command, the `!chatlog off` command message itself can be observed by the existing writer before the command handler changes the state; subsequent messages are suppressed. Existing Neon rows are never deleted by this command.

## Failure and recovery principles

Neon outage must not stall WhatsApp message handling. A bounded queue, bounded retry, duplicate-safe insert, and observable dead-letter path are required for the future writer. The queue must have a finite memory and disk policy; “permanent” means durable after successful commit, not guaranteed during an unbounded outage. The writer must fail closed for missing group consent and fail safe for malformed messages.

## Rollback

Disabling `NEON_ENABLED` stops creation of the Neon client without changing SQLite or deleting Neon data. `!chatlog off` provides a narrower group-scoped runtime rollback without deleting Neon rows. Removing this slice requires only reverting the client/config/test changes; the existing guardrail feature-flag rows can remain inert or be cleaned up through a separately reviewed maintenance operation.

## Evidence and references

The connection string was resolved from the enabled Neon connector for project `Allyssea Roleplay Database`, but its secret value is intentionally not reproduced here. Neon’s official documentation states that connection strings should be stored in environment variables and that pooled endpoints are available for higher concurrency.[^1][^2]

[^1]: [Neon — Connect from any application](https://neon.com/docs/connect/connect-from-any-app)
[^2]: [Neon — Connection pooling](https://neon.com/docs/connect/connection-pooling)
[^3]: [Neon — Connect a JavaScript/Node.js application](https://neon.com/docs/guides/javascript)
