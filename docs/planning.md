# planning.md — Islamic Utilities untuk Allybot

## Project Overview

Paket fitur Islamic utilities untuk bot WhatsApp berbasis Baileys (Allybot).
Menambahkan tiga command user-facing (Quran, jadwal sholat, doa) dan satu
sistem reminder otomatis yang mengirim audio adzan + quote ke grup yang
opt-in.

Reuse infrastruktur yang sudah ada (queue, limiter, cooldown, cache
resolver) tanpa memodifikasi fitur existing (`!play`, `!amprem`, `!img`).

## Problem Statement

Audiens bot dominan Muslim Indonesia. Belum ada fitur keagamaan sama
sekali. User harus keluar dari WhatsApp untuk cek jadwal sholat, baca
ayat, atau cari doa. Untuk reminder waktu sholat, user harus install
aplikasi terpisah atau set alarm manual.

## Goal

Satu paket yang memungkinkan user mengakses konten keagamaan dasar dan
mengaktifkan reminder waktu sholat di grup WhatsApp mereka — tanpa biaya,
tanpa API key, tanpa maintenance berat.

## Scope

### In Scope (MVP)

- `!quran <surah>:<ayat>` — ayat Arab + terjemah Indonesia
- `!sholat <kota>` — jadwal sholat hari ini
- `!doa <topik>` — doa per kategori
- `!sholat subscribe <kota>` — admin grup aktifkan reminder
- `!sholat unsubscribe` — admin/owner nonaktifkan
- `!sholat set-kota <kota>` — admin ganti kota
- `!sholat status` — lihat status subscription
- Background job: reminder tiap waktu sholat ke grup opt-in

### Out of Scope (Fase 2+)

- Hadith sebagai command terpisah
- Tafsir per ayat
- Audio recitation per ayat
- Search Quran
- Image rendering ayat
- Qibla direction
- Hijri calendar
- Zakat calculator
- Asmaul Husna
- Doa pagi/sore cron
- Ayat of the day cron

## Strategy

MVP-first dengan permukaan testing minimal. Tiga command user-facing
menguji tiga jalur yang berbeda: API statis (Quran), API kalkulasi
(sholat), data hardcoded (doa). Setelah pola dasar works, ekspansi
command baru cuma reuse pola yang sama.

Reminder adalah satu-satunya komponen time-triggered. Dikerjakan paling
akhir karena butuh tiga command dasar sebagai fondasi (jadwal sholat
harus works dulu sebelum bisa dijadwalkan).

## Architecture Direction

```
Allybot
├── src/framework/plugins/
│   ├── quran.ts        → handler !quran
│   ├── sholat.ts       → handler !sholat (info + subscription)
│   └── doa.ts          → handler !doa
├── src/services/
│   ├── quran-api.ts    → adapter equran.id
│   ├── sholat-api.ts   → adapter myquran + aladhan fallback
│   ├── doa-data.ts     → pool doa hardcoded
│   ├── sholat-cache.ts → Cache Resolver untuk jadwal
│   ├── sholat-subs.ts  → Subscription manager (per grup)
│   └── sholat-scheduler.ts → Background job
├── data/
│   ├── sholat_subs.tson        → state subscription per grup
│   ├── sholat_cache.tson       → cache jadwal per (kota, tanggal)
│   ├── sholat_quotes.tson      → pool hadith + ayat untuk reminder
│   └── adzan/
│       ├── subuh.mp3
│       ├── dzuhur.mp3
│       ├── ashar.mp3
│       ├── maghrib.mp3
│       └── isya.mp3
└── docs/
├── planning.md
├── prd.md
├── task.md
└── configuration.md
```

Reuse infra existing:
- `src/services/queue.ts` → untuk prevent concurrent API call ke kota yang sama
- `src/services/cooldown.ts` → per grup, untuk command `!quran` dan `!doa`
- `src/services/limiter.ts` → per user, untuk command
- `src/services/tiers.ts` → admin check untuk subscription command

## Major Components

### 1. Quran Adapter
Interface tunggal: `getAyat(surah, ayat) → { arab, latin, arti, surah_name }`.
Sumber tunggal: `equran.id`. Data statis, tidak ada caching yang
diperlukan untuk runtime — tapi response di-cache 24 jam untuk
mengurangi pressure ke API.

### 2. Sholat Adapter
Interface: `getJadwal(kota, tanggal) → { imsak, subuh, dzuhur, ashar, maghrib, isya }`.
Sumber utama: `api.myquran.com`. Fallback: `aladhan.com` kalau primary
gagal 3x retry. Response di-cache per (kota, tanggal) — jadwal hari ini
dan besok di-pre-fetch tiap tengah malam.

### 3. Doa Pool
Data statis di `src/services/doa-data.ts`. 30 doa populer dari Kemenag/Rumaysho,
setiap doa punya: `{ id, kategori, judul, arab, latin, arti, sumber }`.

