# Deferred High-Risk Tracks — Allybot v2

**Tanggal:** 23 Agustus 2026  
**Status:** Decision brief dan release boundary  
**Author:** Manus AI

## Keputusan

Allybot general full release tidak akan mengaktifkan RPG penuh, Mission Platform orchestration, Autospam Detection aktif/destruktif, World Database besar, atau multi-instance worker hanya untuk mengejar jumlah command. Track tersebut tetap dipisahkan dari release surface general karena memerlukan kontrak state, concurrency, privacy, recovery, operational ownership, dan acceptance yang belum tersedia.

> **Prinsip:** fitur yang belum memiliki invariant, boundary, failure behavior, dan rollback yang dapat dibuktikan tidak boleh ditampilkan sebagai `READY`.

## Ground truth repository

Repository saat ini memiliki banyak fondasi reusable—SQLite WAL, audit archive, group-scoped services, PlatformGuardrail, optional Redis primitives, Neon consent-aware chat log, CI sanitized artifact, dan plugin framework—tetapi tidak memiliki implementasi production-shaped yang dapat menjadi dasar aman untuk seluruh track di bawah ini. Tidak ditemukan plugin/service runtime tersendiri untuk Mission Platform, World Database, RPG economy/combat, atau active Autospam Detection pada inventory source saat keputusan ini dibuat. Istilah-istilah tersebut terutama muncul pada roadmap/backlog dan guardrail context, bukan sebagai command release yang sudah tersedia.

| Track | Nilai yang diinginkan | Mengapa tidak masuk general release | Trigger untuk membuka discovery |
| --- | --- | --- | --- |
| RPG penuh | Progres karakter, skill, economy, combat, quest, reward. | Membutuhkan world/state model lintas entitas, determinisme, anti-cheat, concurrency, balance, dan rollback; bertentangan dengan keputusan pengguna untuk menunda unsur RPG. | PRD baru dari pemilik produk yang eksplisit mengubah scope. |
| Mission Platform | Orkestrasi mission/quest dengan objective, trigger, condition, consequence, dan progression. | Bukan sekadar command; memerlukan workflow engine, versioned definitions, idempotent event processing, retry/dead-letter, scheduler, operator tooling, dan migration. | Minimal satu use case mission bounded dengan owner, state machine, event contract, dan recovery rehearsal. |
| World Database | Universe/world/geography/entity/relationship/history/rules/analytics. | Skema besar tidak otomatis memberi nilai; SQLite dapat tetap menjadi runtime store untuk domain kecil, tetapi world graph besar memerlukan ownership, query pattern, indexing, archival, backup/restore, dan consistency policy sebelum memilih PostgreSQL. | Workload nyata, query/read-write profile, retention, multi-user editing, dan availability target terukur. |
| Active Autospam Detection | Mendeteksi spam dan mengambil tindakan otomatis. | Risiko false positive, privacy, surveillance, moderation harm, appeal, adversarial evasion, rate/ban blast radius, dan kebutuhan live acceptance jauh lebih tinggi. | Policy moderation tertulis, dry-run classifier evidence, appeal workflow, kill switch, audit retention, dan isolated canary. |
| Multi-instance worker | Scale-out processing dan queue consumer. | Redis primitive belum menjadi authoritative queue; perlu idempotence, leases, ordering, dedupe, backpressure, split-brain behavior, observability, dan deployment topology. | Measured throughput/latency bottleneck yang tidak bisa diselesaikan single instance dengan bounded changes. |

## Alternatif arsitektur yang dipertimbangkan

| Alternatif | Trade-off | Keputusan |
| --- | --- | --- |
| Tambahkan command tipis di plugin existing | Cepat terlihat, tetapi memalsukan domain; state dan failure semantics akan tersebar serta sulit dipulihkan. | Ditolak. |
| Bangun domain service bounded di modular monolith | Paling sederhana untuk satu use case kecil, tetap memakai SQLite dan service boundary; dapat menjadi alpha yang reversible. | Pilihan awal bila trigger use case konkret muncul. |
| Langsung migrasi ke PostgreSQL/Redis dan worker terpisah | Memungkinkan scale dan query kompleks, tetapi menambah distributed failure, migration, credentials, operational cost, dan belum didorong workload terbukti. | Ditunda sampai evidence workload dan ownership tersedia. |

## Minimum contract sebelum track dibuka

Setiap track harus memiliki satu design brief/ADR yang mendefinisikan actor, scope, data ownership, state machine, invariant, command/API contract, permission, audit outcome, retention, concurrency, retry/idempotence, timeout/backpressure, observability, feature gate, migration, rollback, and acceptance environment. Track yang melakukan tindakan eksternal wajib memiliki dry-run atau preview mode dan kill switch sebelum active mode.

### RPG dan Mission

Tidak boleh ada economy/combat/reward yang menggunakan saldo atau progression tanpa aturan deterministik, transaction boundary, anti-duplicate event, dan reconciliation. Mission definitions harus versioned; event processor harus idempotent; retry tidak boleh menggandakan reward atau side effect; operator harus dapat melihat dan menghentikan mission yang macet. SQLite domain service boleh menjadi alpha bila workload single-instance terbukti, tanpa memindahkan seluruh runtime store.

### World Database

Tidak boleh membuat seluruh schema tree sebagai speculative migration. Mulai dari satu bounded read/write use case, misalnya lore location yang group-scoped, ukur query shape dan write contention, lalu pilih SQLite domain service atau PostgreSQL boundary berdasarkan data. PostgreSQL tidak menjadi alasan untuk memasukkan chat log atau Redis primitives ke satu database generik. Historical changes harus archive-preserving dan dapat direkonsiliasi.

### Autospam

Tahap pertama harus passive/dry-run dengan synthetic fixture atau approved acceptance group, bukan kick/delete/mass message. Input content harus diminimalkan, retention jelas, score dan reason dapat diaudit tanpa menyimpan raw content, dan setiap false positive mempunyai appeal/override. Active enforcement hanya boleh setelah precision/recall pada workload representatif, human review, kill switch, per-group gate, dan live acceptance terisolasi tersedia.

### Multi-instance worker

Redis tetap ephemeral optional dan bukan source of truth. Sebelum worker kedua ditambahkan, perlu benchmark dan failure tests untuk duplicate delivery, lease expiry, clock skew, ordering, consumer crash, retry storm, queue backlog, and graceful drain. Persistent state tetap berada pada SQLite/domain database yang memiliki ownership; distributed lock hanya dipakai untuk invariant yang benar-benar memerlukannya.

## Release impact

Deferred track bukan defect pada general full release. Sebaliknya, menahan track ini mencegah surface palsu, schema spekulatif, dan tindakan moderasi yang sulit dibatalkan. General release tetap dapat memberi roleplay sosial melalui Character, Mood, Emote, Scene, Canon, dan explicit Knowledge tanpa mengaktifkan RPG engine atau passive memory.

## Review trigger

Decision brief ini harus ditinjau ulang jika pemilik produk secara eksplisit meminta RPG, Mission, World, Autospam active mode, atau scale-out worker; jika telemetry menunjukkan single-instance bottleneck; jika retention/compliance requirement berubah; jika Baileys/runtime transport berubah major; atau jika live WhatsApp acceptance environment tersedia.
