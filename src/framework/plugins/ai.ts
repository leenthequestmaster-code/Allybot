import { transcribeAudioBuffer } from "../../services/stt-service.js"
import type {
  CommandContext,
  CommandDefinition,
  CoreMessage,
  Plugin,
  PluginContext,
  WhatsAppPort,
} from '../contracts.js'
import {
  AiHandlerError,
  MAX_AI_INPUT_LENGTH,
  createAiHandler,
  describeImageWithAi,
  type AiTransport,
} from '../../ai-handler.js'
import { isSameJid } from '../../permissions.js'
import { isGroupJid } from '../validation.js'
import { GroupConfigurationService } from '../../services/group-configuration-service.js'
import { AiMemoryService } from '../../services/ai-memory-service.js'
import {
  buildPersonaSystemPrompt,
  type PersonaProfile,
  DEFAULT_CHLONA_PERSONA,
  DEFAULT_ALLY_PERSONA,
  formatToWhatsApp,
} from '../../services/ai-persona-engine.js'

const AI_COMMAND_COOLDOWN_MS = 3_000

/**
 * Economy mutation and sensitive commands that MUST be typed manually with a prefix
 * (e.g. `!pay`, `!bank`, `!taxbayar`) to prevent accidental transfers via natural language.
 */
export const LOCKED_MANUAL_ONLY_COMMANDS = new Set([
  'pay',
  'transfer',
  'tf',
  'bank',
  'deposit',
  'depo',
  'withdraw',
  'tarik',
  'upgrade',
  'tax',
  'pajak',
  'taxbayar',
  'paytax',
  'claim',
  'klaim',
  'menfess',
  'confess',
  'menfessquit',
  'stopmenfess',
  'suggest',
  'saran',
  'report',
  'lapor',
  'ai',
  'ally',
  'tanya',
])

const PRIVILEGED_CATEGORIES = new Set(['moderation', 'admin', 'admin-tools', 'admintools', 'governance', 'developer', 'owner'])

function usage(context: CommandContext): string {
  return [
    "𓏼 *`𝐂𝗵𝗹𝗼𝗻𝗮 (𝐎𝗺𝗻𝐢)`*",
    "─꯭──꯭──    .  .  .    ▭▬▭▬▭",
    `Format: ${context.prefix}ai <pertanyaan atau instruksi>`,
    `Atau tag *@Chlona <pesan>* / ketik *Chlona <pesan>* / reply langsung`,
    "─͜──͜──͜─  · • ·  ─͜──͜──͜─",
    "Semua fungsi AI & Smart Router sudah disatukan di sini:",
    "• Ngobrol Natural : `Chlona hari ini hari apa?`",
    "• Panggil Fitur   : `Chlona tolong ubah gambar ini jadi stiker`",
    "• Putar Musik     : `Chlona play Duka Last Child`",
    "• Reset Ingatan   : `!ai reset`",
    "• Terjemahan      : `!ai terjemahkan ke Jepang: Halo`",
    "• Ringkas         : reply pesan + `!ai ringkas intinya`",
    "• Analisis Foto   : kirim/reply foto + `!ai foto ini tentang apa?`",
    "━━━━━━━━━━━━━━━━━━━━",
    "*© Allyssea Roleplay Community*",
  ].join("\n")
}

function pipeInput(context: CommandContext): { target: string; text: string } | undefined {
  const separator = context.args.join(' ').indexOf('|')
  if (separator < 0) return undefined
  const target = context.args.join(' ').slice(0, separator).trim()
  const text = context.args.join(' ').slice(separator + 1).trim()
  return target && text ? { target, text } : undefined
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof AiHandlerError && error.code === 'invalid_input') return error.message
  if (error instanceof AiHandlerError && error.code === 'missing_api_key') return 'Fitur AI belum siap dipakai nih, colek owner ya~ 🙏'
  return 'Lagi pusing nih, coba tanya lagi beberapa saat ya~ 🤖🙏'
}

function extractImageSourceFromMessage(message: CoreMessage): { descriptor: any; source: 'direct' | 'quoted' } | undefined {
  if (message.media?.kind === 'image') {
    return { descriptor: message.media, source: 'direct' }
  }
  if (message.quotedMedia?.kind === 'image') {
    return { descriptor: message.quotedMedia, source: 'quoted' }
  }
  return undefined
}

function extractImageSource(context: CommandContext): { descriptor: any; source: 'direct' | 'quoted' } | undefined {
  return extractImageSourceFromMessage(context.message)
}

export function isAllowedPublicMenuCommand(command: CommandDefinition): boolean {
  if (command.hidden) return false
  if (command.permission) return false
  if (command.scope === 'internal') return false
  const cat = command.category?.trim().toLowerCase() ?? ''
  if (PRIVILEGED_CATEGORIES.has(cat)) return false
  if (LOCKED_MANUAL_ONLY_COMMANDS.has(command.name.toLowerCase())) return false
  if ((command.aliases ?? []).some((alias) => LOCKED_MANUAL_ONLY_COMMANDS.has(alias.toLowerCase()))) return false
  return true
}

export function isManualOnlyTransactionIntent(text: string): boolean {
  const normalized = text.trim().toLowerCase()
  const firstToken = normalized.split(/\s+/)[0] ?? ''
  if (
    ['pay', 'transfer', 'tf', 'bank', 'deposit', 'depo', 'withdraw', 'tarik', 'taxbayar', 'paytax'].includes(firstToken)
  ) {
    return true
  }
  return /\b(?:transfer\s+vela|kirim\s+vela|bayar\s+pajak|tarik\s+vela|simpan\s+vela|deposit\s+vela|withdraw\s+vela)\b/i.test(normalized)
}

