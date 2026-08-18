# R7 Verification Matrix

| Requirement / risk | Verification | Result target | Status |
|---|---|---:|---|
| Feature default-off | Default-off persistence test | No write while off | Pass — focused |
| Hidden drafts | Draft/proposed visibility test | Noncreator cannot read | Pass — focused |
| Creator/admin boundary | Lifecycle authority test and plugin live metadata | Unauthorized denied | Pass — focused |
| Lifecycle | Add, propose, reject/approve/retire paths | Valid state transitions only | Pass — focused |
| Revision CAS | Stale approval test | No lost update | Pass — focused |
| Supersede/history | Replacement approval test | Old row retained and history append-only | Pass — focused |
| Source provenance | Explicit R4 source reference test | Same-group visible source only; no excerpt copy | Pass — focused |
| Search uncertainty | Case-equivalent conflicting approved entries | Deterministic uncertainty marker | Pass — focused |
| Cross-group tenancy | Foreign ID/prefix test | No read or mutation | Pass — focused |
| Audit privacy | Raw JID/title/content/canon/source ID assertions | No sensitive audit metadata | Pass — focused |
| Restart recovery | Service reinitialize test | State/history restored | Pass — focused |
| Plugin fallback | Default-off, text-only, admin gate, help fallback | Pass | Pass — focused |
| Type compatibility | `npm run typecheck` | Pass | Pass — local gate |
| Clean compiled output | `npm run build` + parity | Pass | Pass — local gate |
| Full regression | `npm test` | No regression | Pass — 156 tests, 0 fail |
| Artifact hygiene | CI sanitized artifact scan | No secret/session/db/node_modules | Pending CI |
| Production runtime | Panel deploy/restart/smoke | Stable runtime | Pending deployment |

## Limitations

R7 does not automatically approve canon, copy source excerpts, resolve semantic contradictions, provide private-scene invitations, perform retcon/handoff/access governance, or run WhatsApp black-box acceptance. These boundaries are intentional and map to later roadmap gates.
