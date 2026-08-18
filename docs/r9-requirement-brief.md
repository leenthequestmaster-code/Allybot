# R9 Requirement Brief — Event Conductor dan Multi-Phase Event

## Objective

R9 menambahkan **Event Conductor** untuk operasi event komunitas berbasis grup. Event ditulis oleh creator, memiliki satu atau lebih fase, lifecycle yang eksplisit, peserta yang join secara opt-in, waktu tersimpan persisten sebagai epoch milliseconds, dan tampilan kalender berbasis timezone IANA. Fitur bersifat opt-in per grup melalui `group.event.core`, default `off`.

## Command contract

| Command | Behavior |
|---|---|
| `!event` atau `!events` | Menampilkan kalender bounded bila event tersedia, atau fallback help text. |
| `!event enable\|disable` | Admin grup mengubah feature flag R9. Default tetap off pada grup baru. |
| `!event create judul \| deskripsi \| start RFC3339 \| IANA/UTC \| fase @ start [@ end] ; fase berikutnya` | Admin membuat event `draft` creator-owned dengan minimal satu fase dan urutan contiguous mulai dari 1. |
| `!event publish <id>` | Admin yang juga creator mengubah `draft → published` dengan CAS. |
| `!event join <id>` | Actor melakukan opt-in sebagai peserta pada event `published`, `active`, atau `paused`. Operasi idempotent. |
| `!event leave <id>` | Actor melakukan opt-out. Operasi idempotent dan tidak menghapus histori participant row. |
| `!event status [<id>]` | Menampilkan bounded calendar atau status satu event, tanpa raw JID participant. |
| `!event phase <id> <number>` | Admin yang juga creator memilih fase aktif; fase sebelumnya ditandai completed dan fase lain scheduled, melalui operation ledger dan CAS event revision. |
| `!event pause <id>` | Admin creator mengubah event menjadi `paused`. |
| `!event resume <id>` | Admin creator mengubah event `paused → active`. |
| `!event close <id>` | Admin creator menutup event dan menghasilkan outcome `closed`. |
| `!event recap <id>` | Menampilkan status, fase, jumlah peserta, dan participant reference hash yang bounded. |
| `!event poll <id> pertanyaan \| opsi 1 \| opsi 2` | Menautkan poll ke event melalui `CollaborationService` bila collaboration aktif; tidak menduplikasi voting engine. |
| `!event location <id> label \| latitude \| longitude` | Creator menyimpan metadata lokasi tervalidasi dan menampilkan fallback teks; native location tidak dipanggil. |
| `!event contact <id>` | Memberi capability-unavailable fallback karena contact-card native belum terverifikasi pada adapter. Tidak membocorkan raw creator JID. |
| `!calendar [<id>]` | Menampilkan event calendar bounded atau detail satu event. Submenu tetap text-only. |

## Invariants

Semua group JID dan actor JID divalidasi dengan validator lokal berbasis `isJid()`. Event ID menerima identifier aman dan prefix hanya bila tidak ambigu. Query object selalu menyertakan `group_jid`, sehingga event dari grup lain tidak dapat dibaca atau dimutasi melalui ID yang sama. Teks, timezone, timestamp, phase order, jumlah fase, jumlah peserta, latitude, dan longitude memiliki batas validasi eksplisit.

Lifecycle yang valid adalah `draft → published → active → paused → closed`, dengan `paused → active` sebagai resume. Creator-only enforcement dilakukan di service; plugin juga melakukan live admin recheck sebelum create, publish, phase, pause, resume, dan close. Join dan leave tidak memerlukan admin karena merupakan opt-in/out actor sendiri. Feature flag dan capability missing fail-closed.

Dispatcher menggunakan query bounded, `setInterval`, `unref`, `clearInterval`, `dispatchInFlight`, dan `dispatchPromise` tracking. Transition otomatis memakai deterministic operation ID, claim CAS, operation status, dan reclaim terbatas untuk operation `failed` atau `running` yang stale. State event tidak dihapus ketika transport notification gagal. Shutdown menunggu dispatch yang sedang berjalan sebelum database ditutup.

Audit menggunakan namespace `allybot` dan outcome yang valid (`allowed`, `denied`, `changed`, `failed`, `limited`, `opened`, `closed`). Audit tidak menyimpan raw JID, nomor telepon, message content, raw event ID, raw poll ID, location label, credential, atau raw error. Participant presentation menggunakan hash reference yang dipotong bounded; JID operasional tetap hanya berada di storage untuk authorization dan delivery.

## Persistence and recovery

SQLite menggunakan tabel additive `events`, `event_phases`, `event_participants`, dan `event_operations` dengan foreign key, unique constraint, dan index bounded. Epoch milliseconds adalah source of truth. Timezone IANA hanya digunakan untuk provenance dan presentasi kalender. Setelah restart, service melakukan migration idempoten, membuka storage, dan dispatcher melakukan recovery scan terhadap event published/active yang sudah due.

## Compatibility and non-goals

R9 tidak menambah dependency baru dan tidak mengubah `WhatsAppPort`. Contact-card dan native location tidak dipanggil karena capability adapter yang terverifikasi belum tersedia. Poll tetap bergantung pada `CollaborationService`; bila service atau feature flag collaboration tidak tersedia, event tetap tersimpan tetapi linkage ditolak dengan fallback aman.

R9 tidak membaca passive full-chat memory, tidak mengambil keputusan canon otomatis, tidak menghapus message, tidak menyediakan eval/exec/shell/raw logs/database dump/credential/logout/reconnect, tidak memakai button untuk submenu, dan tidak menambahkan unsur RPG seperti XP, level, stat, loot, currency, combat, atau gacha. Mission Platform tetap berada setelah R11.
