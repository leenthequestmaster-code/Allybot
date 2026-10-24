import { jidNormalizedUser } from '@whiskeysockets/baileys'
import type {
  CommandContext,
  CoreMessage,
  Plugin,
  WhatsAppPort,
  WhatsAppSendOptions,
} from '../contracts.js'
import {
  BOT_PROFILES,
  ChessService,
  TIME_CONTROLS,
  analyzeGameHistory,
  formatClockMs,
  getEloTier,
  isChessNotationOrBoardReply,
  isInCheck,
  parseTimeControlMode,
  toFen,
  type BotLevel,
  type ChessGameState,
  type EloCategory,
  type EloChangeResult,
  type GameReviewSummary,
  type TimeControlMode,
} from '../../services/chess-service.js'
import { GroupConfigurationService } from '../../services/group-configuration-service.js'
import { isGroupJid } from '../validation.js'
import { isSameJid } from '../../permissions.js'

export { isChessNotationOrBoardReply }

export function isChessMoveOrReply(text: string, quotedText?: string): boolean {
  return isChessNotationOrBoardReply(text, quotedText)
}

const HEADER_BORDER = '─꯭──꯭──    .  .  .    ▭▬▭▬▭'
const DIVIDER_BORDER = '━━━━━━━━━━━━━━━━━━━━'
const OPEN_CHALLENGE_TTL_MS = 5 * 60 * 1000

export interface OpenChallenge {
  readonly chatJid: string
  readonly hostJid: string
  readonly hostName: string
  readonly hostColor: 'w' | 'b'
  readonly mode: TimeControlMode
  readonly createdAt: number
}

const openChallenges = new Map<string, OpenChallenge>()

export function getOpenChallenge(chatJid: string): OpenChallenge | undefined {
  const chal = openChallenges.get(chatJid)
  if (!chal) return undefined
  if (Date.now() - chal.createdAt > OPEN_CHALLENGE_TTL_MS) {
    openChallenges.delete(chatJid)
    return undefined
  }
  return chal
}

export function clearOpenChallenges(): void {
  openChallenges.clear()
}

function userTag(jid: string): string {
  if (jid.startsWith('bot:stockfish:')) {
    const lv = Number(jid.split(':')[2]) as BotLevel
    return BOT_PROFILES[lv]?.name ?? 'Stockfish Bot'
  }
  const user = jid.split('@')[0]?.split(':')[0] ?? jid
  return `@${user}`
}

function displayNameFor(whatsapp: WhatsAppPort, jid: string, fallbackPushName?: string): string {
  if (jid.startsWith('bot:stockfish:')) {
    const lv = Number(jid.split(':')[2]) as BotLevel
    return BOT_PROFILES[lv]?.name ?? 'Stockfish Bot'
  }
  if (fallbackPushName?.trim()) return fallbackPushName.trim()
  const resolved = whatsapp.getDisplayName?.(jid)
  if (resolved?.trim()) return resolved.trim()
  const num = jid.split('@')[0]?.split(':')[0] ?? 'Pemain'
  return num
}

function mentionOpts(jids: readonly string[]): WhatsAppSendOptions | undefined {
  const valid = jids.filter((j) => Boolean(j) && !j.startsWith('bot:stockfish:'))
  const unique = [...new Set(valid.map((j) => jidNormalizedUser(j)))]
  return unique.length > 0 ? { mentions: unique } : undefined
}

function formatEloDelta(delta: number): string {
  return delta >= 0 ? `+${delta}` : `${delta}`
}

function parseColorArg(tokens: readonly string[]): 'w' | 'b' | undefined {
  for (const t of tokens) {
    const low = t.toLowerCase()
    if (low === 'putih' || low === 'white' || low === 'w') return 'w'
    if (low === 'hitam' || low === 'black' || low === 'b') return 'b'
  }
  return undefined
}

function parseModeArg(tokens: readonly string[], fallback: TimeControlMode = 'blitz'): TimeControlMode {
  for (const t of tokens) {
    const low = t.toLowerCase()
    if (
      low === 'bullet' ||
      low === '3m' ||
      low === 'blitz' ||
      low === '7m' ||
      low === 'rapid' ||
      low === '15m' ||
      low === 'casual' ||
      low === 'santai' ||
      low === 'untimed'
    ) {
      return parseTimeControlMode(low, fallback)
    }
  }
  return fallback
}

function parseBotLevelArg(tokens: readonly string[]): BotLevel {
  for (const t of tokens) {
    const n = Number(t.replace(/^lv/i, ''))
    if (n === 1 || n === 2 || n === 3 || n === 4) return n
  }
  return 2
}

