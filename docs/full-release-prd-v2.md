# Allybot Full Release PRD v2

**Status:** Scope freeze baru setelah koreksi definisi full release  
**Tanggal:** 23 Agustus 2026  
**Owner:** Allybot maintainers  
**Target:** Full release general/community/roleplay-social yang benar-benar berisi, bukan sekadar fondasi atau curated snapshot.

## 1. Product outcome

Pengguna grup harus dapat menemukan dan memakai kemampuan Allybot yang sudah dibangun tanpa membaca source atau menebak nama command. Admin harus memiliki workflow group, moderation, governance, collaboration, event, knowledge, dan personalization yang terlihat jelas. Pengguna umum harus memperoleh utility, fun, AI, dan roleplay sosial yang praktis. `!menu` harus informatif sekaligus interaktif melalui format **semi-button**: body teks yang menjelaskan isi dan status, ditambah tombol navigasi; tombol tidak menggantikan command yang memerlukan parameter.

## 2. Definisi full release v2

Full release v2 tercapai ketika seluruh surface general yang dipilih di dokumen ini telah memiliki implementasi nyata, output user-facing, permission, validation, persistence/data ownership, failure handling, tests, documentation, CI artifact, deployment, dan recovery evidence. Semua command yang tampil sebagai `READY` harus berasal dari registry runtime aktual. Fitur `FEATURE-GATED`, `CONDITIONAL`, `OWNER-ONLY`, atau `DEFERRED` tidak boleh disamarkan sebagai ready.

Katalog 512 baris tetap menjadi sumber ide dan backlog, bukan daftar implementasi otomatis. RPG penuh, World Database, Mission Platform lanjutan, Autospam Detection aktif, dan multi-instance worker tidak dimasukkan diam-diam karena memiliki model data, concurrency, abuse, dan recovery yang berbeda. Track tersebut tetap dipelihara sebagai PRD terpisah sampai kontraknya disetujui.

## 3. Scope Must v2

| ID | Kontingen | Scope release |
|---|---|---|
| M2-01 | Menu and discovery | Semi-button main menu dengan body informatif, native quick-reply navigation, text fallback, numeric fallback, pagination, actor-aware privileged visibility, `!commands`, dan `!searchcmd`. |
| M2-02 | Group | Seluruh command Group existing yang sudah terdaftar, copy Indonesia yang mudah dipahami, status feature-gate yang jelas, dan compatibility aliases yang sudah ada. |
| M2-03 | Moderation/Governance | Safety, warning/case/appeal, guarded action, join request, invite safety, retcon, handoff, continuity; seluruh operasi admin-gated, bot-admin checked, bounded, auditable, dan reversible bila memungkinkan. |
| M2-04 | Community/Productivity/Event | Collaboration, announcement, onboarding, poll/vote, reminder, task, decision, agenda, event, calendar; scheduler restart-safe, duplicate-safe, dan menampilkan status yang tidak ambigu. |
| M2-05 | Knowledge/Roleplay foundation | Explicit knowledge, quote/bookmark/source/forget/export, Canon/Lore, scene lifecycle, IC/OOC, scene consent, dan command copy yang tidak mengaktifkan passive full-chat memory. |
| M2-06 | Personal | AFK dan personalization/policy command existing, dengan pemisahan jelas antara preference personal dan policy grup. |
| M2-07 | Tools/System | Ping, health/diag bila enabled, bot profile, owner profile aman, privacy/support/about/version, bounded command index/search, calculator, unit/time/date utilities. |
| M2-08 | Fun | `!random`, `!choose`, `!flip`, `!roll`, dan minimal satu response game ringan seperti `!8ball`, semuanya deterministic-boundary atau cryptographically safe random sesuai kebutuhan, input bounded, tanpa external dependency. |
| M2-09 | AI | `!ai`/`!ally` existing hanya tampil READY jika provider flag dan key tersedia; otherwise tampil FEATURE-GATED. Input/output bounded, rate-limited, no passive memory, safe error. |
| M2-10 | Media | Hanya command yang dapat dibangun dengan dependency dan resource budget yang benar-benar tersedia. Prioritas awal `!sticker`, `!toimg`, atau `!toaudio` dipilih setelah dependency/runtime audit; tidak boleh menjanjikan converter yang belum memiliki pipeline. |
| M2-11 | Release operations | CI sanitized artifact, checksum, deployment, controlled reload, recovery rehearsal, command/catalog/docs parity, rollback runbook, dan residual-risk decision. |

