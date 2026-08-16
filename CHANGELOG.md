# Changelog Allybot

Semua perubahan penting pada Allybot dicatat di dokumen ini. Changelog hanya mencatat perubahan yang benar-benar sudah diimplementasikan dan diverifikasi; fitur yang masih berupa ide tetap berada di `ROADMAP.md` dan tidak ditulis sebagai fitur selesai.

## Aturan versioning

Allybot menggunakan pola versioning sederhana. **Patch release** digunakan untuk bug fix, security fix, reliability fix, perubahan logging, dan perubahan internal yang tidak mengubah kontrak command. **Minor release** digunakan untuk plugin atau command baru yang backward-compatible. **Major release** digunakan untuk perubahan breaking pada command, schema, konfigurasi, storage, atau deployment procedure.

Setiap entri rilis harus menjelaskan perubahan pengguna, perubahan internal penting, konfigurasi atau environment variable baru, migrasi database, status verifikasi, dan known issue bila ada. Perubahan auth state atau data production harus dicatat sebagai deployment note, tetapi tidak boleh menampilkan secret, QR, pairing code, token, isi database, atau message body.

## Format kategori

| Kategori | Penggunaan |
|---|---|
| `Added` | Fitur, command, service, atau kemampuan baru yang telah tersedia. |
| `Changed` | Perubahan behavior, konfigurasi, output, atau struktur yang disengaja. |
| `Fixed` | Bug atau regresi yang telah diperbaiki. |
| `Security` | Permission, redaction, auth protection, atau pengurangan exposure. |
| `Performance` | Perbaikan penggunaan CPU, memory, latency, atau concurrency. |
| `Deprecated` | Fitur yang masih tersedia tetapi akan dihentikan. |
| `Removed` | Fitur atau behavior yang telah dihapus. |

## [Unreleased]

Bagian ini hanya berisi perubahan yang sudah dibuat di source of truth tetapi belum diberi tag release final. Jangan memasukkan ide masa depan ke bagian ini kecuali implementasinya benar-benar sudah dimulai dan statusnya ditulis secara jelas.

### Added

- Maintenance mode melalui `WHATSAPP_ENABLED`, sehingga framework dan service dapat berjalan tanpa membuat socket WhatsApp.
- Regression test maintenance untuk konfigurasi disabled dan guard socket creation.
- Keepalive lifecycle yang aktif hanya ketika maintenance mode berjalan.
- Group metadata melalui `WhatsAppPort` untuk subject, owner, description, peserta, dan role peserta.
- Plugin group foundation dengan `!groupid`, `!groupinfo`, `!membercount`, `!admins`, `!members`, `!memberinfo`, `!role`, `!permissions`, `!rules` read-only, dan `!link` untuk admin/creator.
- Permission resolver untuk `bot.owner`, `group.admin`, dan `group.owner`.
- Owner identity eksplisit melalui `BOT_OWNER_JID`, tanpa memasukkannya ke `publicConfig`.
- Dokumentasi group foundation pada `docs/group-foundation.md`.
- `GroupConfigurationService` dengan database SQLite terpisah `data/allybot-group-config.sqlite`, WAL mode, migrasi schema `0001_group_rules`, dan metadata perubahan.
- Command `!setrules` dan `!clearrules` untuk admin atau creator grup.
- Command `!setwelcome`, `!clearwelcome`, `!setleave`, `!clearleave`, dan `!groupsettings` untuk admin atau creator grup.
- Template welcome/leave custom dengan placeholder `{{user}}`, `{{group}}`, dan `{{count}}`, serta fallback ke pesan default Allybot.
- Command `!prefix`, `!setprefix`, dan `!setlanguage` untuk konfigurasi admin atau creator per grup.
- Penyimpanan `group_preferences` untuk prefix dan language preference dengan migration `0003_group_preferences`.
- Command `!ruleshistory` untuk admin/creator, dengan audit perubahan set/clear, actor, waktu, preview rules, dan mention actor yang clickable.
- Command `!settimezone` untuk menyimpan IANA timezone per grup dan memformat waktu pada rules history.
- Tabel `group_rules_history` dan migration `0004_rules_history_timezone`.

### Changed