/**
 * Deterministic natural-language command matcher for common Indonesian requests
 * so they execute in 0ms without needing an extra LLM round-trip.
 */
export function matchNaturalLanguageCommand(
  instruction: string,
  message: CoreMessage,
): { commandName: string; argsText: string } | undefined {
  const trimmed = instruction.trim()
  const lower = trimmed.toLowerCase()

  const hasImageOrVideo =
    message.media?.kind === 'image' ||
    message.media?.kind === 'video' ||
    message.quotedMedia?.kind === 'image' ||
    message.quotedMedia?.kind === 'video'
  const hasSticker = message.media?.kind === 'sticker' || message.quotedMedia?.kind === 'sticker'

  // 1. Sticker creation ("tolong ubah gambar ini jadi stiker", "bikinin stiker", etc.)
  if (
    hasImageOrVideo &&
    /\b(?:jadi(?:in|kan)?\s+stik?er|buat(?:in|kan)?\s+stik?er|bikin(?:in)?\s+stik?er|ubah\s+(?:gambar|foto|video)?\s*(?:ini\s+)?jadi\s+stik?er|stik?erin)\b/i.test(lower)
  ) {
    return { commandName: 'sticker', argsText: '' }
  }

  // 2. Sticker to image ("ubah stiker ini jadi gambar/foto")
  if (hasSticker && /\b(?:jadi(?:in|kan)?\s+(?:gambar|foto)|ubah\s+(?:stik?er\s+)?(?:ini\s+)?jadi\s+(?:gambar|foto)|toimg)\b/i.test(lower)) {
    return { commandName: 'toimg', argsText: '' }
  }

  // 3. Remove background ("hapus background gambar ini")
  if (
    (message.media?.kind === 'image' || message.quotedMedia?.kind === 'image') &&
    /\b(?:hapus\s+(?:background|bg|latar(?:\s+belakang)?)|removebg|nobg)\b/i.test(lower)
  ) {
    return { commandName: 'removebg', argsText: '' }
  }

  // 4. HD / Enhance image ("jernihkan foto ini", "hd-in gambar ini")
  if (
    (message.media?.kind === 'image' || message.quotedMedia?.kind === 'image') &&
    /\b(?:jernih(?:in|kan)|perjelas|hd(?:-?in|kan)?|remini)\b/i.test(lower)
  ) {
    return { commandName: 'hd', argsText: '' }
  }

  // 5. Play music ("play Duka Last Child", "puterin lagu Duka Last Child", "putar lagu ...")
  const playMatch = trimmed.match(
    /^(?:tolong\s+|coba\s+)?(?:play|putar(?:in|kan)?|puter(?:in|kan)?|stel(?:in)?|mainkan)\s+(?:lagu\s+|musik\s+)?(.+)$/i,
  )
  if (playMatch?.[1]) {
    return { commandName: 'play', argsText: playMatch[1].trim() }
  }

  // 6. Brat sticker ("bikin brat lagi pusing", "stiker brat lagi pusing")
  const bratMatch = trimmed.match(
    /^(?:tolong\s+|coba\s+)?(?:bikin(?:in)?|buat(?:in|kan)?)\s+(?:stik?er\s+)?brat\s+(?:tulisan\s+|teks\s+)?(.+)$/i,
  )
  if (bratMatch?.[1]) {
    return { commandName: 'brat', argsText: bratMatch[1].trim() }
  }

  // 7. Weather ("cek cuaca Jakarta", "cuaca di Medan")
  const cuacaMatch = trimmed.match(/^(?:tolong\s+|coba\s+)?(?:cek\s+|info\s+)?cuaca\s+(?:di\s+|kota\s+)?(.+)$/i)
  if (cuacaMatch?.[1]) {
    return { commandName: 'cuaca', argsText: cuacaMatch[1].trim() }
  }

  // 8. Prayer schedule ("jadwal sholat Jakarta")
  const sholatMatch = trimmed.match(/^(?:tolong\s+|coba\s+)?(?:cek\s+|info\s+)?(?:jadwal\s+)?sholat\s+(?:di\s+|kota\s+)?(.+)$/i)
  if (sholatMatch?.[1]) {
    return { commandName: 'sholat', argsText: sholatMatch[1].trim() }
  }

  // 9. Group chat recap ("rekap chat 50", "rangkum obrolan grup")
  const rekapMatch = trimmed.match(/^(?:tolong\s+|coba\s+)?(?:rekap|rangkum(?:in|kan)?)\s+(?:obrolan|chat|pesan)(?:\s+grup)?(?:\s+(\d+))?/i)
  if (rekapMatch) {
    return { commandName: 'rekap', argsText: rekapMatch[1] ?? '' }
  }

  return undefined
}

