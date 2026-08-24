# Allybot Full Release — Meta-Orchestrator Workspace

**Version:** 1.0
**Status:** Active execution workspace
**Date:** 23 August 2026

> Platform ini tidak menyediakan sub-agent eksternal yang terpisah di dalam sesi. Peran di bawah adalah workstream terisolasi dengan kontrak output dan validator yang berbeda; tidak boleh diklaim sebagai agent paralel sungguhan.

## Agent registry

| Agent ID | Role | Mission | Inputs/provenance | Output contract | Tools/scope | Dependency | Done when |
|---|---|---|---|---|---|---|---|
| STRAT-01 | Strategist | Menetapkan release scope v1.0, non-goals, priority, dan decision triggers | `ROADMAP.md`, changelog, user constraints | Scope decision, assumptions, release gates | Read repository/docs; no production mutation | None | PRD scope approved internally and no unresolved material ambiguity hidden. |
| RES-01 | Researcher | Memvalidasi dependency/library/platform facts saat batch membutuhkan freshness | Official docs, pinned package types, CI evidence | Claim, source, uncertainty, impact | Read-only web/source/package inspection | STRAT-01 | Every external claim has provenance or is marked TBD. |
| ARCH-01 | Architect | Menjaga module boundaries, data ownership, consistency, rollout, rollback | PRD, source, existing architecture docs | Decision brief, alternatives, data flow, ADR delta | Read/write docs; no secret access | STRAT-01, RES-01 | Every cross-cutting change has boundary and rollback. |
| BUILD-01 | Builder | Mengimplementasikan vertical slice dengan diff minimal | Approved batch contract, source, tests | Code, migrations if approved, tests, docs | Source/test edits only; no direct secret or arbitrary command execution | ARCH-01 | Focused tests and typecheck pass. |
| RISK-01 | Risk Guardian | Menguji auth, privacy, abuse cases, secrets, supply chain, and fail-open paths | Diff, config, CI, threat model | Findings with severity, evidence, remediation | Static/read-only and synthetic negative tests | ARCH-01, BUILD-01 | No unmitigated blocker; residual risks explicit. |
| VAL-01 | Validator | Menjalankan verification matrix and independent checks | Build artifact, test results, runtime evidence | Pass/fail/caveat matrix | Tests, hash checks, read-only runtime checks | BUILD-01, RISK-01 | All release gates have evidence. |
| REL-01 | Release Engineer | Menghasilkan sanitized artifact dan menjalankan delivery | Clean commit, CI workflow, deployment vars | Commit, CI run, artifact/checksum, rollback status | GitHub CLI and approved CI pipeline | VAL-01 | Artifact and checksum pass; no sensitive file uploaded. |
| EDIT-01 | Editor | Menyelaraskan changelog, roadmap, command catalog, docs, and final report | All workstream outputs | User-facing release notes and status report | Documentation only | VAL-01, REL-01 | No material contradiction remains. |

## Delegation contracts

### TASK-FR-01 — Release scope and baseline

- **OWNER_AGENT:** STRAT-01
- **OBJECTIVE:** Tetapkan scope full release yang dapat diuji.
- **WHY_THIS_TASK_EXISTS:** Katalog command lebih luas daripada fitur terverifikasi.
- **INPUTS_AND_PROVENANCE:** Repository HEAD, `ROADMAP.md`, `CHANGELOG.md`, user constraints, CI and Panel evidence.
- **CONSTRAINTS:** Jangan menganggap semua katalog sebagai implemented; jangan mengubah production.
- **ALLOWED_TOOLS:** Read-only repository/runtime inspection.
- **EXPECTED_OUTPUT:** PRD, non-goals, acceptance criteria, priority.
- **ACCEPTANCE_CRITERIA:** Must/Should/Could/Won't tersusun; assumptions dan unknowns explicit.
- **DEPENDENCIES:** None.
- **DEADLINE_OR_ITERATION_LIMIT:** 1 baseline pass plus max 2 revisions.
- **RISK_ESCALATION_RULE:** Jika scope memerlukan destructive operation atau unavailable credential, mark blocked.

### TASK-FR-02 — Neon opt-out release

