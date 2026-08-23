import { randomInt } from 'node:crypto'
import type { CommandContext, PluginContext } from '../contracts.js'

const FUN_COOLDOWN_MS = 1_500
const MAX_QUERY_LENGTH = 80

const TRUTH_PROMPTS = [
  'Apa hal kecil yang paling membuatmu senang minggu ini?',
  'Apa kebiasaan yang sedang ingin kamu perbaiki?',
  'Siapa yang paling sering membuatmu tertawa di grup ini?',
  'Apa keputusan sederhana yang ternyata paling membantu?',
  'Apa satu hal yang ingin kamu pelajari?',
] as const

const DARE_PROMPTS = [
  'Kirim satu pujian yang tulus kepada anggota grup.',
  'Tulis satu kalimat hanya dengan tiga kata.',
  'Gunakan emoji yang jarang kamu pakai untuk menggambarkan harimu.',
  'Bagikan rekomendasi lagu tanpa menjelaskan alasannya.',
  'Ucapkan terima kasih kepada seseorang di grup.',
] as const

const RPS_CHOICES = ['batu', 'gunting', 'kertas'] as const

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

function usage(context: CommandContext, command: string, example: string): string {
  return `Format: ${context.prefix}${command} ${example}`
}

function boundText(value: string, max = MAX_QUERY_LENGTH): string | undefined {
  const trimmed = value.trim()
  return trimmed && trimmed.length <= max ? trimmed : undefined
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

export function registerUtilityFunCommands(context: PluginContext): void {
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
    name: 'truth',
    aliases: ['jujur'],
    description: 'Dapatkan pertanyaan truth ringan',
    category: 'fun',
    menuOrder: 14,
    cooldownMs: FUN_COOLDOWN_MS,
    handler: async (commandContext) => commandContext.reply(`🗣️ *Truth:* ${randomChoice(TRUTH_PROMPTS)}`),
  })

  context.commands.register({
    name: 'dare',
    aliases: ['tantangan'],
    description: 'Dapatkan tantangan ringan yang aman',
    category: 'fun',
    menuOrder: 15,
    cooldownMs: FUN_COOLDOWN_MS,
    handler: async (commandContext) => commandContext.reply(`🎯 *Dare:* ${randomChoice(DARE_PROMPTS)}`),
  })

  context.commands.register({
    name: 'rps',
    aliases: ['suit'],
    description: 'Main batu gunting kertas melawan Allybot',
    category: 'fun',
    menuOrder: 16,
    cooldownMs: FUN_COOLDOWN_MS,
    handler: async (commandContext) => {
      const player = commandContext.args[0]?.toLowerCase()
      if (!RPS_CHOICES.includes(player as typeof RPS_CHOICES[number])) {
        await commandContext.reply(usage(commandContext, 'rps', '<batu|gunting|kertas>'))
        return
      }
      const bot = randomChoice(RPS_CHOICES)
      const result = player === bot ? 'Seri.' : (player === 'batu' && bot === 'gunting') || (player === 'gunting' && bot === 'kertas') || (player === 'kertas' && bot === 'batu') ? 'Kamu menang.' : 'Allybot menang.'
      await commandContext.reply(`✊ *Suit*\nKamu: ${player}\nAllybot: ${bot}\n\n*${result}*`)
    },
  })

  context.commands.register({
    name: '8ball',
    description: 'Jawab pertanyaan dengan permainan delapan bola',
    category: 'fun',
    menuOrder: 17,
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
}
