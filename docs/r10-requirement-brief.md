# R10 Requirement Brief — Onboarding Passport

## Scope

R10 tahap pertama memperkenalkan **Onboarding Passport** sebagai bounded, group-scoped onboarding workflow. Fitur ini menyimpan application terstruktur, bukan passive full-chat memory. Application text dibatasi panjangnya dan memiliki content retention deadline.

Fitur aktif hanya jika feature flag `community.onboarding.core` diaktifkan untuk group terkait. Default state untuk group baru adalah **off**.

## User surface

| Command | Behavior |
|---|---|
| `!onboarding help` | Menampilkan format text-only dan fallback. |
| `!onboarding enable` | Admin group mengaktifkan onboarding. |
| `!onboarding disable` | Admin group menonaktifkan onboarding. |
| `!onboarding apply <text>` | Member membuat satu active application pada group tersebut. |
| `!onboarding status` | Applicant melihat status application miliknya tanpa raw JID. |
| `!onboarding list [status]` | Admin melihat bounded application list dengan keterangan yang tersedia. |
| `!onboarding review <id> approve|deny [revision]` | Admin melakukan review dengan revision-CAS. |
| `!onboarding review <id> reopen [revision]` | Admin membuka kembali application yang berstatus denied. |

`!onboard` adalah alias untuk command utama. Submenu tetap text-only; tidak ada native button baru.

## State model

```text
applied → approved
applied → denied
 denied → applied (reopen)
applied → expired
```

Setiap state transition menaikkan `revision`. Mutation dengan `expectedRevision` yang stale ditolak. Application aktif dibatasi satu per `(group_jid, applicant_jid)` melalui partial unique index.

## Security and privacy contract

Implementation harus mempertahankan group isolation, live admin recheck untuk mutation admin, bounded text/list/rate limits, feature-off fail closed, metadata group-scope verification, audit redaction, and no raw JID/application text/message content in guardrail audit. Application text yang melewati content retention window di-redact tanpa menghapus state atau history hash.

## Explicit non-goals

R10 slice ini tidak mengirim pesan otomatis ke applicant, tidak mengubah group membership, tidak mengaktifkan media download, tidak menambahkan Redis/PostgreSQL dependency, tidak menggunakan eval/exec/shell, dan tidak menyediakan autonomous agent atau passive full-chat memory.

## Rollback

Rollback dilakukan dengan mematikan `community.onboarding.core` per group atau mengembalikan artifact sanitized ke commit sebelumnya. Schema additive dan tabel onboarding dapat dibiarkan hot/archive sesuai audit policy; tidak ada destructive migration pada slice ini.
