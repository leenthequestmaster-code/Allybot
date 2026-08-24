# Verification Matrix — Architecture 9,6 Target

## Metadata

| Item | Value |
|---|---|
| Repository | `leenthequestmaster-code/Allybot` |
| Baseline commit | `4400c27035a251c0b35d31665c87deb36179c1e3` |
| Baseline branch | `main` tracking `origin/main` |
| Runtime | Node.js `v22.13.0`, npm `10.9.2` |
| Baseline test count | 205 tests, 0 failed — prior baseline evidence |
| Final local test count | 223 tests, 0 failed |
| Storage scope | SQLite runtime; no PostgreSQL/Redis migration |
| Production mutation | None performed by local test batches |

## Batch results

| Batch | Scope | Evidence | Result |
|---|---|---|---|
| 0 | `npm ci`, typecheck, build, platform verification, baseline test | `/home/ubuntu/allybot-baseline-9.6-2026-08-20.md` | PASS |
| A | Runtime acceptance: inbound flow, rejection paths, permission, menu buttons, numeric fallback, graceful stop | `tests/runtime-acceptance.test.js` | 5 focused tests PASS |
| B | CAS winner, concurrent dispatcher claim, in-flight duplicate suggestion, missing/cyclic dependency, plugin ready cleanup | `tests/r11-announcement-suggestion.test.js`, `tests/framework.test.js` | 5 new focused tests PASS; 22 selected tests PASS |
| C | Guardrail audit redaction, scalar metadata, archive preservation, Developer Mode hashed audit | `docs/observability-contract.md`, `tests/observability-contract.test.js`, `docs/runbooks/allybot-failure-modes.md` | 2 new focused tests PASS; 14 selected tests PASS |
| D | Deterministic release manifest, allowlist, per-file SHA-256, artifact deny checks, CI integration | `scripts/create-release-manifest.mjs`, `.github/workflows/ci.yml` | Local sanitized artifact gate PASS |
| E | Architecture fitness invariants and SQLite backup/restore rehearsal | `tests/architecture-fitness.test.js`, `tests/recovery-rehearsal.test.js`, `docs/recovery-runbook.md` | 6 focused tests PASS; recovery fixture PASS |
| F | Clean install, typecheck, build, platform verification, all tests | `/home/ubuntu/allybot-final-gate-9.6-2026-08-20.log` | 223 tests PASS, 0 failed |

## Security checks

The final local review checks tracked and generated paths for `.env`, database files, credentials, session artifacts, private keys, raw credential markers, and forbidden deployment paths. No such artifact is included in the intended release allowlist. Guardrail and Developer Mode tests continue to verify hashed identifiers, scalar metadata, bounded audit, and fail-closed behavior.

## Artifact checks

The release workflow now generates `release-manifest.json` inside the sanitized artifact. The manifest records schema version, commit SHA, Node version, package version, package-lock hash, allowlist, and per-file byte/checksum entries. `SHA256SUMS.txt` covers the manifest and runtime files. The local packaging rehearsal passed with no forbidden path and no direct source/test/database inclusion.

The Panel upload field remains `files`; remote deploy continues to require local archive verification, extract verification, remote SHA-256 verification, and temporary archive cleanup. Startup Command, `.bash_profile`, server power state, and runtime online status remain intentionally unchanged.

## Residual unknowns

This matrix does not prove black-box WhatsApp behavior against a live account, production provider/network behavior, production workload representativeness, or a production restore. Those remain explicit follow-up gates and are not replaced by fake adapter, fixture, or local artifact tests.

## Release gate

The repository is eligible for commit and CI verification when `git diff --check`, clean install, typecheck, build, platform verification, full tests, architecture fitness, recovery rehearsal, and local artifact checks remain green. Final deployment status must be based on GitHub Actions evidence after push; local success must not be described as CI or Panel deployment success.

## References

The matrix is anchored by `package.json`, `tests/framework.test.js`, `tests/r11-announcement-suggestion.test.js`, `tests/r0s-guardrails.test.js`, `tests/developer-mode.test.js`, `tests/runtime-acceptance.test.js`, `tests/architecture-fitness.test.js`, `tests/recovery-rehearsal.test.js`, `.github/workflows/ci.yml`, `src/platform/guardrails.ts`, `src/services/platform-guardrail-service.ts`, `src/platform/mission.ts`, and `docs/observability-contract.md`.
