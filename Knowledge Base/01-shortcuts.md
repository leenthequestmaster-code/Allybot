# Shortcut Navigasi Kode

Gunakan rute terpendek berikut. Setelah menemukan file, gunakan Serena untuk `get_symbols_overview`, `find_symbol`, dan `find_referencing_symbols` sebelum membaca atau mengedit body.

| Tujuan | Mulai dari | Lanjutkan ke |
|---|---|---|
| Startup/shutdown | `src/index.ts` | `AppLifecycle` di `src/lifecycle.ts`, `ApplicationFramework` |
| Pesan masuk sampai command | `src/whatsapp.ts` | `CommandRegistry.dispatch`, `message-gate`, `middleware` |
| Permission owner/admin | `src/permissions.ts` | `createPermissionResolver`, `createPermissionMiddleware` |
| Menambah command | plugin terkait di `src/framework/plugins/` | `CommandDefinition`, `CommandRegistry.register` |
| Menambah service | `src/services/` | `Service` contract, `ServiceRegistry`, dependency list |
| AI/provider | `src/ai-handler.ts` | `createAiHandler`, `createXkiroTransport`, `src/framework/plugins/ai.ts` |
| Auth/session | `src/storage.ts` | `SqliteStorage`, lalu `src/whatsapp.ts` auth/reconnect |
| Moderasi grup | `src/services/group-safety-service.ts` | `src/framework/plugins/group-safety.ts`, guardrail service |
| Data economy/character | service terkait | Supabase factory dan feature flags di `src/config.ts` |
| Chat logging | `src/neon-chat-log-writer.ts` | `src/framework/plugins/neon-chat-log.ts`, Neon client |
| Codebase export | `src/framework/plugins/codebase.ts` | `.github/workflows/ci.yml`, generator script |
| Config/feature flag | `src/config.ts` | `.env.example`, `src/index.ts` wiring |

## Shortcut diagnosis

- Command tidak merespons: cek prefix/lookup di `CommandRegistry.dispatch`, permission middleware, lalu handler plugin.
- Permission salah: cek `senderJid`, normalisasi JID, metadata peserta, dan `developer-mode` service.
- Bot tidak reconnect: cek status mapping dan scheduling di `WhatsAppConnection`, bukan langsung mengubah lifecycle.
- Data tidak tersimpan: cek service initialization, `SqliteStorage`, schema migration, dan transaction boundary.
- AI gagal: cek feature flag, API key, model ID, timeout 15 detik, bounded input/output, dan fallback.
- Test R1 gagal: mulai dari `tests/r1-group-safety.test.js`, lalu `normalizeReason` dan helper bounded text.
- Artifact export gagal: cek generator, sanitization manifest, ukuran ZIP, signature, dan permission developer observer.

## Protokol perubahan

1. Rumuskan simbol/kontrak yang berubah.
2. Temukan semua referensi dengan Serena.
3. Edit menggunakan operasi simbolik; hindari search-replace luas.
4. Tambahkan atau perbarui test regression.
5. Jalankan `npm run typecheck`, `npm run build`, dan `npm test`.
6. Tinjau `git diff` dan dokumentasikan perubahan di `changes/`.