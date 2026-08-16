# Katalog Command Allybot

Dokumen ini berisi ide command yang dapat dirancang untuk Allybot. Daftar ini adalah katalog kemungkinan fitur, bukan kontrak implementasi final. Setiap command tetap perlu memiliki validasi input, permission yang jelas, cooldown jika diperlukan, dan isolasi error agar kegagalan satu plugin tidak menjatuhkan bot.

Prefix contoh yang digunakan adalah `!`. Prefix aktual tetap mengikuti konfigurasi Allybot.

## Penanda akses

| Penanda | Arti |
|---|---|
| Umum | Dapat digunakan member biasa |
| Grup | Hanya tersedia di grup |
| Reply | Memerlukan reply ke pesan tertentu |
| Admin | Memerlukan status admin grup |
| Owner | Hanya owner bot atau pengelola utama |
| Private | Hanya tersedia di private chat |
| Media | Memerlukan pesan media atau proses media |

## 1. Bantuan, status, dan identitas bot

| Command | Akses | Fungsi |
|---|---|---|
| `!menu` | Umum | Menampilkan menu utama Allybot. |
| `!help` | Umum | Alias atau halaman bantuan command. |
| `!back` | Umum | Kembali dari submenu ke menu utama. |
| `!commands` | Umum | Menampilkan daftar command yang tersedia. |
| `!searchcmd <kata>` | Umum | Mencari command berdasarkan nama atau deskripsi. |
| `!ping` | Umum | Menguji respons, latency, uptime, dan identitas visual Allybot. |
| `!health` | Umum | Menampilkan status ringkas framework, service, dan koneksi. |
| `!status` | Umum | Menampilkan status operasional bot secara umum. |
| `!uptime` | Umum | Menampilkan lama proses Allybot berjalan. |
| `!latency` | Umum | Mengukur waktu respons bot. |
| `!about` | Umum | Menampilkan informasi Allybot, versi, dan komunitas. |
| `!version` | Umum | Menampilkan versi Allybot dan versi komponen non-sensitif. |
| `!features` | Umum | Menampilkan fitur atau plugin yang sedang aktif. |
| `!privacy` | Umum | Menjelaskan data yang disimpan bot. |
| `!terms` | Umum | Menampilkan aturan penggunaan bot. |
| `!report <pesan>` | Umum | Mengirim laporan error atau masalah ke owner. |
| `!feedback <pesan>` | Umum | Mengirim saran fitur ke owner. |
| `!support` | Umum | Menampilkan cara meminta bantuan. |

## 2. Identitas pengguna dan metadata pesan

| Command | Akses | Fungsi |
|---|---|---|
| `!id` | Umum | Menampilkan identitas pengirim dalam format aman. |
| `!whois` | Umum | Menampilkan informasi dasar pengirim command. |
| `!whois @user` | Umum | Menampilkan informasi non-sensitif tentang member yang disebut. |
| `!jid` | Owner | Diagnosis JID untuk debugging terbatas dan tidak menampilkan data auth. |
| `!mention` | Umum | Menghasilkan mention clickable untuk pengguna yang disebut. |
| `!contact` | Umum | Menampilkan atau mengirim contact card jika data tersedia. |
| `!quote` | Reply | Menyimpan atau menampilkan metadata pesan yang direply. |
| `!messageinfo` | Reply | Menampilkan waktu, pengirim, chat, dan tipe pesan secara aman. |
| `!chatid` | Grup | Menampilkan ID chat untuk keperluan konfigurasi. |
| `!lastseen` | Umum | Menampilkan informasi last seen hanya jika tersedia dan diizinkan WhatsApp. |
| `!profile` | Umum | Menampilkan profil bot atau profil roleplay pengguna. |
| `!setbio <teks>` | Umum | Mengatur bio profil roleplay internal, bukan langsung mengubah akun WhatsApp. |
| `!setnickname <nama>` | Umum | Menyimpan nama panggilan internal pada profil bot atau roleplay. |

## 3. AFK dan kehadiran

