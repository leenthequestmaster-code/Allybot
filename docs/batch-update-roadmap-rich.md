# Allybot Rich Feature Roadmap

## Visi

Allybot tidak perlu menjadi sekadar bot dengan daftar command panjang. Target yang lebih kuat adalah menjadikannya **group operating system**: bot yang dapat menjaga keamanan grup, menjalankan workflow terstruktur, membantu kolaborasi, memberi insight, dan tetap aman untuk dipelihara bertahun-tahun.

Roadmap ini sengaja tidak dibatasi oleh LastAlly. LastAlly hanya menjadi satu sumber ide dari audit sebelumnya. Fitur yang sudah ada di Allybot—AFK, Welcome/Leave, Group Setup Mission, konfigurasi grup, group information, menu, native button, pagination, submenu teks, diagnostics, permission, session, dan platform package—tidak diulang sebagai fitur baru.

## Prinsip desain

Fitur baru harus memiliki nilai pengguna yang jelas dan tidak hanya menambah jumlah command. State yang memiliki umur atau ownership harus memakai session, mission, operations, atau persistence yang sesuai. Automation harus memakai rule/DSL yang tervalidasi, bukan `eval` atau eksekusi shell. AI dan provider eksternal harus berada di balik service boundary dengan timeout, rate limit, circuit breaker, dan redacted errors.

## Feature flagship yang membedakan Allybot

### 1. Allybot Mission Studio

Mission Studio adalah workflow engine yang memungkinkan admin membuat alur terstruktur melalui wizard, tanpa menulis kode. Contohnya adalah alur laporan pelanggaran, pendaftaran anggota, voting keputusan, approval request, challenge komunitas, dan reminder.

Setiap workflow memiliki trigger, state, input schema, permission, expiry, retry policy, dan action yang dibatasi allowlist. Action hanya boleh berasal dari registry internal seperti mengirim pesan, mencatat data, meminta approval, memberi role, atau menjadwalkan follow-up. Tidak ada arbitrary code execution.

### 2. Trust & Safety Case Management

Alih-alih hanya menghapus link atau memberi warning, Allybot dapat membuat **case** dengan nomor, pelapor, target, bukti pesan, rule yang dilanggar, moderator yang menangani, status, dan histori tindakan. Moderator dapat mengambil case, menambahkan catatan, menutup, atau mengajukan appeal.

Ini memberi grup mekanisme moderasi yang dapat diaudit dan lebih adil daripada command kick sederhana.

### 3. Privacy-first Group Memory & Digest

Dengan opt-in yang jelas, Allybot dapat menyimpan fakta atau keputusan grup yang memang ingin dipertahankan, misalnya aturan, keputusan rapat, FAQ, dan ringkasan agenda. Default-nya tidak menyimpan seluruh percakapan. Data memiliki owner, retention period, delete/export command, dan audit trail.

Allybot dapat menghasilkan digest harian atau mingguan berisi keputusan, task yang belum selesai, event penting, dan pertanyaan yang belum dijawab. Fitur ini membutuhkan scheduling dan AI/provider policy yang terkontrol.

### 4. Safe Automation Rule Engine

Admin dapat membuat aturan seperti: ketika anggota baru masuk, kirim onboarding; ketika pesan mengandung pola terlarang, buat case; ketika voting ditutup, kirim hasil; ketika reminder jatuh tempo, kirim notifikasi.

Rule engine menggunakan trigger-condition-action DSL yang dapat divalidasi dan di-preview. Admin dapat mengaktifkan dry-run, melihat audit, mematikan rule, dan membatasi rule pada grup tertentu.

### 5. Community Quest & Reputation

Allybot dapat menyediakan challenge komunitas, reputation, achievement, leaderboard, dan reward yang tidak harus berupa ekonomi uang. Contoh: menyelesaikan onboarding, membantu menjawab FAQ, ikut voting, atau berkontribusi pada event grup.

Scoring harus memiliki anti-abuse policy, cooldown, idempotency, dan audit record. Ini dapat menjadi fitur sosial yang lebih orisinal daripada sekadar RPG wallet.

## Portofolio domain fitur

