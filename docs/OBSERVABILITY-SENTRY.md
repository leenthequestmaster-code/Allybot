# Sentry Observability

## Scope

Project acceptance yang dibuat untuk Allybot berada pada organisasi `allyssea` dengan project slug `allybot-acceptance`. Project ini dipakai untuk verifikasi terisolasi sebelum telemetry production dipertimbangkan.

Allybot memakai Sentry sebagai telemetry opsional untuk failure pada framework, plugin, koneksi WhatsApp, startup, shutdown, dan command execution. Telemetry ini **nonaktif secara default** dan dirancang fail-open: kegagalan Sentry tidak boleh menghentikan bot atau menggagalkan command.

Sentry bukan sumber kebenaran Character, Group Context, Economy, atau chat log. Sentry juga bukan bukti bahwa WhatsApp sedang online; status WhatsApp tetap diverifikasi melalui adapter health check dan acceptance test.

## Configuration

Semua nilai berikut dibaca saat proses mulai:

```dotenv
SENTRY_ENABLED=false
# SENTRY_DSN=https://<project-key>@<region>.ingest.sentry.io/<project-id>
SENTRY_ENVIRONMENT=acceptance
# SENTRY_RELEASE=<commit-sha>
SENTRY_TRACES_SAMPLE_RATE=0
```

`SENTRY_DSN` harus disimpan sebagai secret server-side pada environment runtime. Jangan menaruhnya di source code, repository, artifact, chat, atau log. Mengubah environment membutuhkan lifecycle restart terkontrol agar proses memuat nilai baru; deployment artifact saja tidak mengubah proses yang sedang berjalan.

`SENTRY_TRACES_SAMPLE_RATE` tetap `0` sampai error telemetry dan privacy acceptance selesai diverifikasi. Jika performance tracing diperlukan pada environment acceptance, gunakan sample rate kecil dan eksplisit, misalnya `0.05`; jangan mengaktifkannya pada production tanpa review biaya, retention, dan data classification.

## Data boundary

Reporter hanya mengirim fixed message dan tag ber-batas. Tag yang diperbolehkan adalah operasi, status, error class, dan error code yang telah dibatasi karakter serta panjangnya. Error event juga memakai fingerprint deterministik berbasis safe operation, error class, dan optional error code agar kegagalan dari operasi berbeda tidak ter-group menjadi satu issue generik. SDK dijalankan dengan `sendDefaultPii=false` dan default integrations dinonaktifkan agar tidak menangkap request, breadcrumb, user, atau body secara otomatis.

Data berikut tidak boleh dikirim ke Sentry:

- raw WhatsApp message body, quoted text, media metadata, atau group name;
- JID, nomor telepon, QR, Baileys auth/session material, token, password, DSN, atau connection string;
- Character Sheet, Economy payload, Supabase rows, Neon chat-log content, dan Redis values;
- stack trace atau error message mentah yang mungkin memuat input pengguna.

## Event mapping

| Allybot signal | Sentry operation tag | Payload |
| --- | --- | --- |
| Framework error | source yang sudah dibatasi | error class dan optional error code |
| Plugin initialization failure | `plugin:<name>` | error class, optional error code, dan fingerprint aman |
| WhatsApp failed/needs auth | `connection:<status>` | status terbatas |
| Startup failure | `lifecycle:start` | error class dan optional error code |
| Shutdown failure | `lifecycle:shutdown` | error class dan optional error code |

## Acceptance verification

1. Project `allybot-acceptance` pada organisasi `allyssea` harus tersedia dengan platform Node.js.
2. Salin DSN dari halaman project Sentry secara manual dan simpan hanya pada secret runtime. Jangan kirim DSN ke chat atau commit.
3. Set `SENTRY_ENABLED=true`, `SENTRY_ENVIRONMENT=acceptance`, `SENTRY_RELEASE=<commit-sha>`, dan `SENTRY_TRACES_SAMPLE_RATE=0` pada environment acceptance.
4. Restart hanya instance acceptance setelah environment tersimpan. Jangan melakukan restart production sebagai bagian dari verifikasi ini.
5. Periksa log startup untuk pesan `Sentry telemetry initialized` tanpa mencetak DSN.
6. Picu satu failure synthetic yang tidak berasal dari WhatsApp dan tidak membawa data pengguna.
7. Cari issue pada project Sentry dengan filter environment `acceptance` dan release SHA tersebut.
8. Pastikan event hanya berisi fixed message, safe operation tag, safe status/error class, environment, dan release.
9. Pastikan event grouping konsisten dan tidak ada raw payload.
10. Setelah verifikasi, matikan acceptance telemetry atau biarkan aktif dengan retention dan alert yang disepakati.

## Rollback

Rollback telemetry dilakukan dengan mengubah `SENTRY_ENABLED=false` atau menghapus `SENTRY_DSN` dari runtime environment, lalu melakukan restart terkontrol pada instance yang bersangkutan. Rollback tidak mengubah data domain dan tidak memerlukan migrasi database. Bila SDK menyebabkan startup issue, kembalikan artifact ke release sebelumnya dan tetap pertahankan environment production tanpa DSN.

## References

- [Sentry Node.js SDK](https://docs.sentry.io/platforms/javascript/guides/node/)
- [Sentry project setup](https://docs.sentry.io/product/sentry-basics/integrate-frontend/create-new-project/)
- [Sentry data privacy](https://docs.sentry.io/security-legal-pii/)
