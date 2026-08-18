# R8 Threat Model — Retcon, Handoff, and Group Access Governance

## Scope and trust zones

R8 menerima command WhatsApp dari actor authenticated melalui framework, membaca metadata grup live dari adapter, menyimpan state eksplisit pada SQLite, dan dapat melakukan group mutation melalui Baileys. Actor grup adalah untrusted input untuk text, object IDs, correlation, request IDs, scope, dan confirmation token. Admin role, bot role, guardrail policy, dan feature flag adalah control-plane inputs yang harus diverifikasi server-side.

## Assets and abuse cases

| Asset | Abuse case | Control | Verification |
|---|---|---|---|
| Group tenancy | Actor memakai retcon/request ID dari grup lain | Semua lookup menggabungkan group scope; IDs tidak menjadi global capability | Cross-group focused test |
| Canon continuity | Retcon disalahgunakan untuk menulis canon otomatis | R8 hanya proposal/review; tidak memanggil CanonService mutation | Retcon lifecycle test dan non-goal review |
| Moderator authority | Admin lama mengirim command setelah role dicabut | Permission middleware dan service melakukan live metadata recheck | Non-admin/bot-not-admin tests |
| Join-request integrity | Request approved dua kali atau stale revision diterapkan | Request state CAS, unique correlation, operation ledger, duplicate denial | Approval, duplicate, stale tests |
| Invite control | Raw invite masuk audit atau revoke tanpa explicit confirmation | Invite value hanya reply pada admin info; revoke memakai preview token expiry-bound; audit hanya hashes | Invite confirmation/redaction tests |
| Side effects | Retry menggandakan add/revoke | `runPlatformOperation`, 20s timeout, maxAttempts 1, operation state | Capability/operation focused tests |
| Restart consistency | Process restart membuat state seolah aman untuk diulang | Pending payload in-memory; state persisted; missing payload returns recovery-required; continuity reports recoverable operations | Restart test |
| Privacy | Raw JID, content, source ref, or IDs leaked through audit | Audit metadata uses hashes/bounded counts; guardrail sanitizer remains active | Audit redaction test |
| Availability | Large text/evidence/list queries exhaust resources | Text/list/evidence bounds, SQLite indexes, rate profile | Input validators and focused tests |
| Adapter boundary | Unsupported invite/join capability assumed available | Optional `groupRevokeInvite`; fail-closed capability check; no fake native join event | Capability absence test |

## Residual risks and unknowns

Native WhatsApp join-request event ingress is not available in the current `WhatsAppPort`; R8 therefore exposes only bounded `recordJoinRequest` for future adapter integration and does not claim automatic request capture. The current operation payload retains the requester JID in operational SQLite because a participant mutation needs an exact target after planning; the value is never exposed through audit or list response. Database access permissions, disk encryption, and production backup retention remain deployment concerns outside this batch's focused tests.

The Baileys declaration confirms `groupRevokeInvite` exists in the pinned dependency, but a real WhatsApp group acceptance remains intentionally deferred until the final black-box acceptance gate after R11.

## Verification evidence

Local verification includes `npm run typecheck`, clean `npm run build`, 11 focused R8 tests covering default-off, tenancy, retcon CAS/history, handoff expiry, join ledger, invite confirmation, restart recovery, audit redaction, capability failure, and plugin fallback. CI, artifact provenance, Panel deployment, and runtime smoke test are recorded in the R8 verification matrix.
