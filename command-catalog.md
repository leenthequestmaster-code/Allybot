# Katalog Command Allybot — Aktual

Dokumen ini adalah inventaris command yang benar-benar teregistrasi di source code (per September 2026), dihasilkan dan diverifikasi dari `src/framework/plugins/*`. Bukan lagi katalog ide — setiap entri di sini punya implementasi dan unit/integration test.

Aturan baca:
- Prefix default `!`, dapat berubah per grup via `!setprefix`.
- Penanda `[hidden]` = command tersembunyi dari menu utama (owner/diagnostik) tapi tetap bisa dipakai.
- Permission kosong = semua member; `group.admin` = butuh admin grup.
- Command fitur stub (Ekonomi, Group Context IC/OOC, Character Guide) telah aktif dengan adapter SQLite lokal dan PostgreSQL.

## Status Fitur

| Fitur | Flag | Kondisi |
|---|---|---|
| Ekonomi Vela | `ECONOMY_ENABLED` | Aktif lokal SQLite / Postgres 17. |
| Group Context IC/OOC | `GROUP_CONTEXT_ENABLED` | Aktif dengan SQLite / Postgres 17. |
| Character Guide | `CHARACTER_GUIDE_ENABLED` | Aktif via Web Companion PWA & Postgres. |
| AI generik | `AI_ENABLED` + `AI_API_KEY` | Siap; default off; OpenAI-compatible provider. |
| Redis | `REDIS_ENABLED` + `REDIS_URL` | Cache layer & mutasi akun. |
| Diagnostik | `DIAGNOSTICS_ENABLED` | Opsional, default off. |
| Export Codebase | `CODEBASE_EXPORT_ENABLED` | Owner-only, default off. |
| Sentry | `SENTRY_ENABLED` + `SENTRY_DSN` | Telemetry error non-sensitif. |

## developer (4)
| Command | Akses | Fungsi |
|---|---|---|
| `!dev` (debug) [hidden] | Owner | Diagnostik Developer Mode. |
| `!groupid` (jid) [hidden] | Owner | JID grup untuk allowlist. |
| `!alljid` [hidden] | Owner | Daftar semua JID grup. |
| `!codebase` [hidden] | Owner | Kirim Codebase Intelligence Export tersanitasi. |

## economy (4)
| Command | Fungsi |
|---|---|
| `!vela` (wallet) | Saldo Wallet dan Safe Vela. |
| `!bank` | Kelola rekening Wallet dan Safe. |
| `!tax` | Status pajak Vela. |
| `!taxbayar` (bayarpajak) | Bayar pajak tertunggak. |

## fun (8)
| Command | Fungsi |
|---|---|
| `!8ball` | Jawaban delapan bola. |
| `!choose` | Pilih satu opsi acak. |
| `!dare` (tantangan) | Tantangan ringan. |
| `!flip` | Lempar koin. |
| `!random` | Angka acak dalam rentang. |
| `!roll` (dice) | Lempar dadu (mis. 2d6). |
| `!rps` (suit) | Batu-gunting-kertas PvP via PM. |
| `!truth` (jujur) | Pertanyaan truth ringan. |

## governance (6)
| Command | Fungsi |
|---|---|
| `!continuity` (cekcatatan) | Cek kontinuitas governance. |
| `!handoff` (handover) | Serah terima moderator. |
| `!invite` | Inspeksi/cabut link invite. |
| `!join` | Setujui/tolak join request. |
| `!joinrequests` (joinlist) | Daftar join request. |
| `!retcon` | Review proposal retcon. |

## group (24)
| Command | Akses | Fungsi |
|---|---|---|
| `!admins` (adminlist) | Semua | Daftar admin dengan mention. |
| `!afk` (away) | Semua | Set/lihat status AFK. |
| `!clearleave` | Admin | Hapus pesan leave kustom. |
| `!clearrules` | Admin | Hapus rules grup. |
| `!clearwelcome` | Admin | Hapus pesan welcome kustom. |
| `!groupinfo` (ginfo) | Semua | Metadata grup + status bot. |
| `!groupsetup` (setupgroup) | Admin | Misi setup grup persisten. |
| `!info` | Semua | Profil pengguna (nama, nomor, status/role). |
| `!link` | Admin | Link invite grup. |
| `!membercount` | Semua | Jumlah member dan admin. |
| `!memberinfo` | Semua | Info role member yang di-mention. |
| `!members` (memberlist) | Semua | Daftar member terpaginasi. |
| `!ooc` | Semua | Pesan OOC pada grup IC. |
| `!permissions` | Semua | Permission dasar sesuai role. |
| `!prefix` | Semua | Prefix aktif grup. |
| `!role` | Semua | Role kamu/member. |
| `!rules` | Semua | Rules grup. |
| `!setgroup` | Admin | Atur mode dan konteks grup. |
| `!setleave` | Admin | Set pesan leave. |
| `!setprefix` | Admin | Set prefix grup. |
| `!setrules` | Admin | Set rules grup. |
| `!setwelcome` | Admin | Set pesan welcome. |
| `!tagme` | Semua | Mention diri sendiri di obrolan grup. |
| `!whitelistooc` (oocwhitelist) | Admin | Kelola whitelist OOC. |