## 4. Should and Could

Fitur baru yang bernilai tetapi tidak boleh menghambat Must v2 adalah `!feedback`/`!suggest` bounded, `!messageinfo` safe reply metadata, roleplay `!character`/`!mood`/`!emote`, selective metrics, dan media enhancement. Kandidat ini masuk setelah fondasi existing diangkat ke menu dan memiliki owner/data contract.

`!yt2mp3`, `!tomp3`, `!togif`, `!brat`, `!tomeme`, `!upscale`, `!hd`, downloader social, OCR, transcription, dan TTS memerlukan audit dependency, binary, file-size/duration limit, egress policy, license, cleanup, dan artifact manifest. Mereka tidak akan dipalsukan sebagai command yang sekadar mengirim placeholder.

## 5. UX contract menu semi-button

Main menu harus mengirim body teks yang memuat identitas Allybot, ringkasan halaman, daftar kategori pada halaman aktif, jumlah command atau status `FEATURE-GATED`/`COMING SOON`, petunjuk penggunaan command, dan fallback `!menu <angka>`. Native quick replies menjadi tombol navigasi kategori dan pagination. Callback hanya mengubah navigasi; command tetap dieksekusi melalui `CommandRegistry` dan permission middleware.

Submenu tetap text-first agar command beserta contoh pemakaian, permission marker, dan parameter dapat dibaca. Tombol submenu hanya boleh ditambahkan jika ada kebutuhan nyata, contract Baileys pinned, dan tidak membuat command berulang lebih sulit. Saran `location`, `contextInfo rows`, dan auto-category menjadi compatibility spike terpisah, bukan bagian dari perubahan transport utama.

## 6. Quality and security acceptance

Setiap slice wajib membuktikan positive path, invalid input, permission denial, unavailable dependency, duplicate/retry behavior jika asynchronous, persistence/restart jika stateful, bounded output, audit outcome yang valid, dan no raw secret/JID/message in logs or output. Domain baru harus tetap memakai SQLite runtime store dan tidak membuat transaksi lintas Neon/Supabase/Redis.

Admin action harus fail closed ketika metadata actor atau bot-admin tidak dapat diverifikasi. External provider wajib memiliki timeout, bounded retry, rate limit, URL validation bila menerima URL, file/memory quota bila memproses media, dan safe error classification. Tidak boleh ada shell/eval/exec/arbitrary SQL dari chat.

## 7. Release batch order

| Batch | Tujuan | Exit criteria |
|---|---|---|
| V2-A | Semi-button menu, command index/search, utility/fun dasar | Body text benar-benar muncul bersama buttons; fallback and pagination pass; calculator tidak memakai eval; tests pass. |
| V2-B | Promote Group, Moderation, Governance | Semua existing command mapped; permission/case/join/invite negative tests pass; copy/help consistent. |
| V2-C | Promote Community, Productivity, Event, Knowledge | Existing services exposed; scheduler/restart/idempotency tests pass; no stale Coming Soon label. |
| V2-D | Personal and roleplay-social completion | AFK/personalization/scene/canon/knowledge coherent; consent and tenancy tests pass. |
| V2-E | AI, safe media, and additional original utilities | Provider/dependency/resource audit pass; feature-gated status accurate; no placeholder. |
| V2-F | Full surface reconciliation and release rehearsal | Catalog/source/menu/help/docs parity; artifact/deploy/reload/recovery/rollback evidence pass. |
| V2-G | Final release decision | Must v2 complete; `completed` only with required live acceptance, otherwise explicit `completed_with_caveat`. |

## 8. Success metrics

| Metric | Minimum |
|---|---:|
| Existing registered command families represented in menu/help | 100% of non-internal, non-hidden commands |
| Menu native body contains explanatory content | 100% native main-menu sends |
| Main-menu interaction fallback | Text fallback and numeric navigation both pass |
| Permission-sensitive command negative tests | 100% selected admin/owner/developer paths |
| Stateful batch restart coverage | Every feature with scheduler or persistence has restart test |
| Artifact integrity | CI checksum pass and temporary archive cleanup |
| Sensitive-data violations | 0 known violations in source/test/artifact review |
| Unimplemented commands shown as READY | 0 |

## 9. Rollback and acceptance policy

