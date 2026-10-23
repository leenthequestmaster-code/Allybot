import { jidNormalizedUser } from '@whiskeysockets/baileys'
import type {
  CommandContext,
  CoreMessage,
  Plugin,
  WhatsAppPort,
  WhatsAppSendOptions,
} from '../contracts.js'
import {
  ChessService,
  getEloTier,
  isInCheck,
  toFen,
  type ChessGameState,
  type EloChangeResult,
  type GameReviewSummary,
} from '../../services/chess-service.js'
import { GroupConfigurationService } from '../../services/group-configuration-service.js'
import { isGroupJid } from '../validation.js'
import { isSameJid } from '../../permissions.js'

interface OpenChallenge {
  readonly chatJid: string
  readonly hostJid: string
  readonly hostName: string
  readonly hostColor: 'w' | 'b'
  readonly createdAt: number
  readonly expiresAt: number
  readonly timer?: NodeJS.Timeout
}

const OPEN_CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const openChallenges = new Map<string, OpenChallenge>()
const avatarCache = new Map<string, { buf?: Buffer; expiresAt: number }>()

async function resolveAvatar(whatsapp: WhatsAppPort, jid?: string): Promise<Buffer | undefined> {
  if (!jid || !whatsapp.getProfilePictureUrl) return undefined
  const normJid = jidNormalizedUser(jid)
  const cached = avatarCache.get(normJid)
  if (cached && cached.expiresAt > Date.now()) return cached.buf

  try {
    const url = await whatsapp.getProfilePictureUrl(normJid, 'preview', 3000)
    if (!url) {
      avatarCache.set(normJid, { buf: undefined, expiresAt: Date.now() + 5 * 60 * 1000 })
      return undefined
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) {
      avatarCache.set(normJid, { buf: undefined, expiresAt: Date.now() + 5 * 60 * 1000 })
      return undefined
    }
    const arr = await res.arrayBuffer()
    const buf = Buffer.from(arr)
    avatarCache.set(normJid, { buf, expiresAt: Date.now() + 15 * 60 * 1000 })
    return buf
  } catch {
    avatarCache.set(normJid, { buf: undefined, expiresAt: Date.now() + 5 * 60 * 1000 })
    return undefined
  }
}

function userTag(jid: string): string {
  const user = jid.split('@')[0]?.split(':')[0] ?? jid
  return `@${user}`
}

function displayNameFor(whatsapp: WhatsAppPort, jid: string, fallbackPushName?: string): string {
  if (fallbackPushName?.trim()) return fallbackPushName.trim()
  const resolved = whatsapp.getDisplayName?.(jid)
  if (resolved?.trim()) return resolved.trim()
  const num = jid.split('@')[0]?.split(':')[0] ?? 'Pemain'
  return num
}

function mentionOpts(jids: readonly string[]): WhatsAppSendOptions | undefined {
  const unique = [...new Set(jids.filter(Boolean).map((j) => jidNormalizedUser(j)))]
  return unique.length > 0 ? { mentions: unique } : undefined
}

async function canCancelChallenge(ctx: CommandContext, hostJid: string): Promise<boolean> {
  const senderJid = ctx.message.senderJid
  if (!senderJid) return false
  if (isSameJid(senderJid, hostJid)) return true
  if (isSameJid(senderJid, ctx.config.botOwnerJid)) return true
  const remoteJid = ctx.message.remoteJid
  if (!isGroupJid(remoteJid) || !ctx.whatsapp.getGroupMetadata) return false
  try {
    const metadata = await ctx.whatsapp.getGroupMetadata(remoteJid)
    if (!metadata?.participants) return false
    const bareSender = senderJid.split("@")[0]?.split(":")[0]
    const p = metadata.participants.find((x) => x.jid.split("@")[0]?.split(":")[0] === bareSender)
    return p?.role === "admin" || p?.role === "superadmin"
  } catch {
    return false
  }
}

