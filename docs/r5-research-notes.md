# R5 Research Notes

## Decision question

Bagaimana R5 memvalidasi timezone pengguna secara strict-IANA, tanpa dependency baru, tetap kompatibel dengan Node.js 22 dan database SQLite additive yang sudah digunakan Allybot?

## Evidence

| Claim | Source | Scope and limitation | Decision strength |
|---|---|---|---|
| `Intl.DateTimeFormat` menerima nama timezone IANA dan juga offset identifiers, serta melempar `RangeError` untuk nilai opsi invalid | [MDN `Intl.DateTimeFormat()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat) | Dokumentasi API lintas implementasi; tidak cukup untuk membedakan strict-IANA karena offset juga diterima | Strong for API behavior |
| `Intl.supportedValuesOf('timeZone')` mengembalikan identifier timezone yang didukung runtime, dengan daftar canonical dan bergantung pada data implementasi | [MDN `Intl.supportedValuesOf()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/supportedValuesOf) | Daftar runtime dapat berubah mengikuti ICU/tzdb; `UTC` perlu diperlakukan eksplisit bila tidak tercantum | Strong for runtime enumeration |
| ECMA-402 merujuk IANA Time Zone Database dan menetapkan perbandingan identifier timezone case-insensitive ASCII | [ECMA-402](https://tc39.es/ecma402/) | Spesifikasi mengizinkan implementation-dependent data dan berkembang per edisi | Strong for standard boundary |
| IANA tzdb diperbarui berkala oleh perubahan politik terhadap batas timezone, offset, dan daylight-saving rules | [IANA Time Zone Database](https://www.iana.org/time-zones/) | Kebenaran historis/future civil time mengikuti versi tzdb pada runtime/OS | Strong for operational caveat |

## Engineering decision

R5 tidak menambah library timezone. Service akan melakukan trim, membatasi panjang, menolak whitespace/offset-style input, menerima `UTC` secara eksplisit, lalu mencocokkan identifier lain terhadap `Intl.supportedValuesOf('timeZone')` secara case-insensitive ASCII. Formatter `Intl.DateTimeFormat` tetap menjadi fallback behavior check, tetapi bukan satu-satunya validator strict-IANA. Test harus memverifikasi `UTC`, `Asia/Jakarta`, input invalid, offset `+07:00` yang ditolak, dan persistence round-trip.

## R5 architecture implications

Preference user dan policy group tetap additive dan default-off. Precedence policy untuk reminder adalah explicit user override, kemudian group policy, kemudian global default. Karena reminder R3 saat ini mengirim satu pesan ke grup tanpa recipient list, R5 tidak boleh berpura-pura dapat menerapkan quiet hours individual kepada setiap anggota tanpa perubahan kontrak WhatsAppPort. Implementasi minimal yang aman harus menyimpan policy dan menerapkannya pada target reminder yang dapat diidentifikasi secara sah; jika reminder tetap group-wide, group policy menjadi effective dispatch policy dan user preference mengatur format/locale hanya untuk command response atau future targeted delivery. Perubahan kontrak recipient fan-out ditunda sampai ada requirement dan acceptance test yang membuktikannya.

## Unknowns requiring local verification

Belum ada kontrak final di R3 untuk recipient-specific notifications atau per-user fan-out. Belum ada mekanisme global default yang tersimpan di SQLite. R5 harus memisahkan preference presentation dari permission/side-effect authorization dan tidak mengubah behavior reminder yang belum dapat dipetakan ke recipient secara deterministik.
