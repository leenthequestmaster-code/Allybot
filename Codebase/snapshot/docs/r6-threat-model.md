# R6 Threat Model — Scene Passport

## Assets and trust boundaries

| Boundary | Threat actor/input | Asset | Control |
|---|---|---|---|
| WhatsApp command → ScenePlugin | Member, malformed command, oversized title/TTL | Scene state and group policy | Feature flag, parser bounds, enum/TTL validation, group-admin middleware for toggle |
| Plugin → SceneService | Actor JID and scene reference | Object-level authorization and tenancy | Local JID/group validation, group in every primary query, creator check for lifecycle |
| SceneService → SQLite | Concurrent transitions and participant writes | State integrity | Parameterized SQL, primary keys, CHECK constraints, revision CAS, additive migration |
| Private scene lookup → reply | Nonparticipant guessing UUID/prefix | Private scene confidentiality | `(group_jid, scene)` predicate plus creator/active-participant visibility check; ambiguous prefix fail closed |
| Consent → future consumer | Participant, expired/withdrawn record | Action authorization | Scoped scene/user/action/expiry, participant-active check, closed/expired/left state fail closed |
| Service → audit | JIDs, title, scene ID, action | Privacy and audit integrity | Guardrail hashes actor/resource; metadata only bounded enum, boolean, count, short hashed prefix |
| Restart/expiry → runtime | Crash, restart, stale row | Recoverability and availability | Persistent rows, expiry-on-access, no leaked process timer, rollback to prior artifact |

## Abuse cases

A member may try to enable Scene for a group or mutate lifecycle as another actor. The toggle is protected by the existing `group.admin` command permission, while service lifecycle methods independently require the scene creator. A caller may supply a scene ID from another group; every exact and prefix lookup includes the requested group, so the foreign object is not returned or mutated.

A user may guess a private scene ID or use an IC label as an authorization token. Visibility is decided before returning a scene view, and IC/OOC is stored only as presentation metadata. A nonparticipant cannot query a private scene, and a participant must explicitly join before changing mode or granting consent.

A participant may grant consent and then leave, withdraw, or wait until expiry. Leave sets participant status left and disables consent; rejoin resets mode to OOC and disables previous consent; `hasConsent` also rechecks active scene and participant status at evaluation time. Closing or expiry therefore cannot leave an effective consent behind.

Concurrent creators may pause/resume/close with stale revision values. The update predicate contains current status and revision, so only one transition succeeds. Repeated command delivery is rejected as an invalid current state rather than creating duplicate transitions. Scene creation uses a transaction so owner participant creation cannot be separated from the scene row.

## Residual risks and unknowns

R6 has no invitation command, so private-scene participant onboarding remains intentionally closed until R8 access governance. Public scene membership is self-service and does not itself imply consent for future context sharing. The service stores JIDs in operational tables because object authorization needs stable identity; audit output hashes them and tests cover absence of raw identifiers.

Production WhatsApp black-box rendering, multi-process writers, and user behavior under high command volume are not proven by local tests. CI and Panel smoke test prove build/deployment/runtime initialization, not end-to-end command acceptance; that acceptance remains deferred to the final roadmap gate.
