# R4 Privacy-first Knowledge — Verification Matrix

| Requirement | Verification | Result target | Status |
|---|---|---:|---|
| Default-off blocks bookmark | `R4 default-off prevents explicit bookmark persistence` | Pass | Pass |
| Explicit bounded capture and hashed source identifiers | `R4 bookmark requires explicit bounded source...` | Pass | Pass |
| Private/group visibility | `R4 private visibility is creator-only...` | Pass | Pass |
| Retention expiry/retired state | `R4 retention retires expired records...` | Pass | Pass |
| Delete clears hot excerpt and export | `R4 delete removes excerpt...` | Pass | Pass |
| Cross-group/short prefix fail closed | `R4 source prefixes are group-scoped...` | Pass | Pass |
| Sensitive/oversized input rejection | `R4 rejects sensitive-looking...` | Pass | Pass |
| Plugin default-off/admin/explicit reply | `R4 plugin is default-off...` | Pass | Pass |
| Type compatibility | `npm run typecheck` | Pass | Pass |
| Clean compiled output | `npm run build` + parity | Pass | Pass |
| Full regression | `npm test` | No regression | Pass |
| Artifact hygiene | CI sanitized artifact scan | No secret/session/db/node_modules | Pass |
| Production runtime | Panel restart/smoke | Stable runtime | Pass with WhatsApp black-box acceptance deferred |

## Limitation

R4 intentionally does not write or replay native WhatsApp message mutations. Full `WAMessageKey` is not available in `CoreMessage`/storage, and the service does not fabricate it. There is also no passive history ingestion or LLM/provider call in this batch.
