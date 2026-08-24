# R8 Requirement Brief — Retcon, Handoff, and Group Access Governance

## Objective

R8 menambahkan lapisan governance komunitas roleplay yang membantu moderator meninjau retcon, meneruskan continuity, dan mengelola akses grup secara bounded. Fitur baru bersifat opt-in per grup melalui `group.governance.core`, default `off`.

## Command contract

| Command | Behavior |
|---|---|
| `!retcon preview target \| replacement \| rationale` | Menampilkan preview text-only tanpa mutation canon. |
| `!retcon propose target \| replacement \| rationale [\| source]` | Membuat draft retcon eksplisit. Source hanya disimpan sebagai hash reference. |
| `!retcon propose-status <id>` | Mengubah draft menjadi proposed dengan CAS. |
| `!retcon approve|reject <id> [revision]` | Admin melakukan decision pada proposed entry dengan revision guard. |
| `!retcon history <id>` | Menampilkan bounded append-only history. |
| `!handoff offer <scope> [evidenceCount]` | Membuat offer handoff dengan scope dan evidence count bounded. |
| `!handoff claim|decline|close <id> [revision]` | Mengubah state handoff dengan expiry dan revision guard. |
| `!handoff status` | Menampilkan bounded handoff statuses. |
| `!continuity check` | Merangkum pending retcon, handoff aktif, join request, dan recovery operation. |
| `!joinrequests [status]` | Menampilkan request IDs dan requester reference hash, bukan raw requester JID. |
| `!join approve|reject <requestId> [revision]` | Menjalankan decision melalui R8 operation ledger dan live role check. |
| `!invite info` | Menampilkan invite link hanya melalui admin-gated read path. |
| `!invite revoke preview` | Membuat expiry-bound confirmation token tanpa revoke. |
| `!invite revoke confirm <token>` | Merevoke invite melalui operation ledger dan optional adapter capability. |
| `!retcon enable|disable` | Admin mengaktifkan atau menonaktifkan feature flag grup. Submenu tetap text-only. |

## Invariants

Semua group JID, actor JID, bot JID, request ID, operation ID, dan confirmation input divalidasi. Object ID selalu di-query bersama `group_jid` atau `group_hash`. Approval, rejection, dan invite revoke mempunyai idempotency correlation hash, operation TTL, claim CAS, timeout 20 detik, no automatic retry, dan `recovery_required` saat status tidak aman dipulihkan.

Actor dan bot admin di-recheck dari metadata live sebelum side effect. Non-admin, bot-not-admin, capability missing, timeout, stale revision, duplicate correlation, dan expired confirmation semuanya fail-closed. Raw invite value, raw JID, raw message content, credential, serta raw error tidak masuk audit. Audit memakai namespace `allybot` dan outcome R0-S yang valid.

## Compatibility and non-goals

`WhatsAppPort.groupRevokeInvite` ditambahkan sebagai optional method agar mock dan adapter lama tetap kompatibel. Implementasi Baileys memakai method `socket.groupRevokeInvite` yang tersedia pada deklarasi Baileys pinned `7.0.0-rc14`.

R8 tidak menerima passive full-chat memory, tidak mengubah Canon Ledger R7 secara otomatis, tidak menghapus message, tidak menjalankan eval/exec/shell, tidak membuat Developer role, tidak mengimplementasikan tombol submenu, dan belum mengklaim native join-request event karena kontrak adapter belum menyediakan ingress event tersebut.
