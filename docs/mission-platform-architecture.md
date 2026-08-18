# Allybot Mission Platform

## Keputusan arsitektur

Mission Engine dan Mission Studio diposisikan sebagai satu kesatuan bernama **Allybot Mission Platform**. Keduanya bukan dua proyek yang berdiri sendiri.

- **Mission Runtime** adalah inti eksekusi workflow. Ia menjalankan state machine, menyimpan state, memvalidasi input, menangani expiry, ownership, idempotency, optimistic concurrency, recovery, dan menghasilkan response.
- **Mission Authoring** adalah lapisan Studio. Ia membuat, memvalidasi, menampilkan preview, mengaktifkan, menjeda, mengganti versi, dan mengaudit workflow.
- **Mission Adapter** adalah bridge ke framework WhatsApp. Ia memetakan command/event/message menjadi input mission dan mengirimkan response melalui `WhatsAppPort`.
- **Mission Governance** membatasi siapa yang dapat membuat atau menjalankan workflow serta action apa yang boleh digunakan.

Nama produk/platform yang dipakai pada dokumentasi dan public entrypoint adalah **Allybot Mission Platform**. Nama `MissionEngine` tetap dipertahankan pada level class/API internal agar tidak memecahkan compatibility.

## Mengapa disatukan

Secara fungsi, Studio dan Engine memiliki satu lifecycle yang sama: workflow didefinisikan, divalidasi, dipublish, dieksekusi, dipantau, diselesaikan, atau dihentikan. Memisahkannya sebagai dua project independen akan menambah boundary, sinkronisasi version, dan potensi kontrak ganda yang tidak diperlukan.

Pemisahan yang tetap dipertahankan adalah pemisahan **modul dan tanggung jawab**, bukan pemisahan produk. Dengan model ini, Engine dapat digunakan oleh built-in mission seperti Group Setup, sementara Studio dapat menambah authoring capability tanpa menyalin persistence atau concurrency logic.

## Diagram konseptual

```text
WhatsApp messages / group events / scheduled triggers
                         │
                         ▼
                Mission Adapter Layer
                         │
        ┌────────────────┴────────────────┐
        │                                 │
        ▼                                 ▼
Mission Authoring                    Mission Runtime
(Studio)                              (Engine)
- draft                              - state machine
- validate                           - transition
- preview                            - persistence
- publish                            - expiry
- version                            - idempotency
- pause/resume                       - recovery
        │                                 │
        └────────────────┬────────────────┘
                         ▼
                Mission Governance
       permission · action allowlist · quotas
                         │
                         ▼
              SQLite / event sink / logger
```

## Modul yang dipertahankan

| Modul saat ini | Peran dalam Mission Platform | Keputusan |
|---|---|---|
| `platform/mission.ts` | Mission Runtime core | Dipertahankan; tidak rewrite. |
| `platform/sessions.ts` | Interaction/session state | Dipakai ulang untuk wizard dan approval. |
| `platform/operations.ts` | Timeout, retry, permission, operation events | Dipakai untuk action execution. |
| `platform/permission.ts` | Permission decision | Menjadi boundary governance. |
| `platform/events.ts` | Platform event sink | Menjadi dasar audit dan observability. |
| `framework/plugins/group-setup-mission.ts` | Existing Mission Adapter | Dipertahankan sebagai built-in adapter dan compatibility test. |
| `platform/group-setup.ts` | Built-in mission definition | Dipertahankan sebagai reference implementation. |
| `platform/framework-adapter.ts` | Framework bridge | Dipakai untuk adapter baru. |
| `platform/interaction.ts` | Text interaction | Dipakai oleh Studio wizard dan fallback. |
| `platform/buttons.ts` | Native interaction | Opsional untuk wizard jika client mendukung; fallback teks wajib. |

## Modul baru yang dibutuhkan secara bertahap

### Mission definitions

`MissionDefinition` tetap menjadi bentuk runtime yang dieksekusi Engine. Workflow yang dibuat user tidak boleh langsung menghasilkan arbitrary callback JavaScript. Studio harus menghasilkan **declarative definition** yang divalidasi lalu dikompilasi atau diinterpretasikan melalui action registry.

### Action registry

Action registry berisi action aman yang dapat dipanggil workflow. Versi awal hanya boleh memuat action yang deterministic dan mudah diaudit:

| Action | Keterangan |
|---|---|
| `send_text` | Mengirim teks dengan template tervalidasi. |
| `request_input` | Meminta input berikutnya melalui state transition. |
| `request_approval` | Menunggu persetujuan actor yang berwenang. |
| `create_record` | Menulis record domain melalui repository yang ditentukan. |
| `append_audit` | Menambah event audit tanpa menulis file arbitrer. |
| `complete_mission` | Menyelesaikan workflow. |
| `cancel_mission` | Membatalkan workflow dengan ownership/policy check. |

Action seperti `eval`, `execute_shell`, arbitrary HTTP, arbitrary file write, dynamic import, dan plugin mutation tidak boleh ada dalam registry.

### Workflow definition

Studio perlu memiliki schema declarative dengan bagian berikut:

