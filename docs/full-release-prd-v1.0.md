# Allybot v1.0.0 — Full Release PRD

**Status:** Draft execution baseline
**Tanggal:** 23 Agustus 2026
**Owner:** Allybot maintainers
**Source of truth:** repository `main`, CI artifact, dan runtime evidence yang dapat diverifikasi.

## 1. Executive summary

Allybot akan diperlakukan sebagai **full release** ketika command surface yang dipilih untuk v1.0.0 benar-benar tersedia, terdokumentasi, memiliki permission dan persistence yang jelas, dapat dipulihkan setelah restart, lulus regression/security/reliability gates, dan berhasil melalui sanitized deployment. Full release **tidak berarti seluruh command yang pernah masuk katalog ide harus dibuat**. Katalog tetap menjadi backlog; hanya fitur yang scope, owner, storage, failure behavior, dan acceptance criteria-nya jelas yang masuk release.

Release ini mempertahankan modular monolith berbasis Node.js 22, TypeScript strict, ESM, Baileys, SQLite WAL, service/plugin registry, Pino redaction, serta deployment artifact-only. Supabase, Neon, dan Upstash Redis tetap memiliki boundary terpisah.

## 2. Problem statement

Allybot telah memiliki banyak capability yang dibangun melalui batch terpisah, tetapi sebagian statusnya tersebar antara source, changelog, roadmap lama, working tree, artifact Panel, proses manual, dan service eksternal. Risiko utama menuju rilis bukan sekadar kurangnya command, melainkan **ketidakkonsistenan antara behavior, dokumentasi, konfigurasi, deployment, persistence, consent, dan recovery**.

## 3. Goals

| ID | Goal | Ukuran keberhasilan |
|---|---|---|
| G-01 | Menetapkan command surface v1.0 yang terverifikasi | Setiap command release memiliki parser, handler, permission, validation, output, failure path, dan test. |
| G-02 | Menutup pending operational gaps | Neon opt-out dirilis; Redis build terbaru dimuat dan diverifikasi pada runtime; dokumentasi tidak kontradiktif. |
| G-03 | Menjaga data ownership | SQLite tetap runtime store; Neon hanya chat-log consent-aware; Supabase tetap access boundary; Redis hanya ephemeral operational state. |
| G-04 | Menjamin rollback | Feature flag, commit terpisah, artifact provenance, checksum, dan runbook rollback tersedia. |
| G-05 | Menjaga keamanan dan privasi | Tidak ada secret, raw JID, nomor, isi chat, auth/session, atau raw error pada log, audit, artifact, dan laporan. |
| G-06 | Membuktikan release readiness | Typecheck, build, regression, security/dependency, failure-mode, deployment, dan runtime checks lulus atau memiliki caveat eksplisit. |

## 4. Non-goals

Release ini tidak mencakup migrasi SQLite ke PostgreSQL, pembuatan World Database besar, auto-spam deletion/kick, passive full-chat memory tanpa consent, arbitrary shell/SQL/eval/exec, worker multi-instance tanpa kebutuhan terbukti, perubahan Startup Command, perubahan `.bash_profile`, atau seluruh command katalog yang belum memiliki implementation contract.

Live WhatsApp black-box acceptance dilakukan hanya bila environment acceptance terisolasi tersedia. Tanpa environment tersebut, release harus mencatat limitation tersebut dan tidak mengklaim bahwa fake adapter membuktikan seluruh behavior Baileys live.

## 5. Current state

| Area | Current evidence | Release implication |
|---|---|---|
| Source | `main` berisi core, permission, group, Neon, Redis, dan plugin capability yang sudah diuji | Reconcile source dengan docs dan artifact. |
| Tests | Baseline terbaru 274 test lulus | Tambahkan test untuk setiap perubahan selanjutnya. |
| Panel | Artifact sync CI terakhir berhasil; proses masih manual dan API lifecycle dapat menunjukkan `starting` | Reload proses diperlukan untuk memuat build terbaru. |
| Neon | Schema tersedia dan capture aktif; aggregate terbaru menunjukkan 1.023 rows, 5 grup, 1.023 event distinct | Consent dan opt-out harus menjadi release gate. |
| Upstash | Health-check pernah `PASS`; operational primitives tersedia | Runtime reload dan canary perlu diverifikasi. |
| Working tree | Perubahan Neon opt-out masih belum dirilis | Menjadi batch prioritas pertama. |

## 6. Scope functional requirements

### Must

| ID | Requirement |
|---|---|
| M-01 | `!menu` dan command bantuan menampilkan hanya capability yang benar-benar aktif. |
| M-02 | Owner identity dan permission boundary tetap terpusat, default-deny, serta tidak membocorkan identifier. |
| M-03 | Group command memakai canonical group JID validation dan menolak private chat bila scope-nya grup. |
| M-04 | Neon chat-log hanya berjalan jika feature flag global, client, dan allowlist tersedia. |
| M-05 | Admin/Owner dapat menjalankan `!chatlog off`, `!chatlog on`, dan `!chatlog status`; member biasa ditolak. |
| M-06 | Suppression chat-log group-scoped, tersimpan di SQLite, reversible, tidak menghapus row lama, dan fail-safe ketika persistence gagal. |
| M-07 | Redis tidak menjadi blocking dependency; cache/dedupe/rate limit memiliki fallback lokal. |
| M-08 | CI hanya mengirim sanitized artifact dan memverifikasi SHA-256 sebelum cleanup. |
| M-09 | Startup Command dan `.bash_profile` tidak berubah. |
| M-10 | Semua perubahan production memiliki runbook rollback dan evidence. |

### Should

