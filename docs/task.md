# task.md — Execution Checklist: Islamic Utilities

Setiap task punya ID, deskripsi, alasan, dependency, output, acceptance,
dan validasi. Status awal: `TODO`.

---

## Phase 0 — Persistence & Infra Check

### P0-T1 — Verify existing infra bisa di-reuse
- **Why**: Konfirmasi queue.ts, cooldown.ts, limiter.ts bisa di-import tanpa konflik dengan modul baru
- **Dependencies**: -
- **Output**: Laporan singkat: mana yang reusable, mana yang butuh adapter
- **Acceptance**: Bisa import ketiga modul di `src/services/` baru tanpa error
- **Validation**: Tulis test import sederhana, jalankan
- **Status**: DONE

### P0-T2 — Setup struktur folder
- **Why**: Semua modul baru punya rumah yang jelas sebelum coding
- **Dependencies**: -
- **Output**: Folder `data/adzan/`, file placeholder `data/sholat_subs.tson`, `data/sholat_quotes.tson`
- **Acceptance**: Struktur folder match planning.md
- **Validation**: `ls -R data/` menampilkan struktur yang diharapkan
- **Status**: DONE

### P0-T3 — Download 5 file adzan
- **Why**: Reminder butuh audio self-host
- **Dependencies**: P0-T2
- **Output**: `data/adzan/{subuh,dzuhur,ashar,maghrib,isya}.mp3`
- **Acceptance**: 5 file ada, masing-masing <16MB, format mp3 valid
- **Validation**: `ffprobe` tiap file, cek durasi dan codec
- **Status**: DONE

### P0-T4 — Compile pool 30 doa + 30 hadith/ayat untuk quote
- **Why**: Data statis, gak butuh API
- **Dependencies**: -
- **Output**: `src/services/doa-data.ts` (30 doa) dan `data/sholat_quotes.tson` (30 quote)
- **Acceptance**: Setiap doa punya {kategori, judul, arab, latin, arti, sumber}. Setiap quote punya {teks, sumber}
- **Validation**: Script count — harus tepat 30 dan 30
- **Status**: DONE

---

## Phase 1 — Quran Command

### P1-T1 — Buat adapter `src/services/quran-api.ts`
- **Why**: Isolasi logic HTTP dari handler
- **Dependencies**: P0-T1
- **Output**: Fungsi `getAyat(surah, ayat) → { arab, latin, arti, surah_name }`
- **Acceptance**: Retry 3x, timeout 10s, error jelas
- **Validation**: Unit test dengan mock `equran.id` response
- **Status**: DONE

### P1-T2 — Buat handler `src/framework/plugins/quran.ts`
- **Why**: Wire command ke adapter
- **Dependencies**: P1-T1
- **Output**: `handleQuran(sock, msg, args)`
- **Acceptance**: Format `surah:ayat`, reject tanpa ayat, format response match user flow di prd.md
- **Validation**: Manual test `!quran 2:255`, `!quran 2`, `!quran 999:1`
- **Status**: DONE

### P1-T3 — Register command di message handler
- **Why**: Supaya Baileys route pesan `!quran` ke handler baru
- **Dependencies**: P1-T2
- **Output**: Entry di message handler utama
- **Acceptance**: `!quran 2:255` reach handler, `!play` masih works
- **Validation**: Test tiga command existing + `!quran`
- **Status**: DONE

### P1-T4 — Tambah cache 24 jam untuk response ayat
- **Why**: Kurangi pressure ke API, perbaiki latency
- **Dependencies**: P1-T1
- **Output**: Cache layer di adapter, TTL 24 jam
- **Acceptance**: Panggilan kedua untuk ayat sama <100ms
- **Validation**: Log timestamp sebelum/sesudah, cek delta
- **Status**: DONE

---

## Phase 2 — Sholat Command

