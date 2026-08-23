# Allybot Full Release Re-baseline v2

**Tanggal:** 23 Agustus 2026  
**Status:** Working execution baseline setelah koreksi definisi full release oleh pengguna  
**Source of truth:** Source runtime, test suite, CI artifact, dan kontrak produk yang disetujui.

## 1. Perubahan definisi release

Snapshot sebelumnya hanya layak disebut **curated release with caveat**. Itu tidak memenuhi maksud pengguna karena sebagian kontingen yang sudah direncanakan belum diisi dan `!menu` masih berorientasi button-only.

Untuk baseline baru ini, **full release** berarti surface general Allybot yang telah direncanakan harus memiliki implementasi nyata, command contract, permission, validation, persistence atau batas data yang jelas, failure behavior, test, dokumentasi, dan artifact deployment. Menu juga harus menjadi **semi-button**: pesan teks yang informatif menjadi sumber penjelasan, sementara tombol menjadi navigasi cepat. Tombol tidak menggantikan command yang membutuhkan input berulang atau parameter.

Full release tidak berarti menyalin seluruh baris katalog kemungkinan secara membabi buta. Command yang membutuhkan provider, binary, credential, data model besar, atau acceptance yang belum tersedia tetap masuk batch dengan guardrail dan status yang jujur. RPG penuh, World Database besar, Mission Platform lanjutan, dan Autospam Detection destruktif tetap diperlakukan sebagai track berisiko tinggi yang tidak boleh diselundupkan ke general release tanpa kontrak baru.

## 2. Repository ground truth

| Evidence | Observed fact | Consequence |
|---|---|---|
| Plugin source | Terdapat 22 file plugin aktif di `src/framework/plugins`. | Surface sudah modular; ekspansi harus mengikuti plugin/service boundary yang ada. |
| Command registration | Terdapat 101 pemanggilan `context.commands.register`. | Banyak capability nyata sudah ada tetapi belum seluruhnya dipetakan ke menu dan release surface. |
| Product catalog | `command-catalog.md` memiliki 512 baris dan berisi ide/backlog, bukan source of truth runtime. | Catalog harus direkonsiliasi dengan source, bukan langsung diimplementasikan seluruhnya. |
| Runtime composition | `src/index.ts` mendaftarkan Group, Moderation, Governance, Collaboration, Knowledge, Personalization, Scene, Canon, Event, Onboarding, Announcement, AI, dan diagnostics secara modular. | Prioritas pertama adalah mengisi dan mengekspos kontingen existing sebelum menambah sistem baru. |
| Storage | SQLite WAL tetap primary runtime store; service domain sudah terpisah. | Fitur baru harus memakai service SQLite yang bounded; tidak ada migrasi PostgreSQL umum. |
| External state | Neon consent-aware untuk chat-log dan Redis optional untuk operational state. | Jangan memakai Neon/Redis sebagai generic domain database. |
| Feature flags | AI, diagnostics, Neon, Redis, dan beberapa domain workflow memakai default-off atau per-group gate. | “Sudah diimplementasikan” dan “aktif pada semua grup” adalah status yang berbeda. |
| Delivery | CI artifact-only telah lulus checksum dan Panel sync. | Setiap vertical slice tetap wajib melalui CI, sanitized artifact, checksum, dan controlled reload/canary. |

## 3. Kontingen yang sudah nyata tetapi belum sepenuhnya diperlakukan sebagai release surface

| Kontingen publik | Capability yang sudah terlihat di source | Status re-baseline |
|---|---|---|
| `GROUP` | Group info, member/admin listing, rules, rules history, welcome/leave, prefix, language, timezone, role, permissions, group setup, chat-log consent. | Existing; perlu command copy dan menu exposure yang lengkap. |
| `MODERATION` | Safety mode, warning, warnings, clear warning, report, cases, case, claim, appeal, guarded moderation action, group mode, status. | Existing; perlu consistency check, output copy, dan acceptance per operation. |
| `GOVERNANCE` | Retcon proposal, moderator handoff, continuity, join requests, join approval/rejection, invite inspection/revoke. | Existing dan cukup kaya; perlu ditempatkan sebagai subsection Moderation. |
| `COMMUNITY / PRODUCTIVITY` | Announcement, onboarding, collaboration status/toggle, poll/vote, reminders, tasks, decisions, agenda. | Existing; perlu diekspos sebagai Community/Group workflow, bukan dianggap Coming Soon. |
| `EVENT` | Multi-phase event, calendar, create/publish/join/leave/status/recap/phase/pause/resume/close, poll/location text fallback. | Existing; perlu dipetakan sebagai subsection Community dan diuji dengan scheduler/recovery. |
| `ROLEPLAY / KNOWLEDGE` | Scene lifecycle, IC/OOC, consent, Canon/Lore, explicit quote/bookmark/source/forget/export. | Existing; perlu semi-button navigation dan copy yang mudah dipahami. |
| `PERSONAL` | AFK, personalization status/toggle, preferences, language/timezone, quiet, notification, verbosity, format. | Existing; perlu memisahkan personal command dari admin group policy pada menu. |
| `TOOLS / SYSTEM / AI` | Ping, health/diag, bot profile/owner profile, AI query, translation/summary direct-request, suggestion relay, cache control. | Implemented with AI provider gate; AI tetap default-off bila provider tidak aktif. |
| `FUN` | Utility random/choose/flip/roll/8ball dan truth/dare/RPS bounded. | Implemented; tidak memakai storage atau external provider. |

