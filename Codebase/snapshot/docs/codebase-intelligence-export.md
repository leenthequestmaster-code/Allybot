# Codebase Intelligence Export

## Tujuan

`Codebase/` adalah snapshot intelligence yang dibuat otomatis dari source commit yang telah lulus validasi CI. Export ini ditujukan untuk membantu AI code dan maintainer memahami struktur repository tanpa membuka seluruh direktori secara berulang. Isinya bukan database runtime, bukan chat history, dan bukan salinan filesystem Panel.

## Sumber kebenaran dan alur CI

CI tetap menjadi satu-satunya pembuat dan publisher folder generated. Job `verify` terlebih dahulu menjalankan install dari lockfile, typecheck, clean build, parity/platform checks, schema checks, JavaScript syntax checks, dan regression suite. Hanya setelah job tersebut berhasil pada `main`, generator dipanggil dengan `--source-sha "$GITHUB_SHA"`.

Generator membaca allowlist `src`, `tests`, `scripts`, `docs`, `.github`, serta root configuration files yang ditentukan secara eksplisit. Ia tidak membaca `node_modules`, `dist`, `.git`, `Codebase`, symlink, database, credential/session files, atau `.env` selain `.env.example`. Secret-like content dan ukuran file/snapshot dibatasi sebelum snapshot ditulis.

Publisher menggunakan `GITHUB_TOKEN` bawaan GitHub Actions hanya pada job yang memiliki `contents: write`; workflow secara global tetap `contents: read`. Publisher mengunduh artifact dari job validasi, memverifikasi manifest terhadap source SHA, memeriksa path/symlink/sensitive file, lalu hanya melakukan commit `Codebase/**`. Push yang hanya mengubah `Codebase/**` diabaikan oleh trigger CI sehingga tidak membentuk loop. Bila `origin/main` sudah bergerak dari source SHA yang diuji, publisher berhenti tanpa commit agar export tidak pernah menggambarkan commit yang berbeda.

| Tahap | Tanggung jawab | Boundary penting |
| --- | --- | --- |
| `verify` | Membuktikan source commit dapat dibangun dan diuji | Tidak memiliki GitHub write permission |
| generator | Membuat snapshot, AST index, CSV, manifest, dan checksum | Allowlist path, secret scan, batas ukuran, no symlink |
| artifact handoff | Memindahkan hasil validasi ke publisher | Tar transport diverifikasi terhadap traversal path |
| `publish_codebase` | Commit generated `Codebase/**` ke `main` bila tip masih sama | Satu-satunya job dengan `contents: write` |
| deployment artifact | Menyertakan hanya `Codebase/allybot-codebase-latest.zip` | Tidak mengirim source snapshot mentah ke Panel |
| bot runtime | Mengirim ZIP prebuilt kepada developer yang berwenang | Tidak scan, generate, push, exec, eval, atau shell |

## Isi folder

Export mencakup `manifest.json` dengan source commit, timestamp commit, jumlah record, dan daftar file; `SHA256SUMS.txt`; dokumentasi ringkas di `overview/`; dataset relasional CSV di `tables/`; serta snapshot tersanitasi di `snapshot/`. Dataset utama meliputi files, symbols, imports, calls, commands, services, konfigurasi, feature flags, dependencies, tests, dan data-flow relations.

Resolusi call graph memakai TypeScript AST secara konservatif. Relasi yang dapat diikat ke deklarasi lokal yang tidak ambigu diberi confidence lebih tinggi; dynamic import, reflection, dependency injection runtime, generated code, dan seluruh indirect call tidak dijanjikan dapat diselesaikan. Ketidakpastian dicatat sebagai row confidence rendah atau unresolved, bukan ditebak.

`allybot-codebase-latest.zip` adalah transport artifact yang berisi seluruh dataset export kecuali dirinya sendiri. ZIP dibuat setelah checksum dataset selesai, diuji dengan `unzip -t`, dan dibatasi maksimum 4 MiB untuk kompatibilitas dengan adapter dokumen WhatsApp. ZIP bukan input generator pada run berikutnya karena seluruh path `Codebase/` dikecualikan.

## Command runtime

Command tersembunyi `!codebase` didaftarkan hanya ketika `CODEBASE_EXPORT_ENABLED=true`. Ia memakai permission `developerModeObserver`, sehingga tetap tunduk pada model Owner-controlled Developer Mode dan private-chat authorization yang sudah berlaku. Command hanya membuka path relatif yang tetap berada di dalam application directory, memeriksa signature ZIP, membaca ukuran dengan batas konfigurasi, lalu mengirim dokumen dengan nama tetap `allybot-codebase-latest.zip`.

Default configuration adalah `CODEBASE_EXPORT_ENABLED=false`, `CODEBASE_EXPORT_PATH=./Codebase/allybot-codebase-latest.zip`, dan `CODEBASE_EXPORT_MAX_BYTES=3145728`. Path absolut atau path yang mengandung segment `..` ditolak. Jika file tidak ada, bukan ZIP, kosong, atau melebihi batas, bot mengirim pesan fallback yang aman dan log hanya mencatat nama tipe error tanpa isi path atau payload.

## Data dan trust boundary

| Actor atau aset | Boleh | Tidak boleh |
| --- | --- | --- |
| GitHub Actions `verify` | Membaca checkout source, membangun, menguji, dan membuat artifact | Menulis branch `main` |
| GitHub Actions `publish_codebase` | Menulis generated `Codebase/**` pada `main` setelah provenance check | Menulis source lain, mengubah secrets, mengakses Panel, atau menjalankan shell pada bot |
| Panel deployment | Menerima sanitized deployment archive melalui jalur CI yang sudah ada | Menerima source repository, GitHub write token, atau generated scan logic |
| Bot `!codebase` | Mengirim ZIP prebuilt kepada actor berizin | Membuat export, scan filesystem, membaca database/chat/session, push GitHub, eval/exec/shell |
| AI code/maintainer | Membaca export dan memahami provenance/limitations | Menganggap static relation sebagai bukti runtime behavior tanpa verifikasi |

Tidak ada integrasi Google Drive pada desain ini. Repository dan CI adalah storage/publisher yang dipilih agar tidak menambah credential eksternal atau memperluas trust boundary.

## Provenance, stale output, dan rollback

`manifest.json.commitSha` menunjuk source commit yang dianalisis, bukan commit generated yang akhirnya menambahkan folder `Codebase/`. Perbedaan ini disengaja dan memungkinkan reviewer melihat dengan tepat kode mana yang menjadi input. Commit generated harus diperlakukan sebagai derived output dan tidak diedit manual.

Jika publisher gagal karena race branch, source checkout, artifact, atau checksum, tidak ada partial publish yang boleh dianggap valid. Re-run workflow pada tip terbaru adalah jalur pemulihan. Jika export sudah ter-publish tetapi ingin dinonaktifkan sementara, set `CODEBASE_EXPORT_ENABLED=false` pada environment runtime; untuk mengembalikan folder repository, revert commit generated Codebase melalui proses review biasa. Deployment Panel tetap mengikuti artifact workflow existing dan tidak mengubah locked Startup Command maupun `.bash_profile`.

## Review dan refresh trigger

Export perlu diperiksa ulang ketika struktur source root berubah, format command/plugin berubah, TypeScript compiler berubah, batas adapter WhatsApp berubah, ada dependency/security advisory baru, atau workflow permissions diubah. Perubahan terhadap allowlist, secret patterns, ZIP packaging, atau deployment artifact harus disertai regression test dan review security karena berpotensi memperluas data yang keluar dari repository.
