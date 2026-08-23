# Roadmap Pengembangan Allybot

> **Current status snapshot — 23 Agustus 2026:** Core, Owner/Developer control plane, Group Foundation, behavior-wide hardening, architecture upgrade, Supabase boundaries, Neon client/writer, Neon capture, and Upstash Redis artifact integration have been implemented and verified in their respective batches. The remaining release-critical gaps are runtime reload verification, Neon chat-log opt-out release, documentation reconciliation, menu v1.0 finalization, and isolated live WhatsApp acceptance. Historical milestone paragraphs below are retained for provenance; use the current snapshot and latest CI evidence when wording differs.

Roadmap ini menetapkan arah pengembangan Allybot secara bertahap. Daftar command yang besar tidak dimaksudkan untuk dibuat sekaligus; setiap milestone harus menghasilkan bot yang tetap dapat dijalankan, diuji, dan dipelihara. Nomor versi di bawah adalah rancangan release track, bukan jadwal kalender. Sebuah rilis dianggap siap ketika kriteria selesai dan verifikasinya terpenuhi, bukan karena sudah mencapai tanggal tertentu.

## Prinsip prioritas

Prioritas Allybot ditentukan oleh empat pertimbangan. Pertama, fitur yang memperkuat stabilitas, keamanan, persistence, dan observability harus didahulukan. Kedua, fitur yang menjadi dependency bagi banyak plugin lain harus dibangun sebelum fitur yang menggunakannya. Ketiga, fitur read-only dan berisiko rendah sebaiknya mendahului fitur yang mengubah grup atau mengirim pesan massal. Keempat, setiap milestone harus tetap menjaga error isolation, structured logging dengan redaction, persistence SQLite, dan kemampuan graceful shutdown.

Fitur baru tidak dianggap selesai hanya karena command merespons sekali. Fitur harus memiliki validasi input, permission yang tepat, cooldown bila relevan, test atau functional verification, penanganan kegagalan eksternal, serta catatan konfigurasi dan migrasi apabila membutuhkan perubahan database.

## Status baseline saat ini

| Release track | Status | Isi utama |
|---|---|---|
| `v0.1.0` Core baseline | Selesai | Baileys connection layer, SQLite auth persistence, logger, configuration, lifecycle, framework modular, menu, AFK, welcome/leave. |
| `v0.1.1` Maintenance and recovery patch | Berjalan | Maintenance mode, guard agar socket tidak dibuat saat WhatsApp dinonaktifkan, penanganan 408 tanpa retry agresif, dan keepalive lifecycle. |
| `v0.2.0` Group foundation | Selesai offline | Permission policy dasar, group metadata, group ID, group info, admin/member listing, rules read-only, dan invite link dengan pengecekan akses. Belum dideploy. |
| `v0.3.0` Group configuration | Selesai offline | Group Configuration Service SQLite, rules history, welcome/leave template, prefix per grup, language preference, timezone per grup, dan seluruh command konfigurasi. Belum dideploy. |

## Milestone 0 — Core baseline: `v0.1.0`

Milestone ini merupakan fondasi yang sudah dibangun. Tujuannya adalah memastikan Allybot bukan sekadar script command, melainkan aplikasi yang memiliki pemisahan transport WhatsApp, application framework, plugin registry, service registry, event bus, command registry, storage, configuration, logging, dan lifecycle management.

Fitur yang sudah termasuk adalah `!ping`, `!menu`, `!help`, `!back`, AFK berbasis SQLite, auto-unset AFK, forwarding mention ke pengguna AFK, metadata grup dan pesan pada log AFK, serta welcome/leave dengan mention clickable. Baseline ini juga mencakup error isolation sehingga kegagalan command atau plugin tidak menjatuhkan framework.

**Exit criteria:** core dapat start, menerima event, memproses command, menyimpan data, shutdown secara graceful, dan seluruh regression test yang tersedia lulus.

## Milestone 1 — Maintenance dan recovery: `v0.1.1`

Milestone ini berfokus pada kondisi operasional ketika WhatsApp sedang cooldown atau belum siap diautentikasi. Allybot harus tetap dapat menjalankan framework dan service tanpa membuat socket WhatsApp. Proses juga harus tetap hidup agar Pterodactyl tidak menganggap container berhenti secara bersih setelah startup.

Fitur dan perbaikan yang termasuk adalah `WHATSAPP_ENABLED`, `QR_ENABLED`, dan `PAIRING_ENABLED` sebagai kontrol terpisah; guard pada start, socket creation, dan reconnect; penanganan status 408 yang tidak masuk retry loop; logging pairing yang tetap ter-redact; serta keepalive maintenance mode yang dibersihkan saat shutdown.

