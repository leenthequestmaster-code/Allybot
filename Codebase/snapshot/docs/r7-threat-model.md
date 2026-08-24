# R7 Threat Model — Canon Ledger

## Assets and boundaries

| Boundary | Threat | Control |
|---|---|---|
| Command → CanonPlugin | Malformed/oversized title, content, search, source reference | Bounded parser, explicit `::`, length limits, sensitive-looking input rejection, parameterized search |
| Plugin → CanonService | Noncreator proposes or nonadmin approves | Creator check in service; dynamic live group-admin recheck in plugin; service transition remains object-scoped |
| Group A → Group B | Guessing canon/source UUID or prefix from another group | Every lookup, search, source validation, transition, and history query includes group scope |
| Draft/proposed → public lookup | Unreviewed or malicious canon leakage | `getVisible` and search expose only approved to noncreator; list is approved plus creator-owned records |
| Concurrent governance | Two approvals or stale client revision | Status+revision CAS predicate and transactional append-only history |
| Replacement canon | Old canon deletion or silent overwrite | Previous approved entry becomes superseded; history remains queryable; no destructive delete |
| Knowledge → Canon | Source content treated as instruction or private source disclosed | Only explicit active visible source ID is accepted; excerpt is not copied; source group/visibility enforced by KnowledgeService |
| Audit → operator | Raw identifiers or content in telemetry | Guardrail hashes actor/resource; Canon and R4 audit metadata use booleans, counts, hashes, enums only |

## Abuse cases

A user may send a source ID from another group or a private source they cannot see. `validateSource` calls the group-scoped R4 `findSource` with the actor, so the reference is rejected without revealing whether the foreign record exists. The canon stores the reference for provenance, but never copies the source excerpt into content.

A nonadmin may attempt `!canon approve` by bypassing the menu. The plugin fetches current group metadata and compares the actor role; the service additionally requires a valid current proposed object and revision. A noncreator may propose someone else’s draft and is denied by the service even if the command is invoked directly.

Two moderators may approve replacement entries near-simultaneously. SQLite serializes the transaction; each approval uses the current revision, and the later approval supersedes the prior approved record for the same title. The old content remains in the ledger and history, so the system does not erase evidence or invent a conflict resolution.

A user may search for a draft title or use a prefix from a different group. Search filters status approved and group; reference resolution filters group before visibility. Ambiguous prefixes fail closed. When approved records differ by content under case-equivalent titles, search reports uncertainty rather than choosing one.

## Residual risks

Operational canon content is deliberately stored because it is an explicit community artifact, not passive memory. Moderators remain responsible for approval quality; R7 does not perform semantic fact checking. Private-scene invitations, moderator handoff, retcon workflow, and access governance are deferred to R8. End-to-end WhatsApp black-box acceptance remains deferred until R11.