| Command | Akses | Fungsi |
|---|---|---|
| `!afk [alasan]` | Umum | Mengaktifkan AFK dengan alasan opsional. Pesan apa pun dari pengguna akan menonaktifkan AFK otomatis. |
| `!afkstatus` | Umum | Menampilkan status AFK pengguna sendiri atau pengguna yang disebut. |
| `!afklist` | Grup | Menampilkan member grup yang sedang AFK. |
| `!afktop` | Grup | Menampilkan leaderboard durasi atau jumlah sesi AFK. |
| `!afklog` | Umum | Menampilkan ringkasan mention yang terjadi selama pengguna AFK. |
| `!afkclearlog` | Umum | Menghapus log mention pribadi milik pengguna. |
| `!afkstats` | Umum | Menampilkan statistik AFK pribadi. |
| `!afkprivacy` | Umum | Mengatur apakah detail pesan mention boleh diteruskan ke PC pengguna AFK. |

Catatan: desain Allybot tidak menggunakan command `!afk off`. AFK dinonaktifkan otomatis saat pengguna mengirim pesan kembali.

## 4. Informasi grup

| Command | Akses | Fungsi |
|---|---|---|
| `!groupinfo` | Grup | Menampilkan nama, ID, jumlah member, jumlah admin, dan status bot. |
| `!groupid` | Grup | Menampilkan ID unik grup. |
| `!groupname` | Grup | Menampilkan nama grup saat ini. |
| `!groupowner` | Grup | Menampilkan creator atau owner grup jika metadata tersedia. |
| `!admins` | Grup | Menampilkan daftar admin dengan mention clickable. |
| `!members` | Grup | Menampilkan daftar member, dengan pagination jika jumlah besar. |
| `!membercount` | Grup | Menampilkan jumlah member dan admin. |
| `!memberinfo @user` | Grup | Menampilkan status member, admin, atau creator. |
| `!groupcreated` | Grup | Menampilkan waktu pembuatan jika tersedia. |
| `!grouplink` | Grup | Alias untuk `!link`. |
| `!link` | Grup | Mengambil invite link jika bot memiliki akses. |
| `!groupavatar` | Grup | Mengirim avatar grup jika tersedia. |
| `!groupdesc` | Grup | Menampilkan deskripsi grup. |
| `!online` | Grup | Menampilkan status online yang tersedia, tanpa menjamin seluruh presence dapat dibaca. |
| `!groupstats` | Grup | Menampilkan statistik pesan atau aktivitas yang memang disimpan bot. |

## 5. Aturan dan konfigurasi grup

| Command | Akses | Fungsi |
|---|---|---|
| `!rules` | Grup | Menampilkan aturan grup. |
| `!setrules <teks>` | Admin | Menyimpan atau mengganti aturan grup. |
| `!clearrules` | Admin | Menghapus aturan grup dengan konfirmasi. |
| `!ruleshistory` | Admin | Menampilkan riwayat perubahan aturan. |
| `!welcome` | Grup | Menampilkan konfigurasi welcome saat ini. |
| `!setwelcome <teks>` | Admin | Mengatur template welcome grup. |
| `!clearwelcome` | Admin | Mengembalikan welcome ke konfigurasi default. |
| `!leave` | Grup | Menampilkan konfigurasi pesan leave. |
| `!setleave <teks>` | Admin | Mengatur template pesan leave. |
| `!clearleave` | Admin | Menghapus template leave custom. |
| `!setprefix <prefix>` | Admin | Mengatur prefix khusus grup jika sistem sudah mendukung. |
| `!prefix` | Grup | Menampilkan prefix yang sedang aktif. |
| `!groupsettings` | Admin | Menampilkan konfigurasi grup yang tidak sensitif. |
| `!setlanguage <kode>` | Admin | Mengatur bahasa output grup. |
| `!settimezone <zona>` | Admin | Mengatur timezone untuk waktu, reminder, dan log grup. |
| `!setlogchannel` | Admin | Menentukan chat atau tujuan log jika arsitektur mendukung. |
| `!resetsettings` | Admin | Mengembalikan konfigurasi grup ke default dengan konfirmasi. |

## 6. Permission dan role policy

