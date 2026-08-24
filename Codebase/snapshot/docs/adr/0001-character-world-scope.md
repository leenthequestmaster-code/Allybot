# ADR 0001: Character menggunakan world scope berbasis owner

- Status: Accepted
- Tanggal: 2026-08-24
- Scope: Character Guide, IC group, Private Chat

## Konteks

Character dibuat melalui Grup Guide, tetapi harus dapat dilihat dan dipakai sebagai profil owner ketika user berpindah ke grup IC atau membuka Private Chat. Model awal yang mengikat lookup ke hash grup Guide tidak memenuhi perilaku tersebut. Database Character 0005/0006 sudah diterapkan di Supabase dan belum berisi data Character produksi, sehingga perubahan yang paling kecil adalah mempertahankan kontrak RPC dan memakai kolom `guide_key` yang sudah ada sebagai scope key internal yang stabil.

## Keputusan

Runtime memakai konstanta scope `character-world:allyssea:v1`, lalu menyimpan hanya SHA-256 hash scope tersebut sebagai `guide_key` pada RPC Character. `owner_key` tetap merupakan hash identitas owner. Reference ID Card tetap memasukkan hash grup penerbit, hash owner, dan code card sehingga reply tetap terikat pada Guide dan card yang benar. Nama kolom legacy tidak diekspos sebagai domain API baru dan tidak boleh ditafsirkan sebagai raw group identifier.

`!daftar` dan `!savecharacter` tetap hanya boleh dilakukan pada grup mode Guide. `!character` dapat membaca profil aktif dari grup IC maupun Private Chat. `!deletechar` tetap membutuhkan konteks grup sesuai kontrak command yang ada. Character Sheet dan lifecycle tetap authoritative di Supabase; Redis tidak menyimpan authority Character.

## Alternatif yang dipertimbangkan

| Alternatif | Keputusan | Alasan |
|---|---|---|
| Tetap Guide-scoped | Ditolak | Character dari Guide tidak ditemukan di grup IC lain. |
| Menambah tabel mapping world/group baru | Ditunda | Menambah schema dan operasi yang belum diperlukan untuk MVP; belum ada kebutuhan multi-world. |
| Memakai scope hash global pada kontrak kolom yang sudah ada | Dipilih | Perubahan source minimal, backward-compatible terhadap bentuk RPC, tidak perlu migration tambahan setelah fungsi 0005/0006 diverifikasi sudah ada. |

## Konsekuensi dan guardrail

Satu owner hanya memiliki paling banyak satu Character aktif pada world scope ini karena unique index yang sudah ada diterapkan terhadap `guide_key` dan `owner_key`, dengan `guide_key` berisi world scope. Session registration tetap disimpan di Supabase dan idempotensi database tetap berlaku. Bila kelak Allyssea memiliki lebih dari satu world, buat migration additive yang memperkenalkan world registry atau scope key terkonfigurasi; jangan mengubah konstanta diam-diam.

## Verifikasi dan rollback

Production metadata read-only mengonfirmasi fungsi `character_registration_cancel`, `group_ooc_allowlist_clear`, `character_registration_get`, dan `character_delivery_pending` tersedia. Source migration 0005 dicocokkan byte-for-byte dengan payload apply production. Rollback aplikasi dilakukan dengan feature flag; rollback semantic scope memerlukan migration expand/contract hanya setelah ada data dan rencana backfill yang disetujui.