### P2-T1 — Buat adapter `src/services/sholat-api.ts`
- **Why**: Isolasi sumber jadwal + fallback
- **Dependencies**: P0-T1
- **Output**: `getJadwal(kota, tanggal) → { imsak, subuh, dzuhur, ashar, maghrib, isya }`
- **Acceptance**: Primary myquran, fallback aladhan, retry 3x, timeout 10s
- **Validation**: Unit test dengan mock kedua sumber
- **Status**: DONE

### P2-T2 — Buat cache resolver `src/services/sholat-cache.ts`
- **Why**: Jadwal hari ini sering dipanggil, cache murah
- **Dependencies**: P2-T1
- **Output**: `getCached(kota, tanggal)`, `setCached(kota, tanggal, jadwal)`
- **Acceptance**: File persist `data/sholat_cache.tson`, TTL 24 jam
- **Validation**: Panggil dua kali, kedua hit cache
- **Status**: DONE

### P2-T3 — Buat handler `src/framework/plugins/sholat.ts` untuk info
- **Why**: Command utama user
- **Dependencies**: P2-T1, P2-T2
- **Output**: `handleSholat(sock, msg, args)` — branch info vs subscription
- **Acceptance**: `!sholat jakarta` tampilkan jadwal, kota invalid → error dengan saran
- **Validation**: Manual test 3 kota valid + 1 invalid
- **Status**: DONE

### P2-T4 — Register command
- **Dependencies**: P2-T3
- **Output**: Entry di message handler
- **Acceptance**: Reach handler, command lain tidak terganggu
- **Validation**: Smoke test
- **Status**: DONE

---

## Phase 3 — Doa Command

### P3-T1 — Buat handler `src/framework/plugins/doa.ts`
- **Why**: Command sederhana, data lokal
- **Dependencies**: P0-T4
- **Output**: `handleDoa(sock, msg, args)`
- **Acceptance**: `!doa sebelum-tidur` tampilkan doa lengkap, kategori tidak ada → list kategori
- **Validation**: Test 3 kategori valid + 1 invalid
- **Status**: DONE

### P3-T2 — Register command
- **Dependencies**: P3-T1
- **Output**: Entry di message handler
- **Acceptance**: Reach handler
- **Validation**: Smoke test
- **Status**: DONE

---

## Phase 4 — Subscription Commands

### P4-T1 — Buat subscription manager `src/services/sholat-subs.ts`
- **Why**: Isolasi state dari handler
- **Dependencies**: P0-T2
- **Output**: `subscribe(jid, kota, byJid)`, `unsubscribe(jid)`, `setKota(jid, kota)`, `getStatus(jid)`, `listAll()`
- **Acceptance**: Persist ke `data/sholat_subs.tson`, debounce write 500ms
- **Validation**: Unit test, restart simulation
- **Status**: DONE

### P4-T2 — Admin check helper
- **Why**: Subscribe command butuh verifikasi admin
- **Dependencies**: -
- **Output**: `isAdmin(sock, groupJid, userJid) → boolean` (via groupMetadata, cache 5 menit)
- **Acceptance**: Return true untuk admin, false untuk non-admin
- **Validation**: Test dengan grup nyata
- **Status**: DONE

### P4-T3 — Wire subscribe/unsubscribe/set-kota/status ke handler
- **Why**: Lengkapi command subscription
- **Dependencies**: P4-T1, P4-T2, P2-T3
- **Output**: Branch di `handleSholat` untuk subcommand
- **Acceptance**: Semua 4 subcommand works dengan admin check
- **Validation**: Manual test sebagai admin dan non-admin
- **Status**: DONE

### P4-T4 — Owner override untuk reset
- **Why**: Recovery kalau grup stuck atau admin hilang
- **Dependencies**: P4-T3
- **Output**: Command `!sholat reset <group-jid>` yang hanya owner bisa jalankan dari DM
- **Acceptance**: Non-owner tidak bisa akses, owner bisa reset
- **Validation**: Test dari akun owner dan non-owner
- **Status**: DONE

---

## Phase 5 — Reminder Scheduler

