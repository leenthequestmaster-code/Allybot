# Katalog Pesan Error Ramah Pengguna Allybot

Dokumen ini adalah kamus pesan untuk pengguna Allybot. Tujuannya adalah membuat penolakan, kegagalan input, gangguan WhatsApp, dan batas role mudah dipahami tanpa menampilkan nama permission internal, JID teknis, stack trace, token, auth state, atau detail konfigurasi server.

Pesan yang bersifat role-specific hanya digunakan ketika masalahnya benar-benar terkait akses. Pesan input, data, koneksi, dan gangguan internal sebaiknya tetap netral agar tidak memberi kesan pengguna dipersalahkan.

## Aturan bahasa

Setiap pesan harus menyebutkan apa yang terjadi dan, bila aman, langkah berikutnya. Gunakan istilah pengguna seperti *admin grup*, *pembuat grup*, atau *owner Allybot*; jangan gunakan `group.admin`, `group.owner`, `bot.owner`, nama tabel, nama plugin, atau detail Baileys. Jangan menyatakan bahwa target tertentu memiliki role khusus apabila informasi itu tidak perlu dilihat pengguna.

| Prinsip | Benar | Hindari |
|---|---|---|
| Jelas | `Command ini hanya dapat digunakan oleh admin grup.` | `Permission group.admin diperlukan.` |
| Membantu | `Mention satu member, lalu coba lagi.` | `Target invalid.` |
| Tidak bocor | `Allybot belum dapat mengambil link grup saat ini.` | `groupInviteCode returned undefined.` |
| Tidak menyalahkan | `Format command belum lengkap.` | `Kamu salah ketik.` |
| Konsisten | `Maaf, ...` untuk penolakan akses | Nada berubah-ubah antarplugin |

## 1. Akses berdasarkan role

### Member mencoba command admin

```text
Maaf, command ini hanya dapat digunakan oleh admin grup.
```

Versi yang memberi arahan:

```text
Maaf, kamu belum dapat menggunakan command ini.
Silakan hubungi admin grup jika fitur ini diperlukan.
```

### Member mencoba command khusus creator grup

```text
Maaf, command ini hanya dapat digunakan oleh pembuat grup.
```

### Admin mencoba command khusus creator grup

```text
Maaf, command ini hanya dapat digunakan oleh pembuat grup.
```

Pesan untuk admin dan member sengaja sama. Allybot tidak perlu menjelaskan perbedaan policy internal kepada pengguna yang ditolak.

### Member atau admin mencoba command owner Allybot

```text
Maaf, command ini hanya tersedia untuk owner Allybot.
```

### Owner Allybot mencoba command yang tetap memerlukan admin grup

```text
Command ini memerlukan status admin di grup ini.
Pastikan Allybot dan pengirim command memiliki akses yang diperlukan.
```

Pesan ini penting karena owner bot tidak otomatis memiliki hak WhatsApp pada semua grup.

### Command hanya boleh dipakai dari grup tertentu

```text
Maaf, command ini belum tersedia untuk grup ini.
```

### Command sementara dibatasi oleh policy grup

```text
Command ini sedang dibatasi oleh pengaturan grup.
Hubungi admin grup untuk informasi lebih lanjut.
```

## 2. Konteks chat

### Command khusus grup dipakai di private chat

```text
Command ini hanya dapat digunakan di dalam grup WhatsApp.
```

### Command khusus private chat dipakai di grup

```text
Command ini hanya dapat digunakan melalui chat pribadi dengan Allybot.
```

### Command membutuhkan reply terhadap pesan

```text
Balas pesan yang ingin digunakan, lalu kirim command ini lagi.
```

### Command membutuhkan mention

```text
Mention satu member, lalu coba lagi.
Contoh: !memberinfo @user
```

### Reply atau mention tidak dapat dibaca

```text
Allybot tidak dapat membaca target dari pesan tersebut.
Coba mention member secara langsung.
```

## 3. Command dan format input

### Command tidak ditemukan

```text
Command itu belum tersedia.
Ketik !menu untuk melihat daftar command.
```

### Command belum aktif

```text
Fitur ini belum aktif di Allybot.
Ketik !menu untuk melihat fitur yang tersedia saat ini.
```

### Command tidak lengkap

```text
Format command belum lengkap.
Gunakan: !command <isi yang diperlukan>
```

### Terlalu banyak argumen

```text
Format command tidak sesuai.
Gunakan: !command <isi yang diperlukan>
```

### Format angka tidak valid

```text
Masukkan angka yang valid, lalu coba lagi.
```

### Nomor halaman tidak valid

