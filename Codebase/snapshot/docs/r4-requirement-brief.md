# R4 Privacy-first Knowledge — Requirement Brief

## Outcome

R4 membuat pengetahuan Allybot hanya berasal dari pesan yang dipilih secara sengaja melalui reply/bookmark. Bot tidak membaca histori chat secara pasif, tidak menganggap semua pesan sebagai canon, dan tidak memakai WhatsApp star/pin sebagai storage utama.

## Scope implemented

| Capability | Command | Behavior |
|---|---|---|
| Feature status | `!knowledge` / `!know` | Read-only status |
| Group flag | `!setknowledge on|off` | Admin-only, default-off |
| Explicit quote | `!quote` | Memantulkan quoted text secara bounded; tidak menyimpan |
| Bookmark/source creation | `!bookmark <judul> [private]` | Hanya dari explicit quoted message |
| Visible list | `!bookmarks` | Menampilkan active group-visible/private-owned records |
| Source lookup | `!source <id>` / `!sourceinfo` | Prefix harus unik dan group-scoped |
| Owner deletion | `!forget <id>` / `!knowledgeforget` | Hanya creator record |
| Export | `!knowledgeexport` / `!knowexport` | Export bounded active records yang terlihat actor |

## Data boundary

Record menyimpan group scope, creator, visibility (`group` atau `private`), bounded excerpt, excerpt hash, hashed source message/sender identifiers, source timestamp bila tersedia, retention deadline, status, dan deletion metadata. Raw message key tidak dibuat-buat; CoreMessage hanya menyediakan explicit quoted text dan optional quoted sender.

## Invariants

1. Feature flag `group.knowledge.core` default-off dan diperiksa di domain service sebelum setiap state mutation.
2. Semua lookup memakai group scope; private record hanya dapat dibaca creator.
3. Capture hanya terjadi ketika user mengirim command dengan quoted text; tidak ada `messaging-history.set` ingestion.
4. Excerpt, title, list, dan export memiliki batas ukuran; token/credential-looking content ditolak.
5. Retention mengubah active record menjadi retired; expired source tidak muncul di active lookup.
6. Delete membersihkan excerpt dan excerpt hash dari hot record serta mengeluarkan record dari export; audit hanya menyimpan bounded ID metadata.
7. Source IDs di reply hanya prefix UUID; prefix pendek/ambiguous/cross-group fail closed.
8. Button tidak digunakan; submenu tetap text-only dan seluruh command memiliki fallback teks.
9. Draft/hidden/retired source tidak masuk active lookup atau context provider.
10. Native reaction/pin/star/forward/edit/delete/read tetap defer karena full `WAMessageKey` dan account-integrity contract belum tersedia.

## Non-goals

R4 tidak menambahkan passive memory, automatic FAQ extraction, AI provider call, canon write, WhatsApp `chatModify`, global privacy mutation, broadcast, arbitrary code execution, atau RPG mechanics.
