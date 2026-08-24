# Allybot Full-Release Runbook v1.0

**Status:** Active release-readiness runbook  
**Snapshot:** 23 Agustus 2026  
**Source of truth:** `main`, CI artifact, dan evidence runtime yang dapat diverifikasi.

Runbook ini digunakan untuk release candidate Allybot dengan scope terkurasi v1.0.0. Full release tidak berarti seluruh katalog ide harus tersedia. Setiap langkah harus mempertahankan SQLite sebagai runtime database utama, Neon sebagai chat-log consent-aware dan group-scoped, Supabase sebagai boundary akses PostgreSQL terpisah, serta Redis sebagai operational state ephemeral.

## 1. Safety and authorization boundary

Release hanya boleh menggunakan commit yang sudah diuji oleh CI. Jangan mengunggah source tree, `.env`, session/auth state, database, raw log, QR, token, password, raw JID, nomor telepon, atau isi pesan ke repository, attachment, atau Panel.

Deployment harus berjalan melalui sanitized artifact dari CI. Jangan mengubah Pterodactyl Startup Command, `.bash_profile` workaround, database production, Neon historical rows, atau konfigurasi secret tanpa otorisasi terpisah. Restart proses merupakan operasi material; lakukan hanya setelah operator memberikan izin untuk release candidate dan operation tersebut.

> **Aturan penting:** artifact sync memperbarui filesystem, tetapi tidak otomatis membuktikan bahwa proses Node yang sedang hidup sudah memuat build baru. Controlled reload dan bukti uptime/resource diperlukan sebelum runtime behavior dinyatakan aktif.

## 2. Release gates

| Gate | Bukti minimum | Status snapshot 23 Agustus 2026 |
|---|---|---|
| Scope | PRD v1.0, non-goals, risk register, dan command surface terdokumentasi | Pass |
| Source | Commit terpisah dan repository clean setelah docs reconciliation | Pass pada `85eb3a9` |
| Static/build | Typecheck dan clean build lulus | Pass |
| Regression | Seluruh test compiled runtime lulus tanpa assertion dilemahkan | Pass, 275/275 |
| Security | Permission negative tests, redaction, dependency audit, artifact allowlist | Pass pada gate yang tersedia; live auth belum dibuktikan |
| Persistence/recovery | SQLite restart/recovery rehearsal dan audit archive assertions | Pass secara lokal |
| Artifact | Sanitized artifact, manifest SHA-256, remote verification, archive cleanup | Pass pada CI `32631651578` |
| Runtime reload | Process reload, resource uptime reset, safe runtime checks | Reload dilakukan; full Panel command verification masih terbatas |
| Neon consent | Global flag, allowlist, per-group suppression, no historical deletion | Code/test/artifact pass; live command belum dilakukan |
| Redis | Timeout/fallback/unit/concurrency tests dan runtime verifier | Local verifier disabled; Panel flag belum dibuktikan melalui command output |
| Live WhatsApp | Acceptance pada akun dan grup test terisolasi | Deferred; jangan klaim fully proven |
| Decision | Semua Must gate atau caveat eksplisit, owner, trigger, rollback | Maksimal `completed_with_caveat` sampai live acceptance tersedia |

## 3. Pre-release source and CI procedure

1. Pastikan branch release menunjuk ke commit yang dimaksud dan `git status --short` kosong setelah semua perubahan yang relevan dikomit.
2. Jalankan `npm run typecheck`, `npm run build`, dan `npm test` terhadap source. Test harus berjalan terhadap compiled runtime sesuai pipeline repository.
3. Jalankan dependency audit dengan threshold yang disepakati dan periksa bahwa tidak ada runtime high-severity vulnerability yang tidak ditangani.
4. Periksa `scripts/create-release-manifest.mjs` dan workflow CI setiap kali ada file runtime atau dependency baru. Artifact allowlist harus eksplisit dan tidak boleh mencakup `.env`, database, session, source tree, test tree, atau credential.
5. Push commit ke `main` melalui GitHub. Tunggu seluruh job CI selesai; release tidak boleh dilanjutkan jika typecheck, test, manifest, upload, remote checksum, atau cleanup gagal.
6. Simpan hanya metadata sanitized: commit SHA, CI run ID, pass/fail, checksum status, waktu, dan error class yang sudah direduksi.

## 4. Controlled Panel reload

1. Sebelum reload, lakukan pembacaan resource read-only dan catat state, memory, CPU, disk, network counters, serta uptime. Jangan membaca `.env`, raw log, database, session, atau console payload.
2. Minta atau pastikan otorisasi eksplisit untuk menghentikan proses manual yang sedang berjalan dan memulainya kembali.
3. Kirim hanya operasi power `restart` melalui API/UI Panel resmi. Jangan memakai arbitrary console command, `POST /command`, `kill`, reinstall, atau perubahan Startup Command.
4. Tunggu resource endpoint merespons HTTP 200 dan pastikan uptime kembali rendah lalu meningkat pada polling berikutnya. State API `starting` harus diperlakukan sebagai sinyal yang perlu diamati, bukan bukti bahwa WhatsApp live sudah accepted.
5. Pastikan `.bash_profile` workaround tetap utuh dan proses manual tetap menggunakan `node dist/index.js` sebagaimana prosedur yang telah disepakati.
6. Jalankan pemeriksaan aman yang tersedia pada environment Panel. Output yang boleh dicatat hanya status pass/fail, health state, versi runtime, dan metrik bounded. Jangan menyalin config secret atau log mentah.

