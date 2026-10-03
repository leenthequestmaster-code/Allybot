# prd.md — Product Requirements Document: Islamic Utilities

## Product Overview

Paket fitur keagamaan di Allybot (WA bot berbasis Baileys). Menyediakan
akses cepat ke Quran, jadwal sholat, dan doa, plus reminder otomatis
waktu sholat untuk grup yang opt-in.

## Problem

User bot yang dominan Muslim perlu keluar dari WhatsApp untuk hal-hal
dasar seperti cek jadwal sholat atau cari ayat. Untuk reminder, user
harus install app terpisah atau set alarm manual — tidak praktis dan
tidak shareable ke grup.

## Goals

1. User bisa akses ayat Quran, jadwal sholat, dan doa dari dalam WA
2. Grup bisa opt-in reminder waktu sholat dengan audio adzan + quote
3. Zero biaya operasional (semua API gratis, data statis self-host)
4. Tidak mengganggu fitur existing

## Non-Goals

- Bukan pengganti aplikasi Quran lengkap (tafsir, audio recitation, dll)
- Bukan pengganti aplikasi sholat (kiblat, tracker, dll)
- Tidak ada fitur sosial (share ayat, komunitas, dll)
- Tidak ada monetisasi

## Target Users

**Primary**: Anggota grup WhatsApp yang dominan Muslim Indonesia,
menggunakan bot untuk utility sehari-hari.

**Secondary**: Admin grup yang mengaktifkan reminder sholat untuk
komunitas mereka.

**Non-users**: Non-Muslim — bot tidak memaksa, mereka bisa ignore.

## User Stories

### US-1: Ayat Quran
Sebagai user, aku mau baca ayat Quran spesifik dari WA, supaya aku gak
perlu buka aplikasi lain saat ada pertanyaan atau butuh referensi.

### US-2: Jadwal Sholat
Sebagai user, aku mau tahu jadwal sholat hari ini di kotaku, supaya aku
bisa atur jadwal harian.

### US-3: Doa
Sebagai user, aku mau cari doa sesuai situasi (sebelum tidur, perjalanan,
dll), supaya aku bisa amalkan dengan benar.

### US-4: Subscribe Reminder
Sebagai admin grup, aku mau aktifkan reminder waktu sholat untuk grup,
supaya anggota grup dapat notifikasi + adzan otomatis.

### US-5: Ganti Kota
Sebagai admin grup, aku mau ganti kota reminder kalau grup pindah atau
salah setup.

### US-6: Status
Sebagai admin grup, aku mau cek status subscription grup, supaya tahu
apakah reminder aktif atau tidak.

## User Flows

### Flow 1: Baca Ayat
```
User: !quran 2:255
Bot:  📖 Al-Baqarah:255
```

### Flow 2: Jadwal Sholat
```
User: !sholat jakarta
Bot:  🕌 Jadwal Sholat — Jakarta
📅 Kamis, 3 Oktober 2026
```

### Flow 3: Doa
```
User: !doa sebelum-tidur
Bot:  🤲 Doa Sebelum Tidur
```

### Flow 4: Subscribe
```
Admin: !sholat subscribe jakarta
Bot:   ✅ Reminder sholat aktif untuk grup ini.
Kota: Jakarta
Akan kirim adzan + quote tiap waktu sholat.
Admin bisa nonaktifkan dengan: !sholat unsubscribe
```

### Flow 5: Reminder (background)
```
[Bot kirim otomatis jam 11:50 WIB ke grup yang subscribed jakarta]
Bot: [audio adzan dzuhur]
🕌 Waktu Dzuhur — Jakarta, 11:50
```

## Functional Requirements

### FR-1: Command !quran
- **FR-1.1** Menerima format `!quran <surah>:<ayat>`
- **FR-1.2** Menampilkan ayat Arab, terjemah Indonesia, dan referensi
- **FR-1.3** Kalau format salah (tanpa ayat), tolak dengan pesan usage
- **FR-1.4** Kalau surah/ayat tidak valid, tampilkan pesan error jelas
- **FR-1.5** Sumber: `equran.id`
- **FR-1.6** Cache response 24 jam untuk surah yang sama

