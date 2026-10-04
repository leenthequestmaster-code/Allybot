import type { CommandContext, CommandDefinition, Plugin } from '../contracts.js'
import { commandDescription } from '../command-copy.js'
import { registerUtilityFunCommands } from './utility-fun.js'
import type { QuotaService } from '../../services/quota-service.js'

const MAX_QUERY_LENGTH = 80
const MAX_REPLY_LENGTH = 3_500
const MAX_SEARCH_RESULTS = 12
const MAX_COMMAND_LIST = 60
const UTILITY_COOLDOWN_MS = 1_000

type UnitDefinition = {
  readonly group: 'length' | 'mass' | 'temperature' | 'time'
  readonly factor?: number
  readonly offset?: number
}

const UNITS: Record<string, UnitDefinition> = {
  mm: { group: 'length', factor: 0.001 },
  cm: { group: 'length', factor: 0.01 },
  m: { group: 'length', factor: 1 },
  km: { group: 'length', factor: 1_000 },
  mg: { group: 'mass', factor: 0.001 },
  g: { group: 'mass', factor: 1 },
  kg: { group: 'mass', factor: 1_000 },
  ms: { group: 'time', factor: 0.001 },
  s: { group: 'time', factor: 1 },
  sec: { group: 'time', factor: 1 },
  menit: { group: 'time', factor: 60 },
  mnt: { group: 'time', factor: 60 },
  jam: { group: 'time', factor: 3_600 },
  hari: { group: 'time', factor: 86_400 },
  c: { group: 'temperature', offset: 0 },
  f: { group: 'temperature', offset: 0 },
  k: { group: 'temperature', offset: 0 },
}

function usage(context: CommandContext, command: string, example: string): string {
  return `Format: ${context.prefix}${command} ${example}`
}

function boundText(value: string, max = MAX_QUERY_LENGTH): string | undefined {
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

function safeReply(text: string): string {
  return text.length <= MAX_REPLY_LENGTH ? text : `${text.slice(0, MAX_REPLY_LENGTH - 1)}…`
}

function formatUptime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds))
  const days = Math.floor(totalSeconds / 86_400)
  const hours = Math.floor((totalSeconds % 86_400) / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const remainingSeconds = totalSeconds % 60
  const parts: string[] = []
  if (days) parts.push(`${days} hari`)
  if (hours || days) parts.push(`${hours} jam`)
  if (minutes || hours || days) parts.push(`${minutes} menit`)
  parts.push(`${remainingSeconds} detik`)
  return parts.join(' ')
}

function connectionStatus(context: CommandContext): string {
  return context.whatsapp.currentStatus ?? (context.whatsapp.isConnected ? 'connected' : 'idle')
}


function visibleCommands(commands: readonly CommandDefinition[]): CommandDefinition[] {
  return [...commands]
    .filter((command) => !command.hidden && command.name !== 'menu-reply')
    .sort((left, right) => (
      (left.category ?? '').localeCompare(right.category ?? '')
      || left.name.localeCompare(right.name)
    ))
}

function commandLine(command: CommandDefinition, prefix: string): string {
  const aliases = command.aliases?.length
    ? ` (${command.aliases.map((alias) => `${prefix}${alias}`).join(', ')})`
    : ''
  const access = command.permission ? ' · admin/khusus' : ''
  return `• ${prefix}${command.name}${aliases}${access} — ${commandDescription(command)}`
}

function renderCommandList(commands: readonly CommandDefinition[], prefix: string, category?: string): string {
  const normalizedCategory = category?.trim().toLowerCase()
  const filtered = normalizedCategory
    ? commands.filter((command) => (command.category ?? 'personal').toLowerCase() === normalizedCategory)
    : commands
  const shown = filtered.slice(0, MAX_COMMAND_LIST)
  const lines = [
    '📚 *Command Allybot yang tersedia*',
    normalizedCategory ? `Kategori internal: ${normalizedCategory}` : 'Gunakan command langsung atau cari berdasarkan kata kunci.',
    '',
    ...(shown.length > 0 ? shown.map((command) => commandLine(command, prefix)) : ['Belum ada command pada kategori tersebut.']),
  ]
  if (filtered.length > shown.length) lines.push('', `Masih ada ${filtered.length - shown.length} command lain. Gunakan ${prefix}searchcmd <kata>.`)
  lines.push('', `Contoh: ${prefix}searchcmd event`)
  return safeReply(lines.join('\n'))
}