## moderation (32)
| Command | Akses | Fungsi |
|---|---|---|
| `!antilink` | Admin | Filter link otomatis on/off (whitelist link grup). |
| `!antispam` | Admin | Filter anti-spam rolling window on/off. |
| `!antitoxic` | Admin | Filter kata-kata kasar on/off. |
| `!appeal` | Member | Banding kasus sendiri. |
| `!ban` | Admin | Kick + blacklist permanen member per grup. |
| `!case` | Admin | Detail satu kasus safety. |
| `!cases` | Admin | Kasus safety terbaru. |
| `!claimcase` (takecase) | Admin | Klaim kasus terbuka. |
| `!clear` | Admin | Hapus N pesan terakhir dari riwayat lokal bot. |
| `!clearwarn` | Admin | Cabut warning per ID. |
| `!del` (delete) | Admin | Hapus pesan yang di-reply. |
| `!demote` | Admin | Cabut status admin member. |
| `!groupmode` | Admin | Ubah setting grup terjaga. |
| `!hidetag` | Admin | Tag mention semua member tanpa daftar teks. |
| `!kick` (tendang) | Admin | Keluarkan member dari grup. |
| `!left` (leave) | Admin | Toggle pesan perpisahan on/off [template]. |
| `!lock` | Admin | Kunci grup (hanya admin yang dapat kirim pesan). |
| `!modaction` (moderate) | Admin | Aksi moderasi terjaga R2. |
| `!modstatus` | Admin | Status aksi moderasi R2. |
| `!mute` | Admin | Mute member dalam durasi (mis. 10m, 1h, 1d). |
| `!promote` | Admin | Promosikan member menjadi admin. |
| `!report` | Semua | Laporkan kasus safety. |
| `!safety` | Semua | Mode safety grup. |
| `!setlimit` | Admin | Atur batas warning sebelum auto-kick. |
| `!setsafety` | Admin | Aktif/nonaktif dry-run safety. |
| `!tagall` | Admin | Sebut semua member grup dengan jeda anti-spam. |
| `!unban` | Admin | Hapus nomor dari blacklist grup. |
| `!unlock` | Admin | Buka kunci grup (semua member dapat chat). |
| `!unmute` | Admin | Cabut status mute sebelum waktu habis. |
| `!unwarn` | Admin | Kurangi hitungan warning member. |
| `!warn` | Admin | Beri warning (auto-kick jika tembus limit). |
| `!warnings` (warns) | Admin | Daftar riwayat warning member. |
| `!welcome` | Admin | Toggle pesan sambutan on/off [template]. |

## owner (3) — hidden
| Command | Fungsi |
|---|---|
| `!bankpolicy` (economypolicy) | Aktif/nonaktif Economy per grup. |
| `!bankreward` | Beri reward Vela. |
| `!banksweep` | Proses overage jatuh tempo. |

## system (2)
| Command | Fungsi |
|---|---|
| `!menu` (m, help) | Menu utama compact interaktif. |
| `!clearcache` (cacheclear) | Bersihkan cache runtime. |

## tools-ai (8)
| Command | Fungsi |
|---|---|
| `!ai` (ally, tanya) | Tanya AI tanpa memori percakapan. |
| `!aidetection` (deteksiai, aidetect) | Deteksi teks AI. |
| `!img2text` (deskripsigambar) | Analisis dan deskripsi gambar berbasis AI. |
| `!suggest` (suggestion, usul) | Saran dari konteks approved. |
| `!summarize` (ringkas) | Ringkas teks panjang. |
| `!text2img` (buatgambar, t2i) | Hasilkan gambar visual dari prompt teks. |
| `!translate` (terjemah, trans) | Terjemahkan teks antar-bahasa. |
| `!tts` (suara) | Konversi teks menjadi pesan suara MP3. |

