# Security dan Operasional

## Boundary keamanan

- Owner/admin/group owner diverifikasi melalui `src/permissions.ts`; jangan menganggap sender text sebagai identitas tepercaya.
- Command developer observer dibatasi private chat; command moderator memakai group admin permission.
- `src/framework/middleware.ts` adalah gate bersama untuk permission, validation, dan cooldown.
- Credential dan key material disimpan di SQLite lokal dengan directory mode 0700; `data/`, `.env`, session, dan database tidak boleh masuk git.
- Supabase service-role, Neon URL, Upstash token, Xkiro key, dan Sentry DSN hanya boleh berada di environment server.
- Codebase export harus tetap feature-gated, dibatasi ukuran, ZIP signature-checked, tidak symbolic link, dan hanya dikirim melalui developer permission.

## Privacy

- Chat logging Neon harus feature-gated dan group-scoped melalui konfigurasi consent.
- AI prompt tidak boleh mengungkap system instruction, credential, source private, database, session, atau internal data.
- Jangan menulis raw message, token, JID sensitif, atau evidence penuh ke log atau dokumentasi.

## Failure policy

- Command failure harus menghasilkan fallback reply yang aman tanpa membocorkan error internal.
- Uncaught exception/unhandled rejection memicu graceful shutdown dan Sentry capture bila aktif.
- External integration failure harus fail safely; fitur non-esensial tidak boleh merusak local foundation.

## Validasi wajib

| Perubahan | Validasi minimum |
|---|---|
| Source umum | `npm run typecheck`, `npm run build`, `npm test` |
| Platform/permission | minimum di atas + test platform/R-series terkait |
| Integrasi eksternal | script `verify:*` relevan di staging, tanpa credential di repo |
| Release artifact | CI sanitization, checksum, ZIP test, forbidden-file scan |

## Red flags

- `npm test` tidak 100% lulus.
- `npm run typecheck` atau build gagal.
- Perubahan permission tanpa regression test lintas private/group.
- SQL tanpa parameter binding, path filesystem dari input tanpa containment check, atau logging object yang mungkin berisi credential.
- Mengaktifkan feature flag external service tanpa verifikasi schema dan timeout.

## Residual risks

Validasi lokal tidak membuktikan koneksi WhatsApp, Supabase, Neon, Upstash, Xkiro, atau Sentry di deployment produksi. Jalankan pemeriksaan staging yang sesuai sebelum rollout.