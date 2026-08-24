# R6 Architecture Brief — Scene Passport

## Ground truth and decision

R6 menambah SceneService additive pada database Allybot. Primitive `MissionEngine` yang ada memiliki ownership satu actor dan tidak memodelkan participant set, sehingga tidak dipakai sebagai abstraction palsu. Scene membutuhkan tabel scene, participant, dan consent agar dua scene paralel dapat terisolasi dan restart-safe.

Scene berada dalam satu `group_jid`, memiliki creator, bounded title, visibility (`private|public`), lifecycle (`open|paused|closed|expired`), revision CAS, dan expiry. Private scene hanya dapat dilihat creator atau participant aktif; public scene dapat dilihat anggota grup yang mengirim command, tetapi status detail tetap tidak membeberkan raw JID. Semua query menjadikan `(group_jid, scene_id)` sebagai predicate utama.

## Lifecycle and ownership

`open` membuat scene dan otomatis menambahkan creator sebagai participant `owner` dengan mode `ooc`. `join` adalah participant opt-in; rejoin menghapus consent lama sehingga consent baru harus diberikan secara eksplisit. `leave` menandai participant left dan menonaktifkan consent aktif. Creator dapat `pause`, `resume`, dan `close`; CAS revision mencegah stale transition. Expiry otomatis mengubah scene open/paused menjadi expired pada access/operation, tanpa menghapus history.

IC/OOC adalah presentation metadata, bukan permission. Participant aktif dapat mengubah mode melalui `!ic` atau `!ooc`; mode tidak memperluas visibility, tidak memberi access ke private scene, dan tidak mengesahkan action. Consent disimpan per `(scene_id, user_jid, action)` dengan enabled dan `expires_at`; `off` menghapus effective consent, expiry membuatnya tidak aktif, dan action identifier divalidasi sebagai safe identifier.

## Commands and boundaries

`!scene` menampilkan scene visible. `!scene open <title> [public|private] [ttl=<minutes>]`, `join`, `leave`, `status`, `pause`, `resume`, dan `close` seluruhnya text-only. `!ic <sceneId>`, `!ooc <sceneId>`, `!pause <sceneId>`, dan `!consent <sceneId> <action> <on|off> [minutes]` adalah convenience commands. Feature flag `group.scene.core` default-off dan diubah hanya melalui admin command `!setscene on|off`.

## Security and privacy

JID divalidasi di service, tetapi audit melewati guardrail hashing dan metadata hanya menyimpan bounded status/count/enum. Scene title dan action input tidak masuk audit. Tidak ada passive recent-chat capture, quoted text ingestion, raw WhatsApp key mutation, message deletion, atau implicit consent. A user cannot query a private scene by guessing an ID from another group because group scope and participant visibility are checked together.

## Failure and rollback

Invalid state, expired scene, nonparticipant, cross-group ID, stale revision, malformed TTL, invalid action, and consent withdrawal fail closed with text fallback. SQLite migration hanya membuat tabel additive dan tidak mengubah R3/R4 tables. Rollback ke artifact sebelumnya tetap aman karena binary lama tidak membaca tabel baru. Restart reopens persistent rows and no process timer is required; expiry is evaluated on access, avoiding leaked intervals.

## Verification plan

Focused tests must cover default-off, two-scene isolation, private/public visibility, join/leave/rejoin consent reset, IC/OOC metadata-only behavior, creator lifecycle, CAS stale transition, expiry, consent on/off/expiry, cross-group ID rejection, audit redaction, plugin permission fallback, and service restart persistence. Full CI, sanitized artifact, Panel deployment, and smoke test remain independent gates.
