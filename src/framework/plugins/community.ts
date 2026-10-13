import type { CommandContext, Plugin, WhatsAppPort, CoreGroupParticipantUpdate, WhatsAppGroupMetadata } from '../contracts.js'
import { permissionNames } from '../../permissions.js'
import type { CommunityService } from '../../services/community-service.js'
import { isGroupJid } from '../validation.js'

function getCommunityService(context: CommandContext): CommunityService {
  return context.services.get<CommunityService>('community')
}

function resolveTargetJid(context: CommandContext): string | undefined {
  if (context.message.mentionedJids && context.message.mentionedJids.length > 0) {
    return context.message.mentionedJids[0]
  }
  if (context.message.quotedSenderJid) {
    return context.message.quotedSenderJid
  }
  if (context.args[0]) {
    const raw = context.args[0].trim()
    if (raw.endsWith('@s.whatsapp.net') || raw.endsWith('@lid')) {
      return raw
    }
    const digits = raw.replace(/[^0-9]/g, '')
    if (digits.length >= 7) {
      return `${digits}@s.whatsapp.net`
    }
  }
  return undefined
}

function isBotAdmin(metadata: WhatsAppGroupMetadata, botJid: string | undefined): boolean {
  if (!botJid) return false
  const bareBot = botJid.split(':')[0]
  const p = metadata.participants.find((part) => part.jid.split(':')[0] === bareBot)
  return p?.role === 'admin' || p?.role === 'superadmin'
}

