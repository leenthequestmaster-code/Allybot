# Existing Features Audit — Allybot

## Scope dan metode

Audit ini dilakukan sebelum perancangan Batch Update fitur baru. Scope mencakup AFK, Welcome/Leave, group foundation, group configuration, Group Setup Mission, menu/native interaction, diagnostics, serta cross-cutting framework dan WhatsApp adapter yang memengaruhi seluruh fitur tersebut.

Audit dilakukan dengan membaca implementasi aktual di `src/`, memeriksa test yang tersedia, menelusuri entry point dan event flow, melakukan static scan sederhana, serta menjalankan workflow validasi repository. Tidak ada source code runtime yang diubah selama audit ini.

## Baseline validasi

| Pemeriksaan | Hasil aktual |
|---|---|
| `npm run typecheck` | Lulus |
| `npm run build` | Lulus |
| `npm run verify:platform` | Lulus |
| `npm test` | 64 lulus, 0 gagal, 0 skipped |
| Tracked source diff | Tidak ada perubahan |
| Sensitive runtime data | Tidak ditemukan dalam perubahan audit; `.ci-artifact/` hanya diperiksa berdasarkan nama dan ukuran file |

Working tree memiliki file untracked yang sudah ada atau dihasilkan sebelumnya: `.ci-artifact/` dan beberapa dokumen roadmap/arsitektur. Audit ini tidak meng-commit, push, upload, atau deploy apa pun.

## Arsitektur aktual yang relevan

`src/index.ts` membuat `ApplicationFramework`, mendaftarkan `AfkService` dan `GroupConfigurationService`, lalu memuat plugin diagnostics, menu, Welcome/Leave, group foundation, Group Setup Mission, dan AFK. Message dari WhatsApp masuk ke `message.received`, diproses oleh event listener plugin, lalu diteruskan ke `CommandRegistry.dispatch`. Event bus mengisolasi rejection listener dengan `Promise.allSettled`, sedangkan command registry mengisolasi kegagalan handler melalui `command.failed` dan `framework.error`.

Alur ini sudah cukup modular, tetapi plugin lifecycle belum konsisten. Hanya Group Setup Mission yang menyimpan unsubscriber event dan unregister command pada `unload()`. Plugin lain mendaftarkan listener/command tanpa cleanup eksplisit.

## Ringkasan status fitur

| Fitur | Kondisi saat ini | Penilaian audit |
|---|---|---|
| AFK | Persistence SQLite, auto-return, mention tracking, private forward, status, list, leaderboard, migrasi timestamp legacy | Fondasi kuat; gap utama ada pada retention/privacy, write amplification, dan concurrency kecil pada forwarding |
| Welcome/Leave | Event-driven, custom template, mention participant, fallback default | Berfungsi; gap utama ada pada lifecycle cleanup, dedupe event, dan error/observability |
| Group foundation | Informasi grup, member/admin list, role, permissions, invite link | Berfungsi; ada gap UX pagination prefix, quoted target, dan error response |
| Group configuration | Rules, custom messages, prefix, language, timezone, rules history, persistence, transactional apply | Relatif kuat; audit trail belum konsisten untuk semua setting dan history tidak memiliki retention |
| Group Setup Mission | Resumable, persistent, expiry, role recheck, atomic apply, idempotency engine | Paling production-shaped; perlu peningkatan observability dan test edge case tambahan |
| Menu/native button | Native main-menu only, 3-button limit, NEXT, fallback text, reply number, submenu text-only | Sesuai requirement; gap utama state scope per chat, quoted-origin validation langsung, dan UX order |
| Diagnostics | `diag` dan `health`, status koneksi + daftar service | Terlalu minimal untuk health check operasional; alias `diagnostics` belum terdaftar di source aktual |

## Temuan prioritas tinggi

### P1 — Plugin lifecycle cleanup tidak konsisten

**Bukti:** `PluginManager.unload()` memanggil `plugin.unload?.()`, tetapi `afk.ts`, `welcome-leave.ts`, `menu.ts`, `group.ts`, dan `diagnostics.ts` tidak menyimpan unregister command maupun unsubscriber event. Static scan menunjukkan hanya `group-setup-mission.ts` yang memiliki `unload()`, `unbindMessageListener`, dan `unregisterCommand`.

