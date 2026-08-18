# R1 Group Safety — Mini Threat Model

## Assets and boundaries

R1 protects group safety state, warning history, moderation cases, appeal ownership, audit integrity, and member privacy. The untrusted boundary is WhatsApp message input. The authorization boundary is the framework permission resolver plus repeated service-side ownership checks. The persistence boundary is SQLite. The observability boundary is the R0-S audit sanitizer.

## Abuse cases

| ID | Abuse case | Control | Verification |
|---|---|---|---|
| R1-01 | Regular member enables or disables group safety | Existing `group.admin` middleware plus service-side actor authorization | Admin/member command integration tests |
| R1-02 | Group A reads or modifies Group B case/warning | Every query/update includes exact group JID; tables are group keyed | Two-group isolation tests |
| R1-03 | Member appeals another member’s case | Appeal requires appellant JID equals case target JID | Cross-target negative test |
| R1-04 | Replayed report creates duplicate case spam | Unique group/message idempotency key | Duplicate report test |
| R1-05 | Stale moderator overwrites a newer state | Revision-checked transition in SQLite transaction | Stale revision test |
| R1-06 | Oversized reason/evidence creates storage or display abuse | Normalization and hard length bounds | Boundary and invalid-input tests |
| R1-07 | Anti-link detector fetches a malicious URL | Detector only matches text; it never resolves/fetches URLs | Static review and detector test |
| R1-08 | Bot warns itself or moderators are accidentally targeted | Skip `fromMe`, bot JID, and current group admin targets | Detector exemption test |
| R1-09 | Anti-spam state grows without bound | Bounded fixed-window profile and deny-on-capacity | Capacity test |
| R1-10 | Evidence leaks full message text or raw error | Store message hash only; audit safe metadata only | DB inspection and secret scan |
| R1-11 | Expired warning remains punitive | Expiry is evaluated before active count and history remains readable | Clock-controlled expiry test |
| R1-12 | Case transition sends an unauthorized punitive side effect | R1 has no destructive action capability; service only changes durable case state | API surface/static scan |
| R1-13 | Repeated auto-detections create unbounded case volume | Per group/target/rule dry-run gate plus R0 fixed-window limiter; both bounded | Gate regression and capacity review |
| R1-14 | Moderator stores a credential in warning/report reason | Secret-like reason detector rejects common Bearer/JWT/API-key forms | Negative sanitizer test |

## Security invariants

- A non-admin cannot change group safety mode or moderator case state.
- A member can report and appeal only within the group and only appeal a case targeting that member.
- A state transition must match the expected revision and allowed transition graph.
- A duplicate message report is idempotent and does not create a second case.
- No full message body, raw error, secret, or credential is persisted by R1; reason fields reject common secret-like forms and evidence is hashed.
- Dry-run detection never calls delete, kick, promote, demote, provider, URL fetch, or arbitrary code.
- Missing feature flag, invalid mode, or unavailable audit fails closed.

## Residual risk

The dry-run detector is heuristic and may produce false positives; it deliberately does not enforce actions. The current adapter does not provide delete/participant methods, so destructive moderation is not yet possible by design. Live LID/PN behavior and bot-admin status are not established until final WhatsApp acceptance. Existing unrelated raw-error logging outside the R1 path remains a separate hardening item.
