# Sentry debugging and observability fix — 2026-08-29

## Scope

Sentry project `allybot-acceptance` pada organisasi `allyssea` memiliki satu unresolved issue `ALLYBOT-ACCEPTANCE-1` dengan 14 occurrence, 0 affected users, dan low Seer actionability. Events berasal dari release `c6433e2`, environment `acceptance`, dengan operation tags `plugin:group-moderation` dan `plugin:character-guide`.

## Diagnosis

Issue tidak menyediakan stack trace, culprit, atau exception message yang asli. Allybot sengaja menggunakan `captureMessage('Allybot operational event')` dan `beforeSend` membatasi event untuk privacy. Karena semua operational errors memakai message yang sama, event dari beberapa operation ter-group menjadi satu issue. Seer analysis timed out dan tidak ada bukti cukup untuk memperbaiki logic plugin secara aman.

## Autofix applied

Serena menambahkan Sentry fingerprint deterministik di `src/sentry.ts` berdasarkan fixed prefix, safe operation, error class, dan optional error code. Perubahan ini tidak mengirim raw error message, stack trace, user payload, JID, token, atau session. Tujuannya memisahkan issue Sentry yang sebelumnya tercampur dan membuat issue berikutnya lebih actionable tanpa melemahkan privacy boundary.

## Decision

Jangan mengubah `group-moderation` atau `character-guide` berdasarkan issue ini saja. Root cause plugin belum terbukti; issue kemungkinan merupakan instrumentation grouping problem atau acceptance failure yang detailnya sudah disanitasi. Setelah deployment berikutnya, cari issue baru dengan filter operation dan fingerprint, lalu gunakan Serena untuk menelusuri source hanya jika event sudah memuat error class/code yang cukup spesifik.

## Validation workflow

Run `npm --silent run agent-cli -- check --json`. Expected checks: typecheck, build, full test, self-check, and platform parity all pass. Do not commit or push this change until the user confirms.