function formatEloDelta(delta: number): string {
  return delta >= 0 ? `+${delta}` : `${delta}`
}

function formatMoveCaption(
  state: ChessGameState,
  lastSan?: string,
  eloResult?: EloChangeResult,
  prefix = '!',
): string {
  const lines: string[] = []

  if (state.gameOver) {
    lines.push('*CATUR // PERTANDINGAN SELESAI*')
    lines.push('─꯭──꯭──    .  .  .    ▭▬▭▬▭')
    lines.push(`• Hasil : *${state.resultTitle}* (${state.resultReason})`)
    lines.push(`• Putih : ${userTag(state.whiteJid)} (${state.whiteName})`)
    lines.push(`• Hitam : ${userTag(state.blackJid)} (${state.blackName})`)
    if (eloResult) {
      if (eloResult.applied) {
        lines.push('')
        lines.push('*Perubahan Rating ELO:*')
        lines.push(`• Putih : *${eloResult.whiteBefore}* → *${eloResult.whiteAfter}* (${formatEloDelta(eloResult.whiteDelta)})`)
        lines.push(`• Hitam : *${eloResult.blackBefore}* → *${eloResult.blackAfter}* (${formatEloDelta(eloResult.blackDelta)})`)
      } else if (eloResult.reason) {
        lines.push(`• Rating: _${eloResult.reason}_`)
      }
    }
    lines.push('━━━━━━━━━━━━━━━━━━━━')
    lines.push(`_Ketik \`${prefix}review\` untuk analisis langkah (.mp4) atau \`${prefix}lbchess\` untuk klasemen._`)
    return lines.join('\n')
  }

  const turnTag = state.turn === 'w' ? userTag(state.whiteJid) : userTag(state.blackJid)
  const turnLabel = state.turn === 'w' ? 'Putih' : 'Hitam'
  const inCheck = isInCheck(state.board, state.turn)

  lines.push(`*CATUR // MATCH ${state.matchId}*`)
  lines.push('─꯭──꯭──    .  .  .    ▭▬▭▬▭')
  lines.push(`• Putih : ${userTag(state.whiteJid)} (${state.whiteName})`)
  lines.push(`• Hitam : ${userTag(state.blackJid)} (${state.blackName})`)
  if (lastSan) {
    const prevColor = state.turn === 'w' ? 'Hitam' : 'Putih'
    lines.push(`• Langkah Terakhir (${prevColor}) : *${lastSan}*`)
  }
  if (inCheck) {
    lines.push(`• Peringatan : *SKAK* pada Raja ${turnLabel}!`)
  }
  lines.push(`• Giliran Jalan : *${turnLabel}* (${turnTag})`)
  lines.push('━━━━━━━━━━━━━━━━━━━━')
  lines.push(`_Balas foto ini atau ketik langkah (contoh: \`e4\`, \`Nf3\`, \`kuda f3\`)._`)
  return lines.join('\n')
}

