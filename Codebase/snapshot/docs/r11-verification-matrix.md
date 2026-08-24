# R11 Verification Matrix — Consent Window Announcement dan Typed Suggestion Relay

R11 menerapkan dua operasi bounded di atas seam existing Allybot. **Consent Window Announcement** menyediakan preview, approval, expiry, explicit target set, quota, cancellation, idempotency, dan dispatcher bounded. **Typed Suggestion Relay** hanya membuat draft suggestion dari sumber Knowledge yang dipilih eksplisit dan consent Scene yang masih aktif; hasilnya tidak mengirim pesan, tidak mengubah canon, dan tidak membuat side effect eksternal selain pemanggilan provider yang sudah dikontrol.

| Invariant / risk | Verification | Evidence | Status |
|---|---|---|---|
| Feature flag default-off | Grup baru menolak preview announcement dan request suggestion sebelum admin mengaktifkan flag | `R11 announcement is default-off...`; `R11 suggestion relay requires explicit...` | Pass (local) |
| Group isolation | Operasi pada group A tidak dapat menggunakan flag atau state group B | Focused R11 group isolation test dan group-scoped SQL predicates | Pass (local/static) |
| Explicit target set | Announcement membutuhkan minimal satu user JID yang disebut eksplisit; target unik, bounded, dan immutable setelah preview | `R11 announcement is default-off, rejects implicit targets...` | Pass (local) |
| Preview fingerprint | Preview menyimpan body hash, audience count, dan target fingerprint; approval hanya mengantrekan record yang sama | `R11 announcement preview fingerprint...` | Pass (local/static) |
| Admin recheck | Enable/disable, preview, approve, cancel, status, dan list melakukan live group-admin check | Announcement service authorization path | Pass (local/static) |
| Revision CAS | Approval/cancellation dengan revision lama ditolak sebagai `stale_operation` | `R11 announcement preview fingerprint...` | Pass (local) |
| Approval expiry | Preview yang melewati TTL tidak dapat di-approve | `R11 announcement expires previews...` | Pass (local) |
| Quota and bounded dispatcher | Rate profile announcement 10/menit; dispatch maksimum 10 operasi dan maksimum configured targets per operation | Service constants, guardrail registration, focused tests | Pass (local/static) |
| Cancellation safety | Cancel hanya mengubah pekerjaan pending; target yang belum di-claim tidak terkirim; feature disable membatalkan planned/queued work | `R11 cancellation and disable kill switch...` | Pass (local) |
| Partial transport handling | Per-target failure menjadi `partial`/`failed`, tidak dilakukan retry otomatis | `R11 announcement expires... partial transport failure...` | Pass (local) |
| Quiet-hours handling | Quiet hours menunda queue; notification policy disabled membatasi queue secara fail-closed | PersonalizationService seam dan dispatcher policy branch | Pass (static) |
| Restart/recovery bounds | Stale `sending` target ditandai `recovery_required`; expiry dan content redaction diproses bounded batch | `expireStaleState`, `MAX_EXPIRY_BATCH`, `operationTimeoutMs` | Pass (static) |
| Consent for assistance | Requester wajib memiliki Scene consent `receive_assistance` yang belum expired | `R11 suggestion relay requires explicit...` | Pass (local) |
| Consent for context sharing | Creator setiap Knowledge source wajib memiliki Scene consent `share_context` yang belum expired | Focused source-consent path | Pass (local/static) |
| No passive memory | Relay hanya membaca bookmark Knowledge yang direferensikan command; tidak menangkap full chat | `KnowledgeService.findSource` integration dan sourceReferences validation | Pass (static) |
| Provider contract | Provider menerima typed request/context, circuit breaker, timeout 15 detik, no automatic retry, bounded output | `R11 suggestion provider failure...` | Pass (local/static) |
| Provider failure | Failure dicatat sebagai bounded `provider_unavailable`; raw provider error tidak dikirim atau disimpan | Focused provider-failure test dan safe logger path | Pass (local) |
| Suggestion idempotency | Correlation yang sama tidak memanggil provider ulang dan tidak membuat request kedua | `R11 suggestion relay requires...` | Pass (local) |
| Suggestion output semantics | Output diberi label draft suggestion dan tidak mengeksekusi announcement/canon/side effect | Suggestion plugin response and source review | Pass (local/static) |
| Audit privacy | Audit memakai hash/reference bounded; tidak menulis raw JID, nomor, body, source text, credential, atau raw error | `R11 audit records stay redacted...`; guardrail sanitizer | Pass (local) |
| Text-only UX | `!announce` dan `!suggest` memakai command/reply text; tidak menambah button atau native menu | Focused plugin test and source review | Pass (local/static) |
| Type safety | `npm run typecheck` | Local branch after R11 implementation | Pass (local) |
| Clean build | `npm run build` | Local compiled `dist` | Pass (local) |
| Full regression | `npm test` | 205 tests, 0 failures | Pass (local) |
| Diff hygiene | `git diff --check` | Local branch | Pass (local) |
| Platform parity | `npm run verify:platform` | Final pre-commit gate | Pending |
| CI parity and sanitized artifact | GitHub Actions typecheck/build/parity/regression and artifact inspection | R11 commit must run CI before release | Pending |
| Panel deployment | Same-commit sanitized artifact, checksum, restart, runtime smoke | Pending; optional deployment remains default-disabled and server operational state must be confirmed | Pending |
| WhatsApp black-box acceptance | Final acceptance after R11 and all remaining roadmap gates | User explicitly deferred black-box acceptance until all phases complete | Deferred |

## Command contract

`!announce preview <pesan>` menggunakan mention pada message sebagai target eksplisit. Command menghasilkan preview dengan short ID, revision, expiry, dan fingerprint. `!announce approve <id> <revision>` memindahkan preview ke queue. `!announce cancel <id> <revision>` membatalkan pekerjaan yang belum diklaim. `!announce status <id>` dan `!announce list` hanya untuk admin. `!announce enable|disable` mengubah feature flag per grup; saat disable, planned dan queued operations dibatalkan.

`!suggest request <scene-id> <source-id>[,<source-id>] <permintaan>` memerlukan feature flag suggestion, Scene consent `receive_assistance` dari requester, Knowledge feature aktif, source aktif dan terlihat, serta consent `share_context` dari setiap creator source. Output hanya draft suggestion dan tidak pernah dikirim ke audience secara otomatis. `!suggest enable|disable` adalah operasi admin per grup.

## Rollout and rollback gate

Kedua feature tetap **default-off** pada setiap grup. Rollout dilakukan dengan mengaktifkan flag per grup setelah CI pada commit yang sama lulus dan runtime smoke dapat diamati. Rollback announcement menggunakan `!announce disable`, yang membatalkan planned/queued work; rollback suggestion menggunakan `!suggest disable`, yang menghentikan request baru. Consent Scene tetap memiliki expiry dan withdrawal semantics existing.

Tidak ada perubahan pada `.env`, database production, session, Panel Startup Command, atau `.bash_profile`. Deployment tetap artifact-only dari sanitized CI artifact. R11 belum boleh disebut deployed sampai platform parity, CI commit yang sama, artifact whitelist/checksum, dan runtime evidence Panel semuanya lulus.