- Startup WhatsApp sekarang menghormati flag maintenance sebelum membuat koneksi atau menjadwalkan reconnect.
- Application Framework menggunakan permission resolver berbasis metadata grup dan owner config tanpa mengakses raw Baileys socket dari plugin.
- Permission denial sekarang memakai bahasa ramah pengguna sesuai kebutuhan akses; nama permission internal tidak dikirim ke WhatsApp.
- Command berpermission yang tidak dikenal tetap default-deny.
- `!rules` sekarang membaca konfigurasi rules per grup dari SQLite dan memberi petunjuk ketika rules belum tersedia.
- Event participant welcome/leave sekarang membaca template aktif per grup dan tetap mengirim metadata mention clickable.
- Group settings hanya menampilkan konfigurasi yang benar-benar aktif; pengaturan yang belum ada tetap ditandai default.
- Command parser sekarang memakai prefix efektif per grup, tetap menerima prefix global sebagai fallback pemulihan, dan private chat tetap memakai prefix global.
- Menu menampilkan prefix efektif grup; AFK tidak menganggap command dengan prefix custom atau prefix global fallback sebagai pesan kembali aktif.
- Language preference `id` atau `en` sekarang divalidasi, dipersistenkan, dan ditampilkan pada konfigurasi grup; lokalisasi seluruh plugin belum diaktifkan.
- `!ruleshistory` menampilkan history terbaru dalam timezone grup, membatasi preview rules agar output tidak berlebihan, dan hanya dapat digunakan admin/creator.
- `!settimezone` memvalidasi IANA timezone melalui runtime `Intl` tanpa dependency timezone tambahan.

- Namespace auth tetap menggunakan `primary-qr-20260812` selama recovery agar auth state lama tidak tersentuh.
- Prosedur deployment cooldown menggunakan `QR_ENABLED=false` dan `PAIRING_ENABLED=false` untuk mencegah percobaan autentikasi baru.

### Fixed

- Proses Node.js yang sebelumnya keluar dengan exit code 0 ketika WhatsApp dinonaktifkan kini tetap hidup sampai menerima SIGTERM atau shutdown terkontrol.
- Penanganan status 408 tidak melakukan retry agresif selama cooldown.

### Security

- Logging pairing kembali menggunakan field yang telah dilindungi redaction standar.
- Permission `group.admin` hanya mengizinkan admin atau creator; member biasa tidak dapat melewati middleware.
- Permission `group.owner` hanya mengizinkan creator grup; permission `bot.owner` hanya mengizinkan JID owner yang dikonfigurasi.
- Permission yang tidak dikenal selalu ditolak oleh resolver.
- `!link` tidak tersedia untuk member biasa dan hanya memakai API invite link Baileys melalui port yang terkontrol.

- Maintenance mode tidak membaca atau membuat auth socket baru.

### Verification

- Typecheck lulus.
- Build TypeScript lulus.
- Regression suite Milestone 3 lulus: `28/28` test, termasuk persistence rules, preferences, history, dan timezone setelah restart, isolasi antargrup, validasi input, permission admin, clear/reset behavior, custom welcome/leave runtime, dynamic menu prefix, AFK prefix handling, groupsettings, owner identity, default-deny, group foundation, dan denial response.
- Typecheck dan build Milestone 3 lulus.
- Migrasi schema `0002_group_messages`, `0003_group_preferences`, dan `0004_rules_history_timezone` berjalan otomatis pada database konfigurasi terpisah tanpa menyentuh auth database atau database AFK. Migration 0004 juga menambahkan kolom timezone pada database konfigurasi lama bila belum tersedia.
- Test denial diperbarui untuk memverifikasi pesan admin grup, pembuat grup, owner Allybot, dan fallback permission yang tidak dikenal.
- Smoke run maintenance mode bertahan sampai SIGTERM dan menyelesaikan graceful shutdown.
- Deployment panel tetap berada pada maintenance mode, tanpa upload fitur milestone ini, tanpa QR, pairing, socket, atau error 408 baru.
- Group foundation, Permission Policy, dan seluruh Group Configuration Service saat ini **belum dideploy** ke Pterodactyl dan masih offline-only.


### Deployment notes

- `WHATSAPP_ENABLED=false`
- `QR_ENABLED=false`
- `PAIRING_ENABLED=false`
- Database `data/allyssea.sqlite` dan `data/allybot-afk.sqlite` tidak dihapus atau dimigrasikan pada perubahan ini; database Group Configuration tetap berada di namespace terpisah dan hanya menerima migration baru.
- Auth namespace `primary-qr-20260812` tidak diubah.

### Deferred plans — not implemented

- `!restart` dan `!maintenance` ditunda sampai WhatsApp online, owner permission stabil, dan restart policy Pterodactyl terverifikasi.
- `!stop` tidak direncanakan; `!start` melalui WhatsApp tidak dianggap feasible ketika proses sudah mati.
- Tidak ada source, build artifact, konfigurasi aktif, atau deployment untuk lifecycle control pada status sekarang.

