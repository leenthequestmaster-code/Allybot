# R2 Moderation Actions — Verification Matrix

## Scope

Verification ini mencakup implementation lokal R2 pada Node.js 22/TypeScript strict dengan Baileys `7.0.0-rc14` yang terpasang. Test menggunakan SQLite temporary database dan fake `WhatsAppPort`; tidak melakukan mutation ke WhatsApp production. Black-box WhatsApp acceptance sengaja ditunda sampai final phase sesuai keputusan pengguna.

| Risiko/invariant | Evidence | Result | Limitation |
|---|---|---|---|
| Feature default-off | `R2 default-off blocks transport call before role/side effect` | Pass; transport call count tetap 0 | Tidak membuktikan live WhatsApp flag rollout |
| Dry-run no side effect | `R2 dry-run audits and completes without transport side effect` | Pass; operation `dry-run`, transport 0 | Audit sink diuji lewat SQLite lokal |
| Idempotency/replay | Duplicate correlation dan replay-after-success tests | Pass; satu transport call | Upstream partial protocol semantics tetap eksternal |
| Concurrent claim | Atomic claim test | Pass; concurrent execute `in_progress`, satu call | Tidak load-test multi-process SQLite |
| Actor authorization | Non-admin actor test | Pass; `actor_not_admin` | Permission middleware dan service check diuji terpisah dari live client |
| Bot precondition | Non-admin bot test | Pass; `bot_not_admin` | Role dapat berubah setelah test metadata response |
| Validation/scope | Invalid action/setting/duplicate target/cross-group tests | Pass; closed unions and group isolation | Tidak mencakup all possible malformed Baileys nodes |
| Optional capability | Missing participant mutator test | Pass; stable `capability_unavailable` | Old deployed artifact still needs ordinary rollback if mixed versions appear |
| Timeout/failure | Injected timeout and partial result tests | Pass; no automatic retry, failed persisted | Fault injected via fake, not live network timeout |
| Settings positive path | Live `groupSettingUpdate` test | Pass; one setting call, succeeded status | Live protocol acceptance deferred |
| Log/audit privacy | Redaction probe | Pass; raw group/actor/target/error absent from operation/audit serialization | Existing unrelated OBS-01 raw error paths remain backlog |
| Build/API compatibility | Typecheck, clean build, compiled JS check, Baileys installed declarations | Pass | No production WhatsApp black-box yet |
| Regression | Full `npm test` | Pass; 103 tests, 0 failed | Test suite cannot establish external client behavior |

## Commands and outcomes

```text
npm run typecheck                       PASS
rm -rf dist && npm run build            PASS
npm run verify:platform                 PASS
find dist -name '*.js' ... node --check PASS
npm test                                PASS — 103 passed, 0 failed
```

## Review conclusion

The local evidence supports that R2 preserves the current build/test contract, keeps the optional transport capability backward-compatible, and fails closed for the tested authorization, feature, replay, timeout, capability, privacy, and scope conditions. It does not establish that a real WhatsApp account can perform each mutation against a live group; that remains an explicit final-phase acceptance gate.
