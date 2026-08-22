# Upstash Redis Architecture

## Status

Integrasi Redis Upstash sekarang memiliki dua lapisan:

1. **Health-check dan lifecycle service**, yang memverifikasi koneksi REST secara bounded.
2. **Operational primitives**, yaitu cache TTL, deduplikasi atomic, fixed-window rate limit atomic, counter TTL, ownership-safe lock, dan bounded queue primitive.

Feature flag tetap dikontrol oleh `UPSTASH_REDIS_ENABLED`. SQLite tetap menjadi database runtime utama, Neon tetap menjadi penyimpanan chat-log consent-aware, dan Supabase tetap mengikuti boundary yang sudah ditetapkan.

## Boundary dan data flow

`UpstashRedisService` adalah boundary tunggal untuk client `@upstash/redis`. WhatsApp adapter menerima service tersebut secara optional untuk cache nama grup dan deduplikasi event. Group Safety menerima service melalui registry secara optional untuk shared anti-spam window dan deduplikasi dry-run case. Semua path tetap memiliki fallback lokal ketika Redis disabled, unsupported, timeout, atau unavailable.

Alur message existing dipertahankan: normalisasi → duplicate filtering → dispatch listener. Redis hanya menjadi shared duplicate window; cache lokal tetap dipakai untuk mengurangi request berulang dalam satu proses.

## Konfigurasi

| Environment variable | Fungsi | Default/batas |
|---|---|---|
| `UPSTASH_REDIS_ENABLED` | Mengaktifkan service dan fitur shared state | `false` |
| `UPSTASH_REDIS_REST_URL` | URL REST database Upstash | Wajib ketika enabled; harus `https://` tanpa userinfo |
| `UPSTASH_REDIS_REST_TOKEN` | Token REST database Upstash | Wajib ketika enabled; server-side only |
| `UPSTASH_REDIS_TIMEOUT_MS` | Timeout health-check | 1.000–10.000 ms; default 5.000 |
| `UPSTASH_REDIS_OPERATION_TIMEOUT_MS` | Timeout cache/limiter/lock/queue | 100–2.000 ms; default 1.000 |
| `UPSTASH_REDIS_MAX_ATTEMPTS` | Attempt health-check | 1–3; default 2 |
| `UPSTASH_REDIS_RETRY_DELAY_MS` | Jeda antar-attempt | 50–2.000 ms; default 100 |
| `UPSTASH_REDIS_KEY_PREFIX` | Namespace seluruh key | `allybot:v1`, maksimal 40 karakter |

Credential tidak boleh dimasukkan ke repository, CI artifact, console log, public config, atau chat. Key Redis menggunakan prefix dan suffix hash SHA-256 terpotong; raw JID/nomor tidak menjadi nama key yang dikirim sebagai identifier.

## Operational primitives

### Cache metadata grup

`cacheGet`, `cacheSet`, dan `cacheDelete` menyediakan cache-aside dengan TTL bounded. WhatsApp adapter menggunakannya untuk nama grup yang memang sedang diperlukan, dengan TTL 300 detik. Jika Redis gagal, adapter kembali ke cache lokal dan lookup metadata Baileys. Cache tidak menyimpan participant list, isi chat, token, atau session material.

### Deduplikasi atomic

`rememberOnce` memakai `SET` dengan `NX` dan TTL. Adapter memakai scope `message-dedupe` dengan window 600 detik. Group Safety memakai scope `dry-run-case` dengan window 10 detik. Jika Redis disabled atau gagal, state lokal existing tetap menjadi fallback. Karena key dibentuk dari hash identity, data raw tidak dikirim sebagai key suffix.

### Rate limit fixed-window

`consumeFixedWindow` memakai Lua `INCR` dan `PEXPIRE` dalam satu evaluasi Redis sehingga increment dan expiry atomic pada database Redis. Group Safety menggunakan window 10 detik dan limit 5 pada jalur dry-run. Jika operasi Redis gagal, existing `PlatformGuardrailService` tetap digunakan sehingga perubahan tidak fail-open terhadap limiter lokal.

### Counter TTL

`incrementCounter` menyediakan counter dengan expiry pada first increment. Primitive ini belum dipasang pada setiap pesan secara otomatis karena akan menambah satu request Upstash per event dan biaya/latency harus diukur terlebih dahulu. Ia tersedia untuk metric dengan volume yang sudah memiliki budget dan sampling policy.

### Distributed lock