function formatReviewSummaryCaption(summary: GameReviewSummary): string {
  const lines: string[] = [
    `*CATUR // GAME REVIEW (${summary.matchId})*`,
    '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
    `• Hasil : *${summary.resultTitle}* (${summary.resultReason})`,
    `• Putih : ${summary.whiteName} (${summary.whiteElo} ELO) • Akurasi ${summary.whiteAccuracy}%`,
    `• Hitam : ${summary.blackName} (${summary.blackElo} ELO) • Akurasi ${summary.blackAccuracy}%`,
    '',
    '*Klasifikasi Langkah (Putih / Hitam):*',
    `• Brilliant  : ${summary.counts.w.Brilliant} / ${summary.counts.b.Brilliant}`,
    `• Great Move : ${summary.counts.w.Great} / ${summary.counts.b.Great}`,
    `• Best Move  : ${summary.counts.w.Best} / ${summary.counts.b.Best}`,
    `• Good       : ${summary.counts.w.Good} / ${summary.counts.b.Good}`,
    `• Book       : ${summary.counts.w.Book} / ${summary.counts.b.Book}`,
    `• Inaccuracy : ${summary.counts.w.Inaccuracy} / ${summary.counts.b.Inaccuracy}`,
    `• Mistake    : ${summary.counts.w.Mistake} / ${summary.counts.b.Mistake}`,
    `• Blunder    : ${summary.counts.w.Blunder} / ${summary.counts.b.Blunder}`,
  ]

  if (summary.turningPoint) {
    const tp = summary.turningPoint
    const side = tp.color === 'w' ? 'Putih' : 'Hitam'
    lines.push(
      '',
      `• Turning Point: Langkah #${tp.moveNumber} (${side} *${tp.san}*) → ${tp.classification} (-${(tp.cpLoss / 100).toFixed(1)}). Solusi: *${tp.bestMoveSan}*.`,
    )
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━')
  return lines.join('\n')
}

async function sendBoardImage(
  whatsapp: WhatsAppPort,
  chess: ChessService,
  state: ChessGameState,
  caption: string,
): Promise<void> {
  const [whiteAvatarBuffer, blackAvatarBuffer] = await Promise.all([
    resolveAvatar(whatsapp, state.whiteJid),
    resolveAvatar(whatsapp, state.blackJid),
  ])

  const pngBuffer = await chess.renderBoardPng(state, {
    whiteAvatarBuffer,
    blackAvatarBuffer,
  })

  if (whatsapp.sendMedia) {
    await whatsapp.sendMedia(state.chatJid, {
      kind: 'image',
      data: new Uint8Array(pngBuffer),
      mimeType: 'image/png',
      caption,
    })
  } else {
    await whatsapp.sendText(
      state.chatJid,
      caption,
      mentionOpts([state.whiteJid, state.blackJid]),
    )
  }
}

export function createChessPlugin(whatsapp: WhatsAppPort): Plugin {
  return {
    name: 'chess',
    version: '1.0.0',
    dependencies: ['menu'],
    load(context) {
      const chess = context.services.get<ChessService>('chess')
      const groupConfig = context.services.has('group-configuration')
        ? context.services.get<GroupConfigurationService>('group-configuration')
        : undefined

      const handleReviewRequest = async (ctx: CommandContext): Promise<void> => {
        const chatJid = ctx.message.remoteJid
        const wantsActive = ctx.args.some((a) => a.toLowerCase() === '--now' || a.toLowerCase() === 'aktif')
        const targetState = wantsActive
          ? chess.getActiveGame(chatJid) ?? chess.getLastFinishedGame(chatJid)
          : chess.getLastFinishedGame(chatJid) ?? chess.getActiveGame(chatJid)

        if (!targetState) {
          await ctx.reply(
            `*CATUR // GAME REVIEW*\n─꯭──꯭──    .  .  .    ▭▬▭▬▭\nBelum ada riwayat pertandingan selesai di obrolan ini.\nMulai bermain dengan \`${ctx.prefix}catur @lawan\` atau \`${ctx.prefix}catur open\`!\n━━━━━━━━━━━━━━━━━━━━`,
          )
          return
        }

        if (targetState.moveHistory.length === 0) {
          await ctx.reply('Pertandingan belum memiliki langkah untuk dianalisis.')
          return
        }

        await ctx.react('🎬')
        await ctx.reply(
          `⏳ Menganalisis *${targetState.moveHistory.length} langkah* dan merender video Game Review MP4...`,
        )

        try {
          const [whiteAvatarBuffer, blackAvatarBuffer] = await Promise.all([
            resolveAvatar(whatsapp, targetState.whiteJid),
            resolveAvatar(whatsapp, targetState.blackJid),
          ])

          const { mp4Buffer, summary } = await chess.renderReviewVideoMp4(targetState, {
            whiteAvatarBuffer,
            blackAvatarBuffer,
          })
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
          const wProfile = chess.getPlayerElo(targetState.whiteJid, targetState.whiteName)
          const bProfile = chess.getPlayerElo(targetState.blackJid, targetState.blackName)
          const fallbackSummary = await import('../../services/chess-service.js').then((m) =>
            m.analyzeGameHistory(targetState, wProfile.elo, bProfile.elo),
          )
          await ctx.reply(formatReviewSummaryCaption(fallbackSummary))
        }
      }

      // 1. Main !catur / !chess command
      context.commands.register({
        name: 'catur',
        aliases: ['chess'],
        description: 'Main catur P2P interaktif dengan sistem rating ELO & Game Review MP4',
        category: 'fun',
        menuOrder: 3,
        cooldownMs: 1500,
        handler: async (ctx) => {
          const chatJid = ctx.message.remoteJid
          const senderJid = ctx.message.senderJid ? jidNormalizedUser(ctx.message.senderJid) : undefined
          if (!senderJid) return

          const senderName = displayNameFor(whatsapp, senderJid, ctx.message.pushName)
          const sub = ctx.args[0]?.toLowerCase() ?? ''

          // Help / Guide if no args and no active game
          if (!sub) {
            const active = chess.getActiveGame(chatJid)
            if (active) {
              await ctx.react('♟️')
              await sendBoardImage(whatsapp, chess, active, formatMoveCaption(active, undefined, undefined, ctx.prefix))
              return
            }

            await ctx.reply(
              [
                '*CATUR // PANDUAN PERTANDINGAN*',
                '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
                `• \`${ctx.prefix}catur @lawan\` : Tantang pemain lain bermain`,
                `• \`${ctx.prefix}catur open\` : Buka tantangan publik di grup`,
                `• \`${ctx.prefix}catur join\` : Masuk ke tantangan terbuka`,
                `• \`${ctx.prefix}catur cancel\` : Batalkan tantangan terbuka atau pertandingan`,
                `• \`${ctx.prefix}catur solo\` : Mode latihan mandiri`,
                '',
                '*Kontrol Langkah:*',
                '• Balas foto papan atau ketik langkah (`e4`, `Nf3`, `kuda f3`, `e2e4`)',
                `• \`${ctx.prefix}catur board\` : Tampilkan papan terkini`,
                `• \`${ctx.prefix}catur flip\` : Balik sudut pandang papan`,
                `• \`${ctx.prefix}catur menyerah\` : Menyerah dari pertandingan`,
                `• \`${ctx.prefix}catur remis\` : Ajukan atau terima tawaran seri`,
                '',
                '*Analisis & Peringkat:*',
                `• \`${ctx.prefix}review\` : Video analisis langkah MP4 (Blunder hingga Brilliant)`,
                `• \`${ctx.prefix}lbchess\` : Klasemen Top 10 rating ELO`,
                `• \`${ctx.prefix}elochess\` : Profil rating dan riwayat tanding`,
                '━━━━━━━━━━━━━━━━━━━━',
              ].join('\n'),
            )
            return
          }

          // Subcommand: review
          if (sub === 'review' || sub === 'analisis') {
            await handleReviewRequest(ctx)
            return
          }

          // Subcommand: open challenge
          if (sub === 'open' || sub === 'buat') {
            if (chess.getActiveGame(chatJid)) {
              await ctx.reply('Masih ada pertandingan catur yang sedang berlangsung di obrolan ini.')
              return
            }
            const existing = openChallenges.get(chatJid)
            if (existing) {
              if (existing.timer) clearTimeout(existing.timer)
              openChallenges.delete(chatJid)
            }

            const hostColor = ctx.args[1]?.toLowerCase() === 'hitam' || ctx.args[1]?.toLowerCase() === 'b' ? 'b' : 'w'
            const createdAt = Date.now()
            const expiresAt = createdAt + OPEN_CHALLENGE_TTL_MS

            const timer = setTimeout(() => {
              const current = openChallenges.get(chatJid)
              if (current && current.createdAt === createdAt) {
                openChallenges.delete(chatJid)
                whatsapp.sendText(
                  chatJid,
                  `*CATUR // TANTANGAN KEDALUWARSA*\n─꯭──꯭──    .  .  .    ▭▬▭▬▭\n_Tantangan catur terbuka dari ${current.hostName} telah kedaluwarsa (5 menit) karena belum ada lawan yang bergabung._\n━━━━━━━━━━━━━━━━━━━━`,
                ).catch(() => {})
              }
            }, OPEN_CHALLENGE_TTL_MS)
            timer.unref?.()

            openChallenges.set(chatJid, {
              chatJid,
              hostJid: senderJid,
              hostName: senderName,
              hostColor,
              createdAt,
              expiresAt,
              timer,
            })
            const eloProfile = chess.getPlayerElo(senderJid, senderName)
            await ctx.reply(
              [
                '*CATUR // TANTANGAN TERBUKA*',
                '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
                `• Penantang   : ${userTag(senderJid)} (${eloProfile.elo} ELO)`,
                `• Pilihan Sisi: ${hostColor === 'w' ? 'Putih' : 'Hitam'}`,
                '• Berlaku     : 5 menit',
                '━━━━━━━━━━━━━━━━━━━━',
                `_Ketik \`${ctx.prefix}catur join\` untuk menerima tantangan, atau \`${ctx.prefix}catur cancel\` untuk membatalkan._`,
              ].join('\n'),
              mentionOpts([senderJid]),
            )
            return
          }

          // Subcommand: cancel / batal / stop / abort
          if (sub === 'cancel' || sub === 'batal' || sub === 'stop' || sub === 'abort') {
            const chal = openChallenges.get(chatJid)
            if (chal) {
              const allowed = await canCancelChallenge(ctx, chal.hostJid)
              if (!allowed) {
                await ctx.reply(`Hanya penantang (${chal.hostName}) atau Admin yang dapat membatalkan tantangan terbuka ini.`)
                return
              }
              if (chal.timer) clearTimeout(chal.timer)
              openChallenges.delete(chatJid)
              await ctx.reply(
                '*CATUR // TANTANGAN DIBATALKAN*\n─꯭──꯭──    .  .  .    ▭▬▭▬▭\n_Tantangan catur terbuka berhasil dibatalkan._\n━━━━━━━━━━━━━━━━━━━━',
              )
              return
            }

            const activeGame = chess.getActiveGame(chatJid)
            if (!activeGame) {
              await ctx.reply('Tidak ada sesi tantangan terbuka atau pertandingan catur yang aktif di obrolan ini.')
              return
            }

            if (!isSameJid(senderJid, activeGame.whiteJid) && !isSameJid(senderJid, activeGame.blackJid)) {
              await ctx.reply('Hanya pemain yang sedang bertanding yang dapat membatalkan sesi ini.')
              return
            }

            if (activeGame.moveHistory.length >= 4) {
              await ctx.reply(
                `Pertandingan sudah berjalan ${activeGame.moveHistory.length} langkah. Gunakan \`${ctx.prefix}catur menyerah\` atau \`${ctx.prefix}catur remis\`.`,
              )
              return
            }

            chess.abortGame(chatJid)
            await ctx.reply(
              '*CATUR // PERTANDINGAN DIBATALKAN*\n─꯭──꯭──    .  .  .    ▭▬▭▬▭\n_Sesi pertandingan dibatalkan tanpa perubahan rating ELO._\n━━━━━━━━━━━━━━━━━━━━',
            )
            return
          }

          // Subcommand: join open challenge
          if (sub === 'join' || sub === 'gabung' || sub === 'terima') {
            if (chess.getActiveGame(chatJid)) {
              await ctx.reply('Pertandingan sudah dimulai di obrolan ini.')
              return
            }
            const chal = openChallenges.get(chatJid)
            if (!chal) {
              await ctx.reply(`Tidak ada tantangan terbuka. Buka dengan \`${ctx.prefix}catur open\` atau \`${ctx.prefix}catur @lawan\`.`)
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
            })
            if ('error' in created) {
              await ctx.reply(`❌ ${created.error}`)
              return
            }
            await ctx.react('♟️')
            await sendBoardImage(whatsapp, chess, created, formatMoveCaption(created, undefined, undefined, ctx.prefix))
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
            })
            if ('error' in created) {
              await ctx.reply(`❌ ${created.error}`)
              return
            }
            await ctx.react('♟️')
            await sendBoardImage(whatsapp, chess, created, formatMoveCaption(created, undefined, undefined, ctx.prefix))
            return
          }

          // Subcommand: start / direct @mention challenge
          const mentionedJid = ctx.message.mentionedJids?.[0] || ctx.message.quotedSenderJid
          if (sub === 'start' || sub === 'mulai' || sub === 'vs' || (sub.startsWith('@') && mentionedJid)) {
            if (chess.getActiveGame(chatJid)) {
              await ctx.reply('Masih ada pertandingan catur yang sedang aktif di obrolan ini.')
              return
            }
            if (!mentionedJid) {
              await ctx.reply(
                `Tag lawan yang ingin kamu tantang. Contoh: \`${ctx.prefix}catur @lawan\` atau \`${ctx.prefix}catur open\`.`,
              )
              return
            }
            const opponentJid = jidNormalizedUser(mentionedJid)
            const opponentName = displayNameFor(whatsapp, opponentJid)
            const created = chess.createGame({
              chatJid,
              whiteJid: senderJid,
              whiteName: senderName,
              blackJid: opponentJid,
              blackName: opponentName,
            })
            if ('error' in created) {
              await ctx.reply(`❌ ${created.error}`)
              return
            }
            await ctx.react('♟️')
            await sendBoardImage(whatsapp, chess, created, formatMoveCaption(created, undefined, undefined, ctx.prefix))
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
            await ctx.reply(`*CATUR // PGN (${target.matchId})*\n─꯭──꯭──    .  .  .    ▭▬▭▬▭\n\`\`\`${chess.toPgn(target)}\`\`\`\n━━━━━━━━━━━━━━━━━━━━`)
            return
          }

          if (!active) {
            await ctx.reply(
              `Belum ada pertandingan catur aktif. Mulai dengan \`${ctx.prefix}catur @lawan\` atau \`${ctx.prefix}catur open\`!`,
            )
            return
          }

          if (sub === 'board' || sub === 'papan') {
            await sendBoardImage(whatsapp, chess, active, formatMoveCaption(active, undefined, undefined, ctx.prefix))
            return
          }

          if (sub === 'pure' || sub === 'murni') {
            active.pureMode = !active.pureMode
            await sendBoardImage(
              whatsapp,
              chess,
              active,
              `*CATUR // TAMPILAN MURNI 1:1*: *${active.pureMode ? 'AKTIF' : 'NONAKTIF'}*\n\n${formatMoveCaption(active, undefined, undefined, ctx.prefix)}`,
            )
            return
          }

          if (sub === 'flip' || sub === 'putar') {
            active.orientation = active.orientation === 'w' ? 'b' : 'w'
            await sendBoardImage(whatsapp, chess, active, formatMoveCaption(active, undefined, undefined, ctx.prefix))
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
              await ctx.reply(`*CATUR // FEN SAAT INI*\n─꯭──꯭──    .  .  .    ▭▬▭▬▭\n\`${currentFen}\`\n━━━━━━━━━━━━━━━━━━━━`)
              return
            }
            if (!isSameJid(senderJid, active.whiteJid) && !isSameJid(senderJid, active.blackJid)) {
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
            })
            if ('error' in reloaded) {
              await ctx.reply(`❌ FEN Tidak Valid: ${reloaded.error}`)
              return
            }
            await sendBoardImage(whatsapp, chess, reloaded, formatMoveCaption(reloaded, undefined, undefined, ctx.prefix))
            return
          }



          if (sub === 'menyerah' || sub === 'resign' || sub === 'nyerah') {
            if (!isSameJid(senderJid, active.whiteJid) && !isSameJid(senderJid, active.blackJid)) {
              await ctx.reply('Hanya pemain dalam pertandingan ini yang dapat menyerah.')
              return
            }
            const resignColor =
              isSameJid(active.whiteJid, active.blackJid)
                ? active.turn
                : isSameJid(senderJid, active.whiteJid)
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
            if (!isSameJid(senderJid, active.whiteJid) && !isSameJid(senderJid, active.blackJid)) {
              await ctx.reply('Hanya pemain dalam pertandingan ini yang dapat menawarkan atau menerima remis.')
              return
            }
            const callerColor =
              isSameJid(active.whiteJid, active.blackJid)
                ? active.turn
                : isSameJid(senderJid, active.whiteJid)
                  ? 'w'
                  : 'b'

            if (isSameJid(active.whiteJid, active.blackJid) || (active.drawOfferedBy && active.drawOfferedBy !== callerColor)) {
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
              [
                '*CATUR // TAWARAN REMIS*',
                '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
                `• Dari   : ${userTag(senderJid)}`,
                `• Kepada : ${userTag(otherJid)}`,
                '━━━━━━━━━━━━━━━━━━━━',
                `_Ketik \`${ctx.prefix}catur remis\` untuk menerima tawaran seri, atau lanjutkan langkah untuk menolak._`,
              ].join('\n'),
              mentionOpts([senderJid, otherJid]),
            )
            return
          }

          // Otherwise treat args as a move input (e.g. !catur e4, !catur Nf3, !catur Kuda f3)
          const expectedJid = active.turn === 'w' ? active.whiteJid : active.blackJid
          if (!isSameJid(senderJid, expectedJid)) {
            await ctx.reply(
              `Giliran saat ini: *${active.turn === 'w' ? 'Putih' : 'Hitam'}* (${userTag(expectedJid)}).`,
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
            formatMoveCaption(result.state, result.record.san, result.eloResult, ctx.prefix),
          )
        },
      })

      // 2. Standalone !review command
      context.commands.register({
        name: 'review',
        aliases: ['chessreview', 'analisiscatur'],
        description: 'Analisis pertandingan catur selesai menjadi video MP4 lengkap evaluasi langkah',
        category: 'fun',
        menuOrder: 4,
        cooldownMs: 5000,
        handler: handleReviewRequest,
      })

      // 3. Standalone !leaderboardchess command
      context.commands.register({
        name: 'leaderboardchess',
        aliases: ['lbchess', 'topchess', 'rankcatur'],
        description: 'Tampilkan klasemen Top 10 pemain catur berdasarkan rating ELO',
        category: 'fun',
        menuOrder: 5,
        cooldownMs: 3000,
        handler: async (ctx) => {
          await ctx.react('🏆')
          const topList = chess.getLeaderboard(10)
          const avatars = new Map<string, Buffer>()
          await Promise.all(
            topList.map(async (p) => {
              const buf = await resolveAvatar(whatsapp, p.userJid)
              if (buf) avatars.set(p.userJid, buf)
            }),
          )
          const cardPng = await chess.renderLeaderboardCardPng(topList, { avatars })

          const lines: string[] = [
            '*CATUR // KLASEMEN ELO TOP 10*',
            '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
          ]

          if (topList.length === 0) {
            lines.push('_Belum ada data pertandingan berperingkat._')
          } else {
            for (let i = 0; i < topList.length; i++) {
              const p = topList[i]
              const tier = getEloTier(p.elo)
              const wr = p.gamesPlayed > 0 ? Math.round((p.wins / p.gamesPlayed) * 100) : 0
              lines.push(
                `${i + 1}. *${p.displayName}* (${p.elo} ELO) • ${tier.title}\n   ↳ Menang: ${p.wins} | Kalah: ${p.losses} | Seri: ${p.draws} (${wr}%)`,
              )
            }
          }
          lines.push('━━━━━━━━━━━━━━━━━━━━')

          const caption = lines.join('\n')
          if (ctx.whatsapp.sendMedia) {
            await ctx.whatsapp.sendMedia(ctx.message.remoteJid, {
              kind: 'image',
              data: new Uint8Array(cardPng),
              mimeType: 'image/png',
              caption,
            })
          } else {
            await ctx.reply(caption, mentionOpts(topList.map((x) => x.userJid)))
          }
        },
      })

      // 4. Standalone !elochess command
      context.commands.register({
        name: 'elochess',
        aliases: ['chesselo', 'chessprofile', 'statscatur'],
        description: 'Cek rating ELO, gelar catur, dan statistik rekor pemain',
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
          const profile = chess.getPlayerElo(targetJid, displayNameFor(whatsapp, targetJid, fallbackName))
          const tier = getEloTier(profile.elo)
          const winrate =
            profile.gamesPlayed > 0 ? Math.round((profile.wins / profile.gamesPlayed) * 100) : 0

          await ctx.reply(
            [
              `*CATUR // PROFIL PEMAIN: ${profile.displayName}*`,
              '─꯭──꯭──    .  .  .    ▭▬▭▬▭',
              `• Pemain          : ${userTag(profile.userJid)}`,
              `• Gelar & Tier    : *${tier.title}* (${tier.badge})`,
              `• Rating ELO      : *${profile.elo}* (Puncak: ${profile.peakElo})`,
              `• Total Match     : ${profile.gamesPlayed} pertandingan`,
              `• Statistik       : ${profile.wins} Menang | ${profile.losses} Kalah | ${profile.draws} Seri`,
              `• Rasio Kemenangan: *${winrate}%* (Streak: ${profile.winStreak})`,
              '━━━━━━━━━━━━━━━━━━━━',
            ].join('\n'),
            mentionOpts([profile.userJid]),
          )
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

        // Ignore commands handled by command registry
        if (rawText.startsWith(prefix) || rawText.startsWith(context.config.commandPrefix)) return

        const senderJid = jidNormalizedUser(message.senderJid)
        const expectedJid = active.turn === 'w' ? active.whiteJid : active.blackJid
        if (!isSameJid(senderJid, expectedJid)) return

        const isReplyingToBoard = Boolean(
          message.quotedMessageId &&
            (/[♟♞♝♜♛♚]/u.test(message.quotedText || '') ||
              /\b(?:catur|chess|giliran jalan|skak|langkah)\b/i.test(message.quotedText || '')),
        )

        // Pre-filter: allow direct board replies, Indonesian piece names, or standard SAN/UCI
        const looksLikeChessMove =
          isReplyingToBoard ||
          /^(O-O(-O)?|0-0(-0)?|[KQRBNPkqrbnp]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBNqrbn])?[+#!?]*|[a-h][1-8][\s\-:x]*[a-h][1-8][qrbnQRBN]?)$/i.test(
            rawText,
          ) ||
          /^(?:kuda|gajah|benteng|menteri|ratu|raja|pion|rokade)\b/i.test(rawText)

        if (!looksLikeChessMove) return

        const result = chess.executeMove(message.remoteJid, rawText)
        if ('error' in result) {
          // Only reply with diagnostic error if the user explicitly replied to a message or typed an exact coordinate pair
          if (message.quotedMessageId || /^[a-h][1-8][\s\-]*[a-h][1-8]$/i.test(rawText)) {
            await whatsapp.sendText(message.remoteJid, `❌ ${result.error}`)
          }
          return
        }

        await sendBoardImage(
          whatsapp,
          chess,
          result.state,
          formatMoveCaption(result.state, result.record.san, result.eloResult, prefix),
        )
      })
    },
  }
}
