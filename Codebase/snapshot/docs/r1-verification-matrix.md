# R1 Group Safety — Verification Matrix

## Release claim

R1 adds a reversible, admin-gated group safety slice with warning ledger, case workflow, appeals, and anti-link/anti-spam dry-run detection. It does not perform destructive WhatsApp actions and is not claimed as live WhatsApp acceptance.

| Risk / property | Verification | Result | Limitation |
|---|---|---|---|
| Type/API compatibility | `npm run typecheck` | Passed | Local compiler only |
| Compiled artifact | `npm run build` | Passed | Runtime dependency behavior still needs CI |
| Platform source/dist parity | `npm run verify:platform` | Passed; 16 source modules compiled | Does not prove live WhatsApp behavior |
| Existing regression | `npm test` | Passed; 92 tests, 0 failed | No final WhatsApp black-box yet by user decision |
| Warning expiry | Clock-controlled service test | Passed | Uses deterministic fixture clock |
| Warning group isolation | Two-group fixture | Passed | Real group metadata not exercised |
| Case idempotency | Duplicate evidence message test | Passed | Concurrent live duplicate delivery not load-tested |
| Case state machine | Revision and transition negative tests | Passed | No multi-process contention test |
| Appeal ownership | Cross-target denial and duplicate appeal test | Passed | Live LID/PN mapping deferred |
| Evidence privacy | Hash-only evidence and secret-like reason rejection | Passed | Detector covers common patterns, not every possible secret format |
| Anti-link dry-run | Message event fixture | Passed | Regex heuristic; no enforcement |
| Anti-spam boundedness | Hashed limiter key and dry-run gate test | Passed | Representative fixture, not production load benchmark |
| Destructive side effects | Adapter/API surface review and negative test | Passed; no delete/kick/participant mutation exposed by R1 | Future capability requires new review |
| Dependency/supply chain | `npm audit --omit=dev --audit-level=high` | Passed; 0 vulnerabilities | Audit database is time-dependent |
| Diff hygiene | `git diff --check`, secret/raw-error scan | Passed for R1 files | Pre-existing unrelated raw-error paths remain backlog |

## Failure-injection and recovery

The previous R0-S suite retains archive-failure atomic rollback coverage. R1 adds stale revision, duplicate evidence, invalid input, group isolation, and permission negative cases. R1 SQLite tables are additive; rollback to the previous artifact does not require dropping or rewriting them. Setting a group mode to `off` disables dry-run detection without deleting warnings or cases.

## Security review outcome

The service validates group and actor JIDs, bounded identifiers, bounded reason/evidence identifiers, status transitions, revisions, and list limits. R0-S audit request events fail closed before mutation; completion events are attempted after successful local commit and log only safe error names if the separate audit store is unavailable. Raw evidence text is hashed, and audit metadata contains no raw group JID or credential-like value.

## Deployment gate

Before production deployment, create a focused CI commit, wait for all CI jobs, download only the sanitized artifact, verify provenance and forbidden entries, request production confirmation, upload/extract through Panel, verify target checksums, remove the temporary archive, restart without changing Startup Command or `.bash_profile`, and record smoke-test evidence. Live WhatsApp verification remains deferred until the final cross-batch acceptance phase by explicit user decision.

## Residual risk

The current `WhatsAppPort` does not expose message deletion or participant mutation. Anti-link and anti-spam are therefore dry-run only. The group admin status and LID/PN mapping observed by a live Baileys v7 rc14 connection remain unverified. The detector is intentionally conservative and may produce false positives; no punitive action is taken.