## 4. Gap fitur general yang harus diisi

### Wave A — discoverability and utility

Wave ini menyelesaikan menu semi-button informatif, command index/search yang bounded, dan utility ringan yang tidak membutuhkan provider eksternal. Kandidat prioritas adalah `!commands`, `!searchcmd`, `!about`, `!version`, `!privacy`, `!support`, `!calc`, `!convert`, `!time`, `!date`, `!random`, `!choose`, `!flip`, dan `!roll`. Ekspresi matematika harus memakai parser terbatas, bukan eval atau shell. Semua output harus memiliki batas panjang dan cooldown yang sesuai.

### Wave B — community workflow completion

Wave ini mengangkat Collaboration, Event, Onboarding, Announcement, Knowledge, dan Personalization menjadi capability yang mudah ditemukan. Perubahan utamanya adalah mapping menu, command copy Indonesia, help per domain, status feature-gate yang jelas, dan recovery tests untuk reminder/event. Tidak boleh membuat wrapper yang hanya meniru fitur native WhatsApp tanpa persistence, lifecycle, audit, atau consent value.

### Wave C — safe moderation completion

Wave ini menyelesaikan jalur yang sudah memiliki service dan command tetapi belum memiliki acceptance yang seragam: warning/case/appeal, guarded moderation action, join request, invite safety, retcon, handoff, dan continuity. Tindakan eksternal harus tetap admin-gated, bot-admin checked, idempotent bila relevan, dan tidak berubah menjadi mass messaging atau auto-kick tanpa explicit policy.

### Wave D — roleplay social completion

Wave ini mengisi general roleplay tanpa RPG: profile karakter bounded, mood/status sosial yang consent-aware, emote atau scene helper yang tidak menyimpan passive full-chat memory, serta sinkronisasi Canon/Lore/Knowledge. Semua data tetap group-scoped atau user-owned, dengan delete/forget policy dan audit history yang tidak dihapus sembarangan.

### Wave E — media and AI utility

Wave ini hanya memasukkan media operation yang memiliki runtime dependency, ukuran/durasi limit, cleanup, dan artifact allowlist yang terverifikasi. AI tetap direct-request, bounded, rate-limited, provider-failure-safe, dan default-off bila credential/provider belum terpasang. Download eksternal dan converter besar tidak boleh digabung ke satu batch tanpa provider, license, timeout, dan resource evidence. Bounded transport pertama kini mencakup `!sticker`, `!toimg`, `!togif`, dan `!toaudio`; downloader URL, upscale besar, dan converter arbitrer tetap deferred.

### Wave F — optional high-risk tracks

RPG economy/combat, World Database PostgreSQL, Mission Platform orchestration, Autospam Detection aktif, distributed queue workflow, dan multi-instance worker memiliki kontrak data, concurrency, recovery, dan operational burden yang berbeda. Track ini akan dipersiapkan sebagai PRD/alpha terpisah; tidak disamarkan sebagai general feature selesai hanya demi menaikkan jumlah command.

## 5. Urutan implementasi baru

