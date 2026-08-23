import { randomInt } from 'node:crypto'
import type { CommandContext, CommandDefinition, Plugin } from '../contracts.js'

const MAX_QUERY_LENGTH = 80
const MAX_REPLY_LENGTH = 3_500
const MAX_SEARCH_RESULTS = 12
const MAX_COMMAND_LIST = 60
const UTILITY_COOLDOWN_MS = 1_000
const FUN_COOLDOWN_MS = 1_500

const EIGHT_BALL_ANSWERS = [
  'Bisa jadi.',
  'Kemungkinannya cukup besar.',
  'Belum tentu; coba lihat lagi situasinya.',
  'Untuk sekarang, jawabannya belum jelas.',
  'Tanda-tandanya mengarah ke iya.',
  'Sepertinya belum.',
  'Coba tanyakan lagi nanti.',
  'Jawabannya: iya.',
] as const

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
  return `• ${prefix}${command.name}${aliases}${access} — ${command.description ?? 'Tanpa deskripsi.'}`
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
    const haystack = [command.name, ...(command.aliases ?? []), command.description ?? '', command.category ?? '']
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

function renderPrivacy(): string {
  return [
    '🔐 *Privasi singkat*',
    '',
    'Allybot tidak menggunakan passive full-chat memory. Data hanya diproses ketika fitur yang relevan dipanggil atau ketika grup sudah mengaktifkan workflow yang memerlukannya.',
    'Chat-log Neon bersifat consent-aware dan dapat dimatikan per grup oleh admin atau Owner dengan `!chatlog off`.',
    'Jangan kirim password, token, QR, atau data pribadi yang tidak diperlukan ke bot.',
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

function parseRoll(input: string): { count: number; sides: number } | undefined {
  const match = /^(\d{1,2})d(\d{1,3})$/i.exec(input)
  if (!match) return undefined
  const count = Number(match[1])
  const sides = Number(match[2])
  if (count < 1 || count > 10 || sides < 2 || sides > 100) return undefined
  return { count, sides }
}

function randomChoice<T>(values: readonly T[]): T {
  return values[randomInt(values.length)]
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
      menuOrder: 12,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => commandContext.reply(renderAbout()),
    })

    context.commands.register({
      name: 'version',
      description: 'Lihat informasi runtime non-sensitif',
      category: 'tools',
      menuOrder: 13,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => commandContext.reply(`Allybot berjalan pada Node.js ${process.versions.node}. Gunakan ${commandContext.prefix}about untuk ringkasan fitur.`),
    })

    context.commands.register({
      name: 'privacy',
      description: 'Baca ringkasan cara Allybot menjaga data',
      category: 'tools',
      menuOrder: 14,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => commandContext.reply(renderPrivacy()),
    })

    context.commands.register({
      name: 'support',
      description: 'Lihat langkah bantuan saat command bermasalah',
      category: 'tools',
      menuOrder: 15,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => commandContext.reply(renderSupport(commandContext)),
    })

    context.commands.register({
      name: 'calc',
      description: 'Hitung operasi matematika sederhana',
      category: 'tools',
      menuOrder: 20,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => {
        const input = commandContext.args.join('').trim()
        const result = parseExpression(input)
        if (result === undefined) {
          await commandContext.reply(usage(commandContext, 'calc', '<angka dan operator>') + '\nContoh: `!calc (12 + 8) / 2`')
          return
        }
        await commandContext.reply(`🧮 Hasil: *${formatNumber(result)}*`)
      },
    })

    context.commands.register({
      name: 'convert',
      description: 'Konversi satuan dasar',
      category: 'tools',
      menuOrder: 21,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => {
        const [valueText, from, to] = commandContext.args.map((value) => value.toLowerCase())
        const value = valueText ? parseNumber(valueText) : undefined
        const result = value !== undefined && from && to ? convertUnit(value, from, to) : undefined
        if (result === undefined) {
          await commandContext.reply(usage(commandContext, 'convert', '<angka> <dari> <ke>') + '\nContoh: `!convert 10 km m`, `!convert 32 f c`')
          return
        }
        await commandContext.reply(`🔁 ${formatNumber(value as number)} ${from} = *${formatNumber(result)} ${to}*`)
      },
    })

    context.commands.register({
      name: 'time',
      description: 'Lihat waktu pada zona tertentu',
      category: 'tools',
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
          await commandContext.reply(`🕒 *${timezone}*\n${formatted}`)
        } catch {
          await commandContext.reply('Zona waktu tidak dikenali. Contoh: `!time Asia/Jakarta`.')
        }
      },
    })

    context.commands.register({
      name: 'date',
      description: 'Lihat tanggal hari ini',
      category: 'tools',
      menuOrder: 23,
      cooldownMs: UTILITY_COOLDOWN_MS,
      handler: async (commandContext) => {
        const formatted = new Intl.DateTimeFormat('id-ID', { dateStyle: 'full', timeZone: 'Asia/Jakarta' }).format(new Date())
        await commandContext.reply(`📅 Hari ini: ${formatted}`)
      },
    })

    context.commands.register({
      name: 'random',
      description: 'Pilih angka acak dalam rentang tertentu',
      category: 'fun',
      menuOrder: 10,
      cooldownMs: FUN_COOLDOWN_MS,
      handler: async (commandContext) => {
        const [minText, maxText] = commandContext.args
        const min = minText ? Number(minText) : undefined
        const max = maxText ? Number(maxText) : undefined
        if (min === undefined || max === undefined || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < -1_000_000 || max > 1_000_000 || min > max) {
          await commandContext.reply(usage(commandContext, 'random', '<min> <max>') + '\nContoh: `!random 1 100`')
          return
        }
        await commandContext.reply(`🎲 Angka acaknya: *${randomInt(min as number, (max as number) + 1)}*`)
      },
    })

    context.commands.register({
      name: 'choose',
      description: 'Memilih satu opsi secara acak',
      category: 'fun',
      menuOrder: 11,
      cooldownMs: FUN_COOLDOWN_MS,
      handler: async (commandContext) => {
        const options = commandContext.args.join(' ').split('|').map((value) => value.trim()).filter(Boolean)
        if (options.length < 2 || options.length > 20 || options.some((value) => value.length > 80)) {
          await commandContext.reply(usage(commandContext, 'choose', '<opsi 1> | <opsi 2>') + '\nContoh: `!choose teh | kopi`')
          return
        }
        await commandContext.reply(`🎯 Pilihanku: *${randomChoice(options)}*`)
      },
    })

    context.commands.register({
      name: 'flip',
      description: 'Lempar koin',
      category: 'fun',
      menuOrder: 12,
      cooldownMs: FUN_COOLDOWN_MS,
      handler: async (commandContext) => commandContext.reply(`🪙 Hasil lempar koin: *${randomChoice(['Kepala', 'Ekor'])}*`),
    })

    context.commands.register({
      name: 'roll',
      aliases: ['dice'],
      description: 'Lempar dadu, misalnya 2d6',
      category: 'fun',
      menuOrder: 13,
      cooldownMs: FUN_COOLDOWN_MS,
      handler: async (commandContext) => {
        const dice = parseRoll(commandContext.args[0] ?? '')
        if (!dice) {
          await commandContext.reply(usage(commandContext, 'roll', '<jumlah>d<sisi>') + '\nContoh: `!roll 2d6`')
          return
        }
        const results = Array.from({ length: dice.count }, () => randomInt(1, dice.sides + 1))
        await commandContext.reply(`🎲 ${dice.count}d${dice.sides}: ${results.join(', ')}\nTotal: *${results.reduce((sum, value) => sum + value, 0)}*`)
      },
    })

    context.commands.register({
      name: '8ball',
      description: 'Jawab pertanyaan dengan permainan delapan bola',
      category: 'fun',
      menuOrder: 14,
      cooldownMs: FUN_COOLDOWN_MS,
      handler: async (commandContext) => {
        const question = boundText(commandContext.args.join(' '), 120)
        if (!question) {
          await commandContext.reply(usage(commandContext, '8ball', '<pertanyaan>') + '\nContoh: `!8ball apakah hari ini cerah?`')
          return
        }
        await commandContext.reply(`🎱 *${question}*\n${randomChoice(EIGHT_BALL_ANSWERS)}`)
      },
    })
  },
}

export default utilityPlugin