**Dampak:** Jika plugin di-unload lalu di-load kembali dalam proses yang sama, command dapat gagal didaftarkan karena nama sudah ada dan listener lama tetap aktif. Pada recovery/reload, satu pesan berpotensi diproses lebih dari sekali. Saat ini test reload hanya membuktikan Group Setup Mission, sehingga gap plugin lain belum dilindungi.

**Rekomendasi:** Tambahkan pola cleanup yang konsisten pada seluruh plugin atau sediakan lifecycle-managed registration di framework. Perubahan sebaiknya additive dan diuji dengan skenario load → unload → load ulang.

### P1 — Command dispatch belum memiliki guard `fromMe` di satu boundary pusat

**Bukti:** `WhatsAppConnection.emitMessages()` menghasilkan `CoreMessage` dengan `fromMe`, dan beberapa plugin secara individual memeriksa `message.fromMe`. Namun `CommandRegistry.dispatch()` tidak menolak message `fromMe` secara terpusat.

**Dampak:** Jika message bot sendiri masuk ke event notify, command yang diawali prefix dapat diproses sebagai input user. Sebagian plugin aman karena memiliki guard lokal, tetapi proteksinya tidak seragam.

**Rekomendasi:** Tambahkan kebijakan single-source-of-truth di command dispatch: message `fromMe` tidak dieksekusi sebagai command, disertai regression test. Guard lokal tetap boleh dipertahankan untuk event listener non-command.

### P1 — Penyimpanan AFK mention tidak memiliki retention atau batas per user

**Bukti:** `AfkService.recordMention()` menyimpan `message_text` dan `quoted_text` ke SQLite tanpa batas jumlah atau TTL. `getMentions()` mengambil seluruh riwayat, walaupun UI private hanya menampilkan sepuluh item teratas.

**Dampak:** Database AFK dapat tumbuh tanpa batas pada grup aktif. Isi pesan dan quoted message berpotensi menyimpan data pribadi lebih lama dari kebutuhan fitur. Query dan backup juga menjadi semakin berat.

**Rekomendasi:** Tetapkan retention policy, misalnya maksimum jumlah mention per user dan/atau umur maksimum, lakukan pruning terkontrol, batasi ukuran field sebelum insert, dan dokumentasikan kebijakan data. Jangan menghapus histori statistik AFK saat memang masih diperlukan leaderboard.

## Temuan prioritas menengah

### P2 — AFK presence melakukan write SQLite pada setiap pesan

**Bukti:** Listener AFK memanggil `touchPresence()` untuk setiap pesan non-AFK dari setiap sender. Implementasi melakukan `INSERT ... ON CONFLICT UPDATE` langsung ke SQLite.

**Dampak:** Grup aktif dapat menghasilkan write amplification, WAL growth, dan contention yang tidak perlu. Fitur tetap benar, tetapi biaya operasional meningkat.

**Rekomendasi:** Tambahkan throttling/debounce presence per user, misalnya hanya menulis jika timestamp terakhir sudah melewati interval tertentu. Pastikan start AFK tetap menggunakan timestamp presence terbaik yang tersedia.

### P2 — AFK forwarding mengambil mention terbaru setelah insert secara non-atomik

**Bukti:** Handler memanggil `recordMention()`, kemudian mengambil `afk.getMentions(targetJid)[0]` secara terpisah. Beberapa pesan yang masuk hampir bersamaan dapat membuat item terbaru bukan mention yang baru saja diproses.

**Dampak:** Forward private dapat berisi waktu atau sumber pesan yang salah. Ini bukan privilege escalation, tetapi merusak keakuratan fitur.

**Rekomendasi:** Ubah service agar `recordMention()` mengembalikan record mention yang baru dibuat, atau gunakan identifier insert. Pertahankan perubahan minimal dan tambahkan test concurrency-oriented secara deterministik.

### P2 — Welcome/Leave dan sebagian plugin tidak memiliki cleanup listener

Temuan ini merupakan bagian dari P1 lifecycle, tetapi dampaknya pada Welcome/Leave perlu diuji khusus karena listener-nya event-driven. Selain cleanup, event participant tidak memiliki message/event identifier pada `CoreGroupParticipantUpdate`, sehingga deduplikasi tidak dapat dilakukan di plugin tanpa memperluas contract adapter.

**Rekomendasi:** Prioritaskan cleanup dahulu. Deduplikasi baru dilakukan jika terdapat bukti event duplicate aktual dari log atau reproduksi adapter.

### P2 — Group pagination menampilkan prefix hard-coded

