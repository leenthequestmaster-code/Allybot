# Media Transport Spike — 2026-08-23

## Pertanyaan keputusan

Apakah Allybot sudah memiliki boundary yang cukup untuk merilis command media seperti `!sticker`, `!toimg`, `!toaudio`, atau `!togif` tanpa kehilangan metadata, mengunduh payload tanpa batas, atau mengirim file melalui API yang belum dibuktikan?

## Kesimpulan awal

Belum. Implementasi media belum boleh dinyatakan siap hanya dengan menambahkan command karena boundary saat ini membuang descriptor media ketika `WAMessage` dinormalisasi menjadi `CoreMessage`. `WhatsAppPort` juga hanya memiliki `sendImage(remoteJid, imageUrl, caption?)`, bukan kontrak download/send binary atau quoted-media lookup. Langkah yang tepat adalah vertical slice terpisah: descriptor inbound → bounded media download → fixed transformation → bounded media send → cleanup dan negative tests. Command publik baru dirilis setelah seluruh slice tersebut memiliki contract test dan artifact CI.

## Fakta yang terobservasi

| Area | Bukti | Konsekuensi |
| --- | --- | --- |
| Runtime boundary | `CoreMessage` saat ini membawa text/caption/quoted text dan metadata dasar, tetapi tidak membawa media kind, MIME, byte length, atau raw/quoted media descriptor. | Handler tidak dapat mengetahui media yang direply secara aman. |
| Baileys adapter | `emitMessages()` menormalisasi `WAMessage` dan tidak meneruskan `imageMessage`, `videoMessage`, `audioMessage`, `documentMessage`, atau `stickerMessage` sebagai descriptor. | Media hilang sebelum command dispatch. |
| Outbound boundary | `WhatsAppPort` hanya menyediakan `sendText`, interaction/poll, group operations, profile picture, dan `sendImage` berbasis HTTPS URL. | Tidak ada API internal untuk mengirim buffer/stream/file dengan MIME terkontrol. |
| Pinned dependency | Repository memakai `@whiskeysockets/baileys@7.0.0-rc14`. Type lokal mengekspos `downloadMediaMessage(message, 'buffer'|'stream', options, ctx?)`; `AnyMediaMessageContent` mengekspos image/video/audio/sticker/document berbasis `WAMediaUpload`. | API tersedia, tetapi harus dibungkus dan tidak boleh disebarkan langsung ke plugin. |
| Runtime tools | `ffmpeg` dan `ffprobe` tersedia lokal; ImageMagick tidak tersedia. | Konversi media harus fixed-argument dan harus diverifikasi lagi pada environment Panel. |
| Existing tests | Suite menguji `sendImage` URL dan callback interaction, tetapi belum menguji media download, MIME/size rejection, quoted-media parsing, transform timeout, cleanup, atau binary send. | Fake adapter saat ini belum membuktikan live media behavior. |

## Bukti eksternal yang dikunci versi/ruang lingkup

Dokumentasi Baileys menyatakan media dapat dikirim sebagai `Buffer`, URL, atau stream dan menyarankan stream/URL untuk mengurangi pemuatan buffer penuh. Type `AnyMediaMessageContent` mencakup image, video, audio, sticker, dan document. Dokumentasi handling messages mengidentifikasi media sebagai protobuf `imageMessage`, `videoMessage`, `audioMessage`, `documentMessage`, dan `stickerMessage`. Package npm yang relevan adalah release candidate `7.0.0-rc14`, sehingga breaking changes tetap merupakan risiko dan implementasi harus mengikuti type/source pinned, bukan dokumentasi latest tanpa verifikasi.

Sumber:

