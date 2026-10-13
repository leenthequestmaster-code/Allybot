import { execSync } from 'node:child_process'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { Plugin, CommandContext } from '../contracts.js'
import { permissionNames } from '../../permissions.js'

function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const secs = total % 60
  const parts: string[] = []
  if (days) parts.push(`${days}d`)
  if (hours || days) parts.push(`${hours}h`)
  if (minutes || hours || days) parts.push(`${minutes}m`)
  parts.push(`${secs}s`)
  return parts.join(' ')
}

function getDiskUsage(): string {
  try {
    if (process.platform === 'win32') {
      return 'Windows Host (NTFS)'
    }
    const output = execSync('df -h /', { timeout: 3_000, encoding: 'utf-8' })
    const lines = output.trim().split('\n')
    if (lines.length >= 2) {
      const parts = lines[1]?.split(/\s+/)
      if (parts && parts.length >= 5) {
        return `Used: ${parts[2]} / ${parts[1]} (${parts[4]} full)`
      }
    }
    return lines[1] ?? 'Disk info retrieved'
  } catch {
    return 'Disk check unavailable'
  }
}

export const remoteOpsPlugin: Plugin = {
  name: 'remote-ops',
  version: '0.1.0',
  load(context) {
    // 1. !vps / !host / !system
    context.commands.register({
      name: 'vps',
      aliases: ['hostinfo', 'sysinfo'],
      description: 'Snapshot performa dan resource server VPS (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        const totalMem = os.totalmem()
        const freeMem = os.freemem()
        const usedMem = totalMem - freeMem
        const memPercent = Math.round((usedMem / totalMem) * 100)

        const procMem = process.memoryUsage()
        const disk = getDiskUsage()
        const load = os.loadavg().map((n) => n.toFixed(2)).join(', ')
        const cpus = os.cpus()
        const cpuModel = cpus[0]?.model || 'Standard CPU'
        const cpuCores = cpus.length

        const status = [
          '🖥️ *VPS & Host Resource Snapshot*',
          '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
          `⡇╌ *Host OS*    : ${os.type()} ${os.release()} (${os.arch()})`,
          `⡇╌ *Host Uptime*: ${formatUptime(os.uptime())}`,
          `⡇╌ *CPU Cores*  : ${cpuCores}x (${cpuModel})`,
          `⡇╌ *Load Avg*   : ${load}`,
          '─͜──͜──͜─  · ✦ ·  ─͜──͜──͜─',
          `⡇╌ *OS RAM*     : ${Math.round(usedMem / 1024 / 1024)}MB / ${Math.round(totalMem / 1024 / 1024)}MB (${memPercent}%)`,
          `⡇╌ *Root Disk*  : ${disk}`,
          '─͜──͜──͜─  · ✦ ·  ─͜──͜──͜─',
          `⡇╌ *Node.js*    : ${process.version}`,
          `⡇╌ *Bot RSS*    : ${Math.round(procMem.rss / 1024 / 1024)} MB`,
          `⡇╌ *Bot Heap*   : ${Math.round(procMem.heapUsed / 1024 / 1024)} / ${Math.round(procMem.heapTotal / 1024 / 1024)} MB`,
          `⡇╌ *Bot Uptime* : ${formatUptime(process.uptime())}`,
          '━━━━━━━━━━━━━━━━━━━━',
          '*© Allybot Infrastructure*',
        ]

        await commandContext.reply(status.join('\n'))
      },
    })

    // 2. !restart / !reboot
    context.commands.register({
      name: 'restart',
      aliases: ['reboot'],
      description: 'Restart proses bot secara graceful via systemd (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        await commandContext.reply('🔄 *Allybot Reboot Initiated*\n\nBot sedang me-restart proses secara graceful. Systemd akan mengaktifkannya kembali dalam beberapa detik... 👋')
        setTimeout(() => {
          process.exit(0)
        }, 500)
      },
    })

    // 3. !clearmedia / !purgemedia
    context.commands.register({
      name: 'clearmedia',
      aliases: ['purgemedia', 'cleartemp'],
      description: 'Bersihkan cache temporary file media dan download (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        const targetDirs = ['./data/cache', './data/temp', './temp', './cache']
        let removedFiles = 0
        let freedBytes = 0

        for (const dir of targetDirs) {
          try {
            const files = readdirSync(dir)
            for (const file of files) {
              if (file === '.gitkeep' || file.startsWith('.')) continue
              const fullPath = join(dir, file)
              try {
                const stat = statSync(fullPath)
                if (stat.isFile()) {
                  freedBytes += stat.size
                  unlinkSync(fullPath)
                  removedFiles++
                }
              } catch {}
            }
          } catch {}
        }

        const freedMb = (freedBytes / (1024 * 1024)).toFixed(2)
        await commandContext.reply([
          '🧹 *Pembersihan Cache Media Selesai*',
          '',
          `↳ File terhapus: ${removedFiles} file`,
          `↳ Ruang disk dibebaskan: ${freedMb} MB`,
          '↳ Auth session & database: Aman tidak disentuh ✅',
        ].join('\n'))
      },
    })
  },
}

export default remoteOpsPlugin
