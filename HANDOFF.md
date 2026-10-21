# HANDOFF.md — Dokumen Konteks & Status Proyek Allybot

> **Catatan:** Dokumen ini adalah satu-satunya jembatan konteks antar sesi. Dokumen ini wajib diperbarui di setiap akhir sesi pengerjaan agar konteks proyek tidak pernah hilang.

---

## 1. Tujuan Proyek
Allybot adalah bot WhatsApp multifungsi berbasis Node.js 22 & TypeScript untuk melayani komunitas roleplay **"Allyssea"**, sekaligus menyediakan serangkaian utilitas publik:
1. **Sistem Roleplay Fantasi (Allyssea RP):** Registrasi karakter (DM / Web Companion), manajemen status RPG & alokasi token stat, pemisahan mode In-Character (IC) dan Out-Of-Character (OOC), serta sistem ekonomi kerajaan (Vela, safe/brankas, pajak mingguan).
2. **Moderasi & Manajemen Grup:** Perlindungan grup (antilink, antispam, antitoxic), penindakan pelanggaran (warns auto-kick, mute berdurasi, ban/blacklist), manajemen role/admin, dan pencatatan audit log aman.
3. **Utilitas Islami:** Jadwal sholat harian kota Indonesia, pembacaan ayat Al-Qur'an dan terjemahan (`equran.id`), doa harian (80+ doa Kemenag/Rumaysho), dan cron scheduler pengingat waktu adzan otomatis per grup disertai audio dan kutipan hadits bergilir.
4. **Media & Downloader:** Pembuatan stiker WhatsApp (termasuk stiker meme, Brat, stickerpack), downloader media multi-platform (Instagram, Twitter/X, Threads, SoundCloud, YouTube, TikTok), dan integrasi AI (Omni-AI chat, OCR, TTS).
5. **Automasi Khusus:** Modul automasi aktivasi akun Alight Motion Premium (`amprem`).

---

## 2. Arsitektur Singkat
* **Runtime:** Node.js `>=22.0.0` (ESM `"type": "module"`, Strict TypeScript, target `ES2022`, module resolution `NodeNext`).
* **WhatsApp Gateway:** `@whiskeysockets/baileys` (`7.0.0-rc14`) dibungkus oleh adapter `src/whatsapp.ts`.
* **Alur Pesan:** 
  `WhatsAppConnection` ➔ `ApplicationFramework.bindCoreEvents()` ➔ `Message Gates` (kebijakan blokir sebelum proses) ➔ `EventBus` (`message.received`) ➔ `CommandRegistry.dispatch` (Prefix ➔ Permission ➔ User Rate Limit ➔ Validation ➔ Cooldown) ➔ Plugin Handler ➔ Reply via Adapter.
* **Penyimpanan Data (Storage):**
  * **SQLite (`better-sqlite3` v12.4.1):** Penyimpanan primer lokal (kredensial Baileys, cache pemulihan pesan dengan TTL & pruning, konfigurasi grup, AFK, suggestion, kuota harian). WAL mode + busy_timeout 5s.
  * **PostgreSQL (Opsional):** Backend awan untuk profil karakter RPG, perbankan Vela terdistribusi, dan status konteks grup IC/OOC. Jika tidak dikonfigurasi, sistem menerapkan *refusal stub* yang aman tanpa crash.
  * **Redis (Opsional, Fail-soft):** Cache snapshot ekonomi, mutex distributed lock, sliding window rate limit, dan antrean. Dirancang fail-soft (jika Redis mati, bot tetap berjalan normal dengan fallback in-memory/SQLite).

---

## 3. Lingkungan Operasional (Deployment Context)
* **Produksi (Production):** Bot **sudah aktif berjalan di VPS Linux** (jalur `/opt/Allybot`, didistribusikan via CI/CD GitHub Actions dan Pterodactyl Panel).
* **Pengembangan Lokal (Local Development):** Laptop Windows pengguna (RAM 4 GB).
* **Prinsip Utama:** Setiap perubahan kode **harus bersifat cross-platform** dan tidak boleh merusak konfigurasi atau path yang dibutuhkan oleh VPS produksi. Hindari proses berat yang membebani memori laptop.

---

## 4. Keputusan Desain Penting & Alasannya
1. **Isolasi Kegagalan per Plugin:** Kegagalan satu plugin di tahap load, init, atau command handler diisolasi dan di-catch oleh framework sehingga tidak meruntuhkan bot secara keseluruhan.
2. **Privasi By Design:** Nomor telepon / JID selalu di-hash dengan SHA-256 sebelum disimpan ke tabel audit atau dikirim ke backend luar. Log Pino menerapkan sensor (*redact*) ketat pada 36 path sensitif.
3. **Refusal Stub untuk Fitur Ber-backend:** Fitur RPG dan konteks grup yang membutuhkan PostgreSQL memiliki fallback refusal terstruktur agar pengguna mendapatkan pesan penolakan yang ramah alih-alih bot error tanpa respon.