| Command | Akses | Fungsi |
|---|---|---|
| `!role` | Umum | Menampilkan role pengirim. |
| `!role @user` | Grup | Menampilkan role member tertentu. |
| `!roles` | Grup | Menampilkan daftar role yang tersedia. |
| `!permissions` | Umum | Menampilkan permission yang dimiliki pengirim. |
| `!setowner @user` | Owner | Menetapkan owner bot secara aman. |
| `!owners` | Owner | Menampilkan daftar owner bot. |
| `!addowner @user` | Owner | Menambahkan owner bot. |
| `!removeowner @user` | Owner | Menghapus owner bot. |
| `!setmod @user` | Owner | Menambahkan pengelola internal bot. |
| `!removemod @user` | Owner | Menghapus pengelola internal bot. |
| `!allow <command> <role>` | Owner/Admin | Menentukan role minimal untuk command tertentu. |
| `!deny <command> <role>` | Owner/Admin | Mencabut akses role terhadap command tertentu. |
| `!policy` | Admin | Menampilkan policy grup secara ringkas. |
| `!policy reset` | Admin | Mengembalikan policy grup ke default. |
| `!whitelist @user` | Admin | Mengecualikan pengguna dari aturan tertentu. |
| `!unwhitelist @user` | Admin | Menghapus pengecualian pengguna. |
| `!banned` | Admin | Menampilkan daftar pengguna yang diblokir oleh policy bot. |
| `!checkperm <command>` | Umum | Memeriksa apakah pengirim memiliki akses ke command tertentu. |

Command owner dan perubahan permission harus diaudit dengan identitas, waktu, grup, dan perubahan yang dilakukan.

## 7. Moderasi member grup

| Command | Akses | Fungsi |
|---|---|---|
| `!tagall [pesan]` | Admin | Mention seluruh member dengan pesan. |
| `!hidetag [pesan]` | Admin | Mention semua member tanpa menampilkan daftar mention panjang. |
| `!mentionall [pesan]` | Admin | Alias untuk hidetag atau tagall sesuai kebijakan. |
| `!promote @user` | Admin | Mempromosikan member menjadi admin jika bot memiliki akses. |
| `!demote @user` | Admin | Menurunkan admin menjadi member jika bot memiliki akses. |
| `!add <nomor>` | Admin | Menambahkan nomor ke grup jika diizinkan WhatsApp. |
| `!kick @user` | Admin | Mengeluarkan member jika bot memiliki akses. |
| `!remove @user` | Admin | Alias untuk kick. |
| `!approve @user` | Admin | Menyetujui permintaan join jika tersedia. |
| `!reject @user` | Admin | Menolak permintaan join jika tersedia. |
| `!pending` | Admin | Menampilkan permintaan join yang menunggu. |
| `!warn @user [alasan]` | Admin | Memberi peringatan tercatat. |
| `!warnings @user` | Admin | Menampilkan jumlah dan riwayat peringatan. |
| `!unwarn @user` | Admin | Mengurangi atau menghapus satu peringatan. |
| `!clearwarnings @user` | Admin | Menghapus seluruh peringatan dengan konfirmasi. |
| `!mute @user <durasi>` | Admin | Menandai user sebagai muted di policy bot; efektivitasnya bergantung pada kemampuan moderasi grup. |
| `!unmute @user` | Admin | Menghapus status muted. |
| `!modlog` | Admin | Menampilkan riwayat tindakan moderasi. |
| `!case <id>` | Admin | Membuka detail kasus moderasi. |
| `!undo <case-id>` | Admin | Membatalkan tindakan yang masih dapat dibatalkan. |

## 8. Pengaturan grup WhatsApp

| Command | Akses | Fungsi |
|---|---|---|
| `!open` | Admin | Membuka grup agar semua member dapat mengirim pesan, jika bot memiliki akses. |
| `!close` | Admin | Membatasi pengiriman pesan kepada admin, jika bot memiliki akses. |
| `!setsubject <nama>` | Admin | Mengubah nama grup jika bot memiliki akses. |
| `!setdescription <teks>` | Admin | Mengubah deskripsi grup jika bot memiliki akses. |
| `!revokeinvite` | Admin | Mengganti atau mencabut invite link. |
| `!setannounce on` | Admin | Mengaktifkan mode pengumuman. |
| `!setannounce off` | Admin | Menonaktifkan mode pengumuman. |
| `!seteditinfo admins` | Admin | Membatasi perubahan info grup kepada admin. |
| `!seteditinfo all` | Admin | Mengizinkan perubahan info grup kepada semua member. |
| `!setaddmode admins` | Admin | Membatasi penambahan member kepada admin. |
| `!setaddmode all` | Admin | Mengizinkan penambahan member sesuai pengaturan grup. |
| `!approval on` | Admin | Mengaktifkan persetujuan member baru jika tersedia. |
| `!approval off` | Admin | Menonaktifkan persetujuan member baru jika tersedia. |

Command pada kategori ini harus memeriksa status bot sebagai admin dan menangani kegagalan permission dari WhatsApp secara aman.

## 9. Pesan dan moderasi konten