```text
Nomor halaman tidak valid.
Gunakan angka halaman yang tersedia.
```

### Input terlalu pendek

```text
Isi pesan masih terlalu pendek untuk diproses.
Tambahkan keterangan yang diperlukan, lalu coba lagi.
```

### Input terlalu panjang

```text
Pesan terlalu panjang untuk diproses.
Ringkas isi pesan, lalu coba lagi.
```

### Karakter atau format tidak didukung

```text
Format yang dikirim belum didukung untuk command ini.
Coba gunakan teks biasa atau format yang disebutkan pada bantuan command.
```

### Pilihan tidak tersedia

```text
Pilihan tersebut tidak tersedia.
Ketik !help <command> untuk melihat pilihan yang benar.
```

## 4. Data grup dan target pengguna

### Target bukan member grup

```text
Member tersebut tidak ditemukan di grup ini.
```

### Role target belum dapat dibaca

```text
Role member tersebut belum dapat dibaca saat ini.
Coba lagi beberapa saat kemudian.
```

### Metadata grup tidak tersedia

```text
Allybot belum dapat membaca informasi grup saat ini.
Coba lagi beberapa saat kemudian.
```

### Deskripsi atau aturan grup belum disetel

```text
Belum ada aturan grup yang disetel.
Admin grup dapat menambahkannya setelah fitur pengaturan grup tersedia.
```

### Data yang dicari tidak ditemukan

```text
Data yang kamu cari belum ditemukan.
```

### Data sudah ada

```text
Data tersebut sudah tercatat sebelumnya.
```

### Pengguna sudah berada pada status yang sama

```text
Tidak ada perubahan yang perlu dilakukan.
Status pengguna sudah sesuai.
```

### Batas data tercapai

```text
Batas untuk fitur ini sudah tercapai.
Hapus atau selesaikan data lama sebelum menambahkan yang baru.
```

## 5. Permission dan kemampuan WhatsApp

### Allybot bukan admin saat operasi memerlukannya

```text
Allybot memerlukan status admin untuk menjalankan command ini di grup tersebut.
```

### Invite link tidak tersedia

```text
Allybot belum dapat mengambil link undangan grup saat ini.
Pastikan Allybot memiliki akses admin, lalu coba lagi.
```

### Tindakan terhadap target tidak dapat dilakukan

```text
Tindakan ini belum dapat dilakukan pada member tersebut.
Pastikan target masih berada di grup dan Allybot memiliki akses yang diperlukan.
```

### Target adalah creator grup

```text
Tindakan ini tidak dapat diterapkan pada pembuat grup.
```

### Target adalah Allybot sendiri

```text
Command ini tidak dapat diterapkan pada Allybot.
```

### Target sama dengan pengirim command

```text
Command ini tidak dapat digunakan untuk diri sendiri.
```

## 6. Cooldown, rate limit, dan batas penggunaan

### Cooldown pengguna

```text
Tunggu sebentar sebelum menggunakan command ini lagi.
```

### Cooldown dengan sisa waktu

```text
Command ini masih dalam jeda.
Coba lagi dalam {remaining}.
```

### Batas penggunaan harian

```text
Batas penggunaan untuk fitur ini sudah tercapai hari ini.
Coba lagi setelah batasnya diperbarui.
```

### Rate limit grup

```text
Terlalu banyak permintaan dari grup ini dalam waktu singkat.
Tunggu sebentar, lalu coba lagi.
```

### Proses sudah berjalan

```text
Permintaan serupa masih diproses.
Tunggu hingga proses sebelumnya selesai.
```

## 7. Media dan lampiran

### Media wajib dikirim

```text
Kirim media yang ingin diproses, lalu balas dengan command ini.
```

### Jenis media tidak cocok

```text
Jenis media tersebut belum didukung untuk command ini.
```

### Ukuran media terlalu besar

```text
Ukuran media terlalu besar untuk diproses.
Gunakan file yang lebih kecil, lalu coba lagi.
```

### Durasi audio/video terlalu panjang

```text
Durasi media melebihi batas untuk command ini.
Gunakan media yang lebih singkat.
```

### Media tidak dapat diunduh

```text
Allybot belum dapat mengambil media tersebut.
Kirim ulang media, lalu coba lagi.
```

### Media tidak dapat diproses

```text
Media tersebut tidak dapat diproses saat ini.
Coba gunakan file atau format lain.
```

## 8. Koneksi, maintenance, dan layanan eksternal

### Allybot sedang maintenance

```text
Allybot sedang dalam mode maintenance.
Silakan coba lagi setelah layanan kembali aktif.
```

