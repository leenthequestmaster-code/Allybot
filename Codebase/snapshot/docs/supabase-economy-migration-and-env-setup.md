# Supabase Economy Vela — Migration dan Environment Setup

**Status:** siap ditinjau dan dijalankan manual oleh operator. Migration tidak dijalankan otomatis oleh Allybot, CI, atau deployment. Dokumen ini berlaku untuk implementasi Financial System Vela dengan **Supabase PostgreSQL sebagai sumber kebenaran**, Upstash Redis sebagai cache read-through, dan Allybot sebagai server-side consumer.

## 1. Hasil akhir yang dituju

Alur pembacaan saldo adalah:

```text
!vela / !wallet
      ↓
EconomyService
      ↓
Upstash Redis cache lookup
  ├─ hit  → validasi snapshot → User
  └─ miss → Supabase RPC → validasi → Redis TTL → User
```

Redis hanya mempercepat pembacaan. Redis tidak boleh menghitung, menambah, mengurangi, atau menjadi sumber kebenaran saldo. Seluruh mutation ekonomi harus terjadi di dalam function PostgreSQL yang atomic. PostgreSQL menggunakan row-level locking untuk mencegah dua transaksi mengubah akun yang sama secara tidak aman; `SELECT ... FOR UPDATE` menahan lock sampai transaksi selesai.[1]

Semua tabel Economy berada di schema `public`, tetapi **RLS tetap diaktifkan**, grant langsung ke `anon` dan `authenticated` dicabut, dan hanya role server-side `service_role` yang diberi akses. Supabase menekankan bahwa RLS dan table grants adalah dua pemeriksaan berbeda; membuat policy saja tidak otomatis mencabut grant.[2]

## 2. File migration

Jalankan empat file berikut secara berurutan:

| Urutan | File | Isi |
|---:|---|---|
| 1 | `migrations/supabase/0001_economy_schema.sql` | Table, constraint, index, RLS, dan grant server-only. |
| 2 | `migrations/supabase/0002_economy_functions.sql` | RPC snapshot, policy update, Safe, reward, deposit, withdraw, membership, transfer, rejection, overage seizure, dan history. |
| 3 | `migrations/supabase/0003_economy_transfer_cache_keys.sql` | Refresh RPC accept/reject transfer agar response menyertakan hashed sender/recipient key untuk invalidasi cache kedua account. |
| 4 | `migrations/supabase/0004_economy_pgcrypto_search_path.sql` | Menambahkan schema `extensions` ke `search_path` RPC fingerprint agar `pgcrypto.digest` dapat di-resolve saat runtime, lalu meminta refresh schema cache PostgREST. |

Migration pertama **tidak memasukkan saldo, user, account, transfer, atau ledger row**. Migration kedua hanya membuat function dan grant; migration ketiga hanya mengganti definisi dua RPC transfer secara additive; migration keempat hanya mengubah konfigurasi `search_path` function dan mengirim notifikasi reload schema. Tidak ada migration yang membuat saldo awal.

### Cara menjalankan melalui Supabase Dashboard

Buka **Supabase Dashboard → SQL Editor → New query**. Salin seluruh isi `0001_economy_schema.sql`, jalankan sekali, dan pastikan query berhasil. Setelah itu buat query baru secara berurutan untuk `0002_economy_functions.sql`, `0003_economy_transfer_cache_keys.sql`, dan `0004_economy_pgcrypto_search_path.sql`. Pastikan masing-masing query berhasil sebelum lanjut ke file berikutnya.

Jangan menyalin placeholder secara literal dan jangan menggabungkan migration dengan query seed. Jangan menjalankan `DROP TABLE`, `TRUNCATE`, `DELETE`, atau `DROP FUNCTION` sebagai bagian dari setup awal.

### Cara menjalankan melalui Supabase CLI

Jika repository sudah memakai Supabase CLI, salin empat file tersebut ke direktori migration CLI yang sesuai, lalu gunakan workflow migration resmi. Sebelum `db push`, lakukan review diff pada environment lokal atau branch development. Migration produksi tidak boleh dijalankan dari laptop yang tidak memiliki secret management yang benar.