### FR-2: Command !sholat
- **FR-2.1** Menerima format `!sholat <kota>`
- **FR-2.2** Menampilkan 5 waktu sholat + imsak untuk hari ini
- **FR-2.3** Sumber utama: `api.myquran.com`
- **FR-2.4** Fallback: `api.aladhan.com` kalau primary gagal
- **FR-2.5** Kalau kota tidak ditemukan, tampilkan 3 saran terdekat (fuzzy)
- **FR-2.6** Cache per (kota, tanggal) TTL 24 jam

### FR-3: Command !doa
- **FR-3.1** Menerima format `!doa <kategori>`
- **FR-3.2** Menampilkan doa Arab + Latin + arti + sumber
- **FR-3.3** Kalau kategori tidak ada, tampilkan daftar kategori tersedia
- **FR-3.4** Pool 30 doa hardcoded

### FR-4: Command !sholat subscribe
- **FR-4.1** Hanya admin grup atau owner yang bisa jalankan
- **FR-4.2** Wajib include kota
- **FR-4.3** Simpan subscription ke disk
- **FR-4.4** Kalau sudah subscribed, update kota (idempotent)

### FR-5: Command !sholat unsubscribe
- **FR-5.1** Hanya admin grup atau owner
- **FR-5.2** Hapus subscription grup dari state
- **FR-5.3** Idempotent — kalau tidak subscribed, tidak error

### FR-6: Command !sholat set-kota
- **FR-6.1** Hanya admin grup atau owner
- **FR-6.2** Grup harus sudah subscribed
- **FR-6.3** Update kota di state

### FR-7: Command !sholat status
- **FR-7.1** Siapa saja bisa jalankan (read-only)
- **FR-7.2** Tampilkan kota + status enabled
- **FR-7.3** Kalau tidak subscribed, tampilkan pesan jelas

### FR-8: Reminder Scheduler
- **FR-8.1** Cek tiap 60 detik
- **FR-8.2** Kirim ke grup subscribed tepat waktu sholat
- **FR-8.3** Format: audio adzan + caption text
- **FR-8.4** Caption berisi waktu + kota + quote (hadith/ayat) + citation
- **FR-8.5** Catch-up: skip kalau lewat >5 menit dari waktu sholat
- **FR-8.6** Throttle: minimal 3 detik antar pesan, maksimal 10 pesan/menit
- **FR-8.7** Quote rotate, tidak repeat dalam 7 hari untuk grup yang sama

## Non-Functional Requirements

### NFR-1: Performance
- **NFR-1.1** Response command `!quran` <2 detik (dengan cache)
- **NFR-1.2** Response command `!sholat` <2 detik (dengan cache)
- **NFR-1.3** Response command `!doa` <500ms (data lokal)
- **NFR-1.4** Reminder terkirim dalam window ±2 menit dari waktu sholat

### NFR-2: Reliability
- **NFR-2.1** API call retry 3x dengan backoff 1s/3s/9s
- **NFR-2.2** Semua API call timeout 10 detik
- **NFR-2.3** Kalau semua retry gagal, fallback ke cache
- **NFR-2.4** Bot restart → subscription state tetap ada

### NFR-3: Security
- **NFR-3.1** Admin check via `sock.groupMetadata` (bukan trust user input)
- **NFR-3.2** Kalau metadata fetch gagal, tolak dengan pesan jelas
- **NFR-3.3** Tidak expose error internal ke user

### NFR-4: Operability
- **NFR-4.1** Log setiap API call (durasi, status, fallback used)
- **NFR-4.2** Log setiap reminder terkirim (grup, kota, waktu)
- **NFR-4.3** Log error dengan konteks cukup untuk debug

### NFR-5: Compatibility
- **NFR-5.1** Tidak mengubah handler existing (!play, !amprem, !img)
- **NFR-5.2** Reuse infra existing tanpa modifikasi file infra

## Business Rules