function searchCommands(commands: readonly CommandDefinition[], query: string, prefix: string): string {
  const needle = query.toLowerCase()
  const matches = visibleCommands(commands).filter((command) => {
    const haystack = [command.name, ...(command.aliases ?? []), commandDescription(command), command.category ?? '']
      .join(' ')
      .toLowerCase()
    return haystack.includes(needle)
  }).slice(0, MAX_SEARCH_RESULTS)
  if (matches.length === 0) return `Tidak ada command yang cocok dengan “${query}”. Coba kata yang lebih umum.`
  return safeReply([
    `🔎 *Hasil pencarian: ${query}*`,
    '',
    ...matches.map((command) => commandLine(command, prefix)),
    '',
    'Ketik command yang ingin dipakai sesuai contoh pada deskripsinya.',
  ].join('\n'))
}

function parseNumber(value: string): number | undefined {
  const normalized = value.replace(',', '.')
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(normalized)) return undefined
  const number = Number(normalized)
  return Number.isFinite(number) ? number : undefined
}

function parseExpression(input: string): number | undefined {
  if (input.length === 0 || input.length > 100) return undefined
  const tokens = input.match(/\d+(?:\.\d+)?|[()+\-*/%]/g)
  if (!tokens || tokens.join('') !== input.replaceAll(/\s+/g, '')) return undefined
  let index = 0

  const peek = () => tokens[index]
  const consume = () => tokens[index++]

  function expression(): number | undefined {
    let value = term()
    while (value !== undefined && (peek() === '+' || peek() === '-')) {
      const operator = consume()
      const right = term()
      if (right === undefined) return undefined
      value = operator === '+' ? value + right : value - right
    }
    return value
  }

  function term(): number | undefined {
    let value = factor()
    while (value !== undefined && (peek() === '*' || peek() === '/' || peek() === '%')) {
      const operator = consume()
      const right = factor()
      if (right === undefined || ((operator === '/' || operator === '%') && right === 0)) return undefined
      if (operator === '*') value *= right
      else if (operator === '/') value /= right
      else value %= right
    }
    return value
  }

  function factor(): number | undefined {
    if (peek() === '+' || peek() === '-') {
      const operator = consume()
      const value = factor()
      return value === undefined ? undefined : operator === '-' ? -value : value
    }
    if (peek() === '(') {
      consume()
      const value = expression()
      if (consume() !== ')') return undefined
      return value
    }
    const token = consume()
    return token ? Number(token) : undefined
  }

  const result = expression()
  if (index !== tokens.length || result === undefined || !Number.isFinite(result) || Math.abs(result) > 1e12) return undefined
  return result
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('id-ID', { maximumFractionDigits: 6 }).format(value)
}

function convertTemperature(value: number, from: string, to: string): number {
  const celsius = from === 'c' ? value : from === 'f' ? (value - 32) * 5 / 9 : value - 273.15
  return to === 'c' ? celsius : to === 'f' ? celsius * 9 / 5 + 32 : celsius + 273.15
}

function convertUnit(value: number, from: string, to: string): number | undefined {
  const source = UNITS[from]
  const target = UNITS[to]
  if (!source || !target || source.group !== target.group) return undefined
  if (source.group === 'temperature') return convertTemperature(value, from, to)
  const result = value * (source.factor ?? 1) / (target.factor ?? 1)
  return Number.isFinite(result) && Math.abs(result) <= 1e15 ? result : undefined
}

function renderAbout(): string {
  return [
    '🤖 *Tentang Allybot*',
    '',
    'Allybot adalah bot komunitas untuk membantu pengelolaan grup, kolaborasi, roleplay sosial, pengetahuan eksplisit, dan utility ringan.',
    'Command tetap menjadi cara utama memakai fitur. Menu dan tombol hanya membantu menemukan jalurnya.',
    '',
    'Gunakan `!menu` untuk melihat kategori dan `!commands` untuk melihat command yang aktif.',
  ].join('\n')
}