## 3. Environment server-side

Tambahkan nilai berikut hanya pada environment runtime server Allybot, misalnya environment variable Panel atau secret manager. Jangan memasukkannya ke Git, file `.env` yang di-commit, screenshot, log, atau chat.

```dotenv
# Mengaktifkan command Economy setelah schema dan RPC selesai diverifikasi.
SUPABASE_ECONOMY_ENABLED=false

# URL project Supabase; harus HTTPS.
SUPABASE_URL=https://<project-ref>.supabase.co

# Secret server-side. Gunakan service role sesuai boundary backend Allybot.
SUPABASE_SERVICE_ROLE_KEY=<server-only-secret>

# TTL cache Economy dalam detik; validasi Allybot: 5–300, default 15.
SUPABASE_ECONOMY_CACHE_TTL_SECONDS=15

# Upstash Redis REST cache.
UPSTASH_REDIS_ENABLED=true
UPSTASH_REDIS_REST_URL=https://<redis-endpoint>.upstash.io
UPSTASH_REDIS_REST_TOKEN=<server-only-secret>
```

Allybot membuat client Supabase dengan `persistSession=false`, `autoRefreshToken=false`, dan `detectSessionInUrl=false`, sehingga client ini tidak dipakai sebagai browser session. Service-role key hanya boleh berada di backend; Supabase juga memperingatkan agar secret key tidak digunakan di browser atau diekspos kepada pengguna.[2]

`SUPABASE_ECONOMY_ENABLED=false` adalah nilai rollout awal yang aman. Saat `false`, `EconomyService` tidak membuat client Economy aktif dan command Economy tidak didaftarkan ke menu. Setelah migration serta verification lulus, ubah menjadi `true` pada environment server, lalu lakukan process reload/restart sesuai prosedur operator yang berlaku.

### Environment yang sudah ada dan tetap terpisah

Konfigurasi berikut bukan pengganti `SUPABASE_*` Economy:

```dotenv
# Jalur verifikasi PostgreSQL read-only existing Allybot.
POSTGRES_URL=postgresql://<user>:<password>@<host>:5432/postgres
POSTGRES_POOL_MODE=session

# Jalur permanent WhatsApp chat-log existing Allybot.
NEON_ENABLED=true
NEON_DATABASE_URL=<server-only-secret>
NEON_CHAT_LOG_ENABLED=false
```

`POSTGRES_URL` dipakai oleh verifier read-only existing. `NEON_DATABASE_URL` tetap untuk chat-log permanen. Jangan memakai Neon atau SQLite sebagai sumber saldo Economy.

## 4. Secret handling

Gunakan secret yang diambil dari Supabase Project Settings dan Upstash Console melalui kanal secret environment server. Jangan membuat service-role key baru hanya untuk menyalin ke source code. Jika key pernah masuk ke Git, log, screenshot, atau chat, anggap key terekspos dan lakukan revoke/rotate sebelum mengaktifkan Economy.

| Nilai | Boleh di client/browser? | Boleh di repository? | Fungsi |
|---|---|---|---|
| `SUPABASE_URL` | Tidak untuk konfigurasi bot ini; perlakukan sebagai server config. | Hanya placeholder pada `.env.example`. | Endpoint project Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Tidak.** | **Tidak.** | Akses backend untuk RPC Economy. |
| `UPSTASH_REDIS_REST_URL` | Tidak untuk bot backend. | Hanya placeholder pada `.env.example`. | Endpoint REST Redis. |
| `UPSTASH_REDIS_REST_TOKEN` | **Tidak.** | **Tidak.** | Auth REST Redis. |

Nilai secret tidak boleh dicetak saat menjalankan `env`, `printenv`, `config`, health check, atau debug log. Health check cukup mencetak status `PASS` atau `FAIL` yang sudah disanitasi.

## 5. Aktivasi policy Economy per grup

Schema menggunakan policy per scope agar mengaktifkan Economy untuk satu grup tidak otomatis mengaktifkan semua grup. Policy baru default-nya `enabled=false`. Scope dan actor disimpan sebagai SHA-256 hex key, bukan raw JID. Migration `0004` memastikan function yang membuat request fingerprint dapat menemukan `pgcrypto.digest` pada schema `extensions`; tanpa perubahan ini function dapat terdaftar tetapi gagal saat dipanggil.

