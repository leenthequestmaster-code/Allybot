# R9 Threat Model — Event Conductor

## Scope dan trust zones

Threat model ini mencakup source input command WhatsApp grup, `EventService`, `event` plugin, SQLite, `PlatformGuardrailService`, optional `CollaborationService`, personalization policy, Baileys `WhatsAppPort`, dan persistent dispatcher. Deployment target tetap Panel Pterodactyl dengan artifact sanitized dari CI. `.env`, database, auth state, startup command, dan `.bash_profile` berada di luar perubahan R9 dan tidak disentuh.

| Zone | Komponen | Trust assumption | Boundary yang diuji |
|---|---|---|---|
| Z1 — Untrusted actor input | Command text, event ID, title, phase, timezone, coordinates | Actor dapat mengirim input arbitrer dan replay command | Parsing, length, identifier, timestamp, timezone, numeric bounds |
| Z2 — Group authorization | Sender JID, live group metadata, creator ownership | Metadata live adalah sumber role saat command dijalankan | Admin recheck, creator-only lifecycle, group-only scope |
| Z3 — Persistent state | SQLite `events`, `event_phases`, `event_participants`, `event_operations` | Database lokal dapat mengalami restart dan tick duplicate | Foreign key, tenant key, CAS, unique participant, bounded query |
| Z4 — Background execution | `setInterval` dispatcher dan recovery scan | Tick dapat overlap, restart, timeout, atau berhenti saat shutdown | In-flight guard, unref, clearInterval, promise tracking, operation reclaim |
| Z5 — Outbound capability | `WhatsAppPort.sendText`, optional collaboration poll | Adapter atau transport dapat tidak tersedia, timeout, atau gagal | Timeout wrapper, no state rollback by raw error, capability-unavailable fallback |
| Z6 — Audit/telemetry | Guardrail audit hot/archive | Audit dibutuhkan untuk accountability tetapi tidak boleh menjadi PII sink | Hash-only metadata, valid outcomes, no raw error/content/JID/ID |

## Assets dan abuse cases

| Asset / property | Abuse case dan attack path | Control | Verification |
|---|---|---|---|
| Group tenancy | Actor memakai event ID dari grup A pada grup B untuk membaca, join, pause, atau close event | Semua lookup `id + group_jid`; prefix ambiguity ditolak; service memvalidasi group JID | `R9 default-off...`; participant cross-group assertion |
| Lifecycle integrity | Member biasa mengubah publish, phase, pause, resume, atau close melalui command | Plugin live-recheck role; service creator ownership dan CAS revision | `R9 lifecycle...`; plugin admin-gated test |
| Creator ownership | Admin lain mencoba menulis event creator melalui jalur lifecycle | `requireCreator` pada service setelah live admin gate | Lifecycle test memverifikasi actor berbeda ditolak |
| Feature isolation | Dispatcher tetap mengaktifkan event setelah feature flag dimatikan | Dispatcher melewati row disabled; mutation path `requireEnabled` | Default-off test dan static review `dispatchDueEvents` |
| Participant consent | Actor diikutkan tanpa opt-in, dihapus dari histori, atau duplicate join menambah count | Join/leave hanya actor sendiri, unique primary key, idempotent state | Participant join/leave test |
| Participant privacy | Recap atau list membocorkan raw JID/nomor telepon | Presentation memakai truncated SHA-256 participant reference dan bounded list | Participant listing dan audit redaction test |
| Phase integrity | Tick duplicate atau restart menjalankan side effect fase dua kali | Deterministic operation ID, operation claim, phase CAS revision, dispatch in-flight guard | Phase dispatcher test dan restart recovery test |
| Crash recovery | Process mati setelah operation running; restart tidak pernah mencoba transition lagi | Reclaim bounded untuk failed/stale running operation dan persisted state recovery | Restart test; operation ledger inspection melalui source/schema |
| Notification availability | Slow/failing WhatsApp membuat dispatcher hang atau crash | `runPlatformOperation`, timeout, one attempt, state tetap persisted, warning sanitized | Build/typecheck; focused dispatch fake transport |
| Poll boundary | Event membuat poll tanpa collaboration feature atau menduplikasi voting logic | Optional service check dan delegation ke CollaborationService | Poll unavailable and linked poll tests |
| Audit privacy | Raw JID, title, description, event ID, location, poll ID, atau raw error masuk audit | Audit metadata hanya panjang/count/boolean/reason; `audit` best-effort safe error logging | Audit redaction test |
| Input resource bounds | Actor mengirim fase tak terbatas, teks besar, invalid timezone, coordinates ekstrem | max text, max phases, max participants, max list, strict IANA validation, numeric bounds | Validation negative test |
| Native capability safety | Bot memanggil API contact-card/location yang belum verified atau mengarang payload | Contact command capability-unavailable fallback; location text-first only | Plugin fallback test; Baileys capability probe terdokumentasi pada `docs/r9-research-notes.md` |
| Shutdown safety | Interval tetap hidup atau menulis ke database setelah service shutdown | `clearInterval`, `dispatchPromise` await, database close setelah dispatch selesai | Code review dan build/test; runtime Panel smoke masih required |

## Temuan dan status

Pada scope local fixture dan source review ini tidak ditemukan bypass group lookup pada service public methods. Hasil tersebut **tidak sama dengan klaim sistem aman secara absolut**: Panel runtime, credential/session permissions, filesystem permissions, SQLite at-rest exposure, Baileys transport behavior, dan black-box WhatsApp acceptance belum diverifikasi pada gate R9 karena black-box ditunda sampai R11.

Residual risk tertinggi adalah penyimpanan operasional JID di SQLite dan ketergantungan pada permission filesystem/backup Panel. R9 sengaja tidak mengenkripsi database karena itu akan menjadi perubahan lintas runtime dan deployment yang tidak dibutuhkan untuk feature batch ini; residual risk harus ditangani di deployment hardening dan backup policy, bukan dengan memasukkan credential atau database ke repository.

Residual berikutnya adalah semantic recovery ketika process mati tepat setelah outbound `sendText` berhasil tetapi sebelum telemetry selesai. Event state dan operation state tetap idempotent, tetapi notification delivery tidak memiliki acknowledgement end-to-end dari WhatsAppPort. Dampaknya dibatasi dengan deterministic state transition dan no automatic retry pada transport notification yang sama; black-box acceptance pasca-R11 harus menilai duplicate notification behavior pada adapter nyata.

## Verification boundary

Verification R9 menggunakan synthetic JID, temporary SQLite, fake WhatsApp transport, focused regression suite, strict typecheck, clean build, dan project platform parity. Tidak ada destructive exploit, real user data, credential, auth state, atau production database yang dipakai. CI dan Panel evidence wajib ditambahkan ke verification matrix sebelum gate ditutup.
