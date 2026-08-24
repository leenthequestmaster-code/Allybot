# R5 Architecture Brief

## Outcome and hard constraints

R5 harus memberi pengguna kontrol atas bahasa, timezone, quiet hours, verbosity, dan format accessibility tanpa mengubah permission, tanpa mengaktifkan side effect baru, tanpa passive chat memory, dan tanpa mengirim data mentah ke audit. Fitur group-level default-off dengan feature ID `group.personalization.core`. Semua command tetap text-only dan memiliki balasan teks sebagai fallback.

## Local ground truth

Entry point `src/index.ts` mendaftarkan service lalu plugin melalui `ApplicationFramework`. `ServiceRegistry` menyelesaikan dependency secara topological order dan memanggil `initialize`/`shutdown` sekali per lifecycle. Service modern memakai SQLite WAL, tabel additive, validator lokal berbasis `isJid`, dan `PlatformGuardrailService` untuk flag serta hot/archive audit. `CollaborationService` R3 saat ini menyimpan reminder group-wide dan dispatcher mengirim satu `sendText` ke `group_jid`; row reminder tidak memiliki recipient list.

`GroupConfigurationService` sudah memiliki language dan timezone group-level, termasuk `isValidGroupTimezone` berbasis `Intl.DateTimeFormat`, tetapi ia menyimpan konfigurasi operasional grup dan tidak menyediakan user preference, quiet hours, verbosity, atau accessibility format. Karena R5 harus mempertahankan public behavior dan menghindari coupling yang tidak diperlukan, PersonalizationService memakai tabel baru dan API baru; overlap group language/timezone tidak menghapus atau memigrasikan data lama pada batch ini.

## Selected design

`PersonalizationService` memakai dua tabel additive: `user_preferences` keyed by `(group_jid, user_jid)` untuk override personal dan `group_policies` keyed by `group_jid` untuk policy grup. Nilai yang tidak diset direpresentasikan sebagai `NULL`, bukan menyalin default ke setiap row. Global default adalah konstanta kode yang immutable pada batch ini. Effective resolution memilih explicit user override, kemudian group policy, kemudian global default.

Preference yang disimpan dibatasi pada `language` (`id|en`), strict-IANA `timezone`, quiet hours (`start` dan `end` dalam `HH:mm`, atau disabled), `verbosity` (`brief|normal|detailed`), dan `format` (`plain|accessible`). Service menyediakan `getUserPreferences`, `getGroupPolicy`, `resolvePreferences`, setter user, setter group admin, `deleteUserPreferences`, dan bounded export metadata. Export tidak memasukkan raw JID atau credential ke audit; data response tetap hanya diberikan kepada actor yang meminta atau admin untuk policy grup.

Strict timezone validation menerima `UTC` secara eksplisit dan identifier yang ada pada `Intl.supportedValuesOf('timeZone')`, dibandingkan ASCII-case-insensitively. Offset-style values seperti `+07:00` ditolak karena requirement R5 meminta IANA valid, meskipun `Intl.DateTimeFormat` juga menerima offset identifiers.

## Notification integration boundary

PersonalizationService mengekspos `shouldNotify(groupJid, userJid, now)` dan `formatDate`/`formatNotification` yang pure terhadap policy. CollaborationService memakai service tersebut secara opsional saat runtime; dependency hard tidak ditambahkan agar fixture R3 lama dan isolated service tests tetap valid. Untuk reminder group-wide tanpa recipient list, effective notification decision memakai group policy; user-specific quiet hours tidak diperlakukan seolah-olah dapat memfilter seluruh grup. User override dipakai pada future targeted notification dan pada presentation/command responses, tetapi R5 tidak mengubah kontrak WhatsAppPort atau melakukan fan-out baru.

Jika group policy berada dalam quiet hours, due reminder tidak hilang: dispatcher mempertahankan status `scheduled` dan menunda claim sampai window quiet berakhir. Ini menghindari data loss dan menjaga retry/restart recovery. Jika policy `notify` disabled, reminder tidak dikirim dan tetap `scheduled`; status observability/audit membedakan `limited` dari `failed`. Integrasi ini hanya berlaku saat personalization service tersedia dan feature flag group aktif; jika tidak, R3 behavior tetap unchanged.

## Security and privacy invariants

JID divalidasi di service tetapi audit hanya menyimpan hash melalui guardrail. Audit metadata hanya boleh berisi field identifier internal, enum, lengths, count, dan reason; tidak boleh memuat raw JID, phone number, message content, timezone input yang belum dinormalisasi bila dianggap sensitive, atau raw error. Policy tidak pernah menjadi permission check dan tidak dapat mengesahkan group mutation atau provider call. Semua setter dibatasi panjang, enum, dan bentuk input; quiet hour interval menangani overnight window secara deterministik.

## Verification and rollback

Gate R5 mencakup typecheck, clean build, source-dist parity, full regression, focused R5 tests, schema migration on fresh and pre-existing database, default-off, timezone strictness, quiet-hours overnight/normal windows, precedence, cross-user/group isolation, delete/export, audit redaction, reminder deferral/disabled behavior, restart-safe persistence, dan plugin text fallback. Rollback berupa deployment artifact commit sebelumnya; schema additive sehingga binary lama tidak memerlukan kolom baru untuk tabel R5.
