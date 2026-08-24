# R8 Architecture Brief — Retcon, Handoff, and Group Access Governance

## Decision

R8 memakai satu `GroupGovernanceService` dengan domain method yang dipisahkan secara eksplisit untuk retcon review, moderator handoff, join-request lifecycle, dan invite lifecycle. Keputusan ini sengaja menghindari tiga service yang berbagi tabel dan transaction boundary secara tidak aman. Seluruh R8 diikat oleh feature flag `group.governance.core`, default `off`, dan menggunakan satu namespace audit.

## Boundaries

Retcon R8 hanya menyimpan proposal eksplisit yang dikirim melalui command; tidak ada passive full-chat capture. Retcon tidak menulis atau mengubah Canon Ledger R7. Approval R8 adalah keputusan governance yang tercatat dan menjadi input untuk handoff/continuity, bukan auto-approval canon.

Handoff menyimpan scope bounded, claimant, expiry, dan evidence count terbatas. Pergantian atau pencabutan status admin pada actor harus menyebabkan operasi baru ditolak melalui live metadata recheck.

Join request disimpan sebagai request eksplisit dengan status `pending`, `approved`, atau `rejected`. `join approve` dapat menjalankan participant-add melalui operation ledger R8 yang meniru invariant R2: idempotency correlation, claim CAS, timeout, bot-admin recheck, dan recovery-required saat payload transient tidak tersedia. Adapter event native join-request belum tersedia pada kontrak lokal; `recordJoinRequest` disiapkan sebagai bounded ingress untuk adapter masa depan, bukan fake auto-capture.

Invite info memakai capability read existing. Invite revoke membutuhkan preview dan confirmation token yang expiry-bound; raw invite link tidak disimpan di audit atau metadata. Revoke memakai `groupRevokeInvite` optional yang dibuktikan tersedia pada Baileys 7.0.0-rc14 declarations, tetapi tetap fail-closed bila adapter capability tidak tersedia.

## Consistency and failure handling

Mutation operation menggunakan tabel additive `group_governance_operations`, unique `(group_hash, correlation_hash)`, status `planned → running → succeeded|failed|dry-run|expired`, TTL, dan in-process pending payload. Claim menggunakan compare-and-set. Payload sensitif atau raw invite tidak disimpan di operation ledger. Jika process restart setelah planning tetapi sebelum execution, service mengembalikan `recovery_required` dan tidak mencoba menebak ulang side effect.

Semua side effect group melewati `runPlatformOperation` dengan timeout 20 detik dan tanpa retry otomatis untuk operasi yang tidak aman diulang. Actor dan bot admin diverifikasi ulang segera sebelum side effect. Audit hanya memakai outcome yang valid dan metadata bounded/hash.

## Compatibility

Perubahan `WhatsAppPort` berupa optional `groupRevokeInvite`, sehingga mock dan adapter lama tetap compile. Baileys adapter menambahkan method timeout-safe yang memanggil `socket.groupRevokeInvite`. Tidak ada perubahan Startup Command, `.bash_profile`, database lama, atau dependency npm.

## Non-goals

R8 tidak mengimplementasikan auto-accept native join-request event yang belum tersedia pada adapter, tidak menghapus message, tidak menjalankan retcon otomatis pada canon, tidak melakukan raw log/export/database dump, tidak menambahkan role Developer independen, dan tidak memakai button di submenu.