| ID | Requirement |
|---|---|
| S-01 | Menu v1.0 memakai taxonomy delapan kategori dan submenu text-only dengan fallback angka. |
| S-02 | Metadata group-name memakai cache bounded dan tidak melakukan lookup berlebihan. |
| S-03 | Observability memiliki status health dependency, fallback, timeout, dan error class yang aman. |
| S-04 | Dokumentasi roadmap/changelog mencerminkan status deployment yang sebenarnya. |
| S-05 | Masukan desain `location message type`, `contextInfo rows`, dan auto-category dievaluasi melalui spike sebelum diadopsi. |

### Could

| ID | Requirement |
|---|---|
| C-01 | Counter Redis selective untuk metrik operasional dengan budget request yang jelas. |
| C-02 | Distributed lock untuk workflow background setelah worker nyata dibutuhkan. |
| C-03 | Queue Redis untuk workload non-Neon setelah poison-item, retry, DLQ, dan ownership dirancang. |
| C-04 | Autospam Detection dry-run berbasis Neon setelah rancangan disetujui dan telemetry cukup. |

### Won't for v1.0

Seluruh katalog download/media, RPG/economy, World Database PostgreSQL, Mission Platform, auto moderation destruktif, multi-instance worker, dan live acceptance penuh tanpa environment test tidak dianggap release blocker untuk v1.0 kecuali requirement produk baru disetujui dengan scope dan evidence terpisah.

## 7. Non-functional requirements

| Quality | Requirement |
|---|---|
| Security | Server-side authorization, input validation, no secret/raw PII logging, least privilege, dependency lock, sanitized artifact. |
| Reliability | Graceful shutdown, bounded queues/retries, timeout, fallback, idempotency, no dependency outage cascade. |
| Performance | No unbounded cache/value/queue; Redis operation timeout short; metadata lookup cache-aside; no per-message metric write without budget. |
| Maintainability | Minimal diff, explicit service boundaries, typed contracts, docs synchronized, no speculative abstraction. |
| Observability | Health status, safe error class, queue depth where relevant, deployment checksum, and rollback signal. |
| Privacy | Neon group allowlist and consent; per-group opt-out; historical row deletion is out of scope. |
| Deployability | CI artifact-only, reproducible build, SHA-256 verification, no manual source upload. |
| Recovery | Feature flags and local fallback permit disabling optional dependencies without data migration. |

## 8. Acceptance criteria

Release candidate dapat disebut **completed** hanya apabila semua Must requirements lulus, seluruh change set memiliki commit/CI/artifact evidence, no known blocker remains, dan runtime limitations dicatat. Jika live acceptance belum tersedia tetapi semua local/deployment gates lulus, status maksimal **completed with caveat**, bukan “fully proven in production”.

Minimum gates:

1. Repository clean atau remaining changes explicitly assigned to a release batch.
2. Typecheck dan build lulus.
3. Regression suite lulus tanpa test yang dilemahkan.
4. Dependency audit dan release manifest lulus.
5. Negative permission/security tests lulus.
6. Persistence/restart tests lulus untuk state penting.
7. Timeout/retry/duplicate/concurrency tests lulus untuk asynchronous atau distributed behavior.
8. Sanitized artifact tidak memuat secret, source tree, tests, database, atau session.
9. Panel artifact checksum lulus dan temporary archive dibersihkan.
10. Runtime reload/health-check serta rollback flag diverifikasi.
11. Changelog, roadmap, command catalog, runbook, dan configuration docs tidak saling bertentangan.
12. Residual risk, owner, trigger review, dan acceptance limitation ditulis.

## 9. Execution order

| Batch | Scope | Exit criteria |
|---|---|---|
| R0 | Reconcile baseline, PRD, docs, and working tree | Scope freeze dan risk register tersedia. |
| R1 | Neon chat-log opt-out release | Tests, commit, CI, artifact, and runtime command verification. |
| R2 | Redis runtime reload and canary | New build loaded; verifier PASS; fallback and rate-limit path observed. |
| R3 | Menu v1.0 and command copy reconciliation | Taxonomy, output, fallback, and active command list consistent. |
| R4 | Moderate safe community capability hardening | Only selected commands, with permission and rollback. |
| R5 | Productivity/media/AI/roleplay slices as separately approved | Each slice has own PRD and gates; no broad speculative batch. |
| R6 | Full-release rehearsal | Restart, recovery, artifact rollback, dependency outage, and acceptance evidence. |
| R7 | Release decision | Completed or completed-with-caveat with explicit residual risk. |

## 10. Risk register summary

| Risk | Impact | Mitigation | Trigger review |
|---|---|---|---|
| Runtime process masih build lama | New Redis/Neon behavior belum aktif | Manual controlled reload; verify script; no Startup Command change | Uptime reset or verifier failure. |
| Baileys live behavior berbeda | Command/message edge regression | Isolated black-box acceptance when environment available | Payload mismatch or upstream update. |
| Neon consent/control mismatch | Privacy and trust impact | Allowlist, suppression, audit redaction, no historical deletion | Group request or audit anomaly. |
| Redis outage/latency | Shared state unavailable | Timeout, no side-effect retry, local fallback | Error rate or latency budget exceeded. |
| Docs stale | Wrong operations and release confusion | Docs reconciliation batch and status report | Commit/behavior change without doc update. |
| Scope expansion | Overengineering and release delay | PRD gate, non-goals, separate batch approval | New feature lacks owner/storage/acceptance. |

## 11. Release decision policy

Keputusan release dipilih berdasarkan safety, evidence, outcome, completeness, operational risk, dan maintainability. “Full release” berarti scope v1.0 yang dipilih telah complete; tidak berarti semua ide masa depan telah dibangun. Setiap new batch yang materially changes scope harus memiliki PRD delta, acceptance update, dan dependency/risk review.
