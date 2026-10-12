# Aturan kerja agen Allybot

Dokumen ini adalah sumber tunggal aturan agen di repository ini. Ikuti arahan
pengguna yang lebih spesifik; jangan membuat salinan aturan di `CLAUDE.md`.

## Empat prinsip pengguna

Terapkan prinsip ini sebelum memilih perubahan.

1. **Bukti sebelum tindakan.** Baca sumber kecil yang relevan, telusuri jalur
   aktif, dan ukur baseline. Jangan menebak dari nama folder atau komentar.
2. **Solusi paling sederhana.** Pilih patch terkecil yang memenuhi kebutuhan.
   Hapus no-op yang terbukti tidak dibutuhkan beserta pemanggil dan perhitungan
   mati; jangan mempertahankan API kosong atau menambah lapisan tanpa alasan.
3. **Sumber tunggal dan konvensi.** Gunakan pemilik logika, kontrak, registry,
   helper, serta gaya yang sudah ada. Jangan menduplikasi aturan atau fitur.
4. **Perubahan atomik dan rollback.** Satu kategori per commit, stage nama file
   eksplisit, uji terhadap baseline, dan sediakan SHA awal serta rollback.
   Revert perubahan penyebab regresi; jangan mengubah perilaku untuk meluluskan
   tes atau menimpa pekerjaan pengguna.

## Batas keras dan persetujuan

Persetujuan berlaku hanya untuk ruang lingkup yang dinyatakan pengguna.

- Jangan menulis di luar repository/worktree yang disetujui. Jangan mengubah
  konfigurasi proyek atau server, daemon, systemd, atau melakukan restart/deploy
  tanpa persetujuan khusus. Membaca konfigurasi terlacak untuk bukti diperbolehkan.
- Jangan membaca atau mengubah `.env`, secret, kredensial, auth/session, data
  runtime, maupun database produksi. Jangan menampilkan nilai sensitif.
- Pertahankan kredensial Pixiv secara eksplisit: jangan mengubah, merotasi,
  mencabut, atau mengujinya melalui akun produksi.
- Jangan mengubah `node_modules` produksi atau target symlink. Symlink dependency
  pada worktree audit hanya boleh dibaca; jangan stage symlink tersebut.
- Penambahan, penghapusan, atau upgrade dependency dan perubahan manifest/lockfile
  membutuhkan persetujuan tersendiri. Jangan install tanpa dependency tree milik
  worktree sendiri dan persetujuan install.
- Pertahankan output chat, command, alias, callback, quota, dan fungsi pengguna,
  kecuali perbaikan perilaku yang sudah disetujui dan didokumentasikan.
- Log tidak boleh memuat identifier pengguna/pesan, email, URL mentah, potongan
  URL terpilih, `oobCode`, token, payload, atau kredensial. Gunakan metadata aman,
  jumlah, status, dan kode error; pertahankan counter dan error yang bermakna.
- Ignore backup/editor artefact bukan izin menghapus file runtime. Backup sumber
  `src/framework/plugins/menu.ts.bak` sudah dihapus pada commit `a074c99`;
  `dist/framework/plugins/afk.js.bak` runtime yang di-ignore harus tetap utuh.

## Alur perubahan dua fase

Audit dan implementasi harus terpisah serta dapat ditinjau.

1. **Fase 1, hanya baca:** catat SHA, status Git, file relevan, baseline, bukti
   referensi, risiko, rencana patch, tes, dan rollback. Laporkan temuan dan tunggu
   persetujuan sebelum fase 2; permintaan eksplisit pengguna dapat menjadi
   persetujuan ruang lingkup itu.
2. **Fase 2:** mulai dari Git bersih dan buat branch baru; catat SHA awal sebelum
   edit. Jika ada perubahan pengguna, berhenti dan koordinasikan isolasi, bukan
   reset. Utamakan worktree terisolasi dalam `.hermes/` yang di-ignore.
3. Sebelum menghapus simbol/modul, buktikan referensi statis **dan dinamis**:
   import, re-export, namespace/index access, loader, package scripts, registrasi,
   command alias, dan test. Pencarian nama saja tidak cukup untuk loader dinamis.
4. Lakukan dry-run dengan mock dan state terisolasi. Jangan memakai self-check
   produksi sebagai dry-run, menghubungi WhatsApp aktif, atau menulis DB produksi.
5. Typecheck, build, lint bila tersedia, dan focused test harus dibandingkan
   dengan baseline. Jalankan suite terintegrasi secara terkoordinasi, bukan
   paralel antaragen. Revert patch penyebab regresi sebelum melanjutkan.
6. Commit satu kategori terverifikasi; pisahkan dokumentasi dari cleanup kode.
   Laporkan SHA, tes nyata, keterbatasan, dan perubahan yang belum dikerjakan.

## Konvensi terverifikasi

Gunakan kode terlacak sebagai bukti; aturan ini bukan izin memperluas scope.

- `package.json`: Node.js `>=22`, ESM (`"type": "module"`). `tsconfig.json`:
  TypeScript strict, target ES2022, module/resolution NodeNext. Import relatif
  TypeScript memakai ekstensi `.js` agar sesuai output ESM.
- `src/index.ts` mendaftarkan service sebelum plugin, lalu `AppLifecycle.start()`
  di `src/lifecycle.ts` memanggil `ApplicationFramework.start()`.
  `src/framework/application.ts` menginisialisasi service sebelum load/init
  plugin. Registrasi service/plugin wajib sebelum framework start, bukan dari
  hook load plugin; shutdown service dimiliki registry.
- `src/framework/contracts.ts` adalah kontrak service, plugin, command, dan
  WhatsApp port. `service-registry.ts`, `plugin-manager.ts`, dan
  `command-registry.ts` menangani lifecycle, dependensi, dan registrasi.
  Nama command serta alias harus unik; cek konflik sebelum mendaftarkan.
- Feature/plugin aktif lewat registrasi eksplisit, bukan auto-scan folder.
  Menaruh file di folder tidak membuat feature aktif. Plugin menangani command
  dan penyampaian; service/helper layanan memiliki business logic dan HTTP.
- Logger terstruktur memakai Pino melalui `src/logger.ts`/context logger.
  Hindari `console.*` debugging. Redaksi logger bukan izin memasukkan secret
  pada string log; serializer error hanya mempertahankan nama/kode aman.
- Test JavaScript memakai `node:test` dan mengimpor `dist`. Kompilasi segar
  wajib sebelum tes; hapus output build **hanya di worktree terisolasi** agar
  modul yang sudah dihapus tidak tertutupi `dist` lama. Jangan menghapus atau
  membangun ulang `dist` produksi. Jangan mengklaim simulasi sebagai bukti
  penerimaan pengguna WhatsApp nyata.
- Script tersedia: `npm run typecheck`, `npm run build` (termasuk `postbuild`
  untuk asset), dan `npm test`. Belum ada script lint pada manifest saat audit;
  jangan mengarang perintah lint atau install tool baru tanpa persetujuan.
- Helper resource bersama hanya boleh dianggap tersedia setelah implementasinya
  benar-benar landed dan diverifikasi; dokumen ini tidak menyatakan sudah ada.
