# Owner-Controlled Developer Debug Mode — Arsitektur dan Trust Boundary

## Keputusan arsitektur

Allybot akan memiliki dua permukaan command teknis yang berbeda:

| Permukaan | Pengguna | Tujuan | Default exposure |
|---|---|---|---|
| **Public Technical Commands** | Semua pengguna sesuai scope command | Status sederhana dan bantuan operasional yang aman | Boleh terlihat di menu jika relevan |
| **Developer Debug Commands** | Target yang diaktifkan Developer Mode oleh Owner | Observability internal, diagnosis, dan inspeksi metadata runtime | Tidak tampil di menu publik; idealnya hanya private chat |

Pemisahan ini bukan sekadar mengganti nama command. Ia memisahkan **tingkat informasi**, **permission**, **audit**, **rate limit**, dan **risiko perubahan state**. Public command harus aman apabila dibaca pengguna biasa. Developer Mode boleh memberikan detail lebih dalam, tetapi tetap tidak boleh menjadi jalan pintas untuk mengambil alih proses, session, database, atau host.

> Developer Mode berarti **broad observability dengan controlled operations** yang diaktifkan oleh Owner, bukan posisi mandiri dan bukan akses tanpa batas.

Prinsip tersebut konsisten dengan OWASP Authorization Cheat Sheet yang menekankan least privilege, deny-by-default, dan validasi authorization pada setiap request.[1] NIST SP 800-171r3 juga membatasi privileged accounts pada personel atau role yang ditentukan, mencegah non-privileged users menjalankan privileged functions, dan mewajibkan logging terhadap privileged function execution.[2]

## Trust model

**Developer Mode bukan role atau posisi independen.** Ia adalah mode operasional milik Owner, seperti Opsi Pengembang pada smartphone. Owner tetap menjadi satu-satunya otoritas utama yang dapat mengaktifkan mode, menentukan siapa yang boleh memakai mode tersebut, memilih scope observability atau operator, menetapkan expiry, dan mencabut akses.

Identitas pengguna yang menerima akses hanyalah **target sesi Developer Mode**, bukan owner baru dan bukan administrator permanen. Akses tidak boleh diberikan hanya karena username, label, atau pesan mengandung kata `developer`; runtime harus memeriksa activation record atau allowlist yang dibuat oleh Owner.

Model capability minimal yang direkomendasikan adalah:

| Capability mode | Kemampuan | Contoh |
|---|---|---|
| `developer-mode.observer` | Read-only observability dan diagnosis selama mode aktif | Runtime snapshot, feature registry, command registry metadata, connection state, cache info, safe error summary, storage health read-only |
| `developer-mode.operator` | Tindakan maintenance terbatas yang diaktifkan Owner | Clear ephemeral cache, menjalankan health probe, membuat diagnostic correlation record |
| `bot.owner` | Otoritas sumber untuk mengaktifkan/mencabut mode dan mengelola konfigurasi sensitif | Grant/revoke activation, memilih scope, emergency disable, konfigurasi bot |

`developer-mode.operator` tidak otomatis boleh restart, reconnect, logout, menghapus data, membaca credential, atau menjalankan kode. Setiap operasi tetap harus melewati activation scope, allowlist command, expiry check, dan permission check terpusat.

## Public Technical Commands

Command public harus memberi hasil yang mudah dipahami dan tidak memerlukan pengetahuan internal Allybot.

| Command | Fungsi | Data yang boleh ditampilkan |
|---|---|---|
| `!ping` | Menguji respons dan latency | Latency, connection state, uptime |
| `!health` | Health check singkat | Status sehat/degraded, service count, uptime, memory agregat |
| `!diag` | Diagnosis framework yang masih aman | Status, runtime version, platform umum, mode chat; hanya jika diagnostics enabled |
| `!prefix` | Melihat prefix aktif | Prefix aktif, global/override source, instruksi reset |
| `!setprefix` | Mengubah prefix grup | Hanya admin grup; persistent dan tervalidasi |
| `!botprofile` / `!bprofile` | Profil publik bot | Nama, role, runtime, capability umum, status koneksi |

`!clearcache` tetap dianggap privileged maintenance, bukan public command biasa, walaupun secara teknis saat ini memakai nama command langsung. Ia harus tetap owner-only sampai Owner mengaktifkan scope operator Developer Mode untuk operasi tersebut.

## Developer Debug Commands

Command Developer Mode sebaiknya memakai namespace eksplisit agar tidak bercampur dengan command publik. Bentuk yang direkomendasikan adalah `!dev <subcommand>` atau `!debug <subcommand>`, bukan puluhan command global dengan prefix yang mudah dipanggil tanpa sengaja. Namespace ini hanya aktif bagi target yang memiliki activation Developer Mode yang masih berlaku.