### WhatsApp belum terhubung

```text
Allybot belum terhubung ke WhatsApp saat ini.
Silakan coba lagi nanti.
```

### Layanan eksternal tidak tersedia

```text
Layanan yang dibutuhkan sedang tidak tersedia.
Silakan coba lagi beberapa saat lagi.
```

### Timeout layanan

```text
Permintaan membutuhkan waktu terlalu lama untuk diproses.
Silakan coba lagi.
```

### Pengiriman balasan gagal

```text
Allybot belum dapat mengirim balasan saat ini.
Silakan coba lagi beberapa saat lagi.
```

### Koneksi terputus saat proses berlangsung

```text
Koneksi terputus sebelum proses selesai.
Silakan kirim ulang command ini nanti.
```

## 9. State fitur dan operasi yang belum tersedia

### Fitur belum dibuat

```text
Fitur ini masih belum tersedia di Allybot.
```

### Fitur sedang dinonaktifkan oleh admin

```text
Fitur ini sedang dinonaktifkan di grup ini.
```

### Fitur membutuhkan konfigurasi awal

```text
Fitur ini belum dikonfigurasi untuk grup ini.
Hubungi admin grup untuk menyiapkannya.
```

### Tidak ada perubahan untuk dibatalkan

```text
Tidak ada perubahan aktif yang dapat dibatalkan.
```

### Aksi sudah kedaluwarsa

```text
Aksi ini sudah tidak berlaku.
Buat permintaan baru, lalu coba lagi.
```

### Aksi membutuhkan konfirmasi

```text
Aksi ini memerlukan konfirmasi terlebih dahulu.
Ikuti instruksi yang diberikan Allybot.
```

## 10. Kondisi sensitif dan kesalahan internal

### Request tidak dapat diproses dengan aman

```text
Permintaan ini tidak dapat diproses oleh Allybot.
```

### Kesalahan tidak terduga

```text
Terjadi kendala saat memproses command ini.
Silakan coba lagi beberapa saat lagi.
```

### Kesalahan berulang

```text
Allybot masih mengalami kendala pada fitur ini.
Silakan hubungi owner Allybot jika masalah berlanjut.
```

### Data tidak konsisten

```text
Data untuk fitur ini belum dapat digunakan dengan aman.
Coba lagi nanti atau hubungi admin grup.
```

### Akses sementara dikunci

```text
Fitur ini sementara tidak dapat digunakan untuk menjaga keamanan proses.
Silakan coba lagi nanti.
```

## 11. Pesan khusus owner Allybot

Pesan owner tetap harus menjelaskan keadaan tanpa memberi detail server sensitif. Pesan di bawah cocok untuk command lifecycle, diagnostics, atau konfigurasi pada masa depan.

| Skenario | Pesan pengguna |
|---|---|
| Bot belum memiliki owner terkonfigurasi | `Owner Allybot belum dikonfigurasi. Hubungi pengelola server.` |
| Command lifecycle belum aktif | `Control lifecycle belum tersedia saat ini.` |
| Maintenance tidak dapat diubah | `Mode maintenance belum dapat diubah saat ini. Coba lagi nanti.` |
| Self-check tidak lulus | `Pemeriksaan internal belum lulus. Periksa log server melalui panel.` |
| Penyimpanan tidak siap | `Penyimpanan Allybot belum siap digunakan. Coba lagi setelah layanan pulih.` |
| Perubahan konfigurasi memerlukan panel | `Pengaturan ini hanya dapat diubah melalui panel pengelola.` |

## 12. Template implementasi

Untuk permission middleware, mapper internal sebaiknya mengubah requirement menjadi pesan pengguna sebagai berikut:

| Requirement internal | Pesan pengguna |
|---|---|
| `group.admin` | `Maaf, command ini hanya dapat digunakan oleh admin grup.` |
| `group.owner` | `Maaf, command ini hanya dapat digunakan oleh pembuat grup.` |
| `bot.owner` | `Maaf, command ini hanya tersedia untuk owner Allybot.` |
| Lainnya atau unknown | `Maaf, kamu belum memiliki izin untuk menggunakan command ini.` |

Detail requirement asli tetap dicatat melalui structured log yang telah di-redact. Pesan WhatsApp tidak perlu menampilkan nama policy internal.

## Status dokumen

Pesan permission pada bagian template sudah diterapkan ke middleware aktif. Output visual dapat disesuaikan oleh pemilik Allybot, tetapi makna tiap skenario dan batas redaction sebaiknya dipertahankan. Katalog di luar permission middleware masih berfungsi sebagai referensi untuk plugin dan milestone berikutnya.