`acquireLock` menggunakan token acak, `SET NX EX`, dan `releaseLock` memakai Lua compare-and-delete. Token harus disimpan hanya oleh pemilik operasi dan tidak dicatat ke log. Primitive ini belum mengendalikan workflow produksi karena Allybot saat ini tidak memiliki worker multi-instance yang memerlukan lease. Penggunaan lock membutuhkan owner, lease TTL, fencing, crash recovery, dan test concurrency tersendiri.

### Bounded queue

`enqueueBounded` menggunakan list Redis, Lua `RPUSH` + `LTRIM` + `EXPIRE`, sehingga kapasitas dan TTL tetap bounded. Saat kapasitas penuh, item tertua dibuang secara eksplisit dan hasil mengembalikan `droppedOldest=true`. `dequeue` mengambil item tertua. Primitive ini belum menggantikan queue internal Neon karena writer Neon sudah memiliki bounded queue, retry, idempotency, dan drain-aware shutdown yang merupakan domain-specific behavior.

## Failure behavior

Redis tidak menjadi dependency blocking untuk inbound WhatsApp, SQLite, Neon writer, atau fitur yang tidak membutuhkan Redis. Timeout membatalkan request melalui `AbortController`. Health-check memakai maksimal tiga attempt dan delay bounded. Operasi runtime memakai satu attempt dengan timeout operasional pendek karena retry otomatis pada `SET NX`, `INCR`, Lua rate-limit, lock, atau queue dapat mengubah state dua kali ketika respons pertama sebenarnya sudah diterapkan tetapi responsnya hilang. Operasi yang gagal mengembalikan hasil fallback (`undefined` atau status unavailable) dan log hanya menyimpan operation class, attempt, dan error class.

Jika Redis mengalami outage, cache menjadi cold, deduplikasi kembali ke map lokal, dan Group Safety kembali ke limiter/dedupe lokal existing. Tidak ada fail-open yang menonaktifkan seluruh guardrail karena shared Redis gagal.

## Security constraints

Semua scope dibatasi regex dan identity dibatasi panjangnya. Value queue dibatasi 8.192 karakter; kapasitas queue maksimal 10.000 item; TTL maksimal 24 jam. Tidak ada `KEYS *`, scan global, raw chat, raw JID, token, QR, atau session material. Lock release wajib membandingkan token sehingga satu worker tidak dapat melepas lock milik worker lain.

Redis diperlakukan sebagai ephemeral operational state, bukan authoritative store untuk permission, consent, moderation case, chat-log, atau WhatsApp session. Redis data loss harus dapat dipulihkan dari authoritative source atau fallback lokal.

## Rollout and rollback

Health-check harus lulus lebih dahulu. Setelah itu, aktifkan feature flag dan amati timeout, fallback, serta error class. Use case yang menggunakan Redis harus diuji pada workload representative sebelum memperbesar TTL, retry, atau kapasitas. Rollback tahap ini dapat dilakukan dengan `UPSTASH_REDIS_ENABLED=false` dan restart proses; fallback lokal tetap berlaku.

Distributed lock atau queue workflow baru memerlukan ADR terpisah sebelum dipasang ke background job atau deployment multi-instance. Jangan menambahkan worker hanya karena primitive Redis sudah tersedia.

## Verification

Verifikasi lokal yang sudah dilakukan:

- Typecheck berhasil.
- Build berhasil.
- Full regression suite berhasil: 269 test, 0 gagal.
- Unit tests Redis berhasil mencakup default-off, URL/token validation, timeout, retry bounded, secret-safe logging, cache, `SET NX` dedupe, atomic fixed-window contract, counter expiry, lock ownership, bounded queue, dan fallback saat outage.
- `npm audit --omit=dev --audit-level=high` sebelumnya menghasilkan 0 vulnerability untuk dependency runtime yang dipasang.

Verifikasi koneksi production tetap dilakukan dengan:

```bash
npm run verify:upstash-redis
```

Output `PASS` membuktikan koneksi dan respons PONG, bukan membuktikan semua workflow Redis. Workflow yang menggunakan cache, limiter, lock, atau queue harus memiliki acceptance test dan observability masing-masing.

## Research provenance

Desain client didasarkan pada `@upstash/redis` `1.38.2`, package resmi berbasis HTTP/REST. Dokumentasi package menyatakan konfigurasi client menggunakan `url` dan `token`, mendukung `AbortSignal`, `SET` options, dan `eval`. Dokumen upstream yang perlu direfresh ketika dependency berubah:

- https://upstash.com/docs/redis/howto/connect-with-upstash-redis
- https://upstash.com/docs/redis/features/restapi
- https://upstash.com/docs/redis/sdks/ts/overview
- https://www.npmjs.com/package/@upstash/redis
