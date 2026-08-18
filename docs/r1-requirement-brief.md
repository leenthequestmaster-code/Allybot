# R1 Group Safety — Requirement Brief

## Outcome

R1 memberi grup mekanisme safety yang dapat diaudit: admin dapat mengaktifkan policy safety secara eksplisit, memberi warning yang memiliki expiry dan histori, anggota dapat melaporkan kasus, moderator dapat mengelola case, dan anggota target dapat mengajukan appeal. Anti-link dan anti-spam dimulai dalam mode `dry-run`; tidak ada penghapusan pesan atau perubahan peserta sampai adapter capability dan final WhatsApp acceptance tersedia.

## Current-state facts

R0-S sudah menyediakan feature flag per grup, audit hot/archive, bounded rate limiter, policy registry, safe action metadata, dan provider circuit breaker. Framework memiliki `message.received` event sebelum command dispatch, command permission middleware, SQLite service lifecycle, dan `WhatsAppPort` yang saat ini hanya mengekspos `sendText` serta `getGroupMetadata` untuk operasi grup. `WhatsAppPort` belum mengekspos delete message atau participant mutation.

## Scope

| Capability | Required behavior |
|---|---|
| Safety toggle | `off` atau `dry-run`; default off; hanya group admin dapat mengubah |
| Warning ledger | Warning memiliki ID, group/target/issuer, bounded reason, created/expiry/revoked state, revision, dan audit linkage |
| Case management | Report membuat case; moderator dapat list, claim, resolve, dismiss; state transition fail-closed dan revision-aware |
| Appeal | Target case dapat mengajukan appeal sekali per state; reason bounded dan audit-linked |
| Anti-link | Dalam dry-run, URL detection membuat case dengan `ruleId=anti-link`; admin exemption; tidak menghapus pesan |
| Anti-spam | Dalam dry-run, bounded rate profile mendeteksi burst dan membuat case; no unbounded message memory |
| Evidence | Store message ID dan hash evidence; tidak menyimpan full quoted message atau full chat history |
| Authorization | Admin-only for configuration/moderation; member can report and appeal only own target case; group isolation enforced |

## Non-goals

R1 tidak menambahkan arbitrary automation, kick/ban, delete message, admin promotion, AI classification, full-chat memory, persistent message archive, payment/economy, atau live WhatsApp test. R1 tidak mengubah existing group foundation commands.

## Data and privacy policy

JID target/actor disimpan pada moderation tables karena diperlukan untuk case ownership dan permission checks, tetapi tidak disalin ke audit metadata mentah; audit memakai hash. Evidence text hanya di-hash. Reason dibatasi 240 karakter, whitespace dinormalisasi, dan tidak disimpan sebagai raw upstream error. No passive full-chat memory.

## Acceptance criteria

1. Missing safety setting is `off`; group A cannot see or alter group B state.
2. Only `group.admin` can enable dry-run, issue/revoke warnings, claim/resolve/dismiss cases, or list all cases.
3. Members can report a case and appeal a case targeted at their own JID; cross-target appeal is denied.
4. Warning IDs and case IDs are bounded, unique, idempotent where a message ID is supplied, and survive restart.
5. Invalid status transitions, stale revisions, duplicate reports, oversized reasons, invalid JIDs, and non-group commands fail safely.
6. Anti-link and anti-spam dry-run create auditable cases but do not call any destructive WhatsApp capability.
7. Anti-spam state is bounded and resettable; the system does not store every message.
8. Case evidence and audit contain no full message text, raw error, credential, token, or secret-like metadata.
9. Existing tests remain green; R1 tests cover permission, isolation, persistence, idempotency, transitions, appeals, dry-run detection, and negative inputs.
10. Typecheck, build, parity, dependency audit, sanitized artifact inspection, deployment smoke test, and rollback path pass before release.

## Rollback

R1 tables are additive. Binary rollback to the previous artifact leaves tables unused and does not require destructive migration. Feature flag default is off, so a forward-fix can disable R1 per group without touching existing commands. WhatsApp destructive capabilities remain absent until a separately reviewed adapter change.