### P5-T1 — Buat quote rotator
- **Why**: Reminder harus variatif, tidak repeat
- **Dependencies**: P0-T4
- **Output**: `getQuoteFor(groupJid, sholat) → { teks, sumber }` dengan tracking 7-hari-tidak-repeat per grup
- **Acceptance**: 30 panggilan berturut-turut, tidak ada repeat dalam 7
- **Validation**: Unit test rotation logic
- **Status**: DONE

### P5-T2 — Buat scheduler `src/services/sholat-scheduler.ts`
- **Why**: Komponen inti reminder
- **Dependencies**: P2-T2, P4-T1, P5-T1, P0-T3
- **Output**: `startScheduler(sock)` — setInterval 60 detik, cek waktu sholat, kirim ke grup subscribed
- **Acceptance**: Terkirim tepat waktu ±2 menit, catch-up rule, throttle
- **Validation**: Mock clock, subscribe grup test, advance time
- **Status**: DONE

### P5-T3 — Format pesan reminder
- **Why**: Output user-facing, harus rapi
- **Dependencies**: P5-T2
- **Output**: Template caption + audio attach
- **Acceptance**: Format match user flow di prd.md
- **Validation**: Kirim ke grup test, cek visual
- **Status**: DONE

### P5-T4 — Wire scheduler di startup bot
- **Why**: Scheduler harus jalan saat bot start
- **Dependencies**: P5-T2
- **Output**: Panggil `startScheduler(sock)` di `index.ts`
- **Acceptance**: Scheduler aktif setelah startup
- **Validation**: Cek log startup + simulasi waktu sholat
- **Status**: DONE

---

## Phase 6 — Observability & Hardening

### P6-T1 — Logging untuk semua API call
- **Why**: Debug tanpa harus reproduce
- **Dependencies**: Phase 1-5 selesai
- **Output**: Log format konsisten: `[quran-api] GET 2:255 200 340ms`
- **Acceptance**: Setiap API call tercatat
- **Validation**: Grep log untuk beberapa panggilan
- **Status**: DONE

### P6-T2 — Error handling audit
- **Why**: Pastikan tidak ada unhandled rejection
- **Dependencies**: Phase 1-5 selesai
- **Output**: Semua network call punya try/catch, semua handler punya fallback
- **Acceptance**: Grep tidak menemukan `await fetch` tanpa try/catch
- **Validation**: Code review manual
- **Status**: DONE

### P6-T3 — Rate limit test dengan 30 grup simulasi
- **Why**: Verifikasi throttle reminder works di skala
- **Dependencies**: P5-T2
- **Output**: Test environment dengan 30 grup subscribed, simulasi waktu sholat
- **Acceptance**: 30 pesan terkirim dalam ~90 detik tanpa burst
- **Validation**: Log timing
- **Status**: DONE

### P6-T4 — Restart test
- **Why**: Verifikasi state persistence
- **Dependencies**: Phase 4 selesai
- **Output**: Test scenario: subscribe 3 grup, restart bot, cek 3 grup masih ada
- **Acceptance**: State intact setelah restart
- **Validation**: Manual kill + restart + cek file + cek command status
- **Status**: DONE

### P6-T5 — Documentation
- **Why**: Handoff dan maintenance
- **Dependencies**: Semua task selesai
- **Output**: Update README dengan section "Islamic Utilities", cara subscribe, cara ganti kota, cara reset
- **Acceptance**: README lengkap untuk user baru
- **Validation**: Baca sendiri, ikuti step, pastikan works
- **Status**: DONE

---

## Task Dependency Graph
```
Phase 0
├── P0-T1 ────┬── P1-T1 ──── P1-T2 ──── P1-T3
│             │              P1-T4
│             ├── P2-T1 ──── P2-T2 ──── P2-T3 ──── P2-T4
│             │                          │
│             └── P4-T2                  │
├── P0-T2 ──── P4-T1 ────────────────────┤
│             │                          │
├── P0-T3 ────┴── P5-T2 ─────────────────┤
│                                       │
└── P0-T4 ────┬── P3-T1 ──── P3-T2      │
└── P5-T1 ────────────────┘

Phase 6 (setelah semua)
P6-T1, P6-T2, P6-T3, P6-T4, P6-T5
```
