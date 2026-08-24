# R5 Threat Model — Personalization + Notification Policy

## Scope and assets

Threat model ini mencakup command text R5, dua tabel SQLite additive, resolver precedence, integrasi dispatcher reminder R3, audit guardrail, dan lifecycle service/plugin. Asset utamanya adalah isolasi preference antar user/group, integrity policy quiet/notify, availability dispatcher, serta privacy actor/resource identifiers dan preference values.

## Trust boundaries

| Boundary | Untrusted input or actor | Asset at risk | Control |
|---|---|---|---|
| WhatsApp message → plugin | Member, admin, malformed command, oversized value | Preference integrity and command authorization | Parser bounded, enum/timezone/quiet validation, permission middleware for group policy, default-off |
| Plugin → service | Command context and actor JID | Cross-user/group isolation | Local JID/group validation, service keyed by `(group_jid, user_jid)`, no caller-supplied foreign scope |
| Service → SQLite | Normalized values and concurrent writes | Schema/data integrity | Parameterized SQL, additive tables, primary keys, enum CHECK constraints, WAL, busy timeout |
| Collaboration dispatcher → notification policy | Due reminder and group policy | Notification availability and loss | Policy check before claim, retain `scheduled` during suppression, claim CAS, retry/error transition unchanged |
| Service → audit | Event metadata and identifiers | Privacy and audit integrity | Guardrail hashes actor/resource, bounded enum/length metadata, valid outcomes only, hot/archive retention |
| Runtime → restart | Timer, open DB handles, partial dispatch | Resource leak and duplicate send | Service shutdown clears DB/timer/policy state; reminder CAS prevents duplicate claim |

## Abuse cases and mitigations

An attacker may try to enable the feature without group-admin permission. The command carries the existing `group.admin` permission and the service still validates the actor/group identity; the negative plugin test covers a member attempt. An attacker may try to cross-read or overwrite another user's preference by changing identifiers. The command derives actor identity from the message context, service validates scope, and tests cover cross-user and cross-group isolation.

An attacker may submit an offset timezone, an unknown timezone, malformed quiet interval, or a very large value to cause ambiguous scheduling or resource exhaustion. Strict canonical timezone matching, bounded strings, fixed `HH:mm` parsing, enum validation, and SQLite checks reject these values before persistence. An attacker may use quiet hours to create reminder loss or duplicate dispatch. Suppression leaves the row `scheduled`, while normal dispatch uses the existing claim CAS and operation timeout.

Audit data could leak raw JID or policy input if metadata is assembled carelessly. R5 passes actor/resource only through the guardrail hashing boundary and logs only field names, booleans, reasons, counts, and bounded status. The focused test asserts that raw group/user JIDs and timezone input do not appear in audit JSON.

## Residual risks and unknowns

The current R3 reminder contract sends one group-wide message and does not expose recipient fan-out. Therefore user-specific quiet hours cannot safely suppress delivery for only one recipient; R5 intentionally applies group policy to group-wide reminders and leaves user-specific policy available for future targeted delivery. The runtime timezone database follows the host's ICU/tzdb version and can change when Node or the OS is upgraded; the service validates against the currently supported runtime set rather than vendoring a second database.

R5 does not prove end-to-end WhatsApp delivery, button rendering, or behavior under a production multi-process deployment. Those remain outside the focused gate and are explicitly deferred with the roadmap-wide black-box acceptance.

## Verification focus

The gate must prove default-off, permission separation, strict timezone rejection, normal and overnight quiet intervals, per-field precedence, cross-scope isolation, delete/export behavior, audit redaction, reminder deferral/resume, clean shutdown, and regression compatibility with R3 fixtures. Any failure returns the batch to diagnosis rather than being marked pass.
