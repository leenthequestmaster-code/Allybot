# R2 Moderation Actions — Requirement Brief

## Outcome

R2 memberikan cara yang terkontrol bagi moderator grup untuk melakukan perubahan participant dan group settings melalui contract adapter yang typed, bukan melalui akses raw socket dari plugin. Tindakan hanya boleh berjalan ketika feature flag grup aktif, actor dan bot memiliki privilege yang sesuai, target dinormalisasi, operasi memiliki correlation/idempotency key, dan transport memberikan hasil typed.

## In scope

R2 mencakup participant actions `add`, `remove`, `promote`, dan `demote`, serta group settings `announcement`, `not_announcement`, `locked`, dan `unlocked`. Command awal bersifat text-only dan selalu memberikan format/fallback teks yang jelas.

Mode default adalah **off**. Untuk pengembangan dan test fixture tersedia **dry-run**, yang melakukan seluruh validasi, policy evaluation, rate check, dan audit request tetapi tidak memanggil transport mutator. Production tidak akan menjalankan destructive action hanya karena command berhasil diparse.

## Explicit non-goals

Delete-for-everyone tidak masuk R2 slice ini. Walaupun Baileys mendukung `{ delete: WAMessageKey }`, `CoreMessage` dan SQLite storage saat ini tidak mempertahankan full key yang diperlukan untuk pesan grup, termasuk participant/fromMe/alternate JID details. Menambah passive full-chat memory hanya untuk mengejar delete bertentangan dengan privacy boundary roadmap. Delete-message memerlukan contract/persistence design terpisah.

R2 juga tidak mencakup invite lifecycle, join-request approval, group leave, raw Baileys socket exposure, arbitrary command execution, automatic kick based solely on a detector, atau perubahan Startup Command/Panel configuration.

## Required invariants

| Invariant | Acceptance |
|---|---|
| Default-off | R2 transport mutator tidak dipanggil ketika flag `group.moderation.actions` disabled |
| Authorization | Actor harus lulus `group.admin`; bot harus menjadi admin/superadmin; role dibaca ulang sebelum side effect |
| Scope isolation | Group JID dari command, target, flag, policy, audit, dan operation tetap berada pada group yang sama |
| Canonical identity | Target JID dinormalisasi melalui adapter LID/PN mapping dan raw alternate identities tidak dikirim mentah |
| Idempotency | Correlation key yang sama tidak boleh mengulang side effect participant/settings |
| Bounded execution | Transport memiliki timeout 20 detik; retry default 0 untuk mutating operation kecuali caller eksplisit memilih retry-safe path |
| Safe logging | Error log/audit tidak membawa raw upstream error, target JID, phone number, credential, message content, atau full payload |
| Dry-run | Dry-run mengaudit planned action dan mengembalikan preview typed tanpa transport side effect |
| Compatibility | `WhatsAppPort` additions bersifat optional/additive; existing fake cores and commands remain valid |
| Rollback | Feature flag dapat dimatikan dan artifact sebelumnya dapat dipulihkan; migration hanya additive |

## Initial command contract

Commands tetap text-only dan berada di kategori moderation:

- `!modaction <add|remove|promote|demote> @member` atau target dari quoted message.
- `!groupmode <announcement|not_announcement|locked|unlocked>`.
- `!modstatus` untuk melihat apakah R2 aktif/off/dry-run tanpa menampilkan secret atau raw identity.

Enabling flag dilakukan melalui service/runtime fixture terlebih dahulu; tidak ada public command yang diam-diam mengaktifkan destructive actions. Jika action belum diaktifkan, bot menjawab bahwa fitur masih off atau dry-run.

## Success criteria

R2 hanya boleh masuk CI/deployment bila requirement brief, architecture brief, threat model, permission matrix, migration/recovery plan, positive/negative tests, duplicate/failure tests, typecheck, build, parity, dependency audit, sanitized artifact, deployment smoke test, dan evidence report tersedia. Black-box WhatsApp acceptance tetap ditunda ke final phase sesuai keputusan pengguna.