---

## 5. Status Terkini Komponen
* **Tipe Data (`npx tsc --noEmit`):** ✅ SELESAI & LULUS (0 error).
* **Build (`npm run build`):** ✅ SELESAI & LULUS (Kompilasi TypeScript ke `dist/` berhasil 100%).
* **Paritas Platform (`node scripts/verify-platform.mjs`):** ✅ SELESAI & LULUS (20 modul source verified).
* **Dependensi SQLite Lokal:** ✅ DIPULIHKAN (Rebuilt untuk Node 22 win32-x64, file binding `better_sqlite3.node` aktif).
* **Kebersihan Kode Sumber `src/`:** ✅ DIBERSIHKAN (11 file build `.js` sisa kompilasi di `src/` telah dihapus).
* **Normalisasi Jalur Direktori:** ✅ SELESAI (Semua 12 hardcoded `/opt/Allybot/...` diubah dinamis berbasis `process.cwd()`, dan seluruh `/tmp/` diubah menggunakan `tmpdir()` cross-platform).
* **Eksekusi Python Cross-Platform:** ✅ SELESAI (Menggunakan seleksi binary dinamis `pythonBin` dan font prioritas `assets/fonts/`).
* **Test Suite Lokal (`npm test`):** ✅ AKTIF (260 dari 283 subtest lulus; 23 tes yang belum lulus adalah integrasi eksternal PostgreSQL port 5433 untuk CI/Docker).

---

## 6. Tindakan yang Telah Dilakukan di Sesi Ini
1. [x] Membuat dokumen handoff proyek (`HANDOFF.md`).
2. [x] Memulihkan binary C++ `better-sqlite3` di runtime lokal Node 22 (`npm rebuild better-sqlite3`).
3. [x] Membersihkan 11 file build `.js` yang terselip di dalam folder `src/`.
4. [x] Menetralkan semua path mutlak `/opt/Allybot/data/...` menjadi path dinamis berbasis `process.cwd()` (100% kompatibel VPS dan lokal).
5. [x] Menetralkan penulisan file sementara `/tmp/` menjadi `tmpdir()` di `media.ts`, `spotify.ts`, `spack-session.ts`, dan `status-card-renderer.ts`.
6. [x] Menetralkan pemanggilan Python (`python3` vs `python`) dan memprioritaskan font lokal `assets/fonts/Inter.ttf`.
7. [x] Menghapus IP lama statis `38.102.126.42` dan menggantinya dengan fallback `localhost` di `web-companion-service.ts`.
8. [x] Menjalankan verifikasi penuh (`tsc --noEmit`, `npm run build`, `verify-platform.mjs`, dan `npm test`).

---

## 7. Catatan untuk Sesi Berikutnya / Celah yang Perlu Diperhatikan
* **Fitur Natural Typing Indicator:** Rencana teknis telah disusun di `docs/plan-typing-indicator.md` (helper `withTyping`, heartbeat 8s, anti-stuck try-finally, integrasi ke handler AI, media, music, dan downloader).
* **Audit Investigasi Bug `!play` Music:** Pi Coding Agent telah mengidentifikasi 5 akar masalah utama:
  1. Penanganan URL Spotify (`open.spotify.com/track/...`) belum diuraikan menjadi query judul/artis sebelum dilempar ke Deezer.
  2. Normalisasi regex `replace(/[^a-z0-9 ]/g, '')` di `music-cache.ts` memotong tanda kurung `(feat. ...)` dan karakter penting judul.
  3. Negative cache mengunci pencarian gagal selama 10 menit tanpa opsi retry jika pengguna mengetik ulang dengan ejaan serupa.
  4. Akun Deezer free ARL memiliki batasan lisensi pada beberapa lagu (WrongLicense) yang menyebabkan download quality 1 gagal.
  5. Pesan feedback generic ("Gagal download audio. Coba judul lain") membuat persepsi user menganggap database bot tidak punya lagu tersebut.
* **Docker/CI Database Tests:** Tes `character-e2e-postgres.test.js` dan `hotfix-token-guard.test.js` membutuhkan PostgreSQL yang menyala di port `5433` (ini normal untuk pengujian CI/CD; jika ingin dijalankan di lokal, butuh Docker Postgres).
* **Kredensial di `env_backups/`:** File `env_backups/vps_production.env` berisi data produksi nyata; pastikan tidak pernah diikutsertakan dalam commit atau arsip export publik.