function buildPublicMenuCatalogPrompt(context: PluginContext, message: CoreMessage): string {
  const publicCommands = context.commands.list().filter(isAllowedPublicMenuCommand)
  if (publicCommands.length === 0) return ''

  const compactList = publicCommands
    .slice(0, 60)
    .map((cmd) => {
      const aliases = cmd.aliases?.length ? ` (${cmd.aliases.slice(0, 2).join('/')})` : ''
      const desc = cmd.description ? `: ${cmd.description}` : ''
      return `- ${cmd.name}${aliases}${desc}`
    })
    .join('\n')

  const mediaHints: string[] = []
  if (message.media?.kind) mediaHints.push(`lampiran langsung=${message.media.kind}`)
  if (message.quotedMedia?.kind) mediaHints.push(`reply media=${message.quotedMedia.kind}`)
  if (message.quotedText) mediaHints.push(`reply teks="${message.quotedText.slice(0, 120)}"`)

  return [
    '\n[INSTRUKSI SMART ROUTER FITUR BOT]:',
    'Jika pengguna secara eksplisit meminta kamu menjalankan salah satu fitur/command bot dari daftar di bawah ini (misalnya membuat stiker, memutar lagu, cek cuaca, cek jadwal sholat, cek karakter/vela, kalkulator, dll.), balas HANYA dengan satu baris persis dalam format:',
    '[RUN_CMD: <nama_command> <argumen_jika_ada>]',
    'Contoh: [RUN_CMD: sticker] atau [RUN_CMD: play Duka Last Child] atau [RUN_CMD: cuaca Medan].',
    'PENTING: Jika pengguna hanya menyapa, bertanya kabar/hari/pengetahuan umum, curhat, atau mengobrol biasa (seperti "Halo Chlona, hari ini hari apa?"), JANGAN gunakan [RUN_CMD:...], melainkan balas langsung dengan obrolan natural sebagai Chlona.',
    mediaHints.length > 0 ? `Konteks media pesan saat ini: ${mediaHints.join(', ')}.` : '',
    'Daftar fitur publik yang tersedia:\n' + compactList,
  ]
    .filter(Boolean)
    .join('\n')
}

function detectBotMentionOrReply(
  message: CoreMessage,
  whatsapp: WhatsAppPort | undefined,
): { triggered: boolean; cleanText: string; triggerKind: 'mention' | 'reply' | 'audio' | 'none' } {
  const rawText = message.text?.trim() ?? ''
  const isAudio = message.media?.kind === 'audio'

  const botJid = whatsapp?.userJid
  const botLid = whatsapp?.userLid
  const botPhone = botJid?.split('@')[0]?.split(':')[0]
  const botLidBare = botLid?.split('@')[0]?.split(':')[0]

  // 1. Check native WhatsApp @mention in mentionedJids
  const mentionedBotNatively = (message.mentionedJids ?? []).some(
    (jid) => (botJid && isSameJid(jid, botJid)) || (botLid && isSameJid(jid, botLid)),
  )

  // 2. Check text @Chlona / Chlona / @Allybot / @ally / @<botPhone> / @<botLid>
  const textMentionRegex = new RegExp(
    `(?:^|\\s)@?(?:chlona|allybot|ally${botPhone ? `|${botPhone}` : ''}${botLidBare ? `|${botLidBare}` : ''})\\b`,
    'i',
  )
  const mentionedInText = textMentionRegex.test(rawText)

  if (mentionedBotNatively || mentionedInText) {
    const stripRegex = new RegExp(
      `(?:^|\\s)@?(?:chlona|allybot|ally${botPhone ? `|${botPhone}` : ''}${botLidBare ? `|${botLidBare}` : ''})\\b[,:!\\s]*`,
      'gi',
    )
    const cleaned = rawText.replace(stripRegex, ' ').replace(/\s+/g, ' ').trim()
    return { triggered: true, cleanText: cleaned, triggerKind: 'mention' }
  }

  // 3. Check direct reply to bot's own message
  const quotedSender = message.quotedSenderJid ?? message.rawQuotedSenderJid
  const repliedToBotJid =
    Boolean(quotedSender) &&
    ((Boolean(botJid) && isSameJid(quotedSender, botJid)) || (Boolean(botLid) && isSameJid(quotedSender, botLid)))
  const quotedLooksLikeAi = Boolean(
    message.quotedText && /(?:Chlona|Allybot|\bAI\b|^🤖)/i.test(message.quotedText.trim()),
  )

  if (repliedToBotJid || (!quotedSender && quotedLooksLikeAi)) {
    return { triggered: true, cleanText: rawText, triggerKind: isAudio ? 'audio' : 'reply' }
  }

  if (isAudio && !isGroupJid(message.remoteJid)) {
    return { triggered: true, cleanText: '', triggerKind: 'audio' }
  }

  if (!rawText) return { triggered: false, cleanText: '', triggerKind: 'none' }

  return { triggered: false, cleanText: rawText, triggerKind: 'none' }
}

export interface AiPluginOptions {
  readonly transport?: AiTransport
  readonly fallbackEnabled?: boolean
  readonly whatsapp?: WhatsAppPort
  readonly persona?: PersonaProfile
  readonly humanTypingDelayMs?: number
}