| Command | Akses | Fungsi |
|---|---|---|
| `!delete` | Admin, Reply | Menghapus pesan yang direply jika bot memiliki izin. |
| `!pin` | Admin, Reply | Menyematkan pesan jika fitur tersedia. |
| `!unpin` | Admin, Reply | Melepas sematan pesan. |
| `!quote` | Reply | Mengutip ulang metadata atau isi pesan secara terkontrol. |
| `!forward` | Reply | Meneruskan pesan ke tujuan yang ditentukan dengan permission ketat. |
| `!save` | Reply | Menyimpan media atau teks ke storage bot jika fitur tersedia. |
| `!reportmsg` | Reply | Melaporkan pesan tertentu ke admin atau log moderasi. |
| `!filter add <kata>` | Admin | Menambahkan kata atau pola yang diawasi. |
| `!filter remove <kata>` | Admin | Menghapus pola filter. |
| `!filters` | Admin | Menampilkan daftar filter tanpa membocorkan pola sensitif jika perlu. |
| `!antispam on` | Admin | Mengaktifkan deteksi spam grup. |
| `!antispam off` | Admin | Menonaktifkan deteksi spam grup. |
| `!antiflood on` | Admin | Mengaktifkan pembatasan pesan beruntun. |
| `!antiflood off` | Admin | Menonaktifkan pembatasan flood. |
| `!antilink on` | Admin | Mendeteksi link tertentu sesuai policy. |
| `!antilink off` | Admin | Menonaktifkan deteksi link. |
| `!antiinvite on` | Admin | Mendeteksi invite grup lain. |
| `!antiinvite off` | Admin | Menonaktifkan deteksi invite. |
| `!antidelete on` | Admin | Mencatat metadata pesan yang dihapus jika legal dan sesuai privasi. |
| `!antidelete off` | Admin | Menonaktifkan pencatatan tersebut. |

## 10. Media dan konversi

| Command | Akses | Fungsi |
|---|---|---|
| `!sticker` | Media | Mengubah gambar atau video pendek menjadi sticker. |
| `!s` | Media | Alias singkat untuk sticker. |
| `!toimg` | Media | Mengubah sticker tertentu menjadi gambar. |
| `!tovideo` | Media | Mengubah media yang kompatibel menjadi video. |
| `!tourl` | Media | Mengunggah media ke storage dan menghasilkan URL jika layanan tersedia. |
| `!resize <ukuran>` | Media | Mengubah ukuran gambar. |
| `!crop <rasio>` | Media | Memotong gambar sesuai rasio. |
| `!compress` | Media | Mengurangi ukuran media. |
| `!convert <format>` | Media | Mengubah format media. |
| `!caption <teks>` | Media | Mengganti caption media yang direply atau mengirim ulang dengan caption. |
| `!watermark <teks>` | Media | Menambahkan watermark pada media jika pipeline tersedia. |
| `!removebg` | Media | Menghapus latar belakang melalui layanan image processing. |
| `!ocr` | Media | Membaca teks dari gambar. |
| `!qr` | Umum | Membuat QR code dari teks atau URL. |
| `!readqr` | Media | Membaca QR code dari gambar. |
| `!avatar` | Media | Membuat avatar atau gambar profil melalui pipeline yang diizinkan. |

## 11. Audio dan suara

| Command | Akses | Fungsi |
|---|---|---|
| `!toaudio` | Media | Mengubah video menjadi audio. |
| `!tovn` | Media | Mengubah audio menjadi voice note. |
| `!volume <persen>` | Media | Mengatur volume media. |
| `!trim <durasi>` | Media | Memotong audio atau video. |
| `!transcribe` | Media | Mentranskripsikan audio atau voice note menjadi teks. |
| `!translateaudio <bahasa>` | Media | Mentranskripsikan lalu menerjemahkan audio. |
| `!tts <teks>` | Umum | Mengubah teks menjadi audio. |
| `!sound <kata kunci>` | Umum | Mencari dan mengirim sound dari sumber yang diizinkan. |
| `!voice <teks>` | Umum | Alias untuk text-to-speech dengan preset suara. |

## 12. Download dan pencarian eksternal

