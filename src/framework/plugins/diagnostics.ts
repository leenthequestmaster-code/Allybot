import type { CommandContext, Plugin } from '../contracts.js'

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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

function status(context: CommandContext): string {
  return context.whatsapp.currentStatus ?? (context.whatsapp.isConnected ? 'connected' : 'idle')
}

function commonHealth(context: CommandContext): string {
  const services = context.services.list().join(',') || 'no-services'
  return [
    'Allybot framework ready',
    `connected=${context.whatsapp.isConnected}`,
    `services=${services}`,
    `status=${status(context)}`,
    `uptime=${formatUptime(process.uptime())}`,
    `rss=${formatBytes(process.memoryUsage().rss)}`,
  ].join(' | ')
}

function detailedDiagnostics(context: CommandContext): string {
  return [
    commonHealth(context),
    `node=${process.versions.node}`,
    `arch=${process.arch}`,
    `platform=${process.platform}`,
    `mode=${context.message.remoteJid.endsWith('@g.us') ? 'group' : 'private'}`,
  ].join(' | ')
}

export const diagnosticsPlugin: Plugin = {
  name: 'diagnostics',
  version: '0.2.0',
  load(context) {
    context.commands.register({
      name: 'health',
      description: 'Show a concise non-sensitive framework health snapshot',
      category: 'system',
      menuOrder: 5,
      cooldownMs: 3000,
      hidden: true,
      handler: async (commandContext) => {
        await commandContext.reply(commonHealth(commandContext))
      },
    })

    context.commands.register({
      name: 'diag',
      description: 'Show a detailed non-sensitive framework diagnostics snapshot',
      category: 'system',
      menuOrder: 6,
      cooldownMs: 3000,
      handler: async (commandContext) => {
        await commandContext.reply(detailedDiagnostics(commandContext))
      },
    })
  },
}