```text
id
version
name
description
trigger
permission
states
transitions
actions
expiry
retryPolicy
limits
```

Schema harus memiliki batas panjang, jumlah state, jumlah transition, jumlah action, recursion/depth, dan ukuran data. Definition yang tidak valid harus ditolak sebelum disimpan atau dipublish.

### Draft, publish, dan version

Workflow baru dimulai sebagai `draft`. Hanya definition berstatus `published` yang dapat dieksekusi. Perubahan pada workflow membuat version baru; execution yang sedang berjalan tetap memakai version yang sudah tercatat pada `MissionRecord`.

Status minimal:

```text
draft → validated → published → paused → archived
                         │
                         └──────────────→ disabled
```

Tidak boleh mengedit definition published secara in-place. Untuk emergency, workflow dapat di-pause atau di-disable tanpa menghapus histori execution.

### Governance

Governance adalah bagian dari platform, bukan fitur tambahan belakangan. Policy minimal mencakup creator, reviewer, publisher, executor, cancellation authority, group scope, quota, expiry maksimum, dan action allowlist.

Workflow yang membuat tindakan moderasi atau mengubah data sensitif harus membutuhkan approval atau role yang lebih tinggi. Runtime wajib melakukan permission recheck saat execution, bukan hanya saat workflow dibuat.

## MVP terpadu

MVP tidak berupa editor workflow bebas. MVP terdiri dari satu platform dengan dua built-in template dan satu wizard authoring terbatas:

1. **Moderation Case Workflow**: report → collect evidence → moderator review → approve/reject → close.
2. **Approval Workflow**: request → reviewer approval/rejection → notification → complete.
3. **Studio wizard terbatas**: membuat workflow hanya dari trigger, state, dan action yang sudah tersedia dalam allowlist.

MVP harus membuktikan bahwa workflow dapat dibuat, divalidasi, dipublish, dijalankan, dilanjutkan setelah restart, dibatalkan, di-expire, dan diaudit.

## Roadmap implementasi

| Fase | Cakupan | Hasil |
|---|---|---|
| **MP-0 Contract** | Public naming, schema, action registry, policy, limits | Contract dan threat model disepakati. |
| **MP-1 Runtime hardening** | Definition version check, action execution boundary, audit event, quotas | Engine siap menerima declarative workflow. |
| **MP-2 Built-in workflows** | Moderation case dan approval workflow | Nilai produk terlihat tanpa editor bebas. |
| **MP-3 Studio wizard** | Draft, validate, preview, publish, pause, cancel | Admin dapat membuat workflow terbatas melalui WhatsApp. |
| **MP-4 Governance** | Reviewer/publisher, versioning, rollback, kill switch, per-group feature flag | Operasi workflow aman untuk production. |
| **MP-5 Expansion** | More triggers/actions, dashboard optional, templates | Platform dapat berkembang tanpa mengubah runtime core. |

## Compatibility dan non-breaking policy

Perubahan awal tidak boleh mengganti `MissionEngine`, `MissionStore`, `MissionDefinition`, atau Group Setup behavior. API baru ditambahkan secara additive, misalnya `MissionDefinitionRegistry`, `MissionActionRegistry`, `MissionWorkflowStore`, dan `MissionGovernancePort`.

`Group Setup Mission` harus tetap lulus seluruh test yang ada, termasuk persistence reload, actor ownership, admin recheck, expiry, idempotency, dan failure behavior. Jika Mission Studio belum siap, built-in missions tetap berjalan melalui Engine yang sekarang.

## Definition of Done

Mission Platform belum boleh dianggap siap jika belum memiliki schema validation, action allowlist, permission recheck, version pinning, audit trail, expiry, idempotency, concurrency handling, input/resource limits, recovery test, rollback/disable path, dan fallback text interaction.

Setiap perubahan harus melewati architecture review, threat model review, unit/integration tests, typecheck, build, platform parity, CI artifact, deployment verification, dan smoke test workflow di WhatsApp nyata.

## Urutan pengerjaan resmi

Mission Platform **tidak termasuk Batch Update reguler** dan tidak dikerjakan pada fase audit existing saat ini. Urutan kerja yang disepakati adalah:

```text
Audit + improvisasi fitur existing
        ↓
Seluruh Batch Update fitur baru
        ↓
Allybot Mission Platform sebagai proyek independen
```

Dengan demikian, Mission Platform tetap memiliki desain dan roadmap sendiri, tetapi implementasinya ditunda sampai seluruh batch fitur selesai. Tidak boleh ada fitur batch yang diam-diam bergantung pada Mission Platform sebelum platform tersebut resmi dimulai.

## Keputusan akhir

Mission Engine dan Mission Studio resmi diperlakukan sebagai **satu platform dengan dua lapisan**:

> **Mission Platform = Mission Runtime + Mission Authoring + Adapter + Governance.**

Kita tidak melakukan rewrite besar. Engine saat ini menjadi core yang stabil; Studio ditambahkan secara bertahap di atasnya. Implementasi berikutnya sebaiknya dimulai dari MP-0 Contract, bukan langsung membuat wizard atau editor bebas.
