# Technical Bot Command Pack — Contract dan Batas Implementasi

## Tujuan

Technical Bot Command Pack memperkuat command operasional yang sudah ada dan menambahkan command teknis yang aman untuk operator. Scope ini tidak mencakup arbitrary shell execution, pembacaan log mentah, restart WhatsApp dari chat, perubahan credential, atau penghapusan database/session.

## Temuan baseline

| Area | Kondisi baseline | Keputusan |
|---|---|---|
| `!ping` | Responder berada di `WhatsAppConnection.handleMessages`, hanya mengenali prefix literal `!`, dan bypass command registry. | Pindahkan behavior ping ke framework command agar mengikuti prefix resolver, central `fromMe` guard, permission/cooldown path, dan test harness. |
| `!diag`/`!health` | Alias yang sama dan hanya mengirim snapshot `connected` serta daftar service. | Pisahkan output: `health` ringkas untuk status publik, `diag` lebih detail tetapi tetap redacted. Flag `DIAGNOSTICS_ENABLED` tetap menjadi gate diagnostics. |
| `!prefix` | Menampilkan prefix aktif dan bahasa, tetapi belum membedakan global fallback dengan group override. | Tampilkan active/global/override source dan instruksi reset yang konsisten. |
| `!setprefix` | Sudah admin-only, validasi simbol, persistent, dan mendukung `default`. | Pertahankan contract persistence/permission; perbaiki usage, normalisasi reset, dan response transisi. |
| `!botprofile` | Belum ada. | Tambahkan alias `bprofile`, safe profile publik tanpa JID, owner, database path, pairing, credential, atau token. |
| `!clearcache` | Belum ada command; adapter memiliki cache in-memory non-auth. | Tambahkan bot-owner-only command yang hanya membersihkan cache runtime ephemeral melalui explicit adapter API. |

## Command contract

| Command | Scope | Permission | Output |
|---|---|---|---|
| `!ping` | Private/group | Public | Response cepat, message dispatch latency, uptime, dan connection state. |
| `!health` | Private/group | Public | Status `HEALTHY` atau `DEGRADED`, connection state, uptime, memory, dan service count. |
| `!diag` | Private/group | Public ketika diagnostics enabled | Health snapshot detail yang tetap tidak memuat secret, JID, database path, atau raw log. |
| `!prefix` | Group | Public | Active prefix, global fallback, dan apakah ada group override. |
| `!setprefix <symbol>` | Group | Group admin | Validasi simbol 1–4 karakter, persistence, actor audit, dan usage reset. |
| `!botprofile` / `!bprofile` | Private/group | Public | Nama bot, runtime Node, uptime, connection state, effective prefix, native-button capability, dan mode chat. |
| `!clearcache` | Private/group | Bot owner | Jumlah cache ephemeral yang dibersihkan; tidak menyentuh auth/session SQLite. |

## Cache boundary

`!clearcache` hanya boleh membersihkan cache berikut:

| Cache | Aman dibersihkan? | Alasan |
|---|---|---|
| Duplicate-message cache | Ya | Hanya deduplication sementara; entry akan terbentuk kembali. |
| Group-name cache | Ya | Hanya metadata display TTL; lookup berikutnya mengisi ulang. |
| Baileys message-retry cache | Ya | Counter retry sementara, bukan credential atau Signal auth key. |
| Auth credentials dan Signal keys | Tidak | Dibutuhkan untuk session WhatsApp dan hanya boleh diubah oleh lifecycle/storage resmi. |
| SQLite messages | Tidak | Merupakan persistence core dan bukan cache command. |
| AFK/platform/group configuration database | Tidak | Data fitur persistent yang tidak boleh dihapus oleh command teknis. |
| Reconnect timer/watchdog | Tidak | Mengubahnya dari chat dapat membuat lifecycle race dan reconnect storm. |

## Redaction policy

Output command tidak menampilkan `BOT_OWNER_JID`, `PAIRING_PHONE_NUMBER`, QR/pairing code, auth credentials, Signal keys, access token, raw database path, raw message body, atau raw logs. Status account cukup ditampilkan sebagai `linked`/`not-linked`, dan status native button cukup sebagai `available`/`unavailable`.

## Compatibility constraints

Behavior `setprefix` yang sudah persistent, admin-only, dan dapat di-reset dengan `default` harus tetap dipertahankan. `health` dan `diag` tetap tidak mengubah database. `clearcache` memakai method optional pada `WhatsAppPort` sehingga FakeCore dan adapter lain tetap kompatibel. `!ping` diproses sekali melalui framework setelah responder transport-level dihapus; link preview tetap dinonaktifkan oleh `sendText`.

## Ide tambahan yang ditunda

Command seperti `!reconnect`, `!reload`, `!logs`, `!eval`, `!exec`, dan `!dbreset` sengaja tidak dimasukkan. Command tersebut berisiko mengubah lifecycle, membocorkan data, atau memberi arbitrary execution dari chat. Jika nanti diperlukan, harus dibuat sebagai operator workflow terautorisasi di luar command publik biasa.
