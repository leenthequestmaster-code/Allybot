import type { CommandContext, Plugin } from '../contracts.js'
import { permissionNames } from '../../permissions.js'
import {
  DeveloperModeService,
  normalizeDeveloperJid,
  type DeveloperModeActivation,
} from '../../services/developer-mode-service.js'

function formatUptime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const remainingSeconds = totalSeconds % 60
  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours || days) parts.push(`${hours}h`)
  if (minutes || hours || days) parts.push(`${minutes}m`)
  parts.push(`${remainingSeconds}s`)
  return parts.join(' ')
}

function connectionStatus(context: CommandContext): string {
  return context.whatsapp.currentStatus ?? (context.whatsapp.isConnected ? 'connected' : 'idle')
}

function bareJid(jid: string): string {
  return jid.split(':')[0] ?? jid
}

function isOwner(context: CommandContext): boolean {
  if (!context.message.senderJid || !context.config.botOwnerJid) return false
  try {
    if (bareJid(normalizeDeveloperJid(context.message.senderJid)) === bareJid(normalizeDeveloperJid(context.config.botOwnerJid))) return true
  } catch {}
  if (context.services.has('gatekeeper')) {
    try {
      const gk = context.services.get<any>('gatekeeper')
      if (typeof gk.isOwner === 'function' && gk.isOwner(context.message.senderJid)) return true
    } catch {}
  }
  return false
}

function service(context: CommandContext): DeveloperModeService {
  return context.services.get<DeveloperModeService>('developer-mode')
}

function formatActivation(activation: DeveloperModeActivation, revealTarget: boolean): string {
  const target = revealTarget ? activation.targetJid : 'activation milik akun ini'
  return [
    `↳ ID: ${activation.id}`,
    `↳ Target: ${target}`,
    `↳ Scope: ${activation.scope}`,
    `↳ Expires: ${new Date(activation.expiresAt).toISOString()}`,
    `↳ Reason: ${activation.reason}`,
  ].join('\n')
}

function helpText(): string {
  return [
    '🛠️ *Allybot Advanced Developer Suite*',
    '',
    '*Unified Developer Diagnostics:*',
    '↳ `!dev db` : Matrix status SQLite, PostgreSQL 17, Redis 8 & latency',
    '↳ `!dev ai` : Ping 9Router Sidecar (port 20128) & model registry check',
    '↳ `!dev logs [n]` : Bounded journalctl error logs with PII/secret scrubbing',
    '↳ `!dev mem` : V8 process memory snapshot (RSS, Heap, External)',
    '↳ `!dev gc` : Trigger manual garbage collection & report freed memory',
    '↳ `!dev plugins` : Summary registered plugins & active command surface',
    '↳ `!dev runtime` : Host platform, Node.js runtime, & process uptime',
    '↳ `!dev connection` : WhatsApp socket connection status',
    '',
    '*Developer Mode Delegation (Legacy/Observer):*',
    '↳ `!dev enable <phone-or-jid> <observer|operator> <minutes> <reason>`',
    '↳ `!dev disable <activation-id>`',
    '↳ `!dev kill` / `!dev resume`',
    '↳ `!dev status`',
  ].join('\n')
}

function parseMinutes(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new Error('Duration must be an integer number of minutes')
  const minutes = Number(value)
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1_440) {
    throw new Error('Duration must be between 1 and 1440 minutes')
  }
  return minutes
}

function safeError(error: unknown): string {
  if (error instanceof Error && /^(Duration|Developer Mode|Target|JID|Unsupported)/.test(error.message)) return error.message
  return 'Developer Mode request could not be completed.'
}