- **OWNER_AGENT:** BUILD-01
- **OBJECTIVE:** Rilis command `!chatlog off|on|status|help` dengan group scope dan persisted suppression.
- **WHY_THIS_TASK_EXISTS:** Consent control adalah release-critical privacy capability.
- **INPUTS_AND_PROVENANCE:** Existing plugin/test, guardrail service, command registry, commit `f26b8ea`, CI run `32630662155`.
- **CONSTRAINTS:** Tidak menghapus historical Neon rows; no new Neon schema; audit redaction; admin/Owner only.
- **ALLOWED_TOOLS:** Source/test/docs edits; local build/tests.
- **EXPECTED_OUTPUT:** Focused commit-ready code and tests.
- **ACCEPTANCE_CRITERIA:** Positive/negative/persistence/fail-safe tests pass.
- **DEPENDENCIES:** ARCH-01 data ownership and RISK-01 review.
- **DEADLINE_OR_ITERATION_LIMIT:** 1 vertical slice plus max 2 corrections.
- **RISK_ESCALATION_RULE:** Any raw PII/secret or ambiguous authorization stops the slice.

### TASK-FR-03 — Redis runtime canary

- **OWNER_AGENT:** VAL-01
- **OBJECTIVE:** Prove latest deployed process loads Redis build and preserves fallback behavior.
- **WHY_THIS_TASK_EXISTS:** Artifact sync does not restart the manual process.
- **INPUTS_AND_PROVENANCE:** CI artifact, Panel resource status, verifier script, runtime env presence.
- **CONSTRAINTS:** No power mutation without explicit operation approval; no secret output.
- **ALLOWED_TOOLS:** Read-only Panel health and user-run verifier.
- **EXPECTED_OUTPUT:** PASS/caveat evidence.
- **ACCEPTANCE_CRITERIA:** Build identity and health-check correspond to deployed artifact.
- **DEPENDENCIES:** REL-01 artifact sync.
- **DEADLINE_OR_ITERATION_LIMIT:** One controlled verification attempt plus one retry.
- **RISK_ESCALATION_RULE:** If process reload is required, request exact operation approval.

### TASK-FR-04 — Menu v1.0

- **OWNER_AGENT:** ARCH-01 / EDIT-01
- **OBJECTIVE:** Finalize eight-category command navigation and copy.
- **WHY_THIS_TASK_EXISTS:** Full release requires discoverable, accurate command surface.
- **INPUTS_AND_PROVENANCE:** Menu taxonomy baseline, command copy guidelines, active registry, Adit suggestion.
- **CONSTRAINTS:** Buttons only for `!menu`; submenu text-only; no fictional command.
- **ALLOWED_TOOLS:** Source/docs/tests, synthetic output fixtures.
- **EXPECTED_OUTPUT:** Menu decision brief and implementation slice.
- **ACCEPTANCE_CRITERIA:** Active commands and categories match registry; text fallback works; Developer/Owner visibility is actor-aware.
- **DEPENDENCIES:** Current command inventory and scope freeze.
- **DEADLINE_OR_ITERATION_LIMIT:** Design first; implementation completed in commit `606a0d2` after focused contract tests.
- **RISK_ESCALATION_RULE:** If location/contextInfo changes message semantics or client compatibility, isolate as spike; no such experimental transport change is included in this slice.

## State ledger

| State | Current status |
|---|---|
| `CURRENT_OBJECTIVE` | Full release v1.0 scope, not unlimited catalog completion. |
| `PRD_VERSION` | `full-release-prd-v1.0` draft baseline. |
| `ACTIVE_WORKSTREAMS` | Redis runtime reload/canary, documentation reconciliation, recovery rehearsal, and live acceptance limitation. |
| `AGENT_REGISTRY` | STRAT-01, RES-01, ARCH-01, BUILD-01, RISK-01, VAL-01, REL-01, EDIT-01. |
| `TASK_QUEUE` | Controlled runtime reload/canary → docs/runbook reconciliation → recovery rehearsal → release decision. |
| `DEPENDENCY_GRAPH` | See `meta-orchestrator-dependency-graph.mmd`. |
| `EVIDENCE_LEDGER` | Repository HEAD, CI run, Panel resource, Neon aggregate, local test output. |
| `DECISION_LOG` | Full release means curated verified scope; no speculative catalog completion. |
| `ASSUMPTION_LOG` | Live WhatsApp black-box acceptance environment is unavailable. |
| `RISK_REGISTER` | See PRD and verification/recovery artifacts. |
| `VALIDATION_RESULTS` | Menu v1.0 focused/full regression: 275 tests pass; typecheck/build pass; CI run `32631329930` artifact sync and SHA-256 verification pass; dependency audit last recorded at 0 high vulnerabilities. |
| `DELIVERABLE_REGISTRY` | PRD, workspace, docs, source/test commits, sanitized CI artifacts. |
| `STOP_CONDITION` | Completed-with-caveat only after all feasible gates pass and unknown live behavior is disclosed. |
