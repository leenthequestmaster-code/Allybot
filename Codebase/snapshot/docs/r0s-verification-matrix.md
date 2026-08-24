# R0-S Safety Core — Verification Matrix

## Scope and environment

Validation was performed in `/home/ubuntu/Allybot_git_upload` against the current working tree after R0-S implementation. Runtime target is Node.js `>=22`, TypeScript ESM, `better-sqlite3` `12.4.1`, and the existing dependency lockfile. Production WhatsApp black-box tests are intentionally deferred until the final phase by user decision.

## Evidence matrix

| Risk/property | Check | Result | Limitation |
|---|---|---|---|
| Type/API mismatch | `npm run typecheck` | Passed | Does not prove live WhatsApp behavior |
| Compiled artifact correctness | `npm run build` | Passed | Production artifact still requires CI rerun |
| Source/dist parity | `npm run verify:platform` | Passed | Checks repository parity, not Panel live state |
| Existing behavior regression | `npm test` | 89 passed, 0 failed | No final black-box WhatsApp run yet |
| Policy fail-closed | R0-S policy registry tests | Passed | Uses local fixtures |
| Safe action allowlist | Unknown/disabled action tests | Passed | No user-facing automation consumes it yet |
| Group isolation | Two-group lookup plus SQLite reopen | Passed | Single-process SQLite model |
| Audit redaction | Hash and sensitive-key/value rejection tests | Passed | Pattern detector is not a universal secret classifier |
| Audit retention safety | Hot overflow and archive query tests | Passed | Archive growth monitoring is not yet a user feature |
| Archive atomicity | SQLite trigger fault injection | Passed | Simulates archive failure locally |
| Rate/resource bound | Fixed-window limit and capacity tests | Passed | No production workload benchmark yet |
| Provider failure containment | Circuit closed/open/half-open/closed tests | Passed | No live provider outage test yet |
| Supply chain | `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities | Audit database is time-dependent |
| Diff hygiene | `git diff --check` | Passed | Review remains required after CI artifact generation |

## Security review conclusions

R0-S does not expose an executor. Safe actions are metadata-only and can be resolved only from a code-owned registry. Policy, action, feature, rate, and provider identifiers accept bounded namespaced identifiers; arbitrary user input cannot become code. Feature flags are group-scoped and missing state is disabled. Audit actor and resource JIDs are hashed, sensitive metadata keys and secret-like values are rejected, and raw errors are never persisted by the new code.

Audit rollover is archive-first and transactional. When hot capacity is exceeded, the oldest records are inserted into archive and removed from hot within one SQLite transaction. An injected archive failure rolls back the complete operation. Archive has no automatic delete path.

## Operational and compatibility review

The new service uses additive SQLite tables on the existing core database path and the project’s established WAL, synchronous, foreign-key, and busy-timeout conventions. Runtime registration is additive and occurs before plugin initialization and WhatsApp startup. Existing command handlers are not changed to consume R0-S yet; this keeps the release behavior-compatible while later batches adopt explicit guardrail contracts.

## Release gate status

R0-S implementation gate is passed locally. Remaining gates are CI validation on the pushed commit, sanitized artifact inspection, production deployment through the Panel, infrastructure smoke test, and final deferred WhatsApp black-box acceptance. The final WhatsApp test must cover existing commands and new cross-batch behavior after R1–R9 and Mission Platform are complete.

## Rollback

If CI or deployment validation fails, do not alter production data. Roll back to the previous sanitized artifact. The new SQLite tables are additive, so binary rollback does not require destructive schema removal. If archive growth or SQLite contention becomes material, pause further feature adoption and introduce an explicit retention/migration policy rather than deleting records implicitly.