| Urutan | Slice | Exit criteria |
|---:|---|---|
| R4 | Menu semi-button + utility index/fun dasar | Informative text + buttons, text fallback, numbered navigation, actor visibility, `!commands`/`!searchcmd`, utility safety tests. |
| R5 | Community/Productivity/Event exposure and recovery | Existing workflows tampil dan terdokumentasi; scheduler restart/idempotency tests pass; no duplicate reminder/event action. |
| R6 | Moderation/Governance completion | Negative permission tests, bot-admin recheck, case/audit invariants, safe failure and rollback. |
| R7 | Roleplay social completion | User/group tenancy, consent, history, deletion/forget semantics, scene/canon/knowledge integration. |
| R8 | Media/AI bounded utilities | Dependency/artifact review, resource limits, timeout, cleanup, provider failure tests, default-off behavior. |
| R9 | Full surface reconciliation | Catalog/source/menu/help/docs parity; no command listed as ready without implementation. |
| R10 | Recovery and deployment rehearsal | CI artifact, checksum, controlled reload, dependency outage fallback, SQLite recovery, rollback rehearsal. |
| R11 | Final release decision | All selected Must slices pass; status is `completed` only if required live acceptance exists, otherwise explicit caveat. |

## 6. Hard constraints

Perubahan tetap harus mempertahankan command sebagai primary interface. Semi-button hanya memperpendek navigasi dan tidak boleh memaksa pengguna memilih tombol untuk fitur yang membutuhkan teks, target, alasan, judul, durasi, atau parameter berulang. Tidak ada arbitrary shell, SQL, eval, exec, passive full-chat memory, raw PII logging, secret exposure, mass broadcast, atau destructive moderation tanpa policy dan otorisasi.

Fitur baru harus memakai `import type { Logger } from 'pino'` jika mengimpor tipe Logger, feature flag default-off ketika external dependency belum siap, audit outcome yang valid, bounded input/output/queue, error class yang aman, dan test negatif untuk permission serta failure modes.

## 7. Open decisions and assumptions

| Item | Current decision | Confidence | Falsifier |
|---|---|---:|---|
| Semi-button format | Text body tetap dikirim bersama native quick-reply buttons; fallback text tetap tersedia. | High | Pinned Baileys contract atau live payload menunjukkan body/button incompatibility. |
| Taxonomy | Delapan kategori produk tetap dipakai; domain internal boleh dipetakan ke subsection. | High | Command surface menjadi terlalu panjang sehingga perlu pagination/subsection tambahan. |
| Native location/contextInfo | Belum diadopsi; dievaluasi sebagai compatibility spike terpisah. | High | Synthetic contract test dan pinned Baileys types membuktikan payload stabil serta memberi UX nyata. |
| Default-on versus feature-gated | Domain workflow tetap explicit enable per group bila sudah memakai persistence/scheduler; menu harus menunjukkan statusnya. | High | Produk menetapkan global activation policy baru dengan operational budget. |
| RPG/World/Mission | Tidak masuk general full-release implementation tanpa PRD delta karena kontrak dan risiko berbeda. | Medium | Pengguna secara eksplisit mengubah scope produk untuk memasukkan track tersebut. |

## 8. Release definition

Full release baru dapat dinyatakan selesai apabila Wave A–E yang dipilih pada scope freeze benar-benar memiliki implementation dan test, semua command yang tampil pada menu berasal dari registry aktual, CI artifact dan Panel deployment lulus, recovery rehearsal selesai, dan residual risk ditulis. Jika acceptance live WhatsApp masih unavailable, status harus `completed_with_caveat`; kata “full release” merujuk pada breadth implementation yang benar-benar dipilih, bukan klaim bahwa semua perilaku Baileys telah diuji.

**Author:** Manus AI

## 9. V2-A checkpoint

V2-A sudah mengisi slice pertama setelah re-baseline. Menu native kini semi-button dengan body informatif, command fallback, dan pagination. Utility/fun plugin baru mendaftarkan command discovery, status, privacy/support, calculator terbatas, konversi, waktu/tanggal, random, choose, coin flip, dice, dan 8ball. Registry command diperluas secara aman untuk nama numeric-leading seperti `8ball` dengan karakter tetap dibatasi.

Checkpoint lokal setelah slice ini: typecheck dan clean build pass; focused tests pass; full regression `280/280` pass; runtime dependency audit high threshold pass dengan 0 vulnerability. Commit source utama V2-A adalah `d932d51`, dan localization/copy checkpoint adalah `b899996`; commit discovery lanjutan menunggu validasi final/CI.

## 10. V2-B checkpoint

V2-B mengangkat discoverability kontingen existing melalui alias user-friendly yang tetap kompatibel dengan canonical names. Alias telah ditambahkan pada Collaboration, Knowledge, Canon, Scene, Moderation, Governance, Personalization, dan AI; tidak ada perubahan pada permission, data model, atau handler semantics.

Focused alias contract dan full regression terbaru lulus `282/282`; dependency audit runtime high threshold lulus dengan `0 vulnerability`. CI/artifact sync perlu dijalankan setelah commit checkpoint ini.