export function createAiPlugin(options: AiPluginOptions = {}): Plugin {
  return {
    name: 'ai-commands',
    version: '0.2.0',
    load(context) {
      const handler = createAiHandler({
        transport: options.transport,
        logger: context.logger,
        fallbackEnabled: options.fallbackEnabled,
      })

      const getMemoryService = (): AiMemoryService | undefined => {
        if (typeof context.services?.has === 'function') {
          if (!context.services.has('ai-memory')) return undefined
          try {
            return context.services.get<AiMemoryService>('ai-memory')
          } catch {
            return undefined
          }
        }
        return undefined
      }

      const resolvePrefix = (message: CoreMessage): string => {
        if (isGroupJid(message.remoteJid) && typeof context.services?.has === 'function' && context.services.has('group-configuration')) {
          try {
            const groupConfig = context.services.get<GroupConfigurationService>('group-configuration')
            return groupConfig.resolvePrefix(message.remoteJid, context.config.commandPrefix)
          } catch {
            return context.config.commandPrefix
          }
        }
        return context.config.commandPrefix
      }

      // 1. Omni-AI: Single entry point for general chat, contextual reply, multi-turn memory, and vision
      context.commands.register({
        name: 'ai',
        aliases: ['chlona', 'ally', 'tanya'],
        description: 'Tanya atau ngobrol bareng Chlona secara serbaguna',
        category: 'tools',
        menuOrder: 1,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const rawPrompt = commandContext.args.join(' ').trim()
          const quotedText = commandContext.message.quotedText?.trim()
          const imageSource = extractImageSource(commandContext)
          const senderJid = commandContext.message.senderJid ?? commandContext.message.remoteJid
          const memory = getMemoryService()

          // Subcommand: !ai reset / !ai clear
          if (/^(?:reset|clear|hapus|lupakan)$/i.test(rawPrompt) && !quotedText && !imageSource) {
            await memory?.clearHistory(commandContext.message.remoteJid, senderJid)
            await commandContext.reply('🧹 Oke, ingatan obrolan kita udah di-reset ya! Yuk mulai topik baru~')
            return
          }

          // Guardrail: Block automatic execution of Vela transfers / Bank / Tax mutations
          if (isManualOnlyTransactionIntent(rawPrompt)) {
            await commandContext.reply(
              `🛡️ Demi keamanan saldo Vela kamu, transaksi seperti transfer, bank, atau pembayaran pajak tetap wajib diketik manual pakai command ya (misalnya *${commandContext.prefix}pay @user nominal* atau *${commandContext.prefix}bank*)~`,
            )
            return
          }

          // Stage 1: Fast-Path Direct Command/Alias Match (e.g. "!ai play Duka Last Child")
          const [firstWord, ...restTokens] = rawPrompt.split(/\s+/)
          if (firstWord && !quotedText && !imageSource) {
            const directCmd = context.commands.get(firstWord.toLowerCase())
            if (directCmd && isAllowedPublicMenuCommand(directCmd) && directCmd.name !== 'ai') {
              const syntheticText = `${commandContext.prefix}${directCmd.name}${restTokens.length > 0 ? ` ${restTokens.join(' ')}` : ''}`
              await context.commands.dispatch({ ...commandContext.message, text: syntheticText })
              return
            }
          }

          // Stage 2: Deterministic Natural Language Command Matcher (e.g. "!ai tolong jadikan stiker")
          if (rawPrompt && !quotedText && !imageSource) {
            const matchedNlu = matchNaturalLanguageCommand(rawPrompt, commandContext.message)
            if (matchedNlu && matchedNlu.commandName !== 'ai') {
              const targetCmd = context.commands.get(matchedNlu.commandName)
              if (targetCmd && isAllowedPublicMenuCommand(targetCmd)) {
                const syntheticText = `${commandContext.prefix}${targetCmd.name}${matchedNlu.argsText ? ` ${matchedNlu.argsText}` : ''}`
                await context.commands.dispatch({ ...commandContext.message, text: syntheticText })
                return
              }
            }
          }

          // 1A. Multimodal Vision Handling (Direct Image or Quoted Image)
          if (imageSource) {
            if (!commandContext.whatsapp.downloadMedia) {
              await commandContext.reply('Waduh, belum bisa ambil gambarnya nih. Coba kirim ulang ya~ 📥')
              return
            }
            try {
              const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, imageSource.source, {
                maxBytes: 10 * 1024 * 1024,
                timeoutMs: 25_000,
              })
              const base64 = Buffer.from(downloaded.data).toString('base64')
              const mime = downloaded.mimeType || 'image/jpeg'
              const dataUrl = `data:${mime};base64,${base64}`

              const prompt = rawPrompt || (quotedText ? `Perhatikan gambar ini berdasarkan konteks berikut:\n"${quotedText}"` : undefined)
              const result = await describeImageWithAi(dataUrl, prompt)
              const formattedResult = formatToWhatsApp(result)
              await memory?.appendExchange(commandContext.message.remoteJid, senderJid, prompt ?? '[Kirim Gambar]', formattedResult)
              await commandContext.reply(formattedResult)
            } catch (error) {
              commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'ai vision failed')
              await commandContext.reply('Gambarnya kurang jelas atau lagi gagal diproses nih, coba foto yang lebih terang ya~ 🔍📷')
            }
            return
          }

          // 1B. Text Handling (Standalone or Quoted Message Context)
          let finalPrompt = rawPrompt
          if (quotedText) {
            if (rawPrompt) {
              finalPrompt = `Rujukan pesan yang dibalas:\n"${quotedText}"\n\nInstruksi pengguna:\n${rawPrompt}`
            } else {
              finalPrompt = `Ringkas dan jelaskan inti dari pesan berikut secara singkat dalam bahasa Indonesia:\n"${quotedText}"`
            }
          }

          if (!finalPrompt) {
            await commandContext.reply(usage(commandContext))
            return
          }

          if (finalPrompt.length > MAX_AI_INPUT_LENGTH) {
            await commandContext.reply(`Pertanyaannya kepanjangan nih, maksimal ${MAX_AI_INPUT_LENGTH} karakter ya~ ✍️`)
            return
          }

          try {
            await commandContext.sendPresence?.('composing')
            const history = await memory?.getHistory(commandContext.message.remoteJid, senderJid)
            const personaPrompt =
              buildPersonaSystemPrompt(
                {
                  senderName: commandContext.message.pushName,
                  isGroup: isGroupJid(commandContext.message.remoteJid),
                  groupName: commandContext.message.groupName,
                },
                options.persona ?? DEFAULT_CHLONA_PERSONA,
              ) + buildPublicMenuCatalogPrompt(context, commandContext.message)

            const rawReply = await handler(finalPrompt, {
              history,
              systemPrompt: personaPrompt,
            })

            // Check if the LLM routed the request to a public !menu command: [RUN_CMD: <name> <args>]
            const cmdMatch = rawReply.trim().match(/^\[RUN_CMD:\s*([a-z0-9_-]+)(?:\s+([^\]]*))?\]$/i)
            if (cmdMatch?.[1]) {
              const cmdName = cmdMatch[1].toLowerCase()
              const cmdArgs = (cmdMatch[2] ?? '').trim()
              if (isManualOnlyTransactionIntent(`${cmdName} ${cmdArgs}`)) {
                await commandContext.reply(
                  `🛡️ Demi keamanan saldo Vela kamu, transaksi seperti *${commandContext.prefix}${cmdName}* wajib diketik manual pakai command ya~`,
                )
                return
              }
              const targetCmd = context.commands.get(cmdName)
              if (targetCmd && isAllowedPublicMenuCommand(targetCmd) && targetCmd.name !== 'ai') {
                const syntheticText = `${commandContext.prefix}${targetCmd.name}${cmdArgs ? ` ${cmdArgs}` : ''}`
                await context.commands.dispatch({ ...commandContext.message, text: syntheticText })
                return
              }
            }

            const formattedReply = formatToWhatsApp(rawReply)
            const typingDelayMs =
              options.humanTypingDelayMs !== undefined
                ? options.humanTypingDelayMs
                : process.env.NODE_ENV === 'test'
                  ? 0
                  : Math.min(1200, Math.max(300, Math.round(formattedReply.length * 8)))

            if (typingDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, typingDelayMs))
            }

            await memory?.appendExchange(commandContext.message.remoteJid, senderJid, finalPrompt, formattedReply)
            await commandContext.reply(formattedReply)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'AI command failed safely')
            await commandContext.reply(safeFailureMessage(error))
          }
        },
      })

      // 1C. Natural @Allybot Mention, Reply-Chain & Smart !menu Command Router
      context.events.on('message.received', async (message: CoreMessage) => {
        if (message.fromMe) return
        const whatsapp = options.whatsapp
        if (!whatsapp) return

        const prefix = resolvePrefix(message)
        const isAudio = message.media?.kind === 'audio'
        const rawText = (message.text ?? '').trim()
        if (!rawText && !isAudio) return

        // Ignore explicit prefixed commands (!menu, .ai, etc.) because CommandRegistry handles them
        if (rawText && (rawText.startsWith(prefix) || rawText.startsWith(context.config.commandPrefix))) {
          return
        }

        const detection = detectBotMentionOrReply(message, whatsapp)
        if (!detection.triggered) return

        const senderJid = message.senderJid ?? message.remoteJid

        // Guard: If user is replying to a chess board or playing in an active chess game, do NOT hijack with AI Chlona
        if (detection.triggerKind === 'reply') {
          const quotedText = message.quotedText ?? ''
          const isQuotingChess =
            /[♟♞♝♜♛♚]/u.test(quotedText) ||
            /\b(?:catur|chess|skak|skakmat|giliran jalan|langkah terakhir|game review)\b/i.test(quotedText)

          const chessService = context.services.has('chess')
            ? (context.services.get('chess') as any)
            : undefined

          const activeGame = chessService?.getActiveGame?.(message.remoteJid)
          const isPlayerInActiveGame =
            activeGame &&
            !activeGame.gameOver &&
            senderJid &&
            (isSameJid(senderJid, activeGame.whiteJid) || isSameJid(senderJid, activeGame.blackJid))

          if (isQuotingChess || isPlayerInActiveGame) {
            return
          }
        }

        let instruction = detection.cleanText
        const memory = getMemoryService()

        const sendPresence = async (presence: 'composing' | 'paused') => {
          try {
            if (whatsapp.sendPresenceUpdate) {
              await whatsapp.sendPresenceUpdate(message.remoteJid, presence)
            }
          } catch {
            // fail-soft
          }
        }

        if (isAudio && whatsapp.downloadMedia) {
          await sendPresence('composing')
          try {
            const downloaded = await whatsapp.downloadMedia(message, 'direct', {
              maxBytes: 15 * 1024 * 1024,
              timeoutMs: 30_000,
            })
            const transcript = await transcribeAudioBuffer(Buffer.from(downloaded.data))
            if (transcript && transcript.length > 0) {
              instruction = transcript
            } else {
              await whatsapp.sendText(message.remoteJid, 'Suara di pesan suaramu kurang jelas nih, bisa tolong diulangi lagi? 🎙️😅')
              return
            }
          } catch (err) {
            context.logger.warn({ err }, 'failed to transcribe voice note in mention handler')
            await whatsapp.sendText(message.remoteJid, 'Waduh, gagal mendengarkan pesan suara kamu nih. Coba lagi ya~ 🎙️')
            return
          }
        }

        // If user just tagged @Chlona with no text and no media
        if (!instruction && !extractImageSourceFromMessage(message)) {
          await whatsapp.sendText(
            message.remoteJid,
            `Halo${message.pushName ? ` *${message.pushName}*` : ''}! 👋 Ada yang bisa kubantu? Kamu bisa langsung ngobrol sama aku atau minta jalankan fitur (contoh: *Chlona play Duka Last Child* atau kirim foto sambil ketik *Chlona ubah jadi stiker*).`,
          )
          return
        }

        // Reset memory via Chlona reset
        if (/^(?:reset|clear|reset\s+ingatan|lupakan\s+obrolan)$/i.test(instruction)) {
          await memory?.clearHistory(message.remoteJid, senderJid)
          await whatsapp.sendText(message.remoteJid, '🧹 Oke, ingatan obrolan kita udah kuhapus ya. Mau bahas apa nih sekarang?')
          return
        }

        // Guardrail: Block automatic execution of Vela transfers / Bank / Tax mutations
        if (isManualOnlyTransactionIntent(instruction)) {
          await whatsapp.sendText(
            message.remoteJid,
            `🛡️ Demi keamanan saldo Vela kamu, transaksi seperti transfer, bank, atau pembayaran pajak tetap wajib diketik manual pakai command ya (misalnya *${prefix}pay @user nominal* atau *${prefix}bank*)~`,
          )
          return
        }

        // Stage 1: Fast-Path Direct Command/Alias Match (e.g. "@Chlona play Duka Last Child")
        const [firstWord, ...restTokens] = instruction.split(/\s+/)
        if (firstWord) {
          const directCmd = context.commands.get(firstWord.toLowerCase())
          if (directCmd && isAllowedPublicMenuCommand(directCmd)) {
            const syntheticText = `${prefix}${directCmd.name}${restTokens.length > 0 ? ` ${restTokens.join(' ')}` : ''}`
            await context.commands.dispatch({ ...message, text: syntheticText })
            return
          }
        }

        // Stage 2: Deterministic Natural Language Command Matcher (0ms)
        const matchedNlu = matchNaturalLanguageCommand(instruction, message)
        if (matchedNlu) {
          const targetCmd = context.commands.get(matchedNlu.commandName)
          if (targetCmd && isAllowedPublicMenuCommand(targetCmd)) {
            const syntheticText = `${prefix}${targetCmd.name}${matchedNlu.argsText ? ` ${matchedNlu.argsText}` : ''}`
            await context.commands.dispatch({ ...message, text: syntheticText })
            return
          }
        }

        // Wrap LLM, Vision, and Conversational synthesis in active composing presence + heartbeat
        await sendPresence('composing')
        const presenceHeartbeat = setInterval(() => {
          void sendPresence('composing')
        }, 8_000)

        try {
          // Stage 3: Multimodal Image Vision on mention (when not a sticker/hd/nobg command)
          const imageSource = extractImageSourceFromMessage(message)
          if (imageSource && whatsapp.downloadMedia) {
            try {
              const downloaded = await whatsapp.downloadMedia(message, imageSource.source, {
                maxBytes: 10 * 1024 * 1024,
                timeoutMs: 25_000,
              })
              const base64 = Buffer.from(downloaded.data).toString('base64')
              const mime = downloaded.mimeType || 'image/jpeg'
              const dataUrl = `data:${mime};base64,${base64}`
              const visionPrompt = instruction || (message.quotedText ? `Perhatikan gambar ini berdasarkan konteks: "${message.quotedText}"` : undefined)
              const result = await describeImageWithAi(dataUrl, visionPrompt)
              const formattedResult = formatToWhatsApp(result)
              await memory?.appendExchange(message.remoteJid, senderJid, visionPrompt ?? '[Gambar]', formattedResult)
              await whatsapp.sendText(message.remoteJid, formattedResult)
            } catch (error) {
              context.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'mention vision failed')
              await whatsapp.sendText(message.remoteJid, 'Gambarnya kurang jelas atau gagal diproses nih, coba kirim ulang ya~ 🔍📷')
            }
            return
          }

          // Stage 4: Single-Call Conversational Persona + Smart LLM Command Router
          const boundedInstruction = instruction.slice(0, MAX_AI_INPUT_LENGTH)
          const promptWithQuote =
            message.quotedText && detection.triggerKind === 'mention'
              ? `Rujukan pesan yang dibalas:\n"${message.quotedText.trim()}"\n\nPesan pengguna:\n${boundedInstruction}`
              : boundedInstruction

          const history = await memory?.getHistory(message.remoteJid, senderJid)
          const personaPrompt =
            buildPersonaSystemPrompt(
              {
                senderName: message.pushName,
                isGroup: isGroupJid(message.remoteJid),
                groupName: message.groupName,
              },
              options.persona ?? DEFAULT_CHLONA_PERSONA,
            ) + buildPublicMenuCatalogPrompt(context, message)

          const rawReply = await handler(promptWithQuote.slice(0, MAX_AI_INPUT_LENGTH), {
            history,
            systemPrompt: personaPrompt,
          })

          // Check if the LLM routed the request to a public !menu command: [RUN_CMD: <name> <args>]
          const cmdMatch = rawReply.trim().match(/^\[RUN_CMD:\s*([a-z0-9_-]+)(?:\s+([^\]]*))?\]$/i)
          if (cmdMatch?.[1]) {
            const cmdName = cmdMatch[1].toLowerCase()
            const cmdArgs = (cmdMatch[2] ?? '').trim()
            if (isManualOnlyTransactionIntent(`${cmdName} ${cmdArgs}`)) {
              await whatsapp.sendText(
                message.remoteJid,
                `🛡️ Demi keamanan saldo Vela kamu, transaksi seperti *${prefix}${cmdName}* wajib diketik manual pakai command ya~`,
              )
              return
            }
            const targetCmd = context.commands.get(cmdName)
            if (targetCmd && isAllowedPublicMenuCommand(targetCmd)) {
              const syntheticText = `${prefix}${targetCmd.name}${cmdArgs ? ` ${cmdArgs}` : ''}`
              await context.commands.dispatch({ ...message, text: syntheticText })
              return
            }
          }

          const formattedReply = formatToWhatsApp(rawReply)
          const typingDelayMs =
            options.humanTypingDelayMs !== undefined
              ? options.humanTypingDelayMs
              : process.env.NODE_ENV === 'test'
                ? 0
                : Math.min(1200, Math.max(300, Math.round(formattedReply.length * 8)))

          if (typingDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, typingDelayMs))
          }

          await memory?.appendExchange(message.remoteJid, senderJid, boundedInstruction, formattedReply)
          await whatsapp.sendText(message.remoteJid, formattedReply)
        } catch (error) {
          context.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'AI mention handler failed safely')
          await whatsapp.sendText(message.remoteJid, safeFailureMessage(error))
        } finally {
          clearInterval(presenceHeartbeat)
          await sendPresence('paused')
        }
      })

      // 2. Shortcut: Translate
      context.commands.register({
        name: 'translate',
        aliases: ['terjemah', 'trans'],
        description: 'Terjemahkan teks yang kamu kirim secara langsung',
        category: 'tools',
        hidden: true,
        menuOrder: 2,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const input = pipeInput(commandContext)
          if (!input || input.target.length > 40 || input.text.length > MAX_AI_INPUT_LENGTH - 120) {
            await commandContext.reply(`Format: ${commandContext.prefix}translate <bahasa> | <teks>\nContoh: ${commandContext.prefix}translate Inggris | Selamat datang di grup.`)
            return
          }
          try {
            const response = await handler(`Terjemahkan teks berikut ke bahasa ${input.target}. Pertahankan makna dan jangan menambahkan penjelasan:\n${input.text}`)
            await commandContext.reply(`🌐 *Terjemahan*\n${formatToWhatsApp(response)}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'translate command failed safely')
            await commandContext.reply(safeFailureMessage(error))
          }
        },
      })

      // 3. Shortcut: Summarize
      context.commands.register({
        name: 'summarize',
        aliases: ['ringkas'],
        description: 'Ringkas teks yang kamu kirim secara langsung',
        category: 'tools',
        hidden: true,
        menuOrder: 3,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.message.quotedText?.trim() || commandContext.args.join(' ').trim()
          if (!text || text.length > MAX_AI_INPUT_LENGTH) {
            await commandContext.reply(`Format: ${commandContext.prefix}summarize <teks>\nContoh: ${commandContext.prefix}summarize [tempel teks di sini]`)
            return
          }
          try {
            const response = await handler(`Ringkas teks berikut menjadi beberapa kalimat singkat dalam bahasa Indonesia. Jangan menambahkan fakta baru:\n${text}`)
            await commandContext.reply(`📝 *Ringkasan*\n${formatToWhatsApp(response)}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'summarize command failed safely')
            await commandContext.reply(safeFailureMessage(error))
          }
        },
      })

      // 4. AI Detection
      context.commands.register({
        name: 'aidetection',
        aliases: ['deteksiai', 'aidetect'],
        description: 'Deteksi teks AI via reply message atau teks input',
        category: 'tools',
        hidden: true,
        menuOrder: 4,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.message.quotedText ?? commandContext.args.join(' ').trim()
          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}aidetection <teks>\nAtau reply pesan lalu ketik ${commandContext.prefix}aidetection`)
            return
          }
          if (text.length > MAX_AI_INPUT_LENGTH) {
            await commandContext.reply(`Teksnya kepanjangan nih, maksimal ${MAX_AI_INPUT_LENGTH} karakter ya~ ✍️`)
            return
          }
          try {
            const response = await handler(`Analisis teks berikut dan tentukan apakah ditulis oleh AI atau manusia. Berikan skor kepercayaan 0-100% dan alasan singkat:\n\n${text}`)
            await commandContext.reply(`🔍 *AI Detection*\n${formatToWhatsApp(response)}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'AI detection failed safely')
            await commandContext.reply(safeFailureMessage(error))
          }
        },
      })

      // 5. Text-to-Speech (Google TTS + FFmpeg OGG Opus PTT)
      context.commands.register({
        name: 'tts',
        aliases: ['suara'],
        description: 'Ubah teks menjadi pesan suara',
        category: 'tools',
        menuOrder: 5,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const text = commandContext.args.join(' ').trim()
          if (!text) {
            await commandContext.reply(`Format: ${commandContext.prefix}tts <teks>\nContoh: ${commandContext.prefix}tts Halo, selamat pagi`)
            return
          }
          if (text.length > 300) {
            await commandContext.reply('Teksnya kepanjangan buat pesan suara nih, maksimal 300 karakter ya~ 🎙️')
            return
          }
          try {
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=id&client=tw-ob`
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const mp3Buffer = Buffer.from(await res.arrayBuffer())

            let audioData: Uint8Array = new Uint8Array(mp3Buffer)
            let mimeType = 'audio/mp4'
            const isPtt = true

            try {
              const { spawn } = await import('node:child_process')
              const opus = await new Promise<Buffer>((resolve, reject) => {
                const ff = spawn('ffmpeg', ['-y', '-i', 'pipe:0', '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'libopus', '-b:a', '48k', '-application', 'voip', '-avoid_negative_ts', 'make_zero', '-f', 'ogg', 'pipe:1'])
                const chunks: Buffer[] = []
                ff.stdout.on('data', (d: Buffer) => chunks.push(d))
                ff.on('error', reject)
                ff.on('close', (code) => {
                  if (code === 0 && chunks.length > 0) resolve(Buffer.concat(chunks))
                  else reject(new Error(`FFmpeg exited with code ${code}`))
                })
                ff.stdin.write(mp3Buffer)
                ff.stdin.end()
              })
              audioData = new Uint8Array(opus)
              mimeType = 'audio/ogg; codecs=opus'
            } catch {
              // fallback to audioData as is
            }

            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'audio',
                data: audioData,
                mimeType,
                ptt: isPtt,
              })
            } else {
              await commandContext.reply('Pesan suara belum bisa kekirim nih, coba lagi nanti ya~ 🎙️')
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'tts command failed')
            await commandContext.reply('Gagal bikin pesan suara nih, coba kalimat lain ya~ 😅')
          }
        },
      })

      // 6. Text-to-Image (Pollinations AI)
      context.commands.register({
        name: 'text2img',
        aliases: ['buatgambar', 't2i'],
        description: 'Hasilkan gambar dari deskripsi teks',
        category: 'tools',
        menuOrder: 6,
        cooldownMs: 5_000,
        handler: async (commandContext) => {
          const prompt = commandContext.args.join(' ').trim()
          if (!prompt) {
            await commandContext.reply(`Format: ${commandContext.prefix}text2img <deskripsi gambar>\nContoh: ${commandContext.prefix}text2img a cute anime cat in space`)
            return
          }
          if (prompt.length > 300) {
            await commandContext.reply('Deskripsinya kepanjangan nih, maksimal 300 karakter ya~ ✍️')
            return
          }
          try {
            const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=512&height=512&nologo=true`
            const res = await fetch(url, { signal: AbortSignal.timeout(25_000) })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const buffer = new Uint8Array(await res.arrayBuffer())
            if (commandContext.whatsapp.sendMedia) {
              await commandContext.whatsapp.sendMedia(commandContext.message.remoteJid, {
                kind: 'image',
                data: buffer,
                mimeType: 'image/jpeg',
              })
            } else {
              await commandContext.reply(`Gambar hasil: ${url}`)
            }
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'text2img command failed')
            await commandContext.reply('Gagal bikin gambar nih, coba kata kunci lain ya~ 🎨')
          }
        },
      })

      // 7. Vision Description: img2text
      context.commands.register({
        name: 'img2text',
        aliases: ['deskripsigambar'],
        description: 'Deskripsikan isi gambar menggunakan AI',
        category: 'tools',
        hidden: true,
        menuOrder: 7,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = extractImageSource(commandContext)

          if (!selected) {
            await commandContext.reply(`Kirim gambar dengan caption ${commandContext.prefix}img2text [opsional: instruksi], atau balas gambar lalu ketik ${commandContext.prefix}img2text.`)
            return
          }

          if (!commandContext.whatsapp.downloadMedia) {
            await commandContext.reply('Waduh, belum bisa ambil gambarnya nih. Coba kirim ulang ya~ 📥')
            return
          }

          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: 10 * 1024 * 1024,
              timeoutMs: 25_000,
            })
            const base64 = Buffer.from(downloaded.data).toString('base64')
            const mime = downloaded.mimeType || 'image/jpeg'
            const dataUrl = `data:${mime};base64,${base64}`

            const prompt = commandContext.args.join(' ').trim() || undefined
            const result = await describeImageWithAi(dataUrl, prompt)
            await commandContext.reply(`🤖 *Analisis Gambar (AI Vision):*\n\n${result}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'img2text command failed')
            await commandContext.reply('Gambarnya kurang jelas nih, coba kirim foto yang lebih terang ya~ 🔍📷')
          }
        },
      })

      // 8. OCR: Extract text from image via Multimodal AI
      context.commands.register({
        name: 'ocr',
        description: 'Ekstrak teks dari gambar secara presisi menggunakan AI Vision',
        category: 'tools',
        hidden: true,
        menuOrder: 8,
        cooldownMs: AI_COMMAND_COOLDOWN_MS,
        handler: async (commandContext) => {
          const selected = extractImageSource(commandContext)

          if (!selected) {
            await commandContext.reply(`Balas gambar lalu ketik ${commandContext.prefix}ocr, atau kirim gambar dengan caption ${commandContext.prefix}ocr.`)
            return
          }

          if (!commandContext.whatsapp.downloadMedia) {
            await commandContext.reply('Waduh, belum bisa ambil gambarnya nih. Coba kirim ulang ya~ 📥')
            return
          }

          try {
            const downloaded = await commandContext.whatsapp.downloadMedia(commandContext.message, selected.source, {
              maxBytes: 10 * 1024 * 1024,
              timeoutMs: 25_000,
            })
            const base64 = Buffer.from(downloaded.data).toString('base64')
            const mime = downloaded.mimeType || 'image/jpeg'
            const dataUrl = `data:${mime};base64,${base64}`

            const result = await describeImageWithAi(
              dataUrl,
              'Ekstrak dan salin seluruh teks yang tertulis di dalam gambar ini secara presisi dan lengkap. Tuliskan ulang teksnya saja tanpa basa-basi atau analisis visual.',
              { maxTokens: 1_200 },
            )
            await commandContext.reply(`🔍 *Hasil Ekstraksi Teks (OCR):*\n\n${result}`)
          } catch (error) {
            commandContext.logger.warn({ errorName: error instanceof Error ? error.name : 'UnknownError' }, 'ocr command failed')
            await commandContext.reply('Gagal membaca tulisan di gambar nih, coba foto yang lebih terang dan jelas ya~ 📝📷')
          }
        },
      })
    },
  }
}

export const aiPlugin = createAiPlugin()
export default aiPlugin