Function operator yang tersedia adalah:

```sql
public.economy_set_group_policy(
  p_scope_key TEXT,
  p_enabled BOOLEAN,
  p_operation_key TEXT,
  p_actor_key TEXT,
  p_reason TEXT
)
```

Gunakan hanya melalui jalur operator/server yang telah diotorisasi. Hash dapat dibuat secara lokal tanpa menyimpan raw JID di file atau mencetaknya ke log. Contoh shell berikut membaca nilai secara tersembunyi dari input terminal dan hanya menampilkan hash hasilnya:

```bash
read -r -s -p 'Group JID: ' GROUP_JID; printf '\n'
SCOPE_KEY="$(printf '%s' "$GROUP_JID" | sha256sum | awk '{print $1}')"
unset GROUP_JID
printf 'SCOPE_KEY=%s\n' "$SCOPE_KEY"
```

Lakukan cara yang sama untuk actor key menggunakan actor identifier yang sudah disetujui, lalu hapus nilai sementara dari shell. Jangan memasukkan raw JID ke migration, screenshot, ticket, atau command history.

Template SQL berikut sengaja memakai placeholder dan **tidak boleh dijalankan sebelum diganti dengan hash yang benar**:

```sql
SELECT public.economy_set_group_policy(
  '<64-hex-scope-key>',
  TRUE,
  'policy-enable-<unique-operation-key>',
  '<64-hex-actor-key>',
  'Aktivasi Economy setelah consent dan review grup'
);
```

Operation key harus unik untuk setiap perubahan. Mengulang operation key yang sama dimaksudkan sebagai retry idempotent terhadap operasi yang sama, bukan cara untuk menjalankan policy berbeda. Jangan membuat public command yang menerima arbitrary scope key atau arbitrary actor key sebelum authorization owner/developer dan audit trail terhubung.

## 6. Verification setelah migration

### 6.1 Verifikasi dari repository

Dari root repository Allybot, jalankan:

```bash
npm run typecheck
npm run build
npm run verify:supabase-access
npm run verify:upstash-redis
npm test
npm audit --omit=dev --audit-level=high
```

Output yang diharapkan untuk access boundary existing adalah pola berikut:

```text
SUPABASE_ACCESS=PASS (readonly:read-only-select-1, readwrite:client-initialized)
```

Output Redis harus menunjukkan health check berhasil tanpa mencetak URL lengkap atau token. `npm test` harus lulus tanpa test baru yang memakai credential nyata.

### 6.2 Verifikasi schema secara read-only

Setelah menjalankan migration, gunakan SQL Editor dengan query inspeksi read-only berikut:

```sql
SELECT to_regclass('public.economy_group_policies') AS group_policies,
       to_regclass('public.economy_accounts') AS accounts,
       to_regclass('public.economy_operations') AS operations,
       to_regclass('public.economy_ledger_entries') AS ledger_entries,
       to_regclass('public.economy_transfers') AS transfers;

SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name LIKE 'economy_%'
ORDER BY routine_name
LIMIT 50;

SELECT COUNT(*) AS economy_account_rows
FROM public.economy_accounts;
```

Hasil awal yang diharapkan adalah lima table terdeteksi, seluruh function Economy terdaftar, dan `economy_account_rows` bernilai `0` sebelum ada provisioning atau operasi ekonomi. Selain itu, RPC mutation fingerprint harus memiliki `search_path=public, extensions`. Query ini tidak mengubah data.

### 6.3 Verifikasi RPC read

Gunakan dua hash fixture yang tidak merepresentasikan identifier produksi saat melakukan smoke test. Contoh berikut hanya memeriksa bentuk API dan tidak membuat row:

```sql
SELECT public.economy_get_account_snapshot(
  '<64-hex-scope-fixture>',
  '<64-hex-subject-fixture>'
);
```

Jika policy belum aktif, response harus memiliki `economy_enabled=false`. Jika policy aktif tetapi account belum ada, response harus mengembalikan saldo awal `0` tanpa insert otomatis.

