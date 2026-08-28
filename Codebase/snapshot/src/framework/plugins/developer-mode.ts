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
    return bareJid(normalizeDeveloperJid(context.message.senderJid)) === bareJid(normalizeDeveloperJid(context.config.botOwnerJid))
  } catch {
    return false
  }
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
    '🛠️ *Owner-Controlled Developer Mode*',
    '',
    'Observer commands:',
    '↳ `!dev help`',
    '↳ `!dev status`',
    '↳ `!dev runtime`',
    '↳ `!dev connection`',
    '↳ `!dev commands`',
    '↳ `!dev services`',
    '↳ `!codebase` — kirim export Codebase tersanitasi terakhir dari CI (jika diaktifkan)',
    '',
    'Owner control:',
    '↳ `!dev enable <international-phone-or-jid> <observer|operator> <minutes> <reason>`',
    '↳ `!dev disable <activation-id>`',
    '↳ `!dev kill`',
    '↳ `!dev resume`',
    '',
    'Developer Mode tidak menyediakan eval, exec, shell, raw logs, database dump, credential, logout, atau reconnect.',
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
  version: '0.1.0',
  load(context) {
    context.commands.register({
      name: 'dev',
      aliases: ['debug'],
      description: 'Owner-controlled Developer Mode diagnostics',
      category: 'developer',
      hidden: true,
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

        if (subcommand === 'commands') {
          const commands = context.commands.list()
            .filter((command) => command.name !== 'dev')
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((command) => `↳ ${command.name}${command.aliases?.length ? ` (${command.aliases.join(', ')})` : ''} — ${command.category ?? 'uncategorized'} — ${command.permission ?? 'public'}`)
          await commandContext.reply(['📚 *Command Registry Metadata*', '', ...commands, '', 'Handler source, credentials, and raw implementation: redacted'].join('\n'))
          return
        }

        if (subcommand === 'services') {
          await commandContext.reply([
            '🧩 *Service Registry Metadata*',
            '',
            ...commandContext.services.list().map((name) => `↳ ${name}`),
            '',
            'Service internals, paths, credentials, and database rows: redacted',
          ].join('\n'))
          return
        }

        await commandContext.reply('Subcommand Developer Mode tidak dikenal. Gunakan `!dev help`.')
      },
    })
  },
}

export default developerModePlugin
