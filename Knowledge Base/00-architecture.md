# Arsitektur Fundamental Allybot

## Stack

Allybot adalah proses Node.js jangka panjang berbasis TypeScript 5.9 dan Node >=22. Transport WhatsApp menggunakan Baileys. SQLite menyimpan kredensial, key store, dan data lokal; Supabase, Neon/Postgres, dan Upstash adalah integrasi feature-gated. AI memakai OpenAI-compatible SDK melalui provider Xkiro.

## Peta direktori

| Area | Peran | Entry point penting |
|---|---|---|
| `src/index.ts` | wiring aplikasi, config, service, plugin, lifecycle | `main`/bootstrap |
| `src/config.ts` | parse dan validasi environment | `loadConfig` |
| `src/lifecycle.ts` | startup, signal, shutdown, uncaught error | `AppLifecycle` |
| `src/whatsapp.ts` | Baileys socket, normalisasi pesan, media, reconnect | `WhatsAppConnection` |
| `src/framework/` | application framework, registry, middleware, event bus | `ApplicationFramework` |
| `src/platform/` | boundary platform, validation, guardrail, sessions, operations | platform adapters |
| `src/framework/plugins/` | fitur command yang terisolasi | plugin exports |
| `src/services/` | business logic dan persistence service | service classes |
| `src/storage.ts` | SQLite auth/key/data foundation | `SqliteStorage` |

## Alur pesan

```text
Baileys event
  -> WhatsAppConnection normalisasi CoreMessage
  -> ApplicationFramework / message gate
  -> CommandRegistry prefix + command lookup
  -> permission middleware
  -> validation/cooldown middleware
  -> plugin handler
  -> service/platform adapter
  -> WhatsApp reply atau persistence
```

## Invariants

- Semua command melewati permission, validation, dan cooldown middleware.
- Business logic tidak boleh melewati platform boundary untuk mengakses detail Baileys secara langsung.
- Environment dan external input divalidasi dengan Zod atau helper bounded validation.
- Credential, session, database, dan private user data tidak boleh masuk ke log, artifact, atau Knowledge Base.
- Integrasi eksternal harus feature-gated dan gagal secara aman; SQLite tetap menjadi local foundation.
- Perubahan lintas simbol harus menggunakan Serena symbol/reference tools bila tersedia; baca hanya body yang dibutuhkan.

## Area berisiko tinggi

- `src/permissions.ts`: owner/admin/developer boundary.
- `src/framework/middleware.ts` dan `src/framework/command-registry.ts`: command dispatch boundary.
- `src/whatsapp.ts`: auth session, reconnect, media, inbound normalization.
- `src/storage.ts`: auth creds, key material, SQLite permissions.
- `src/config.ts`: secret validation dan feature flags.
- `src/ai-handler.ts`: external provider, input/output bounds, prompt boundary.
- `src/framework/plugins/codebase.ts`: private source artifact delivery.
- `src/services/group-safety-service.ts`: moderation record integrity dan privacy.