| Command | Akses | Fungsi |
|---|---|---|
| `!search <query>` | Umum | Mencari informasi melalui provider eksternal. |
| `!image <query>` | Umum | Mencari gambar. |
| `!video <query>` | Umum | Mencari video. |
| `!yt <URL/query>` | Umum | Mengambil metadata atau media dari YouTube sesuai batasan layanan. |
| `!play <query>` | Umum | Mencari audio atau video berdasarkan query. |
| `!tiktok <URL>` | Umum | Mengambil informasi atau media dari TikTok jika provider tersedia. |
| `!instagram <URL>` | Umum | Mengambil informasi atau media dari Instagram jika provider tersedia. |
| `!pinterest <URL>` | Umum | Mengambil gambar dari Pinterest jika provider tersedia. |
| `!wiki <query>` | Umum | Mencari ringkasan Wikipedia. |
| `!news <query>` | Umum | Mencari berita. |
| `!weather <kota>` | Umum | Menampilkan cuaca berdasarkan API cuaca. |
| `!map <lokasi>` | Umum | Menghasilkan tautan peta untuk lokasi. |
| `!define <kata>` | Umum | Mencari definisi kata. |
| `!translate <bahasa> <teks>` | Umum | Menerjemahkan teks. |

Command eksternal perlu rate limit, cache, timeout, dan perlindungan terhadap URL berbahaya. Integrasi juga harus mematuhi aturan layanan sumber.

## 13. Utility umum

| Command | Akses | Fungsi |
|---|---|---|
| `!calc <ekspresi>` | Umum | Menghitung ekspresi matematika yang divalidasi tanpa menjalankan kode arbitrer. |
| `!convert <nilai> <satuan>` | Umum | Konversi satuan panjang, berat, suhu, dan waktu. |
| `!time <zona/kota>` | Umum | Menampilkan waktu di zona tertentu. |
| `!date` | Umum | Menampilkan tanggal dan hari. |
| `!countdown <waktu>` | Umum | Menghitung mundur menuju waktu tertentu. |
| `!random <min> <max>` | Umum | Menghasilkan angka acak. |
| `!choose <opsi1> \| <opsi2>` | Umum | Memilih satu opsi acak. |
| `!flip` | Umum | Melempar koin. |
| `!roll [dadu]` | Umum | Melempar dadu, misalnya `!roll 2d6`. |
| `!stopwatch` | Umum | Memulai atau membaca stopwatch pribadi. |
| `!remind <durasi> <teks>` | Umum | Membuat pengingat. |
| `!reminders` | Umum | Menampilkan pengingat aktif milik pengguna. |
| `!cancelremind <id>` | Umum | Membatalkan pengingat milik pengguna. |
| `!todo add <teks>` | Umum | Menambahkan tugas pribadi. |
| `!todo list` | Umum | Menampilkan daftar tugas pribadi. |
| `!todo done <id>` | Umum | Menandai tugas selesai. |
| `!todo delete <id>` | Umum | Menghapus tugas pribadi. |
| `!note add <judul> | <isi>` | Grup/Admin | Menyimpan catatan grup. |
| `!note list` | Grup | Menampilkan daftar catatan grup. |
| `!note get <judul>` | Grup | Membaca catatan tertentu. |
| `!note delete <judul>` | Admin | Menghapus catatan grup. |

## 14. AI dan pemrosesan bahasa

| Command | Akses | Fungsi |
|---|---|---|
| `!ask <pertanyaan>` | Umum | Menjawab pertanyaan dengan model bahasa. |
| `!summarize` | Reply | Merangkum pesan atau teks yang direply. |
| `!rewrite <gaya>` | Reply | Menulis ulang teks dengan gaya tertentu. |
| `!correct` | Reply | Memperbaiki ejaan dan tata bahasa. |
| `!translateai <bahasa>` | Reply | Menerjemahkan pesan yang direply. |
| `!explain` | Reply | Menjelaskan isi pesan yang direply. |
| `!extract` | Reply | Mengekstrak poin penting, tanggal, nama, atau tugas. |
| `!classify` | Reply | Mengklasifikasikan teks berdasarkan kategori yang tersedia. |
| `!summarizechat <jumlah>` | Admin | Merangkum sejumlah pesan yang memang tersimpan dan diizinkan. |
| `!ocr` | Media | Mengekstrak teks dari gambar. |
| `!describe` | Media | Mendeskripsikan gambar. |
| `!captionai` | Media | Membuat caption untuk gambar. |
| `!prompt <teks>` | Umum | Membuat prompt terstruktur untuk kebutuhan tertentu. |
| `!roleplay <instruksi>` | Umum | Memulai respons roleplay dengan preset aman. |
| `!aistatus` | Umum | Menampilkan status provider AI tanpa membocorkan API key. |

