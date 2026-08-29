# Menu Refactor — 2026-08-29

## Kontrak UX baru

`!menu` adalah menu text-first dengan satu pengiriman media opsional. Jika thumbnail tersedia, `sendMedia` mengirim satu image message dengan caption yang berisi deskripsi menu, biodata bot, daftar kategori, dan instruksi angka. Thumbnail tidak dikirim sebagai pesan terpisah dari deskripsi. Jika media tidak tersedia atau pengiriman gagal, body yang sama dikirim sebagai satu text message.

Kategori dipilih hanya dengan nomor global: `!menu 1`, `!menu 2`, dan seterusnya. Nama kategori dan alias kategori bukan input user-facing. Sub-menu juga menampilkan `!menu` untuk kembali ke daftar utama.

## Biodata menu

Body menu menampilkan Nama `Allybot`, Uptime dari `process.uptime()`, Owner yang dimasking, dan Versi `v0.1.0`. Owner tidak ditampilkan sebagai nomor penuh untuk mengurangi kebocoran data.

## YAGNI decisions

Dihapus dari plugin menu: Location message, native quick replies, active native menu map, button token, expiry state, quote navigation, page buttons, dan daftar roadmap kategori kosong. Semua kategori yang ditampilkan sekarang harus memiliki command visible yang dapat diakses oleh requester.

## Bug/fallacy fixed

- Cooldown menu diubah menjadi `0` agar pengguna dapat mengirim `!menu 1` segera setelah `!menu`.
- Kategori privileged tetap difilter berdasarkan sender saat menu dibuat.
- Resolver kategori hanya menerima angka sehingga nama kategori tidak menjadi kontrak publik.
- Fallback media tidak mengirim native/location message setelah media gagal; selalu satu text fallback dengan body yang sama.
- `collectCategories` tidak lagi membuat kategori Coming Soon kosong.
- Pengiriman menu tidak menyimpan state per chat, sehingga tidak ada collision active-menu antar-pengguna.

## Files

- `src/framework/plugins/menu.ts` — refactor utama, menyederhanakan sekitar 678 menjadi sekitar 300 baris.
- `tests/menu.test.js` — test UX thumbnail tunggal, biodata, numeric navigation, privilege filtering, dan fallback.
- `tests/runtime-acceptance.test.js` — acceptance test text-first numeric flow.

## Validation

`npm run typecheck`, `npm run build`, `npm test`, `npm run self-check`, `npm run verify:platform`, dan `git diff --check` wajib lulus. Pada refactor ini: 368 test lulus, 0 gagal.

## Future extension rule

Jangan menambahkan button, pagination, quote state, atau alternate transport sebelum ada kebutuhan produk yang jelas dan test contract yang menjelaskan manfaatnya. Jika thumbnail gagal, pertahankan satu text fallback; jangan menambah jalur pesan baru tanpa alasan UX terukur.
