# Allybot

Bot WhatsApp untuk komunitas roleplay **Allyssea**. Dibangun dengan [Baileys](https://github.com/WhiskeySockets/Baileys), TypeScript, dan SQLite.

Yang bisa dilakukan:

- Moderasi grup, AFK, knowledge base, dan scene roleplay
- Utilitas Islami: Al-Qur'an, jadwal sholat, doa harian, dan pengingat adzan
- AI opsional (tanya jawab, terjemahan, ringkasan) lewat provider yang kompatibel dengan OpenAI

> **Belum aktif:** Ekonomi Vela, Group Context (IC/OOC), dan Character Guide. Flag-nya ada, tapi backend-nya belum dipasang, jadi command-nya hanya membalas "belum tersedia". Aman diaktifkan, tapi jangan dijanjikan ke member.

## Mulai Cepat

Butuh **Node.js 22** dan npm.

```bash
git clone <url-repo> allybot
cd allybot
npm ci
cp .env.example .env
```

Buka `.env`, lalu set `QR_ENABLED=true`. Tanpa ini, QR login tidak akan muncul.

```bash
npm run build
npm start
```

Scan QR yang muncul di terminal lewat WhatsApp → **Perangkat Tertaut**. Sesi tersimpan di SQLite, jadi restart berikutnya tidak perlu scan lagi.

Lebih suka kode angka daripada QR? Set `PAIRING_ENABLED=true` dan `PAIRING_PHONE_NUMBER` (digit saja).

## Konfigurasi

Semua pengaturan ada di `.env`. Nilai boolean harus persis `true` atau `false`. Daftar lengkap ada di `.env.example`.

| Variabel | Default | Fungsi |
|---|---|---|
| `QR_ENABLED` | `false` | Cetak QR untuk login pertama |
| `COMMAND_PREFIX` | `!` | Awalan command (1–4 karakter) |
| `BOT_OWNER_JID` | – | Nomor pemilik bot, untuk command khusus owner |
| `DATABASE_PATH` | `./data/allyssea.sqlite` | Lokasi database |
| `LOG_LEVEL` | `info` | `silent` sampai `trace` |
| `WHATSAPP_ENABLED` | `true` | `false` = mode maintenance (bot hidup tanpa koneksi WhatsApp) |

## Pengembangan

```bash
npm run build       # kompilasi TypeScript ke dist/
npm run typecheck   # cek tipe tanpa build
npm test            # jalankan test
npm run self-check  # cek integritas database dan konfigurasi
```

Test membaca dari `dist/`, bukan `src/`. **Selalu `npm run build` dulu** sebelum `npm test`.

Struktur singkat:

```
src/
├── index.ts            # titik masuk
├── config.ts           # validasi .env
├── whatsapp.ts         # koneksi Baileys
├── framework/plugins/  # fitur-fitur bot (satu plugin per fitur)
└── services/           # layanan dengan state (SQLite, Redis)
tests/                  # test (import dari ../dist/)
```

Menambah command baru: buat atau edit plugin di `src/framework/plugins/`, lalu daftarkan lewat `context.commands.register({ name, description, handler })`. Contoh lengkap ada di plugin yang sudah ada.

## Deployment

CI berjalan di GitHub Actions (`.github/workflows/ci.yml`): typecheck, build, test, lalu membuat arsip release (`allybot-release-<sha>.zip`, disimpan 14 hari).

Deploy otomatis ke panel Pterodactyl bersifat opsional. Untuk mengaktifkannya, isi variabel repo `PANEL_DEPLOY_ENABLED=true`, `PANEL_URL`, `PTERODACTYL_SERVER_ID`, dan secret `PTERODACTYL_API_TOKEN`. Deploy hanya mengunggah file. Restart server tetap dilakukan manual dari panel.

Arsip deploy tidak berisi `.env`, database, atau sesi WhatsApp, jadi deploy dan rollback tidak memutus login bot. Untuk rollback, `git revert` commit yang bermasalah lalu push, atau unggah arsip release versi sebelumnya.

## Masalah Umum

| Masalah | Solusi |
|---|---|
| QR tidak muncul | Set `QR_ENABLED=true`. QR juga tidak muncul kalau bot sudah pernah login. |
| Banyak test gagal / `ERR_MODULE_NOT_FOUND` | `rm -rf dist && npm run build && npm test` |
| `SQLITE_BUSY` | Pastikan hanya satu proses bot yang memakai file database yang sama. |
| Bot logout sendiri | Perangkat di-unlink, atau akun login di tempat lain. Hapus sesi lama dan scan ulang. |
| `Invalid Allybot configuration` | Baca pesan errornya, biasanya ada `.env` yang kurang atau salah. Contoh: `PAIRING_ENABLED=true` tanpa `PAIRING_PHONE_NUMBER`. |
| Build atau native module error | Pastikan `node --version` menunjukkan `v22.x`, lalu `npm ci` ulang. |

## Catatan

- Baileys yang dipakai adalah release candidate (`7.0.0-rc14`), jadi ada risiko perubahan API dari WhatsApp.
- Privasi: isi pesan mention AFK tidak disimpan, riwayat chat tidak disinkronkan, dan JID di-hash sebelum dikirim ke layanan eksternal. Log menyamarkan data sensitif.
