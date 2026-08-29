# Audit Fixes — 2026-08-29

## Scope

Audit awal terhadap `main` menemukan satu regression terverifikasi pada group safety. Build, typecheck, self-check, platform parity, dan dependency audit sebelumnya lulus; `npm test` gagal pada satu assertion R1.

## Fix

`src/services/group-safety-service.ts` — fungsi `normalizeReason` sekarang melakukan normalisasi whitespace lalu menolak reason kosong, reason yang melebihi `maxReasonLength`, dan reason yang terlihat seperti credential. Sebelumnya fungsi memakai helper truncating sehingga input 241 karakter dipotong menjadi 240 karakter dan lolos, padahal kontrak moderasi dan test mensyaratkan rejection.

## Rationale

Reason moderasi adalah record audit, bukan cache display. Data audit tidak boleh kehilangan bagian akhir secara diam-diam. Rejection eksplisit mempertahankan integritas record dan membuat caller dapat meminta input yang lebih ringkas.

## Files

- `src/services/group-safety-service.ts` — symbol-level fix pada `normalizeReason`.
- `Knowledge Base/README.md` — entrypoint dan aturan AI.
- `Knowledge Base/00-architecture.md` — peta sistem dan invariants.
- `Knowledge Base/01-shortcuts.md` — shortcut navigasi dan diagnosis.
- `Knowledge Base/02-security-operations.md` — boundary keamanan dan validasi.

## Validation required

Run `npm run typecheck`, `npm run build`, `npm test`, `npm run self-check`, `npm run verify:platform`, lalu review `git diff` dan `git status --short`.

## Residual risk

Integrasi WhatsApp, Supabase, Neon, Upstash, Xkiro, dan Sentry tetap memerlukan verifikasi staging dengan credential yang benar. Perubahan ini tidak mengaktifkan feature flag atau mengubah schema eksternal.