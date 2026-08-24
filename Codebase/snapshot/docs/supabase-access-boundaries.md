# Supabase Access Boundaries

## Keputusan

Allybot menggunakan dua boundary akses yang terpisah. Boundary pertama adalah koneksi PostgreSQL read-only yang sudah ada dan hanya menjalankan `SELECT 1 AS ok LIMIT 1`. Boundary kedua adalah client Supabase Data API server-side yang dibuat dari `SUPABASE_URL` dan `SUPABASE_SERVICE_ROLE_KEY`; client ini disiapkan untuk operasi write terotorisasi di masa depan, tetapi pada tahap ini tidak memanggil `insert`, `update`, `delete`, RPC write, schema change, atau migration.

Supabase membedakan connection string PostgreSQL dari API key. Connection string digunakan oleh PostgreSQL client, sedangkan service-role/secret key digunakan oleh komponen backend untuk akses Data API dengan hak elevated dan dapat melewati Row Level Security. Karena itu, service-role key hanya boleh berada di environment server yang dikendalikan operator, bukan di source code, artifact, browser, log, chat, atau bundle publik.[^1][^2]

## Environment contract

```env
# Existing read-only PostgreSQL verification path
POSTGRES_URL=postgresql://<user>:<password>@<host>:<port>/postgres
POSTGRES_POOL_MODE=session

# Separate server-side Supabase Data API path for future guarded writes
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only-secret-key>
```

`POSTGRES_URL` dan `SUPABASE_SERVICE_ROLE_KEY` tidak saling menggantikan. Keduanya wajib diisi bersama hanya ketika command access verification dijalankan. Nilai sebenarnya tidak boleh dimasukkan ke repository atau sanitized artifact.

## Runtime behavior

Command berikut melakukan dua hal terbatas:

```bash
npm run verify:supabase-access
```

Pertama, command menjalankan query read-only pada boundary PostgreSQL dan memeriksa hasil `1`. Kedua, command membuat client Supabase server-side dengan konfigurasi session yang tidak menyimpan session, tidak melakukan auto-refresh token, dan tidak membaca session dari URL. Client tersebut hanya diinisialisasi; tidak ada operasi data write yang dijalankan.

Output sukses memiliki bentuk berikut tanpa mencetak key:

```text
SUPABASE_ACCESS=PASS (readonly:read-only-select-1, readwrite:client-initialized)
```

Jika salah satu konfigurasi tidak ada atau URL bukan HTTPS, command berhenti fail-closed. Jika query read-only gagal, client write tidak dianggap tervalidasi. Tidak ada retry write dan tidak ada fallback ke SQLite.

## Write authorization boundary

Modul `src/supabase-read-write.ts` adalah satu-satunya factory untuk client service-role pada tahap ini. Call site-nya adalah command verifikasi konfigurasi dan `EconomyService` read-only yang memanggil RPC snapshot terkontrol ketika feature flag aktif. Implementasi fitur write berikutnya wajib memiliki command/service terpisah, validasi input, authorization, idempotency, audit redaction, bounded retry, dan test negative sebelum factory dipakai untuk mutation data.

SQLite tetap menjadi storage runtime Allybot. Supabase World Database tetap berada pada boundary terpisah dan belum memiliki schema atau tabel yang dibuat oleh perubahan ini.

## Economy read-through boundary

Financial System Economy menggunakan `SUPABASE_ECONOMY_ENABLED` sebagai feature flag terpisah. Saat aktif, `EconomyService` memanggil RPC read-only `economy_get_account_snapshot` pada Supabase PostgreSQL menggunakan hash SHA-256 dari scope grup dan subject; raw JID tidak dikirim sebagai key database atau suffix Redis. Snapshot yang lolos validasi ditulis ke Upstash Redis dengan TTL bounded dan read berikutnya dapat dilayani dari cache. Redis bukan sumber kebenaran saldo: cache miss, cache invalidation, timeout, atau outage Redis selalu kembali ke Supabase.

Alur read yang digunakan adalah:

```text
EconomyPlugin → EconomyService → Redis cache lookup
                                      ├─ hit  → validate snapshot → User
                                      └─ miss → Supabase RPC → validate → Redis TTL → User
```

Pada tahap ini migration Economy hanya membuat account projection kosong dan RPC pembacaan; tidak ada saldo atau data ekonomi yang diinsert. Mutation ekonomi seperti reward, deposit, withdraw, transfer, membership, reversal, dan seizure harus ditambahkan melalui RPC transactional terpisah sebelum command write diaktifkan. Setelah mutation berhasil di Supabase, cache account terkait wajib di-invalidate atau di-prime dengan snapshot terbaru. Jika Supabase gagal, bot tidak boleh mengirim output sukses dan tidak boleh memperbarui cache.

## Security and rollback

Service-role/secret key memberikan akses elevated dan dapat bypass RLS. Karena itu, key harus disimpan sebagai secret environment pada runtime server dan dipisahkan per backend component jika memungkinkan.[^1] Tidak ada secret yang diubah oleh perubahan ini. Rollback cukup dilakukan dengan menghapus command, factory, dan environment contract pada commit ini; tidak ada migration atau data rollback yang diperlukan.

## References

[^1]: [Supabase — Understanding API keys](https://supabase.com/docs/guides/getting-started/api-keys)
[^2]: [Supabase — Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres)
[^3]: [Supabase — Postgres Roles](https://supabase.com/docs/guides/database/postgres/roles)
