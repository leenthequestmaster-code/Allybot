# Katalog Command Allybot — Aktual

Dokumen ini adalah inventaris command yang benar-benar teregistrasi di source code (per 13 September 2026, commit 90144de), dihasilkan dan diverifikasi dari `src/framework/plugins/*`. Bukan lagi katalog ide — setiap entri di sini punya implementasi dan test.

Aturan baca:
- Prefix default `!`, dapat berubah per grup via `!setprefix`.
- Penanda `[hidden]` = command tersembunyi dari menu utama (owner/diagnostik) tapi tetap bisa dipakai.
- Permission kosong = semua member; `group.admin` = butuh admin grup.
- Command fitur stub (Ekonomi, Group Context IC/OOC, Character Guide) hanya hidup penuh setelah backend RPC dipasang — lihat bagian Status Fitur.

## Status Fitur

| Fitur | Flag | Kondisi |
|---|---|---|
| Ekonomi Vela | `ECONOMY_ENABLED` | Backend RPC belum dipasang. Flag on tanpa backend → command menjawab "belum tersedia", hidden dari menu. |
| Group Context IC/OOC | `GROUP_CONTEXT_ENABLED` | Backend RPC belum dipasang. Perilaku sama. Catatan: `!ooc`/`!setgroup` bentrok dengan command scene/moderasi saat mode ini aktif (dipantau `plugin-readiness`). |
| Character Guide | `CHARACTER_GUIDE_ENABLED` | Backend RPC belum dipasang. Perilaku sama. |
| AI generik | `AI_ENABLED` + `AI_API_KEY` (+ `AI_BASE_URL`, `AI_MODEL`) | Siap; default off; provider OpenAI-compatible mana pun. |
| Redis | `REDIS_ENABLED` + `REDIS_URL` | Opsional; fail-soft dengan warning. |
| Diagnostik | `DIAGNOSTICS_ENABLED` | Opsional, default off. |
| Export Codebase | `CODEBASE_EXPORT_ENABLED` | Owner-only, default off. |
| Sentry | `SENTRY_ENABLED` + `SENTRY_DSN` | Opsional, default off. |

## developer (4)
| Command | Akses | Fungsi |
|---|---|---|
| `!dev` (debug) [hidden] | Owner | Diagnostik Developer Mode. |
| `!groupid` (jid) [hidden] | Owner | JID grup untuk allowlist. |
| `!alljid` [hidden] | Owner | Daftar semua JID grup. |
| `!codebase` [hidden] | Owner | Kirim Codebase Intelligence Export tersanitasi. |

## economy (4) — stub
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

## group (22)
| Command | Fungsi |
|---|---|
| `!admins` (adminlist) | Daftar admin dengan mention. |
| `!afk` (away) | Set/lihat status AFK. |
| `!clearleave` | Hapus pesan leave kustom. |
| `!clearrules` | Hapus rules grup. |
| `!clearwelcome` | Hapus pesan welcome kustom. |
| `!groupinfo` (ginfo) | Metadata grup + status bot. |
| `!groupsetup` (setupgroup) [group.admin] | Misi setup grup persisten. |
| `!link` | Link invite grup (admin). |
| `!membercount` | Jumlah member dan admin. |
| `!memberinfo` | Info role member yang di-mention. |
| `!members` (memberlist) | Daftar member terpaginasi. |
| `!ooc` ⚠️ stub | Pesan OOC pada grup IC. |
| `!permissions` | Permission dasar sesuai role. |
| `!prefix` | Prefix aktif grup. |
| `!role` | Role kamu/member. |
| `!rules` | Rules grup. |
| `!setgroup` (groupmode) ⚠️ stub | Atur mode dan konteks grup. |
| `!setleave` | Set pesan leave. |
| `!setprefix` | Set prefix grup. |
| `!setrules` | Set rules grup. |
| `!setwelcome` | Set pesan welcome. |
| `!whitelistooc` (oocwhitelist) ⚠️ stub | Kelola whitelist OOC. |

## moderation (13)
| Command | Fungsi |
|---|---|
| `!appeal` | Banding kasus sendiri. |
| `!case` | Detail satu kasus safety. |
| `!cases` | Kasus safety terbaru. |
| `!claimcase` (takecase) | Klaim kasus terbuka. |
| `!clearwarn` | Cabut warning per id. |
| `!groupmode` | Ubah setting grup terjaga. |
| `!modaction` (moderate) | Aksi moderasi terjaga. |
| `!modstatus` | Status aksi moderasi. |
| `!report` | Laporkan kasus safety. |
| `!safety` | Mode safety grup. |
| `!setsafety` | Aktif/nonaktif dry-run safety. |
| `!warn` | Warning teraudit. |
| `!warnings` (warns) | Daftar warning terbaru. |

