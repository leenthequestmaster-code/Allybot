# R9 Verification Matrix

| Invariant / risk | Verification | Evidence | Status |
|---|---|---|---|
| Feature flag default-off | Service fixture pada group baru; mutation sebelum enable ditolak | `R9 default-off blocks persistence mutations and isolates groups` | Pass |
| Cross-group tenancy | Event ID dari group A tidak dapat dibaca atau dimutasi dari group B | Default-off, manual phase isolation, participant isolation tests | Pass |
| Lifecycle authorization | Creator-only lifecycle; plugin melakukan live admin recheck untuk mutation | Lifecycle CAS test dan plugin test | Pass |
| Lifecycle CAS | Draft → published → paused → active → closed; invalid transition ditolak | `R9 lifecycle uses creator authorization and CAS state transitions` | Pass |
| Phase scheduling | Published event dan fase due diproses bounded; phase completion/start transition idempotent | `R9 phases transition automatically...` | Pass |
| Operation ledger recovery | Deterministic operation ID, running/failed reclaim, restart recovery | Phase dispatcher source review dan restart test | Pass |
| Participant consent | Join/leave explicit, duplicate idempotent, closed event leaves denied | Participant join/leave focused test | Pass |
| Participant privacy | Recap/list hanya truncated hash reference dan bounded list | Participant listing test | Pass |
| Event-linked poll | Collaboration aktif membuat poll melalui existing service; unavailable fails closed | Linked poll dan unavailable poll tests | Pass |
| Calendar/timezone | Epoch-ms persistence; IANA/UTC validation; display memakai event timezone | Timezone validation test dan plugin render path | Pass |
| Location fallback | Coordinate bounds; native location tidak dipanggil; text metadata only | Location validation test; adapter capability assessment | Pass |
| Contact-card capability | Tidak ada native call; user mendapat capability-unavailable text fallback | Plugin help/contact path; `docs/r9-research-notes.md` | Pass |
| Audit privacy | Audit tidak berisi raw JID, title, description, location, event ID, poll ID, raw error | `R9 audit redaction...` | Pass |
| Input/resource bounds | Text, identifier, phase count/order, participant/list limit, timestamp, timezone, coordinate validation | `R9 timezone, timestamp, phase ordering...` | Pass |
| Dispatcher shutdown | `unref`, interval clear, dispatch promise tracking, DB close setelah in-flight work | Source review; runtime smoke pending | Pass (static) |
| Text-only plugin fallback | Group-only, default-off response, admin denial, help fallback; no submenu buttons | `R9 plugin is default-off...` | Pass |
| Type safety | `npm run typecheck` | Local gate sukses setelah latest source change | Pass |
| Clean compiled output | `rm -rf dist && npm run build` | Local clean build sukses | Pass |
| Platform parity | `npm run verify:platform` | `Platform parity verified: 16 source modules have compiled output` | Pass |
| Focused regression | `node --test tests/r9-event.test.js` | 12 tests, 0 failures | Pass |
| Full regression | `npm test` | 179 tests, 0 failures | Pass |
| CI parity and artifact | GitHub Actions typecheck/build/parity/regression; sanitized artifact only | CI run `32174244291` success; archive SHA256 `b63e32e235308ff59b82200930585cfe4d07e96ccbf51a93c8afbe12b2803673`; contents limited to dist and package manifests | Pass |
| Panel deployment | Artifact CI commit yang sama, decompress HTTP 204, archive cleanup, restart, `event storage initialized`, smoke | Commit `e9d3ff1`; decompress HTTP 204; archive absent after cleanup; fresh console showed `component:"event" msg:"event storage initialized"`; runtime online | Pass |
| Startup command integrity | Read-only Panel Startup page after deployment | `clear; neofetch; ulimit -c 0; exec /bin/bash -l` unchanged; Docker image remains NodeJS 22 | Pass |
| WhatsApp black-box | Final acceptance setelah R11 sesuai roadmap | Explicitly deferred | Deferred |

## Release gate

R9 tidak boleh ditutup sebelum semua row bertanda **Pending** memiliki evidence aktual, kecuali row WhatsApp black-box yang sengaja **Deferred** sampai R11. Artifact deployment harus dibuat dari output CI commit yang sama dan hanya berisi `dist/**`, `package.json`, dan `package-lock.json`; `.env`, database, auth state, source repository, dan startup command Panel tidak boleh tersentuh.

## Limitations dan residual risk

Matrix ini membuktikan behavior service/plugin pada synthetic fixture dan build pipeline, bukan keamanan absolut atau kompatibilitas penuh dengan akun WhatsApp produksi. Native contact-card dan native location tetap capability-unavailable/text fallback. Notification acknowledgement end-to-end dan duplicate delivery behavior adapter Baileys nyata menunggu black-box acceptance final setelah R11.
