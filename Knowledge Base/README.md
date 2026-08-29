# Allybot Knowledge Base

Dokumentasi operasional untuk AI dan kontributor berikutnya. Mulai dari file ini; jangan membaca seluruh codebase sebelum mengikuti shortcut yang relevan.

## Jalur baca cepat

1. `00-architecture.md` — peta struktur, alur pesan, dan invariants.
2. `01-shortcuts.md` — rute cepat dari tujuan kerja ke file/simbol yang relevan.
3. `02-security-operations.md` — boundary keamanan, data, integrasi, dan prosedur validasi.
4. `changes/2026-08-29-audit-fixes.md` — perubahan audit yang dilakukan dan alasan desainnya.
5. `changes/2026-08-29-menu-refactor.md` — kontrak UX `!menu`, keputusan YAGNI, dan aturan ekstensi berikutnya.

## Aturan kerja AI

- Mulai dari shortcut, lalu gunakan pencarian simbol/referensi sebelum membaca body file.
- Jangan mengubah platform boundary, permission, storage, atau schema tanpa membaca bagian terkait di Knowledge Base.
- Setelah perubahan source, jalankan minimal `npm run typecheck`, `npm run build`, dan `npm test`.
- Jangan menjalankan `npm start` selama validasi biasa karena itu memulai proses WhatsApp jangka panjang.
- Jangan menambahkan credential, session, database, atau data pengguna ke repository.
- Perlakukan catatan ini sebagai konteks stabil; verifikasi ulang terhadap source jika ada konflik.

## Status

Knowledge Base ini dibuat setelah audit awal branch `main`. Setiap perubahan substantif harus menambahkan file markdown di `changes/` dengan tanggal, scope, file terdampak, validasi, dan risiko residual.