function renderSupport(context: CommandContext): string {
  return [
    '🆘 *Bantuan Allybot*',
    '',
    `Gunakan ${context.prefix}menu untuk melihat kategori.`,
    `Gunakan ${context.prefix}searchcmd <kata> jika lupa nama command.`,
    `Untuk memberi saran, gunakan ${context.prefix}suggest <isi> jika fitur suggestion sedang aktif.`,
    'Jika command gagal, kirim ulang dengan format yang ditampilkan dan jangan sertakan credential.',
  ].join('\n')
}

export const utilityPlugin: Plugin = {
  name: 'utility',
  version: '0.1.0',
  load(context) {
    const commands = () => visibleCommands(context.commands.list())

    context.commands.register({
      name: 'commands',
      aliases: ['cmds'],
      description: 'Lihat daftar command yang aktif',
      category: 'tools',
      hidden: true,
      menuOrder: 10,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => {
        const category = commandContext.args[0]
        if (category && !/^[a-z][a-z0-9_-]{0,31}$/i.test(category)) {
          await commandContext.reply('Nama kategori tidak valid. Contoh: `!commands tools`.')
          return
        }
        await commandContext.reply(renderCommandList(commands(), commandContext.prefix, category))
      },
    })

    context.commands.register({
      name: 'searchcmd',
      description: 'Cari command berdasarkan kata kunci',
      category: 'tools',
      hidden: true,
      menuOrder: 11,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => {
        const query = boundText(commandContext.args.join(' '), 40)
        if (!query || query.length < 2) {
          await commandContext.reply(usage(commandContext, 'searchcmd', '<kata>'))
          return
        }
        await commandContext.reply(searchCommands(commands(), query, commandContext.prefix))
      },
    })

    context.commands.register({
      name: 'about',
      description: 'Lihat penjelasan singkat tentang Allybot',
      category: 'tools',
      hidden: true,
      menuOrder: 12,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => commandContext.reply(renderAbout()),
    })

    context.commands.register({
      name: 'version',
      description: 'Lihat informasi runtime non-sensitif',
      category: 'tools',
      hidden: true,
      menuOrder: 13,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => commandContext.reply(`Allybot berjalan pada Node.js ${process.versions.node}. Gunakan ${commandContext.prefix}about untuk ringkasan fitur.`),
    })


    context.commands.register({
      name: 'support',
      description: 'Lihat langkah bantuan saat command bermasalah',
      category: 'tools',
      hidden: true,
      menuOrder: 15,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => commandContext.reply(renderSupport(commandContext)),
    })

    context.commands.register({
      name: 'time',
      description: 'Lihat waktu pada zona tertentu',
      category: 'tools',
      hidden: true,
      menuOrder: 22,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => {
        const timezone = commandContext.args.join(' ').trim() || 'Asia/Jakarta'
        if (timezone.length > 64) {
          await commandContext.reply('Nama zona waktu terlalu panjang. Contoh: `!time Asia/Jakarta`.')
          return
        }
        try {
          const formatted = new Intl.DateTimeFormat('id-ID', {
            dateStyle: 'full',
            timeStyle: 'medium',
            timeZone: timezone,
          }).format(new Date())
          await commandContext.reply([
            '𓏼 *`𝐖𝗼𝗿𝗹𝗱 𝐓𝗶𝗺𝗲`*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
            `⡇╌ *Zona*  : ${timezone}`,
            `⡇╌ *Waktu* : ${formatted}`,
            '━━━━━━━━━━━━━━━━━━━━',
            '*© Allyssea Roleplay Community*',
          ].join('\n'))
        } catch {
          await commandContext.reply('Zona waktu tidak dikenali. Contoh: `!time Asia/Jakarta`.')
        }
      },
    })

    context.commands.register({
      name: 'date',
      description: 'Lihat tanggal hari ini',
      category: 'tools',
      hidden: true,
      menuOrder: 23,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => {
        const formatted = new Intl.DateTimeFormat('id-ID', { dateStyle: 'full', timeZone: 'Asia/Jakarta' }).format(new Date())
        await commandContext.reply([
          '𓏼 *`𝐂𝐚𝐥𝗲𝗻𝗱𝐚𝐫 𝐃𝗮𝘁𝗲`*',
          '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
          `⡇╌ *Hari ini* : ${formatted}`,
          '━━━━━━━━━━━━━━━━━━━━',
          '*© Allyssea Roleplay Community*',
        ].join('\n'))
      },
    })

    context.commands.register({
      name: 'donasi',
      aliases: ['donate', 'donatur'],
      description: 'Dukung operasional Allybot & unlock fitur eksklusif seumur hidup',
      category: 'tools',
      menuOrder: 5,
      cooldownMs: UTILITY_COOLDOWN_MS,
      scope: 'both',
      handler: async (commandContext) => {
        const quotaService = commandContext.services.has('quota')
          ? commandContext.services.get<QuotaService>('quota')
          : undefined
        const sender = commandContext.message.senderJid ?? commandContext.message.remoteJid
        const isDonator = quotaService?.isDonator(sender) ?? false
        const tier = quotaService?.getTier(sender) ?? 'free'

        const statusText = tier === 'owner'
          ? '👑 *Status:* Owner (Akses Penuh Tanpa Batas)'
          : isDonator
            ? '🌟 *Status:* Donator Seumur Hidup (Aktif)'
            : '⚪ *Status:* Member Regular'

        await commandContext.reply([
          '𓏼 *`𝐃𝗼𝗻𝐚𝐬𝗶 𝐀𝗹𝗹𝘆𝐬𝐬𝗲𝐚`*',
          '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
          statusText,
          '',
          'Dukung server VPS Allybot agar tetap aktif 24/7 bebas gangguan.',
          '⡇╌ *Donasi*    : Seikhlasnya',
          '⡇╌ *Masa Aktif*: Seumur Hidup (Lifetime)',
          '',
          '🎁 *Keuntungan Donator:*',
          '• Akses fitur aktivator Alight Motion (`!am`)',
          '• Limit harian download & play 50x / hari (Regular: 5x)',
          '• Prioritas proses antrean downloader',
          '',
          '💳 *Cara Donasi:*',
          '1. Transfer seikhlasnya via E-Wallet (Dana/GoPay/OVO/BCA).',
          '2. Kontak Owner untuk tujuan transfer: wa.me/6283197859955',
          '3. Kirim bukti transfer via `!report` atau DM Owner.',
          '━━━━━━━━━━━━━━━━━━━━',
          '*© Allyssea Roleplay Community*',
        ].join('\n'))
      },
    })

    context.commands.register({
      name: 'setdonasi',
      aliases: ['adddonatur'],
      description: 'Atur status Donator Seumur Hidup untuk pengguna',
      category: 'tools',
      hidden: true,
      permission: 'bot.owner',
      cooldownMs: 0,
      scope: 'both',
      handler: async (commandContext) => {
        const quotaService = commandContext.services.has('quota')
          ? commandContext.services.get<QuotaService>('quota')
          : undefined
        if (!quotaService) {
          await commandContext.reply('Layanan quota tidak aktif.')
          return
        }

        const targetArg = commandContext.args[0]
        const stateArg = (commandContext.args[1] ?? 'on').toLowerCase()
        const enabled = stateArg === 'on' || stateArg === '1' || stateArg === 'true'

        const mention = commandContext.message.mentionedJids?.[0]
        const rawTarget = mention ?? targetArg
        if (!rawTarget) {
          await commandContext.reply(`Format: ${commandContext.prefix}setdonasi <@user|nomor> <on|off> [catatan]`)
          return
        }

        const cleanPhone = rawTarget.replace(/[^0-9]/g, '')
        if (!cleanPhone || cleanPhone.length < 5) {
          await commandContext.reply('Nomor atau target pengguna tidak valid.')
          return
        }
        const targetJid = `${cleanPhone}@s.whatsapp.net`
        const note = commandContext.args.slice(2).join(' ') || undefined

        quotaService.setDonator(targetJid, enabled, note)
        const actionLabel = enabled ? 'diaktifkan' : 'dinonaktifkan'
        await commandContext.reply(`✅ Status Donator Seumur Hidup untuk @${cleanPhone} berhasil ${actionLabel}.`, {
          mentions: [targetJid],
        })
      },
    })

    registerUtilityFunCommands(context)
  },
}

export default utilityPlugin