**Exit criteria:** server dapat berjalan dalam maintenance mode, log tidak membocorkan QR atau auth state, tidak ada socket WhatsApp yang dibuat, tidak ada reconnect attempt, proses bertahan, shutdown SIGTERM tetap graceful, dan konfigurasi dapat dikembalikan ke mode auth tanpa perubahan database.

## Milestone 2 — Permission policy dan group foundation: `v0.2.0`

Ini adalah prioritas fitur berikutnya. Banyak plugin masa depan seperti `!setrules`, moderasi, broadcast, dan pengaturan grup memerlukan keputusan permission yang konsisten. Karena itu, permission policy harus dibuat sebelum command yang dapat mengubah keadaan grup.

Cakupan command publik awal adalah `!groupid`, `!groupinfo`, `!admins`, `!members`, `!membercount`, `!memberinfo @user`, `!rules`, `!role`, dan `!permissions`. Cakupan command admin atau owner adalah konfigurasi owner internal, pemeriksaan role, dan policy minimal. `!link` dapat disertakan apabila bot dapat membaca invite link dan status admin sudah tervalidasi.

Policy awal cukup menggunakan role `owner`, `admin`, dan `member`, ditambah identitas `bot` bila dibutuhkan oleh pemeriksaan internal. Jangan langsung membuat role hierarchy atau permission DSL yang kompleks. Metadata WhatsApp menjadi sumber status admin grup, sedangkan owner bot disimpan melalui konfigurasi atau storage yang aman.

**Exit criteria:** command grup menolak private chat dengan pesan yang jelas; output mention dapat diklik; status admin dan creator dinormalisasi; command sensitif menolak member biasa; permission failure tidak mengeksekusi handler; owner bot tersimpan secara eksplisit melalui `BOT_OWNER_JID`; permission yang tidak dikenal default-deny; denial response konsisten; dan test mencakup bot owner, creator, admin, member, private chat, unknown permission, konfigurasi invalid, serta metadata yang tidak lengkap. Exit criteria ini telah terpenuhi secara offline. Group foundation dan permission policy tetap belum dideploy ke panel.

## Milestone 3 — Konfigurasi grup: `v0.3.0`

Setelah permission policy tersedia, Allybot dapat mulai menyimpan konfigurasi yang berbeda untuk tiap grup. Fokusnya adalah fitur yang meningkatkan kegunaan komunitas tanpa melakukan moderasi agresif.

Seluruh scope command Milestone 3 telah selesai secara offline. Cakupannya adalah `!rules`, `!setrules`, `!clearrules`, `!ruleshistory`, `!setwelcome`, `!clearwelcome`, `!setleave`, `!clearleave`, `!groupsettings`, `!prefix`, `!setprefix`, `!setlanguage`, dan `!settimezone`, dengan `GroupConfigurationService` SQLite terpisah, isolasi antargrup, validasi, audit history rules, metadata perubahan, migrasi schema, template placeholder, resolver prefix per grup, timezone IANA, dan persistence setelah restart.

`!setlanguage` menyimpan language preference yang dipakai pada konfigurasi grup dan output konfigurasi terkait; ini belum merupakan lokalisasi seluruh output plugin. Lokalisasi penuh tetap menjadi pekerjaan terpisah, bukan bagian tersembunyi dari Milestone 3.

Setiap perubahan harus memiliki batas panjang, validasi, audit ringan, dan pesan konfirmasi. Pengaturan yang belum tersedia tidak boleh dibuat seolah-olah aktif. Bila timezone atau bahasa belum benar-benar digunakan oleh runtime, konfigurasi tersebut belum perlu diekspos.

**Exit criteria Milestone 3:** konfigurasi antargrup terisolasi, migrasi SQLite dapat dijalankan tanpa kehilangan data, admin dapat mengubah dan menghapus konfigurasi, history rules mencatat set/clear beserta actor dan waktu, event participant memakai template aktif atau fallback default, parser command memakai prefix grup dengan fallback prefix global, timezone IANA memformat audit time, member tidak dapat mengubah konfigurasi, dan restart container tidak menghilangkan konfigurasi. Milestone ini telah lulus secara offline dengan 28/28 test; deployment ke panel tetap ditunda sampai cooldown WhatsApp berakhir.

## Milestone 4 — Moderasi aman: `v0.4.0`

Milestone ini memperkenalkan moderasi yang dapat dipahami dan dibatalkan. Fokus awal bukan membuat sistem anti-spam besar, melainkan menyediakan audit dan tindakan dasar yang memiliki permission jelas.

