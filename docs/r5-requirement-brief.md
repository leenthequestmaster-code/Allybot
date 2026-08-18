# R5 Requirement Brief — Personalization + Notification Policy

## Tujuan

R5 memberi kontrol presentasi dan notifikasi yang dapat dipilih pengguna atau admin grup tanpa mengubah permission, tanpa membuka side effect baru, dan tanpa menyimpan passive full-chat memory. Fitur diaktifkan per grup melalui feature flag `group.personalization.core` yang **default-off**.

## Scope

Preference personal disimpan per `(groupJid, userJid)` untuk language (`id|en`), strict-IANA timezone, quiet hours, notification enablement, verbosity (`brief|normal|detailed`), dan accessibility format (`plain|accessible`). Group policy menyimpan field yang sama per group. Nilai yang tidak diatur tidak disalin ke database; resolver menerapkan precedence **explicit user override → group policy → global default**.

Notification policy hanya mengatur apakah reminder/event yang sudah diizinkan oleh fitur asal boleh dikirim pada saat itu. Policy tidak memberikan permission, tidak mem-bypass admin check, tidak mengaktifkan provider, dan tidak dapat membuat mutation WhatsApp. Reminder R3 yang group-wide memakai group policy; user quiet hours tidak diperlakukan sebagai filter terhadap seluruh anggota karena `WhatsAppPort` saat ini tidak memiliki recipient fan-out contract.

## Command contract

Semua command R5 bersifat text-only dan selalu memiliki reply teks sebagai fallback. `!personalization` menampilkan status, sedangkan `!setpersonalization on|off` hanya untuk admin grup. Pengguna dapat memakai `!myprefs`, `!mylanguage <id|en>`, `!mytimezone <IANA timezone>`, `!quiet <HH:mm-HH:mm|off>`, `!notify <on|off>`, `!verbosity <brief|normal|detailed>`, dan `!format <plain|accessible>`. Admin grup mengatur policy melalui `!preferences <language|timezone|quiet|notify|verbosity|format> <nilai>`; `!preferences quiet off` mereset quiet hours.

Ketika feature off, command operasional tidak menyimpan preference dan membalas instruksi enablement. Input invalid ditolak dengan pesan format yang dapat langsung digunakan. Command tidak memakai button; navigasi menu tetap mengikuti aturan global Allybot.

## Invariants

| Invariant | Required behavior |
|---|---|
| Default-off | Tidak ada preference/policy write atau notification suppression aktif sebelum flag group dinyalakan. |
| Authorization separation | Policy tidak mengubah permission atau safe action authorization. Group policy hanya dapat diubah melalui command yang telah melalui `group.admin`. |
| Timezone | `UTC` atau identifier canonical yang didukung `Intl.supportedValuesOf('timeZone')`; offset seperti `+07:00`, whitespace, dan unknown identifier ditolak. |
| Quiet hours | Interval normal dan overnight dievaluasi di timezone efektif; saat quiet aktif reminder tetap `scheduled`, bukan hilang atau ditandai sent. |
| Precedence | User override menang atas group policy, yang menang atas global default, per field. |
| Isolation | Preference user dan group tidak bocor lintas scope. |
| Audit privacy | Audit hanya memakai hash actor/resource dari guardrail dan metadata bounded; raw JID, nomor telepon, message content, credential, dan raw error tidak disimpan. |
| Compatibility | Tabel R5 additive; CollaborationService memakai personalization secara opsional sehingga fixture dan deployment R3 tanpa service R5 tetap dapat berjalan. |

## Non-goals

R5 tidak menambahkan AI/provider call, passive chat ingestion, generic notification fan-out, WhatsApp message deletion, database dump, credential access, eval/exec/shell, atau perubahan Startup Command Panel. Black-box WhatsApp acceptance tetap ditunda sampai seluruh roadmap batch selesai.

## References

[1]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat "MDN Intl.DateTimeFormat()"
[2]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/supportedValuesOf "MDN Intl.supportedValuesOf()"
[3]: https://tc39.es/ecma402/ "ECMA-402 ECMAScript Internationalization API Specification"
[4]: https://www.iana.org/time-zones/ "IANA Time Zone Database"
