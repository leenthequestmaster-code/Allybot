# Efficiency Coding Audit Report — Allybot

## Audit Status

`COMPLETE`

Audit awal dilakukan read-only. Setelah pengguna mengizinkan seluruh batch, rekomendasi prioritas yang aman telah diterapkan melalui batch terpisah dan diverifikasi oleh local gate serta CI artifact-only.

Audit awal dilakukan dalam mode read-only sesuai default skill. Setelah audit selesai, pengguna meminta seluruh batch dijalankan berurutan dalam satu sesi. Perubahan implementasi dicatat terpisah melalui Batch A-D; dokumen ini sekarang memuat hasil akhir rekonsiliasinya. File `docs/panel-startup-observation-2026-08-23.md` adalah artefak observasi incident Panel dan tetap tidak dinilai sebagai source code.

## Executive Summary

Audit menemukan **tiga kandidat prioritas yang cukup konkret** dan beberapa kandidat struktural yang memerlukan review terpisah. Temuan paling aman adalah branch ternary redundan pada `CollaborationService`; temuan paling bernilai secara runtime adalah pola N+1 query ketika event calendar memuat banyak event; temuan paling mengurangi maintenance cost adalah duplikasi fake WhatsApp adapter pada test. Tidak ada dependency direct yang terbukti tidak digunakan melalui static import scan.

Sebagian file source berukuran besar bukan otomatis masalah. `WhatsAppConnection`, `EventService`, `AnnouncementService`, dan service domain lain menggabungkan state machine, authorization, persistence, timeout, retry, audit, dan recovery semantics. Memecah atau memendekkan file-file tersebut tanpa characterization tests dan boundary design dapat menurunkan correctness, bukan meningkatkan efisiensi. Karena itu, audit memberi status `DO_NOT_CHANGE` atau `INTENTIONALLY_COMPLEX` pada bagian tersebut untuk saat ini.

## Execution Summary

