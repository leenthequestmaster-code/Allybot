# Permission Policy Allybot

Dokumen ini menjelaskan fondasi permission policy yang aktif pada Milestone 2. Policy dibuat kecil dan eksplisit agar plugin tidak membuat pemeriksaan role sendiri-sendiri.

## Identity

`BOT_OWNER_JID` adalah konfigurasi opsional untuk identitas owner bot. Nilainya harus berupa nomor phone JID, misalnya:

```dotenv
BOT_OWNER_JID=628xxxxxxxxxx@s.whatsapp.net
```

Nilai ini divalidasi saat startup, diteruskan ke framework secara internal, dan tidak dimasukkan ke `publicConfig` maupun structured log. Jika konfigurasi tidak diisi, permission `bot.owner` selalu ditolak.

## Role

| Role | Sumber | Makna |
|---|---|---|
| `Bot Owner` | `BOT_OWNER_JID` | Pengelola utama Allybot; tidak otomatis menjadi admin WhatsApp. |
| `Creator` | Metadata participant WhatsApp | Pemilik/creator grup. |
| `Admin` | Metadata participant WhatsApp | Admin grup. |
| `Member` | Metadata participant WhatsApp | Peserta biasa. |
| `Unknown` | Adapter fallback | Role yang tidak dikenali; tidak mendapat permission sensitif. |

Bot owner dan creator grup adalah dua identitas berbeda. Bot owner memiliki hak aplikasi, sedangkan creator/admin grup memiliki hak WhatsApp pada grup tertentu. Bot owner tidak otomatis dapat melakukan operasi yang membutuhkan bot sebagai admin WhatsApp.

## Permission names

| Permission | Allow rule |
|---|---|
| `bot.owner` | Sender cocok dengan `BOT_OWNER_JID` setelah normalisasi JID. Dapat dipakai dari private chat. |
| `group.admin` | Sender tercatat sebagai `admin` atau `superadmin` pada metadata grup. |
| `group.owner` | Sender tercatat sebagai `superadmin` atau cocok dengan `ownerJid` metadata grup. |
| Permission lain | Default-deny. Resolver tidak memberikan akses pada nama yang tidak dikenal. |

## Command matrix Milestone 2

| Command | Permission | Private chat |
|---|---|---:|
| `!groupid` | Tidak ada; plugin group guard | Ditolak |
| `!groupinfo` / `!ginfo` | Tidak ada; plugin group guard | Ditolak |
| `!membercount` | Tidak ada; plugin group guard | Ditolak |
| `!admins` / `!adminlist` | Tidak ada; plugin group guard | Ditolak |
| `!members` / `!memberlist` | Tidak ada; plugin group guard | Ditolak |
| `!memberinfo` | Tidak ada; plugin group guard | Ditolak |
| `!role` | Tidak ada; plugin group guard | Ditolak |
| `!permissions` | Tidak ada; plugin group guard | Ditolak |
| `!rules` | Tidak ada; plugin group guard | Ditolak |
| `!link` | `group.admin` | Ditolak |

Command read-only tetap memerlukan konteks grup karena data berasal dari metadata WhatsApp. Permission middleware dan group guard memiliki tanggung jawab berbeda: middleware memeriksa hak akses bernama, sedangkan group guard memastikan command memang dikirim dari grup.

## Denial behavior

Jika command memiliki permission dan resolver menolak akses, handler tidak dijalankan. Middleware mengirim response aman berikut:

```text
Permission ditolak.
Command ini membutuhkan permission `group.admin`.
```

Nama permission pada response mengikuti requirement command. Error metadata atau kegagalan transport tetap masuk ke error isolation framework dan tidak boleh menjatuhkan proses utama.

## Normalisasi

JID peserta dan sender dinormalisasi dengan membuang device suffix sebelum dibandingkan. Adapter WhatsApp juga menerjemahkan LID ke phone-number JID apabila mapping tersedia. Konfigurasi owner menerima nomor langsung atau nomor dengan suffix `@s.whatsapp.net`.

## Scope yang sengaja belum dibuat

Milestone ini belum menyediakan custom role per grup, delegation owner, permission override per command, temporary role, audit history perubahan policy, atau command untuk mengubah owner/policy melalui chat. Fitur tersebut baru boleh ditambahkan setelah use case, storage, audit, dan rollback-nya jelas.

## Verification

Validasi offline terakhir mencakup typecheck, build, denial response, group admin, group owner, bot owner dari private chat, unknown permission default-deny, role display, publicConfig redaction, private-chat guard, metadata group, dan plugin regression suite. Hasil terakhir adalah **22/22 test lulus**. Fitur belum dideploy ke Pterodactyl.
