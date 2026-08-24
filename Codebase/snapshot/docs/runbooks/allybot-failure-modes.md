# Allybot Failure Modes Runbook

## Cara menggunakan

Runbook ini dipakai setelah signal bounded menunjukkan failure. Operator harus mengumpulkan commit SHA, deployment artifact checksum, framework phase, connection status, failure class, dan correlation ID yang aman. Jangan menyalin raw log, message content, credential, session, raw identifier, atau database dump ke issue atau chat.

Urutan umum adalah **confirm → contain → preserve evidence → diagnose → recover → verify**. Jika failure berhubungan dengan database, audit, credential, atau Panel state, hentikan tindakan destruktif dan gunakan jalur recovery yang terdokumentasi.

## Framework tidak ready atau startup gagal

**Indikasi.** Framework phase berada pada `failed`, `stopping`, atau tidak mencapai `ready`; service/plugin failure event muncul; connection tidak menjadi `connected`.

**Tindakan.** Periksa `ApplicationFramework.state`, service dependency order, plugin state, dan failure class. Pastikan cleanup sudah dijalankan. Jalankan local `npm run self-check` atau test fixture bila masalah dapat direproduksi tanpa production state. Jika failure berasal dari artifact, hentikan rollout dan kembali ke artifact terakhir yang telah diverifikasi.

**Larangan.** Jangan memperbaiki dengan menjalankan arbitrary command pada Panel, jangan mengubah locked Startup Command, dan jangan menghapus database atau audit record.

## Permission atau Developer Mode ditolak

**Indikasi.** Command menghasilkan outcome `denied`, khususnya `bot.owner`, `group.admin`, `group.owner`, atau `developer.mode.observer`.

**Tindakan.** Verifikasi command permission declaration, central resolver, private-chat boundary Developer Mode, scope, expiry, dan feature flag. Gunakan test `tests/permissions.test.js` atau `tests/developer-mode.test.js` dengan synthetic identity. Jika group metadata lookup gagal, perlakukan sebagai deny/failure, bukan allow.

**Larangan.** Jangan memindahkan authorization ke handler ad hoc, jangan mencetak identifier mentah, dan jangan mengubah Developer Mode menjadi role independen.

## Guardrail audit unavailable atau policy denied

**Indikasi.** `GuardrailPolicyRegistry` menolak policy/action/scope; `PlatformGuardrailService` mengembalikan `Guardrail audit unavailable`; rate profile limited; provider circuit open.

**Tindakan.** Pertahankan fail-closed behavior. Periksa storage initialization, audit hot/archive capacity, policy registration, feature flag version, rate profile, dan circuit state pada fixture. Bila provider gagal, tunggu cooldown atau gunakan recovery state yang bounded; jangan melakukan retry manual tanpa policy.

**Larangan.** Jangan mematikan sanitizer, mengubah outcome agar tampak sukses, atau menghapus audit archive untuk mengatasi overflow.

## Announcement duplicate, stale, atau partial delivery

**Indikasi.** Preview/approve/cancel mengembalikan `duplicate`, `stale_operation`, `expired`, `limited`, `partial`, atau `failed`.

**Tindakan.** Catat operation reference hash dan revision, bukan isi body atau raw target. Verifikasi expected revision, feature flag, quota, target status, expiry, claim state, dan transport failure code. Jalankan deterministic R11 tests dengan fake clock/transport. Target yang sudah `sent` tidak boleh dikirim ulang.

**Recovery.** Gunakan cancel/feature disable jika operasi masih queued dan sesuai authority. Jika state membutuhkan recovery, biarkan bounded recovery path menandai failure dan simpan audit outcome. Jangan mengubah row secara manual di production.

## Suggestion provider failure atau consent denied

**Indikasi.** Request mengembalikan `consent_required`, `source_not_found`, `provider_unavailable`, `in_progress`, atau `recovery_required`.

**Tindakan.** Verifikasi feature flag, scene/knowledge availability, consent `receive_assistance` dan `share_context`, approved source status, correlation duplicate, provider circuit, timeout, dan output normalizer. Provider failure harus menghasilkan bounded failure dan tidak membuat automatic announcement/canon mutation.

**Larangan.** Jangan mengirim context yang belum approved, jangan bypass consent, jangan menyalin request/output mentah ke log, dan jangan retry provider tanpa batas.

## Persistence, migration, atau integrity failure

**Indikasi.** `self-check` invalid, SQLite migration gagal, WAL/database unavailable, archive insert gagal, atau state revision tidak konsisten.

**Tindakan.** Stop rollout. Preserve evidence safely. Jalankan recovery rehearsal pada fixture atau backup yang telah disetujui, lakukan integrity check, dan verifikasi schema/index serta state invariants. Untuk audit overflow, pastikan hot/archive transaction rollback atau archive movement tetap konsisten.

**Larangan.** Jangan menghapus audit lama, jangan menjalankan broad cleanup, jangan mengganti database target, dan jangan melakukan migration contract/contract step tanpa rehearsal.

## Artifact atau deployment mismatch

**Indikasi.** CI verify gagal, archive berisi path di luar allowlist, checksum lokal/remote berbeda, upload multipart contract gagal, atau remote extraction tidak sesuai manifest.

**Tindakan.** Stop deployment dan simpan commit/artifact/checksum evidence. Rebuild dari commit yang sama, periksa allowlist `dist`, `package.json`, `package-lock.json`, dan `bash-exec-list.txt`, lalu jalankan checksum verification ulang. Jika masih gagal, revert workflow/artifact commit; jangan upload source langsung.

**Larangan.** Jangan mengubah checksum agar cocok, jangan mengubah Startup Command, jangan mengubah `.bash_profile`, dan jangan memulai power operation sebagai workaround.

## Recovery verification checklist

| Check | Expected |
|---|---|
| Framework lifecycle | Tidak ada listener/plugin/service cleanup yang tertinggal. |
| Authorization | Denied path tetap fail-closed. |
| Guardrail audit | Record sanitized; archive tidak hilang. |
| Stateful operations | Revision, idempotency, expiry, dan target/provider state konsisten. |
| Artifact | Allowlist dan checksum cocok. |
| Runtime | Health/readiness bounded dan tidak membuka data sensitif. |
| Rollback | Artifact atau feature disable path tersedia dan dapat dijalankan tanpa destructive cleanup. |

## Review trigger

Perbarui runbook setelah incident, perubahan failure code, perubahan audit schema, perubahan provider/adapter, perubahan storage/migration, perubahan CI/deployment contract, atau bukti baru yang menunjukkan procedure tidak dapat memulihkan state secara aman.
