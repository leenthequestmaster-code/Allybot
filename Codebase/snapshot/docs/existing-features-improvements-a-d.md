# Existing Features Improvements — Prioritas A sampai D

## Ringkasan

Prioritas improvisasi existing Allybot A sampai D telah diimplementasikan secara bertahap. Perubahan difokuskan pada reliability lintas-plugin, security boundary command, konsistensi UX group, dan hardening storage AFK. Tidak ada fitur batch baru atau Mission Platform yang diimplementasikan dalam rangkaian ini.

Mission Platform tetap dijadwalkan sebagai proyek independen setelah seluruh Batch Update selesai.

## Perubahan yang diterapkan

| Prioritas | Perubahan | Dampak |
|---|---|---|
| **A** | `PluginManager` sekarang membungkus registration command/event setiap plugin dan membersihkannya saat unload, partial load failure, maupun ready failure. Disposer bersifat idempotent agar tetap kompatibel dengan plugin yang sudah melakukan unregister sendiri. | Mencegah duplicate command dan duplicate listener saat reload/recovery. Plugin yang gagal setelah membuka resource tetap memperoleh kesempatan menjalankan `unload()`. |
| **B** | `CommandRegistry.dispatch()` menolak `CoreMessage.fromMe` sebelum prefix parsing dan middleware. | Message yang berasal dari bot tidak dapat memicu command melalui central dispatch. |
| **C** | Pagination `admins`/`members` kini menampilkan effective group prefix. `memberinfo` mendukung mention atau quoted sender; helper role juga memperoleh dukungan quoted target. | Instruksi pagination tidak lagi salah pada group prefix custom, dan behavior reply sesuai dengan pesan bantuan command. |
| **D** | AFK reason dibatasi 500 karakter; message/quoted context dibatasi 2.000 karakter; group name dibatasi 200 karakter; mention disimpan maksimal 100 record per user dan 30 hari; presence write di-debounce 60 detik; mention insert dan `search_count` dibuat atomic; plugin menggunakan record insert yang baru dibuat untuk forwarding. | Mengurangi pertumbuhan database, write amplification, penyimpanan data berlebihan, dan risiko forward menggunakan mention yang salah ketika input datang berdekatan. |

## Compatibility policy

Perubahan mempertahankan public behavior utama. `AfkService.recordMention()` tetap mengembalikan boolean seperti sebelumnya. API tambahan `recordMentionWithResult()` dipakai plugin untuk akurasi forwarding. Constructor `AfkService` menerima options tambahan secara optional, sehingga pemanggilan lama tetap valid.

Native menu, fallback text, reply-number navigation, submenu text-only, Group Setup Mission, dan konfigurasi grup tidak diubah di luar perbaikan UX C. Startup Command Panel, `.bash_profile`, database/session policy, dan deployment flow juga tidak disentuh.

## Data retention AFK

Retention default yang baru berlaku khusus untuk `afk_mentions`, bukan `afk_active`, `afk_presence`, atau `afk_stats`. Pada initialization dan setiap insert mention, service menghapus mention yang lebih tua dari 30 hari serta memangkas histori menjadi maksimal 100 record per user.

Perubahan ini berarti context mention lama dapat dihapus saat service mulai berjalan. Statistik AFK dan leaderboard tetap dipertahankan karena disimpan pada tabel terpisah. Test migrasi timestamp legacy tetap dipertahankan dengan retention window khusus agar menguji konversi timestamp secara terisolasi.

## Test coverage baru

Regression test tambahan mencakup:

| Area | Bukti test |
|---|---|
| Plugin lifecycle | Load → unload → load ulang; command/listener tidak berlipat; partial load failure tetap dapat di-unload. |
| `fromMe` guard | Message bot sendiri menghasilkan `dispatch = false`, handler tidak berjalan, dan tidak ada balasan. |
| Group UX | Pagination menggunakan `##members` ketika effective prefix adalah `##`; `memberinfo` menerima `quotedSenderJid`. |
| AFK hardening | Reason/context truncation, retention jumlah, throttled presence write, atomic mention result, dan migrasi timestamp legacy. |

## Validasi final

| Pemeriksaan | Hasil |
|---|---|
| `npm run typecheck` | Lulus |
| `npm run build` | Lulus |
| `npm run verify:platform` | Lulus |
| `npm test` | **69 lulus, 0 gagal, 0 skipped** |
| `git diff --check` | Lulus |
| Security scan source | Tidak menemukan credential, `.env`, session, arbitrary execution, atau secret runtime pada source yang berubah |

## File runtime yang berubah

Perubahan source hanya berada pada:

```text
src/framework/command-registry.ts
src/framework/plugin-manager.ts
src/framework/plugins/afk.ts
src/framework/plugins/group.ts
src/services/afk-service.ts
```

Test yang diperluas berada pada `tests/framework.test.js`, `tests/group.test.js`, dan `tests/afk.test.js`.

## Status repository dan deployment

Perubahan **belum di-commit, belum di-push ke GitHub, dan belum dideploy ke Pterodactyl Panel**. Working tree juga masih memiliki file dokumentasi/artifact untracked dari pekerjaan sebelumnya. Tidak ada file sensitif yang diunggah atau ditambahkan ke perubahan ini.

Deployment baru aman dilakukan setelah user meninjau hasil validasi dan memberi konfirmasi terpisah. Prosedur deployment tetap menggunakan CI artifact sanitized dan tidak mengubah Startup Command yang dikunci.

## Review akhir

Architecture review menunjukkan perubahan tetap berada pada boundary yang benar: lifecycle di framework, self-message rejection di command boundary, UX di group plugin, dan retention/atomicity di AFK service. Dependency review tidak menambah package baru. Security review tidak menemukan secret leakage atau arbitrary execution. Edge-case review mencakup partial load failure, quoted target, group prefix custom, stale mention, duplicate/rapid input, dan legacy timestamp. Regression review mencakup seluruh suite existing serta test baru. Validation review menghasilkan 69 test lulus.