export function formatMoveCaption(
  state: ChessGameState,
  lastSan?: string,
  eloResult?: EloChangeResult,
  prefix = '!',
): string {
  const tc = TIME_CONTROLS[state.timeControl]
  const lines: string[] = [HEADER_BORDER]

  if (state.gameOver) {
    lines.push(`  *${state.resultTitle ?? 'PERTANDINGAN SELESAI'}*`)
    lines.push(DIVIDER_BORDER)
    lines.push('')
    lines.push(`Hasil: ${state.resultReason ?? '-'}`)
    lines.push(`Mode: ${tc.icon} *${tc.label}*${state.isBotMatch ? ` (PvE Lv ${state.botLevel})` : ''}`)
    lines.push('')
    lines.push(`⬜ *Putih* : ${userTag(state.whiteJid)} (${state.whiteName})`)
    lines.push(`⬛ *Hitam* : ${userTag(state.blackJid)} (${state.blackName})`)

    if (eloResult) {
      lines.push('')
      if (eloResult.applied) {
        const catLabel = eloResult.category.toUpperCase()
        lines.push(`*PERUBAHAN RATING ${catLabel}*`)
        lines.push(
          `• Putih: *${eloResult.whiteBefore}* → *${eloResult.whiteAfter}* (${formatEloDelta(eloResult.whiteDelta)}, K=${eloResult.whiteK})`,
        )
        lines.push(
          `• Hitam: *${eloResult.blackBefore}* → *${eloResult.blackAfter}* (${formatEloDelta(eloResult.blackDelta)}, K=${eloResult.blackK})`,
        )
      } else if (eloResult.reason) {
        lines.push(`Info: _${eloResult.reason}_`)
      }
      if (eloResult.trophyUnlocked) {
        lines.push(`🏅 *TROFI BARU TERBUKA* : *Bot Slayer Lv ${eloResult.trophyUnlocked}*!`)
      }
    }

    lines.push('')
    lines.push(`Ketik *${prefix}review* untuk video analisis langkah (.mp4) *Blunder ↔ Brilliant*`)
    lines.push(`Ketik *${prefix}leaderboardchess ${state.eloCategory}* untuk klasemen ELO`)
    lines.push(DIVIDER_BORDER)
    return lines.join('\n')
  }

  const turnTag = state.turn === 'w' ? userTag(state.whiteJid) : userTag(state.blackJid)
  const turnLabel = state.turn === 'w' ? 'Putih ⬜' : 'Hitam ⬛'
  const inCheck = isInCheck(state.board, state.turn)

  lines.push(`  *CATUR ALLYBOT* • \`${state.matchId}\``)
  lines.push(DIVIDER_BORDER)
  lines.push(`Mode: ${tc.icon} *${tc.label}*${tc.bankMs > 0 ? ` (${Math.round(tc.bankMs / 60000)}m | Turn maks ${Math.round(tc.maxTurnMs / 1000)}s)` : ''}`)

  if (tc.bankMs > 0) {
    lines.push(
      `⏱️ Jam: ⬜ *${formatClockMs(state.whiteRemainingMs)}*  vs  ⬛ *${formatClockMs(state.blackRemainingMs)}*`,
    )
  }

  if (lastSan) {
    const prevColor = state.turn === 'w' ? 'Hitam' : 'Putih'
    const lastRec = state.moveHistory[state.moveHistory.length - 1]
    const bookBadge = lastRec?.openingName ? ` 📖 _${lastRec.openingEco}: ${lastRec.openingName}_` : ''
    lines.push(`Langkah Terakhir (${prevColor}): *${lastSan}*${bookBadge}`)
  }

  if (inCheck) {
    lines.push(`⚠️ *SKAK!* Raja ${turnLabel} sedang terancam!`)
  }

  lines.push(`Giliran Jalan: ${turnLabel} (${turnTag})`)
  lines.push('')
  lines.push(`_Ketik langsung notasi langkah (\`e4\`, \`Nf3\`, \`O-O\`) atau \`${prefix}catur <langkah>\`_`)
  lines.push(DIVIDER_BORDER)
  return lines.join('\n')
}

export function formatReviewSummaryCaption(summary: GameReviewSummary): string {
  const lines: string[] = [
    HEADER_BORDER,
    `  *GAME REVIEW CATUR (${summary.matchId})*`,
    DIVIDER_BORDER,
    '',
    `Hasil: *${summary.resultTitle}*`,
    `Info: _${summary.resultReason}_`,
  ]

  if (summary.openingName) {
    lines.push(`📖 Pembukaan: *${summary.openingEco ?? ''} ${summary.openingName}*`)
  }

  lines.push(
    '',
    `⬜ *${summary.whiteName}* (${summary.whiteElo} ELO) — Akurasi: *${summary.whiteAccuracy}%*`,
    `⬛ *${summary.blackName}* (${summary.blackElo} ELO) — Akurasi: *${summary.blackAccuracy}%*`,
    '',
    '*KLASIFIKASI LANGKAH (PUTIH | HITAM)*',
    `• !! Brilliant  : *${summary.counts.w.Brilliant}* | *${summary.counts.b.Brilliant}*`,
    `• ! Great Move  : *${summary.counts.w.Great}* | *${summary.counts.b.Great}*`,
    `• ★ Best Move   : *${summary.counts.w.Best}* | *${summary.counts.b.Best}*`,
    `• ✓ Good Move   : *${summary.counts.w.Good}* | *${summary.counts.b.Good}*`,
    `• 📖 Book Move   : *${summary.counts.w.Book}* | *${summary.counts.b.Book}*`,
    `• ?! Inaccuracy : *${summary.counts.w.Inaccuracy}* | *${summary.counts.b.Inaccuracy}*`,
    `• ? Mistake     : *${summary.counts.w.Mistake}* | *${summary.counts.b.Mistake}*`,
    `• ?? Blunder    : *${summary.counts.w.Blunder}* | *${summary.counts.b.Blunder}*`,
  )

  if (summary.turningPoint) {
    const tp = summary.turningPoint
    const side = tp.color === 'w' ? 'Putih' : 'Hitam'
    lines.push(
      '',
      `*MOMEN KUNCI (TURNING POINT)*`,
      `Langkah #${tp.moveNumber} (${side}: *${tp.san}*) terdeteksi *${tp.classification.toUpperCase()} (${tp.symbol})* (-${(tp.cpLoss / 100).toFixed(1)} poin). Rekomendasi mesin: *${tp.bestMoveSan}*.`,
    )
  }

  lines.push(DIVIDER_BORDER)
  return lines.join('\n')
}

