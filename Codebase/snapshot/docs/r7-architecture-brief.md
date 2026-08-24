# R7 Architecture Brief — Canon Ledger

## Decision

CanonService memakai tabel additive `canon_entries` dan `canon_history`. Canon entry menyimpan current state; setiap create dan transition menambah history row dengan revision, action, actor, status, content hash, dan optional R4 source reference. Old canon tidak dihapus ketika ada versi baru: entry approved sebelumnya menjadi `superseded` saat entry baru dengan title sama di-approve.

## Lifecycle and authorization

Lifecycle yang valid adalah `draft → proposed → approved → superseded → retired`. `reject` mengembalikan `proposed` ke `draft` sambil menulis history, karena rejected bukan status canon retained pada roadmap. Creator dapat propose entry miliknya. Group admin dapat approve, reject, dan retire melalui command permission existing; service tetap memeriksa creator ownership untuk propose dan `(group_jid, id)` untuk setiap object operation. Approval memakai current revision in SQL predicate; dua approval concurrent hanya satu yang berhasil.

Lookup/search hanya mengembalikan `approved` entries. Draft/proposed tidak bocor ke anggota lain; creator dapat melihat entry miliknya untuk status/history, sedangkan governance commands berada di group-admin boundary. All source/title/content values are explicit command input and bounded; no chat history is searched or imported implicitly.

## Provenance boundary

CanonService memiliki dependency pada KnowledgeService. `source=<id>` pada `!canon add` hanya menyimpan reference ke explicit active R4 source yang visible pada actor dan group; canon tidak menyalin excerpt serta tidak memperlakukan source text sebagai instruction. Jika source kemudian retired/deleted, canon entry tetap menyimpan provenance reference tanpa menghidupkan kembali source.

## Query and privacy

Group scope selalu menjadi primary predicate. Search memakai parameterized bounded query; user input tidak menjadi SQL fragment. Audit metadata menyimpan status/action/revision/count dan content hash prefix, bukan raw JID, title, content, source ID, atau raw error. Operational tables menyimpan canon content karena itu adalah explicit approved community record, bukan passive memory.

## Rollback and verification

Migration additive dan tidak mengubah R4 tables. Prior artifact dapat rollback karena tidak membutuhkan tabel R7. Focused tests mencakup default-off, lifecycle, creator/admin boundaries, cross-group ID rejection, concurrent CAS approval, supersede behavior, hidden drafts, source visibility/reference, history, search conflict markers, audit redaction, and restart persistence. CI, sanitized artifact, Panel smoke, and final WhatsApp black-box acceptance remain separate gates.