## tools-media (32)
| Command | Fungsi |
|---|---|
| `!about` | Tentang Allybot. |
| `!botprofile` (bprofile) | Profil publik bot. |
| `!brat` | Stiker brat album-cover style. |
| `!calc` | Kalkulator matematika sederhana. |
| `!commands` (cmds) | Daftar command aktif. |
| `!compress` | Kompres ukuran gambar/video. |
| `!convert` | Konversi satuan. |
| `!date` | Tanggal hari ini. |
| `!diag` [hidden] | Snapshot diagnostik non-sensitif. |
| `!emojimix` (mixemoji) | Gabungkan dua emoji menjadi stiker. |
| `!features` | Ringkasan fitur. |
| `!health` [hidden] | Snapshot health bot. |
| `!ocr` | Ekstrak teks dari gambar. |
| `!owner` | Profil publik Owner. |
| `!ping` | Latency dan uptime. |
| `!privacy` | Ringkasan privasi data. |
| `!qr` | Buat kode QR dari teks/link. |
| `!removebg` (nobg) | Hapus latar belakang gambar. |
| `!searchcmd` | Cari command. |
| `!smeme` | Stiker meme gambar + teks. |
| `!ss` (screenshot) | Ambil tangkapan layar website. |
| `!status` | Status umum runtime. |
| `!sticker` (stiker) | Gambar → sticker WebP. |
| `!stickerwm` (swm) | Stiker dengan watermark custom. |
| `!support` | Panduan langkah bantuan. |
| `!time` | Waktu zona dunia. |
| `!toaudio` (audio, tomp3) | Ekstrak audio dari video/pesan suara. |
| `!togif` (gif) | Video pendek → GIF MP4. |
| `!toimg` (togambar) | Sticker → gambar PNG. |
| `!tourl` | Unggah media ke web publik dan dapatkan link. |
| `!tovideo` (tomp4) | Stiker animasi → video pendek MP4. |
| `!uptime` | Lama bot berjalan. |
| `!version` | Info runtime bot. |
| `!ytmp3` | Unduh audio dari YouTube. |
| `!ytmp4` | Unduh video dari YouTube. |

## tools-search (16)
| Command | Fungsi |
|---|---|
| `!bookmark` | Bookmark pesan ter-quote. |
| `!bookmarks` (tersimpan) | Daftar bookmark. |
| `!cuaca` (weather) | Prakiraan cuaca kota (Open-Meteo). |
| `!find` (cari) | Cari knowledge eksplisit. |
| `!forget` | Hapus sumber milikmu. |
| `!google` (search) | Pencarian ringkas web (DuckDuckGo/Google). |
| `!image` (gambar) | Cari gambar aman (Wikimedia/Unsplash). |
| `!knowledge` (know) | Status knowledge grup. |
| `!knowledgeexport` (knowexport, exportcatatan) | Export knowledge. |
| `!lirik` (lyrics) | Cari lirik lagu lengkap (LRCLIB). |
| `!pin` (pinterest) | Cari gambar Pinterest. |
| `!pixiv` | Cari ilustrasi Pixiv. |
| `!quote` | Kutip pesan tanpa menyimpan. |
| `!setknowledge` (catatan) | Aktif/nonaktif knowledge. |
| `!source` (sourceinfo) | Baca satu sumber per ID. |
| `!wiki` (wikipedia) | Ringkasan artikel Wikipedia ID. |

## your-character (12)
| Command | Fungsi |
|---|---|
| `!cancel` (cancelcharacter) | Batalkan pendaftaran sheet. |
| `!character` (char, yourcharacter) | Lihat Character aktif. |
| `!consent` | Consent scene ter-scoped. |
| `!daftar` (registercharacter, createcharacter) | Mulai pendaftaran Character Sheet. |
| `!deletecharacter` (deletechar, offcharacter) | Nonaktifkan Character. |
| `!guider` | Kontak Guide grup. |
| `!pause` | Pause scene milik aktor. |
| `!retry` (retrycharacter) | Ulangi pendaftaran. |
| `!savecharacter` (savechar) | Simpan sheet dari reply ID Card. |
| `!scene` | Kelola scene roleplay. |
| `!setscene` (adegan) | Aktif/nonaktif Scene per grup. |
| `!timerp` (rpwaktu) | Waktu RP Allyssea. |

---
Total: 147 command terverifikasi dan aktif di `src/framework/plugins/*`.
