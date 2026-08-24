# R9 Event Conductor — Architecture Brief

## Tujuan

R9 menambahkan **Event Conductor** untuk mengelola event komunitas yang ditulis oleh creator, memiliki beberapa fase, peserta opt-in, waktu tersimpan secara persisten, serta transisi otomatis yang aman setelah restart. R9 tetap text-first dan berjalan sebagai feature flag per grup dengan ID `group.event.core`, default **off**.

## Boundary dan tanggung jawab

`EventService` menjadi pemilik state event, fase, peserta, operation ledger, dan scheduler. Service memvalidasi JID, identifier, teks, timestamp epoch-ms, timezone IANA, batas jumlah fase/peserta, serta seluruh transisi lifecycle dengan compare-and-swap (CAS). Service tidak membaca riwayat chat dan tidak mengambil keputusan canon secara otomatis.

Plugin `event` hanya menangani parsing command, group scope, creator/admin gate, reply yang bounded, dan pemanggilan service. `ApplicationFramework` tetap menjadi pemilik lifecycle; plugin memulai dispatcher setelah service siap, sedangkan `EventService.shutdown()` menghentikan interval dan menyelesaikan timer secara aman.

`CollaborationService` adalah dependency opsional untuk event-linked poll. R9 tidak menduplikasi voting engine. Bila service collaboration tidak tersedia, feature collaboration off, atau native poll capability tidak ada, event tetap valid dan plugin memberi fallback teks yang eksplisit.

## Model data persisten

SQLite menggunakan tabel additive berikut: `events`, `event_phases`, `event_participants`, dan `event_operations`. State source-of-truth untuk waktu adalah epoch milliseconds. `timezone` hanya dipakai untuk presentasi kalender dan provenance. `event_operations` adalah ledger idempotency untuk transisi fase yang memiliki side effect dan untuk recovery setelah restart.

Semua tabel memiliki `group_jid` sebagai isolation key. Query daftar selalu bounded. Unique constraint mencegah participant duplicate dan operation duplicate. Data operasional dapat menyimpan JID untuk authorization dan delivery, tetapi audit hanya menyimpan hash atau ukuran data yang telah disanitasi.

## Lifecycle dan scheduler

Lifecycle event: `draft → published → active → paused → closed`. Publish, pause, resume, close, dan perubahan fase creator-only. Dispatcher menjalankan bounded scan berkala dengan `setInterval`, `unref`, dan `clearInterval` saat shutdown. Klaim due transition menggunakan CAS sehingga restart atau dua tick tidak menggandakan side effect. Dispatcher memulihkan event `published` yang sudah melewati `start_at`, mengaktifkan fase due, menyelesaikan fase yang melewati `end_at`, dan menutup event yang telah berakhir sesuai state yang persisted.

Notifier hanya mengirim ringkasan transisi ke grup ketika adapter tersedia dan notification policy R5 mengizinkannya. Kegagalan transport tidak menghapus state; operation ledger merekam hasil bounded dan retry berikutnya tetap aman.

## Authorization dan safety

Event creator adalah actor yang membuat event dan menjadi satu-satunya penulis lifecycle. Admin grup dapat menjadi fallback operasional hanya jika command menetapkannya secara eksplisit; perubahan event tidak boleh mengubah membership grup. Join dan leave selalu explicit opt-in/out oleh actor sendiri. Participant list dibatasi dan tidak ditampilkan sebagai raw JID.

Feature flag default-off, audit outcome menggunakan vocabulary guardrail yang valid, audit tidak memuat raw JID, nomor telepon, message content, credential, raw error, atau identifier mentah. Tidak ada eval, exec, shell, passive full-chat memory, delete-message, native contact-card, atau native location dependency pada R9.

## Text-first presentation

Command utama: `!event`, `!event create`, `publish`, `join`, `leave`, `status`, `phase`, `pause`, `resume`, `close`, `recap`, `poll`, `contact`, `location`, dan `!calendar`. Submenu tidak menggunakan button; fallback help selalu berupa teks. Contact-card dan location native yang tidak terverifikasi tidak dipanggil. R9 hanya menyediakan fallback teks atau status capability-unavailable.

## Non-goals

R9 tidak membangun auto-canon decision, passive chat memory, generic auto-download media, arbitrary code execution, RPG mechanics, delete-message flow, atau migrasi besar framework. Mission Platform tetap dikerjakan setelah R11.

## Acceptance boundary

Gate lokal harus membuktikan typecheck, clean build, source-dist parity, focused R9 regression, dan full regression. Gate CI harus berhasil sebelum artifact sanitized dikirim ke Panel. Black-box WhatsApp acceptance ditunda sampai seluruh roadmap R9–R11 selesai sesuai keputusan pengguna.
