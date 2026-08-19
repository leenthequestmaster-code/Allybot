# Allybot SQLite Recovery Runbook

## Scope

Runbook ini hanya untuk **fixture atau backup non-produksi yang telah disetujui**. Ia membuktikan bahwa runtime SQLite dapat dipulihkan ke file database baru, schema/index dapat dibaca kembali, MissionStore tetap konsisten, dan audit hot/archive tidak hilang. Ia tidak memberikan izin untuk menyalin database/session production ke repository, attachment, atau Panel.

## Preconditions

Pastikan commit SHA, Node.js 22, `package-lock.json`, schema source, dan lokasi fixture tercatat. Gunakan temporary directory dengan permission terbatas. Jangan masukkan `.env`, auth session, raw message, credential, raw log, atau PII ke fixture.

## Procedure

1. Buat fixture SQLite dengan schema runtime/service yang relevan, mission record representative, dan audit records scalar yang disanitasi.
2. Jalankan integrity check dan query bounded untuk memastikan table/index utama tersedia.
3. Hentikan writer pada fixture, lakukan WAL checkpoint yang aman, lalu tutup connection.
4. Salin file fixture ke file restore baru. Jangan melakukan copy terhadap database production yang sedang aktif tanpa prosedur backup resmi.
5. Buka file restore dengan `better-sqlite3`, instantiate `SqliteMissionStore` dengan namespace yang sama, dan jalankan migration idempotent.
6. Verifikasi mission record, revision, status, operation key, expiry, dan CAS invariants.
7. Verifikasi jumlah audit hot/archive serta urutan event. Pastikan record lama tetap tersedia di archive.
8. Jalankan integrity check ulang, lalu tutup seluruh connection.
9. Catat hasil, commit, Node version, schema expectation, dan residual unknown. Hapus temporary fixture setelah evidence sanitized tersimpan.

## Required assertions

| Assertion | Expected |
|---|---|
| Database opens | Success tanpa corruption error. |
| Schema migration | Idempotent dan additive untuk current schema. |
| Mission state | Record dapat dibaca dengan revision/status/data yang sama. |
| CAS/idempotency | Duplicate operation tidak menghasilkan transition kedua. |
| Audit hot/archive | Overflow memindahkan record lama ke archive; tidak ada deletion sebagai workaround. |
| Sensitive data | Fixture dan evidence tidak berisi raw identifier, session, credential, payload, atau database dump. |
| Rollback | Jika migration/integrity gagal, rollout berhenti dan file restore tetap menjadi fixture terisolasi. |

## Failure handling

Jika restore gagal, jangan mengedit file restore secara manual untuk membuat test lulus. Simpan error class yang telah disanitasi, bandingkan schema/migration source, dan lakukan root-cause analysis. Jika audit archive gagal ditulis, guardrail tetap fail-closed dan audit history harus dipertahankan. Jika production recovery diperlukan, operator harus memakai backup/Pterodactyl/database procedure yang disetujui secara terpisah; runbook ini tidak memberi otorisasi destructive operation.

## Verification anchor

Automated rehearsal berada pada `tests/recovery-rehearsal.test.js` dan menggunakan `SqliteMissionStore`, `PlatformGuardrailService`, WAL checkpoint, temporary copy, restore, mission verification, serta hot/archive count verification.
