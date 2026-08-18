# R0-S Safety Core — Mini Threat Model

## Scope

The scope is the new guardrail service and its callers inside the Allybot process at commit `0b327a1`, including SQLite persistence, framework service wiring, audit logging, feature flag lookup, rate/resource state, safe action metadata, and provider circuit state. WhatsApp black-box behavior is explicitly deferred to final acceptance.

## Actors and assets

| Actor | Capability | Assets at risk |
|---|---|---|
| Group member | Sends commands/messages and may control ordinary inputs | Group safety, feature availability, rate budget |
| Group admin | Configures future group features through authorized commands | Group policy and moderation state |
| Owner | Controls Owner-only operations and future guardrail policy administration | Global control plane and audit integrity |
| Malicious or compromised plugin | Attempts to invoke unregistered actions or bypass policy | Arbitrary execution boundary, provider credentials |
| Provider failure/attacker | Causes timeout, repeated error, or degraded upstream response | Availability, resource budget, retry storm |
| Local operator/process | Deploys artifacts and controls runtime filesystem | SQLite integrity, session/auth material, deployment provenance |

## Trust boundaries

1. WhatsApp message input is untrusted until identity normalization, command parsing, feature lookup, rate check, and permission evaluation complete.
2. Plugin/handler code is trusted only for code-owned registry definitions; user-supplied values never become executable code.
3. The guardrail service crosses into SQLite, which is durable local state and must not expose auth/session tables through its public methods.
4. Provider adapters are untrusted external dependencies; circuit state prevents them from consuming unlimited calls.
5. Logs and audit metadata are lower-trust sinks and must not receive raw errors, tokens, credential material, or full chat payloads.

## Abuse cases and controls

| ID | Abuse case | Required control | Verification |
|---|---|---|---|
| R0S-01 | Member invokes an unknown or disabled action | Code-owned safe action registry and default-deny policy | Negative action lookup tests |
| R0S-02 | Group A enables a feature and Group B receives it accidentally | Group-scoped primary key and lookup isolation | Two-group isolation test plus SQLite restart test |
| R0S-03 | Actor injects oversized or secret-bearing audit metadata | Scalar allowlist, size bounds, hashing/redaction | Oversized, object, token-like, and raw-error negative tests |
| R0S-04 | Hot audit rollover loses events | Single transaction with archive insert before hot delete | Fault-injected archive failure test |
| R0S-05 | Replayed audit event creates duplicates | Event ID primary key and idempotent insert semantics | Duplicate event test |
| R0S-06 | Attacker exhausts rate state memory | Finite profiles and bounded key capacity; deny on exhaustion | Capacity boundary test |
| R0S-07 | Provider outage causes retry storm | Closed/open/half-open circuit with bounded probe | Failure transition and no-call-while-open test |
| R0S-08 | Plugin uses arbitrary code path | Registry contains metadata only; no user callback or dynamic execution | Static scan for eval/exec/shell and API surface review |
| R0S-09 | Audit archive is silently deleted | No automatic delete path; archive APIs read-only except explicit future policy migration | API review and persistence test |
| R0S-10 | SQLite contention or partial migration corrupts state | Idempotent additive migration, WAL, busy timeout, transaction boundaries | Restart/reopen and migration repeat test |

## Security invariants

- **I1:** A request cannot execute an action unless policy, feature, permission, and rate checks all allow it.
- **I2:** A missing or malformed guardrail state fails closed.
- **I3:** A group-scoped decision cannot read another group’s flag.
- **I4:** Audit output contains only approved fields and safe hashes; raw errors and secrets are never persisted.
- **I5:** Archive-first rollover is atomic and preserves event identity.
- **I6:** An open provider circuit prevents provider execution.
- **I7:** No user input can cause arbitrary code execution or shell invocation.

## Residual risk

The first R0-S release does not yet enforce every future feature because R1–R9 have not opted into the contracts. It establishes the controls and testable seams. Existing unrelated raw-error logs remain outside SEC-01 scope and require a separate hardening batch. SQLite archive growth is intentionally preserved per user requirement; storage monitoring and a future explicit retention policy are required before archive volume becomes material.
