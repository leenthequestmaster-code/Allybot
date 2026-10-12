export interface CommandHelpEntry {
  readonly summary: string
  readonly description: string
  readonly usage: string
  readonly examples: readonly string[]
  readonly note?: string
  readonly type: 'Q' | 'R' | 'N' | 'C'
}

export const COMMAND_HELP_MAP: Readonly<Record<string, CommandHelpEntry>> = {
  // --- SEARCH & TOOLS ---
  google: {
    summary: 'Cari jawaban dan rangkuman informasi dari Google',
    description: 'Cari informasi penting dan jawaban praktis langsung dari Google tanpa perlu membuka peramban web.',
    usage: 'Format: !google <pertanyaan atau kata kunci>',
    examples: ['!google resep sayur lodeh praktis', '!google jadwal libur nasional tahun ini'],
    type: 'Q',
  },
  image: {
    summary: 'Cari foto atau gambar yang relevan dari internet',
    description: 'Temukan gambar atau foto berkualitas sesuai kata kunci yang kamu masukkan dari mesin pencari.',
    usage: 'Format: !image <nama gambar yang dicari>',
    examples: ['!image pemandangan gunung bromo', '!image kucing anggora lucu'],
    type: 'Q',
  },
  wiki: {
    summary: 'Baca penjelasan artikel lengkap dari Wikipedia',
    description: 'Buka ensiklopedia Wikipedia berbahasa Indonesia untuk mempelajari istilah, tokoh sejarah, atau peristiwa penting.',
    usage: 'Format: !wiki <topik atau istilah>',
    examples: ['!wiki planet mars', '!wiki candi borobudur'],
    type: 'Q',
  },
  cuaca: {
    summary: 'Pantau prakiraan cuaca terkini di kotamu',
    description: 'Cek suhu udara, kelembapan, dan kondisi cuaca hari ini di kota tujuan.',
    usage: 'Format: !cuaca <nama kota> (atau cukup ketik !cuaca untuk kota default)',
    examples: ['!cuaca Bandung', '!cuaca Jakarta'],
    type: 'C',
  },
  pin: {
    summary: 'Temukan ide foto dan inspirasi gaya dari Pinterest',
    description: 'Cari ribuan gambar estetik, desain rumah, dan inspirasi pakaian langsung dari platform Pinterest.',
    usage: 'Format: !pin <kata kunci pencarian>',
    examples: ['!pin dekorasi ruang tamu minimalis', '!pin poster tipografi'],
    type: 'Q',
  },
  pixiv: {
    summary: 'Cari gambar ilustrasi dan karya seni dari Pixiv',
    description: 'Temukan karya seni gambar anime, ilustrasi pemandangan, dan karya digital populer dari Pixiv.',
    usage: 'Format: !pixiv <kata kunci atau karakter>',
    examples: ['!pixiv pemandangan senja', '!pixiv anime art'],
    type: 'Q',
  },
  lirik: {
    summary: 'Cari teks lirik lagu lengkap dari judul musik',
    description: 'Temukan teks lirik lagu favoritmu lengkap dengan nama penyanyi aslinya.',
    usage: 'Format: !lirik <judul lagu atau potongan lirik>',
    examples: ['!lirik Melompat Lebih Tinggi', '!lirik Hati-Hati di Jalan'],
    type: 'Q',
  },
  ss: {
    summary: 'Lihat tangkapan layar tampilan halaman web dari tautan',
    description: 'Ambil gambar tangkapan layar tampilan situs internet secara otomatis tanpa harus mengunjungi web.',
    usage: 'Format: !ss <alamat tautan web>',
    examples: ['!ss https://wikipedia.org'],
    note: 'Hanya mendukung alamat web publik yang dapat diakses umum.',
    type: 'C',
  },
  qr: {
    summary: 'Buat gambar kode QR untuk tautan atau catatan penting',
    description: 'Ubah tulisan atau tautan web menjadi gambar kode QR yang dapat dipindai oleh kamera ponsel.',
    usage: 'Format: !qr <tautan atau teks catatan>',
    examples: ['!qr https://google.com', '!qr Pembayaran Kas Anggota'],
    type: 'Q',
  },

  // --- DOWNLOADER & MEDIA ---
  dl: {
    summary: 'Simpan video atau foto dari Instagram, TikTok, Facebook, dan X',
    description: 'Unduh video Reels, TikTok tanpa tanda air, postingan media sosial, serta berkas unduhan langsung ke WhatsApp.',
    usage: 'Format: !dl <tautan postingan media sosial>',
    examples: [
      '!dl https://www.instagram.com/reel/xxx',
      '!dl https://vt.tiktok.com/xxx',
      '!dl https://www.facebook.com/watch?v=xxx',
    ],
    note: 'Untuk video Facebook hanya mendukung format video publik, bukan album foto pribadi.',
    type: 'Q',
  },
  terabox: {
    summary: 'Buka dan simpan berkas atau video dari tautan TeraBox',
    description: 'Ambil berkas atau video yang dibagikan melalui TeraBox tanpa perlu memasang aplikasi tambahan.',
    usage: 'Format: !terabox <tautan berkas TeraBox>',
    examples: ['!terabox https://terabox.app/s/xxx'],
    type: 'Q',
  },
  bypass: {
    summary: 'Buka alamat asli dari pemendek tautan yang terkunci',
    description: 'Buka tujuan akhir tautan yang dipersingkat atau dikunci oleh pengunci media sosial.',
    usage: 'Format: !bypass <tautan pemendek>',
    examples: ['!bypass https://sfl.gl/xxx', '!bypass https://sub2unlock.com/xxx'],
    type: 'Q',
  },
  sc: {
    summary: 'Dengarkan dan simpan lagu favorit dari SoundCloud',
    description: 'Cari rekaman musik di SoundCloud atau unduh langsung berkas audionya dari tautan.',
    usage: 'Format: !sc <judul lagu atau tautan musik>',
    examples: ['!sc lofi hip hop study'],
    type: 'Q',
  },
  yts: {
    summary: 'Telusuri video menarik dari YouTube',
    description: 'Cari daftar video di YouTube berdasarkan judul untuk melihat durasi, penonton, dan tautan tonton.',
    usage: 'Format: !yts <judul video yang dicari>',
    examples: ['!yts panduan belajar berkebun'],
    type: 'Q',
  },
  spotify: {
    summary: 'Dengarkan cuplikan lagu resmi dari katalog Spotify',
    description: 'Cari judul lagu di katalog Spotify untuk memutar pratinjau audio resmi dan melihat informasi artis.',
    usage: 'Format: !spotify <judul lagu atau tautan lagu>',
    examples: ['!spotify Sheila on 7 Sephia'],
    type: 'Q',
  },
  ytmp3: {
    summary: 'Unduh rekaman suara dari video YouTube',
    description: 'Ubah video YouTube menjadi berkas audio agar hemat kuota dan mudah didengarkan di ponsel.',
    usage: 'Format: !ytmp3 <tautan video YouTube>',
    examples: ['!ytmp3 https://youtu.be/xxx'],
    type: 'C',
  },
  ytmp4: {
    summary: 'Unduh rekaman video dari tautan YouTube',
    description: 'Simpan berkas video YouTube dengan kualitas terbaik langsung ke ruang obrolan.',
    usage: 'Format: !ytmp4 <tautan video YouTube>',
    examples: ['!ytmp4 https://youtu.be/xxx'],
    type: 'C',
  },
  tik: {
    summary: 'Simpan video TikTok jernih tanpa tanda air',
    description: 'Unduh video dari tautan TikTok dengan hasil bersih tanpa logo tanda air yang menutupi layar.',
    usage: 'Format: !tik <tautan video TikTok>',
    examples: ['!tik https://vt.tiktok.com/xxx'],
    type: 'C',
  },
  tik2mp3: {
    summary: 'Ambil rekaman musik suara latar dari video TikTok',
    description: 'Ekstrak nada musik atau suara percakapan latar dari video TikTok menjadi pesan audio.',
    usage: 'Format: !tik2mp3 <tautan video TikTok>',
    examples: ['!tik2mp3 https://vt.tiktok.com/xxx'],
    type: 'C',
  },

  // --- STIKER & KREASI MEDIA ---
  sticker: {
    summary: 'Ubah foto atau video pendek menjadi stiker WhatsApp',
    description: 'Ubah gambar foto atau rekaman video pendek di bawah sepuluh detik menjadi stiker obrolan.',
    usage: 'Kirim foto dengan keterangan !s, atau balas pesan media temanmu dengan mengetik !s.',
    examples: ['!s', '!sticker'],
    note: 'Durasi video maksimal 10 detik agar stiker dapat bergerak lancar.',
    type: 'N',
  },
  toimg: {
    summary: 'Ubah stiker kembali menjadi berkas foto biasa',
    description: 'Kembalikan stiker WhatsApp menjadi gambar foto biasa agar mudah disimpan ke galeri ponsel.',
    usage: 'Balas stiker yang ingin diubah dengan mengetik !toimg.',
    examples: ['!toimg'],
    type: 'N',
  },
  togif: {
    summary: 'Ubah stiker bergerak menjadi format gambar gerak',
    description: 'Konversi stiker animasi bergerak menjadi format berkas gambar gerak GIF.',
    usage: 'Balas stiker bergerak dengan mengetik !togif.',
    examples: ['!togif'],
    type: 'N',
  },
  toaudio: {
    summary: 'Ambil suara musik atau percakapan dari rekaman video',
    description: 'Pisahkan suara audio dari video yang kamu kirimkan agar bisa didengarkan sebagai pesan suara.',
    usage: 'Balas rekaman video di obrolan dengan mengetik !toaudio.',
    examples: ['!toaudio'],
    type: 'N',
  },
  removebg: {
    summary: 'Buat latar belakang foto menjadi tembus pandang',
    description: 'Hapus latar belakang foto subjek secara rapi dan otomatis tanpa perlu diedit manual.',
    usage: 'Kirim foto dengan keterangan !removebg atau balas foto dengan !removebg.',
    examples: ['!removebg'],
    type: 'N',
  },
  hd: {
    summary: 'Tajamkan foto yang buram agar terlihat lebih jelas',
    description: 'Tingkatkan resolusi gambar atau foto lama yang agak pecah agar garis detailnya kembali tajam.',
    usage: 'Kirim foto dengan keterangan !hd atau balas foto yang ingin dijernihkan dengan !hd.',
    examples: ['!hd'],
    type: 'N',
  },
  smeme: {
    summary: 'Buat stiker meme dengan tulisan di atas dan bawah',
    description: 'Tambahkan teks tulisan lucu di bagian atas dan bawah gambar stiker untuk membuat meme obrolan.',
    usage: 'Balas gambar atau stiker dengan mengetik: !smeme <teks atas> | <teks bawah>',
    examples: ['!smeme sabar ya | ini ujian hidup'],
    type: 'C',
  },
  stickerwm: {
    summary: 'Pasang nama kamu sebagai pembuat pada stiker',
    description: 'Ubah informasi hak cipta pada paket stiker dengan menyematkan nama diri dan nama koleksimu.',
    usage: 'Balas stiker dengan mengetik: !swm <nama pembuat> | <nama paket stiker>',
    examples: ['!swm Cyrus | Koleksi Pribadi'],
    type: 'C',
  },
  qc: {
    summary: 'Buat gambar kutipan kata berlatar gelembung obrolan',
    description: 'Jadikan pesan tulisan temanmu di obrolan sebagai stiker kartu kutipan lengkap dengan foto profil pengirim.',
    usage: 'Balas pesan tulisan teman yang ingin kamu kutip dengan mengetik !qc.',
    examples: ['!qc'],
    type: 'R',
  },
  iqc: {
    summary: 'Buat gambar stiker kutipan dengan tampilan khas ponsel',
    description: 'Ubah teks kutipan obrolan menjadi tampilan gelembung pesan elegan bergaya ponsel modern.',
    usage: 'Balas pesan tulisan yang ingin dikutip dengan mengetik !iqc.',
    examples: ['!iqc'],
    type: 'R',
  },
  brat: {
    summary: 'Buat gambar teks minimalis berlatar hijau terang',
    description: 'Tulis kalimat singkat dalam format poster teks minimalis berlatar warna hijau terang yang khas.',
    usage: 'Format: !brat <kalimat> atau balas pesan tulisan teman dengan !brat.',
    examples: ['!brat santai dulu kawan'],
    type: 'R',
  },
  bratvid: {
    summary: 'Buat video animasi tulisan bergerak yang menarik',
    description: 'Buat rekaman video singkat dengan animasi penulisan huruf kata demi kata berlatar warna khas.',
    usage: 'Format: !bratvid <kalimat>',
    examples: ['!bratvid semangat beraktivitas'],
    type: 'Q',
  },

  // --- ARTIFICIAL INTELLIGENCE ---
  ai: {
    summary: 'Berbincang santai atau minta bantuan ide ke asisten pintar',
    description: 'Tanyakan jawaban tugas, minta saran solusi, perbaiki tata bahasa, atau diskusikan ide apa pun.',
    usage: 'Format: !ai <pertanyaanmu> atau balas pesan teks obrolan dengan mengetik !ai.',
    examples: ['!ai buatkan pantun ulang tahun untuk ayah', '!ai jelaskan cara kerja fotosintesis'],
    type: 'R',
  },
  tts: {
    summary: 'Ubah pesan tulisan menjadi suara rekaman audio',
    description: 'Konversi naskah tulisan menjadi ucapan suara bahasa Indonesia yang ramah dan jelas.',
    usage: 'Format: !tts <kalimat yang ingin disuarakan>',
    examples: ['!tts Selamat pagi semuanya, semoga hari kalian menyenangkan'],
    type: 'Q',
  },
  text2img: {
    summary: 'Buat gambar ilustrasi baru dari kalimat deskripsi',
    description: 'Rancang lukisan dan gambar ilustrasi orisinal secara otomatis hanya dengan menjelaskan wujud objeknya.',
    usage: 'Format: !text2img <kalimat penggambaran objek>',
    examples: ['!text2img kucing kecil memakai topi jerami santai di tepi pantai'],
    type: 'C',
  },

  // --- IBADAH & KEAGAMAAN ---
  doa: {
    summary: 'Baca doa sehari-hari lengkap dengan artinya',
    description: 'Temukan doa sehari-hari lengkap dengan lafaz Arab, tulisan latin, dan arti terjemahannya.',
    usage: 'Format: !doa <nama doa>',
    examples: ['!doa sebelum makan', '!doa masuk masjid'],
    type: 'Q',
  },
  quran: {
    summary: 'Baca potongan ayat dan arti surah dalam Al-Qur\'an',
    description: 'Buka surah dan ayat dalam Al-Qur\'an lengkap dengan teks Arab dan terjemahan bahasa Indonesia.',
    usage: 'Format: !quran <nama atau nomor surah>',
    examples: ['!quran Al-Fatihah', '!quran 36'],
    type: 'Q',
  },
  sholat: {
    summary: 'Cek waktu dan jadwal ibadah sholat hari ini',
    description: 'Lihat jadwal waktu sholat lima waktu serta waktu imsak untuk wilayah kabupaten atau kota pilihanmu.',
    usage: 'Format: !sholat <nama kota>',
    examples: ['!sholat Surabaya', '!sholat Jakarta Selatan'],
    type: 'Q',
  },

  // --- SISTEM & INFORMASI ---
  ping: {
    summary: 'Cek kecepatan jaringan dan waktu respons bot saat ini',
    description: 'Ukur kecepatan komunikasi antara server bot dengan WhatsApp untuk memastikan koneksi berjalan lancar.',
    usage: 'Cukup ketik !ping di ruang obrolan.',
    examples: ['!ping'],
    type: 'N',
  },
  botprofile: {
    summary: 'Buka keterangan pengembang dan versi bot yang berjalan',
    description: 'Tampilkan identitas resmi pengembang bot, nomor kontak darurat, dan versi aplikasi terkini.',
    usage: 'Cukup ketik !botprofile.',
    examples: ['!botprofile'],
    type: 'N',
  },
  diag: {
    summary: 'Pantau kesehatan memori dan ketahanan sistem bot',
    description: 'Periksa penggunaan memori sistem, durasi waktu aktif, dan stabilitas server secara langsung.',
    usage: 'Cukup ketik !diag.',
    examples: ['!diag'],
    type: 'N',
  },

  // --- GRUP & PENGATURAN ---
  groupinfo: {
    summary: 'Tampilkan data umum dan setelan grup obrolan ini',
    description: 'Lihat nama grup, tanggal pembuatan, pemilik grup, deskripsi, dan status fitur bot yang aktif di sini.',
    usage: 'Cukup ketik !groupinfo di dalam obrolan grup.',
    examples: ['!groupinfo'],
    type: 'N',
  },
  membercount: {
    summary: 'Hitung total orang yang bergabung di grup saat ini',
    description: 'Lihat ringkasan total anggota yang terdaftar dan perbandingan jumlah pengurus di grup ini.',
    usage: 'Cukup ketik !membercount di dalam grup.',
    examples: ['!membercount'],
    type: 'N',
  },
  admins: {
    summary: 'Tampilkan nama admin yang mengelola grup ini',
    description: 'Daftar seluruh kontak admin pengurus grup yang memiliki wewenang mengelola obrolan.',
    usage: 'Cukup ketik !admins.',
    examples: ['!admins'],
    type: 'C',
  },
  rules: {
    summary: 'Baca peraturan yang disepakati bersama di grup ini',
    description: 'Buka lembar tata tertib resmi grup agar seluruh anggota mengetahui batas etika percakapan.',
    usage: 'Cukup ketik !rules di dalam grup.',
    examples: ['!rules'],
    type: 'N',
  },
  link: {
    summary: 'Bagikan tautan resmi untuk mengajak teman masuk grup',
    description: 'Dapatkan tautan undangan resmi grup WhatsApp untuk dibagikan kepada teman baru.',
    usage: 'Cukup ketik !link di dalam grup.',
    examples: ['!link'],
    note: 'Hanya bisa dijalankan jika bot telah diberi wewenang sebagai admin grup.',
    type: 'N',
  },
  afk: {
    summary: 'Beri tahu teman bahwa kamu sedang rehat sejenak',
    description: 'Pasang status sedang tidak di tempat agar bot otomatis membalas jika ada anggota lain yang memanggil namamu.',
    usage: 'Format: !afk <alasan rehat opsional>',
    examples: ['!afk istirahat makan siang', '!afk'],
    type: 'C',
  },

  // --- KEAMANAN & MODERASI ---
  kick: {
    summary: 'Lepas anggota yang mengganggu kenyamanan obrolan',
    description: 'Keluarkan anggota tertentu dari grup karena melanggar tata tertib yang telah ditetapkan.',
    usage: 'Format: !kick @nama atau balas pesan anggota yang ingin dikeluarkan dengan mengetik !kick.',
    examples: ['!kick @anggota'],
    note: 'Perintah ini khusus untuk admin grup.',
    type: 'Q',
  },
  warn: {
    summary: 'Berikan poin teguran resmi pada anggota yang melanggar',
    description: 'Catat satu poin peringatan resmi kepada anggota yang berbuat gaduh atau tidak mematuhi tata tertib.',
    usage: 'Format: !warn @nama <alasan> atau balas pesan pelanggar dengan !warn <alasan>.',
    examples: ['!warn @anggota kata kurang sopan'],
    note: 'Jika poin teguran mencapai batas maksimal, anggota akan otomatis dikeluarkan.',
    type: 'Q',
  },
  unwarn: {
    summary: 'Kurangi satu poin teguran anggota yang sudah berbenah',
    description: 'Hapus satu catatan poin peringatan milik anggota yang telah meminta maaf atau berkelakuan baik.',
    usage: 'Format: !unwarn @nama atau balas pesan anggota dengan mengetik !unwarn.',
    examples: ['!unwarn @anggota'],
    note: 'Perintah ini khusus untuk admin grup.',
    type: 'Q',
  },
  warnings: {
    summary: 'Lihat riwayat teguran yang pernah diterima anggota',
    description: 'Periksa berapa sisa batas poin peringatan milikmu sendiri atau milik teman di obrolan.',
    usage: 'Format: !warnings (untuk diri sendiri) atau balas pesan anggota dengan !warnings.',
    examples: ['!warnings'],
    type: 'R',
  },
  lock: {
    summary: 'Batasi obrolan agar hanya pengurus yang bisa mengirim pesan',
    description: 'Tutup izin obrolan sementara agar ruang pesan tenang saat ada pengumuman penting dari pengurus.',
    usage: 'Cukup ketik !lock oleh admin grup.',
    examples: ['!lock'],
    type: 'N',
  },
  unlock: {
    summary: 'Izinkan kembali semua anggota mengobrol seperti biasa',
    description: 'Buka kembali akses percakapan agar seluruh anggota grup bisa saling berkirim pesan.',
    usage: 'Cukup ketik !unlock oleh admin grup.',
    examples: ['!unlock'],
    type: 'N',
  },
  antilink: {
    summary: 'Cegah pengiriman tautan berbahaya atau promosi liar',
    description: 'Nyalakan pengawas otomatis yang langsung menghapus kiriman tautan masuk grup tanpa izin.',
    usage: 'Format: !antilink on (untuk mengaktifkan) atau !antilink off (untuk mematikan).',
    examples: ['!antilink on', '!antilink off'],
    type: 'C',
  },
  antispam: {
    summary: 'Batasi pesan beruntun cepat yang mengganggu obrolan',
    description: 'Lindungi kenyamanan ruang grup dari anggota yang mengirimkan banyak pesan dalam waktu sangat singkat.',
    usage: 'Format: !antispam on atau !antispam off.',
    examples: ['!antispam on', '!antispam off'],
    type: 'C',
  },
  antitoxic: {
    summary: 'Tegur otomatis pesan yang memuat kata tidak pantas',
    description: 'Aktifkan pendeteksi kata kasar yang akan menegur dan menghapus kalimat yang melanggar kesopanan.',
    usage: 'Format: !antitoxic on atau !antitoxic off.',
    examples: ['!antitoxic on', '!antitoxic off'],
    type: 'C',
  },
  hidetag: {
    summary: 'Berikan kabar penting kepada seluruh anggota grup',
    description: 'Kirimkan pesan pengumuman penting yang memunculkan tanda notifikasi kepada seluruh anggota grup.',
    usage: 'Format: !hidetag <pesan pengumuman>',
    examples: ['!hidetag jadwal kerja bakti hari minggu pagi'],
    note: 'Gunakan dengan bijak hanya untuk hal yang benar-benar penting.',
    type: 'C',
  },
  del: {
    summary: 'Hapus pesan balasan bot yang keliru dari layar obrolan',
    description: 'Minta bot menarik kembali pesan yang telah dikirimnya agar ruang percakapan tetap rapi.',
    usage: 'Balas pesan bot yang ingin dibersihkan dengan mengetik !del.',
    examples: ['!del'],
    type: 'R',
  },

  // --- KARAKTER CERITA & EKONOMI ---
  character: {
    summary: 'Lihat biodata dan status tokoh cerita milikmu',
    description: 'Tampilkan lembar biodata tokoh ceritamu, nama peran, tingkat level, dan sisa poin kemampuan.',
    usage: 'Cukup ketik !character di ruang obrolan.',
    examples: ['!character'],
    type: 'N',
  },
  stats: {
    summary: 'Cek sebaran poin kekuatan dan ketahanan tokoh ceritamu',
    description: 'Periksa statistik kekuatan fisik, kecerdasan, kelincahan, dan ketahanan tokoh milikmu secara rinci.',
    usage: 'Cukup ketik !stats.',
    examples: ['!stats'],
    type: 'N',
  },
  daftar: {
    summary: 'Buka formulir pembuatan tokoh cerita baru',
    description: 'Mulai petualangan ceritamu dengan mendaftarkan nama, latar belakang, dan keahlian tokoh baru.',
    usage: 'Cukup ketik !daftar lalu ikuti petunjuk yang diberikan oleh bot.',
    examples: ['!daftar'],
    type: 'N',
  },
  vela: {
    summary: 'Periksa sisa uang Vela yang tersimpan di kantongmu',
    description: 'Cek jumlah uang tunai Vela yang siap kamu belanjakan atau bagikan kepada teman di obrolan.',
    usage: 'Cukup ketik !vela.',
    examples: ['!vela'],
    type: 'N',
  },
  bank: {
    summary: 'Periksa tabungan aman milikmu di bank komunitas',
    description: 'Lihat catatan saldo simpanan yang kamu tabung di perbankan agar aman dari pemotongan harian.',
    usage: 'Cukup ketik !bank.',
    examples: ['!bank'],
    type: 'N',
  },
}

export function formatCommandHelp(
  name: string,
  aliases: readonly string[] = [],
  prefix = '!',
): string | undefined {
  const cleanName = name.replace(/^[!/#.]/, '').trim().toLowerCase()
  const entry = COMMAND_HELP_MAP[cleanName]
  if (!entry) return undefined

  const lines: string[] = [
    `*Bantuan Perintah: ${prefix}${cleanName}*`,
  ]

  if (aliases && aliases.length > 0) {
    const aliasStr = aliases.map((a) => `${prefix}${a}`).join(', ')
    lines.push(`Alias: ${aliasStr}`)
  }

  lines.push('')
  lines.push(entry.description)
  lines.push('')
  lines.push('*Cara Pakai:*')
  lines.push(entry.usage)

  if (entry.examples && entry.examples.length > 0) {
    lines.push('')
    lines.push('*Contoh:*')
    for (const ex of entry.examples) {
      lines.push(ex)
    }
  }

  if (entry.note) {
    lines.push('')
    lines.push(`_Catatan: ${entry.note}_`)
  }

  return lines.join('\n')
}
