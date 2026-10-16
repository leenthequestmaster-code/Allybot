import { execSync } from 'node:child_process'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { Plugin, CommandContext, CoreMessage } from '../contracts.js'
import { permissionNames } from '../../permissions.js'
import type { RemoteOpsService } from '../../services/remote-ops-service.js'
import type { GatekeeperService } from '../../services/gatekeeper-service.js'
import { isGroupJid } from '../validation.js'

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

function bareJid(jid: string): string {
  return jid.split(':')[0] ?? jid
}

function isOwner(context: CommandContext): boolean {
  if (!context.message.senderJid || !context.config.botOwnerJid) return false
  if (bareJid(context.message.senderJid) === bareJid(context.config.botOwnerJid)) return true
  if (context.services.has('gatekeeper')) {
    try {
      const gk = context.services.get<any>('gatekeeper')
      if (typeof gk.isOwner === 'function' && gk.isOwner(context.message.senderJid)) return true
    } catch {}
  }
  return false
}

export const remoteOpsPlugin: Plugin = {
  name: 'remote-ops',
  version: '0.3.0',
  load(context) {
    // 0. Register Walled-Garden Policy Gate
    context.messageGates.register('walled-garden-gate', async (message: CoreMessage) => {
      if (message.fromMe) return { allowed: true }

      let remoteOps: RemoteOpsService | undefined
      let gatekeeper: GatekeeperService | undefined
      try {
        if (context.services.has('remote-ops')) {
          remoteOps = context.services.get<RemoteOpsService>('remote-ops')
        }
        if (context.services.has('gatekeeper')) {
          gatekeeper = context.services.get<GatekeeperService>('gatekeeper')
        }
      } catch {}

      if (remoteOps) {
        await remoteOps.handleIncomingMessage(message)
      }

      if (gatekeeper) {
        return await gatekeeper.evaluateMessage(message)
      }

      return { allowed: true }
    })

    // 1. !vps / !host / !sysinfo
    context.commands.register({
      name: 'vps',
      aliases: ['hostinfo', 'sysinfo'],
      description: 'Snapshot performa dan resource server VPS (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
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
          '*DEV // VPS & Host Resource Snapshot*',
          '',
          `• Host OS    : ${os.type()} ${os.release()} (${os.arch()})`,
          `• Host Uptime: ${formatUptime(os.uptime())}`,
          `• CPU Cores  : ${cpuCores}x (${cpuModel})`,
          `• Load Avg   : ${load}`,
          `• OS RAM     : ${Math.round(usedMem / 1024 / 1024)} MB / ${Math.round(totalMem / 1024 / 1024)} MB (${memPercent}%)`,
          `• Root Disk  : ${disk}`,
          '',
          `• Node.js    : ${process.version}`,
          `• Bot RSS    : ${Math.round(procMem.rss / 1024 / 1024)} MB`,
          `• Bot Heap   : ${Math.round(procMem.heapUsed / 1024 / 1024)} / ${Math.round(procMem.heapTotal / 1024 / 1024)} MB`,
          `• Bot Uptime : ${formatUptime(process.uptime())}`,
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
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        await commandContext.reply('*DEV // REBOOT INITIATED*\n\nMe-restart proses Allybot secara graceful via systemd...')
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
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
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
          '*DEV // MEDIA CACHE PURGED*',
          '',
          `• File terhapus   : ${removedFiles} file`,
          `• Disk dibebaskan : ${freedMb} MB`,
          `• Core Storage    : Aman tidak disentuh`,
        ].join('\n'))
      },
    })

    // 4. !auth <add|remove|list|mode|ooc>
    context.commands.register({
      name: 'auth',
      description: 'Kelola whitelist grup komunitas resmi Allyssea & Gatekeeper Mode (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const gatekeeper = context.services.get<GatekeeperService>('gatekeeper')
        if (!gatekeeper) {
          await commandContext.reply('GatekeeperService tidak aktif.')
          return
        }

        const [subcommand = 'list', targetJid, ...nameParts] = commandContext.args.map((a) => a.trim()).filter(Boolean)

        if (subcommand === 'list') {
          const groups = gatekeeper.listOfficialGroups()
          const mode = gatekeeper.getGateMode()
          if (groups.length === 0) {
            await commandContext.reply(`*DEV // WALLED-GARDEN GROUPS* (Mode: ${mode})\n\nBelum ada grup resmi yang terdaftar.`)
            return
          }
          const lines = [
            `*DEV // WALLED-GARDEN GROUPS* (Mode: \`${mode}\`)`,
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            ...groups.map((g, idx) => {
              const tags = []
              if (g.isOocHub) tags.push('OOC Hub')
              if (g.remoteSilenced) tags.push('Silenced')
              if (g.sniffOnce) tags.push('Sniff-Once')
              const tagStr = tags.length ? ` [${tags.join(', ')}]` : ''
              return `${idx + 1}. *${g.name || 'Unnamed Group'}*${tagStr}\n   • \`${g.jid}\` (${g.memberCount} members)`
            }),
            '━━━━━━━━━━━━━━━━━━━━',
            '_Gunakan `!auth add <jid> [name]` atau `!auth remove <jid>`._',
          ]
          await commandContext.reply(lines.join('\n'))
          return
        }

        if (subcommand === 'add') {
          const jid = targetJid || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
          if (!jid || !jid.endsWith('@g.us')) {
            await commandContext.reply('Usage: `!auth add <group-jid@g.us> [nama grup]` (atau jalankan di dalam grup target)')
            return
          }
          const name = nameParts.join(' ') || 'Official Community Group'
          gatekeeper.registerGroup(jid, name, commandContext.message.senderJid ?? 'owner')
          await commandContext.reply(`Grup *${name}* (\`${jid}\`) berhasil didaftarkan sebagai grup komunitas resmi Allyssea.`)
          return
        }

        if (subcommand === 'remove') {
          const jid = targetJid || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
          if (!jid) {
            await commandContext.reply('Usage: `!auth remove <group-jid@g.us>`')
            return
          }
          const removed = gatekeeper.removeGroup(jid)
          await commandContext.reply(removed ? `Grup \`${jid}\` berhasil dihapus dari daftar resmi.` : `Grup \`${jid}\` tidak ditemukan.`)
          return
        }

        if (subcommand === 'ooc') {
          const jid = targetJid || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
          if (!jid || !jid.endsWith('@g.us')) {
            await commandContext.reply('Usage: `!auth ooc <group-jid@g.us>`')
            return
          }
          gatekeeper.setOocGroup(jid)
          await commandContext.reply(`Grup \`${jid}\` ditetapkan sebagai *Official OOC Hub* Allyssea. Link invite dinamis akan otomatis diselesaikan ke grup ini.`)
          return
        }

        if (subcommand === 'mode') {
          const mode = targetJid
          if (mode !== 'strict' && mode !== 'strict_walled_garden' && mode !== 'permissive') {
            await commandContext.reply('Usage: `!auth mode <strict|permissive>`')
            return
          }
          gatekeeper.setGateMode(mode as any)
          await commandContext.reply(`Gatekeeper Mode diubah menjadi: \`${mode}\`.`)
          return
        }

        if (subcommand === 'bulk') {
          const raw = commandContext.args.slice(1).join(' ')
          const matches = raw.match(/[0-9]{15,25}@g\.us/g)
          if (!matches || matches.length === 0) {
            await commandContext.reply('Usage: `!auth bulk <jid1@g.us> <jid2@g.us> ...`\n\nKirim daftar JID grup yang dipisahkan spasi atau baris baru.')
            return
          }
          const uniqueJids = Array.from(new Set(matches))
          let addedCount = 0
          for (const jid of uniqueJids) {
            gatekeeper.registerGroup(jid, 'Official Community Group', commandContext.message.senderJid ?? 'owner')
            addedCount++
          }
          await commandContext.reply(`*DEV // BULK REGISTER*\n\n• Berhasil mendaftarkan ${addedCount} grup ke whitelist resmi Allyssea.\n• Jalankan \`!syncmembers\` untuk memperbarui cache peserta.`)
          return
        }

        if (subcommand === 'enrollall') {
          const listParticipatingGroups = commandContext.whatsapp.listParticipatingGroups
          if (!listParticipatingGroups) {
            await commandContext.reply('Adapter WhatsApp belum mendukung listParticipatingGroups.')
            return
          }
          const excludeTerms = commandContext.args.slice(1).map((s) => s.toLowerCase().trim()).filter(Boolean)
          const filters = excludeTerms.length > 0 ? excludeTerms : ['s.e.n.t.r.y', 'sentry', 'unnamed', 'althara', 'garden of memories', 'star paradise', 'paradise']

          try {
            const allGroups = await listParticipatingGroups.call(commandContext.whatsapp)
            const enrolled: Array<{ jid: string; name: string }> = []
            const skipped: Array<{ jid: string; name: string; reason: string }> = []

            for (const g of allGroups) {
              const nameLower = (g.subject || '').toLowerCase()
              const isExcluded = filters.some((term) => nameLower.includes(term) || g.jid.toLowerCase().includes(term))
              if (isExcluded) {
                skipped.push({ jid: g.jid, name: g.subject, reason: 'Match exclusion filter' })
              } else {
                gatekeeper.registerGroup(g.jid, g.subject || 'Official Community Group', commandContext.message.senderJid ?? 'owner')
                enrolled.push({ jid: g.jid, name: g.subject })
              }
            }

            const lines = [
              '*DEV // AUTO-ENROLLMENT GRUP*',
              '',
              `• Berhasil didaftarkan: ${enrolled.length} grup`,
              ...enrolled.map((e, idx) => `${idx + 1}. *${e.name}* (\`${e.jid}\`)`),
              '',
              `• Dilewati (Exclusion): ${skipped.length} grup`,
              ...skipped.map((s) => `- ~${s.name}~ (\`${s.jid}\`)`),
              '',
              '_Jalankan `!syncmembers` untuk menyegarkan cache member._',
            ]
            await commandContext.reply(lines.join('\n'))
          } catch (err: any) {
            await commandContext.reply('Gagal mengambil daftar grup: ' + (err?.message || String(err)))
          }
          return
        }

        await commandContext.reply('Subcommand `!auth` tidak dikenal. Pilihan: `list`, `add`, `bulk`, `enrollall`, `remove`, `ooc`, `mode`.')
      },
    })

    // Shortcut: !addjidbulk <groupJid...>
    context.commands.register({
      name: 'addjidbulk',
      description: 'Shortcut daftarkan banyak grup sekaligus ke whitelist (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const gatekeeper = context.services.get<GatekeeperService>('gatekeeper')
        if (!gatekeeper) {
          await commandContext.reply('GatekeeperService tidak aktif.')
          return
        }
        const raw = commandContext.args.join(' ')
        const matches = raw.match(/[0-9]{15,25}@g\.us/g)
        if (!matches || matches.length === 0) {
          await commandContext.reply('Usage: `!addjidbulk <jid1@g.us> <jid2@g.us> ...`')
          return
        }
        const uniqueJids = Array.from(new Set(matches))
        for (const jid of uniqueJids) {
          gatekeeper.registerGroup(jid, 'Official Community Group', commandContext.message.senderJid ?? 'owner')
        }
        await commandContext.reply(`Berhasil mendaftarkan ${uniqueJids.length} grup ke whitelist resmi Allyssea.`)
      },
    })

    // Shortcut: !addjid <groupJid> [name]
    context.commands.register({
      name: 'addjid',
      description: 'Shortcut daftarkan grup komunitas resmi Allyssea (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const gatekeeper = context.services.get<GatekeeperService>('gatekeeper')
        if (!gatekeeper) {
          await commandContext.reply('GatekeeperService tidak aktif.')
          return
        }
        const [targetJid, ...nameParts] = commandContext.args.map((a) => a.trim()).filter(Boolean)
        const jid = targetJid || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
        if (!jid || !jid.endsWith('@g.us')) {
          await commandContext.reply('Usage: `!addjid <group-jid@g.us> [nama grup]`')
          return
        }
        const name = nameParts.join(' ') || 'Official Community Group'
        gatekeeper.registerGroup(jid, name, commandContext.message.senderJid ?? 'owner')
        await commandContext.reply(`Grup *${name}* (\`${jid}\`) berhasil didaftarkan sebagai grup komunitas resmi Allyssea.`)
      },
    })

    // Shortcut: !deljid <groupJid>
    context.commands.register({
      name: 'deljid',
      description: 'Shortcut hapus grup dari whitelist resmi Allyssea (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const gatekeeper = context.services.get<GatekeeperService>('gatekeeper')
        if (!gatekeeper) {
          await commandContext.reply('GatekeeperService tidak aktif.')
          return
        }
        const targetJid = commandContext.args[0]?.trim() || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
        if (!targetJid) {
          await commandContext.reply('Usage: `!deljid <group-jid@g.us>`')
          return
        }
        const removed = gatekeeper.removeGroup(targetJid)
        await commandContext.reply(removed ? `Grup \`${targetJid}\` dihapus dari whitelist resmi.` : `Grup \`${targetJid}\` tidak ditemukan.`)
      },
    })

    // Shortcut: !addooc <groupJid|inviteLink>
    context.commands.register({
      name: 'addooc',
      description: 'Shortcut atur Official OOC Hub atau link invite publik (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const gatekeeper = context.services.get<GatekeeperService>('gatekeeper')
        if (!gatekeeper) {
          await commandContext.reply('GatekeeperService tidak aktif.')
          return
        }
        const target = commandContext.args[0]?.trim() || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
        if (!target) {
          await commandContext.reply('Usage: `!addooc <group-jid@g.us | link-invite-whatsapp>`')
          return
        }
        if (target.startsWith('http')) {
          gatekeeper.setOocStaticLink(target)
          await commandContext.reply(`Static invite link OOC ditetapkan ke: ${target}`)
        } else if (target.endsWith('@g.us')) {
          gatekeeper.setOocGroup(target)
          await commandContext.reply(`Grup \`${target}\` ditetapkan sebagai *Official OOC Hub*. Bot akan mengambil dynamic invite link dari grup ini.`)
        } else {
          await commandContext.reply('Target harus berupa JID grup (`...@g.us`) atau URL invite WhatsApp.')
        }
      },
    })

    // Shortcut: !gate <strict|permissive>
    context.commands.register({
      name: 'gate',
      description: 'Shortcut ganti mode proteksi Walled-Garden (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const gatekeeper = context.services.get<GatekeeperService>('gatekeeper')
        if (!gatekeeper) {
          await commandContext.reply('GatekeeperService tidak aktif.')
          return
        }
        const mode = commandContext.args[0]?.toLowerCase().trim()
        if (mode !== 'strict' && mode !== 'strict_walled_garden' && mode !== 'permissive') {
          await commandContext.reply(`Status Gatekeeper saat ini: \`${gatekeeper.getGateMode()}\`\n\nUbah dengan: \`!gate <strict|permissive>\``)
          return
        }
        gatekeeper.setGateMode(mode as any)
        await commandContext.reply(`Walled-Garden Gatekeeper Mode sekarang: \`${mode}\`.`)
      },
    })

    // 5. !shadowban <add|remove|list>
    context.commands.register({
      name: 'shadowban',
      aliases: ['sban'],
      description: 'Ghost drop / silent ignore akun spammer & perusuh tanpa notifikasi (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const gatekeeper = context.services.get<GatekeeperService>('gatekeeper')
        if (!gatekeeper) {
          await commandContext.reply('GatekeeperService tidak aktif.')
          return
        }

        const [subcommand = 'list', target, ...reasonParts] = commandContext.args.map((a) => a.trim()).filter(Boolean)

        if (subcommand === 'list') {
          const list = gatekeeper.listShadowbans()
          if (list.length === 0) {
            await commandContext.reply('*DEV // SHADOWBANNED TARGETS*\n\nTidak ada user yang terkena shadowban saat ini.')
            return
          }
          const lines = [
            `*DEV // SHADOWBANNED TARGETS (${list.length} target)*`,
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            ...list.map((s, idx) => `${idx + 1}. \`${s.targetJid}\`\n   • Alasan: ${s.reason}\n   • Sejak: ${new Date(s.bannedAt * 1000).toLocaleString('id-ID')}`),
            '━━━━━━━━━━━━━━━━━━━━',
            '_Pesan dari user di atas otomatis dibuang (silent ghost ignore)._',
          ]
          await commandContext.reply(lines.join('\n'))
          return
        }

        if (subcommand === 'add') {
          if (!target) {
            await commandContext.reply('Usage: `!shadowban add <phone-or-jid> [alasan]`')
            return
          }
          const reason = reasonParts.join(' ') || 'Malicious / Spam'
          gatekeeper.addShadowban(target, reason, commandContext.message.senderJid ?? 'owner')
          await commandContext.reply(`Target \`${target}\` berhasil di-*shadowban*. Seluruh pesannya akan di-drop secara silent.`)
          return
        }

        if (subcommand === 'remove') {
          if (!target) {
            await commandContext.reply('Usage: `!shadowban remove <phone-or-jid>`')
            return
          }
          const removed = gatekeeper.removeShadowban(target)
          await commandContext.reply(removed ? `Target \`${target}\` dibebaskan dari shadowban.` : `Target \`${target}\` tidak ditemukan di list shadowban.`)
          return
        }

        await commandContext.reply('Usage: `!shadowban <list|add|remove> [target] [alasan]`')
      },
    })

    // 6. !silence <groupJid> <on|off>
    context.commands.register({
      name: 'silence',
      description: 'Mute/unmute respons bot di grup resmi tertentu tanpa perlu kick bot (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const gatekeeper = context.services.get<GatekeeperService>('gatekeeper')
        if (!gatekeeper) {
          await commandContext.reply('GatekeeperService tidak aktif.')
          return
        }

        const [arg1, arg2] = commandContext.args.map((a) => a.trim()).filter(Boolean)
        let targetJid = ''
        let mode = ''

        if (arg1 === 'on' || arg1 === 'off') {
          mode = arg1
          targetJid = commandContext.message.remoteJid
        } else {
          targetJid = arg1 || commandContext.message.remoteJid
          mode = arg2 || 'on'
        }

        if (!targetJid || !targetJid.endsWith('@g.us')) {
          await commandContext.reply('Usage: `!silence [group-jid@g.us] <on|off>`')
          return
        }

        const enableSilence = mode === 'on'
        gatekeeper.silenceGroup(targetJid, enableSilence)
        await commandContext.reply(enableSilence
          ? `Bot sekarang *SILENCED* di grup \`${targetJid}\`. Pesan member diabaikan.`
          : `Bot sekarang *UNSILENCED* di grup \`${targetJid}\`. Respons normal dipulihkan.`)
      },
    })

    // 7. !inspect <start|stop|list>
    context.commands.register({
      name: 'inspect',
      description: 'Remote live wiretap inspeksi grup tertentu ke DM Owner untuk audit & debug (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const remoteOps = context.services.get<RemoteOpsService>('remote-ops')
        if (!remoteOps) {
          await commandContext.reply('RemoteOpsService tidak aktif.')
          return
        }

        const [subcommand = 'list', targetJid, filterArg = 'all', durationArg = '60'] = commandContext.args.map((a) => a.trim()).filter(Boolean)

        if (subcommand === 'list') {
          const sessions = remoteOps.listActiveInspectSessions()
          if (sessions.length === 0) {
            await commandContext.reply('*DEV // ACTIVE WIRETAP SESSIONS*\n\nTidak ada sesi inspeksi aktif saat ini.')
            return
          }
          const lines = [
            `*DEV // ACTIVE WIRETAP SESSIONS (${sessions.length})*`,
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            ...sessions.map((s, idx) => {
              const remainingMin = Math.max(0, Math.round((s.expiresAt - Math.floor(Date.now() / 1000)) / 60))
              return `${idx + 1}. *${s.groupName}* (\`${s.groupJid}\`)\n   • Filter: \`${s.filterMode}\` | Sisa: ${remainingMin} menit | Forwarded: ${s.forwardedCount} pesan`
            }),
            '━━━━━━━━━━━━━━━━━━━━',
            '_Gunakan `!inspect stop <group-jid>` untuk menghentikan sesi._',
          ]
          await commandContext.reply(lines.join('\n'))
          return
        }

        if (subcommand === 'start') {
          const jid = targetJid || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
          if (!jid || !jid.endsWith('@g.us')) {
            await commandContext.reply('Usage: `!inspect start <group-jid@g.us> [all|cmd|mention] [minutes]`')
            return
          }
          const filterMode = (filterArg === 'cmd' || filterArg === 'mention') ? filterArg : 'all'
          const minutes = Number(durationArg) || 60
          const ownerJid = commandContext.config.botOwnerJid || commandContext.message.senderJid || ''

          let groupName = jid
          try {
            const meta = await commandContext.whatsapp.getGroupMetadata(jid)
            if (meta?.subject) groupName = meta.subject
          } catch {}

          remoteOps.startInspect(jid, groupName, filterMode, ownerJid, minutes * 60)
          await commandContext.reply(`*DEV // WIRETAP INSPECT STARTED*\n\n• Target: *${groupName}* (\`${jid}\`)\n• Filter: \`${filterMode}\`\n• Durasi: ${minutes} menit\n• Forwarding ke DM: \`${ownerJid}\`\n\nSetiap aktivitas yang cocok akan diteruskan langsung ke DM Owner.`)
          return
        }

        if (subcommand === 'stop') {
          const jid = targetJid || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
          if (!jid) {
            await commandContext.reply('Usage: `!inspect stop <group-jid@g.us>`')
            return
          }
          const stopped = remoteOps.stopInspect(jid)
          await commandContext.reply(stopped ? `Wiretap inspect untuk \`${jid}\` telah dihentikan.` : `Tidak ada sesi inspect aktif untuk \`${jid}\`.`)
          return
        }

        await commandContext.reply('Usage: `!inspect <start|stop|list> [groupJid] [filter] [minutes]`')
      },
    })

    // 8. !sniffonce <groupJid>
    context.commands.register({
      name: 'sniffonce',
      description: 'Tangkap tepat 1 pesan berikutnya dari grup target lalu otomatis nonaktif (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const remoteOps = context.services.get<RemoteOpsService>('remote-ops')
        if (!remoteOps) {
          await commandContext.reply('RemoteOpsService tidak aktif.')
          return
        }

        const targetJid = commandContext.args[0]?.trim() || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
        if (!targetJid || !targetJid.endsWith('@g.us')) {
          await commandContext.reply('Usage: `!sniffonce <group-jid@g.us>`')
          return
        }

        const active = remoteOps.toggleSniffOnce(targetJid)
        await commandContext.reply(active
          ? `*Sniff-Once Diaktifkan* untuk \`${targetJid}\`.\nPesan berikutnya dari grup ini akan di-capture ke DM Owner dan fitur ini akan otomatis mati.`
          : `Sniff-Once dinonaktifkan untuk \`${targetJid}\`.`)
      },
    })

    // 9. !broadcast <message>
    context.commands.register({
      name: 'broadcast',
      aliases: ['bc'],
      description: 'Broadcast pesan ke seluruh grup resmi Allyssea dengan proteksi rate-limit (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const gatekeeper = context.services.get<GatekeeperService>('gatekeeper')
        const remoteOps = context.services.get<RemoteOpsService>('remote-ops')
        if (!gatekeeper || !remoteOps) {
          await commandContext.reply('Service gatekeeper / remote-ops tidak aktif.')
          return
        }

        const text = commandContext.args.join(' ').trim()
        if (!text) {
          await commandContext.reply('Usage: `!broadcast <isi pesan pengumuman>`')
          return
        }

        const groups = gatekeeper.listOfficialGroups()
        if (groups.length === 0) {
          await commandContext.reply('Tidak ada grup resmi yang terdaftar untuk menerima broadcast.')
          return
        }

        const targetJids = groups.map((g) => g.jid)
        await commandContext.reply(`Memulai broadcast ke *${targetJids.length}* grup komunitas resmi (throttled 2.5s jitter)...`)

        const broadcastPayload = [
          '*[PENGUMUMAN RESMI ALLYSSEA]*',
          '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
          text,
          '━━━━━━━━━━━━━━━━━━━━',
          '*© Allyssea Official Staff Broadcast*',
        ].join('\n')

        const result = await remoteOps.broadcastThrottled(commandContext.whatsapp, targetJids, broadcastPayload, 2500)
        await commandContext.reply(`*DEV // BROADCAST COMPLETED*\n\n• Total Target: ${result.total}\n• Terkirim: ${result.sent}\n• Gagal: ${result.failed}`)
      },
    })

    // 10. !syncmembers
    context.commands.register({
      name: 'syncmembers',
      description: 'Sinkronisasi daftar member resmi dari WhatsApp socket ke memory & DB (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const gatekeeper = context.services.get<GatekeeperService>('gatekeeper')
        if (!gatekeeper) {
          await commandContext.reply('GatekeeperService tidak aktif.')
          return
        }

        await commandContext.reply('Memulai sinkronisasi member dari seluruh grup komunitas resmi...')
        const count = await gatekeeper.syncGroupMembers(commandContext.whatsapp)
        await commandContext.reply(`*DEV // MEMBER CACHE SYNCED*\n\n• Total ${count} ID/Phone resmi berhasil di-index ke memory cache O(1) & database.`)
      },
    })

    // 11. !remoteleave <groupJid>
    context.commands.register({
      name: 'remoteleave',
      aliases: ['botexit', 'groupleave'],
      description: 'Keluarkan bot dari grup target secara remote via DM tanpa perlu hadir di grup (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const targetJid = commandContext.args[0]?.trim() || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
        if (!targetJid || !targetJid.endsWith('@g.us')) {
          await commandContext.reply('Usage: `!remoteleave <group-jid@g.us>`')
          return
        }
        try {
          if (!commandContext.whatsapp.groupLeave) {
            await commandContext.reply('Metode groupLeave belum didukung oleh WhatsApp adapter.')
            return
          }
          await commandContext.whatsapp.groupLeave(targetJid)
          await commandContext.reply(`Sukses keluar dari grup target: \`${targetJid}\`.`)
        } catch (error) {
          await commandContext.reply(`Gagal keluar dari grup \`${targetJid}\`: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })

    // 12. !grouppeek <groupJid> [limit]
    context.commands.register({
      name: 'grouppeek',
      description: 'Lihat beberapa pesan terakhir dari grup target dari database pesan (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const remoteOps = context.services.get<RemoteOpsService>('remote-ops')
        if (!remoteOps) {
          await commandContext.reply('RemoteOpsService tidak aktif.')
          return
        }
        const targetJid = commandContext.args[0]?.trim() || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
        if (!targetJid || !targetJid.endsWith('@g.us')) {
          await commandContext.reply('Usage: `!grouppeek <group-jid@g.us> [limit]`')
          return
        }
        const limit = Number(commandContext.args[1]) || 5
        const peeks = remoteOps.peekGroupMessages(targetJid, limit)
        if (peeks.length === 0) {
          await commandContext.reply(`*Group Peek: \`${targetJid}\`*\n\nBelum ada histori pesan yang tersimpan di buffer SQLite.`)
          return
        }
        const lines = [
          `*DEV // GROUP MESSAGE PEEK (${peeks.length} pesan)*`,
          `Target: \`${targetJid}\``,
          '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
          ...peeks.map((p, idx) => {
            const time = p.timestamp ? new Date(p.timestamp * 1000).toLocaleTimeString('id-ID') : 'N/A'
            return `${idx + 1}. [${time}] *${p.pushName || 'Anon'}* (\`${p.senderJid.split(':')[0]}\`):\n   ${p.text}`
          }),
          '━━━━━━━━━━━━━━━━━━━━',
        ]
        await commandContext.reply(lines.join('\n'))
      },
    })

    // 13. !groupdetail <groupJid>
    context.commands.register({
      name: 'groupdetail',
      description: 'Inspeksi metadata grup, admin, member count & link invite (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const targetJid = commandContext.args[0]?.trim() || (commandContext.message.remoteJid.endsWith('@g.us') ? commandContext.message.remoteJid : '')
        if (!targetJid || !targetJid.endsWith('@g.us')) {
          await commandContext.reply('Usage: `!groupdetail <group-jid@g.us>`')
          return
        }
        try {
          const meta = await commandContext.whatsapp.getGroupMetadata(targetJid)
          let inviteLink = 'Tidak tersedia / bukan admin'
          try {
            const link = await commandContext.whatsapp.getGroupInviteLink(targetJid)
            if (link) inviteLink = link
          } catch {}

          const participants = meta.participants || []
          const admins = participants.filter((p) => p.role === 'admin' || p.role === 'superadmin')

          const lines = [
            `*DEV // GROUP METADATA: ${meta.subject || 'Unnamed'}*`,
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ *JID*          : \`${targetJid}\``,
            `⡇╌ *Owner*        : \`${meta.ownerJid ? meta.ownerJid.split(':')[0] : 'N/A'}\``,
            `⡇╌ *Total Anggota*: ${participants.length} member`,
            `⡇╌ *Total Admin*  : ${admins.length} admin`,
            `⡇╌ *Link Invite*  : ${inviteLink}`,
            '────────────────────',
            `*Deskripsi Grup*:`,
            meta.description || '_Tidak ada deskripsi._',
            '━━━━━━━━━━━━━━━━━━━━',
          ]
          await commandContext.reply(lines.join('\n'))
        } catch (error) {
          await commandContext.reply(`Gagal mengambil metadata grup \`${targetJid}\`: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })

    // 14. !say <targetJid> <message>
    context.commands.register({
      name: 'say',
      description: 'Kirim pesan jarak jauh ke grup atau nomor target melalui bot (Owner only)',
      category: 'developer',
      hidden: true,
      scope: 'both',
      permission: permissionNames.botOwner,
      handler: async (commandContext: CommandContext) => {
        if (!isOwner(commandContext)) {
          await commandContext.reply('Maaf, command ini khusus untuk Bot Owner.')
          return
        }
        const targetJid = commandContext.args[0]?.trim()
        const text = commandContext.args.slice(1).join(' ').trim()
        if (!targetJid || !text) {
          await commandContext.reply('Usage: `!say <target-jid> <pesan yang akan dikirim>`')
          return
        }
        try {
          await commandContext.whatsapp.sendText(targetJid, text)
          await commandContext.reply(`Pesan berhasil dikirim ke \`${targetJid}\`.`)
        } catch (error) {
          await commandContext.reply(`Gagal mengirim pesan ke \`${targetJid}\`: ${error instanceof Error ? error.message : String(error)}`)
        }
      },
    })
  },
}

export function createRemoteOpsPlugin(_whatsapp?: unknown): Plugin {
  return remoteOpsPlugin
}

export default remoteOpsPlugin
