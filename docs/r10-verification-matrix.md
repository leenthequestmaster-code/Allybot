# R10 Verification Matrix — Onboarding Passport

| Invariant / risk | Verification | Evidence | Status |
|---|---|---|---|
| Feature flag default-off | Group baru menolak apply dan tidak membuat application | `R10 onboarding is default-off and blocks persistence across groups` | Pass (local) |
| Group isolation | Application group A tidak dapat direview melalui group B | `R10 onboarding cannot review an application through another group scope` | Pass (local) |
| Admin authorization | Enable/disable, list, dan review melakukan live admin recheck | `R10 onboarding review requires admin...`; plugin admin denial | Pass (local) |
| Metadata scope integrity | Metadata `jid` harus sama dengan group target sebelum role decision | Service static review dan negative authorization path | Pass (static/local) |
| Application input bound | Text kosong/oversized ditolak; list limit bounded | `R10 onboarding rejects oversized input...` | Pass (local) |
| Active applicant uniqueness | Satu active application per group/applicant; duplicate request ditolak | `R10 onboarding apply is bounded, idempotent...` | Pass (local) |
| Revision CAS | Stale expected revision tidak dapat melakukan transition | `R10 onboarding review requires admin, uses revision CAS...` | Pass (local) |
| Lifecycle validity | Hanya applied→approved/denied dan denied→reopen diterima | Focused lifecycle tests | Pass (local) |
| Expiry | Applied application berubah menjadi expired melalui bounded batch | `R10 onboarding expiry is bounded...` | Pass (local) |
| Content retention | Application text di-redact setelah retention tanpa menghapus state | `R10 onboarding content retention redacts...` | Pass (local) |
| Restart persistence | State bertahan setelah service shutdown/initialize | `R10 onboarding state survives service restart...` | Pass (local) |
| Audit privacy | Audit tidak memuat raw JID, application text, atau application ID | `R10 onboarding audit redacts...` | Pass (local) |
| Text-only UX | `!onboarding`/`!onboard` memakai reply text dan help fallback | `R10 onboarding plugin is text-first...` | Pass (local) |
| No side effect beyond persistence | Slice tidak memanggil participant/media/send operation selain command reply | Source review; focused plugin fixture | Pass (static/local) |
| Type safety | `npm run typecheck` | Local branch baseline after latest change | Pass (local) |
| Clean build | `npm run build` | Local branch clean compile | Pass (local) |
| Full regression | `npm test` | 198 tests, 0 failures | Pass (local) |
| Diff hygiene | `git diff --check` | Local branch | Pass (local) |
| Platform parity | `npm run verify:platform` | Pending final pre-commit gate | Pending |
| CI parity and sanitized artifact | GitHub Actions typecheck/build/parity/regression and artifact inspection | Pending push | Pending |
| Panel deployment | Same-commit sanitized artifact, checksum, restart, runtime smoke | Intentionally pending safety gate; server currently offline | Pending |
| WhatsApp black-box | Final acceptance after roadmap completion | Explicitly deferred until R11 | Deferred |

## Release gate

R10 tidak boleh dinyatakan deployed sebelum `verify:platform`, CI pada commit yang sama, artifact whitelist/checksum, dan deployment/recovery evidence semuanya pass. Feature flag harus tetap default-off sampai runtime smoke selesai. Panel Startup Command dan `.bash_profile` tidak boleh diubah.

## Known limitations

Evidence lokal menggunakan synthetic WhatsApp adapter dan SQLite temporary databases. Belum terbukti kompatibilitas penuh dengan akun WhatsApp produksi, deployment artifact CI, atau server Panel offline. R10 slice ini belum mencakup Media Artifact Gate, R11, maupun Mission Platform.
