# Allybot Platform Package

## Tujuan

Platform Package adalah internal package layer untuk memisahkan domain logic Allybot dari transport WhatsApp/Baileys. Package ini tidak menggantikan Baileys dan tidak mengadopsi fork pihak ketiga. Transport hanya berfungsi sebagai adapter yang menerjemahkan pesan masuk, mengirim response, dan menyediakan capability yang tersedia.

## Modul

| Modul | Tanggung jawab |
|---|---|
| `contracts.ts` | Contract feature, interaction, permission, event, clock, dan logger |
| `feature-registry.ts` | Registry feature deterministik dan status filtering |
| `lifecycle.ts` | Dependency ordering, lifecycle hooks, cycle detection, rollback, dan state guard |
| `interaction.ts` | Menu teks dan parsing direct/reply-number |
| `buttons.ts` | Native quick-reply model, capability gate, callback parsing, dan text fallback |
| `framework-adapter.ts` | Mapping `CoreMessage` dan command definitions ke interaction contract |
| `sessions.ts` | Persistent interaction sessions dengan expiry, ownership, cancellation, dan idempotency |
| `permission.ts` | Central policy evaluator dengan default-deny |
| `events.ts` | Bounded audit sink dan structured logger sink |
| `operations.ts` | Permission gate, timeout, retry policy, dan operation events |
| `mission.ts` | Generic persistent state-machine Mission Engine |
| `group-setup.ts` | Domain definition Group Setup Mission |

## Interaction fallback

Native quick replies hanya dirender jika capability transport tersedia, seluruh item memenuhi batas validasi, dan jumlah item tidak melewati konfigurasi adapter. Jika kondisi tersebut tidak terpenuhi, adapter mengembalikan menu teks yang tetap dapat digunakan melalui angka atau reply terhadap menu.

Baileys upstream menyediakan tipe protobuf untuk native-flow pada versi yang digunakan, tetapi dukungan server/client untuk interactive list atau button tidak dapat dianggap stabil. Upstream issue [#2465](https://github.com/WhiskeySockets/Baileys/issues/2465) mencatat kasus pesan list tidak terkirim atau tidak ditampilkan sebagai interactive list pada versi terbaru. Karena itu native sender bersifat optional dan menu existing tetap text-first.

## Persistent sessions

Interaction sessions disimpan pada SQLite terpisah `allybot-platform.sqlite` di direktori yang sama dengan database utama. Mission records menggunakan optimistic concurrency melalui `revision`, menyimpan operation key terakhir untuk idempotency, membatasi actor dan chat, dan melakukan expiry sebelum resume. Auth/session Baileys tidak dicampur dengan mission data.

## Mission Engine

Mission definition terdiri dari ID, version, initial state, dan handler per state. Handler hanya mengembalikan transition domain-neutral: `stay`, `transition`, `complete`, `cancel`, atau `fail`. Engine menyimpan state serta response terakhir sehingga mission dapat dilanjutkan setelah restart. Perubahan yang bersamaan ditolak oleh revision check, sedangkan input duplikat dengan operation key sama dikembalikan sebagai replay tanpa menjalankan handler ulang.

## Group Setup Mission

`Group Setup Mission` adalah vertical slice pertama yang menggunakan engine generic, tetapi sengaja diimplementasikan paling akhir setelah primitives stabil. Mission meminta aturan, welcome, leave, prefix, bahasa, dan timezone secara bertahap. Setiap nilai divalidasi sebelum lanjut ke tahap berikutnya. Pada tahap review, admin harus mengirim `confirm` atau `cancel`. Gateway konfigurasi menerapkan seluruh patch dalam satu transaksi SQLite, sehingga kegagalan salah satu write tidak meninggalkan konfigurasi setengah jadi.

Command production yang tersedia adalah `!groupsetup` atau `!setupgroup`. Command hanya berlaku pada grup dan memakai `group.admin`; setiap input mission melakukan recheck role terhadap metadata grup sebelum diproses. Mission aktif dapat dilanjutkan setelah restart atau dibatalkan melalui `!groupsetup cancel`.

## CI contract

CI menjalankan typecheck, clean build, platform source-dist parity verifier, syntax check seluruh compiled JavaScript, dan test suite terhadap compiled runtime. Verifier juga menolak file auth/session/database sensitif dari repository set. Artifact hanya memuat `dist`, `package.json`, dan `package-lock.json`. Startup Command Pterodactyl tidak diubah.