| Batch | Implementasi | Commit | CI/artifact |
|---|---|---|---|
| A | Simplifikasi no-op ternary pada `CollaborationService` dan coverage native sent/failed | [`362b07e`](https://github.com/leenthequestmaster-code/Allybot/commit/362b07e687f9369f03fa65e4653d5bf6d3586a85) | [CI 32651899882](https://github.com/leenthequestmaster-code/Allybot/actions/runs/32651899882) sukses; artifact dan SHA-256 Panel sukses. |
| B | Prefetch bounded phases/counts pada `EventService.listEvents()` | [`01bce24`](https://github.com/leenthequestmaster-code/Allybot/commit/01bce242deeb104cf638b8c4f4a8a457361e47e8) | [CI 32652178853](https://github.com/leenthequestmaster-code/Allybot/actions/runs/32652178853) sukses; artifact dan SHA-256 Panel sukses. |
| C | Shared test-only fake WhatsApp factory pada tiga test representative | [`9b6800e`](https://github.com/leenthequestmaster-code/Allybot/commit/9b6800ebf7c4112dce942104af59f7acb9f64bbf) | [CI 32652473593](https://github.com/leenthequestmaster-code/Allybot/actions/runs/32652473593) sukses; artifact dan SHA-256 Panel sukses. |
| D | Memisahkan fun registration ke `utility-fun.ts`, mempertahankan satu public plugin boundary dan command parity guard | [`b914c1c`](https://github.com/leenthequestmaster-code/Allybot/commit/b914c1c720b03a2e09020a2d020c4f0d3c64c8df) | [CI 32652842528](https://github.com/leenthequestmaster-code/Allybot/actions/runs/32652842528) sukses; artifact dan SHA-256 Panel sukses. |

Benchmark sintetis Batch B pada 25 event dan 500 list calls mengukur pola lama sebesar 51 statement/list dan rata-rata 1,38634 ms/list, sedangkan prefetch menjadi 3 statement/list dan 0,38870 ms/list. Ini setara pengurangan statement sekitar 94,1% dan pengurangan waktu sekitar 72,0% pada environment benchmark. Angka tersebut adalah evidence lokal sintetis, bukan jaminan latency Panel atau live WhatsApp.

> **Kesimpulan praktis:** broad refactor tetap tidak diperlukan. Urutan evidence-first telah dijalankan: redundansi lokal diperbaiki, N+1 event diukur lalu dioptimalkan, test fixture diekstrak secara bertahap, dan Utility fun registration dipisahkan dengan parity guard. Kandidat cross-cutting berisiko tinggi tetap ditahan.

## Scope and Coverage

| Area | Coverage |
|---|---|
| Repository | `/home/ubuntu/Allybot_main_exec`; audit baseline commit `182d9b9`, hasil batch terakhir `b914c1c`. |
| Included paths | `src/**/*.ts`, `tests/**/*.js`, `scripts/*`, `package.json`, `package-lock.json`, dan struktur `docs/`. |
| Excluded paths | `.git`, `node_modules`, `dist`, build output, vendor/minified code, serta data/session/runtime secrets. |
| Source inventory | 84 file TypeScript. |
| Test inventory | 56 file JavaScript test. |
| Script inventory | 8 file `.mjs` pada `scripts/`. |
| Documentation inventory | 87 file Markdown pada `docs/`. |
| Generated/vendor | `dist` dan `node_modules` tidak dianalisis sebagai source biasa. Source map/generated artifact tidak dijadikan target refactor. |
| Dynamic usage review | Registry service/plugin dan command registrations diperiksa secara sampling pada composition root, plugin boundary, dan call sites utama. |
| Area belum diaudit penuh | Benchmark workload nyata, heap/profile runtime Panel, live WhatsApp behavior, dependency license/maintainer health, serta seluruh dynamic/reflection behavior. |

## Baseline

| Metric | Before | Source/Command | Reliability | Notes |
|---|---:|---|---|---|
| Repository files counted | 248 | `codebase_inventory.py` | High for inventory | Excludes default directories seperti `.git`, `node_modules`, `dist`, dan build. |
| Counted repository lines | 40,378 | `codebase_inventory.py` | High for line count | Mencakup docs/lockfile; bukan source-only LOC. |
| Largest source file | 1,014 lines | Inventory | High | `src/whatsapp.ts`; size bukan bukti refactor diperlukan. |
| Highest heuristic signal | 35 | `complexity_signals.py` | Low–medium | Heuristic branch/nesting/line signal; bukan cyclomatic complexity atau proof of debt. |
| Direct runtime dependencies | 11 | `package.json` | High | Static import scan menemukan call site untuk dependency direct; tidak ada unused dependency yang terbukti. |
| Direct dev dependencies | 3 | `package.json` | High | TypeScript/types tooling. |
| SQLite constructor occurrences | 19 | `grep 'new Database(' src` | High | Banyak service sengaja memiliki lifecycle/DB boundary sendiri; bukan otomatis candidate extraction. |
| WAL pragma occurrences | 19 | `grep journal_mode src` | High | Repetition nyata, tetapi perubahan shared helper bersifat cross-cutting. |
| `busy_timeout` occurrences | 18 | `grep busy_timeout src` | High | Satu service memiliki konfigurasi berbeda/tidak sama; perlu review sebelum centralization. |
| Hash helper definitions | 11 | `grep function (hash|hashText|hashIdentifier)` | High | Sebagian menerima JID, sebagian menerima opaque ID/text; tidak aman disatukan tanpa contract matrix. |
| Local test baseline | 304/304 pass | `npm test` pada fix baseline | High | Baseline berasal dari commit startup fix sebelum audit read-only. |
| Type/build baseline | Pass | `npm run typecheck`, `npm run build` | High | Dijalankan ulang pada setiap batch yang menyentuh source/runtime. |
| Dependency audit | 0 vulnerability | `npm audit --omit=dev --audit-level=high` | High for this threshold | Tidak membuktikan business-logic atau zero-day safety. |

## Findings

| ID | Location | Category | Finding | Evidence | Confidence | Benefit | Effort | Risk | Status |
|---|---|---|---|---|---:|---:|---:|---:|---|
| EFF-001 | `src/services/collaboration-service.ts:470-479` | Redundancy / branch simplification | Return ternary memiliki dua cabang identik. | `result.changes === 1 ? this.getPoll(pollId, now) : this.getPoll(pollId, now)` | High | Low–medium | Low | Low | `APPLIED` |
| EFF-002 | `src/services/event-service.ts:420-425,636-673` | Data-flow / query efficiency | `listEvents()` sebelumnya mengambil daftar event lalu menjalankan query phases/count per row; kini memakai bounded prefetch. | Benchmark 25 event: 51 → 3 statement/list; 1,38634 → 0,38870 ms/list pada fixture sintetis. | High | Medium | Medium | Medium | `APPLIED_AFTER_BENCHMARK` |
| EFF-003 | `tests/helpers/fake-whatsapp.js` dan tiga test representative | Test maintenance / duplication | Shared fake WhatsApp factory sudah dibuat dan dipakai pada tiga test yang bentuknya identik. | 54 baris fixture lokal dihapus pada migration pertama; fixture khusus/failure/media belum dipaksa migrasi. | High | Medium | Medium | Low–medium | `APPLIED_PARTIAL` |
| EFF-004 | 19 file source yang membuka `better-sqlite3` | Repeated infrastructure setup | Constructor, WAL, synchronous, foreign keys, busy timeout, dan migration lifecycle berulang pada domain services. | 19 `new Database`, 19 WAL pragma, 18 busy timeout. | High | Medium | High | High | `NEEDS_REVIEW` |
| EFF-005 | `src/framework/plugins/utility.ts`, `src/framework/plugins/utility-fun.ts` | Module cohesion / maintainability | Fun registration dipisahkan ke modul cohesive sementara public `utilityPlugin` boundary tetap dipertahankan. | Command parity guard mengunci 21 canonical utility commands dan alias `dice`/`suit`. | High | Medium | Medium | Medium | `APPLIED` |
| EFF-006 | Banyak service domain; pembanding `src/platform/guardrails.ts:319-440` | Helper duplication / boundary | Helper hash, JID validation, bounded text, dan audit preparation sebagian berulang; sebagian sudah memiliki shared guardrail boundary. | 11 local hash helper definitions; constraints dan error semantics tidak identik. | Medium | Medium | High | High | `NEEDS_MORE_EVIDENCE` |
| EFF-007 | `src/whatsapp.ts:1-1014` | File size / adapter cohesion | Adapter adalah file terbesar dan memiliki branch-like heuristic tinggi. | 1,014 lines, heuristic branch signal 166, nesting 6. | High for size, low for refactor safety | Medium | High | High | `DO_NOT_CHANGE` |
| EFF-008 | `src/services/event-service.ts`, `announcement-service.ts`, `collaboration-service.ts` | Intentional scheduling complexity | Dispatcher, idempotence, retry/timeout, stale operation, partial send, dan audit paths terlihat berulang secara bentuk. | Masing-masing domain memiliki state transition dan recovery semantics yang berbeda. | High | Low for generic abstraction | High | High | `INTENTIONALLY_COMPLEX` |

## Detailed Findings

### EFF-001 — Ternary return redundant pada poll transport

**Lokasi:** `src/services/collaboration-service.ts:470-479`, method `updatePollTransport`.

**Kategori:** Redundancy dan branch simplification.

**Evidence:** Setelah update dan audit, method mengembalikan `this.getPoll(pollId, now)` baik ketika `result.changes === 1` maupun ketika kondisi tersebut false. Nilai `result.changes` hanya dipakai untuk memilih dua ekspresi yang sama.

**Why it may be excessive:** Branch tersebut tidak menambah behavior, informasi, atau error handling. Ia menambah cognitive load dan membuat pembaca mencari perbedaan yang tidak ada.

**Behavior to preserve:** Validasi group/feature/id/actor, optimistic revision update, audit outcome, dan fakta bahwa method saat ini mengembalikan current poll record baik update berhasil maupun stale. Jangan mengubah semantics menjadi `undefined` pada stale tanpa keputusan API baru.

**Suggested simplification:** Jalankan statement update dan audit seperti sekarang, lalu gunakan satu `return this.getPoll(pollId, now)`. Alternatif yang lebih eksplisit adalah menghapus variable `result` bila return value update memang tidak diperlukan.

**Trade-offs:** Mengurangi branch noise, tetapi tidak memberi runtime performance yang berarti. Perubahan tetap harus mempertahankan audit pada stale update dan test concurrent/revision.

**Confidence:** HIGH.

**Regression risk:** LOW, selama semantics current-poll pada stale update dipertahankan.

**Refactor safety:** `LIKELY_SAFE`, tetapi status audit tetap `RECOMMEND` karena belum diberi otorisasi untuk edit.

**Verification plan:** Tambahkan/pertahankan test native-sent/native-failed untuk update sukses, revision stale, poll closed, group mismatch, dan audit outcome. Jalankan typecheck, focused collaboration tests, full test, diff check.

### EFF-002 — N+1 query pada event calendar

**Lokasi:** `src/services/event-service.ts:420-425` dan `636-658`.

**Kategori:** Data-flow dan database efficiency.

**Evidence:** `listEvents()` menjalankan query event terbuka. Setiap row kemudian dipetakan oleh `mapEvent()`. Mapper menjalankan satu query `event_phases` dan satu query `COUNT(*)` ke `event_participants`. Dengan limit default `25`, jalur list dapat menjalankan hingga 51 statement database.

**Why it may be excessive:** Jumlah query tumbuh linear terhadap jumlah event, sementara data dapat diambil dengan prefetch/batch query. Ini meningkatkan round-trip ke SQLite handle, parsing statement, dan latency list. Static evidence membuktikan bentuk N+1, tetapi belum membuktikan dampak pada workload Panel.

**Behavior to preserve:** Group scoping, status exclusion, order `start_at ASC, id ASC`, limit phases, phase order, participant count yang hanya menghitung `status = 'joined'`, serta output field dan error semantics.

**Suggested simplification:** Tambahkan jalur `mapEvents(rows)` yang mengambil phases untuk semua event IDs dan participant counts dengan query agregat/prefetch terbatas, lalu menggabungkan berdasarkan `event_id`. Alternatif paling konservatif adalah hanya mengoptimalkan `listEvents()` dan membiarkan `getEvent()` memakai mapper single-record. Jangan mengubah `mapEvent()` global sebelum call sites dan tests dipetakan.

**Trade-offs:** Query count turun, tetapi code mapping menjadi sedikit lebih panjang dan memerlukan grouping yang benar. Query `IN (...)` harus memakai placeholders terparameterisasi, tetap bounded oleh `maxListLimit`, dan menjaga ordering. Perlu test empty list, satu event, limit 25, event tanpa phase, participant status left, group isolation, dan duplicate IDs.

**Confidence:** HIGH untuk adanya N+1; MEDIUM untuk benefit nyata karena belum ada benchmark workload.

**Regression risk:** MEDIUM; risiko utama adalah salah grouping, salah count, atau perubahan urutan output.

**Refactor safety:** `LIKELY_SAFE` setelah benchmark dan contract tests; `NEEDS_REVIEW` saat ini.

**Verification plan:** Instrument fake/SQLite statement count sebelum/sesudah, benchmark 0/1/10/25 event, jalankan event tests dan full suite, lalu review query plan serta group/tenant isolation.

### EFF-003 — Duplikasi fake WhatsApp adapter pada test

**Lokasi:** Sedikitnya 29 file di `tests/`, termasuk `framework.test.js`, `group.test.js`, `r3-collaboration.test.js`, `r4-knowledge.test.js`, `r5-personalization.test.js`, `r6-scene.test.js`, `r7-canon.test.js`, `r8-group-governance.test.js`, dan `r9-event.test.js`.

**Kategori:** Test maintenance dan duplication.

**Evidence:** Test mengulang listener set, `sendText`, metadata group, `start`, `close`, dan emit helper dengan variasi kecil. Static grep menemukan 84 matching snippets pada 29 file.

**Why it may be excessive:** Perubahan kontrak `WhatsAppPort` harus diperbarui pada banyak fixture. Duplikasi juga membuat satu test dapat memiliki behavior fake yang berbeda tanpa sengaja.

**Behavior to preserve:** Setiap test harus tetap dapat mengatur metadata, sent messages, connection state, group participants, optional media methods, failure injection, dan lifecycle sesuai kebutuhan. Jangan menghapus kemampuan fixture yang memang digunakan oleh test tertentu.

**Suggested simplification:** Buat helper test-only seperti `tests/helpers/fake-whatsapp.js` dengan default capability minimal dan override options. Migrasikan bertahap hanya fixture yang bentuknya sama; pertahankan fixture khusus untuk tests yang menguji failure atau media. Tambahkan contract test helper terhadap subset `WhatsAppPort` yang digunakan.

**Trade-offs:** Mengurangi duplication dan maintenance cost, tetapi shared mutable fixture dapat membuat tests lebih sulit dibaca atau menimbulkan state leakage. Factory baru harus mengembalikan state terisolasi per test, bukan singleton.

**Confidence:** HIGH untuk duplication; MEDIUM untuk benefit karena migration effort cukup besar.

**Regression risk:** LOW–MEDIUM, terutama test isolation dan method optionality.

**Refactor safety:** `LIKELY_SAFE` secara bertahap; `RECOMMEND` untuk patch terpisah.

**Verification plan:** Migrate satu kelompok test terlebih dahulu, jalankan test berulang dalam urutan berbeda jika tersedia, pastikan cleanup listener/state, lalu full suite dan type/build CI.

### EFF-004 — Repeated SQLite setup lintas domain service

**Lokasi:** 19 file source yang memanggil `new Database()`, termasuk `storage.ts`, service domain, dan `group-setup-mission.ts`.

**Kategori:** Repeated infrastructure setup.

**Evidence:** Terdapat 19 constructor `new Database`, 19 WAL pragma, dan 18 `busy_timeout` pragma. Namun `CharacterService` sengaja memakai file database domain terpisah, sementara sebagian service memakai core database; beberapa service juga memiliki foreign keys atau lifecycle/transaction semantics yang berbeda.

**Why it may be excessive:** Konfigurasi SQLite yang identik dapat drift. Perbaikan bug seperti startup dependency menunjukkan bahwa identifier/lifecycle kecil dapat berdampak besar; setup helper bersama dapat mengurangi copy-paste.

**Behavior to preserve:** Path database, `:memory:` handling, WAL, synchronous mode, foreign keys, busy timeout, file mode, migration order, shutdown, transaction behavior, dan domain separation Character. Jangan membuka satu shared connection global tanpa analisis concurrency/lifecycle.

**Suggested simplification:** Pertimbangkan helper internal `openSqliteDatabase(path, options)` yang hanya mengenkapsulasi mkdir dan pragma yang benar-benar identik, dengan options eksplisit untuk foreign keys, memory database, dan domain label. Jangan langsung melakukan migrasi seluruh service.

**Trade-offs:** Mengurangi boilerplate, tetapi menambah abstraction pada persistence boundary dan dapat menyamarkan perbedaan service. Benefit runtime kecil; benefit utama adalah consistency/maintenance.

**Confidence:** HIGH untuk duplication; LOW–MEDIUM untuk safety centralization.

**Regression risk:** HIGH karena menyentuh semua service initialization dan startup order.

**Refactor safety:** `SPECULATIVE`/`NEEDS_REVIEW`; bukan prioritas pertama.

**Verification plan:** Buat matrix konfigurasi setiap service, characterization test untuk path/memory/pragma/migration, fault test terhadap lock/busy timeout, startup/shutdown test, lalu benchmark ringan sebelum menyentuh production artifact.

### EFF-005 — Utility plugin besar tetapi masih satu registration boundary

**Lokasi:** `src/framework/plugins/utility.ts:303-600`, sekitar 605 lines.

**Kategori:** Module cohesion dan maintainability.

**Evidence:** File memuat command status/discovery/help, calculator/converter/time/date, dan fun command. `utilityPlugin` adalah satu public plugin dengan satu `load()` yang mendaftarkan semua command.

**Why it may be excessive:** Mencari command utility tertentu atau meninjau fun behavior memerlukan scanning file besar. Domain kecil dapat dipisah secara source-level tanpa mengubah public command names, tetapi belum ada bukti bahwa ukuran file mengganggu build/runtime.

**Behavior to preserve:** Canonical names, aliases, menu category/order, cooldown, bounded parser, safe error output, and command-copy mapping.

**Suggested simplification:** Pisahkan pure helpers dan registration groups menjadi modul `utility-system`, `utility-conversion`, dan `utility-fun`, lalu pertahankan satu composition plugin tipis atau register tiga plugin internal. Pilihan pertama lebih konservatif karena public plugin boundary tetap satu.

**Trade-offs:** Readability meningkat, tetapi jumlah file/import bertambah. Jika terlalu banyak helper diekstrak, indirection justru naik. Tidak ada klaim bundle/runtime improvement tanpa measurement.

**Confidence:** MEDIUM.

**Regression risk:** MEDIUM karena command registry order/duplicate alias harus tetap konsisten.

**Refactor safety:** `LIKELY_SAFE` setelah registration contract test; `RECOMMEND` sebagai maintenance patch terpisah, bukan hotfix.

**Verification plan:** Snapshot canonical command names/aliases/categories/menuOrder sebelum-sesudah, focused utility tests, full suite, typecheck/build, dan manual source review.

### EFF-006 — Local hash/validation helpers sebagian berulang

**Lokasi:** Banyak `src/services/*-service.ts`; shared comparison `src/platform/guardrails.ts:319-440`.

**Kategori:** Helper duplication dan boundary cohesion.

**Evidence:** Static count menemukan 11 local hash helper definitions. Shared guardrail sudah memiliki `hashIdentifier`, audit sanitization, identifier validation, outcome validation, dan metadata policy. Namun local helpers tidak identik: sebagian meng-hash JID, sebagian opaque event/poll IDs atau raw text, dengan panjang output dan validasi berbeda.

**Why it may be excessive:** Repeated cryptographic calls and validation shapes dapat drift atau memperbesar review surface. Akan tetapi menyatukan hash JID dengan hash arbitrary text dapat mengubah privacy/format contract atau membuat validasi terlalu ketat.

**Behavior to preserve:** Redaction policy, audit metadata limits, correlation identifiers, output length, no raw JID/message leakage, dan compatibility dengan stored audit records.

**Suggested simplification:** Buat matrix helper berdasarkan input class: `hashJidForAudit`, `hashOpaqueIdentifier`, dan `hashBoundedTextForCorrelation` hanya bila contract-nya memang sama. Reuse existing guardrail functions terlebih dahulu; jangan membuat generic `hash(value)` tanpa domain label.

**Trade-offs:** Deduplikasi dapat mengurangi drift, tetapi abstraction cryptographic/privacy yang salah memiliki risiko lebih besar daripada copy-paste yang terlihat. Perlu migration/versioning bila output hash berubah.

**Confidence:** MEDIUM untuk duplication; LOW untuk safe consolidation.

**Regression risk:** HIGH pada audit/history compatibility dan privacy.

**Refactor safety:** `SPECULATIVE`; `NEEDS_MORE_EVIDENCE`.

**Verification plan:** Inventory semua call site dan persisted fields, compare exact output contracts, security review, golden tests, audit redaction tests, dan migration decision sebelum edit.

## Recommended Order

| Urutan | Action | Alasan |
|---:|---|---|
| 1 | EFF-001: simplifikasi branch Collaboration. | Selesai; confidence tinggi, effort rendah, dan risiko rendah. |
| 2 | EFF-002: benchmark lalu prefetch Event. | Selesai; benefit terukur dan contract/group-isolation tests lulus. |
| 3 | EFF-003: shared fake WhatsApp fixture. | Selesai secara bertahap pada tiga test representative; migration penuh sengaja tidak dipaksakan. |
| 4 | EFF-005: split Utility fun module. | Selesai dengan public plugin boundary dan canonical parity tetap identik. |
| 5 | EFF-004 dan EFF-006. | Ditahan untuk architecture maintenance terpisah karena cross-cutting dan risiko tinggi. |
| 6 | EFF-007/EFF-008. | Tidak diubah; kompleksitas memiliki alasan domain/failure-containment yang valid. |

## Patch Plan

**Status patch:** Batch A-D diterapkan; audit final tetap menyisakan kandidat cross-cutting yang sengaja belum disentuh.

1. Batch A menerapkan simplifikasi `updatePollTransport` dan coverage native sent/failed.
2. Batch B menginstrumentasi benchmark lokal, lalu menerapkan prefetch bounded pada `listEvents()` setelah evidence mendukung.
3. Batch C membuat shared fake adapter factory dan memigrasikan tiga test representative; migration penuh tidak dipaksakan.
4. Batch D memisahkan fun registration dengan command parity guard, tanpa mengubah public plugin boundary.
5. Setiap batch memakai commit, CI, sanitized artifact, dan SHA-256 Panel verification terpisah.

## Verification Results

| Check | Command/Method | Result | Evidence | Limitation |
|---|---|---|---|---|
| Repository inventory | `codebase_inventory.py` | passed | 248 files, 40,378 counted lines | Inventory tidak membuktikan usage/dead code. |
| Heuristic complexity | `complexity_signals.py` | passed | Top signals teridentifikasi pada service besar dan adapter | Parser heuristic; branch/nesting dapat overcount. |
| Dependency reachability | Static import grep + `package.json` review | passed | 11 direct runtime dependencies memiliki call site yang ditemukan | Dynamic import/reflection tidak terbukti lengkap. |
| Typecheck baseline | `npm run typecheck` | passed | Baseline startup-fix validation | Tidak menguji live Panel. |
| Build baseline | `npm run build` | passed | Dist berhasil dibangun dari source | Build success bukan runtime acceptance. |
| Full regression baseline | `npm test` | passed | 304/304 sebelum batch; 306/306 setelah Batch D | Fake adapters tidak membuktikan live WhatsApp. |
| Dependency audit | `npm audit --omit=dev --audit-level=high` | passed | 0 vulnerability pada threshold tersebut | Tidak mencakup business logic/zero-day. |
| Diff hygiene | `git diff --check` | passed | Batch A-D lulus diff hygiene sebelum commit | Dokumen rekonsiliasi memiliki perubahan terpisah. |
| Runtime self-check | `npm run self-check` | passed | Compiled storage integrity check pass | Tidak menyalakan WhatsApp. |
| Runtime benchmark Event N+1 | Temporary synthetic benchmark | passed | 25 event × 500 list calls: 51 → 3 statements/list; 1,38634 → 0,38870 ms/list | Synthetic local result; bukan Panel/live workload guarantee. |
| Live Panel performance/profile | Tidak tersedia dalam audit ini | blocked | Tidak melakukan active profiling produksi | Tidak ada klaim runtime gain. |
| Live WhatsApp acceptance | Ditunda sesuai scope | blocked | Acceptance account belum tersedia | Baileys/WhatsApp behavior tetap residual risk. |

## Regression and Risk Review

Review mempertahankan public command names, aliases, permissions, feature gates, audit outcomes, persistence schemas, SQLite domain separation, media/AI boundaries, and deployment artifact policy. Tidak ada rekomendasi yang menghapus security control, validation, timeout, retry, audit, or authorization hanya demi mengurangi baris.

Dynamic usage dipertimbangkan pada service registry, plugin manager, command registry, composition root, dan public command registrations. Test fixtures memiliki variasi capabilities; karena itu shared fake adapter tidak boleh dipaksakan pada fixture media, failure injection, atau connection lifecycle yang berbeda.

N+1 optimization memiliki risiko data-integrity dan tenancy bila query batch lupa `group_jid`, salah melakukan `IN` placeholders, atau menghitung participant status yang salah. SQLite setup centralization memiliki risiko lebih tinggi karena `CharacterService` memakai domain database terpisah dan service lain memiliki perbedaan pragmas/lifecycle. Hash helper centralization memiliki risiko privacy/audit compatibility bila output berubah.

Tidak ada perubahan UI/DOM/CSS pada repository ini. Accessibility/browser review tidak relevan untuk source bot, kecuali nanti terdapat panel/web frontend terpisah.

## Intentionally Complex Code

| Component | Alasan kompleksitas dipertahankan |
|---|---|
| `src/whatsapp.ts` | Adapter boundary Baileys, inbound normalization, media descriptor/download/send, callback compatibility, group operations, reconnect, dan redaction berada pada trust boundary yang sensitif. Splitting memerlukan characterization/contract tests. |
| `src/services/event-service.ts` | Multi-phase lifecycle, idempotent operations, CAS revision, dispatcher recovery, participant limits, linked poll, notification policy, dan timeout failure handling adalah domain behavior, bukan sekadar boilerplate. |
| `src/services/announcement-service.ts` | Explicit target, approval, cancellation, queued/partial/failed states, expiry, retry, and audit are necessary to avoid accidental broadcast semantics. |
| `src/services/collaboration-service.ts` | Poll/vote/reminder/task/decision workflows share a domain but have distinct state and concurrency rules. Only local no-op branch is a good simplification candidate. |
| `src/platform/guardrails.ts` | Shared policy/rate/circuit/audit boundary; adding another generic abstraction outside it would likely increase indirection. |
| Multiple domain services | Separate services make feature gates, ownership, migrations, and audit responsibilities visible. Centralizing all persistence prematurely would reduce failure isolation. |

## Unverified Areas

Benchmark lokal membuktikan biaya query dan timing turun pada fixture sintetis 25 event, tetapi belum membuktikan latency workload aktual di Panel. Audit juga tidak dapat membuktikan dead code melalui static grep saja karena registry/plugin/alias behavior bersifat dynamic dan public consumers dapat berada di luar repository.

Tidak dilakukan cleanup dependency, install/update, centralization SQLite, hash-helper consolidation, runtime restart baru, atau live WhatsApp command sebagai bagian Batch A-D. Artifact deployment dilakukan oleh CI sesuai policy; tidak ada klaim bahwa Panel startup incident teratasi hanya dari audit efficiency. Incident tersebut memiliki patch terpisah pada commit `182d9b9`.

## Next Actions

Batch A-D telah selesai. Langkah lanjutan yang masih bernilai adalah memperluas migrasi shared fake fixture hanya bila variasi capability dapat dimodelkan tanpa state leakage, serta membuat architecture review terpisah untuk EFF-004 dan EFF-006. Centralization SQLite dan hash/audit helper tidak boleh dilakukan hanya demi mengurangi baris; keduanya memerlukan compatibility matrix, security review, dan rollback plan.

## References

1. [Repository commit `182d9b9`](https://github.com/leenthequestmaster-code/Allybot/commit/182d9b9) — baseline startup dependency fix yang menjadi titik observasi audit.
2. [Batch A commit `362b07e`](https://github.com/leenthequestmaster-code/Allybot/commit/362b07e687f9369f03fa65e4653d5bf6d3586a85) — Collaboration branch simplification.
3. [Batch B commit `01bce24`](https://github.com/leenthequestmaster-code/Allybot/commit/01bce242deeb104cf638b8c4f4a8a457361e47e8) — Event prefetch optimization.
4. [Batch C commit `9b6800e`](https://github.com/leenthequestmaster-code/Allybot/commit/9b6800ebf7c4112dce942104af59f7acb9f64bbf) — shared fake WhatsApp fixture.
5. [Batch D commit `b914c1c`](https://github.com/leenthequestmaster-code/Allybot/commit/b914c1c720b03a2e09020a2d020c4f0d3c64c8df) — utility fun module split.
2. [Efficiency Coding Writer skill](file:///home/ubuntu/skills/efficiency-coding-writer/SKILL.md) — workflow, safety classification, dan output contract yang digunakan.
3. [Allybot service registry](../src/framework/service-registry.ts) — dependency graph dan plugin/service lifecycle contract.
4. [Allybot platform guardrails](../src/platform/guardrails.ts) — shared policy, audit, validation, dan redaction boundary.