Setiap batch dikomit terpisah dan dapat direvert tanpa menghapus historical audit atau chat-log. Optional feature menggunakan default-off/per-group gate ketika dependency atau operational evidence belum siap. Jika live WhatsApp acceptance belum tersedia, hasil akhir boleh disebut `completed_with_caveat`, tetapi tidak boleh disebut fully proven production behavior.

## 10. Immediate execution decision

Langkah eksekusi pertama adalah V2-A karena langsung memperbaiki keluhan utama pengguna dan membuka semua kontingen yang sudah existing. Setelah V2-A lulus, batch berikutnya tidak akan berhenti pada menu: source plugin yang sudah nyata akan diangkat ke menu/help, lalu gap command general yang aman diisi, dan setiap batch akan melewati CI artifact-only serta release gates.

**Author:** Manus AI

## 11. V2-A implementation checkpoint

V2-A telah diimplementasikan bertahap pada commit `d932d51` dan `b899996`. Main menu native sekarang mengirim body teks informatif bersama tombol kategori/pagination, dengan text/numeric fallback tetap tersedia. Registry menerima nama command aman yang diawali angka sehingga `!8ball` dapat dipakai sesuai katalog.

Surface baru yang benar-benar terdaftar adalah `!commands`, `!searchcmd`, `!about`, `!version`, `!privacy`, `!support`, `!status`, `!uptime`, `!features`, `!calc`, `!convert`, `!time`, `!date`, `!random`, `!choose`, `!flip`, `!roll`/`!dice`, dan `!8ball`. Calculator menggunakan parser aritmetika terbatas; tidak ada `eval`, shell, atau arbitrary code execution. Permainan dibatasi pada input, rentang, jumlah opsi, dan cooldown.

Verification checkpoint setelah discovery update: typecheck pass, clean build pass, menu/utility tests pass, full regression `280/280` pass, dan runtime dependency audit pada high threshold `0 vulnerability`. CI/artifact deployment berikutnya tetap wajib dijalankan setelah commit checkpoint ini.

## 12. V2-B compatibility checkpoint

V2-B menambahkan alias ramah pengguna tanpa mengganti canonical command. Alias yang tersedia antara lain `collabmode`, `pollmode`, `catatan`, `tersimpan`, `exportcatatan`, `cerita`, `adegan`, `moderate`, `takecase`, `handover`, `cekcatatan`, `joinlist`, `prefs`, `balasan`, dan `tanya`. Setiap alias mengarah ke handler, permission, cooldown, validation, audit, dan persistence yang sama dengan command lama.

Contract test alias lulus dan full regression terbaru adalah `282/282` pass. Dependency audit runtime pada high threshold tetap menghasilkan `0 vulnerability`. Alias tidak mengubah database schema, feature flag, transport, atau storage boundary.

## 13. V2-C roleplay social checkpoint

V2-C menambahkan roleplay sosial bounded melalui `!character`/`!char` dan `!mood`. Pengguna dapat membuat, melihat, membuat daftar, mengubah, dan mengarsipkan character miliknya pada scope grup; mood hanya dapat diubah oleh pemilik character aktif. Deskripsi dan nama dibatasi panjangnya, hanya tiga character aktif per pemilik per grup, profile tidak ikut masuk metadata audit, dan pengarsipan mempertahankan row historis sebagai `retired`.

Character memakai SQLite domain file terpisah, WAL, busy timeout, transaksi `immediate` pada create untuk menjaga batas concurrent, serta dependency `platform-guardrail` untuk audit. Tidak ada passive chat capture, Neon write, Redis state, atau perubahan schema database utama.

Service, command integration, persistence, ownership, soft-retire, dan audit tests lulus. Full regression checkpoint lokal setelah V2-C: `285/285` pass; runtime dependency audit high threshold: `0 vulnerability`. CI/artifact sync wajib dilakukan pada commit V2-C.

## 14. V2-D community discoverability checkpoint

V2-D menambahkan alias lokal untuk surface yang sudah memiliki handler matang: `jajak` untuk poll, `ingatkan` untuk reminder, `tugas` untuk task, `putuskan` untuk decision, `acara` untuk event, `kalender` untuk calendar, `pengumuman` untuk announce, dan `usul` untuk suggestion relay. Alias hanya memperbaiki discoverability; consent, admin gate, feature toggle, queue/dispatcher, persistence, dan audit tetap memakai implementation existing.

Full regression setelah V2-D lulus `285/285` dan runtime dependency audit tetap `0 vulnerability`. Artifact sync CI wajib dijalankan pada commit V2-D.
