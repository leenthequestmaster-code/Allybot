# Draft Output Command Milestone 2

Dokumen ini berisi draft output yang saat ini dihasilkan oleh group foundation Allybot. Nilai seperti nama grup, JID, jumlah member, nama pengguna, role, dan invite link bersifat dinamis. Mention pada output `!admins`, `!members`, dan `!memberinfo` dikirim menggunakan metadata mention WhatsApp sehingga dapat tampil clickable ketika bot online.

Format di bawah adalah draft teknis, bukan desain visual final. Ornamen, emoji, istilah, footer, susunan field, dan gaya bahasa masih dapat diubah tanpa mengubah fungsi command.

## `!groupid`

### Command

```text
!groupid
```

### Output saat digunakan di grup

```text
Group ID grup ini:
120363000000000000@g.us
```

### Output saat digunakan di private chat

```text
Command ini hanya dapat digunakan di dalam grup WhatsApp.
```

## `!groupinfo` atau `!ginfo`

### Command

```text
!groupinfo
!ginfo
```

### Draft output

```text
𖥦 ׂׅ─── ꫶֗ ୨ 👥 ୧ ꫶֗ ───ׂ
⿴⃟۪۪⃕᎒⃟ *𝐆𝗿𝗼𝘂𝗽 𝐈𝗻𝗳𝗼* ꕤꪆ
᠂᠂᠂ ───┈ ⸼ ⚝ ⸼ ┈─── ᠂᠂᠂

↳ *Nama* : Allyssea Test Room
↳ *Group ID* : 120363000000000000@g.us
↳ *Member* : 24 orang
↳ *Admin* : 4 orang
↳ *Status Bot* : Admin
↳ *Creator* : @628120000001
↳ *Deskripsi* : Room untuk pengujian group foundation.

━━━━━━━━━━━━━━━━━━━━
*© Allyssea Roleplay Community*
```

## `!membercount`

### Command

```text
!membercount
```

### Draft output

```text
👥 *Allyssea Test Room*
↳ Member : 24
↳ Admin : 4
```

## `!admins` atau `!adminlist`

### Command

```text
!admins
!adminlist
```

### Draft output

```text
𖥦 ׂׅ─── ꫶֗ ୨ 👥 ୧ ꫶֗ ───ׂ
⿴⃟۪۪⃕᎒⃟ *𝐆𝗿𝗼𝘂𝗽 𝐀𝗱𝗺𝗶𝗻* ꕤꪆ
᠂᠂᠂ ───┈ ⸼ ⚝ ⸼ ┈─── ᠂᠂᠂

*Grup* : Allyssea Test Room
*Halaman* : 1/1

1. @628120000001 — Creator
2. @628120000002 — Admin

━━━━━━━━━━━━━━━━━━━━
*© Allyssea Roleplay Community*
```

Mention `@628120000001` dan `@628120000002` dikirim melalui metadata mention WhatsApp.

### Draft output ketika admin lebih dari 25 orang

```text
𖥦 ׂׅ─── ꫶֗ ୨ 👥 ୧ ꫶֗ ───ׂ
⿴⃟۪۪⃕᎒⃟ *𝐆𝗿𝗼𝘂𝗽 𝐀𝗱𝗺𝗶𝗻* ꕤꪆ
᠂᠂᠂ ───┈ ⸼ ⚝ ⸼ ┈─── ᠂᠂᠂

*Grup* : Allyssea Test Room
*Halaman* : 1/2

1. @628120000001 — Creator
2. @628120000002 — Admin
...
25. @628120000025 — Admin

Ketik !admins 2 untuk halaman berikutnya.

━━━━━━━━━━━━━━━━━━━━
*© Allyssea Roleplay Community*
```

## `!members` atau `!memberlist`

### Command

```text
!members
!members 2
!memberlist
```

### Draft output

```text
𖥦 ׂׅ─── ꫶֗ ୨ 👥 ୧ ꫶֗ ───ׂ
⿴⃟۪۪⃕᎒⃟ *𝐆𝗿𝗼𝘂𝗽 𝐌𝗲𝗺𝗯𝗲𝗿* ꕤꪆ
᠂᠂᠂ ───┈ ⸼ ⚝ ⸼ ┈─── ᠂᠂᠂

*Grup* : Allyssea Test Room
*Halaman* : 1/1

1. @628120000001 — Creator
2. @628120000002 — Admin
3. @628120000003 — Member

━━━━━━━━━━━━━━━━━━━━
*© Allyssea Roleplay Community*
```

## `!memberinfo @user`

### Command

```text
!memberinfo @628120000002
```

### Draft output

```text
👤 *Member Info*
↳ Pengguna : @628120000002
↳ Role : Admin
```

Mention target dikirim melalui metadata mention WhatsApp.

### Output jika tidak ada target mention

```text
Reply atau mention satu member. Contoh: !memberinfo @user
```

### Output jika target tidak ditemukan

```text
Member tersebut tidak ditemukan di metadata grup.
```

## `!role`

### Command

```text
!role
!role @628120000002
```

### Draft output

```text
↳ @628120000003 memiliki role *Member*.
```

Atau jika menanyakan admin:

```text
↳ @628120000002 memiliki role *Admin*.
```

### Output jika role tidak ditemukan

```text
Role pengguna tidak ditemukan di metadata grup.
```

## `!permissions`

### Command

```text
!permissions
```

### Draft output untuk member biasa

```text
🔐 *Permissions*
↳ Role : Member
✓ Melihat metadata grup
✓ Melihat daftar member
```

### Draft output untuk admin

```text
🔐 *Permissions*
↳ Role : Admin
✓ Melihat metadata grup
✓ Melihat daftar member
✓ Menggunakan command admin setelah policy tersedia
```

Catatan: output ini saat ini bersifat informatif. Ia belum menjadi daftar permission lengkap yang dapat dikustomisasi per grup.

## `!rules`

### Command

```text
!rules
```

### Draft output saat aturan belum dikonfigurasi

```text
📖 ⑅【 𝐑𝘂𝗹𝗲𝘀 𝐆𝗿𝘂𝗽 】
⏜ׄ꤮᷼⌒︵
↳ *Grup* : Allyssea Test Room

Aturan grup belum dikonfigurasi.
Admin dapat menambahkan aturan pada milestone konfigurasi grup.

━━━━━━━━━━━━━━━━━━━━
*© Allyssea Roleplay Community*
```

## `!link`

### Command

```text
!link
```

### Draft output untuk admin atau creator

```text
🔗 *Invite Link Grup*
https://chat.whatsapp.com/xxxxxxxxxxxxxxxxxxxx
```

### Output ketika link tidak tersedia

```text
Invite link grup tidak tersedia saat ini.
```

### Perilaku untuk member biasa

Pada implementasi saat ini, member biasa ditolak oleh permission middleware sebelum handler invite link dijalankan. Pesan penolakan permission masih mengikuti behavior middleware dan belum memiliki format dekoratif khusus.

## Guard private chat

Semua command group foundation menolak penggunaan pada private chat dengan output:

```text
Command ini hanya dapat digunakan di dalam grup WhatsApp.
```

## Draft yang masih perlu dirapikan

Bagian yang paling terbuka untuk penyesuaian visual adalah header group, footer, format `!membercount`, format role, format permission, output permission denied, dan output invite link. Saat merapikan desain, sebaiknya tetap dipertahankan tiga behavior teknis: ID grup tidak terpotong, mention dikirim melalui metadata WhatsApp, dan command admin tetap memiliki permission guard meskipun teks output diubah.