export const developerModePlugin: Plugin = {
  name: 'developer-mode-commands',
  version: '0.2.0',
  load(context) {
    context.commands.register({
      name: 'dev',
      aliases: ['debug'],
      description: 'Owner-controlled Developer Mode diagnostics',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.developerModeObserver,
      cooldownMs: 1_000,
      handler: async (commandContext) => {
        const developerMode = service(commandContext)
        const [subcommand = 'help', ...args] = commandContext.args.map((arg) => arg.trim()).filter(Boolean)
        const owner = isOwner(commandContext)

        if (subcommand === 'help') {
          await commandContext.reply(helpText())
          return
        }

        // 1. !dev db
        if (subcommand === 'db') {
          if (!owner) {
            await commandContext.reply('Maaf, hanya Owner yang dapat mengakses inspeksi database.')
            return
          }
          let redisClient: any
          try {
            if (commandContext.services.has('redis')) {
              redisClient = commandContext.services.get('redis')
            }
          } catch {}

          const matrix = await developerMode.inspectStorageMatrix(undefined, redisClient)
          const lines = [
            '🗄️ *Triple-DB Storage Matrix*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            '*[SQLite 3 Core]*',
            `⡇╌ Size       : ${matrix.sqlite.sizeKb} KB (WAL: ${matrix.sqlite.walSizeKb} KB)`,
            `⡇╌ Pages      : ${matrix.sqlite.pageCount} (Page size: ${matrix.sqlite.pageSize} B)`,
            `⡇╌ Latency    : ${matrix.sqlite.latencyMs} ms`,
            `⡇╌ Integrity  : ${matrix.sqlite.quickCheck}`,
            `⡇╌ Official G : ${matrix.sqlite.groupsCount} groups`,
            `⡇╌ Trial DMs  : ${matrix.sqlite.trialGuestsCount} guests`,
            `⡇╌ Shadowbans : ${matrix.sqlite.shadowbanCount} targets`,
            '─͜──͜──͜─  · ✦ ·  ─͜──͜──͜─',
            '*[PostgreSQL 17]*',
            matrix.postgres?.available
              ? [
                  `⡇╌ Status     : Connected (${matrix.postgres.latencyMs} ms)`,
                  `⡇╌ Characters : ${matrix.postgres.characterCount} active profiles`,
                  `⡇╌ Economy    : ${matrix.postgres.economyAccounts} wallets (${matrix.postgres.economyTotalVela} Vela)`,
                ].join('\n')
              : `⡇╌ Status     : ${matrix.postgres?.error ? `Offline (${matrix.postgres.error})` : 'Standalone (SQLite Fallback)'}`,
            '─͜──͜──͜─  · ✦ ·  ─͜──͜──͜─',
            '*[Redis 8 Cache]*',
            matrix.redis?.available
              ? [
                  `⡇╌ Status     : Connected (${matrix.redis.latencyMs} ms)`,
                  `⡇╌ Memory     : ${matrix.redis.usedMemoryHuman}`,
                  `⡇╌ Keys       : ${matrix.redis.keysCount} keys`,
                ].join('\n')
              : `⡇╌ Status     : ${matrix.redis?.error ? `Offline (${matrix.redis.error})` : 'Not configured'}`,
            '━━━━━━━━━━━━━━━━━━━━',
            '*© Allyssea Core Infrastructure*',
          ]
          await commandContext.reply(lines.join('\n'))
          return
        }

        // 2. !dev ai
        if (subcommand === 'ai') {
          if (!owner) {
            await commandContext.reply('Maaf, hanya Owner yang dapat memeriksa sidecar AI.')
            return
          }
          const aiStatus = await developerMode.pingAiSidecar()
          const lines = [
            '🤖 *9Router AI Sidecar Telemetry*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ Endpoint   : http://127.0.0.1:20128/v1/models`,
            `⡇╌ Status     : ${aiStatus.reachable ? `Online (${aiStatus.statusCode})` : 'Offline / Unreachable'}`,
            `⡇╌ Latency    : ${aiStatus.latencyMs} ms`,
            `⡇╌ Models Reg : ${aiStatus.modelCount !== undefined ? `${aiStatus.modelCount} models` : 'N/A'}`,
            aiStatus.error ? `⡇╌ Error      : ${aiStatus.error}` : '⡇╌ Health     : Nominal (unlimited_token proxy)',
            '━━━━━━━━━━━━━━━━━━━━',
            '*© Allyssea Neural Fabric*',
          ]
          await commandContext.reply(lines.join('\n'))
          return
        }

        // 3. !dev logs [n]
        if (subcommand === 'logs') {
          if (!owner) {
            await commandContext.reply('Maaf, hanya Owner yang dapat membaca log sistem.')
            return
          }
          const count = Number(args[0]) || 10
          const logs = await developerMode.collectLogs(count)
          const text = [
            `📋 *Systemd Error Logs (Last ${logs.length} entries)*`,
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            ...logs.map((l) => `\`\`\`${l}\`\`\``),
            '━━━━━━━━━━━━━━━━━━━━',
            '🔒 _Sensitive secrets & PII are automatically redacted._',
          ].join('\n')
          await commandContext.reply(text)
          return
        }

        // 4. !dev mem
        if (subcommand === 'mem') {
          const mem = developerMode.collectMemoryAndOptionalGc(false)
          const lines = [
            '🧠 *V8 Process Memory Footprint*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ Resident Set (RSS) : ${mem.rssMb} MiB`,
            `⡇╌ Heap Used          : ${mem.heapUsedMb} MiB`,
            `⡇╌ Heap Total         : ${mem.heapTotalMb} MiB`,
            `⡇╌ External (C++)     : ${mem.externalMb} MiB`,
            `⡇╌ ArrayBuffers       : ${mem.arrayBuffersMb} MiB`,
            '━━━━━━━━━━━━━━━━━━━━',
            '💡 _Gunakan `!dev gc` untuk memicu manual garbage collector._',
          ]
          await commandContext.reply(lines.join('\n'))
          return
        }

        // 5. !dev gc
        if (subcommand === 'gc') {
          if (!owner) {
            await commandContext.reply('Maaf, hanya Owner yang dapat memicu Garbage Collection.')
            return
          }
          const mem = developerMode.collectMemoryAndOptionalGc(true)
          if (!mem.gcExecuted) {
            await commandContext.reply('⚠️ `global.gc()` tidak aktif pada runtime Node.js ini (butuh flag `--expose-gc`).')
            return
          }
          const lines = [
            '🧹 *Manual Garbage Collection Triggered*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ Heap Dibebaskan   : ${mem.freedHeapMb ?? 0} MiB`,
            `⡇╌ Heap Terpakai Kini: ${mem.heapUsedMb} MiB / ${mem.heapTotalMb} MiB`,
            `⡇╌ RSS Sekarang      : ${mem.rssMb} MiB`,
            '━━━━━━━━━━━━━━━━━━━━',
            '✅ _V8 memory sweep selesai._',
          ]
          await commandContext.reply(lines.join('\n'))
          return
        }

        // 6. !dev plugins
        if (subcommand === 'plugins') {
          const totalCommands = context.commands.list().length
          const lines = [
            '🧩 *Allybot Framework Plugins & Commands*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ Active Commands Surface : ${totalCommands} commands registered`,
            `⡇╌ Core Architecture      : Ports & Adapters (Hexagonal)`,
            `⡇╌ Gatekeeper Mode        : Walled-Garden Active`,
            '━━━━━━━━━━━━━━━━━━━━',
          ]
          await commandContext.reply(lines.join('\n'))
          return
        }

        if (subcommand === 'enable') {
          if (!owner) {
            await commandContext.reply('Maaf, hanya Owner yang dapat mengaktifkan Developer Mode.')
            return
          }
          const [target, scope, minutes, ...reasonParts] = args
          if (!target || (scope !== 'observer' && scope !== 'operator') || !minutes || reasonParts.length === 0) {
            await commandContext.reply('Usage: `!dev enable <international-phone-or-jid> <observer|operator> <minutes> <reason>`')
            return
          }
          try {
            const activation = developerMode.activate(
              commandContext.config.botOwnerJid ?? commandContext.message.senderJid ?? '',
              target,
              scope,
              parseMinutes(minutes) * 60_000,
              reasonParts.join(' '),
            )
            await commandContext.reply([
              '✅ *Developer Mode berhasil diaktifkan.*',
              '',
              formatActivation(activation, true),
              '↳ Mode: Owner-controlled activation',
            ].join('\n'))
          } catch (error) {
            await commandContext.reply(`Developer Mode tidak diaktifkan: ${safeError(error)}`)
          }
          return
        }

        if (subcommand === 'disable') {
          if (!owner) {
            await commandContext.reply('Maaf, hanya Owner yang dapat mencabut Developer Mode.')
            return
          }
          const activationId = args[0]
          if (!activationId || !/^dm_[a-f0-9]{20}$/.test(activationId)) {
            await commandContext.reply('Usage: `!dev disable <activation-id>`')
            return
          }
          const revoked = developerMode.revoke(commandContext.config.botOwnerJid ?? commandContext.message.senderJid ?? '', activationId)
          await commandContext.reply(revoked ? '✅ Developer Mode activation berhasil dicabut.' : 'Activation tidak ditemukan atau sudah tidak aktif.')
          return
        }

        if (subcommand === 'kill' || subcommand === 'resume') {
          if (!owner) {
            await commandContext.reply('Maaf, hanya Owner yang dapat mengubah global Developer Mode state.')
            return
          }
          developerMode.setGlobalEnabled(commandContext.config.botOwnerJid ?? commandContext.message.senderJid ?? '', subcommand === 'resume')
          await commandContext.reply(subcommand === 'kill'
            ? '⛔ Developer Mode dinonaktifkan secara global. Activation tidak dihapus dan tetap memerlukan resume Owner.'
            : '✅ Developer Mode global diaktifkan kembali. Activation yang sudah revoke/expired tidak dipulihkan.')
          return
        }

        if (subcommand === 'status') {
          const activations = developerMode.listVisibleActivations(commandContext.message.senderJid ?? '', owner)
          const global = developerMode.isGloballyEnabled() ? 'enabled' : 'disabled'
          await commandContext.reply([
            `🛡️ *Developer Mode: ${global}*`,
            '',
            activations.length === 0
              ? '↳ Tidak ada activation aktif untuk scope ini.'
              : activations.map((activation) => formatActivation(activation, owner)).join('\n\n'),
          ].join('\n'))
          return
        }

        if (subcommand === 'runtime') {
          const memory = process.memoryUsage()
          await commandContext.reply([
            '🧪 *Developer Runtime Snapshot*',
            '',
            `↳ Node: ${process.versions.node}`,
            `↳ Platform: ${process.platform}/${process.arch}`,
            `↳ Uptime: ${formatUptime(process.uptime())}`,
            `↳ RSS: ${Math.round(memory.rss / 1024 / 1024)} MiB`,
            `↳ Heap: ${Math.round(memory.heapUsed / 1024 / 1024)}/${Math.round(memory.heapTotal / 1024 / 1024)} MiB`,
            `↳ Connection: ${connectionStatus(commandContext)}`,
            '↳ Credentials/session/database/raw logs: redacted',
          ].join('\n'))
          return
        }

        if (subcommand === 'connection') {
          await commandContext.reply([
            '🔌 *Developer Connection Snapshot*',
            '',
            `↳ Status: ${connectionStatus(commandContext)}`,
            `↳ Linked: ${commandContext.whatsapp.isConnected ? 'yes' : 'no'}`,
            '↳ Account identity: redacted',
            '↳ Pairing/QR/session material: redacted',
          ].join('\n'))
          return
        }

        await commandContext.reply('Subcommand Developer Mode tidak dikenal. Gunakan `!dev help`.')
      },
    })
  },
}

export default developerModePlugin
