# R6 Requirement Brief — Scene Passport + IC/OOC Boundary

## Tujuan

R6 menyediakan passport scene yang scoped ke grup agar komunitas roleplay dapat membuka, mengikuti, menjeda, dan menutup scene dengan lifecycle yang dapat dipulihkan setelah restart. Scene adalah unit koordinasi dan presentasi; ia bukan RPG engine, bukan memory pasif, dan bukan permission bypass.

## Scope and command contract

Feature flag `group.scene.core` default-off. Admin memakai `!setscene on|off`. Pengguna memakai `!scene`, `!scene open <judul> [public|private] [ttl=menit]`, `!scene join <id>`, `!scene leave <id>`, `!scene status <id>`, `!scene pause|resume|close <id>`, `!ic <id>`, `!ooc <id>`, `!pause <id>`, dan `!consent <id> <participate|share_context|receive_assistance> <on|off> [menit]`. Semua command text-only dan setiap invalid input memiliki reply teks.

`open` membuat creator sebagai participant owner dalam mode OOC. `join` adalah participant opt-in untuk scene public. `leave` menarik consent aktif dan menghapus status participant aktif; rejoin kembali ke OOC dan memerlukan consent baru. Private scene tidak terlihat bagi nonparticipant dan tidak memiliki implicit invitation pada R6; invitation governance menjadi scope R8.

## State and authorization invariants

| Invariant | Required behavior |
|---|---|
| Group scope | Semua scene lookup dan mutation memakai `group_jid` bersama scene reference. |
| Lifecycle | `open → paused → open`, atau `open/paused → closed`; expiry menghasilkan `expired`. Stale revision ditolak dengan CAS. |
| Creator authority | Hanya creator yang dapat pause, resume, atau close scene. |
| Participant visibility | Public scene dapat dilihat anggota grup; private scene hanya creator/active participant. |
| IC/OOC | Hanya metadata presentasi participant aktif; tidak memberi access, consent, atau permission. |
| Consent | Scoped per scene, user, action, dan expiry; withdrawal efektif segera; closed/expired/left participant tidak memiliki consent efektif. |
| Persistence | Tables additive; state, participant, consent, revision, dan expiry survive restart. |
| Privacy | Audit melewati hashing guardrail dan tidak memuat raw JID, title, scene ID, message content, atau credential. |
| Retention | Closed/expired rows dipertahankan sebagai bounded history; tidak dihapus otomatis pada R6. |

## Non-goals

R6 tidak melakukan passive chat capture, recent-message import, quote/source ingestion, AI/provider call, public HTTP bridge, message deletion/edit/pin, raw WhatsApp key mutation, invite governance, moderator handoff, canon write, atau RPG mechanics seperti XP, level, stat, loot, currency, combat, dan gacha.
