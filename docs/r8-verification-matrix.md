# R8 Verification Matrix

| Invariant / risk | Verification | Evidence | Status |
|---|---|---|---|
| Feature flag default-off | Service fixture on untouched group; plugin command before enable | R8 focused test 1 | Pass |
| Cross-group tenancy | Lookup and transitions use group scope | Focused retcon/default-off tests | Pass |
| Retcon lifecycle | Draft → proposed → approved/rejected with invalid transition denial | Focused retcon lifecycle test | Pass |
| Retcon revision CAS | Stale expected revision rejected; history remains append-only | Focused retcon lifecycle test | Pass |
| Retcon privacy | Audit excludes raw JID, text, source reference, and retcon ID | Focused audit test | Pass |
| Handoff continuity | Offer/claim and expiry are bounded; evidence count max 5 | Focused handoff test | Pass |
| Join request tenancy/state | Request is group-scoped; approval/rejection uses pending/approving CAS | Focused join tests | Pass |
| Join mutation safety | Live actor/bot admin recheck, participant add via ledger, no side effect on denial | Focused join tests | Pass |
| Duplicate/replay | Correlation uniqueness and terminal request status deny replay | Focused approval test | Pass |
| Invite privacy and confirmation | Info is admin-gated; revoke requires explicit expiry-bound token; raw link absent from audit | Focused invite test | Pass |
| Adapter capability | Missing optional revoke method fails closed | Focused capability test | Pass |
| Restart recovery | Retcon, handoff, request persist; continuity reports bounded state | Focused restart test | Pass |
| Text-only plugin fallback | Admin gate, default-off response, help fallback, no native button path | Focused plugin test | Pass |
| Type safety | `npm run typecheck` | Local gate | Pass |
| Clean compiled output | `rm -rf dist && npm run build` | Local gate | Pass |
| Focused regression | `node --test tests/r8-group-governance.test.js` | 11 tests, 0 failures | Pass |
| Full regression | `npm test` | 167 tests, 0 failures | Pass |
| Source-dist parity and CI | `npm run verify:platform` plus CI parity/compiled checks | Local parity pass; CI pending | Pending |
| Artifact hygiene | CI artifact contains only dist and package manifests | Pending CI artifact | Pending |
| Panel runtime | Upload, decompress, cleanup, restart, smoke test | Pending R8 delivery | Pending |
| WhatsApp black-box | Final acceptance after R11 | Explicitly deferred | Deferred |

## Limitations

R8 does not capture native join-request events because the current adapter contract has no event ingress for them. The bounded `recordJoinRequest` API is intentionally explicit and ready for a future adapter integration. R8 also does not mutate Canon Ledger, perform message deletion, or expose raw operational database contents.