export function formatPlayerProfileCaption(
  chess: ChessService,
  userJid: string,
  displayName: string,
): string {
  const profile = chess.getPlayerElo(userJid, displayName)
  const rank = chess.getPlayerRank(userJid)
  const weekly = chess.getWeeklyEloDeltas(userJid)
  const highestRating = Math.max(
    profile.blitz.elo,
    profile.rapid.elo,
    profile.bullet.elo,
    profile.puzzle.elo,
  )
  const tier = getEloTier(highestRating)

  const fmtDelta = (d: number) => `${d >= 0 ? '+' : ''}${d} this week ${d >= 0 ? '↑' : '↓'}`

  const trophyStr =
    profile.botTrophies.length > 0
      ? profile.botTrophies.map((lv) => `Bot Lv ${lv}`).join(', ')
      : 'Belum ada'

  return [
    HEADER_BORDER,
    '  *PROFIL CATUR ALLYBOT (ALLYCHESS)*',
    DIVIDER_BORDER,
    '',
    `Pemain: ${userTag(profile.userJid)} (${profile.displayName}) [${tier.title.toUpperCase()}]`,
    `Peringkat Global: *#${rank}* • Gelar: ${tier.icon} ${tier.title}`,
    `Statistik Total: *${profile.totalPlayed.toLocaleString('en-US')}* Main • *${profile.totalWins}* Menang • *${profile.totalDraws}* Seri • *${profile.totalLosses}* Kalah`,
    '',
    '*RATING KATEGORI*',
    `⚡ Bullet (3m) : *${profile.bullet.elo}* (Peak *${profile.bullet.peakElo}*) • ${fmtDelta(weekly.bullet)}`,
    `🔥 Blitz (7m)  : *${profile.blitz.elo}* (Peak *${profile.blitz.peakElo}*) • ${fmtDelta(weekly.blitz)}`,
    `☕ Rapid (15m) : *${profile.rapid.elo}* (Peak *${profile.rapid.peakElo}*) • ${fmtDelta(weekly.rapid)}`,
    `🧩 Puzzle      : *${profile.puzzle.elo}* (Peak *${profile.puzzle.peakElo}*) • ${fmtDelta(weekly.puzzle)}`,
    '',
    `Trofi: ${trophyStr}`,
    DIVIDER_BORDER,
  ].join('\n')
}

async function sendBoardImage(
  whatsapp: WhatsAppPort,
  chess: ChessService,
  state: ChessGameState,
  caption: string,
): Promise<void> {
  const pngBuffer = await chess.renderBoardPng(state, whatsapp)
  const mentions = mentionOpts([state.whiteJid, state.blackJid])
  if (whatsapp.sendMedia) {
    await whatsapp.sendMedia(state.chatJid, {
        kind: 'image',
        data: new Uint8Array(pngBuffer),
        mimeType: 'image/png',
        caption,
      })
  } else {
    await whatsapp.sendText(state.chatJid, caption, mentions)
  }
}

async function triggerBotTurnIfNeeded(
  whatsapp: WhatsAppPort,
  chess: ChessService,
  state: ChessGameState,
  prefix: string,
  botDelayMs = 450,
): Promise<void> {
  if (state.gameOver || !state.isBotMatch || !state.botColor) return
  if (state.turn !== state.botColor) return

  if (whatsapp.sendPresenceUpdate) {
    await whatsapp.sendPresenceUpdate(state.chatJid, 'composing').catch(() => undefined)
  }
  if (botDelayMs > 0) {
    await new Promise((r) => setTimeout(r, botDelayMs))
  }

  const botRes = await chess.executeBotReply(state.chatJid)
  if (!botRes || 'error' in botRes) return

  if (whatsapp.sendPresenceUpdate) {
    await whatsapp.sendPresenceUpdate(state.chatJid, 'paused').catch(() => undefined)
  }

  await sendBoardImage(
    whatsapp,
    chess,
    botRes.state,
    formatMoveCaption(botRes.state, botRes.record.san, botRes.eloResult, prefix),
  )
}

