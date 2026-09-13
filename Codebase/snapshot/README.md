# Allybot

Allybot adalah bot WhatsApp berbasis [Baileys](https://github.com/WhiskeySockets/Baileys) untuk komunitas roleplay **Allyssea**, dibangun di atas framework plugin internal (TypeScript, ESM, strict mode). Semua interaksi grup — moderasi, AFK, knowledge base, scene, governance — berjalan melalui satu pipeline command yang seragam: message gate → permission → validasi → cooldown → handler.

- **Runtime**: Node.js 22+, npm
- **Bahasa**: TypeScript → dikompilasi ke `dist/` (ESM, strict, `noEmitOnError`)
- **Storage**: SQLite (`better-sqlite3`, WAL) untuk state lokal; Redis opsional untuk cache/rate-limit/lock
- **AI**: opsional via provider OpenAI-compatible apa pun (default **off**)
- **Status**: proyek private, versi `0.1.0`, CI penuh di GitHub Actions

> Tiga fitur besar (Ekonomi Vela, Group Context, Character Guide) saat ini **stub backend** — flag-nya ada, tetapi backend RPC eksternalnya belum dipasang di `src/index.ts`. Lihat [Fitur Opsional](#fitur-opsional) sebelum mengaktifkan.

---

## Daftar Isi

1. [Arsitektur](#arsitektur)
2. [Prasyarat](#prasyarat)
3. [Instalasi](#instalasi)
4. [Konfigurasi `.env`](#konfigurasi-env)
5. [Menjalankan (Development)](#menjalankan-development)
6. [Test](#test)
7. [Build](#build)
8. [Deployment (CI/CD)](#deployment-cicd)
9. [Struktur Repository](#struktur-repository)
10. [Cara Plugin dan Service Bekerja](#cara-plugin-dan-service-bekerja)
11. [Fitur Opsional](#fitur-opsional)
12. [Known Limitations](#known-limitations)
13. [Troubleshooting](#troubleshooting)

---

## Arsitektur

```
                        ┌─────────────────────────────────────────────┐
                        │                 src/index.ts                │
                        │  config → logger → sentry → storage → redis │
                        │        → WhatsAppConnection → Framework     │
                        └────────────────────┬────────────────────────┘
                                             │ register (sebelum start)
              ┌──────────────────────────────┼──────────────────────────────┐
              ▼                              ▼                              ▼
   ┌─────────────────────┐      ┌─────────────────────────┐     ┌──────────────────────┐
   │  src/framework/     │      │     src/services/       │     │   src/whatsapp.ts    │
   │  ─────────────────── │      │  ────────────────────── │     │  ──────────────────  │
   │  ApplicationFramework│     │  14 service stateful    │     │  Adapter Baileys     │
   │  PluginManager       │      │  (SQLite + Redis + RPC  │     │  7.0.0-rc14          │
   │  CommandRegistry     │◄─────│  stub): afk, economy,   │────►│  QR/pairing, koneksi,│
   │  EventBus            │      │  group-*, knowledge,    │     │  media, native flow  │
   │  ServiceRegistry     │      │  scene, redis, dll.     │     │  buttons, moderation │
   │  MessageGateRegistry │      └─────────────────────────┘     └──────────┬───────────┘
   │  + plugins/ (23)     │                                                 │
   └──────────┬──────────┘                                                 │
              │                                                            │
              ▼                                                            ▼
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │                                 STORAGE                                       │
   │  SQLite (better-sqlite3): auth creds Baileys, cache pesan terbatas, state     │
   │  service. WAL + busy_timeout 5s. Redis (opsional, fail-soft): cache, rate     │
   │  limit, mutex, queue — via src/redis.ts                                      │
   └──────────────────────────────────────────────────────────────────────────────┘
```

Alur pesan masuk: `WhatsAppConnection` → `ApplicationFramework.bindCoreEvents()` → **message gates** (kebijakan bisa memblokir) → `EventBus` (`message.received`) → `CommandRegistry.dispatch` (prefix, permission, validasi, cooldown) → handler command plugin → reply via adapter.

Prinsip utama yang dijaga kode: isolasi error per-plugin (kegagalan satu plugin tidak menjatuhkan bot), privacy by default (JID di-hash sebelum persist ke backend RPC, log pino di-redact, telemetry Sentry di-collapse), dan fail-soft untuk semua dependensi opsional (Redis, AI, RPC).

## Prasyarat

| Kebutuhan | Versi | Catatan |
|---|---|---|
| Node.js | **22 (major)** | `engines: ">=22.0.0"`; CI memverifikasi `major === 22` dan gagal di luar itu |
| npm | ≥ 9 | untuk `npm ci` dari `package-lock.json` |
| Git | bebas | clone repo |

Tidak ada database eksternal yang wajib — SQLite berjalan embedded. Redis dan backend Supabase/Postgres hanya untuk fitur opsional.

## Instalasi

```bash
git clone <url-repo-allybot> allybot
cd allybot
npm ci          # install terkunci dari package-lock.json
```

`node_modules` berisi native build (`better-sqlite3`); jika pindah mesin, jalankan `npm ci` ulang di mesin tersebut.

## Konfigurasi `.env`

Salin contoh lalu sesuaikan:

```bash
cp .env.example .env
```

Nilai diverifikasi dari `src/config.ts` (zod schema). Boolean **harus** string `'true'`/`'false'` — nilai lain ditolak saat start. Kolom "default" di bawah = nilai saat variabel **tidak di-set** sama sekali.

### Variabel inti

| Variabel | Default | Efek |
|---|---|---|
| `NODE_ENV` | `production` | `development` \| `test` \| `production` |
| `LOG_LEVEL` | `info` | `silent`..`trace` (pino) |
| `DATABASE_PATH` | `./data/allyssea.sqlite` | File SQLite: auth creds + state service |
| `AUTH_ACCOUNT_ID` | `primary` | Label akun WhatsApp (multi-akun di satu DB) |
| `LOCAL_MESSAGE_CACHE_*` | TTL 24j / 10.000 baris / 64 MiB | Cache pemulihan pesan (terbatas, bukan riwayat chat permanen) |
| `WHATSAPP_ENABLED` | `true` | `false` → mode maintenance (bot jalan tanpa koneksi WA) |
| `QR_ENABLED` | `false` | **Set `true`** agar QR pairing pertama dicetak ke terminal |
| `PAIRING_ENABLED` | `false` | Pairing via kode angka (butuh `PAIRING_PHONE_NUMBER`) |
| `PAIRING_PHONE_NUMBER` | — | Wajib jika `PAIRING_ENABLED=true`, hanya digit |
| `ENABLE_HISTORY_SYNC` | `false` | Sinkronisasi riwayat chat saat online (privasi: default off) |
| `MAX_RECONNECT_DELAY_MS` | `300000` | Batas backoff reconnect |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Graceful shutdown timeout |
| `COMMAND_PREFIX` | `!` | Prefix command global (1–4 karakter) |
| `DEFAULT_COMMAND_COOLDOWN_MS` | `3000` | Cooldown default semua command |
| `BOT_OWNER_JID` | — (opsional) | JID/digit pemilik bot untuk permission owner |

### Fitur opsional

| Variabel | Default | Efek |
|---|---|---|
| `DIAGNOSTICS_ENABLED` | `false` | Aktifkan plugin diagnostik (`!health`, `!diag`) |
| `AI_ENABLED` | `false` | Aktifkan plugin AI (`!ai`, `!translate`, `!summarize`, `!aidetection`) |
| `AI_API_KEY` | — | API key provider — dibaca langsung oleh AI handler (di luar zod schema) |
| `AI_BASE_URL` | — | Base URL provider OpenAI-compatible (mis. `https://api.example.com/v1`) |
| `AI_MODEL` | — | ID model utama |
| `AI_FALLBACK_MODEL` | — | ID model fallback (butuh `AI_FALLBACK_ENABLED=true`) |
| `AI_FALLBACK_ENABLED` | `false` | Fallback ke `AI_FALLBACK_MODEL` bila model utama gagal |
| `ECONOMY_ENABLED` | `false` | Fitur ekonomi Vela — **lihat status stub di bawah** |
| `GROUP_CONTEXT_ENABLED` | `false` | Fitur mode grup IC/OOC — **status stub** |
| `CHARACTER_GUIDE_ENABLED` | `false` | Fitur Character Guide — **status stub** |
| `CHARACTER_GUIDE_SESSION_TTL_SECONDS` | `1800` | TTL sesi registrasi karakter (300–86400) |
| `GROUP_CONTEXT_OOC_*` | 30j / 600j / 3 | Cooldown, window, dan kuota OOC per window |
| `REDIS_ENABLED` | `false` | Aktifkan Redis (wajib `REDIS_URL`) |
| `REDIS_URL` | — (opsional) | `redis://...`; **wajib** jika `REDIS_ENABLED=true` |
| `REDIS_KEY_PREFIX` | `allybot:v1` | Prefix key Redis |
| `REDIS_TIMEOUT_MS` dll. | 5000/1000/2/100 | Timeout koneksi/operasi, max attempt, delay retry |
| `CODEBASE_EXPORT_ENABLED` | `false` | Aktifkan command `!codebase` (kirim export tersanitasi ke developer) |
| `CODEBASE_EXPORT_PATH` | `./Codebase/allybot-codebase-latest.zip` | Path ZIP export (harus relatif, di dalam direktori aplikasi) |
| `SENTRY_ENABLED` | `false` | Aktifkan telemetry error (wajib `SENTRY_DSN`) |
| `SENTRY_DSN` | — | DSN Sentry, harus `https://` |
| `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE` / `SENTRY_TRACES_SAMPLE_RATE` | `production` / — / `0` | Tag & sampling Sentry |

Validasi start yang akan **menolak start** jika salah: `PAIRING_ENABLED=true` tanpa nomor telepon, `REDIS_ENABLED=true` tanpa `REDIS_URL`, `SENTRY_ENABLED=true` tanpa DSN, dan `CODEBASE_EXPORT_PATH` yang keluar dari direktori aplikasi.

> **Catatan QR**: `.env.example` menyarankan `QR_ENABLED=true`. Default schema-nya `false` — tanpa meng-set variabel ini, **QR tidak akan dicetak** dan pairing pertama tidak bisa dilakukan. Pairing kedua (device tambahan) memakai kode angka via `PAIRING_ENABLED` + `PAIRING_PHONE_NUMBER`.

## Menjalankan (Development)

Build dulu — entrypoint menjalankan `dist/index.js`, bukan `src`:

```bash
npm run build
npm start          # node dist/index.js
```

Pada sesi pertama (belum terdaftar):

- `QR_ENABLED=true` → QR dicetak di terminal; scan via WhatsApp → *Linked Devices*.
- `PAIRING_ENABLED=true` + `PAIRING_PHONE_NUMBER` → kode pairing 8 digit dilog (dan langsung di-redact dari output log).

Sesi disimpan di SQLite (`auth_creds`/`auth_keys`), sehingga restart berikutnya tidak meminta scan ulang. `Ctrl-C`/SIGTERM memicu graceful shutdown: plugin di-unload, service di-shutdown, koneksi ditutup dalam batas `SHUTDOWN_TIMEOUT_MS`.

Perintah berguna saat development:

```bash
npm run typecheck        # tsc --noEmit
npm run self-check       # node dist/index.js --self-check → verifikasi integritas SQLite + config
npm run verify:platform  # paritas src/framework ↔ dist + scan file sensitif di repo
```

`WHATSAPP_ENABLED=false` menjalankan bot dalam mode maintenance: framework dan service tetap hidup (berguna untuk menguji service tanpa WhatsApp).

## Test

> **Penting: selalu `npm run build` dulu.** Semua test mengimport dari `../dist/` — dengan `dist` basi/kosong, hasil test tidak mencerminkan source.

```bash
npm run build
npm test
```

`npm test` = `node --test tests/*.test.js` — **277 test** behavioral/integrasi (baseline gelombang awal 237; suite sekarang 277, semua lulus saat README ini ditulis). Cakupan di antaranya: framework lifecycle, permissions, privasi logger, guardrail, storage, semua plugin aktif, Redis fail-soft, AI handler, dan kontrak refusal untuk fitur stub.

### Pattern test behavioral

Test ditulis dalam JS murni (`node:test`) yang memuat **output terkompilasi** dan mensimulasikan framework kecil tanpa WhatsApp nyata — pola dari `tests/stub-feature-disable.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import pino from 'pino'
import { CommandRegistry, EventBus } from '../dist/framework/index.js'
import { myPlugin } from '../dist/framework/plugins/my-plugin.js'

const logger = pino({ level: 'silent' })

test('perilaku command saya', async () => {
  const commands = new CommandRegistry({ commandPrefix: '!', defaultCooldownMs: 0 }, logger, whatsappStub(), serviceRegistryStub(), new EventBus(logger))
  myPlugin.load({ logger, commands, config: { commandPrefix: '!' }, services, events, messageGates })
  // panggil handler command secara langsung dengan CommandContext stub
  await commands.get('mycommand').handler(stubContext)
  assert.equal(replies[0], '...')
})
```

Helper lengkap (stub WhatsApp, load plugin, run command) ada di `tests/helpers/fake-whatsapp.js` dan file test tetangga — salin pola yang sudah terbukti, jangan menemukan cara baru.

## Build

```bash
npm run build     # tsc -p tsconfig.json → dist/ (+ copy thumbnail menu ke dist/assets/)
```

- TypeScript strict, `noEmitOnError: true` — build gagal total bila ada error type.
- `postbuild` menyalin `assets/allybot-menu-thumbnail.jpg` ke `dist/assets/`.
- `npm run typecheck` untuk cek tanpa emit.
- CI melakukan **clean build** (`rm -rf dist` lalu `npm run build`) untuk menjamin `dist` selalu hasil source terkini.

## Deployment (CI/CD)

Semua ada di `.github/workflows/ci.yml` — tiga job inti:

### 1. `verify` (selalu, setiap push/PR)

Node 22 → `npm ci` → `typecheck` → **clean build** → `verify:platform` → `node --check` seluruh `dist/*.js` → `npm test`. Pada push ke `main`, ditambah:

- **Codebase Intelligence Export**: `scripts/generate-codebase-export.mjs` membuat snapshot tersanitasi (`Codebase/`) — index simbol/import/command untuk review AI & manusia. CI memverifikasi manifest SHA, **menolak** JID numerik / pola nomor HP di snapshot, memastikan tidak ada `.env`/`*.sqlite`/credential, lalu meng-zip + upload sebagai artifact.
- **Release artifact**: `allybot-dist-<sha>` (dist + package manifest) dan `allybot-release-<sha>.zip` — arsip deployment tersanitasi berisi `dist/`, `Codebase/` ZIP, node_modules runtime terkurasi, `release-manifest.json`, dan `SHA256SUMS.txt`. Retention 14 hari.

### 2. `deploy_panel` (opsional, Pterodactyl)

Aktif hanya jika **salah satu** berlaku:

- `vars.PANEL_DEPLOY_ENABLED == 'true'` pada push ke `main`, atau
- `workflow_dispatch` dengan input `deploy_panel=true`.

Butuh konfigurasi di repo/org: `PANEL_URL` (https), `PTERODACTYL_SERVER_ID` (vars) dan `PTERODACTYL_API_TOKEN` (secret). Job mengunduh arsip release, memverifikasi SHA256 lokal, mengunggah via API Panel, **memverifikasi checksum file ter-deploy** (sentinel `dist/index.js`, `dist/sentry.js`, manifest, dsb. — kegagalan checksum = job gagal), lalu menghapus arsip sementara. Job **tidak** mengubah power state server maupun startup command — restart dilakukan dari Panel.

### 3. `publish_codebase` (push ke `main`)

Commit hasil export `Codebase/` kembali ke `main` dengan pesan `chore(codebase): refresh intelligence export [skip ci]` (loop terputus via `[skip ci]` dan pengecekan provenance SHA). Job `deployment-summary` menutup run dengan ringkasan gate di step summary.

### Rollback / Undo

- **Via CI**: deploy arsip SHA sebelumnya — artifact `allybot-release-<sha-lama>.zip` tersimpan 14 hari; jalankan ulang workflow `deploy_panel` dengan input `deploy_panel=true` pada commit lama, atau unggah arsip lama secara manual melalui file manager Panel (integritas bisa dicek dengan `sha256sum` dari `SHA256SUMS.txt`).
- **Via git**: `git revert <commit-buruk> && git push origin main` → CI memverifikasi ulang commit revert dan (bila `PANEL_DEPLOY_ENABLED=true`) otomatis men-deploy-nya.
- **Data aman**: arsip deployment tidak berisi `.env`, `*.sqlite`, creds, atau `src/` — kredensial WhatsApp dan database lokal di server **tidak tersentuh** oleh deploy, jadi rollback tidak memutus sesi pairing.

## Struktur Repository

```
allybot/
├── assets/                        # Aset statis (thumbnail menu)
├── scripts/
│   ├── verify-platform.mjs        # Paritas src/framework↔dist + scan file sensitif
│   ├── generate-codebase-export.mjs  # Generator Codebase Intelligence Export
│   └── create-release-manifest.mjs   # Manifest SHA256 arsip release CI
├── src/
│   ├── index.ts                   # Entry point: wiring config→storage→service→plugin
│   ├── config.ts                  # zod schema env + validasi
│   ├── logger.ts                  # pino + redact 36 path sensitif
│   ├── whatsapp.ts                # Adapter Baileys (koneksi, QR, media, native flow)
│   ├── storage.ts                 # SQLite auth creds + cache pesan terbatas
│   ├── storage-helpers.ts         # Inisialisasi DB (WAL, busy_timeout)
│   ├── redis.ts                   # Service Redis opsional (fail-soft)
│   ├── ai-handler.ts              # Handler AI generik OpenAI-compatible (input/output bounded)
│   ├── sentry.ts                  # Reporter telemetry privacy-minimized
│   ├── lifecycle.ts               # Start/shutdown + process handler
│   ├── errors.ts / permissions.ts / media.ts / ...
│   ├── framework/                 # Kernel aplikasi
│   │   ├── application.ts         # ApplicationFramework (state machine start/stop)
│   │   ├── plugin-manager.ts      # Register/load/init/ready/unload + topological deps
│   │   ├── command-registry.ts    # Dispatch + middleware pipeline
│   │   ├── middleware.ts          # Permission, validasi, cooldown
│   │   ├── event-bus.ts / service-registry.ts / message-gate.ts
│   │   ├── contracts.ts           # Semua interface inti (Plugin, Service, Command…)
│   │   └── plugins/               # 23 plugin fitur (menu, group, afk, economy, …)
│   └── services/                  # 14 service stateful (SQLite / Redis / RPC)
├── tests/                         # 54 suite test behavioral (import dari ../dist/)
│   └── helpers/fake-whatsapp.js
├── .github/workflows/ci.yml       # verify + deploy_panel + publish_codebase
├── command-catalog.md             # Katalog *ide* command (bukan kontrak implementasi)
├── .env.example                   # Template konfigurasi
├── package.json / package-lock.json / tsconfig.json
└── README.md
```

## Cara Plugin dan Service Bekerja

### Lifecycle plugin

Plugin = unit fitur (`src/framework/plugins/*`) dengan hook opsional. State berurutan: `registered → loaded → initialized → ready` (atau `failed`).

1. `register(plugin)` — nama divalidasi (`^[a-z][a-z0-9_-]{1,63}$`), duplikat ditolak. Registrasi hanya boleh **sebelum** framework start.
2. `loadAndInitialize()` — dependensi diselesaikan **topologis** (cycle → error), lalu `load()` → `initialize()`. Handler registration (`commands`, `events`, `messageGates`) dilakukan di hook ini; semua disposer dilacak untuk cleanup.
3. `ready()` — dipanggil setelah semua plugin initialize, sebelum koneksi WhatsApp start.
4. `unload()` — urutan terbalik (LIFO); semua listener/registrasi di-dispose otomatis.

Kegagalan satu plugin (di hook mana pun) → state `failed`, plugin di-cleanup, event `plugin.failed` di-emit — **bot tetap jalan**.

### Lifecycle service

Service = objek stateful (`src/services/*`) dengan `name`, `dependencies?`, `initialize()`, `shutdown()`. Semua service di-initialize sebelum plugin. Service dapat saling lookup via `ServiceRegistry.get<T>(name)` — termasuk service `redis` untuk cache.

### Registrasi command

```ts
context.commands.register({
  name: 'contoh',
  aliases: ['c'],
  description: '…',        // muncul di menu (kecuali hidden: true)
  category: 'group',       // pengelompokan menu
  permission: permissionNames.groupAdmin,  // opsional
  cooldownMs: 3000,        // opsional
  hidden: true,            // sembunyikan dari menu (mis. command developer)
  validate: (ctx) => ctx.args[0] ? undefined : 'butuh argumen',
  handler: async (ctx) => { await ctx.reply('hai') },
})
```

`CommandRegistry.dispatch()` menolak pesan `fromMe`, menyelesaikan prefix (global, atau per-grup via `GroupConfigurationService.resolvePrefix` — command `setprefix` di grup), lalu menjalankan middleware berurutan: **permission → validation → cooldown** → handler. Error di handler di-catch framework: fallback reply ke user + event `command.failed` — satu command rusak tidak menjatuhkan bot.

### Message gates

Plugin dapat mendaftarkan gate (`messageGates.register('nama', fn)`) yang mengevaluasi **setiap pesan masuk sebelum dispatch**. Gate pertama yang mengembalikan `{ allowed: false, reason }` memblokir pesan (di-log, tidak dibalas). Contoh nyata: gate IC/OOC milik plugin group-context (hanya terpasang saat backend-nya live).

### Event bus

Event typed di `contracts.ts`: `connection.changed`, `message.received`, `group.participants.changed`, `command.before/executed/failed`, `plugin.loaded/failed`, `framework.error/ready`. Plugin berorientasi event (mis. `welcome-leave`) cukup subscribe via `context.events.on(...)` — disposernya otomatis dilacak.

## Fitur Opsional

| Fitur | Flag | Status | Keterangan |
|---|---|---|---|
| **Ekonomi Vela** (`vela`, `bank`, `tax`, …) | `ECONOMY_ENABLED` | ⚠️ **STUB — backend belum terpasang** | Flag `true` + tanpa backend → command menjawab *"Fitur ekonomi belum tersedia — backend sedang disiapkan."* dan **hidden dari menu**. Implementasi lengkap (wallet, safe, transfer, tax mingguan) sudah ada di `EconomyService`, menunggu wiring `options.createClient` (RPC Supabase/Postgres) di `src/index.ts`. |
| **Group Context** (`setgroup`, `ooc`, `whitelistooc`) | `GROUP_CONTEXT_ENABLED` | ⚠️ **STUB — backend belum terpasang** | Sama: refusal *"Fitur konteks grup belum tersedia…"*, hidden. Mode IC/OOC + gate pesan aktif hanya setelah RPC backend di-inject. |
| **Character Guide** (`daftar`, `character`, `timerp`, `guider`, …) | `CHARACTER_GUIDE_ENABLED` | ⚠️ **STUB — backend belum terpasang** | Sama: refusal *"Fitur Character Guide belum tersedia…"*, hidden. Parser character sheet (`character-sheet-parser.ts`) sudah ada dan teruji, menunggu wiring backend. |
| **AI generik** | `AI_ENABLED` + `AI_API_KEY` (+ `AI_BASE_URL`, `AI_MODEL`) | ✅ Siap (default off) | `!ai`/`!ally`/`!tanya`, `!translate`, `!summarize`/`!ringkas`, `!aidetection`. Provider apa pun yang kompatibel OpenAI Chat Completions; model utama via `AI_MODEL`, fallback via `AI_FALLBACK_MODEL` + `AI_FALLBACK_ENABLED=true`. Input dibatasi 1.200 karakter, tanpa memori percakapan. Tanpa API key → command menjawab "belum dikonfigurasi". |
| **Redis** | `REDIS_ENABLED` + `REDIS_URL` | ✅ Siap (default off) | Cache snapshot ekonomi (TTL 15s), rate-limit, mutex, queue. **Fail-soft**: Redis mati → `logger.warn` per operasi (bukan silent), bot tetap berfungsi. |
| **Diagnostics** | `DIAGNOSTICS_ENABLED` | ✅ Siap (default off) | `!health` (hidden) & `!diag`: status framework, service aktif, uptime, RSS — non-sensitif. |
| **Codebase Export delivery** | `CODEBASE_EXPORT_ENABLED` | ✅ Siap (default off) | `!codebase` (hidden, permission developer) mengirim ZIP export tersanitasi terakhir (maks 3 MiB). Mengandalkan artifact CI terpasang di server. |
| **Sentry telemetry** | `SENTRY_ENABLED` + `SENTRY_DSN` | ✅ Siap (default off) | Error/checkpoint di-collapse (`beforeSend` meredact isi event, tanpa PII), fingerprint per operation. |
| Maintenance mode | `WHATSAPP_ENABLED=false` | ✅ | Framework + service hidup tanpa koneksi WhatsApp. |

Untuk tiga fitur stub: jalur wiring-nya sudah disiapkan sebagai *disable ladder* eksplisit di service (`hasBackend`) — flag `false` → plugin tidak meregistrasi apa pun; flag `true` tanpa backend → permukaan refusal tersembunyi; flag `true` + backend → command live penuh. Jadi mengaktifkan flag dengan backend yang belum ada **tidak merusak apa pun**; command-nya hanya menolak dengan satu pesan jelas.

## Known Limitations

1. **Baileys `7.0.0-rc14` adalah release candidate** — satu-satunya garis Baileys yang dipakai (`package.json`). API WS WhatsApp bisa berubah sebelum rilis final; risiko breaking update mengikuti garis RC ini.
2. **1 kerentanan HIGH: `sharp < 0.35.4`** (libheif, [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)) — masuk via peerDependency `sharp: "*"` milik Baileys dan terpasang sebagai `0.35.3` di lockfile. Perbaikan berencana: upgrade lock ke `0.35.4` (`npm audit fix`).
3. **Tiga fitur stub** — Economy, Group Context, Character Guide: backend RPC eksternal (Supabase/Postgres) belum di-inject di `src/index.ts`; command selalu menolak. Jangan dijanjikan ke pengguna.
4. **Panel deploy butuh konfigurasi** — tanpa `PANEL_URL`, `PTERODACTYL_SERVER_ID`, `PTERODACTYL_API_TOKEN`, dan `PANEL_DEPLOY_ENABLED`, job `deploy_panel` otomatis skipped (by design).
5. **Privasi by design membatasi fitur**: `afk_mentions` hanya menyimpan metadata routing (siapa/di mana/kapan) — isi pesan mention **tidak** dipersist; `ENABLE_HISTORY_SYNC` default off; JID di-hash SHA-256 sebelum keluar ke backend RPC.
6. **Test bergantung pada `dist/`** — harus build setiap kali source berubah (lihat [Troubleshooting](#troubleshooting)).
7. Plugin `utility-fun` (game ringan: `random`, `rps`, `8ball`, dsb.) ada di source dan teruji, tetapi **belum diregistrasi** di `src/index.ts` — command-nya tidak aktif di bot berjalan.

## Troubleshooting

| Gejala | Penyebab umum | Solusi |
|---|---|---|
| **QR tidak muncul saat start** | `QR_ENABLED` default `false` (bukan `true`) | Set `QR_ENABLED=true` di `.env`, restart. QR hanya dicetak saat creds belum terdaftar (`creds.registered` false) — jika sudah pernah pairing, sesi dimuat dari SQLite dan QR memang tidak muncul. |
| **Test merah banyak sekaligus / `ERR_MODULE_NOT_FOUND ../dist/...`** | `dist/` basi atau kosong — test import dari `dist`, bukan `src` | `rm -rf dist && npm run build && npm test`. CI selalu melakukan clean build; lakukan hal sama lokal. |
| **`SQLITE_BUSY` saat runtime** | Dua proses menulis ke `DATABASE_PATH` yang sama | DB sudah berjalan WAL + `busy_timeout=5000`; pastikan hanya satu instance bot per file DB (cek proses PID lama yang belum mati / cron duplikat). Jangan menaruh DB di path yang di-sync cloud. |
| **`Allybot failed to start: Invalid Allybot configuration: …`** | Validasi zod menolak env (mis. `REDIS_ENABLED=true` tanpa `REDIS_URL`, boolean bukan `'true'/'false'`, `PAIRING_ENABLED=true` tanpa nomor) | Baca pesan error — path + alasan selalu eksplisit; perbaiki `.env` lalu start ulang. |
| **Node versi salah / build aneh** | Bukan Node 22 | `node --version` harus `v22.x`; CI mem-hardcode pengecekan `major === 22`. Pakai nvm/fnm untuk switch. |
| **Redis aktif tapi bot "lambat"** | Redis unreachable → fail-soft dengan `warn` per operasi | Cek log `Redis health check failed` / `unhealthy`; bot sengaja tetap jalan — perbaiki `REDIS_URL` atau matikan `REDIS_ENABLED`. |
| **Bot logout sendiri (`needs_auth`)** | Sesi ditandai logged-out (device di-unlink) atau `connectionReplaced` (login di tempat lain) | Hapus sesi lama (data di tabel `auth_creds`) atau pairing ulang via QR. |
| **Command AI menjawab "belum dikonfigurasi"** | `AI_API_KEY` kosong meski `AI_ENABLED=true` | Isi `AI_API_KEY` (dan `AI_BASE_URL`/`AI_MODEL` bila provider bukan default) di `.env`; tanpa itu transport AI tidak dibuat. |

---

## Catatan Privasi & Keamanan (ringkas)

- JID tidak pernah dikirim mentah ke backend eksternal — di-hash SHA-256 (`hashIdentity`).
- Log pino men-redact 36 path sensitif (termasuk `pairingCode`, `qr`, `err.message`) — diverifikasi: log `pairingCode` tercetak sebagai `[REDACTED]`.
- Sentry events di-collapse menjadi label operation + error class (`beforeSend`), tanpa PII.
- CI menscan artifact export untuk JID numerik dan pola nomor HP Indonesia — match = job gagal.
- Command `!privacy` dan `!about` menjelaskan praktik data kepada pengguna akhir.

Dokumen ini menggambarkan repo pada commit `509f7e8`. Untuk daftar ide command (bukan kontrak implementasi), lihat `command-catalog.md`.