function normalizePhone(jid: string): string {
  return jid.split('@')[0]?.replace(/[^0-9]/g, '') ?? jid
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createCommunityPlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'community-federation',
    version: '0.1.0',
    load(context) {
      const community = context.services.get<CommunityService>('community')

      // Auto-eject blacklisted members if they join an official group
      context.events.on('group.participants.changed', async (event: unknown) => {
        const update = event as CoreGroupParticipantUpdate
        if (update.action !== 'add') return
        if (!community.isOfficialGroup(update.groupJid)) return

        for (const participant of update.participantJids) {
          const bare = participant.split(':')[0]
          if (community.isBlacklisted(participant) || community.isBlacklisted(bare)) {
            context.logger.warn(
              { group: update.groupJid, participant },
              'auto-ejecting blacklisted member from official Allyssea community group',
            )
            try {
              if (whatsapp.groupParticipantsUpdate) {
                await whatsapp.groupParticipantsUpdate(update.groupJid, [participant], 'remove')
              }
              const phone = normalizePhone(participant)
              await whatsapp.sendText(
                update.groupJid,
                `🛡️ *Allyssea Community Blacklist*\n\nAkun @${phone} terdaftar di blacklist resmi dan langsung dikeluarkan otomatis dari grup jaringan Allyssea.`,
                { mentions: [participant] },
              )
            } catch (err) {
              context.logger.error({ err, participant }, 'failed auto-ejecting blacklisted participant')
            }
          }
        }
      })

      // 1. !addgroup [jid] [alias]
      context.commands.register({
        name: 'addgroup',
        aliases: ['caddgroup'],
        description: 'Daftarkan grup ke jaringan resmi Allyssea (Owner only)',
        category: 'developer',
        hidden: true,
        permission: permissionNames.botOwner,
        handler: async (commandContext) => {
          const commService = getCommunityService(commandContext)
          let targetJid: string | undefined
          let groupName: string | undefined

          if (commandContext.args[0] && isGroupJid(commandContext.args[0])) {
            targetJid = commandContext.args[0]
            groupName = commandContext.args.slice(1).join(' ').trim() || undefined
          } else if (isGroupJid(commandContext.message.remoteJid)) {
            targetJid = commandContext.message.remoteJid
            groupName = commandContext.args.join(' ').trim() || undefined
          }

          if (!targetJid) {
            await commandContext.reply('Format salah! Gunakan `!addgroup` di dalam grup, atau `!addgroup <jid_grup> [alias]` dari private chat.')
            return
          }

          if (!groupName) {
            try {
              const meta = await commandContext.whatsapp.getGroupMetadata(targetJid)
              groupName = meta.subject
            } catch {
              groupName = 'Grup Resmi Allyssea'
            }
          }

          commService.registerGroup(targetJid, groupName, commandContext.message.senderJid ?? 'owner')
          await commandContext.reply([
            '🏛️ *Grup Resmi Allyssea Ditambahkan*',
            '',
            `↳ Nama : ${groupName}`,
            `↳ JID  : \`${targetJid}\``,
            '↳ Status: Terintegrasi ke Federated Network Allyssea ✅',
          ].join('\n'))
        },
      })

      // 2. !delgroup <jid>
      context.commands.register({
        name: 'delgroup',
        aliases: ['cdelgroup'],
        description: 'Hapus grup dari jaringan resmi Allyssea (Owner only)',
        category: 'developer',
        hidden: true,
        permission: permissionNames.botOwner,
        handler: async (commandContext) => {
          const commService = getCommunityService(commandContext)
          let targetJid: string | undefined

          if (commandContext.args[0] && isGroupJid(commandContext.args[0])) {
            targetJid = commandContext.args[0]
          } else if (isGroupJid(commandContext.message.remoteJid)) {
            targetJid = commandContext.message.remoteJid
          }

          if (!targetJid) {
            await commandContext.reply('Format: `!delgroup <jid_grup>` atau jalankan langsung di dalam grup target.')
            return
          }

          const removed = commService.removeGroup(targetJid)
          if (removed) {
            await commandContext.reply(`🗑️ Grup \`${targetJid}\` telah dihapus dari jaringan resmi Allyssea.`)
          } else {
            await commandContext.reply(`⚠️ Grup \`${targetJid}\` tidak ditemukan dalam daftar grup resmi.`)
          }
        },
      })

      // 3. !clist / !grouplist
      context.commands.register({
        name: 'clist',
        aliases: ['grouplist', 'cgroups'],
        description: 'Lihat daftar seluruh grup resmi Allyssea (Owner only)',
        category: 'developer',
        hidden: true,
        permission: permissionNames.botOwner,
        handler: async (commandContext) => {
          const commService = getCommunityService(commandContext)
          const groups = commService.listGroups()

          if (groups.length === 0) {
            await commandContext.reply('Belum ada grup yang didaftarkan ke jaringan resmi Allyssea. Gunakan `!addgroup`.')
            return
          }

          const lines: string[] = []
          for (let i = 0; i < groups.length; i++) {
            const g = groups[i]
            let memberCount = '?'
            let botRole = 'Unknown'

            try {
              const meta = await commandContext.whatsapp.getGroupMetadata(g.jid)
              memberCount = `${meta.participants.length}`
              botRole = isBotAdmin(meta, commandContext.whatsapp.userJid) ? 'Admin 👑' : 'Member 👤'
            } catch {
              botRole = 'Unreachable ⚠️'
            }

            lines.push(
              `${i + 1}. *${g.name}*\n` +
              `   ↳ JID   : \`${g.jid}\`\n` +
              `   ↳ Bot   : ${botRole} | Member: ${memberCount}`,
            )
          }

          await commandContext.reply([
            '🏛️ *Daftar Jaringan Komunitas Resmi Allyssea*',
            '',
            `Total terdaftar: ${groups.length} grup`,
            '',
            lines.join('\n\n'),
          ].join('\n'))
        },
      })

      // 4. !ckick <target> [alasan]
      context.commands.register({
        name: 'ckick',
        description: 'Tendang user dari seluruh grup resmi Allyssea serentak (Owner only)',
        category: 'developer',
        hidden: true,
        permission: permissionNames.botOwner,
        handler: async (commandContext) => {
          const commService = getCommunityService(commandContext)
          const target = resolveTargetJid(commandContext)
          if (!target) {
            await commandContext.reply(`Format: ${commandContext.prefix}ckick @user [alasan]`)
            return
          }

          const bareTarget = target.split(':')[0]
          const ownerBare = commandContext.config.botOwnerJid?.split(':')[0]
          const botBare = commandContext.whatsapp.userJid?.split(':')[0]

          if (bareTarget === ownerBare || bareTarget === botBare) {
            await commandContext.reply('❌ Tindakan dilarang: Target adalah Owner atau Bot sendiri.')
            return
          }

          const groups = commService.listGroups()
          if (groups.length === 0) {
            await commandContext.reply('Belum ada grup resmi yang terdaftar. Daftarkan dulu dengan `!addgroup`.')
            return
          }

          let successCount = 0
          let skippedCount = 0
          const failures: string[] = []

          for (const g of groups) {
            try {
              const meta = await commandContext.whatsapp.getGroupMetadata(g.jid)
              const hasTarget = meta.participants.some((p) => p.jid.split(':')[0] === bareTarget)
              if (!hasTarget) {
                skippedCount++
                continue
              }

              if (!isBotAdmin(meta, commandContext.whatsapp.userJid)) {
                failures.push(`${g.name} (Bot bukan admin)`)
                continue
              }

              if (commandContext.whatsapp.groupParticipantsUpdate) {
                await commandContext.whatsapp.groupParticipantsUpdate(g.jid, [target], 'remove')
                successCount++
                await sleep(80) // Rate pacing
              }
            } catch (err) {
              failures.push(`${g.name} (Error: ${err instanceof Error ? err.message : 'failed'})`)
            }
          }

          const response = [
            '⚡ *Federated Community Kick Selesai*',
            '',
            `↳ Target  : @${normalizePhone(target)}`,
            `↳ Berhasil: ${successCount} grup`,
            `↳ Dilewati: ${skippedCount} grup (target tidak ada di grup)`,
          ]

          if (failures.length > 0) {
            response.push('', '⚠️ *Gagal di:*', ...failures.map((f) => `↳ ${f}`))
          }

          await commandContext.reply(response.join('\n'), { mentions: [target] })
        },
      })

      // 5. !cban <target> [alasan]
      context.commands.register({
        name: 'cban',
        description: 'Blacklist dan kick user dari seluruh grup resmi Allyssea (Owner only)',
        category: 'developer',
        hidden: true,
        permission: permissionNames.botOwner,
        handler: async (commandContext) => {
          const commService = getCommunityService(commandContext)
          const target = resolveTargetJid(commandContext)
          if (!target) {
            await commandContext.reply(`Format: ${commandContext.prefix}cban @user [alasan]`)
            return
          }

          const bareTarget = target.split(':')[0]
          const ownerBare = commandContext.config.botOwnerJid?.split(':')[0]
          const botBare = commandContext.whatsapp.userJid?.split(':')[0]

          if (bareTarget === ownerBare || bareTarget === botBare) {
            await commandContext.reply('❌ Tindakan dilarang: Target adalah Owner atau Bot sendiri.')
            return
          }

          // Ambil alasan (selain mention/target di arg 0)
          const reasonParts = commandContext.args.slice(1).filter((a) => !a.startsWith('@'))
          const reason = reasonParts.join(' ').trim() || 'Pelanggaran aturan komunitas Allyssea'

          // Catat ke blacklist
          commService.banUser(target, reason, commandContext.message.senderJid ?? 'owner')

          const groups = commService.listGroups()
          let successCount = 0
          let skippedCount = 0
          const failures: string[] = []

          for (const g of groups) {
            try {
              const meta = await commandContext.whatsapp.getGroupMetadata(g.jid)
              const hasTarget = meta.participants.some((p) => p.jid.split(':')[0] === bareTarget)
              if (!hasTarget) {
                skippedCount++
                continue
              }

              if (!isBotAdmin(meta, commandContext.whatsapp.userJid)) {
                failures.push(`${g.name} (Bot bukan admin)`)
                continue
              }

              if (commandContext.whatsapp.groupParticipantsUpdate) {
                await commandContext.whatsapp.groupParticipantsUpdate(g.jid, [target], 'remove')
                successCount++
                await sleep(80)
              }
            } catch (err) {
              failures.push(`${g.name} (Error: ${err instanceof Error ? err.message : 'failed'})`)
            }
          }

          const response = [
            '🚫 *Federated Community Ban & Blacklist Aktif*',
            '',
            `↳ Target  : @${normalizePhone(target)}`,
            `↳ Alasan  : ${reason}`,
            `↳ Berhasil: Kick di ${successCount} grup`,
            `↳ Dilewati: ${skippedCount} grup`,
            '↳ Status  : Terdaftar di Blacklist Jaringan (Auto-kick aktif jika join ulang) 🛡️',
          ]

          if (failures.length > 0) {
            response.push('', '⚠️ *Gagal kick di:*', ...failures.map((f) => `↳ ${f}`))
          }

          await commandContext.reply(response.join('\n'), { mentions: [target] })
        },
      })

      // 6. !cunban <target>
      context.commands.register({
        name: 'cunban',
        description: 'Cabut blacklist user dari jaringan resmi Allyssea (Owner only)',
        category: 'developer',
        hidden: true,
        permission: permissionNames.botOwner,
        handler: async (commandContext) => {
          const commService = getCommunityService(commandContext)
          const target = resolveTargetJid(commandContext)
          if (!target) {
            await commandContext.reply(`Format: ${commandContext.prefix}cunban @user`)
            return
          }

          const unbanned = commService.unbanUser(target)
          if (unbanned) {
            await commandContext.reply(`✅ Blacklist komunitas untuk @${normalizePhone(target)} telah dicabut.`, {
              mentions: [target],
            })
          } else {
            await commandContext.reply(`User @${normalizePhone(target)} tidak terdaftar dalam blacklist komunitas.`, {
              mentions: [target],
            })
          }
        },
      })

      // 7. !cblacklist
      context.commands.register({
        name: 'cblacklist',
        aliases: ['blacklistlist'],
        description: 'Lihat daftar user yang ter-blacklist di komunitas Allyssea (Owner only)',
        category: 'developer',
        hidden: true,
        permission: permissionNames.botOwner,
        handler: async (commandContext) => {
          const commService = getCommunityService(commandContext)
          const list = commService.listBlacklist()

          if (list.length === 0) {
            await commandContext.reply('Tidak ada user yang sedang di-blacklist di jaringan Allyssea.')
            return
          }

          const lines = list.map((b, idx) => {
            const date = new Date(b.bannedAt).toLocaleDateString('id-ID')
            return `${idx + 1}. @${normalizePhone(b.jid)}\n   ↳ Alasan: ${b.reason} (${date})`
          })

          await commandContext.reply([
            '📋 *Daftar Blacklist Komunitas Allyssea*',
            '',
            `Total: ${list.length} akun terdaftar`,
            '',
            lines.join('\n\n'),
          ].join('\n'), { mentions: list.map((b) => b.jid) })
        },
      })
    },
  }
}

export default createCommunityPlugin
