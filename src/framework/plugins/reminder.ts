/**
 * @module plugins/reminder
 * WhatsApp Reminder Plugin for Allybot using Natural Language Date Parser and SQLite.
 */

import type { CommandContext, Plugin, PluginContext } from '../contracts.js'
import type { ReminderService } from '../../services/reminder-service.js'
import { parseNaturalTimeIndonesian, formatWibDateTime } from '../../services/natural-time.js'

export const reminderPlugin: Plugin = {
  name: 'reminder',

  load(context: PluginContext) {
    context.commands.register({
      name: 'remind',
      aliases: ['ingatkan', 'ingetin', 'pengingat'],
      description: 'Atur pengingat dengan bahasa santai. Contoh: !remind besok jam 7 pagi sahur',
      category: 'tools',
      menuOrder: 25,
      cooldownMs: 2_000,

      handler: async (ctx: CommandContext) => {
        const reminderService = ctx.services.get<ReminderService>('reminder')
        if (!reminderService) {
          await ctx.reply('Layanan pengingat sementara tidak tersedia.')
          return
        }

        const input = ctx.args.join(' ').trim()
        if (!input || input.length < 3) {
          await ctx.reply(
            [
              '⏰ *Format Perintah Pengingat (!remind)*',
              '',
              'Ketik waktu dan pesan yang ingin diingatkan dalam bahasa santai.',
              'Contoh:',
              '• `!remind 30 menit lagi angkat jemuran`',
              '• `!remind besok jam 7 pagi bangunin sahur ya`',
              '• `!remind lusa jam 2 siang rapat kerja`',
              '• `!remind hari jumat jam 8 malam mabar catur`',
              '',
              'Perintah lain: `!remindlist` (daftar aktif) | `!reminddel <id>` (batalkan)',
            ].join('\n'),
          )
          return
        }

        const userJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const targetJid = ctx.message.remoteJid
        const now = new Date()

        const parsed = parseNaturalTimeIndonesian(input, now)
        if (!parsed.date || !parsed.isFuture) {
          await ctx.reply(
            'Gagal menentukan waktu pengingat yang valid di masa depan. Pastikan menulis waktu dengan jelas (contoh: `!remind 30 menit lagi beli bensin` atau `!remind besok jam 8 pagi`).',
          )
          return
        }

        const note = parsed.remainingText || 'Pengingat tanpa catatan'
        const dueAt = parsed.date.getTime()

        const created = reminderService.createReminder(userJid, targetJid, note, dueAt)
        const formattedWib = formatWibDateTime(parsed.date)

        await ctx.reply(
          [
            '⏰ *Pengingat Berhasil Disimpan!*',
            '',
            `• Catatan : *${note}*`,
            `• Waktu   : *${formattedWib}*`,
            `• ID      : \`${created.id}\``,
            '',
            '_Allybot akan otomatis mengingatkanmu tepat pada waktu tersebut!_',
          ].join('\n'),
        )
      },
    })

    context.commands.register({
      name: 'remindlist',
      aliases: ['daftarpengingat', 'cekremind'],
      description: 'Lihat daftar pengingat aktif milikmu',
      category: 'tools',
      menuOrder: 26,
      cooldownMs: 2_000,

      handler: async (ctx: CommandContext) => {
        const reminderService = ctx.services.get<ReminderService>('reminder')
        if (!reminderService) {
          await ctx.reply('Layanan pengingat sementara tidak tersedia.')
          return
        }

        const userJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const list = reminderService.listPending(userJid)

        if (list.length === 0) {
          await ctx.reply('Kamu tidak memiliki pengingat aktif saat ini. Buat baru dengan `!remind <waktu> <pesan>`.')
          return
        }

        const lines = [
          '📋 *Daftar Pengingat Aktif Kamu*',
          '',
          ...list.map((item, idx) => {
            const timeStr = formatWibDateTime(new Date(item.dueAt))
            return `${idx + 1}. *${item.reminderText}*\n   ↳ Waktu: ${timeStr}\n   ↳ ID: \`${item.id}\``
          }),
          '',
          'Gunakan `!reminddel <id>` jika ingin membatalkan pengingat.',
        ]

        await ctx.reply(lines.join('\n'))
      },
    })

    context.commands.register({
      name: 'reminddel',
      aliases: ['hapuspengingat', 'cancelremind'],
      description: 'Batalkan pengingat berdasarkan ID. Contoh: !reminddel rem_12345678',
      category: 'tools',
      menuOrder: 27,
      cooldownMs: 1_000,

      handler: async (ctx: CommandContext) => {
        const reminderService = ctx.services.get<ReminderService>('reminder')
        if (!reminderService) {
          await ctx.reply('Layanan pengingat sementara tidak tersedia.')
          return
        }

        const id = ctx.args[0]?.trim()
        if (!id) {
          await ctx.reply('Kirim ID pengingat yang ingin dihapus. Contoh: `!reminddel rem_12345678`. Cek ID via `!remindlist`.')
          return
        }

        const userJid = ctx.message.senderJid ?? ctx.message.remoteJid
        const ok = reminderService.cancelReminder(id, userJid)

        if (ok) {
          await ctx.reply(`✅ Pengingat dengan ID \`${id}\` berhasil dibatalkan.`)
        } else {
          await ctx.reply(`❌ Pengingat dengan ID \`${id}\` tidak ditemukan atau sudah kedaluwarsa.`)
        }
      },
    })
  },
}