| Domain | Kandidat fitur baru | Nilai utama | Risiko |
|---|---|---|---|
| Trust & Safety | Warning, anti-link, anti-spam, trust score berbasis rule, case management, moderator queue, appeal workflow | Grup lebih aman dan tindakan dapat diaudit | Menengah–tinggi |
| Automation | Rule engine, trigger-condition-action, approval flow, scheduled workflow, recurring task, dry-run | Bot dapat menjalankan workflow tanpa custom code | Tinggi |
| Collaboration | Poll/voting, agenda, task assignment, decision log, reminder, bookmark, FAQ, unresolved question tracker | Membantu grup bekerja dan mengambil keputusan | Menengah |
| Knowledge | Opt-in memory, group FAQ, decision archive, digest, search semantik/provider adapter | Pengetahuan grup tidak hilang di chat | Tinggi karena privasi |
| Personalization | User preferences, language, timezone, quiet hours, notification policy, command aliases per user | Interaksi lebih personal dan tidak mengganggu | Menengah |
| Community | Quest, achievement, reputation, leaderboard, contribution badges, event challenge | Engagement dan kontribusi anggota | Menengah |
| AI | Assistant berbasis context terkontrol, summarizer, classifier, moderation suggestion, translation | Mengurangi kerja manual moderator | Tinggi |
| Media | Voice transcription, OCR dokumen/gambar, sticker pipeline, safe conversion, quote card | Memperluas input yang dapat dipahami bot | Tinggi |
| WhatsApp utility | Reaction-driven actions, contact/album workflow, presence-aware response, call policy | Pemanfaatan event WhatsApp lebih kaya | Menengah–tinggi |
| Operations | Feature flags, canary per grup, circuit breaker provider, operator report, data retention controls | Deployment dan operasi lebih aman | Menengah |

## Roadmap batch kaya

### Batch R0 — Platform Guardrails

Batch ini bukan fitur pengguna utama, tetapi pagar agar batch berikutnya tidak menjadi kumpulan command yang sulit dikendalikan. Isinya adalah policy registry untuk automation, audit event schema, feature flag per grup, rate-limit profile, provider circuit breaker, data retention policy, dan safe action registry.

Batch ini memanfaatkan platform package yang sudah ada tetapi menambahkan capability baru. Definition of Done-nya meliputi policy denial test, audit completeness, feature flag isolation, rate-limit test, provider failure test, dan secret redaction.

### Batch R1 — Trust & Safety

Fitur utama: warning system, anti-link, anti-spam, moderation case, moderator queue, appeal, dan audit log. Welcome/Leave dan AFK tidak termasuk karena sudah ada.

R1 direkomendasikan sebagai batch pertama yang terlihat manfaatnya. Implementasi awal sebaiknya dimulai dari warning + audit case, kemudian anti-link dan anti-spam setelah policy threshold disepakati.

### Batch R2 — Mission Studio dan Safe Automation

Fitur utama: membuat workflow melalui wizard, trigger registry, condition schema, action allowlist, approval node, expiry, dry-run, preview, pause/resume, dan execution history.

R2 adalah kandidat **fitur pembeda utama Allybot**. Mission Engine sudah ada sebagai fondasi, tetapi user-facing workflow studio dan rule DSL belum ada. Implementasinya harus sangat ketat karena automation yang terlalu bebas dapat menjadi jalur penyalahgunaan.

### Batch R3 — Collaboration Suite

Fitur utama: poll/voting, agenda, task assignment, decision log, reminder, FAQ, unresolved question tracker, dan bookmark pesan. Voting dapat memakai poll native bila kompatibilitas client terverifikasi, dengan fallback command jika tidak.

Reminder harus memiliki owner, timezone, cancellation, expiry, persistence, dan recovery setelah restart. Scheduled execution tidak boleh bergantung pada `setTimeout` tanpa persistence.

### Batch R4 — Privacy-first Knowledge

Fitur utama: group memory opt-in, fact/decision capture, retention policy, export/delete, group FAQ, digest, dan permission untuk memory curator. Default memory harus off atau hanya menyimpan data yang eksplisit disimpan melalui command.

R4 tidak boleh memproses seluruh chat secara diam-diam. Setiap memory record harus memiliki source, creator, timestamp, expiry/retention, dan cara penghapusan.

### Batch R5 — Personalization dan Accessibility