Command AI perlu batas panjang input, cooldown, pemisahan data sensitif, dan informasi bahwa output dapat keliru.

## 15. Reminder, kalender, dan produktivitas grup

| Command | Akses | Fungsi |
|---|---|---|
| `!event add <waktu> <judul>` | Grup | Membuat agenda grup. |
| `!event list` | Grup | Menampilkan agenda mendatang. |
| `!event get <id>` | Grup | Menampilkan detail agenda. |
| `!event cancel <id>` | Pembuat/Admin | Membatalkan agenda. |
| `!poll <pertanyaan> | <opsi>` | Grup | Membuat polling. |
| `!poll close <id>` | Pembuat/Admin | Menutup polling. |
| `!poll result <id>` | Grup | Menampilkan hasil polling. |
| `!attendance open` | Admin | Membuka presensi grup. |
| `!attendance checkin` | Grup | Mencatat kehadiran. |
| `!attendance close` | Admin | Menutup presensi. |
| `!attendance report` | Admin | Menampilkan rekap presensi. |
| `!task add <teks>` | Admin | Menambahkan tugas grup. |
| `!task list` | Grup | Menampilkan tugas grup. |
| `!task assign <id> @user` | Admin | Menugaskan tugas kepada member. |
| `!task done <id>` | Member | Menandai tugas selesai. |

## 16. Roleplay sosial

| Command | Akses | Fungsi |
|---|---|---|
| `!character create <nama>` | Umum | Membuat karakter roleplay. |
| `!character view` | Umum | Melihat karakter aktif. |
| `!character edit <bagian>` | Umum | Mengubah bagian karakter. |
| `!character list` | Grup | Menampilkan karakter yang terdaftar di grup. |
| `!character delete` | Umum | Menghapus karakter dengan konfirmasi. |
| `!lore add <judul> | <isi>` | Admin/Owner | Menambahkan lore grup. |
| `!lore list` | Grup | Menampilkan daftar lore. |
| `!lore get <judul>` | Grup | Membaca lore tertentu. |
| `!lore delete <judul>` | Admin/Owner | Menghapus lore. |
| `!scene start <judul>` | Grup | Membuka scene roleplay. |
| `!scene join` | Grup | Bergabung dalam scene aktif. |
| `!scene leave` | Grup | Keluar dari scene. |
| `!scene status` | Grup | Menampilkan scene aktif dan peserta. |
| `!scene close` | Pembuat/Admin | Menutup scene. |
| `!mood <mood>` | Umum | Menyimpan mood roleplay pengguna. |
| `!relationship @user <status>` | Umum | Menyimpan status hubungan roleplay dengan persetujuan desain yang jelas. |
| `!quote add <teks>` | Umum | Menyimpan quote karakter. |
| `!quotes` | Grup | Menampilkan quote roleplay. |
| `!emote <aksi>` | Umum | Menghasilkan respons aksi roleplay. |
| `!dicecheck <atribut> <kesulitan>` | Grup | Melakukan uji dadu berbasis atribut. |

## 17. RPG dan ekonomi virtual