## 5. Runtime verification

Pemeriksaan minimum setelah reload adalah self-check, health verifier dependency yang sudah tersedia, resource stability, dan bukti bahwa process tidak langsung exit. Jika verifier lokal atau Panel melaporkan feature flag disabled, catat sebagai `disabled`, bukan sebagai failure dan bukan sebagai bukti bahwa credential salah.

Untuk Neon, jangan mengirim command atau message ke grup nyata sebagai bagian dari runbook ini. Live command acceptance dilakukan hanya pada akun/group acceptance terisolasi yang memiliki consent sesuai prosedur. Tanpa environment tersebut, bukti yang sah adalah unit/integration tests, artifact evidence, runtime process evidence, dan status limitation.

Untuk Redis, outage atau timeout harus tetap mengaktifkan fallback lokal dan tidak memblokir WhatsApp/SQLite/Neon. Counter, distributed lock, dan bounded queue tidak boleh dianggap production workflow hanya karena primitive-nya tersedia.

## 6. Rollback and recovery

Rollback harus dilakukan dengan commit/artifact sebelumnya yang sudah diketahui baik. Jangan memperbaiki filesystem Panel secara manual dari source tree. Jalur rollback minimum adalah: hentikan rollout berikutnya, preserve evidence sanitized, pilih commit sebelumnya, biarkan CI menghasilkan artifact lama, verifikasi checksum, lalu lakukan controlled reload yang mendapat otorisasi.

Jika fitur optional menyebabkan masalah, gunakan feature flag yang sudah ada untuk mematikan capability tanpa menghapus data. Neon suppression tidak menghapus historical rows. Redis failure tidak mengubah authoritative state. SQLite restore hanya boleh memakai fixture atau backup non-produksi yang disetujui; gunakan `docs/recovery-runbook.md` untuk rehearsal dan jangan menyalin production database ke repository atau attachment.

Jika restart tidak memulihkan proses, jangan mengulangi restart tanpa batas. Catat state resource, uptime, sanitized error class, commit, dan CI run; kemudian kembali ke artifact sebelumnya atau tahan release sesuai risk owner. Jangan mengubah Startup Command atau `.bash_profile` sebagai workaround.

## 7. Post-release observation

Amati process survival, memory trend, reconnect behavior, dependency health, Neon writer queue behavior, Redis fallback signal, dan error class yang sudah direduksi. Review ulang setelah ada dependency update Baileys, perubahan konfigurasi feature flag, perubahan CI artifact allowlist, atau laporan command yang berbeda antara fake adapter dan WhatsApp.

Audit history harus diarsipkan, bukan dihapus. Laporan release harus membedakan **observed**, **inferred**, dan **not established**. Jangan menyebut release fully proven jika isolated live WhatsApp acceptance belum tersedia.

## 8. Current residual risks and owners

| Residual risk | Owner | Trigger review | Containment |
|---|---|---|---|
| Baileys live payload atau callback berbeda dari fake adapter | Maintainer/QA | Pinned dependency update atau acceptance environment tersedia | Text fallback, no destructive action, isolated test group |
| Manual process tidak otomatis reload setelah artifact sync | Operator/Release Engineer | Setiap artifact deployment | Controlled reload dan uptime evidence |
| Panel API state `starting` tidak menjelaskan readiness lengkap | Operator | Process uptime tidak meningkat atau command tidak merespons | Read-only resource checks, rollback artifact |
| Redis/Neon flag berbeda antara local dan Panel | Operator | Verifier menunjukkan disabled/unexpected state | Jangan klaim active; periksa env melalui prosedur secret-safe |
| Catalog scope melebar menjadi overengineering | Product/Maintainer | Command baru tidak punya contract, storage, permission, test | PRD delta dan separate batch |

## 9. Release decision template

Gunakan salah satu status berikut:

| Status | Arti |
|---|---|
| `blocked` | Ada Must gate gagal, artifact/checksum gagal, security blocker, atau recovery path tidak tersedia. |
| `ready_for_acceptance` | Semua feasible local/deployment gates pass, tetapi live acceptance belum dilakukan. |
| `completed_with_caveat` | Curated v1 scope telah lulus gates yang tersedia, residual live/operational risk tertulis, owner dan trigger review jelas. |
| `completed` | Hanya boleh dipakai jika semua Must gate dan acceptance yang diwajibkan oleh PRD terbukti pada environment yang relevan. |

**Keputusan snapshot:** `completed_with_caveat` belum boleh dipublikasikan sebagai keputusan final sampai controlled runtime checks, recovery rehearsal, dan rekonsiliasi evidence terakhir selesai. Live WhatsApp black-box acceptance tetap menjadi limitation yang harus disebutkan.

**Author:** Manus AI