Cakupan command adalah `!warn`, `!warnings`, `!unwarn`, `!clearwarnings`, `!modlog`, `!case`, `!delete`, `!tagall`, dan tindakan grup seperti `!promote`, `!demote`, `!kick`, `!approve`, atau `!reject` hanya jika Baileys dan status admin mendukungnya. Sistem mute dapat dimulai sebagai policy internal sebelum mencoba mengubah setting grup.

Setiap kasus moderasi harus mencatat grup, target, pelaksana, waktu, alasan, tindakan, dan status rollback jika tersedia. Message body tidak boleh masuk log umum secara sembarangan. Command tindakan grup harus gagal dengan aman ketika bot bukan admin.

**Exit criteria:** tindakan admin terproteksi, modlog dapat ditelusuri, warning tidak hilang ketika restart, semua tindakan eksternal memiliki error handling, dan tidak ada command moderasi yang dapat dipakai oleh member biasa.

## Milestone 5 — Productivity dan community tools: `v0.5.0`

Milestone ini menambahkan fitur yang membantu komunitas tanpa bergantung pada roleplay atau ekonomi virtual. Kandidat utamanya adalah notes, reminder, polling, event, task, dan presensi.

Cakupan command adalah `!note add`, `!note list`, `!note get`, `!note delete`, `!remind`, `!reminders`, `!cancelremind`, `!poll`, `!poll result`, `!poll close`, `!event`, `!event list`, `!event cancel`, `!task`, dan `!attendance`. Reminder dan event memerlukan scheduler yang persisten, timezone yang jelas, idempotency, serta mekanisme pemulihan setelah restart.

**Exit criteria:** job tidak terkirim dua kali setelah restart, timezone ditampilkan secara eksplisit, pengguna hanya dapat mengubah data miliknya kecuali admin diberi hak, job yang gagal tercatat, dan data lama memiliki kebijakan retention yang jelas.

## Milestone 6 — Media dan content tools: `v0.6.0`

Milestone ini memperluas folder `media` dan pipeline pemrosesan media. Fitur harus dibangun berdasarkan kebutuhan nyata dan keterbatasan resource Pterodactyl, bukan sekadar mengumpulkan converter.

Kandidat command adalah `!sticker`, `!toimg`, `!toaudio`, `!tovn`, `!compress`, `!resize`, `!crop`, `!qr`, `!readqr`, `!ocr`, `!caption`, dan `!tourl`. Setiap file harus divalidasi berdasarkan ukuran, MIME type, durasi, dan batas concurrency. File sementara harus dibersihkan setelah proses selesai atau gagal.

**Exit criteria:** media besar ditolak dengan pesan yang jelas, proses tidak menghabiskan memory secara tidak terkendali, file temporary dibersihkan, error converter terisolasi, dan media yang diproses tidak otomatis disimpan permanen tanpa kebijakan.

## Milestone 7 — AI utility: `v0.7.0`

AI utility hanya dibuat setelah permission, rate limit, privacy, dan external provider abstraction cukup jelas. Fitur awal sebaiknya fokus pada transformasi teks atau media yang diminta langsung, bukan agent yang memiliki kemampuan luas.

Kandidat command adalah `!ask`, `!summarize`, `!rewrite`, `!correct`, `!translateai`, `!extract`, `!describe`, `!captionai`, dan `!transcribe`. Semua input harus memiliki batas panjang dan semua output harus dapat gagal tanpa menjatuhkan plugin.

**Exit criteria:** provider timeout dan error ditangani, rate limit per pengguna atau grup tersedia, API key tidak pernah masuk log, prompt atau message body tidak disimpan tanpa kebijakan, dan output menjelaskan keterbatasan ketika diperlukan.

## Milestone 8 — Roleplay foundation: `v0.8.0`

Milestone ini mulai membangun identitas komunitas Allybot tanpa langsung membuat RPG penuh. Fokusnya adalah profil karakter, lore, scene, quote, dan emote yang dapat digunakan secara sosial.

Kandidat command adalah `!character create`, `!character view`, `!character edit`, `!character list`, `!lore add`, `!lore list`, `!lore get`, `!scene start`, `!scene join`, `!scene leave`, `!scene status`, `!scene close`, `!quote add`, `!quotes`, dan `!emote`.

**Exit criteria:** data karakter dan lore terisolasi berdasarkan pengguna dan grup, perubahan memiliki validasi, penghapusan memerlukan konfirmasi, dan command roleplay tidak mencampur data dengan storage AFK atau permission.

## Milestone 9 — RPG alpha: `v0.9.0`