## 7. Rollout yang disarankan

| Tahap | Flag | Tindakan | Exit criteria |
|---:|---|---|---|
| 0 | `false` | Jalankan migration dan verifikasi schema. | Table, function, RLS, grant, dan function list sesuai. |
| 1 | `false` | Verifikasi Supabase client dan Redis health. | Access check dan Redis check lulus. |
| 2 | `false` | Aktifkan satu policy test menggunakan hashed fixture atau grup yang sudah disetujui. | RPC read mengembalikan `economy_enabled=true`; tidak ada raw identifier di log. |
| 3 | `true` | Aktifkan server-side Economy dan lakukan smoke test `!vela`. | Output benar, cache miss/hit benar, tidak ada perubahan saldo ilegal. |
| 4 | `true` | Tambahkan mutation command hanya setelah contract test concurrency dan ledger selesai. | Setiap mutation punya operation key, ledger entry, lock, audit, dan invalidation. |

Mulai dari satu grup yang sudah memberikan consent. Jangan langsung mengaktifkan seluruh grup produksi. Cache TTL 15 detik dipilih sebagai default konservatif; ubah hanya setelah workload dan toleransi stale read diukur.

## 8. Rollback dan recovery

Untuk rollback code atau konfigurasi, ubah `SUPABASE_ECONOMY_ENABLED=false`, lakukan reload/restart process sesuai runbook, dan biarkan tabel tetap ada. Karena command tidak aktif saat flag `false`, ini adalah rollback yang paling reversibel dan tidak menghapus audit data.

Jika Redis gagal, `EconomyService` melakukan cache miss/fallback ke Supabase. Jika Supabase gagal, service tidak mengirim output sukses dan tidak memperbarui cache. Jangan mengatasi outage dengan menulis saldo ke SQLite atau Redis secara manual.

Jangan melakukan `DROP TABLE`, `TRUNCATE`, atau penghapusan ledger sebagai rollback rutin. Structural rollback memerlukan backup, review dampak foreign key, persetujuan eksplisit, dan prosedur recovery terpisah. PostgreSQL mendeteksi deadlock akibat lock yang saling menunggu; function transfer dalam migration mengunci sender dan recipient berdasarkan urutan key yang konsisten untuk mengurangi risiko tersebut.[1]

## 9. Batasan migration ini

Migration ini menyediakan boundary dan RPC database, sementara wiring bot sekarang menyediakan snapshot read-through serta command write yang tetap feature-gated: `!bank open`, `setor`, `tarik`, `kirim`, `terima`, `tolak`, `membership`, dan `riwayat`, ditambah command admin tersembunyi `!bankpolicy`, `!bankreward`, dan `!banksweep`. Command tersebut belum dapat digunakan sebelum migration diaplikasikan, environment aktif, policy grup diaktifkan, dan smoke test terkontrol lulus. Migration belum menyediakan scheduler untuk memanggil `economy_sweep_overage`; pemanggilan seizure harus datang dari worker/job terotorisasi pada fase berikutnya, bukan dari user input langsung.

Sebelum full release Economy, tambahkan contract test Supabase/pgTAP untuk grants dan RLS, integration test terhadap database branch, concurrency test untuk transfer dua arah, test retry operation key, test invalidation setelah mutation, dan review owner/developer authorization. Function PostgreSQL sebaiknya tetap memakai schema-qualified references dan privilege execution terbatas; PostgreSQL mendokumentasikan bahwa privilege default function dapat terbuka ke `PUBLIC`, sehingga revoke/grant harus dilakukan dalam migration yang sama.[3]

## References

[1]: https://www.postgresql.org/docs/current/explicit-locking.html "PostgreSQL 18 — Explicit Locking"
[2]: https://supabase.com/docs/guides/database/postgres/row-level-security "Supabase — Row Level Security"
[3]: https://www.postgresql.org/docs/current/sql-createfunction.html "PostgreSQL 18 — CREATE FUNCTION"
[4]: https://supabase.com/docs/guides/database/functions "Supabase — Database Functions"
