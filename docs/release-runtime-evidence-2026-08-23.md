# Release Runtime Evidence — 23 Agustus 2026

## Scope

Controlled reload proses manual Allybot pada Panel dilakukan setelah izin eksplisit pengguna. Startup Command dan `.bash_profile` tidak diubah. Tidak ada log mentah, secret, raw JID, raw message content, atau session material yang dikumpulkan.

## Repository and CI

- Menu v1.0 commit: `606a0d2`.
- Documentation reconciliation commit: `85eb3a9`.
- CI run menu: `32631329930`, success; sanitized artifact sync, SHA-256 verification, dan archive cleanup pass.
- CI run documentation: `32631651578`, success; sanitized artifact sync, SHA-256 verification, dan archive cleanup pass.

## Controlled reload

- Endpoint power resmi merespons HTTP `204` untuk signal `restart`.
- Read-only resource endpoint sesudah restart merespons HTTP `200`.
- Snapshot setelah restart: state Panel terlapor `starting`, memory `3,756,032` bytes, uptime sekitar `101,839` ms pada salah satu observasi. Dalam konteks Panel ini, `starting` adalah state API yang pernah teramati saat proses manual berjalan; status tersebut belum menjadi bukti live WhatsApp acceptance.

## Sanitized verifier

- `npm run self-check`: pass; integrity valid; tidak ada operasi database atau koneksi WhatsApp live yang dilakukan oleh self-check.
- `npm run verify:upstash-redis`: `UPSTASH_REDIS_VERIFY=DISABLED` pada environment sandbox lokal. Ini bukan bukti bahwa flag Upstash pada environment Panel aktif.

## Limitations

- Belum menjalankan command live di WhatsApp karena black-box acceptance tetap ditunda sampai environment acceptance terisolasi tersedia.
- Belum mengklaim bahwa runtime Panel memuat flag Neon/Redis aktif hanya berdasarkan artifact sync dan resource state.

## API documentation note

Dokumentasi resmi Pterodactyl pada URL `https://pterodactyl.io/api/client.html#list-files` mengarahkan dokumentasi API ke `https://dashflo.net/docs/api/pterodactyl/v1/`; ekstraksi section anchor langsung tidak tersedia. Tidak ada operasi file write dilakukan berdasarkan dokumentasi tersebut.

## Evidence classification

- **Observed:** restart HTTP 204; resource HTTP 200; uptime meningkat setelah restart; local self-check pass; local Redis verifier disabled; CI success.
- **Inferred:** proses Panel kemungkinan telah dimuat ulang karena uptime reset/rendah setelah restart.
- **Not established:** live Baileys payload behavior, live command response, dan active Panel feature-flag values.

**Author:** Manus AI

---

## References

[1]: https://pterodactyl.io/api/client.html#list-files "Pterodactyl API documentation entry point"
[2]: https://dashflo.net/docs/api/pterodactyl/v1/ "Pterodactyl Client API reference linked by official documentation"

## Final source and verification gate

- Repository tree bersih setelah commit `cd86788`.
- `HEAD` lokal dan `origin/main` sama: `cd86788ee0a04c56678e4133c829e384e1f3be51`.
- Recovery rehearsal terfokus: pass.
- Full regression setelah runbook: 275/275 pass, 0 fail.
- Runtime dependency audit: 0 vulnerabilities pada threshold high.
- CI run terakhir: `32632120441`, success; typecheck, clean build, compiled runtime regression, sanitized artifact, SHA-256 verification, dan archive cleanup pass.

## Decision evidence update

- **Observed:** source clean dan synced; CI latest success; controlled restart accepted HTTP 204; resource endpoint HTTP 200; uptime meningkat setelah restart; local self-check pass; recovery rehearsal pass.
- **Still not established:** live WhatsApp/Baileys black-box behavior dan effective Panel feature flags untuk Neon/Upstash melalui command output. Release status tidak boleh dinaikkan menjadi fully proven production release berdasarkan evidence ini saja.