Fitur utama: preferensi bahasa user, timezone user, quiet hours, notification policy, per-user command alias, response verbosity, dan accessibility mode untuk format pesan.

Group language dan timezone sudah ada; R5 memperluasnya menjadi preferensi user tanpa merusak setting grup. Resolusi prioritas harus jelas: user override, group policy, lalu global default.

### Batch R6 — Community Quest dan Reputation

Fitur utama: quest, achievement, reputation, contribution points, leaderboard, event challenge, reward non-finansial, dan anti-abuse controls.

Scoring harus dapat diaudit dan di-reset berdasarkan policy. Jangan membuat ekonomi yang dapat diperdagangkan sebelum anti-abuse, transaction, dan moderation policy matang.

### Batch R7 — AI Contextual Assistant

Fitur utama: assistant berbasis context yang dipilih, summarizer digest, translation, moderation suggestion, FAQ answer, dan extraction dari message yang secara eksplisit diberikan.

AI tidak boleh memiliki akses penuh ke database atau chat history. Context harus dibatasi per request, user/group permission harus diperiksa, prompt dan output memiliki batas, provider memiliki timeout/circuit breaker, dan error tidak boleh membocorkan secret.

### Batch R8 — Media Intelligence

Fitur utama: voice transcription, OCR, sticker generator, safe image conversion, quote card, dan media metadata extraction.

Setiap job memiliki size/duration limit, MIME verification, concurrency cap, timeout, temporary directory, cleanup, dan observability. Worker tidak boleh menerima shell string dari input user.

### Batch R9 — Integrations dan Advanced WhatsApp

Fitur utama: provider adapter untuk GitHub/currency/search, contact/album workflow, reaction-driven actions, presence-aware response, call policy, dan optional webhook/integration bridge.

R9 dikerjakan terakhir karena paling bergantung pada API eksternal dan perubahan protokol. Setiap provider harus dapat dimatikan atau diganti tanpa merusak command contract.

## Prioritas implementasi

| Prioritas | Batch | Alasan |
|---|---|---|
| Pertama | R0 lalu R1 | Menyediakan guardrail dan fitur keamanan grup yang benar-benar belum ada |
| Kedua | R2 | Menjadi fitur pembeda dan memanfaatkan Mission Engine yang sudah tersedia |
| Ketiga | R3 | Memberi nilai produktivitas tinggi dengan risiko yang masih dapat dikontrol |
| Keempat | R4 dan R5 | Membangun knowledge dan personalization secara privacy-first |
| Kelima | R6 | Meningkatkan engagement setelah trust dan data policy matang |
| Keenam | R7 | Memakai AI setelah context dan privacy boundary tersedia |
| Terakhir | R8 dan R9 | Resource, provider, dan compatibility risk paling tinggi |

## Definition of Done

Setiap batch harus memiliki requirement brief, threat model, permission matrix, data schema, migration/recovery strategy, timeout/resource policy, regression test, typecheck, build, parity check, CI artifact, sanitized deployment, rollback path, dan smoke test production.

Fitur stateful harus memiliki ownership, expiry, idempotency, dan recovery setelah restart. Fitur AI/external provider harus memiliki rate limit, timeout, circuit breaker, response validation, dan secret-safe logging. Fitur automation tidak boleh menjalankan arbitrary code.

## Keputusan

Jawabannya: **tidak, fitur Allybot tidak berhenti pada daftar anti-link, warn, voting, RPG, AI, dan downloader.** Daftar itu hanya capability gap dasar. Roadmap yang lebih kaya sebaiknya menjadikan **Mission Studio, Trust & Safety Case Management, Privacy-first Group Memory & Digest, Safe Automation Rule Engine, dan Community Quest & Reputation** sebagai fitur pembeda utama.

Batch pertama yang direkomendasikan adalah **R0 + R1**, lalu **R2 Mission Studio** sebagai flagship. Implementasi belum dimulai pada tahap ini.

## References

[1]: https://baileys.wiki/concepts/events — Baileys official typed event model for messages, group updates, polls, presence, calls, and connection lifecycle.
[2]: https://baileys.wiki/introduction — Baileys official capability overview for messages, media, groups, privacy, presence, and real-time events.