| Command | Akses | Fungsi |
|---|---|---|
| `!register` | Umum | Mendaftarkan pemain RPG. |
| `!unregister` | Umum | Menghapus karakter RPG dengan konfirmasi. |
| `!stats` | Umum | Menampilkan statistik karakter. |
| `!level` | Umum | Menampilkan level, XP, dan progres berikutnya. |
| `!class` | Umum | Melihat atau memilih class karakter. |
| `!race` | Umum | Melihat atau memilih ras karakter. |
| `!skill` | Umum | Menampilkan skill karakter. |
| `!skillup <skill>` | Umum | Menaikkan skill jika memiliki poin. |
| `!inventory` | Umum | Menampilkan inventory. |
| `!item <nama>` | Umum | Menampilkan detail item. |
| `!equip <item>` | Umum | Memasang equipment. |
| `!unequip <item>` | Umum | Melepas equipment. |
| `!use <item>` | Umum | Menggunakan item. |
| `!shop` | Umum | Menampilkan toko. |
| `!buy <item>` | Umum | Membeli item. |
| `!sell <item>` | Umum | Menjual item. |
| `!daily` | Umum | Mengambil hadiah harian. |
| `!claim` | Umum | Mengambil hadiah atau reward yang tersedia. |
| `!quest` | Umum | Menampilkan quest aktif. |
| `!quests` | Umum | Menampilkan daftar quest. |
| `!quest accept <id>` | Umum | Menerima quest. |
| `!quest abandon <id>` | Umum | Membatalkan quest. |
| `!hunt` | Umum | Menjalankan aktivitas berburu. |
| `!explore` | Umum | Menjelajah lokasi virtual. |
| `!travel <lokasi>` | Umum | Berpindah lokasi. |
| `!battle @user` | Grup | Mengajak duel. |
| `!battle accept` | Grup | Menerima duel. |
| `!battle decline` | Grup | Menolak duel. |
| `!party create` | Grup | Membuat party. |
| `!party invite @user` | Grup | Mengundang member ke party. |
| `!party leave` | Grup | Keluar dari party. |
| `!guild create <nama>` | Grup | Membuat guild. |
| `!guild join <nama>` | Grup | Bergabung ke guild. |
| `!guild leave` | Grup | Keluar dari guild. |
| `!guild info` | Grup | Melihat informasi guild. |
| `!craft <resep>` | Umum | Membuat item dari bahan. |
| `!recipe list` | Umum | Menampilkan resep. |
| `!bank` | Umum | Menampilkan saldo bank virtual. |
| `!balance` | Umum | Menampilkan saldo ekonomi virtual. |
| `!pay @user <jumlah>` | Umum | Mengirim mata uang virtual. |
| `!trade @user <item>` | Umum | Membuka pertukaran item. |
| `!market` | Umum | Menampilkan pasar virtual. |
| `!leaderboard` | Grup | Menampilkan peringkat level, XP, kekayaan, atau statistik lain. |
| `!prestige` | Umum | Menjalankan reset progres untuk bonus jangka panjang. |
| `!rpghelp` | Umum | Menampilkan bantuan sistem RPG. |

Ekonomi virtual harus menggunakan aturan anti-abuse, audit transaksi, batas transfer, dan mekanisme rollback. Jangan mencampur mata uang virtual dengan uang nyata tanpa desain hukum dan keamanan yang berbeda.

## 18. Fun dan permainan ringan

| Command | Akses | Fungsi |
|---|---|---|
| `!8ball <pertanyaan>` | Umum | Menjawab pertanyaan secara acak. |
| `!truth` | Umum | Memberikan pertanyaan truth. |
| `!dare` | Umum | Memberikan tantangan ringan. |
| `!truthordare` | Umum | Memilih truth atau dare. |
| `!ship @user @user` | Umum | Menghasilkan skor kecocokan untuk hiburan. |
| `!rate <teks>` | Umum | Memberikan rating hiburan. |
| `!roast <teks>` | Umum | Membuat roast ringan dengan batasan keselamatan. |
| `!compliment @user` | Umum | Memberikan pujian acak. |
| `!joke` | Umum | Mengirim lelucon. |
| `!fact` | Umum | Mengirim fakta singkat. |
| `!riddle` | Umum | Mengirim teka-teki. |
| `!answer <jawaban>` | Umum | Menjawab teka-teki aktif. |
| `!trivia` | Umum | Memulai kuis trivia. |
| `!quiz answer <jawaban>` | Umum | Menjawab kuis. |
| `!wordchain` | Grup | Memulai permainan sambung kata. |
| `!hangman` | Grup | Memulai permainan tebak kata. |
| `!tictactoe @user` | Grup | Memulai permainan tic-tac-toe. |
| `!guessnumber` | Grup | Memulai tebak angka. |

## 19. Broadcast dan komunikasi komunitas

| Command | Akses | Fungsi |
|---|---|---|
| `!announce <pesan>` | Admin | Mengirim pengumuman ke grup. |
| `!broadcast <pesan>` | Owner | Mengirim pesan ke daftar tujuan yang telah diizinkan. |
| `!broadcastpreview` | Owner | Melihat preview sebelum broadcast. |
| `!broadcastcancel` | Owner | Membatalkan broadcast yang belum berjalan. |
| `!scheduleannounce <waktu> <pesan>` | Admin/Owner | Menjadwalkan pengumuman. |
| `!scheduled` | Admin/Owner | Menampilkan pengumuman terjadwal. |
| `!cancelannounce <id>` | Admin/Owner | Membatalkan pengumuman terjadwal. |
| `!subscribe <topik>` | Umum | Berlangganan notifikasi topik tertentu. |
| `!unsubscribe <topik>` | Umum | Berhenti dari notifikasi topik tertentu. |
| `!topics` | Umum | Menampilkan topik notifikasi yang tersedia. |