export function createChessPlugin(whatsapp: WhatsAppPort, options?: { botDelayMs?: number }): Plugin {
  const botDelayMs = options?.botDelayMs ?? 450

  return {
    name: 'chess',
    version: '2.0.0',
    dependencies: ['menu'],
    load(context) {
      const chess = context.services.get<ChessService>('chess')
      const groupConfig = context.services.has('group-configuration')
        ? context.services.get<GroupConfigurationService>('group-configuration')
        : undefined

      // Register background clock timeout / Move-1 AFK callback
      chess.setTimeoutCallback(async (chatJid, state, eloResult, abortedMove1) => {
        const prefix =
          isGroupJid(chatJid) && groupConfig
            ? groupConfig.resolvePrefix(chatJid, context.config.commandPrefix)
            : context.config.commandPrefix

        if (abortedMove1) {
          await whatsapp.sendText(
            chatJid,
            [
              HEADER_BORDER,
              '  *PERTANDINGAN DIBATALKAN (AFK)*',
              DIVIDER_BORDER,
              '',
              state.resultReason ?? 'Pemain tidak melangkah pada langkah pertama.',
              'Status: _Tidak ada penalti ELO._',
              DIVIDER_BORDER,
            ].join('\n'),
            mentionOpts([state.whiteJid, state.blackJid]),
          )
          return
        }

        await sendBoardImage(
          whatsapp,
          chess,
          state,
          formatMoveCaption(state, undefined, eloResult, prefix),
        )
      })

      const handleReviewRequest = async (ctx: CommandContext): Promise<void> => {
        const chatJid = ctx.message.remoteJid
        const wantsActive = ctx.args.some(
          (a) => a.toLowerCase() === '--now' || a.toLowerCase() === 'aktif',
        )
        const targetState = wantsActive
          ? chess.getActiveGame(chatJid) ?? chess.getLastFinishedGame(chatJid)
          : chess.getLastFinishedGame(chatJid) ?? chess.getActiveGame(chatJid)

        if (!targetState) {
          await ctx.reply(
            `Belum ada riwayat pertandingan catur yang selesai di obrolan ini untuk di-review.\nMulai main dengan *${ctx.prefix}catur @lawan*, *${ctx.prefix}catur open*, atau *${ctx.prefix}catur bot*!`,
          )
          return
        }

        if (targetState.moveHistory.length === 0) {
          await ctx.reply('Pertandingan belum memiliki langkah untuk dianalisis.')
          return
        }

        await ctx.react('🎬')
        await ctx.reply(
          `⏳ Menganalisis *${targetState.moveHistory.length} langkah* (Stockfish 16 NNUE + 80 FIDE ECO Book) dan merender video MP4 *Game Review*...`,
        )

        try {
          const { mp4Buffer, summary } = await chess.renderReviewVideoMp4(targetState)
          const caption = formatReviewSummaryCaption(summary)
          if (ctx.whatsapp.sendMedia) {
            await ctx.whatsapp.sendMedia(chatJid, {
              kind: 'video',
              data: new Uint8Array(mp4Buffer),
              mimeType: 'video/mp4',
              caption,
            })
          } else {
            await ctx.reply(caption)
          }
          await ctx.react('✅')
        } catch (error) {
          ctx.logger.warn(
            { errorName: error instanceof Error ? error.name : 'UnknownError' },
            'chess review video generation failed',
          )
          const wProfile = chess.getPlayerElo(
            targetState.whiteJid,
            targetState.whiteName,
            targetState.eloCategory,
          )
          const bProfile = chess.getPlayerElo(
            targetState.blackJid,
            targetState.blackName,
            targetState.eloCategory,
          )
          const fallbackSummary = await analyzeGameHistory(
            targetState,
            wProfile.elo,
            bProfile.elo,
          )
          await ctx.reply(formatReviewSummaryCaption(fallbackSummary))
        }
      }

      // 1. Main !catur / !chess command
      context.commands.register({
        name: 'catur',
        aliases: ['chess'],
        description:
          'Main catur FIDE P2P & PvE Stockfish dengan Chess Clock, Multi-ELO Base 400 & Game Review MP4',
        category: 'fun',
        menuOrder: 3,
        cooldownMs: 1200,
        handler: async (ctx) => {
          const chatJid = ctx.message.remoteJid
          const senderJid = ctx.message.senderJid
            ? jidNormalizedUser(ctx.message.senderJid)
            : undefined
          if (!senderJid) return

          const senderName = displayNameFor(whatsapp, senderJid, ctx.message.pushName)
          const sub = ctx.args[0]?.toLowerCase() ?? ''

          if (!sub) {
            const active = chess.getActiveGame(chatJid)
            if (active) {
              await ctx.react('♟️')
              await sendBoardImage(
                whatsapp,
                chess,
                active,
                formatMoveCaption(active, undefined, undefined, ctx.prefix),
              )
              return
            }

            await ctx.reply(
              [
                HEADER_BORDER,
                '  *CATUR FIDE ALLYBOT v2.0*',
                DIVIDER_BORDER,
                '',
                '*Mode Tantangan PvP & PvE:*',
                `• \`${ctx.prefix}catur @lawan [blitz|rapid|bullet|casual]\` — Tantang teman`,
                `• \`${ctx.prefix}catur open [blitz|rapid|bullet] [putih|hitam]\` — Buka meja (TTL 5m)`,
                `• \`${ctx.prefix}catur join\` — Terima tantangan terbuka`,
                `• \`${ctx.prefix}catur cancel\` — Batalkan tantangan terbuka`,
                `• \`${ctx.prefix}catur bot [1|2|3|4] [putih|hitam]\` — Lawan AI Stockfish (Lv 1-4)`,
                `• \`${ctx.prefix}catur solo\` — Mode latihan mandiri`,
                '',
                '*Kontrol Waktu (WhatsApp Chess Clock):*',
                '• ⚡ `bullet` : 3 menit bank | maks 90 detik/giliran',
                '• 🔥 `blitz`  : 7 menit bank | maks 3 menit/giliran (Default)',
                '• ☕ `rapid`  : 15 menit bank | maks 5 menit/giliran',
                '• 🛋️ `casual` : Tanpa jam & unrated',
                '',
                '*Kontrol Saat Pertandingan:*',
                `• Ketik langsung langkah di chat (\`e4\`, \`Nf3\`, \`O-O\`) atau \`${ctx.prefix}catur <langkah>\``,
                `• \`${ctx.prefix}catur board\` | \`flip\` | \`pure\` | \`pgn\` | \`fen\``,
                `• \`${ctx.prefix}catur remis\` — Tawarkan / terima seri`,
                `• \`${ctx.prefix}catur menyerah\` — Menyerah (Resign)`,
                '',
                '*Analisis & Klasemen Multi-ELO (Base 400):*',
                `• \`${ctx.prefix}review\` — Video MP4 Analisis (Stockfish 16 + 80 ECO Book)`,
                `• \`${ctx.prefix}elochess [@user]\` — Kartu profil Multi-ELO & Trofi Bot`,
                `• \`${ctx.prefix}leaderboardchess [blitz|rapid|bullet]\` — Klasemen Top 10`,
                DIVIDER_BORDER,
              ].join('\n'),
            )
            return
          }

          if (sub === 'review' || sub === 'analisis') {
            await handleReviewRequest(ctx)
            return
          }

          if (sub === 'elo' || sub === 'profile' || sub === 'profil' || sub === 'stats') {
            const targetRaw =
              ctx.message.mentionedJids?.[0] || ctx.message.quotedSenderJid || senderJid
            const targetJid = jidNormalizedUser(targetRaw)
            const fallbackName = targetJid === senderJid ? ctx.message.pushName : undefined
            const dispName = displayNameFor(whatsapp, targetJid, fallbackName)
            await ctx.react('📊')
            const cardPng = await chess.renderProfileCardPng(targetJid, dispName, whatsapp)
            const caption = formatPlayerProfileCaption(chess, targetJid, dispName)
            const mentions = mentionOpts([targetJid])
            if (ctx.whatsapp.sendMedia) {
              await ctx.whatsapp.sendMedia(chatJid, {
                kind: 'image',
                data: new Uint8Array(cardPng),
                mimeType: 'image/png',
                caption,
              })
            } else {
              await ctx.reply(caption, mentions)
            }
            return
          }

          if (sub === 'puzzle' || sub === 'teka-teki' || sub === 'taktik') {
            const answerArg = ctx.args.slice(1).join('').trim()
            if (!answerArg) {
              const session = chess.startPuzzle(chatJid, senderJid, senderName)
              const caption = [
                HEADER_BORDER,
                `  *TEKA-TEKI TAKTIS ALLYCHESS (${session.puzzle.id})*`,
                DIVIDER_BORDER,
                '',
                `🧩 Judul  : *${session.puzzle.title}*`,
                `🎯 Tema   : *${session.puzzle.theme}*`,
                `⭐ Rating : *${session.puzzle.rating} ELO*`,
                `💡 Petunjuk: _${session.puzzle.hint}_`,
                '',
                `Ketik *${ctx.prefix}catur puzzle <langkah>* (contoh: \`${ctx.prefix}catur puzzle Re8#\`) untuk menjawab dan meningkatkan *Puzzle ELO* di kartu \`!elochess\`!`,
                DIVIDER_BORDER,
              ].join('\n')
              await ctx.reply(caption)
              return
            }

            const res = chess.solvePuzzle(chatJid, senderJid, senderName, answerArg)
            if ('error' in res) {
              await ctx.reply(`❌ ${res.error}`)
              return
            }
            const sign = res.delta >= 0 ? '+' : ''
            const statusHeader = res.solved
              ? '✅ *JAWABAN BENAR! TEKA-TEKI TERPECAHKAN*'
              : `❌ *JAWABAN KURANG TEPAT* (Solusi: *${res.puzzle.solutionSan}*)`
            await ctx.reply(
              [
                HEADER_BORDER,
                `  ${statusHeader}`,
                DIVIDER_BORDER,
                '',
                `🧩 Puzzle : *${res.puzzle.title}* (${res.puzzle.rating} ELO)`,
                `📈 Puzzle ELO : *${res.before} → ${res.after}* (*${sign}${res.delta}* minggu ini)`,
                `Cek kartu profil terbarumu dengan *${ctx.prefix}elochess*!`,
                DIVIDER_BORDER,
              ].join('\n'),
            )
            return
          }

          // Subcommand: cancel open challenge or early game
          if (sub === 'cancel' || sub === 'batal' || sub === 'stop' || sub === 'abort') {
            const chal = getOpenChallenge(chatJid)
            if (chal) {
              if (!isSameJid(chal.hostJid, senderJid)) {
                await ctx.reply('Hanya pembuat tantangan yang dapat membatalkan tantangan terbuka ini.')
                return
              }
              openChallenges.delete(chatJid)
              await ctx.reply('🛑 Tantangan catur terbuka berhasil dibatalkan.')
              return
            }

            const active = chess.getActiveGame(chatJid)
            if (!active) {
              await ctx.reply('Tidak ada tantangan terbuka atau pertandingan aktif untuk dibatalkan.')
              return
            }
            if (senderJid !== active.whiteJid && senderJid !== active.blackJid) {
              await ctx.reply('Hanya pemain yang sedang bertanding yang bisa membatalkan sesi ini.')
              return
            }
            if (active.moveHistory.length >= 4 && !active.isBotMatch) {
              await ctx.reply(
                `Pertandingan sudah berjalan lebih dari 4 langkah. Gunakan *${ctx.prefix}catur menyerah* atau *${ctx.prefix}catur remis*.`,
              )
              return
            }
            chess.abortGame(chatJid)
            await ctx.reply('🛑 Pertandingan catur dibatalkan tanpa perubahan ELO.')
            return
          }

          // Subcommand: open challenge
          if (sub === 'open' || sub === 'buat') {
            if (chess.getActiveGame(chatJid)) {
              await ctx.reply('Masih ada pertandingan catur yang sedang berlangsung di obrolan ini!')
              return
            }
            const restArgs = ctx.args.slice(1)
            const hostColor = parseColorArg(restArgs) ?? 'w'
            const mode = parseModeArg(restArgs, 'blitz')
            const tc = TIME_CONTROLS[mode]
            const category: EloCategory = mode === 'casual' ? 'blitz' : mode

            openChallenges.set(chatJid, {
              chatJid,
              hostJid: senderJid,
              hostName: senderName,
              hostColor,
              mode,
              createdAt: Date.now(),
            })
            const eloProfile = chess.getPlayerElo(senderJid, senderName, category)
            const tier = getEloTier(eloProfile.elo)

            await ctx.reply(
              [
                HEADER_BORDER,
                '  *TANTANGAN CATUR TERBUKA*',
                DIVIDER_BORDER,
                '',
                `Penantang: ${userTag(senderJid)} (${eloProfile.elo} ELO • ${tier.icon} ${tier.title})`,
                `Mode Waktu: ${tc.icon} *${tc.label}*${tc.bankMs > 0 ? ` (${Math.round(tc.bankMs / 60000)}m bank / ${Math.round(tc.maxTurnMs / 1000)}s turn)` : ' (Unrated)'}`,
                `Warna Host: ${hostColor === 'w' ? 'Putih ⬜' : 'Hitam ⬛'}`,
                `Kedaluwarsa: 5 menit`,
                '',
                `Ketik *${ctx.prefix}catur join* untuk menerima tantangan!`,
                DIVIDER_BORDER,
              ].join('\n'),
              mentionOpts([senderJid]),
            )
            return
          }

          // Subcommand: join open challenge
          if (sub === 'join' || sub === 'gabung' || sub === 'terima') {
            if (chess.getActiveGame(chatJid)) {
              await ctx.reply('Pertandingan sudah dimulai di obrolan ini!')
              return
            }
            const chal = getOpenChallenge(chatJid)
            if (!chal) {
              await ctx.reply(
                `Tidak ada tantangan terbuka yang aktif (atau sudah kedaluwarsa 5 menit). Ketik *${ctx.prefix}catur open* atau *${ctx.prefix}catur @lawan*.`,
              )
              return
            }
            if (isSameJid(chal.hostJid, senderJid)) {
              await ctx.reply(
                `Kamu tidak bisa menerima tantanganmu sendiri! Tunggu pemain lain mengetik *${ctx.prefix}catur join* atau gunakan *${ctx.prefix}catur bot* untuk melawan AI.`,
              )
              return
            }

            openChallenges.delete(chatJid)
            const whiteJid = chal.hostColor === 'w' ? chal.hostJid : senderJid
            const whiteName = chal.hostColor === 'w' ? chal.hostName : senderName
            const blackJid = chal.hostColor === 'w' ? senderJid : chal.hostJid
            const blackName = chal.hostColor === 'w' ? senderName : chal.hostName

            const created = chess.createGame({
              chatJid,
              whiteJid,
              whiteName,
              blackJid,
              blackName,
              timeControl: chal.mode,
            })
            if ('error' in created) {
              await ctx.reply(`❌ ${created.error}`)
              return
            }
            await ctx.react('♟️')
            await sendBoardImage(
              whatsapp,
              chess,
              created,
              formatMoveCaption(created, undefined, undefined, ctx.prefix),
            )
            return
          }

          // Subcommand: PvE Stockfish Bot (!catur bot [1|2|3|4] [putih|hitam] [blitz|rapid|bullet|casual])
          if (sub === 'bot' || sub === 'ai' || sub === 'stockfish' || sub === 'pve') {
            if (chess.getActiveGame(chatJid)) {
              await ctx.reply('Masih ada pertandingan aktif di obrolan ini.')
              return
            }
            const restArgs = ctx.args.slice(1)
            const botLevel = parseBotLevelArg(restArgs)
            const humanColor = parseColorArg(restArgs) ?? 'w'
            const mode = parseModeArg(restArgs, 'casual')
            const botProfile = BOT_PROFILES[botLevel]
            const botJid = `bot:stockfish:${botLevel}`

            const whiteJid = humanColor === 'w' ? senderJid : botJid
            const whiteName = humanColor === 'w' ? senderName : botProfile.name
            const blackJid = humanColor === 'w' ? botJid : senderJid
            const blackName = humanColor === 'w' ? botProfile.name : senderName

            const created = chess.createGame({
              chatJid,
              whiteJid,
              whiteName,
              blackJid,
              blackName,
              timeControl: mode,
              botLevel,
              botColor: humanColor === 'w' ? 'b' : 'w',
              orientation: humanColor,
            })
            if ('error' in created) {
              await ctx.reply(`❌ ${created.error}`)
              return
            }
            await ctx.react('🤖')
            await sendBoardImage(
              whatsapp,
              chess,
              created,
              formatMoveCaption(created, undefined, undefined, ctx.prefix),
            )
            // If bot plays White, trigger bot's first move immediately
            await triggerBotTurnIfNeeded(whatsapp, chess, created, ctx.prefix, botDelayMs)
            return
          }

          // Subcommand: solo / practice mode
          if (sub === 'solo' || sub === 'latihan') {
            if (chess.getActiveGame(chatJid)) {
              await ctx.reply('Masih ada pertandingan aktif di obrolan ini.')
              return
            }
            const created = chess.createGame({
              chatJid,
              whiteJid: senderJid,
              whiteName: senderName,
              blackJid: senderJid,
              blackName: `${senderName} (Hitam)`,
              timeControl: 'casual',
            })
            if ('error' in created) {
              await ctx.reply(`❌ ${created.error}`)
              return
            }
            await ctx.react('♟️')
            await sendBoardImage(
              whatsapp,
              chess,
              created,
              formatMoveCaption(created, undefined, undefined, ctx.prefix),
            )
            return
          }

          // Subcommand: direct @mention challenge
          const mentionedJid = ctx.message.mentionedJids?.[0] || ctx.message.quotedSenderJid
          if (
            sub === 'start' ||
            sub === 'mulai' ||
            sub === 'vs' ||
            (sub.startsWith('@') && mentionedJid)
          ) {
            if (chess.getActiveGame(chatJid)) {
              await ctx.reply('Masih ada pertandingan catur yang sedang aktif di obrolan ini.')
              return
            }
            if (!mentionedJid) {
              await ctx.reply(
                `Tag lawan yang ingin kamu tantang! Contoh: *${ctx.prefix}catur @lawan blitz* atau ketik *${ctx.prefix}catur open*.`,
              )
              return
            }
            const opponentJid = jidNormalizedUser(mentionedJid)
            const opponentName = displayNameFor(whatsapp, opponentJid)
            const restArgs = ctx.args.slice(1)
            const mode = parseModeArg(restArgs, 'blitz')
            const hostColor = parseColorArg(restArgs) ?? 'w'

            const whiteJid = hostColor === 'w' ? senderJid : opponentJid
            const whiteName = hostColor === 'w' ? senderName : opponentName
            const blackJid = hostColor === 'w' ? opponentJid : senderJid
            const blackName = hostColor === 'w' ? opponentName : senderName

            const created = chess.createGame({
              chatJid,
              whiteJid,
              whiteName,
              blackJid,
              blackName,
              timeControl: mode,
            })
            if ('error' in created) {
              await ctx.reply(`❌ ${created.error}`)
              return
            }
            await ctx.react('♟️')
            await sendBoardImage(
              whatsapp,
              chess,
              created,
              formatMoveCaption(created, undefined, undefined, ctx.prefix),
            )
            return
          }

          // Active game subcommands
          const active = chess.getActiveGame(chatJid)

          if (sub === 'pgn') {
            const target = active ?? chess.getLastFinishedGame(chatJid)
            if (!target) {
              await ctx.reply('Belum ada data PGN pertandingan di obrolan ini.')
              return
            }
            await ctx.reply(
              `${HEADER_BORDER}\n  *PGN PERTANDINGAN (${target.matchId})*\n${DIVIDER_BORDER}\n\n\`\`\`${chess.toPgn(target)}\`\`\``,
            )
            return
          }

          if (!active) {
            await ctx.reply(
              `Belum ada pertandingan catur yang aktif. Mulai dengan *${ctx.prefix}catur @lawan*, *${ctx.prefix}catur open*, atau *${ctx.prefix}catur bot*!`,
            )
            return
          }

          if (sub === 'board' || sub === 'papan') {
            await sendBoardImage(
              whatsapp,
              chess,
              active,
              formatMoveCaption(active, undefined, undefined, ctx.prefix),
            )
            return
          }

          if (sub === 'pure' || sub === 'murni') {
            active.pureMode = !active.pureMode
            await sendBoardImage(
              whatsapp,
              chess,
              active,
              `🖼️ Mode Papan Murni 1:1: *${active.pureMode ? 'AKTIF' : 'NONAKTIF'}*\n\n${formatMoveCaption(active, undefined, undefined, ctx.prefix)}`,
            )
            return
          }

          if (sub === 'flip' || sub === 'putar') {
            active.orientation = active.orientation === 'w' ? 'b' : 'w'
            await sendBoardImage(
              whatsapp,
              chess,
              active,
              formatMoveCaption(active, undefined, undefined, ctx.prefix),
            )
            return
          }

          if (sub === 'fen') {
            const customFen = ctx.args.slice(1).join(' ').trim()
            if (!customFen) {
              const currentFen = toFen(
                active.board,
                active.turn,
                active.castling,
                active.epTarget,
                active.halfMoveClock,
                active.fullMoveNumber,
              )
              await ctx.reply(`📌 *FEN Saat Ini:*\n\`${currentFen}\``)
              return
            }
            if (senderJid !== active.whiteJid && senderJid !== active.blackJid) {
              await ctx.reply('Hanya pemain dalam pertandingan ini yang dapat memuat posisi FEN.')
              return
            }
            const reloaded = chess.createGame({
              chatJid,
              whiteJid: active.whiteJid,
              whiteName: active.whiteName,
              blackJid: active.blackJid,
              blackName: active.blackName,
              fen: customFen,
              timeControl: active.timeControl,
              botLevel: active.botLevel,
              botColor: active.botColor,
            })
            if ('error' in reloaded) {
              await ctx.reply(`❌ FEN Tidak Valid: ${reloaded.error}`)
              return
            }
            await sendBoardImage(
              whatsapp,
              chess,
              reloaded,
              formatMoveCaption(reloaded, undefined, undefined, ctx.prefix),
            )
            return
          }

          if (sub === 'menyerah' || sub === 'resign' || sub === 'nyerah') {
            if (senderJid !== active.whiteJid && senderJid !== active.blackJid) {
              await ctx.reply('Hanya pemain dalam pertandingan ini yang bisa menyerah.')
              return
            }
            const resignColor =
              active.whiteJid === active.blackJid
                ? active.turn
                : senderJid === active.whiteJid
                  ? 'w'
                  : 'b'
            const res = chess.resignGame(chatJid, resignColor)
            if (res) {
              await sendBoardImage(
                whatsapp,
                chess,
                res.state,
                formatMoveCaption(res.state, undefined, res.eloResult, ctx.prefix),
              )
            }
            return
          }

          if (sub === 'remis' || sub === 'draw' || sub === 'seri') {
            if (senderJid !== active.whiteJid && senderJid !== active.blackJid) {
              await ctx.reply(
                'Hanya pemain dalam pertandingan ini yang dapat menawarkan atau menerima remis.',
              )
              return
            }
            if (active.isBotMatch) {
              await ctx.reply('Bot Stockfish tidak menerima tawaran remis manual. Mainkan hingga tuntas!')
              return
            }
            const callerColor =
              active.whiteJid === active.blackJid
                ? active.turn
                : senderJid === active.whiteJid
                  ? 'w'
                  : 'b'

            if (
              active.whiteJid === active.blackJid ||
              (active.drawOfferedBy && active.drawOfferedBy !== callerColor)
            ) {
              const res = chess.agreeDraw(chatJid)
              if (res) {
                await sendBoardImage(
                  whatsapp,
                  chess,
                  res.state,
                  formatMoveCaption(res.state, undefined, res.eloResult, ctx.prefix),
                )
              }
              return
            }

            active.drawOfferedBy = callerColor
            const otherJid = callerColor === 'w' ? active.blackJid : active.whiteJid
            await ctx.reply(
              `🤝 ${userTag(senderJid)} menawarkan *REMIS (Seri)* kepada ${userTag(otherJid)}.\nKetik *${ctx.prefix}catur remis* untuk menerima tawaran seri, atau lanjutkan melangkah untuk menolak.`,
              mentionOpts([senderJid, otherJid]),
            )
            return
          }

          // Treat args as move notation
          const expectedJid = active.turn === 'w' ? active.whiteJid : active.blackJid
          if (senderJid !== expectedJid) {
            await ctx.reply(
              `⏳ Sekarang adalah giliran *${active.turn === 'w' ? 'Putih ⬜' : 'Hitam ⬛'}* (${userTag(expectedJid)}) untuk melangkah!`,
              mentionOpts([expectedJid]),
            )
            return
          }

          const moveStr = ctx.args.join(' ').trim()
          const result = chess.executeMove(chatJid, moveStr)
          if ('error' in result) {
            await ctx.reply(`❌ ${result.error}`)
            return
          }

          await sendBoardImage(
            whatsapp,
            chess,
            result.state,
            formatMoveCaption(
              result.state,
              result.record?.san,
              result.eloResult,
              ctx.prefix,
            ),
          )

          if (!result.state.gameOver && result.state.isBotMatch) {
            await triggerBotTurnIfNeeded(whatsapp, chess, result.state, ctx.prefix, botDelayMs)
          }
        },
      })

      // 2. Standalone !review command
      context.commands.register({
        name: 'review',
        aliases: ['chessreview', 'analisiscatur'],
        description:
          'Analisis pertandingan catur selesai menjadi video MP4 lengkap evaluasi Stockfish 16 & 80 ECO Book',
        category: 'fun',
        menuOrder: 4,
        cooldownMs: 5000,
        handler: handleReviewRequest,
      })

      // 3. Standalone !leaderboardchess [blitz|rapid|bullet] command
      context.commands.register({
        name: 'leaderboardchess',
        aliases: ['lbchess', 'topchess', 'rankcatur'],
        description: 'Tampilkan klasemen Top 10 pemain catur per kategori (Blitz / Rapid / Bullet)',
        category: 'fun',
        menuOrder: 5,
        cooldownMs: 3000,
        handler: async (ctx) => {
          await ctx.react('🏆')
          const rawCat = ctx.args[0]?.toLowerCase() ?? 'blitz'
          const category: EloCategory =
            rawCat === 'rapid' || rawCat === '15m'
              ? 'rapid'
              : rawCat === 'bullet' || rawCat === '3m'
                ? 'bullet'
                : 'blitz'

          const topList = chess.getLeaderboard(10, category)
          const cardPng = await chess.renderLeaderboardCardPng(topList, category, whatsapp)
          const tc = TIME_CONTROLS[category]

          const medals = ['🥇', '🥈', '🥉']
          const lines: string[] = [
            HEADER_BORDER,
            `  *KLASEMEN TOP 10 ${tc.label.toUpperCase()} CATUR*`,
            DIVIDER_BORDER,
            '',
          ]

          if (topList.length === 0) {
            lines.push('_Belum ada pemain yang menyelesaikan pertandingan berperingkat._')
          } else {
            for (let i = 0; i < topList.length; i++) {
              const p = topList[i]
              const tier = getEloTier(p.elo)
              const wr = p.gamesPlayed > 0 ? Math.round((p.wins / p.gamesPlayed) * 100) : 0
              lines.push(
                `${medals[i] ?? `#${i + 1}`} ${userTag(p.userJid)} — *${p.elo} ELO* (${tier.icon} ${tier.title}) • ${p.wins}W/${p.losses}L/${p.draws}D (${wr}%)`,
              )
            }
          }
          lines.push(DIVIDER_BORDER)

          const caption = lines.join('\n')
          const mentions = mentionOpts(topList.map((x) => x.userJid))
          if (ctx.whatsapp.sendMedia) {
            await ctx.whatsapp.sendMedia(ctx.message.remoteJid, {
                kind: 'image',
                data: new Uint8Array(cardPng),
                mimeType: 'image/png',
                caption,
              })
          } else {
            await ctx.reply(caption, mentions)
          }
        },
      })

      // 4. Standalone !elochess [@user] command (Visual 1000x667 AllyChess Profile Card + Official Caption)
      context.commands.register({
        name: 'elochess',
        aliases: ['chesselo', 'chessprofile', 'statscatur'],
        description: 'Cek kartu visual Multi-ELO (Bullet, Blitz, Rapid, Puzzle), #Ranking, dan trofi Bot Slayer',
        category: 'fun',
        menuOrder: 6,
        cooldownMs: 2000,
        handler: async (ctx) => {
          const targetRaw =
            ctx.message.mentionedJids?.[0] || ctx.message.quotedSenderJid || ctx.message.senderJid
          if (!targetRaw) return
          const targetJid = jidNormalizedUser(targetRaw)
          const fallbackName =
            targetJid === (ctx.message.senderJid ? jidNormalizedUser(ctx.message.senderJid) : '')
              ? ctx.message.pushName
              : undefined
          const displayName = displayNameFor(whatsapp, targetJid, fallbackName)
          await ctx.react('📊')
          const cardPng = await chess.renderProfileCardPng(targetJid, displayName, whatsapp)
          const caption = formatPlayerProfileCaption(chess, targetJid, displayName)
          const mentions = mentionOpts([targetJid])
          if (ctx.whatsapp.sendMedia) {
            await ctx.whatsapp.sendMedia(ctx.message.remoteJid, {
                kind: 'image',
                data: new Uint8Array(cardPng),
                mimeType: 'image/png',
                caption,
              })
          } else {
            await ctx.reply(caption, mentions)
          }
        },
      })

      // 5. Seamless Direct-Move Listener for Active Players in Room
      context.events.on('message.received', async (message: CoreMessage) => {
        if (message.fromMe || !message.senderJid || !message.text) return
        const active = chess.getActiveGame(message.remoteJid)
        if (!active || active.gameOver) return

        const rawText = message.text.trim()
        const prefix =
          isGroupJid(message.remoteJid) && groupConfig
            ? groupConfig.resolvePrefix(message.remoteJid, context.config.commandPrefix)
            : context.config.commandPrefix

        if (rawText.startsWith(prefix) || rawText.startsWith(context.config.commandPrefix)) return

        const senderJid = jidNormalizedUser(message.senderJid)
        const expectedJid = active.turn === 'w' ? active.whiteJid : active.blackJid
        if (senderJid !== expectedJid) return

        const looksLikeChessMove =
          /^(O-O(-O)?|0-0(-0)?|[KQRBNPkqrbnp]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBNqrbn])?[+#!?]*|[a-h][1-8][\s\-:x]*[a-h][1-8][qrbnQRBN]?|(?:pion|kuda|gajah|menteri|ratu|benteng|raja)\s+[a-h1-8\s\-x]+)$/i.test(
            rawText,
          )
        if (!looksLikeChessMove) return

        const result = chess.executeMove(message.remoteJid, rawText)
        if ('error' in result) {
          if (message.quotedMessageId || /^[a-h][1-8][\s\-]*[a-h][1-8]$/i.test(rawText)) {
            await whatsapp.sendText(message.remoteJid, `❌ ${result.error}`)
          }
          return
        }

        await sendBoardImage(
          whatsapp,
          chess,
          result.state,
          formatMoveCaption(result.state, result.record?.san, result.eloResult, prefix),
        )

        if (!result.state.gameOver && result.state.isBotMatch) {
          await triggerBotTurnIfNeeded(whatsapp, chess, result.state, prefix, botDelayMs)
        }
      })
    },
  }
}