| Command | Level | Fungsi | Output boundary |
|---|---|---|---|
| `!dev help` | Observer | Daftar debug command yang diizinkan untuk target Developer Mode tersebut | Metadata command saja |
| `!dev runtime` | Observer | Runtime snapshot detail | Node, uptime, memory, process state; tanpa path rahasia |
| `!dev connection` | Observer | Status dan riwayat singkat lifecycle WhatsApp | State, timestamp, safe reason code; tanpa QR, pairing code, raw error, atau credential |
| `!dev features` | Observer | Daftar plugin/feature terdaftar | Name, version, category, status, dependency names |
| `!dev commands` | Observer | Daftar command registry dan permission metadata | Name, alias, category, permission; tanpa source code atau handler body |
| `!dev cacheinfo` | Observer | Jumlah dan TTL cache ephemeral | Count dan TTL; tidak menampilkan key atau payload |
| `!dev storagehealth` | Observer | Pemeriksaan storage read-only | Validity, schema status, aggregate counts; tanpa database path, row content, auth keys |
| `!dev errors <id>` | Observer | Mencari error berdasarkan correlation ID | Safe error code dan timestamp; tanpa raw message body atau secret |
| `!dev audit` | Observer | Melihat ringkasan audit event developer | Actor hash, action, decision, timestamp, correlation ID |
| `!dev clearcache` | Operator | Membersihkan cache ephemeral | Hanya adapter allowlist; audit wajib; tidak menyentuh auth/session/database |

`!dev logs`, jika kelak diperlukan, tidak boleh mengirim raw log langsung ke WhatsApp. Ia harus mengirim ringkasan event terstruktur dengan redaction dan correlation ID. OWASP Logging Cheat Sheet menyarankan agar source code, session identifiers, access tokens, passwords, database connection strings, encryption keys, dan sensitive personal data tidak dicatat secara langsung; data tersebut harus dihapus, dimask, disanitasi, di-hash, atau dienkripsi.[3]

## Developer Mode lifecycle

Developer Mode tidak boleh permanen secara default. Tahap pertama dapat menggunakan static activation allowlist yang hanya dibaca saat startup. Tahap berikutnya dapat menambahkan Owner-managed activation record dengan TTL, target identity, scope capability, alasan aktivasi, actor Owner, dan revoke timestamp.

| Lifecycle | Otoritas | Ketentuan |
|---|---|---|
| Activate | Owner | Harus menyebut target identity, capability scope, alasan, dan expiry |
| Use | Target Developer Mode | Setiap command diperiksa ulang terhadap activation yang aktif, scope, dan private-chat boundary |
| Audit | Runtime | Record activation, allow/deny, command, actor hash, target scope, result, dan correlation ID |
| Revoke | Owner | Revoke harus berlaku pada request berikutnya tanpa restart bila activation record sudah tersedia |
| Expiry | Runtime | Activation expired otomatis ditolak dan dicatat |
| Emergency disable | Owner | Satu kill switch menonaktifkan seluruh Developer Mode |

Untuk MVP, command Developer Mode sebaiknya hanya dapat digunakan melalui **private chat**. Pemanggilan dari grup ditolak agar diagnostic metadata tidak bocor ke seluruh anggota grup dan agar target activation lebih mudah diaudit.

## Redaction levels

| Level | Permitted data |
|---|---|
| Public | Status, uptime, count agregat, capability umum, prefix konteks |
| Developer-safe | Runtime metadata, feature/command metadata, safe reason code, aggregate storage health, cache count/TTL |
| Owner-only sensitive | Konfigurasi administrasi tertentu yang memang diperlukan untuk mengelola bot; tetap bukan raw credential |
| Never exposed through WhatsApp | Password, token, QR, pairing code, auth creds, Signal keys, database path, raw database rows, raw message body, source code, arbitrary command output |

## Guardrails wajib

Developer Debug Pack harus menggunakan permission resolver terpusat dan default-deny. Ia tidak boleh memeriksa string sender secara tersebar di setiap handler. Setiap command harus memiliki command-level allowlist, cooldown, input validation, bounded output, dan audit event. Command yang mengubah state wajib memerlukan confirmation token atau explicit operation key jika tindakan tersebut kelak diperluas.

Tidak boleh ada `eval`, `exec`, shell command, arbitrary file operation, arbitrary HTTP request, `!dbreset`, `!logout`, `!reconnect`, atau `!reload` melalui chat. Command semacam itu melampaui observability dan dapat mengubah lifecycle atau session security.

## Roadmap implementasi independen

| Fase | Fokus |
|---|---|
| **DD-0** | Contract permission, namespace `!dev`, redaction policy, audit event schema, dan output limits |
| **DD-1** | Static developer allowlist dan `observer` permission; implementasi `help`, `runtime`, `features`, `commands`, `cacheinfo` |
| **DD-2** | `storagehealth`, `connection`, safe error correlation, dan audit summary |
| **DD-3** | Owner-managed Developer Mode activation/revoke dengan TTL dan emergency disable |
| **DD-4** | Owner-enabled operator actions yang sangat terbatas, dimulai dari clear ephemeral cache |

Developer Debug Pack ini tetap merupakan bagian dari technical operations, bukan Mission Platform. Mission Platform tetap independen dan dikerjakan setelah seluruh Batch Update selesai.

## References

[1]: https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html "OWASP Authorization Cheat Sheet"
[2]: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/800-171r3/NIST.SP.800-171r3.html "NIST SP 800-171r3"
[3]: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html "OWASP Logging Cheat Sheet"
