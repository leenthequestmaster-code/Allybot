# Group Foundation Allybot

Group foundation adalah fondasi command grup yang bersifat read-only dan permission-aware. Implementasi ini menggunakan `WhatsAppPort` sebagai batas transport, sehingga plugin tidak mengakses raw Baileys socket secara langsung.

## Command yang tersedia

| Command | Fungsi | Batasan |
|---|---|---|
| `!groupid` | Menampilkan JID grup saat ini. | Hanya grup. |
| `!groupinfo` atau `!ginfo` | Menampilkan subject, JID, jumlah member, jumlah admin, creator, description, dan status bot bila terdeteksi. | Membutuhkan koneksi WhatsApp dan metadata grup. |
| `!membercount` | Menampilkan jumlah member dan admin. | Hanya grup. |
| `!admins` atau `!adminlist` | Menampilkan daftar admin dengan pagination dan mention clickable. | Maksimal 25 peserta per halaman. |
| `!members` atau `!memberlist` | Menampilkan daftar member dengan pagination dan mention clickable. | Maksimal 25 peserta per halaman. |
| `!memberinfo @user` | Menampilkan role member yang disebut. | Target harus disebut melalui mention. |
| `!role` atau `!role @user` | Menampilkan role pengirim atau member yang disebut. | Role berasal dari metadata WhatsApp. |
| `!permissions` | Menampilkan permission dasar berdasarkan role grup. | Belum mengubah setting grup. |
| `!rules` | Menampilkan status aturan grup read-only. | Penyimpanan aturan akan masuk milestone konfigurasi grup. |
| `!link` | Menampilkan invite link grup. | Hanya admin/creator; bot juga harus memiliki akses yang diperlukan WhatsApp. |

## Role dasar

Metadata peserta dinormalisasi menjadi empat role internal. `superadmin` berarti creator grup, `admin` berarti admin grup, `member` berarti peserta biasa, dan `unknown` digunakan ketika WhatsApp memberi nilai admin yang tidak dikenali oleh adapter. Di atas role grup, Allybot dapat mengenali `Bot Owner` melalui `BOT_OWNER_JID` yang dikonfigurasi secara eksplisit.

Permission middleware mendukung `bot.owner`, `group.admin`, dan `group.owner`. Permission `bot.owner` hanya diberikan kepada JID owner yang cocok setelah normalisasi. Permission `group.admin` diberikan kepada admin dan creator grup. Permission `group.owner` diberikan kepada creator yang terdeteksi. Permission yang tidak dikenal selalu ditolak. Member biasa tidak dapat melewati permission tersebut.

## Permission matrix Milestone 2

| Permission | Member | Admin grup | Creator grup | Bot owner |
|---|---:|---:|---:|---:|
| Command read-only group | Ya | Ya | Ya | Ya, bila berada di grup |
| `group.admin` | Tidak | Ya | Ya | Tidak otomatis; status admin WhatsApp tetap diperlukan |
| `group.owner` | Tidak | Tidak | Ya | Tidak otomatis |
| `bot.owner` | Tidak | Tidak | Tidak | Ya, termasuk dari private chat |

Command `!link` menggunakan `group.admin`. Command yang memiliki permission tetapi tidak diloloskan middleware tidak menjalankan handler dan mengirim denial response yang konsisten. Permission resolver tidak menganggap bot owner sebagai admin WhatsApp secara otomatis, karena hak aplikasi tidak sama dengan kemampuan bot melakukan operasi admin di server WhatsApp.

## Metadata dan normalisasi

Adapter WhatsApp mengubah metadata Baileys menjadi bentuk `WhatsAppGroupMetadata` yang hanya berisi data yang diperlukan framework: JID grup, subject, owner, description, dan peserta beserta role. JID peserta melewati normalisasi LID ke phone-number JID jika mapping tersedia, sehingga mention output dapat digunakan secara konsisten.

## Permission denial dan validasi

Jika command berpermission dipakai oleh aktor yang tidak memenuhi policy, framework mengirim pesan yang sesuai kebutuhan akses tanpa membocorkan nama permission internal:

| Kebutuhan akses | Pesan pengguna |
|---|---|
| Admin grup | `Maaf, command ini hanya dapat digunakan oleh admin grup.` |
| Pembuat grup | `Maaf, command ini hanya dapat digunakan oleh pembuat grup.` |
| Owner Allybot | `Maaf, command ini hanya tersedia untuk owner Allybot.` |
| Policy lain atau tidak dikenal | `Maaf, kamu belum memiliki izin untuk menggunakan command ini.` |

Nama permission tetap dicatat pada structured log internal. Private-chat guard ditangani oleh plugin group dan tidak digantikan oleh permission middleware.

## Batasan saat maintenance mode

Ketika `WHATSAPP_ENABLED=false`, command group foundation tetap terdaftar pada framework, tetapi command yang memerlukan metadata grup akan gagal secara aman karena socket tidak connected. Tidak ada socket, QR, pairing, atau request WhatsApp yang dibuat. Perilaku ini memungkinkan typecheck, unit test, dan plugin validation dikerjakan offline.

## Scope yang belum termasuk

Milestone ini belum mengubah aturan grup, welcome configuration, prefix, promote, demote, kick, atau setting admin. Fitur tersebut memerlukan permission policy yang lebih lengkap, kemampuan transport tambahan yang telah diverifikasi, serta failure handling untuk operasi mutatif.
