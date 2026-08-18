# R3 Collaboration Suite — Verification Matrix

| Requirement/invariant | Verification | Result target | Status |
|---|---|---:|---|
| Default-off blocks state mutation | `R3 default-off prevents poll state mutation...` | Pass | Pass |
| Poll group isolation and expiry | `R3 poll lifecycle is group-scoped...` | Pass | Pass |
| Vote idempotency and cross-group rejection | `R3 vote is idempotent...` | Pass | Pass |
| Invalid option/duplicate/secret-like input rejection | `R3 invalid poll input...` | Pass | Pass |
| Native capability is optional | `R3 native poll is optional...` | Pass | Pass |
| Reminder persistence and single delivery | `R3 reminders survive service restart...` | Pass | Pass |
| Reminder timeout has no retry amplification | `R3 reminder timeout...` | Pass | Pass |
| Task creator/assignee ownership | `R3 task completion enforces...` | Pass | Pass |
| Decision group isolation | `R3 decisions are explicit...` | Pass | Pass |
| Plugin admin gate/default-off/text fallback | `R3 plugin is default-off...` | Pass | Pass |
| Type compatibility | `npm run typecheck` | Pass | Pending final gate |
| Deterministic compiled output | `npm run build` + parity | Pass | Pending final gate |
| Full regression | `npm test` | No regression | Pending final gate |
| Artifact hygiene | CI sanitized artifact scan | No secret/session/db/node_modules | Pending CI |
| Production runtime | Panel restart/smoke | Stable online runtime | Pending deployment |

## Limitations

Native poll update aggregation is intentionally not claimed. The native method is optional presentation only and official votes use `!vote`; event ingestion requires a future message-key/event-storage contract and final black-box acceptance.
