# R6 Verification Matrix

| Requirement / risk | Verification | Result target | Status |
|---|---|---:|---|
| Feature default-off | `R6 default-off blocks scene mutation...` | No mutation while off | Pass — focused |
| Parallel scene/group isolation | Two groups and two scene records | No cross-group read/mutation | Pass — focused |
| Public/private visibility | Public join; private nonparticipant lookup | Fail closed | Pass — focused |
| Participant lifecycle | Join, leave, rejoin | Consent withdrawal and OOC reset | Pass — focused |
| IC/OOC boundary | Nonparticipant denial and participant metadata update | No permission/consent grant | Pass — focused |
| Creator lifecycle | Creator-only pause/resume/close | Unauthorized/stale denied | Pass — focused |
| CAS | Stale revision transition | No lost update | Pass — focused |
| Scoped consent | Action, withdrawal, expiry | Effective only when active | Pass — focused |
| Expiry | Scene expiry and post-expiry operations | Expired, no access/consent | Pass — focused |
| Audit redaction | JID/title/scene ID absence | No raw sensitive metadata | Pass — focused |
| Restart recovery | Service shutdown and reinitialize | State restored | Pass — focused |
| Plugin contract | Default-off, admin gate, text fallback, lifecycle commands | Pass | Pass — focused |
| Type compatibility | `npm run typecheck` | Pass | Pass — local gate |
| Clean compiled output | `npm run build` + parity | Pass | Pass — local gate |
| Full regression | `npm test` | No regression | Pass — 145 tests, 0 fail |
| Artifact hygiene | CI sanitized artifact scan | No secret/session/db/node_modules | Pending CI |
| Production runtime | Panel deploy/restart/smoke | Stable runtime | Pending deployment |

## Limitations

R6 does not implement private-scene invitations, group access governance, source/quote ingestion, moderator handoff, or black-box WhatsApp acceptance. These are later roadmap scopes or final-stage verification items.
