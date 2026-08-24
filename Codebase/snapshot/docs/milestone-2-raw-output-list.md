# Raw Output List — Milestone 2

Dokumen ini berisi output mentah dengan dummy text. Nilai dummy dapat diganti langsung. Alias command tidak ditulis ulang jika menghasilkan output yang sama.

---

## 1. `!groupid`

```text
Group ID grup ini:
<jid-redacted@g.us>
```

---

## 2. `!groupinfo` / `!ginfo`

```text
Group Info

Nama       : Dummy Roleplay Group
Group ID   : <jid-redacted@g.us>
Member     : 24 orang
Admin      : 4 orang
Status Bot : Admin
Creator    : @<phone-redacted>
Deskripsi  : Dummy description for this group.
```

### `!groupinfo` tanpa deskripsi

```text
Group Info

Nama       : Dummy Roleplay Group
Group ID   : <jid-redacted@g.us>
Member     : 24 orang
Admin      : 4 orang
Status Bot : Member
Creator    : @<phone-redacted>
```

---

## 3. `!membercount`

```text
Dummy Roleplay Group
Member : 24
Admin  : 4
```

---

## 4. `!admins` / `!adminlist`

### Halaman tunggal

```text
Group Admin

Grup    : Dummy Roleplay Group
Halaman : 1/1

1. @<phone-redacted> — Creator
2. @<phone-redacted> — Admin
3. @<phone-redacted> — Admin
4. @<phone-redacted> — Admin
```

### Halaman pertama dari beberapa halaman

```text
Group Admin

Grup    : Dummy Roleplay Group
Halaman : 1/2

1. @<phone-redacted> — Creator
2. @<phone-redacted> — Admin
3. @<phone-redacted> — Admin
4. @<phone-redacted> — Admin
5. @<phone-redacted> — Admin

Ketik !admins 2 untuk halaman berikutnya.
```

### Halaman terakhir

```text
Group Admin

Grup    : Dummy Roleplay Group
Halaman : 2/2

26. @<phone-redacted> — Admin
27. @<phone-redacted> — Admin
28. @<phone-redacted> — Admin

Ketik !admins 1 untuk kembali ke halaman pertama.
```

---

## 5. `!members` / `!memberlist`

### Halaman tunggal

```text
Group Member

Grup    : Dummy Roleplay Group
Halaman : 1/1

1. @<phone-redacted> — Creator
2. @<phone-redacted> — Admin
3. @<phone-redacted> — Member
4. @<phone-redacted> — Member
5. @<phone-redacted> — Member
```

### Halaman pertama dari beberapa halaman

```text
Group Member

Grup    : Dummy Roleplay Group
Halaman : 1/2

1. @<phone-redacted> — Creator
2. @<phone-redacted> — Admin
3. @<phone-redacted> — Member
4. @<phone-redacted> — Member
5. @<phone-redacted> — Member

Ketik !members 2 untuk halaman berikutnya.
```

### Halaman terakhir

```text
Group Member

Grup    : Dummy Roleplay Group
Halaman : 2/2

26. @<phone-redacted> — Member
27. @<phone-redacted> — Member
28. @<phone-redacted> — Member

Ketik !members 1 untuk kembali ke halaman pertama.
```

---

## 6. `!memberinfo @user`

### Member biasa

```text
Member Info
Pengguna : @<phone-redacted>
Role     : Member
```

### Admin

```text
Member Info
Pengguna : @<phone-redacted>
Role     : Admin
```

### Creator

```text
Member Info
Pengguna : @<phone-redacted>
Role     : Creator
```

---

## 7. `!link`

### Invite link tersedia

```text
Invite Link Grup
https://chat.whatsapp.com/DUMMYINVITELINK
```

### Invite link tidak tersedia

```text
Invite link grup tidak tersedia saat ini.
```

---

## 8. `!rules`

### Aturan belum dikonfigurasi

```text
Rules Grup

Grup : Dummy Roleplay Group

Aturan grup belum dikonfigurasi.
Admin dapat menambahkan aturan pada milestone konfigurasi grup.
```

### Draft apabila aturan sudah tersedia nanti

```text
Rules Grup

Grup : Dummy Roleplay Group

1. Hormati semua member.
2. Jangan mengirim spam.
3. Ikuti aturan roleplay grup.
4. Hubungi admin jika membutuhkan bantuan.
```

---

## 9. `!role`

### Role pengirim command

```text
@<phone-redacted> memiliki role Member.
```

### Role target yang disebut

```text
@<phone-redacted> memiliki role Admin.
```

### Role creator

```text
@<phone-redacted> memiliki role Creator.
```

---

## 10. `!permissions`

### Member biasa

```text
Permissions
Role : Member

- Melihat metadata grup
- Melihat daftar member
```

### Admin

```text
Permissions
Role : Admin

- Melihat metadata grup
- Melihat daftar member
- Menggunakan command admin setelah policy tersedia
```

### Creator

```text
Permissions
Role : Creator

- Melihat metadata grup
- Melihat daftar member
- Menggunakan command admin
- Mengelola pengaturan grup
```

Catatan: daftar Creator di atas adalah rancangan output untuk desain policy berikutnya. Implementasi Milestone 2 saat ini baru menampilkan permission dasar untuk member dan admin.

---

## 11. Private-chat guard

Semua command group foundation yang dikirim melalui private chat menghasilkan output berikut:

```text
Command ini hanya dapat digunakan di dalam grup WhatsApp.
```

---

## 12. `!memberinfo` tanpa mention atau reply

```text
Reply atau mention satu member. Contoh: !memberinfo @user
```

---

## 13. Target member tidak ditemukan

```text
Member tersebut tidak ditemukan di metadata grup.
```

---

## 14. Role tidak ditemukan

```text
Role pengguna tidak ditemukan di metadata grup.
```

---

## 15. Permission ditolak

Draft output untuk command yang membutuhkan admin atau creator, misalnya `!link`:

```text
Kamu tidak memiliki izin untuk menggunakan command ini.
Permission yang dibutuhkan: group.admin
```

Output ini masih dapat diberi desain visual baru.

---

## 16. Ringkasan output yang perlu didesain

```text
!groupid       → Group ID
!groupinfo     → Nama, ID, jumlah member, admin, status bot, creator, deskripsi
!membercount   → Jumlah member dan admin
!admins        → Daftar admin, creator, role, pagination
!members       → Daftar member, role, mention, pagination
!memberinfo    → Target member dan role
!link          → Invite link atau fallback
!rules         → Aturan grup atau fallback
!role          → Role pengirim atau target
!permissions   → Role dan permission dasar
```