### 4. Subscription Manager
File: `data/sholat_subs.tson`. Struktur:
```
{
"<group-jid>": {
"kota": "jakarta",
"subscribedAt": 1759481760000,
"subscribedBy": "<admin-jid>",
"enabled": true
}
}
```

Command subscribe/unsubscribe/set-kota hanya untuk admin grup (via
`sock.groupMetadata`) + owner. State persist ke disk.

### 5. Reminder Scheduler
`setInterval` tiap 60 detik. Untuk setiap menit:
1. Ambil jam saat ini (WIB)
2. Cek semua grup subscribed
3. Untuk setiap grup, cek apakah jam saat ini = salah satu waktu sholat
   untuk kotanya
4. Kalau ya: kirim audio + caption
5. Throttle: antar pesan minimal 3 detik, maksimal 10 pesan per menit

Catch-up rule: kalau bot restart dan waktu sholat terlewat <5 menit,
tetap kirim. Kalau >5 menit, skip.

### 6. Quote Rotator
Pool hadith + ayat untuk reminder. Random rotate per sholat, tidak
repeat dalam 7 hari untuk grup yang sama. State rotasi per grup.

## Implementation Phases

### Phase 0 — Persistence & Infra Check
Verifikasi bahwa infra existing (queue, cooldown, limiter) bisa di-reuse
tanpa modifikasi. Setup struktur folder.

### Phase 1 — Quran Command
Adapter + handler + register. Test `!quran 2:255`.

### Phase 2 — Sholat Command (info only)
Adapter + cache + handler. Test `!sholat jakarta`.

### Phase 3 — Doa Command
Pool data + handler. Test `!doa sebelum-tidur`.

### Phase 4 — Subscription Commands
Subscription manager + admin check. Test subscribe/unsubscribe/status.

### Phase 5 — Reminder Scheduler
Scheduler + quote rotator + audio files. Test dengan waktu sholat
simulasi.

### Phase 6 — Observability & Hardening
Logging, error handling, edge case coverage, rate limit audit.

## Dependencies

| Dependency | Untuk | Kritikalitas |
|---|---|---|
| `equran.id` | Teks Quran + terjemah | Tinggi |
| `api.myquran.com` | Jadwal sholat | Tinggi |
| `api.aladhan.com` | Fallback jadwal | Sedang |
| File adzan (5) | Reminder | Tinggi |
| Baileys groupMetadata | Admin check | Tinggi |

## Risks

| Risk | Impact | Mitigasi |
|---|---|---|
| WhatsApp rate limit / ban | Tinggi | Throttle reminder, batch kecil, jangan burst |
| API sholat down | Sedang | Fallback aladhan + cache 24 jam |
| Bot restart hilang state | Sedang | Persist subscription ke disk |
| Kota tidak ditemukan | Rendah | Fuzzy match + pesan error jelas |
| Admin grup tidak bisa di-fetch | Sedang | Cache metadata grup, fallback ke owner manual |

## Assumptions

- `equran.id` dan `api.myquran.com` stabil selama development
- File adzan dapat ditemukan dengan lisensi aman (public domain / CC)
- Bot di-deploy di VPS yang bisa reach API Indonesia dengan latency <500ms
- Infra existing (queue, cooldown, limiter) bisa di-reuse tanpa modifikasi

## Decisions

| ID | Decision | Reason |
|---|---|---|
| D1 | Command `!sholat` (bukan `!solat`) | Lebih umum di Indonesia |
| D2 | Unsubscribe: admin + owner | Owner bisa recover kalau admin hilang |
| D3 | Quote include citation | Kredibilitas + verifiable |
| D4 | Doa hardcode (bukan API) | API doa tidak konsisten |
| D5 | Audio adzan self-host | Statis, gak ada dependency network |
| D6 | Subscription per grup, bukan per user | Satu sumber kebenaran, hindari DM massal |
| D7 | Catch-up rule 5 menit | Balance antara miss dan spam |

## Milestones

- **M1**: Quran + Sholat + Doa commands works (Phase 1-3)
- **M2**: Subscription commands works (Phase 4)
- **M3**: Reminder scheduler works end-to-end (Phase 5)
- **M4**: Hardened & documented (Phase 6)

## Definition of Done

- Tiga command user-facing works dengan output benar
- Empat command subscription works dengan admin check
- Reminder terkirim tepat waktu ke grup subscribed, dengan audio + quote
- Bot restart → state subscription tetap intact
- Semua API call punya retry + timeout
- Log cukup untuk debug tanpa harus reproduce
- Tidak ada modifikasi ke handler existing (!play, !amprem, !img)

## Validation Strategy

- Unit-level: setiap adapter punya test dengan mock HTTP response
- Integration: manual test setiap command via WA dari akun test
- Reminder: test dengan mock clock (bukan tunggu waktu sholat real)
- Restart: kill bot, restart, cek subscription tetap ada
- Rate limit: simulasi 30 grup subscribed, cek throttle behavior