## [0.1.0] — Core baseline

Rilis ini mewakili fondasi awal Allybot yang sudah dibangun sebelum maintenance recovery.

### Added

- WhatsApp transport berbasis Baileys dengan TypeScript ESM dan Node.js 22.
- SQLite storage dengan WAL untuk auth credentials, auth keys, dan message persistence yang diperlukan.
- Configuration system berbasis dotenv dan Zod.
- Structured logging berbasis Pino dengan redaction untuk data sensitif.
- Application lifecycle dengan SIGINT, SIGTERM, graceful shutdown, dan shutdown timeout.
- Application Framework modular dengan `WhatsAppPort`, event bus, service registry, command registry, dan plugin manager.
- Error isolation agar kegagalan plugin atau command tidak menjatuhkan framework.
- Plugin `!ping` dengan identitas visual Allybot.
- Plugin `!menu`, alias `!help`, `!back`, kategori bernomor, dan pagination submenu.
- Plugin AFK berbasis SQLite dengan auto-unset ketika pengguna mengirim pesan kembali.
- Forwarding setiap mention kepada pengguna AFK ke private chat pengguna tersebut.
- Mention clickable pada output AFK dan welcome/leave.
- Penyimpanan metadata AFK meliputi grup, nama grup, pesan, quoted text, pengirim, dan timestamp.
- Plugin welcome/leave berdasarkan group participant update.

### Changed

- Nama proyek, logger identity, dan browser identity menggunakan Allybot.
- Normalisasi LID ke phone-number JID untuk mention dan pengiriman pesan.
- Timestamp Baileys dalam detik dinormalisasi ke epoch milliseconds.
- Storage plugin menggunakan SQLite sebagai default untuk data persisten.

### Fixed

- AFK reply-only message dideteksi melalui `quotedSenderJid`.
- Timestamp legacy AFK dikonversi dari detik ke milliseconds melalui migrasi storage.
- Mention yang sebelumnya tidak clickable diperbaiki menggunakan metadata `mentions` pada `sendMessage`.
- Metadata chat yang sebelumnya hanya berisi label `Grup` diganti dengan nama grup dan isi pesan yang relevan.

### Security

- QR, pairing code, auth state, dan data sensitif tidak ditulis ke structured log dalam bentuk mentah.
- Database dan auth state dipertahankan melewati restart container.
- Command failure diisolasi agar error satu plugin tidak mematikan bot.

### Verification

- Framework, integration, menu, AFK, timestamp, dan welcome/leave test tersedia dan lulus pada baseline terkait.
- Deployment dilakukan melalui upload file individual ke Pterodactyl tanpa menjalankan `npm ci` di server.

## Template rilis baru

Template berikut digunakan setiap kali milestone selesai. Entri harus ditulis sebelum deployment final, lalu diperbarui setelah verifikasi deployment selesai.

```markdown
## [0.2.0] — Group foundation — YYYY-MM-DD

### Added

- `!groupid` — ...
- `!groupinfo` — ...

### Changed

- ...

### Fixed

- ...

### Security

- ...

### Configuration

- Added `ENV_NAME=...`.
- Changed default `...` from `...` to `...`.

### Migration

- No database migration required.

### Verification

- Typecheck: pass.
- Build: pass.
- Tests: X/X pass.
- Panel verification: ...

### Deployment notes

- Uploaded files: ...
- Database/auth state: preserved.
- Rollback: ...
- Known issues: ...
```

## Kebijakan pencatatan command

Command baru tidak ditulis di bagian `Added` hanya karena sudah dirancang di katalog. Command baru masuk changelog setelah parser, handler, permission, output, storage bila diperlukan, error handling, dan verification-nya selesai. Jika command diubah tetapi alias lama tetap tersedia, catat sebagai `Changed`. Jika alias atau command lama dihapus, gunakan `Deprecated` terlebih dahulu sebelum `Removed`, kecuali ada alasan security yang memerlukan penghapusan langsung.

Untuk perubahan yang menyentuh schema SQLite, changelog harus menyebutkan nama database, versi migrasi, apakah migrasi otomatis atau manual, backup yang diperlukan, dan prosedur rollback. Untuk perubahan `.env`, changelog harus menyebutkan nama variable dan nilai default tanpa menampilkan credential.

## Referensi status

Roadmap dan prioritas milestone disimpan di [`ROADMAP.md`](./ROADMAP.md). Katalog ide command lengkap disimpan di [`command-catalog.md`](./command-catalog.md). Catatan deployment maintenance mode disimpan di [`deploy_notes_maintenance.md`](./deploy_notes_maintenance.md).
