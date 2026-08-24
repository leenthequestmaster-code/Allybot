# Allybot Batch Update Roadmap — Revised

## Tujuan dan koreksi baseline

Roadmap ini disusun ulang berdasarkan audit source Allybot terkini, bukan berdasarkan daftar fitur LastAlly. Fitur hanya dimasukkan jika belum tersedia sebagai command, event, service, atau workflow yang aktif dan terdaftar pada `src/index.ts`.

Allybot saat ini sudah memiliki plugin menu, native quick reply dengan pagination dan fallback, Group Setup Mission, Group Configuration, Group Foundation, Welcome/Leave event, serta AFK service dan plugin. Karena itu fitur-fitur tersebut **tidak menjadi kandidat batch baru**.

Baileys upstream menyediakan typed events untuk pesan, perubahan koneksi, participant grup, presence, calls, contacts, dan chat, serta dukungan pesan seperti polls, reactions, locations, contacts, media, dan group management [1] [2]. Capability ini dapat menjadi sumber ide baru, tetapi setiap fitur tetap harus divalidasi terhadap API `WhatsAppPort` Allybot dan dukungan client WhatsApp nyata.

## Fitur yang sudah ada dan dikeluarkan dari roadmap

| Fitur | Bukti implementasi | Status |
|---|---|---|
| AFK | `src/framework/plugins/afk.ts` dan `src/services/afk-service.ts` | Sudah aktif; memiliki start, auto-return, mention tracking, status, list, leaderboard, dan SQLite persistence. |
| Welcome/Leave | `src/framework/plugins/welcome-leave.ts` | Sudah aktif sebagai event add/remove dengan pesan default dan custom. |
| Konfigurasi Welcome/Leave | `setwelcome`, `clearwelcome`, `setleave`, `clearleave` di `group.ts` | Sudah aktif dan admin-only. |
| Group Setup | `group-setup-mission.ts` dan `GroupConfigurationService` | Sudah selesai; rules, welcome, leave, prefix, language, timezone. |
| Group information | `groupid`, `groupinfo`, `membercount`, `admins`, `members`, `memberinfo`, `link`, `role`, `permissions` | Sudah aktif. |
| Group configuration | `rules`, `ruleshistory`, `setrules`, `clearrules`, `groupsettings`, `prefix`, `setprefix`, `setlanguage`, `settimezone` | Sudah aktif. |
| Menu | `menu.ts` | Sudah aktif; native main-menu button, pagination, text submenu, Coming Soon, callback, expiry, dan fallback. |
| Diagnostics | `diagnostics.ts` dan command `diag`/`diagnostics`/`health` | Sudah aktif sebagai health/diagnostic surface. |

## Capability gap yang benar-benar terkonfirmasi

| Gap | Bukti audit | Prioritas |
|---|---|---:|
| Warning dan moderation ledger | Tidak ada command `warn`/`warning` yang terdaftar | P0 |
| Anti-link dan anti-spam | Tidak ada event/plugin anti-link atau anti-spam | P0 |
| Group moderation actions | Tidak ada command add/kick/promote/demote/mute/lock yang terdaftar; `WhatsAppPort` saat ini baru menyediakan metadata dan invite link | P0 |
| Voting/poll workflow | Tidak ada command/event poll atau voting | P1 |
| Reminder/scheduled task user-facing | Tidak ada command reminder yang terdaftar | P1 |
| RPG/economy/inventory | Tidak ada command wallet, bank, inventory, item, atau economy | P1 |
| AI assistant | Tidak ada integrasi AI pada source runtime | P1 |
| Search/information integrations | Tidak ada GitHub, currency, search provider, atau knowledge command | P2 |
| Media processing commands | Tidak ada sticker generator, conversion, atau downloader command | P2 |
| Moderation analytics | Diagnostics ada, tetapi belum ada warning history, action history, heatmap, atau group moderation report | P2 |
| Presence/call/privacy utilities | Transport belum mengekspos workflow user-facing untuk presence, call policy, atau privacy controls | P3 |

## Roadmap batch yang direvisi

| Batch | Fokus | Fitur baru | Prioritas | Risiko | Dependency |
|---|---|---|---:|---:|---|
| **Batch 1** | Group Safety | Warning system, anti-link, anti-spam dasar, moderation audit log | P0 | Menengah | EventBus, SQLite, permission, additive transport methods |
| **Batch 2** | Group Moderation Actions | Add/remove, promote/demote, mute/lock group, moderation policy | P0 | Menengah–tinggi | Perlu perluasan `WhatsAppPort`, admin/bot-admin policy, idempotency |
| **Batch 3** | Interaction & Productivity | Poll/voting, reminder, scheduled notification, user-owned cancellation | P1 | Menengah | Mission/operations/session layer, scheduler policy, SQLite |
| **Batch 4** | RPG Foundation | Registration, profile, wallet, daily reward, reputation/points | P1 | Menengah | Transactional SQLite repository, cooldown, idempotency |
| **Batch 5** | RPG Economy & Inventory | Transfer, bank operations, inventory, storage, items, ledger | P1 | Tinggi | Batch 4, transaction invariants, audit ledger |
| **Batch 6** | AI & Knowledge | AI assistant, GitHub search, currency converter, configurable provider adapter | P1 | Menengah | Integration service, timeout, rate limit, schema validation |
| **Batch 7** | Media | Sticker, image conversion, video-to-audio, quote/watermark image | P2 | Tinggi | Media worker, size/duration limit, temporary cleanup |
| **Batch 8** | External Downloaders | TikTok, Instagram, Pinterest, YouTube, provider abstraction | P2 | Tinggi | URL policy, SSRF guard, provider adapter, resource limits |
| **Batch 9** | Advanced WhatsApp Utilities | Presence indicator, call policy, contact sender, album sender, privacy helpers | P3 | Menengah–tinggi | Verify upstream API, additive transport contract, live client test |