**Bukti:** `renderParticipantList()` membentuk instruksi `Ketik !${nextCommand} ...`, sedangkan command lain memakai `commandContext.prefix` dan group dapat memiliki prefix custom.

**Dampak:** User pada grup dengan prefix `##`, misalnya, menerima instruksi yang salah dan dapat mengira pagination tidak berfungsi.

**Rekomendasi:** Pass effective prefix ke renderer dan tambahkan test untuk pagination dengan group prefix custom.

### P2 — Target `memberinfo` mengklaim mendukung reply tetapi hanya membaca mention

**Bukti:** Pesan bantuan `memberinfo` berbunyi “Reply atau mention satu member”, tetapi handler hanya mengambil `commandContext.message.mentionedJids?.[0]`. `quotedSenderJid` tidak digunakan.

**Dampak:** UX tidak konsisten dengan instruksi. Reply ke pesan member tidak menghasilkan target.

**Rekomendasi:** Dukung `quotedSenderJid` dengan precedence yang jelas: mention pertama, quoted sender, atau tolak jika lebih dari satu target. Tambahkan test.

### P2 — Error command sebagian besar hanya dicatat, tanpa respons user yang konsisten

**Bukti:** `CommandRegistry.dispatch()` menangkap error handler, menulis log, dan emit event, tetapi tidak mengirim pesan kegagalan generik kepada user. Command yang gagal saat metadata grup atau invite link mengalami timeout/error dapat terlihat sebagai tidak merespons.

**Dampak:** Diagnosis operator menjadi lebih sulit dan UX terlihat seperti bot mati, walaupun framework masih hidup.

**Rekomendasi:** Tambahkan error response generik yang tidak membocorkan detail internal, dengan rate limit atau correlation id bila diperlukan. Jangan mengirim stack trace atau error mentah ke WhatsApp.

### P2 — Audit trail konfigurasi grup belum konsisten

**Bukti:** Rules memiliki `group_rules_history`, tetapi welcome, leave, prefix, language, timezone, dan operasi clear tidak memiliki histori perubahan setara. Record hanya menyimpan updater terakhir.

**Dampak:** Admin dapat melihat keadaan sekarang, tetapi sulit menelusuri siapa yang mengubah setting lain dan kapan. Ini mengurangi operability dan forensic value.

**Rekomendasi:** Jangan langsung membuat satu audit system besar. Tambahkan event/audit record generik setelah kebutuhan audit moderation atau governance benar-benar dimulai, atau mulai dari perubahan konfigurasi yang paling berisiko.

### P2 — Menu native state hanya keyed by `remoteJid`

**Bukti:** `activeNativeMenus` pada `menu.ts` adalah `Map<string, ActiveNativeMenu>` dengan key `message.remoteJid`. Menu baru pada chat/grup yang sama menggantikan state menu sebelumnya.

**Dampak:** Dua user yang membuka menu hampir bersamaan dalam grup dapat membuat button milik user pertama tidak berfungsi. Ini terutama masalah UX dan bukan privilege bypass karena callback hanya menampilkan submenu.

**Rekomendasi:** Key state dengan scope chat plus actor jika transport selalu menyediakan actor, atau gunakan token yang membawa context tervalidasi. Pertahankan fallback text dan expiry lima menit.

### P2 — Reply angka di listener menu tidak memvalidasi quoted sender secara langsung

**Bukti:** `menu.ts` hanya memeriksa pola isi `quotedText` melalui `isMainMenuQuote()`. Adapter platform memiliki pemeriksaan `quotedSenderJid`, tetapi listener menu menerima raw `message.received` dan tidak menggunakan pemeriksaan tersebut.

**Dampak:** Menu yang disalin atau dipalsukan dapat memicu navigasi submenu. Dampaknya terbatas pada discovery command karena tidak menjalankan command target dan tidak mengubah permission.

**Rekomendasi:** Selaraskan validasi dengan contract quoted sender pada boundary menu. Jika metadata quoted sender tidak tersedia pada seluruh legacy message, gunakan fallback yang tetap tidak memengaruhi security-sensitive action.

## Temuan prioritas rendah atau keputusan desain

### P3 — Prioritas kategori native berbeda dari urutan fallback angka