## 11. V2-C checkpoint

V2-C mengisi kontingen ROLEPLAY general tanpa masuk ke RPG: `!character`/`!char` untuk profil character group-scoped dan `!mood` untuk mood character aktif. Data memiliki owner check, batas profile/name/mood, maksimal tiga character aktif per owner, transactional create, dan soft-retire yang tidak menghapus history. Storage memakai SQLite domain terpisah dan audit metadata hanya memuat panjang data serta hashed reference.

Focused service/plugin tests dan full regression terbaru lulus `285/285`; dependency audit runtime high threshold lulus dengan `0 vulnerability`. File baru berada di `src` dan akan masuk artifact melalui `dist/**`; tidak ada dependency runtime baru sehingga CI/manifest allowlist tidak perlu diubah.

## 12. V2-D checkpoint

V2-D menambah alias untuk workflow yang sudah tersedia: `jajak`, `ingatkan`, `tugas`, `putuskan`, `acara`, `kalender`, `pengumuman`, dan `usul`. Tidak ada schema, dependency, transport, permission, atau service baru. Verification lokal: typecheck/build pass, full regression `285/285`, dan runtime audit high threshold `0 vulnerability`.

## 13. V2-E checkpoint

V2-E mengisi gap retrieval pada kontingen Knowledge melalui `!find`/`!cari`. Search hanya membaca catatan eksplisit yang visible pada grup, mematuhi retention, membatasi query/result, dan tidak membocorkan private record kepada anggota lain. Verification lokal: full regression `286/286`, typecheck/build pass, runtime dependency audit `0 vulnerability`.

## 14. V2-F checkpoint

V2-F mengisi FUN dengan `!truth`/`!jujur`, `!dare`/`!tantangan`, dan `!rps`/`!suit`. Prompt statis, input terbatas, output pendek, cooldown tetap aktif, dan tidak ada storage/external API. Local verification: utility tests pass, typecheck/build pass, full regression baseline `286/286`, runtime audit `0 vulnerability`. Commit `2b46b57` telah lulus CI dan sanitized artifact sync pada run `32639218671`.

## 15. V2-G checkpoint

V2-G menyelesaikan dua gap Tools/Media yang sebelumnya belum memiliki boundary nyata. AI kini memiliki `!translate`/`!terjemah` untuk teks explicit dengan format `bahasa | teks` dan `!summarize`/`!ringkas` untuk teks explicit; keduanya tetap memakai provider AI existing, cooldown, batas input/output, safe error, dan tanpa conversation memory. AI tetap hanya terdaftar ketika `XKIRO_AI_ENABLED` aktif.

Media kini memiliki `CoreMediaDescriptor` dan optional `WhatsAppPort` media contract yang tidak mengekspos raw Baileys message ke plugin. Adapter memetakan direct, quoted, dan view-once metadata, memakai stored message untuk bounded download stream, re-upload callback resmi Baileys, timeout/abort, pre-download size guard, MIME validation, fixed-argument ffmpeg tanpa shell, output cap, dan cleanup. Command nyata yang tersedia adalah `!sticker`/`!stiker`, `!toimg`/`!togambar`, `!togif`/`!gif`, dan `!toaudio`/`!audio`. `!togif` dikirim sebagai MP4 dengan playback flag karena WhatsApp tidak mengirim file GIF secara langsung.

Verification lokal V2-G: typecheck pass, clean build pass, 13 focused media tests pass, real ffmpeg smoke test pada fixture sintetis pass, full regression `302/302` pass, runtime dependency audit high threshold `0 vulnerability`, dan `git diff --check` pass. CI/artifact sync pada run `32640752984` sukses sampai checksum Panel; live WhatsApp media acceptance masih belum dilakukan dan tidak diklaim.

## 16. V2-H checkpoint

V2-H menyelesaikan roleplay-social text surface dengan `!emote`/`!aksi`. Command ini group-only, menerima aksi singkat maksimal 160 karakter, menormalkan whitespace, menghapus markup presentasi, tidak menyimpan state, tidak menangkap passive chat, dan tidak menampilkan identitas raw pengguna. Help Character juga sudah mencantumkan emote.

Decision brief `docs/deferred-high-risk-tracks-v2.md` memisahkan RPG penuh, Mission Platform, World Database besar, active Autospam Detection, dan multi-instance worker dari general full release. Pemisahan ini disengaja untuk menjaga release surface tetap jujur dan mencegah schema/worker/moderation behavior spekulatif.