## Batch 1 — Group Safety

Batch pertama yang paling direkomendasikan adalah Group Safety karena capability gap-nya jelas dan manfaatnya langsung untuk group. Welcome/Leave dan AFK tidak disentuh lagi; batch ini fokus pada behavior baru.

Warning system harus menyimpan target, actor, group, reason, timestamp, expiry, dan action history. Command minimal dapat berupa `warn`, `warnings`, dan `unwarn`, tetapi nama final ditentukan saat contract design. Warning tidak boleh langsung menyebabkan kick tanpa policy eksplisit. Semua operasi harus idempotent terhadap message ID.

Anti-link harus memiliki allowlist/denylist yang jelas, pengecualian owner/admin, pengecekan bot admin, dan mode dry-run sebelum delete action diaktifkan. Anti-spam tidak boleh menghukum berdasarkan satu pesan; policy awal harus memiliki threshold, time window, cooldown, dan audit event.

Batch ini kemungkinan memerlukan `WhatsAppPort` additive method untuk menghapus pesan, tetapi method tersebut harus memiliki timeout, error classification, dan permission context. Tidak boleh memakai raw socket dari plugin.

**Gate Batch 1:** permission matrix test, warning persistence test, duplicate-message test, expiry test, anti-link allowlist test, anti-spam threshold test, admin exemption test, bot-admin failure test, audit-log assertion, typecheck/build/parity, CI, dan group smoke test.

## Batch 2 — Group Moderation Actions

Allybot memiliki metadata grup dan invite link, tetapi belum mengekspos operasi administrasi participant atau group setting melalui `WhatsAppPort`. Karena itu Batch 2 harus dimulai dengan contract design dan transport adapter, bukan langsung menulis command.

Candidate command meliputi add participant, remove participant, promote, demote, mute group, unmute group, lock group, dan unlock group. Semua operasi harus memeriksa pengirim admin, bot admin, target valid, target bukan owner bot, dan status terkini sebelum action. Retry harus aman dan hasil action harus dijelaskan kepada user.

## Batch 3 — Interaction & Productivity

Voting/poll dapat dibuat sebagai Mission Engine dengan owner, expiry, pilihan, pencegah double vote, close command, dan hasil agregat. Baileys mendokumentasikan poll vote updates yang membutuhkan message retrieval untuk dekripsi/aggregation [1]. Reminder harus menggunakan operations/scheduler layer dengan ownership, cancellation, timezone, persistence, dan recovery setelah restart; bukan `setTimeout` lepas.

## Batch 4 dan 5 — RPG, Economy, dan Inventory

RPG merupakan fitur besar yang tidak ada di Allybot sekarang. Batch 4 harus membangun model user/profile/wallet dan daily reward terlebih dahulu. Batch 5 baru menambahkan transfer, inventory, storage, item, dan ledger.

Semua perubahan saldo dan item harus atomik. Invariant minimal meliputi saldo tidak negatif, transfer tidak boleh menggandakan atau menghilangkan saldo, reward tidak bisa diklaim dua kali, dan operasi retry tidak boleh menghasilkan item ganda. SQLite transaction serta audit ledger wajib menjadi bagian dari design, bukan tambahan belakangan.

## Batch 6 — AI dan Knowledge Integrations

AI assistant, GitHub search, dan currency converter tidak ada pada Allybot saat ini, tetapi implementasinya harus melalui integration service. Setiap provider perlu timeout, AbortController, retry terbatas, rate limit, batas input/output, response schema validation, provider failure fallback, dan secret-safe error handling. API key tidak boleh masuk ke URL log atau pesan error.

## Batch 7 dan 8 — Media dan Downloader

Media processing dan downloader ditempatkan setelah fitur core karena risiko resource dan dependency lebih tinggi. Semua job harus memiliki size limit, MIME verification, duration limit, concurrency cap, timeout, temporary directory, cleanup `finally`, dan observable failure. Downloader wajib memiliki URL parser dan SSRF policy; tidak cukup memakai substring check terhadap domain.

## Batch 9 — Advanced WhatsApp Utilities

Presence, call policy, privacy helpers, contact sender, dan album sender baru dikerjakan bila ada use case yang jelas. Baileys upstream memang mengekspos event presence/call dan berbagai message type [1] [2], tetapi masing-masing perlu compatibility test terhadap client WhatsApp nyata dan tidak boleh diasumsikan stabil hanya karena tipe API tersedia.

## Definition of Done setiap batch

Batch hanya dianggap selesai jika setiap fitur memiliki command/event contract, permission matrix, input validation, ownership dan expiry bila stateful, timeout/resource policy, structured logging tanpa secret, regression test, typecheck, build, platform parity, CI artifact, deployment verification, dan production smoke test.

Deployment tidak boleh mengunggah `.env`, database, auth, atau session. Perubahan harus masuk melalui commit, CI, sanitized artifact, dan rollback path. Fitur yang gagal smoke test tidak boleh ditinggalkan dalam keadaan setengah aktif.

## Rekomendasi keputusan

Roadmap lama harus dianggap **deprecated** karena memasukkan Welcome/Leave dan AFK yang sudah ada. Roadmap revised ini menjadi baseline baru. Batch pertama yang paling tepat adalah **Batch 1 — Group Safety**, tetapi implementasi belum dimulai sampai command contract, policy warning, dan transport capability delete-message disepakati.

## References

[1]: https://baileys.wiki/concepts/events — Baileys official event model, message batches, group participant updates, polls, presence, and call events.
[2]: https://baileys.wiki/introduction — Baileys official capability overview for messages, media, groups, privacy, presence, and real-time events.
