# R7 Requirement Brief — Canon Ledger

## Tujuan

R7 menyediakan ledger canon komunitas yang dapat direview, disetujui, ditelusuri, dan digantikan tanpa menghapus sejarah. Canon hanya berasal dari input eksplisit pengguna atau source R4 yang direferensikan secara eksplisit; bot tidak mengimpor isi chat secara pasif dan tidak menafsirkan source sebagai instruksi.

## Scope and command contract

Feature flag `group.canon.core` default-off. Admin memakai `!setcanon on|off`. Pengguna memakai `!canon`, `!canon add <judul> :: <isi> [source=<id>]`, `!canon propose <id>`, `!canon approve <id>`, `!canon reject <id>`, `!canon search <kata>`, `!canon history <id>`, `!canon retire <id>`, dan `!lore`. Semua command text-only dengan reply fallback.

`add` membuat `draft`; creator dapat `propose`; admin grup dapat `approve`, `reject`, dan `retire`. `reject` mengembalikan `proposed` menjadi `draft`. `approve` menjadikan entry approved dan menandai approved entry sebelumnya dengan judul yang sama sebagai `superseded`. Lookup anggota hanya mengembalikan `approved`; creator dapat melihat entry miliknya untuk review dan history.

## State and authorization invariants

| Invariant | Required behavior |
|---|---|
| Lifecycle | `draft → proposed → approved → superseded → retired`; reject `proposed → draft`. |
| Group tenancy | Setiap lookup/mutation memakai `group_jid` pada predicate utama. |
| Object authorization | Creator-only propose; group-admin approval/rejection/retirement; service tidak hanya mengandalkan UI. |
| CAS | Transition memeriksa status dan revision; stale revision ditolak. |
| Provenance | Optional source reference harus active, visible, dan berasal dari group yang sama pada KnowledgeService. |
| History | Setiap create/transition ditulis append-only dalam transaction bersama current-state update. |
| Conflict | Search mengembalikan uncertainty marker ketika approved entries dengan title setara memiliki content hash berbeda; bot tidak memilih pemenang otomatis. |
| Privacy | Audit tidak memuat raw JID, title/content, canon ID, source ID, credential, atau raw error. |
| Retention | Superseded/retired entries dipertahankan; tidak ada destructive delete pada R7. |

## Non-goals

R7 tidak melakukan passive full-chat memory, AI synthesis, automatic canon approval, source excerpt copying, message deletion/edit, group invite/access governance, moderator handoff, event scheduling, media processing, atau RPG mechanics.
