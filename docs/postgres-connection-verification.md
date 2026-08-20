# PostgreSQL Connection Verification

## Tujuan

Allybot saat ini tetap memakai SQLite sebagai storage runtime. PostgreSQL Supabase hanya disiapkan sebagai koneksi terpisah untuk verifikasi awal dan fondasi World Database di masa depan. Verifier ini tidak membuat tabel, tidak membuat schema, tidak menjalankan migration, dan tidak mengubah data.

## Project

Project Supabase yang digunakan adalah `Allyssea Roleplay Database` pada region `ap-southeast-1`. Project ref dan credential tidak perlu dicantumkan di source code atau log.

## Environment

Set `POSTGRES_URL` hanya pada environment runtime yang ingin diuji. Jangan commit nilai sebenarnya ke repository dan jangan menempelkannya ke chat. Gunakan `POSTGRES_POOL_MODE=session` untuk process Allybot yang berjalan lama. Gunakan `transaction` hanya bila memakai transaction pooler; verifier otomatis mematikan prepared statements pada mode tersebut.

```env
POSTGRES_URL=postgresql://<user>:<password>@<host>:<port>/postgres
POSTGRES_POOL_MODE=session
```

`POSTGRES_URL` bersifat optional. Jika tidak ada, startup Allybot tetap tidak berubah dan SQLite tetap menjadi storage utama.

## Verification command

```bash
npm run verify:postgres
```

Build TypeScript dilakukan oleh CI sebelum artifact dibuat. Pada Panel, command ini langsung menjalankan verifier dari `dist` yang sudah diverifikasi; ia membuat satu client PostgreSQL, menjalankan query read-only `SELECT 1 AS ok LIMIT 1`, memeriksa hasil `1`, lalu menutup client. Command tersebut tidak menjalankan `CREATE`, `ALTER`, `DROP`, `INSERT`, `UPDATE`, `DELETE`, atau migration.

## Periodic read-only monitor

Untuk pengujian berkala di Panel, gunakan command operator berikut setelah artifact hasil CI terpasang:

```bash
npm run monitor:postgres
```

Monitor menjalankan pemeriksaan awal segera, lalu mengulanginya setiap lima menit. Setiap pemeriksaan membuat client terbatas, menjalankan query read-only yang sama (`SELECT 1 AS ok LIMIT 1`), menutup client, dan mencetak status ringkas. Monitor tidak aktif otomatis pada startup Allybot; ia hanya berjalan ketika command tersebut dijalankan secara eksplisit.

Interval dan timeout dapat diubah melalui environment berikut:

```env
POSTGRES_MONITOR_INTERVAL_MS=300000
POSTGRES_MONITOR_TIMEOUT_MS=15000
```

`POSTGRES_MONITOR_INTERVAL_MS` menerima nilai 1 sampai 86.400.000 milidetik. `POSTGRES_MONITOR_TIMEOUT_MS` menerima nilai 1 sampai 60.000 milidetik. Nilai default dipilih agar pemeriksaan tidak menghasilkan koneksi paralel atau beban yang tidak perlu. Pemeriksaan yang masih berjalan tidak ditumpuk dengan pemeriksaan berikutnya. `SIGINT` dan `SIGTERM` menghentikan timer serta menutup client secara graceful.

Output sukses berbentuk `POSTGRES_MONITOR=PASS`; kegagalan berbentuk `POSTGRES_MONITOR=FAIL` dengan error yang telah direduksi. URI, password, raw query, dan payload database tidak dicetak.

## SSL and connection mode

Verifier selalu meminta SSL. Session mode menjadi default karena Allybot adalah process Node.js yang berjalan lama. Transaction mode didukung, tetapi prepared statements dinonaktifkan karena batasan transaction pooler. Direct mode juga diterima jika environment dan network mendukungnya.

## Batas keamanan

SQLite `DATABASE_PATH` tidak diganti. PostgreSQL tidak dibuka otomatis pada startup WhatsApp, tidak didaftarkan sebagai service runtime, dan tidak dipakai untuk menyimpan auth/session/message. Error connection direduksi agar URI/password tidak masuk output. Client selalu ditutup dengan timeout bounded.

## Status implementasi

Verifier, env contract, test, dan dokumentasi ini adalah perubahan fondasi saja. Verifikasi nyata terhadap Supabase baru dapat dilakukan setelah `POSTGRES_URL` tersedia pada environment yang aman. Setelah koneksi lulus, langkah berikutnya tetap memerlukan keputusan terpisah sebelum membuat schema atau tabel apa pun.