## owner (3) — hidden, stub
| Command | Fungsi |
|---|---|
| `!bankpolicy` (economypolicy) | Aktif/nonaktif Economy per grup. |
| `!bankreward` | Beri reward Vela. |
| `!banksweep` | Proses overage jatuh tempo. |

## system (2)
| Command | Fungsi |
|---|---|
| `!menu` (m, help) | Menu utama (hidden dari list, tetap dipakai). |
| `!clearcache` (cacheclear) | Bersihkan cache runtime. |

## tools-ai (5)
| Command | Fungsi |
|---|---|
| `!ai` (ally, tanya) | Tanya AI tanpa memori percakapan. Butuh fitur AI aktif. |
| `!aidetection` (deteksiai, aidetect) | Deteksi teks AI. |
| `!suggest` (suggestion, usul) | Saran dari konteks approved. |
| `!summarize` (ringkas) | Ringkas teks. |
| `!translate` (terjemah, trans) | Terjemahkan teks. |

## tools-media (22)
| Command | Fungsi |
|---|---|
| `!about` | Tentang Allybot. |
| `!botprofile` (bprofile) | Profil publik bot. |
| `!calc` | Kalkulator sederhana. |
| `!commands` (cmds) | Daftar command aktif. |
| `!convert` | Konversi satuan. |
| `!date` | Tanggal hari ini. |
| `!diag` [hidden] | Snapshot diagnostik non-sensitif. |
| `!features` | Ringkasan fitur. |
| `!health` [hidden] | Snapshot health. |
| `!owner` | Profil publik Owner. |
| `!ping` | Latency dan uptime. |
| `!privacy` | Ringkasan privasi data. |
| `!searchcmd` | Cari command. |
| `!status` | Status umum. |
| `!sticker` (stiker) | Gambar → sticker. |
| `!support` | Langkah bantuan. |
| `!time` | Waktu zona tertentu. |
| `!toaudio` (audio) | Ekstrak audio. |
| `!togif` (gif) | Video pendek → GIF. |
| `!toimg` (togambar) | Sticker → gambar. |
| `!uptime` | Lama bot berjalan. |
| `!version` | Info runtime. |

## tools-search (11)
| Command | Fungsi |
|---|---|
| `!bookmark` | Bookmark pesan ter-quote. |
| `!bookmarks` (tersimpan) | Daftar bookmark. |
| `!find` (cari) | Cari knowledge eksplisit. |
| `!forget` | Hapus sumber milikmu. |
| `!knowledge` (know) | Status knowledge grup. |
| `!knowledgeexport` (knowexport, exportcatatan) | Export knowledge. |
| `!pin` (pinterest) | Cari gambar Pinterest. |
| `!pixiv` | Cari ilustrasi Pixiv. |
| `!quote` | Kutip pesan tanpa menyimpan. |
| `!setknowledge` (catatan) | Aktif/nonaktif knowledge. |
| `!source` (sourceinfo) | Baca satu sumber per id. |

## tools-sticker (2)
| Command | Fungsi |
|---|---|
| `!brat` | Stiker brat style. |
| `!smeme` | Stiker meme dari gambar + teks. |

## your-character (12) — sebagian stub
| Command | Fungsi |
|---|---|
| `!cancel` (cancelcharacter) ⚠️ stub | Batalkan pendaftaran sheet. |
| `!character` (char, yourcharacter) ⚠️ stub | Lihat Character aktif. |
| `!consent` | Consent scene ter-scoped. |
| `!daftar` (registercharacter, createcharacter) ⚠️ stub | Mulai pendaftaran Character Sheet. |
| `!deletecharacter` (deletechar, offcharacter) ⚠️ stub | Nonaktifkan Character. |
| `!guider` ⚠️ stub | Kontak Guide grup. |
| `!pause` | Pause scene milik aktor. |
| `!retry` (retrycharacter) ⚠️ stub | Ulangi pendaftaran. |
| `!savecharacter` (savechar) ⚠️ stub | Simpan sheet dari reply ID Card. |
| `!scene` | Kelola scene roleplay. |
| `!setscene` (adegan) | Aktif/nonaktif Scene per grup. |
| `!timerp` (rpwaktu) | Waktu RP Allyssea. |

---
Total: 114 command dari 24 plugin. Sumber kebenaran: `src/framework/plugins/` dan `plugin-readiness.test.js`. Katalog ini didahului oleh versi lama berisi ide fitur — versi ide itu sudah tidak dipakai; dokumen kini mencerminkan implementasi aktual.
