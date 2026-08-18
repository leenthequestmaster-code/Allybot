# R5 Verification Matrix

| Requirement / risk | Verification | Result target | Status |
|---|---|---:|---|
| Feature default-off | `R5 default-off blocks preference persistence...` | No write while off | Pass — focused |
| Strict IANA timezone | Canonical timezone accepted; offset/unknown/whitespace rejected | Pass | Pass — focused |
| Normal quiet hours | `R5 quiet hours suppress notifications inside a normal interval` | Suppress only inside window | Pass — focused |
| Overnight quiet hours | `R5 quiet hours support an overnight interval` | Correct midnight boundary | Pass — focused |
| Precedence | User override → group policy → default, per field | Pass | Pass — focused |
| Cross-user/group isolation | User and group scopes cannot read or mutate each other | Pass | Pass — focused |
| Export/delete | Requesting user's row exports and deletes without affecting another user | Pass | Pass — focused |
| Audit redaction | Raw actor/group JID and timezone input absent from audit JSON | Pass | Pass — focused |
| Notification disabled policy | Explicit `policy-disabled` decision | Pass | Pass — focused |
| R3 reminder integration | Due reminder remains scheduled during quiet hours and resumes after policy clears | Pass | Pass — focused |
| Plugin contract | Default-off, admin gate, text-only reply, invalid input fallback | Pass | Pass — focused |
| Type compatibility | `npm run typecheck` | Pass | Pass — local gate |
| Clean compiled output | `npm run build` + parity | Pass | Pass — local gate |
| Full regression | `npm test` | No regression | Pass — 134 tests, 0 fail |
| Artifact hygiene | CI sanitized artifact scan | No secret/session/db/node_modules | Pending CI |
| Production runtime | Panel deploy/restart/smoke | Stable runtime | Pending deployment |

## Limitations

R5 does not add recipient-specific fan-out to `WhatsAppPort`; group-wide R3 reminders therefore use group policy, while user-specific quiet hours are retained for targeted future notifications and presentation resolution. R5 does not perform passive chat capture, provider/LLM calls, native message mutation, message deletion, or black-box WhatsApp acceptance. Those behaviors remain outside this batch or explicitly deferred.