Menu teks dan fallback angka memakai canonical order taxonomy v1.0, sedangkan native menu memprioritaskan kategori yang memiliki command sebelum kategori Coming Soon agar fitur aktif lebih cepat ditemukan. Tombol membawa target kategori langsung sehingga tidak bergantung pada nomor teks; perbedaan urutan visual tetap merupakan residual UX yang perlu dikonfirmasi pada WhatsApp nyata.

Focused contract test sudah memverifikasi pagination, callback target, dan fallback. Jangan mengganti format native atau menambahkan `location`/`contextInfo` tanpa spike kompatibilitas terpisah pada Baileys pinned.

### P3 — Diagnostics belum mencerminkan health operasional penuh

Source aktual hanya mendaftarkan `diag` dengan alias `health`, bukan alias `diagnostics`. Response hanya memuat `isConnected` dan daftar service. Ia tidak memberi framework phase, plugin state, storage integrity, last connection transition, atau latency.

Rekomendasi minimal adalah memperbaiki alias dan menambah informasi non-sensitive yang benar-benar tersedia. Health check lebih detail sebaiknya dibuat setelah kebutuhan observability ditentukan, bukan dengan membuka path database atau credential state ke chat.

### P3 — `permissions` adalah deskripsi statis, bukan policy introspection

Command tersebut menampilkan teks “Menggunakan command admin setelah policy tersedia” untuk admin, sementara beberapa command admin sudah memiliki policy. Ini dapat membingungkan dan tidak sejalan dengan permission registry aktual.

Perbaikan minimal adalah mengganti wording agar menjelaskan “command admin yang tersedia sesuai policy”, atau membangun daftar dinamis hanya jika registry permission memang sudah memiliki contract yang stabil.

## Fitur yang saat ini relatif kuat

AFK telah memiliki integration test untuk persistence, mention forwarding, auto-unset, private status, leaderboard, prefix resolution, dan migrasi timestamp legacy. Group configuration memiliki test untuk admin-only, isolasi antar-grup, persistence restart, validasi rules, welcome/leave, prefix, language, timezone, dan rules history. Group Setup Mission memiliki test persistence reload dan role recheck, sementara Mission Engine memiliki test idempotency, expiry, revision, persistence, dan rejection input oversized.

Menu juga memiliki regression test yang cukup lengkap untuk alias, hidden command, prefix grup, quoted numeric reply, native callback, fallback ketika native sender gagal, submenu pagination, Coming Soon, dan NEXT. Karena itu, audit tidak merekomendasikan mengulang implementasi fondasi-fondasi tersebut; fokusnya adalah gap yang belum dijaga oleh test atau inconsistency yang terlihat dari source.

## Urutan improvisasi yang direkomendasikan

| Urutan | Perubahan | Alasan |
|---|---|---|
| **A** | Plugin lifecycle cleanup + regression load/unload/reload | Cross-cutting, risiko duplicate command/listener, perubahan relatif kecil |
| **B** | Central `fromMe` command guard | Security/reliability boundary sederhana dan mudah diuji |
| **C** | Group UX fixes: pagination prefix dan quoted target | Dampak langsung ke user, scope kecil |
| **D** | AFK retention, field-size limit, dan throttled presence | Mengurangi pertumbuhan database dan write amplification |
| **E** | AFK mention insert mengembalikan record baru | Memperbaiki akurasi forwarding pada input cepat bersamaan |
| **F** | Generic safe command error response | Memperbaiki UX operasional, perlu desain wording/rate limit |
| **G** | Menu state per actor dan quoted-origin validation | Memperbaiki multi-user group UX tanpa mengubah fallback |
| **H** | Diagnostics alias dan health snapshot non-sensitive | Meningkatkan observability setelah contract status disepakati |
| **I** | Audit trail konfigurasi grup yang lebih lengkap | Valuable, tetapi lebih besar dan dapat menunggu kebutuhan moderation/governance |

## Requirement dan change gate

Tidak ada Batch Update fitur baru yang dirancang sebelum backlog improvisasi existing ditinjau. Mission Platform tetap merupakan satu platform terpadu secara arsitektur, tetapi implementasinya dikerjakan **secara independen setelah seluruh Batch Update selesai**.

Sebelum implementasi perubahan existing, prioritas harus dipilih dari backlog di atas. Setiap item terpilih akan dikerjakan sebagai perubahan minimal terpisah, lalu melewati typecheck, build, seluruh test, test regresi spesifik, static scan, dan review security/edge case. Tidak ada deployment ke Panel sebelum user mengonfirmasi hasil validasi lokal.