Broadcast harus memiliki whitelist tujuan, preview, cooldown, pencatatan audit, dan proteksi dari pengiriman massal yang tidak disengaja.

## 20. Backup, diagnosis, dan administrasi bot

| Command | Akses | Fungsi |
|---|---|---|
| `!botstatus` | Owner | Menampilkan status internal non-sensitif. |
| `!metrics` | Owner | Menampilkan CPU, memory, event count, dan error count. |
| `!plugins` | Owner | Menampilkan plugin aktif dan statusnya. |
| `!plugin <nama>` | Owner | Menampilkan informasi plugin tertentu. |
| `!reload` | Owner | Memuat ulang konfigurasi atau plugin yang aman untuk direload. |
| `!maintenance on` | Owner | Mengaktifkan maintenance mode melalui command terproteksi. |
| `!maintenance off` | Owner | Menonaktifkan maintenance mode jika mekanisme runtime mendukung. |
| `!broadcaststatus` | Owner | Menampilkan status job broadcast. |
| `!dbstatus` | Owner | Menampilkan status database tanpa isi data sensitif. |
| `!dbcheck` | Owner | Menjalankan integrity check database. |
| `!backupstatus` | Owner | Menampilkan status backup. |
| `!backup create` | Owner | Membuat backup yang aman. |
| `!backup list` | Owner | Menampilkan daftar backup. |
| `!backup verify <id>` | Owner | Memverifikasi integritas backup. |
| `!cache status` | Owner | Menampilkan status cache. |
| `!cache clear` | Owner | Menghapus cache yang aman dihapus. |
| `!ratelimit` | Owner | Menampilkan statistik rate limit. |
| `!errors` | Owner | Menampilkan ringkasan error tanpa membocorkan message body atau auth. |
| `!audit <id>` | Owner | Membuka satu entri audit. |
| `!sessionstatus` | Owner | Menampilkan status auth secara minimal, tanpa QR, token, atau auth state. |
| `!shutdown` | Owner | Meminta graceful shutdown dengan konfirmasi berlapis. |

Command administrasi tidak boleh menampilkan QR, pairing code, auth key, cookie, token, isi database mentah, atau message body secara default. Command berisiko seperti `eval`, `exec`, atau arbitrary SQL sebaiknya tidak pernah tersedia melalui chat.

## 21. Command alias yang dapat disediakan

| Alias | Command utama |
|---|---|
| `!h` | `!help` |
| `!p` | `!ping` |
| `!s` | `!sticker` |
| `!ginfo` | `!groupinfo` |
| `!gid` | `!groupid` |
| `!admins` | `!adminlist` |
| `!members` | `!memberlist` |
| `!rules` | `!grouprules` |
| `!afk` | `!afkstatus` atau aktivasi AFK, sesuai parser |
| `!ai` | `!ask` |
| `!tr` | `!translate` |
| `!calc` | `!math` |
| `!del` | `!delete` |
| `!kick` | `!remove` |
| `!promote` | `!addadmin` |
| `!demote` | `!removeadmin` |

Alias sebaiknya dibatasi agar tidak terlalu banyak variasi parser. Setiap alias perlu ditampilkan pada bantuan command dan diuji sama seperti command utamanya.

## 22. Command yang sebaiknya tidak dibuat melalui chat

Beberapa kemampuan terlalu berisiko untuk diekspos sebagai command WhatsApp. Contohnya adalah menjalankan JavaScript atau shell arbitrer, menjalankan SQL mentah, menampilkan auth state, mencetak QR atau pairing code ke chat, mengubah owner tanpa bootstrap authentication, menghapus database, dan mengirim broadcast tanpa preview atau konfirmasi.

Untuk kemampuan tersebut, akses yang lebih aman adalah panel server, environment variable, deployment terkontrol, atau prosedur owner yang memiliki audit dan konfirmasi berlapis.

## Ringkasan cakupan

Katalog ini mencakup command untuk bantuan, identitas, AFK, informasi grup, konfigurasi grup, permission, moderasi, pengaturan WhatsApp, media, audio, pencarian, utility, AI, produktivitas, roleplay, RPG, permainan, broadcast, diagnosis, dan administrasi. Tidak semua command harus diwujudkan; daftar ini berfungsi sebagai peta ruang fitur agar desain Allybot dapat dipilih dengan sadar tanpa menambah command secara acak.
