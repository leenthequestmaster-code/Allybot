# Allybot Application Framework Architecture

## Tujuan dan batasan

Application Framework Allybot adalah lapisan aplikasi di atas core WhatsApp yang sudah stabil. Framework tidak membuat socket Baileys, tidak mengelola auth state, dan tidak mengubah reconnect/watchdog policy. Framework hanya berkomunikasi dengan core melalui `WhatsAppPort`: menerima message/connection event, membaca status, dan meminta pengiriman text.

> **Invariant:** perubahan command, plugin, middleware, service, atau scheduler tidak boleh memerlukan perubahan pada auth/session store dan connection lifecycle core.

## Struktur project

```text
src/
├── config.ts                 # konfigurasi existing dan validation
├── errors.ts                 # error taxonomy existing
├── logger.ts                 # Pino existing
├── storage.ts                # SQLite/auth/message store existing
├── whatsapp.ts               # Baileys transport + reliability; adapter seam only
├── lifecycle.ts              # process lifecycle; framework-first boot/shutdown
├── index.ts                  # composition root
└── framework/
    ├── contracts.ts          # WhatsAppPort, events, Context, Plugin, Service, Command
    ├── event-bus.ts          # typed application event dispatch + isolation
    ├── middleware.ts         # compose, permission, cooldown, validation middleware
    ├── service-registry.ts   # dependency-aware service initialization/shutdown
    ├── command-registry.ts   # parsing, alias, permission, cooldown, execution
    ├── plugin-manager.ts     # load/initialize/ready/unload lifecycle
    ├── application.ts        # framework composition and core adapter binding
    └── plugins/
        └── diagnostics.ts    # minimal proof-of-concept command/plugin

tests/
├── framework.test.js        # event, command, middleware, plugin, service tests
└── integration.test.js      # fake core/application integration tests
```

## Lifecycle

| Fase | Tindakan | Failure policy |
|---|---|---|
| `created` | Composition root membuat core adapter, event bus, registry, dan manager. | Configuration failure menghentikan boot. |
| `bootstrapping` | Framework mengikat listener core sebelum core socket start. | Listener registration failure menghentikan boot. |
| `services` | Service registry memvalidasi dependency dan memanggil `initialize`. | Service gagal menghentikan boot dan tidak memulai WhatsApp core. |
| `plugins.load` | Plugin divalidasi, didaftarkan, dan `load` dipanggil. | Plugin gagal diisolasi; production policy dapat menolak plugin required. |
| `plugins.initialize` | Plugin melakukan setup internal. | Error dicatat; plugin faulty tidak masuk ready. |
| `ready` | Core start dipanggil; framework menerima event dan dispatch command. | Runtime event error diisolasi per listener/command. |
| `stopping` | Framework menolak dispatch baru, unload plugin, shutdown service, lalu core close. | Shutdown tetap bounded dan dilaporkan. |

## Interface boundary

```ts
interface WhatsAppPort {
  readonly isConnected: boolean
  readonly userJid?: string
  onMessage(listener: (message: CoreMessage) => Promise<void> | void): () => void
  onConnectionState(listener: (event: CoreConnectionState) => Promise<void> | void): () => void
  sendText(remoteJid: string, text: string): Promise<void>
  getGroupMetadata(groupJid: string): Promise<WhatsAppGroupMetadata>
  getGroupInviteLink(groupJid: string): Promise<string | undefined>
  start(): Promise<void>
  close(): Promise<void>
}
```

`CoreMessage` sudah dinormalisasi oleh core setelah security gate dan deduplication. Framework tidak menerima QR, auth keys, raw socket, atau Baileys event emitter. `CoreConnectionState` hanya berisi status publik, timestamp, dan optional reason code. Group plugin hanya memakai metadata dan invite link yang telah dinormalisasi melalui `WhatsAppPort`; plugin tidak boleh memanggil raw socket.

## Event model

Framework memakai event names yang stabil dan tidak mengekspos event Baileys langsung: `connection.changed`, `message.received`, `command.before`, `command.executed`, `command.failed`, `plugin.loaded`, `plugin.failed`, `framework.error`, dan `framework.ready`. Event listener dieksekusi dengan error isolation; satu listener gagal tidak menjatuhkan process atau menghentikan listener lain.

## Command dan context

Command mempunyai canonical name, aliases, description, optional permission, cooldown, argument validator, dan async handler. Dispatcher hanya memproses `CoreMessage` inbound yang mempunyai text. `CommandContext` berisi message, sender, chat, args, config, logger, service registry, bot port, dan `reply(text)`. Handler tidak boleh mengakses `WASocket`, auth state, SQLite connection, atau environment secara langsung.

## Plugin dan service

Plugin mempunyai `name`, optional `version`, optional `dependencies`, serta lifecycle `load`, `initialize`, `ready`, dan `unload`. Plugin hanya mendaftarkan command/event/service melalui framework context. Service mempunyai `name`, dependencies, `initialize`, dan `shutdown`. Registry melakukan dependency validation sebelum init; shutdown dilakukan secara reverse order.

Framework tidak mendaftarkan service default yang belum memiliki kebutuhan nyata. `ServiceRegistry` tersedia sebagai extension point untuk database, cache, HTTP client, scheduler, atau media processor ketika fitur tersebut benar-benar dibangun; tidak ada singleton kosong yang dibuat hanya demi struktur.

## Middleware

`CommandRegistry` terlebih dahulu melakukan text filter, prefix parsing, dan lookup command. Setelah command ditemukan, middleware di-compose dalam urutan tetap: permission, cooldown/rate limit, argument validation, middleware tambahan, lalu handler. Middleware dapat menghentikan chain dengan alasan yang aman; alasan internal dicatat sebagai structured log tanpa membocorkan message body atau secret.

## Error boundary dan diagnostics

Framework membedakan configuration/registration failure saat boot dari runtime command/plugin failure. Runtime failure dipublikasikan sebagai `framework.error`, dicatat dengan plugin/command/correlation context, dan tidak mematikan core. Diagnostic command proof-of-concept hanya mengembalikan status framework yang tidak sensitif; tidak ada fitur bisnis besar yang dibuat.

## Testing standard

Test minimal harus membuktikan event listener isolation, service dependency/init/shutdown order, plugin lifecycle, command name/alias parsing, permission denial, cooldown, argument validation, handler error isolation, configuration validation, graceful application shutdown, serta adapter-to-framework message dispatch menggunakan fake core. Live WhatsApp hanya diverifikasi melalui smoke test Pterodactyl; unit tests tidak menggunakan akun nyata.
