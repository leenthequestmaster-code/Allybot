# R0-S Safety Core — Requirement Brief

## Outcome

R0-S menyediakan guardrail platform yang dapat dipakai batch berikutnya tanpa mengubah perilaku command yang sudah ada. Guardrail harus fail-closed untuk policy, dapat membatasi fitur per grup, membatasi operasi berdasarkan rate/resource profile, menyimpan audit yang dapat ditelusuri, membatasi action automation melalui allowlist, dan mencegah provider failure menyebar ke runtime utama.

## Current-state facts

Repository `Allybot` menggunakan Node.js `>=22`, TypeScript ESM, SQLite melalui `better-sqlite3`, dan tidak memiliki dependency tambahan untuk R0-S. Platform package sudah memiliki `FeatureRegistry`, `PolicyPermissionEvaluator`, bounded in-memory event sink, `runPlatformOperation`, `PlatformKernel`, serta session store. Runtime utama saat ini mendaftarkan service melalui `ApplicationFramework` dan belum me-wire `PlatformKernel` ke boot path.

Baseline commit adalah `0b327a1`. Baseline validation pada Phase 2 menunjukkan typecheck, build, platform parity, dan seluruh 80 test lulus.

## Scope R0-S

| Capability | Required behavior |
|---|---|
| Policy registry | Policy bernama dan berversi; evaluasi deterministic; default-deny; input invalid ditolak; keputusan dapat diaudit tanpa raw secret |
| Feature flag per group | Default disabled untuk fitur baru; state group-scoped; persistence SQLite; actor dan timestamp tercatat; group isolation wajib |
| Audit contract | Event terstruktur dengan event type/version, namespace, actor/resource hash atau redacted identifier, outcome, timestamp, correlation/idempotency key, dan safe metadata |
| Hot/archive audit | Audit aktif dibatasi untuk operasi cepat; event lama dipindahkan secara transaksional ke archive sebelum dikeluarkan dari hot set; archive tidak dihapus otomatis sebagai perilaku default |
| Rate/resource profile | Named profile dengan finite limits; deny atau return decision saat limit terlampaui; tidak ada unbounded memory growth; reset berdasarkan monotonic timestamp yang dapat diuji |
| Safe action registry | Hanya action yang terdaftar, enabled, dan memiliki schema/permission metadata yang dapat dipanggil; tidak ada `eval`, `exec`, shell, dynamic import, atau arbitrary callback dari user input |
| Provider circuit breaker | Closed/open/half-open state; bounded failure threshold, cooldown, probe limit; fail-closed terhadap provider call saat open; state reset dan transition dapat diuji |
| Secret-safe observability | Hanya error name/category dan metadata allowlist yang dicatat; raw error message/stack, credential, token, JID sensitif, dan payload chat tidak masuk audit |

## Non-goals

R0-S tidak membuat command moderasi, AI assistant, RPG economy, downloader, Mission Studio UI, full-chat memory, arbitrary automation, atau black-box WhatsApp verification. Black-box WhatsApp verification ditunda sampai final phase sesuai keputusan pengguna. R0-S juga tidak menghapus atau memigrasikan authentication/session data.

## User decision

Pengguna menetapkan bahwa audit lama **tidak boleh dihapus begitu saja**. Audit harus dipindahkan secara transaksional ke archive. Archive deletion bukan default behavior dan akan memerlukan kebijakan terpisah, backup, serta persetujuan eksplisit.

## Provisional assumptions

Untuk keputusan yang belum dipilih secara eksplisit, implementasi menggunakan batas konservatif dan dapat dikonfigurasi: maksimal 1.000 event hot per namespace, audit archive retained indefinitely by default, rate profiles finite dan injectable melalui options, feature baru default disabled, serta provider circuit breaker tidak melakukan background timer. Semua angka exposed sebagai options/constants dan dicatat sebagai policy version agar dapat direvisi tanpa mengubah schema secara destruktif.

## Hard constraints

Perubahan harus additive dan backward-compatible terhadap public API yang ada. Tidak ada dependency baru tanpa kebutuhan terbukti. SQLite migration harus additive dan idempotent. Runtime harus tetap berjalan bila fitur R0-S belum dipakai. Tidak boleh ada eval/exec/shell, raw logs, credential access, database dump, atau reconnect automation. Deployment hanya melalui CI sanitized artifact. Startup Command Panel dan `.bash_profile` tidak boleh diubah.

## Acceptance criteria

1. Policy registry menolak policy invalid, deterministic, dan default-deny ketika tidak ada match.
2. Feature state pada group A tidak terbaca atau memengaruhi group B; state bertahan setelah service restart.
3. Audit event memiliki schema tervalidasi, actor/resource sensitif tidak disimpan mentah, dan metadata raw error ditolak.
4. Hot-to-archive migration atomic: event tidak hilang bila archive insert gagal; retry tidak menggandakan event yang sama.
5. Archive query dapat membaca histori lama tanpa menambah data ke hot set dan tidak menghapus archive.
6. Rate/resource profile menolak input tidak valid, bounded, dan memiliki deterministic reset behavior.
7. Safe action registry menolak unknown/disabled action dan tidak menyediakan arbitrary execution path.
8. Circuit breaker menguji closed → open → half-open → closed, serta provider call tidak dijalankan ketika open.
9. Existing 80 tests tetap lulus; test baru mencakup denial, isolation, persistence, archive atomicity, rate limit, circuit failure, dan secret redaction.
10. Typecheck, build, platform parity, regression suite, diff hygiene, dan sanitized artifact validation lulus sebelum release gate.

## Rollback

Rollback code dilakukan dengan artifact CI sebelumnya. Database tables baru bersifat additive dan tidak perlu dihapus untuk rollback binary. R0-S runtime wiring harus fail-safe: jika service guardrail gagal initialize, process startup gagal secara jelas sebelum WhatsApp traffic diproses, dan operator dapat kembali ke artifact sebelumnya tanpa destructive migration.

## Open review trigger

Policy dan archive defaults perlu ditinjau sebelum R1 mulai apabila archive growth, privacy requirement, moderator workflow, atau production storage budget menunjukkan bahwa indefinite archive tidak sesuai. Keputusan tersebut harus menjadi migration/retention policy baru, bukan silent deletion.
