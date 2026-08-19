# Allybot Observability Contract

## Tujuan dan scope

Dokumen ini menetapkan kontrak minimum untuk signal operasional Allybot yang dapat digunakan untuk diagnosis, security review, dan release verification. Kontrak ini menggunakan signal yang sudah tersedia pada framework event bus, Pino logger, platform guardrail audit, Developer Mode, diagnostics command, dan CI evidence. Ia tidak memperkenalkan external metrics service atau dependency telemetry baru.

Observability bukan bukti bahwa sistem selalu sehat. Ia adalah mekanisme untuk mendeteksi penyimpangan dari invariant dan mengarahkan operator ke tindakan yang aman. Setiap signal harus memiliki tujuan, pemilik tindakan, retention/privacy rule, dan test atau inspection path.

## Data classification dan aturan wajib

| Kelas | Boleh | Tidak boleh |
|---|---|---|
| Runtime state | `phase`, connection status, bounded uptime/duration bucket, service/plugin state | session content, credentials, raw adapter state |
| Command | command name/class, outcome, duration bucket, permission result, bounded failure code | message text, raw sender/recipient identifier, quoted content |
| Guardrail | policy/action/profile id yang aman, scope, version, circuit state, bounded count | raw identifier, raw payload, secret-like value |
| Persistence | migration status, integrity result, bounded row/count/archive movement | database dump, raw row content, session/auth material |
| Release | commit SHA, artifact checksum, allowlist result, gate outcome | `.env`, credential, session, raw logs, database archive |

Identifier yang masuk ke audit runtime harus mengikuti hashing/sanitization source code. Metadata audit hanya scalar bounded dan menggunakan key aman. Outcome wajib menggunakan vocabulary `allowed|denied|changed|failed|limited|opened|closed`.

## Signal contract

| Signal family | Required fields | Safe action |
|---|---|---|
| Framework health | `phase`, `connected`, `startedAt/readyAt` bila tersedia, bounded age | Cek lifecycle dan adapter state; jangan restart membabi buta. |
| Command execution | command class, outcome, duration bucket bila tersedia, failure code | Reproduce pada fake adapter; cek permission/middleware sebelum production action. |
| Service/plugin lifecycle | component name, lifecycle phase, state, failure class | Cek dependency order dan cleanup; lakukan rollback jika startup gagal. |
| Guardrail | policy/action/rate profile, scope, version, allowed/denied/limited, circuit state | Evaluasi policy/feature flag; jangan bypass guardrail. |
| Persistence | integrity result, migration result, bounded counts, archive movement | Stop rollout on integrity failure; restore fixture or approved backup path. |
| Release/deployment | commit, artifact checksum, allowlist result, CI gate status | Halt deployment on mismatch; preserve locked Panel startup contract. |

## Correlation and time

Correlation ID digunakan untuk menghubungkan satu bounded operation lintas service tanpa membawa data pribadi. Correlation ID harus bounded dan safe identifier. Timestamp event memakai epoch milliseconds sebagai source of truth; IANA timezone hanya digunakan pada display/report.

Duration harus direpresentasikan sebagai bucket atau bounded integer, bukan raw high-cardinality trace payload. Event listener failure harus menghasilkan `framework.error` atau error-safe log tanpa membuat listener lain berhenti, sesuai contract EventBus.

## Failure classes and actions

| Failure class | Detection signal | First action | Do not do |
|---|---|---|---|
| Framework not ready | phase tidak `ready` atau connection false | Inspect lifecycle error and dependency state | Jangan menjalankan arbitrary command pada host. |
| Permission denied | denied outcome dengan permission class | Verify resolver and group/private boundary | Jangan mengubah handler untuk bypass resolver. |
| Guardrail unavailable | policy audit fail-closed / provider circuit open | Keep operation denied/limited; inspect audit/storage | Jangan fail-open atau mematikan sanitizer. |
| Persistence/migration failure | self-check/integrity/migration failure | Stop rollout, preserve evidence, use recovery rehearsal | Jangan menghapus audit atau database secara luas. |
| Provider/transport failure | bounded failure code, circuit transition | Allow bounded retry policy or recovery state | Jangan retry tanpa batas atau mengirim ulang target yang sudah claimed. |
| Artifact mismatch | checksum/allowlist gate failure | Stop deployment | Jangan upload source langsung atau mengganti checksum. |

## Auditability and privacy tests

Signal baru harus diuji untuk memastikan raw identifier, message content, credential marker, session material, raw error, dan database content tidak masuk output. Test juga harus memastikan audit archive tetap ada ketika hot capacity overflow; history tidak boleh dihapus sebagai cara mengurangi storage.

## Ownership and review trigger

Framework/lifecycle signal dimiliki maintainer runtime; command/permission signal dimiliki maintainer framework/security; guardrail/audit signal dimiliki maintainer platform security; persistence/recovery signal dimiliki maintainer storage; release signal dimiliki maintainer CI/CD. Review wajib dilakukan jika public contract, audit schema, data classification, runtime dependency, CI workflow, deployment topology, atau incident evidence berubah.

## Verification references

`src/framework/contracts.ts`, `src/framework/application.ts`, `src/platform/guardrails.ts`, `src/services/platform-guardrail-service.ts`, `src/services/developer-mode-service.ts`, `.github/workflows/ci.yml`, `tests/framework.test.js`, `tests/r0s-guardrails.test.js`, dan `tests/developer-mode.test.js` adalah source/test anchors untuk kontrak ini.