RPG sebaiknya dimulai sebagai alpha terbatas. Sistem minimal dapat mencakup registrasi pemain, statistik, level, inventory, item, quest sederhana, reward harian, dan leaderboard. Sistem battle, party, guild, craft, dan ekonomi penuh ditambahkan hanya setelah model data dasar stabil.

Kandidat command awal adalah `!register`, `!stats`, `!level`, `!inventory`, `!item`, `!daily`, `!quest`, `!quests`, `!quest accept`, `!quest abandon`, `!leaderboard`, dan `!rpghelp`. Command ekonomi seperti `!pay`, `!trade`, `!market`, dan `!bank` membutuhkan audit transaksi serta perlindungan dari duplikasi akibat retry.

**Exit criteria:** state RPG konsisten setelah restart, transaksi idempotent, reward tidak dapat diklaim berulang karena race condition, command memiliki cooldown, dan reset atau perubahan schema memiliki prosedur migrasi.

## Milestone 10 — Stable release: `v1.0.0`

Versi stabil bukan berarti semua command dalam katalog sudah tersedia. Versi stabil berarti fitur yang dipilih memiliki behavior yang terdokumentasi, migrasi yang jelas, observability yang cukup, dan prosedur recovery yang dapat dijalankan.

Sebelum `v1.0.0`, Allybot perlu memiliki regression suite yang mencakup core lifecycle, permission, group metadata, plugin isolation, SQLite migration, AFK, welcome/leave, media cleanup bila sudah ada, scheduler bila sudah ada, dan recovery setelah process restart. Deployment checklist harus memuat backup, perubahan `.env`, perubahan schema, rollback, serta verifikasi log.

## Rencana tertunda: lifecycle control online-only

Fitur `!restart` dan `!maintenance` sengaja ditunda sampai Allybot kembali online. Keduanya tidak akan dibuat setengah jadi selama maintenance mode dan tidak akan dideploy hanya berdasarkan unit test offline.

`!restart` nantinya menjadi command owner-only yang menjalankan graceful shutdown melalui lifecycle resmi Allybot. Proses tidak boleh melakukan spawn process sendiri. Keberhasilan hidup kembali bergantung pada restart policy Pterodactyl/Wings atau supervisor yang telah diverifikasi. Sebelum fitur dipakai, kita harus menguji proses shutdown, automatic restart, persistence database, dan recovery log dalam satu percobaan terkontrol.

`!maintenance` nantinya menjadi mode internal yang membuat bot tetap hidup dan panel tetap berstatus running, tetapi menonaktifkan fungsi WhatsApp atau fungsi command yang ditentukan. State maintenance harus memiliki sumber yang jelas, persistence yang aman, status yang dapat diperiksa, dan mekanisme pemulihan owner-only. Scope finalnya harus diputuskan terlebih dahulu: apakah hanya transport WhatsApp yang dihentikan, atau sebagian command juga dibatasi.

`!stop` tidak termasuk rencana. Jika proses benar-benar mati, `!start` tetap tidak dapat dijalankan melalui WhatsApp karena tidak ada bot yang menerima command; pemulihan tetap melalui panel atau controller eksternal. Tidak ada command lifecycle yang boleh mengekspos auth state, token, arbitrary shell, atau arbitrary SQL.

**Kriteria masuk implementasi:** WhatsApp sudah online, owner identity dan permission policy telah stabil, restart policy panel telah diverifikasi, state maintenance telah memiliki schema atau konfigurasi yang jelas, dan prosedur rollback tersedia. Rencana ini tersimpan sebagai backlog dan bukan fitur aktif.

## Backlog lintas milestone

Beberapa pekerjaan bukan plugin, tetapi harus dipelihara sepanjang roadmap. Pekerjaan tersebut meliputi test coverage, schema migration, backup dan restore verification, rate limiting, structured logging, redaction, error taxonomy, metrics, dependency pinning, resource monitoring, documentation, dan deployment verification. Backlog ini tidak boleh selalu ditunda sampai versi stabil karena kualitas setiap plugin bergantung padanya.

## Aturan masuk dan keluar milestone

Sebuah command boleh masuk milestone apabila tujuan pengguna jelas, scope-nya dapat diuji, permission-nya diketahui, storage-nya ditentukan, dan failure mode-nya dipahami. Sebuah milestone boleh ditutup apabila fitur utama telah diuji, tidak ada bug blocker, perubahan konfigurasi terdokumentasi, dan deployment tidak merusak fitur yang sudah ada.

Command eksperimental seperti arbitrary shell, arbitrary SQL, `eval`, atau command yang menampilkan auth state tidak masuk roadmap chat Allybot. Kemampuan tersebut tetap berada di luar permukaan command demi keamanan.
