import { randomInt } from 'node:crypto'
import { createHash } from 'node:crypto'
import type { CommandContext, PluginContext, WhatsAppPort } from '../contracts.js'

const FUN_COOLDOWN_MS = 1_500
const MAX_QUERY_LENGTH = 80
const RPS_CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes

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

interface RpsChallenge {
  readonly challengerJid: string
  readonly challengedJid: string
  challengerChoice?: string
  challengedChoice?: string
  readonly createdAt: number
  readonly expiresAt: number
  readonly groupJid?: string
}

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

function normalizeJid(jid: string): string {
  const at = jid.lastIndexOf('@')
  if (at <= 0) return jid
  const local = jid.slice(0, at).split(':', 1)[0]
  return `${local}@${jid.slice(at + 1)}`
}

function challengeKey(challengerJid: string, challengedJid: string): string {
  return createHash('sha256').update(`${normalizeJid(challengerJid)}:${normalizeJid(challengedJid)}`).digest('hex').slice(0, 32)
}

export function registerUtilityFunCommands(context: PluginContext): void {
  const rpsChallenges = new Map<string, RpsChallenge>()
  const whatsapp = (context as { whatsapp?: WhatsAppPort }).whatsapp

  const pruneChallenges = (): void => {
    const now = Date.now()
    for (const [key, challenge] of rpsChallenges) {
      if (now >= challenge.expiresAt) rpsChallenges.delete(key)
    }
  }

  const getChallenge = (challengerJid: string, challengedJid: string): RpsChallenge | undefined => {
    return rpsChallenges.get(challengeKey(challengerJid, challengedJid))
  }

  const createChallenge = (challengerJid: string, challengedJid: string, groupJid?: string): RpsChallenge => {
    const now = Date.now()
    const challenge: RpsChallenge = {
      challengerJid: normalizeJid(challengerJid),
      challengedJid: normalizeJid(challengedJid),
      createdAt: now,
      expiresAt: now + RPS_CHALLENGE_TTL_MS,
      groupJid,
    }
    rpsChallenges.set(challengeKey(challengerJid, challengedJid), challenge)
    return challenge
  }

  const setChoice = (challengerJid: string, challengedJid: string, playerJid: string, choice: string): boolean => {
    const key = challengeKey(challengerJid, challengedJid)
    const challenge = rpsChallenges.get(key)
    if (!challenge) return false
    const normalizedPlayer = normalizeJid(playerJid)
    if (normalizedPlayer === challenge.challengerJid) {
      challenge.challengerChoice = choice
    } else if (normalizedPlayer === challenge.challengedJid) {
      challenge.challengedChoice = choice
    } else {
      return false
    }
    return true
  }

  const resolveChallenge = (challengerJid: string, challengedJid: string): { result: string; challengerChoice: string; challengedChoice: string } | undefined => {
    const key = challengeKey(challengerJid, challengedJid)
    const challenge = rpsChallenges.get(key)
    if (!challenge || !challenge.challengerChoice || !challenge.challengedChoice) return undefined
    const player = challenge.challengerChoice
    const opponent = challenge.challengedChoice
    let result: string
    if (player === opponent) {
      result = 'Seri!'
    } else if (
      (player === 'batu' && opponent === 'gunting') ||
      (player === 'gunting' && opponent === 'kertas') ||
      (player === 'kertas' && opponent === 'batu')
    ) {
      result = 'Challenger menang!'
    } else {
      result = 'Challenged menang!'
    }
    rpsChallenges.delete(key)
    return { result, challengerChoice: player, challengedChoice: opponent }
  }

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
    description: 'Main batu gunting kertas PvP (Private Chat)',
    category: 'fun',
    menuOrder: 16,
    cooldownMs: FUN_COOLDOWN_MS,
    handler: async (commandContext) => {
      pruneChallenges()
      const args = commandContext.args
      const subcommand = args[0]?.toLowerCase()
      const senderJid = commandContext.message.senderJid
      if (!senderJid) return

      const isGroup = commandContext.message.remoteJid.endsWith('@g.us')
      const isPrivate = !isGroup

      // Usage: !rps challenge @user - tantang pemain lain
      //        !rps accept - terima tantangan
      //        !rps <batu|gunting|kertas> - pilih pilihan (di PM)
      //        !rps cancel - batalkan tantangan

      if (!subcommand || subcommand === 'help') {
        await commandContext.reply([
          '✊ *Suit PvP (Player vs Player)*',
          '',
          'Cara main:',
          '1. Di grup: `!rps challenge @pemain` untuk menantang',
          '2. Kedua pemain akan diminta pilih di **Private Chat (PM)**',
          '3. Di PM: `!rps batu|gunting|kertas` untuk memilih',
          '4. Hasil akan diumumkan setelah keduanya memilih',
          '',
          'Command:',
          '• `!rps challenge @user` - Tantang pemain',
          '• `!rps accept` - Terima tantangan (di PM)',
          '• `!rps <batu|gunting|kertas>` - Pilih (di PM)',
          '• `!rps cancel` - Batalkan tantangan',
          '• `!rps status` - Lihat status tantangan aktif',
        ].join('\n'))
        return
      }

      if (subcommand === 'challenge') {
        if (isPrivate) {
          await commandContext.reply('Command challenge hanya bisa digunakan di grup.')
          return
        }
        const target = commandContext.message.mentionedJids?.[0] ?? commandContext.message.quotedSenderJid
        if (!target) {
          await commandContext.reply('Mention atau reply pemain yang ingin ditantang. Contoh: `!rps challenge @user`')
          return
        }
        if (normalizeJid(target) === normalizeJid(senderJid)) {
          await commandContext.reply('Tidak bisa menantang diri sendiri.')
          return
        }

        const challenge = createChallenge(senderJid, target, commandContext.message.remoteJid)

        // Send challenge notification to both players via PM
        const challengeMsg = [
          '✊ *Tantangan Suit PvP*',
          '',
          `🎯 *Challenger* : @${normalizeJid(senderJid).split('@')[0]}`,
          `🎯 *Challenged* : @${normalizeJid(target).split('@')[0]}`,
          '',
          'Kedua pemain: silakan buka Private Chat dengan Allybot dan ketik:',
          '`!rps batu` atau `!rps gunting` atau `!rps kertas`',
          '',
          `⏰ Tantangan berlaku ${RPS_CHALLENGE_TTL_MS / 60000} menit.`,
        ].join('\n')

        await commandContext.reply(challengeMsg, { mentions: [senderJid, target] })

        // Also send PM to both players
        if (whatsapp) {
          try {
            await whatsapp.sendText(normalizeJid(senderJid), `✊ Kamu menantang @${normalizeJid(target).split('@')[0]} untuk Suit PvP!\n\nKetik pilihanmu di sini: \`!rps batu\`, \`!rps gunting\`, atau \`!rps kertas\`\n\n⏰ Berlaku ${RPS_CHALLENGE_TTL_MS / 60000} menit.`)
            await whatsapp.sendText(normalizeJid(target), `✊ @${normalizeJid(senderJid).split('@')[0]} menantangmu untuk Suit PvP!\n\nKetik pilihanmu di sini: \`!rps batu\`, \`!rps gunting\`, atau \`!rps kertas\`\n\nAtau ketik \`!rps accept\` untuk menerima.\n\n⏰ Berlaku ${RPS_CHALLENGE_TTL_MS / 60000} menit.`)
          } catch {}
        }
        return
      }

      if (subcommand === 'accept') {
        if (isGroup) {
          await commandContext.reply('Command accept hanya bisa digunakan di Private Chat.')
          return
        }
        // Find challenge where this user is challenged
        let foundChallenge: RpsChallenge | undefined
        for (const challenge of rpsChallenges.values()) {
          if (challenge.challengedJid === normalizeJid(senderJid) && !challenge.challengedChoice) {
            foundChallenge = challenge
            break
          }
        }
        if (!foundChallenge) {
          await commandContext.reply('Tidak ada tantangan yang menunggu konfirmasimu.')
          return
        }
        await commandContext.reply('✅ Tantangan diterima! Sekarang pilih: `!rps batu`, `!rps gunting`, atau `!rps kertas`')
        return
      }

      if (subcommand === 'cancel') {
        let cancelled = false
        for (const [key, challenge] of rpsChallenges) {
          if (challenge.challengerJid === normalizeJid(senderJid) || challenge.challengedJid === normalizeJid(senderJid)) {
            rpsChallenges.delete(key)
            cancelled = true
          }
        }
        await commandContext.reply(cancelled ? '✅ Tantangan dibatalkan.' : 'Tidak ada tantangan aktif untuk dibatalkan.')
        return
      }

      if (subcommand === 'status') {
        const challenges = Array.from(rpsChallenges.values()).filter(
          c => c.challengerJid === normalizeJid(senderJid) || c.challengedJid === normalizeJid(senderJid)
        )
        if (challenges.length === 0) {
          await commandContext.reply('Tidak ada tantangan aktif.')
          return
        }
        await commandContext.reply(challenges.map(c =>
          `✊ @${c.challengerJid.split('@')[0]} vs @${c.challengedJid.split('@')[0]}\n` +
          `   Challenger: ${c.challengerChoice ?? 'belum pilih'}\n` +
          `   Challenged: ${c.challengedChoice ?? 'belum pilih'}\n` +
          `   Expired: <t:${Math.floor(c.expiresAt / 1000)}:R>`
        ).join('\n\n'), { mentions: challenges.flatMap(c => [c.challengerJid, c.challengedJid]) })
        return
      }

      // Handle choice input: batu, gunting, kertas
      if (!RPS_CHOICES.includes(subcommand as typeof RPS_CHOICES[number])) {
        await commandContext.reply(usage(commandContext, 'rps', '<batu|gunting|kertas>') + '\nAtau gunakan `!rps help` untuk bantuan.')
        return
      }

      if (isGroup) {
        await commandContext.reply('Pilih pilihan di **Private Chat** dengan Allybot, bukan di grup.')
        return
      }

      // Find challenge where this user is a participant
      let foundChallenge: RpsChallenge | undefined
      for (const challenge of rpsChallenges.values()) {
        if ((challenge.challengerJid === normalizeJid(senderJid) || challenge.challengedJid === normalizeJid(senderJid)) &&
            (!challenge.challengerChoice || !challenge.challengedChoice)) {
          foundChallenge = challenge
          break
        }
      }

      if (!foundChallenge) {
        await commandContext.reply('Tidak ada tantangan aktif untukmu. Minta seseorang menantangmu dengan `!rps challenge @kamu` di grup.')
        return
      }

      const choice = subcommand
      const success = setChoice(foundChallenge.challengerJid, foundChallenge.challengedJid, senderJid, choice)
      if (!success) {
        await commandContext.reply('Gagal mencatat pilihan. Coba lagi.')
        return
      }

      await commandContext.reply(`✅ Pilihan *${choice}* dicatat. Menunggu lawan...`)

      // Check if both have chosen
      const resolved = resolveChallenge(foundChallenge.challengerJid, foundChallenge.challengedJid)
      if (resolved) {
        const resultMsg = [
          '✊ *Suit PvP Selesai!*',
          '',
          `🎯 *Challenger* : ${resolved.challengerChoice}`,
          `🎯 *Challenged* : ${resolved.challengedChoice}`,
          '',
          `*${resolved.result}*`,
        ].join('\n')

        // Send result to both players via PM
        if (whatsapp) {
          try {
            await whatsapp.sendText(normalizeJid(foundChallenge.challengerJid), resultMsg)
            await whatsapp.sendText(normalizeJid(foundChallenge.challengedJid), resultMsg)
          } catch {}
        }

        // Also announce in group if challenge was from group
        if (foundChallenge.groupJid && whatsapp) {
          try {
            await whatsapp.sendText(foundChallenge.groupJid, resultMsg, {
              mentions: [foundChallenge.challengerJid, foundChallenge.challengedJid]
            })
          } catch {}
        }
      }
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