1. [Baileys Sending Media Messages](https://whiskeysockets-baileys-85.mintlify.app/messages/sending-media) — bentuk outbound media, stream/URL/buffer, MIME, sticker, video-as-GIF, dan audio voice-note.
2. [Baileys Handling Messages](https://baileys.wiki/docs/socket/handling-messages/) — bentuk protobuf inbound dan jenis media.
3. [Baileys pinned source `messages.ts`](https://github.com/WhiskeySockets/Baileys/blob/master/src/Utils/messages.ts) — implementation reference untuk `downloadMediaMessage`/media preparation; mutable `master`, dipakai sebagai cross-check, bukan compatibility guarantee.
4. [@whiskeysockets/baileys npm package](https://www.npmjs.com/package/@whiskeysockets/baileys) — package metadata, release-candidate warning, dan breaking-change notice.

## Alternatif

| Alternatif | Kelebihan | Kekurangan | Keputusan |
| --- | --- | --- | --- |
| A. Menambah command di atas `sendImage` URL existing | Diff kecil dan tidak menyentuh adapter. | Tidak dapat memproses media inbound/reply; memerlukan URL publik; memperbesar risiko SSRF/privacy; tidak memenuhi `!sticker`/`!toimg`. | Ditolak. |
| B. Memperluas boundary internal dengan `MediaDescriptor` dan `MediaPort` minimal | Memisahkan Baileys dari plugin, dapat diuji dengan fake adapter, menjaga kontrak tetap eksplisit, dan memungkinkan bounded download/send. | Menyentuh `CoreMessage`, adapter, contract tests, serta membutuhkan verifikasi environment ffmpeg. | Dipilih untuk spike lanjutan. |
| C. Menambahkan service media terpisah/queue worker | Isolasi resource lebih baik untuk workload besar. | Terlalu berat sebelum ada kebutuhan throughput; deployment dan observability baru; tidak perlu untuk single-instance bounded commands. | Ditunda; trigger revisi adalah sustained media workload atau transform melebihi runtime budget. |

## Target boundary yang direkomendasikan

`CoreMessage.media?: MediaDescriptor` hanya memuat metadata aman dan locator internal non-secret: `kind`, `mimeType`, `sizeBytes` bila tersedia, `width`, `height`, `durationSeconds`, dan `isQuoted`. Descriptor tidak memuat raw JID tambahan, media key, direct path, URL CDN, atau isi message. `MediaPort` menangani `download(descriptor, limits)` dan `send(remoteJid, payload, options)`; plugin tidak boleh memanggil Baileys atau `spawn` langsung.

Boundary harus memaksa batas sebelum download: jenis media yang diizinkan, MIME allowlist, byte limit, duration/dimension limit bila tersedia, deadline, concurrency limit, dan temporary-directory ownership. Download sebaiknya stream-to-bounded-buffer atau file terkontrol dengan hard cap dan cleanup `finally`. Transform memakai `spawn` dengan executable fixed (`ffmpeg`/`ffprobe`), fixed argument builder, tanpa shell, tanpa user-controlled executable/flag/path, timeout, output-size cap, dan signal termination. Semua output temporary dihapus setelah send atau failure.

## Command slice yang layak setelah boundary siap

Slice pertama yang bernilai dan bounded adalah `!sticker` untuk image/video yang dikirim langsung atau direply, dengan static MIME allowlist dan ukuran kecil. Slice berikutnya `!toimg` untuk sticker statis dan `!togif` untuk video pendek; `!toaudio` hanya setelah MIME/duration/codec contract dan ffmpeg availability terverifikasi pada Panel. `!yt2mp3`, downloader arbitrary URL, upscale 2K–16K, dan `!hd` tidak masuk release ini karena membutuhkan outbound fetch/codec/resource policy yang belum memiliki kontrak dan meningkatkan abuse surface.

## Failure modes dan kontrol wajib

| Failure mode | Kontrol sebelum release |
| --- | --- |
| Media descriptor hilang atau nested/view-once/quoted tidak terbaca | Adapter fixtures untuk plain, quoted, view-once, ephemeral, dan unsupported media; fail closed bila descriptor ambigu. |
| Oversize download menghabiskan memory/disk | Reject metadata di awal; bounded stream/file; hard byte cap; temp quota; test cap boundary. |
| CDN/media URL expired atau re-upload gagal | Pakai callback reupload resmi Baileys melalui adapter; bounded timeout; user-facing safe failure; tidak retry tanpa batas. |
| MIME spoof atau transform salah | Allowlist berdasarkan descriptor dan magic-byte/ffprobe check; output MIME ditentukan server-side. |
| ffmpeg injection/DoS | Fixed executable, args array tanpa shell, no user path/flag, timeout, output cap, concurrency semaphore. |
| Temporary file tertinggal | `finally` cleanup, unique mode-700 temp dir, startup stale-temp cleanup terbatas, test failure cleanup. |
| Duplicate send/retry | Command cooldown/idempotency policy; no automatic broadcast or retry storm. |
| Raw media/privacy leak | Tidak audit/log buffer, media key, CDN URL, raw message, atau quoted content; log hanya kind/size/outcome/error name. |
| Baileys version skew | Compile against pinned `7.0.0-rc14`, adapter contract tests, dependency upgrade review trigger. |
| Panel tidak memiliki binary yang diasumsikan | CI/runtime preflight non-secret; command disabled dengan pesan aman bila capability tidak tersedia. |

## Exit criteria untuk mulai coding

Media slice baru boleh dikodekan setelah: (1) `MediaDescriptor` dan `MediaPort` disepakati sebagai boundary internal; (2) adapter fixture membuktikan pemetaan media dari pinned Baileys; (3) fake port membuktikan rejection sebelum download dan cleanup/timeout; (4) outbound send contract mencakup image/video/audio/sticker dengan MIME yang ditentukan server; (5) tidak ada API media publik yang mengekspos Baileys type ke plugin; (6) CI artifact tetap sanitized; dan (7) command pertama memiliki positive, negative, permission, size, timeout, and restart-safe tests.

## Status

Status keputusan: **spike selesai, implementasi media belum dimulai**. AI tools dan FUN tools dirilis terpisah tanpa media boundary. Review trigger: perubahan major Baileys, kebutuhan command media pertama, atau bukti workload yang membuat transform synchronous tidak lagi aman.