- **BR-1**: Subscription per grup, tidak per user
- **BR-2**: Hanya admin grup yang bisa aktifkan/nonaktifkan
- **BR-3**: Owner bisa override dari DM
- **BR-4**: Reminder tidak diganggu cooldown user (background job)
- **BR-5**: Command user-facing tetap kena cooldown per grup (konsisten dengan fitur lain)

## Edge Cases

| Case | Handling |
|---|---|
| `!quran 2` (tanpa ayat) | Tolak: "Sertakan nomor ayat. Contoh: !quran 2:255" |
| `!quran 999:1` (surah invalid) | "Surah 999 tidak ada. Quran punya 114 surah." |
| `!quran 2:999` (ayat invalid) | "Al-Baqarah punya 286 ayat, bukan 999." |
| `!sholat` (tanpa kota) | "Ketik kota. Contoh: !sholat jakarta" |
| `!sholat kotabesar` | Fuzzy match, atau "Kota tidak ditemukan. Coba: Jakarta, Bandung, Surabaya." |
| `!doa` (tanpa kategori) | Tampilkan daftar 30 kategori |
| `!sholat subscribe` (non-admin) | "Hanya admin grup yang bisa subscribe reminder." |
| `!sholat subscribe` (di DM) | "Subscribe hanya untuk grup, bukan DM." |
| `!sholat set-kota` (belum subscribe) | "Grup belum subscribed. Jalankan !sholat subscribe <kota> dulu." |
| API sholat down 3x | Fallback aladhan. Kalau aladhan juga down, "Service sedang sibuk, coba lagi nanti." |
| Reminder ketika bot baru restart | Catch-up rule: skip kalau lewat >5 menit |
| Grup subscribed tapi kota tidak valid | Skip reminder, log error, kirim notif ke owner |

## Error States

| Kondisi | Pesan User |
|---|---|
| Input kosong | "Ketik query. Lihat contoh di !sholat help" |
| Network error | "Service sedang sibuk, coba lagi nanti." |
| API return invalid | "Data tidak tersedia untuk query ini. Coba lagi nanti." |
| Admin check gagal | "Gagal verifikasi admin grup. Coba lagi atau hubungi owner." |

## Acceptance Criteria

- **AC-1**: `!quran 2:255` mengembalikan ayat Arab + terjemah dalam <2 detik
- **AC-2**: `!sholat jakarta` mengembalikan jadwal 5 waktu + imsak dalam <2 detik
- **AC-3**: `!doa sebelum-tidur` mengembalikan doa lengkap + sumber dalam <500ms
- **AC-4**: `!sholat subscribe jakarta` oleh admin → tersimpan di state
- **AC-5**: `!sholat subscribe jakarta` oleh non-admin → ditolak
- **AC-6**: Reminder terkirim ke grup subscribed pada waktu sholat ±2 menit
- **AC-7**: Reminder berisi audio adzan + caption dengan quote + citation
- **AC-8**: Bot restart → subscription tetap ada, reminder tetap jalan
- **AC-9**: API sholat down → fallback ke aladhan, user tidak lihat error
- **AC-10**: 10 grup subscribed dengan kota sama → reminder terkirim semua, throttle 3 detik antar pesan

## Success Metrics

- **SM-1**: Command usage: minimal 10 command/user/hari setelah 1 minggu
- **SM-2**: Reminder: minimal 5 grup subscribed dalam 1 minggu pertama
- **SM-3**: Error rate: <1% dari total command
- **SM-4**: Reminder delivery: 95% terkirim dalam ±2 menit

## Scope / MVP

**Phase MVP (Phase 0-5)**: FR-1 sampai FR-8.

**Phase Fase 2**: Hadith command, tafsir, qibla, asmaul husna, kalender hijri, zakat calculator, doa pagi/sore cron.

## Future Considerations

- Endpoint doa yang lebih lengkap kalau API baru muncul
- Multi-bahasa untuk terjemah Quran
- Audio recitation per ayat
- Notifikasi personal (DM, bukan cuma grup)
- Command `!sholat report` untuk user non-admin yang mau protes grup spam