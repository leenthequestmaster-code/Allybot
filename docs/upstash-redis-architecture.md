# Upstash Redis Architecture

## Status

Integrasi tahap awal telah ditambahkan sebagai **optional service**. Service default-off, belum dipakai oleh command atau event business, dan tidak menggantikan SQLite, Neon, maupun Supabase.

## Boundary

`UpstashRedisService` adalah satu-satunya boundary aplikasi untuk client `@upstash/redis`. Composition root mendaftarkannya melalui service lifecycle framework. Plugin atau service lain tidak boleh membuat instance client Upstash secara langsung.

Pada tahap ini service hanya menyediakan health-check bounded. Tidak ada key bisnis, cache metadata, rate-limit state, queue, distributed lock, atau data chat yang ditulis ke Redis. Dengan demikian, penambahan dependency tidak mengubah behavior Allybot ketika flag tetap nonaktif.

## Konfigurasi

| Environment variable | Fungsi | Default/batas |
|---|---|---|
| `UPSTASH_REDIS_ENABLED` | Mengaktifkan service | `false` |
| `UPSTASH_REDIS_REST_URL` | URL REST database Upstash | Wajib ketika enabled; harus `https://` |
| `UPSTASH_REDIS_REST_TOKEN` | Token REST database Upstash | Wajib ketika enabled; server-side only |
| `UPSTASH_REDIS_TIMEOUT_MS` | Timeout per health-check attempt | 1.000–10.000 ms; default 5.000 |
| `UPSTASH_REDIS_MAX_ATTEMPTS` | Jumlah attempt termasuk attempt pertama | 1–3; default 2 |
| `UPSTASH_REDIS_RETRY_DELAY_MS` | Jeda bounded antar-attempt | 50–2.000 ms; default 100 |

Credential tidak boleh dimasukkan ke repository, CI artifact, console log, public config, atau chat. Nilai environment harus dipasang melalui secret store/Panel environment yang sesuai.

## Health states

Service mengekspos state sanitized: `disabled`, `healthy`, atau `unhealthy`. Failure reason yang boleh keluar adalah `timeout`, `unavailable`, atau `unexpected-response`. URL, token, response body, dan raw error tidak dikembalikan.

`npm run verify:upstash-redis` menghasilkan salah satu output operasional berikut:

- `UPSTASH_REDIS_VERIFY=DISABLED` ketika feature flag false atau belum dikonfigurasi.
- `UPSTASH_REDIS_VERIFY=PASS (attempts=N)` ketika health-check menerima respons `PONG`.
- `UPSTASH_REDIS_VERIFY=FAIL (error=...)` ketika health-check gagal setelah retry bounded.

## Failure behavior

Redis tidak menjadi dependency blocking untuk inbound WhatsApp, SQLite, Neon writer, atau fitur yang tidak membutuhkan Redis. Timeout membatalkan request melalui `AbortController`. Retry dibatasi maksimal tiga attempt dan menggunakan delay bertambah secara linear berdasarkan nomor attempt. Tidak ada infinite retry atau background timer pada service tahap awal.

Jika Redis mengalami outage, fitur yang kelak menggunakannya harus menentukan fallback per use case. Cache boleh menjadi cold dan kembali ke authoritative source. Rate limit yang berkaitan dengan keamanan tidak boleh fail-open tanpa keputusan eksplisit dan test khusus.

## Use case berikutnya

Setelah credential terpasang dan health-check canary berhasil, pilih hanya satu use case pertama:

1. **Cache metadata grup**, menggunakan cache-aside, TTL bounded, dan fallback ke adapter WhatsApp; atau
2. **Rate limit lintas proses**, hanya jika deployment multi-instance atau kebutuhan shared state terbukti.

`@upstash/ratelimit` tidak otomatis ditambahkan. Existing `PlatformGuardrailService` sudah menyediakan rate profile lokal; Redis rate limit harus dibuktikan perlu melalui baseline workload terlebih dahulu.

Distributed lock dan queue ditunda karena menambah failure mode, ownership, dan kebutuhan observability. Keduanya memerlukan ADR terpisah sebelum implementasi.

## Verification and rollback

Verifikasi lokal mencakup typecheck, build, default-off, configuration validation, healthy fake client, bounded retry, timeout abort, dan secret-safe logging. Verifikasi production membutuhkan credential yang dipasang server-side dan tidak boleh digantikan dengan token di chat.

Rollback tahap ini dapat dilakukan dengan mengatur `UPSTASH_REDIS_ENABLED=false` atau mengembalikan artifact commit. Rollback tidak memerlukan perubahan Startup Command Panel atau `.bash_profile`.

## Research provenance

Desain client didasarkan pada `@upstash/redis` `1.38.2`, package resmi berbasis HTTP/REST. Dokumentasi package menyatakan konfigurasi client menggunakan `url` dan `token`, mendukung `AbortSignal`, dan menyediakan `ping()`. Dokumen upstream yang perlu direfresh ketika dependency berubah:

- https://upstash.com/docs/redis/howto/connect-with-upstash-redis
- https://upstash.com/docs/redis/features/restapi
- https://upstash.com/docs/redis/sdks/ts/overview
- https://www.npmjs.com/package/@upstash/redis
