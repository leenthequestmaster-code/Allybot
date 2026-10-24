import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import pino from 'pino'
import {
  BASE_STARTING_ELO,
  BOT_PROFILES,
  ChessService,
  OPENING_BOOK,
  PROFILE_CARD_BASEPLATE_DATA_URL,
  TACTICAL_PUZZLES,
  TIME_CONTROLS,
  analyzeGameHistory,
  calculateEloUpdate,
  createInitialBoard,
  formatClockMs,
  getEloTier,
   getKFactor,
  isChessNotationOrBoardReply,
  lookupOpeningBook,
  makePlayerBar,
  parseFen,
  toFen,
} from '../dist/services/chess-service.js'
import {
  clearOpenChallenges,
  createChessPlugin,
  formatMoveCaption,
  formatPlayerProfileCaption,
  isChessMoveOrReply,
} from '../dist/framework/plugins/chess.js'

const logger = pino({ level: 'silent' })

function createTestContext(chess, whatsapp) {
  const commands = new Map()
  const events = new Map()
  return {
    commands: {
      register(def) {
        commands.set(def.name, def)
      },
      get(name) {
        return commands.get(name)
      },
    },
    events: {
      on(event, fn) {
        events.set(event, fn)
      },
      emit(event, payload) {
        return events.get(event)?.(payload)
      },
    },
    services: {
      get(name) {
        if (name === 'chess') return chess
        return undefined
      },
      has(name) {
        return name === 'chess'
      },
    },
    config: {
      commandPrefix: '!',
      defaultCooldownMs: 0,
    },
    whatsapp,
    logger,
  }
}

test('Feature A: WhatsApp-Adapted Chess Clocks, Flag Fall, Move-1 AFK Abort & Satori Digital Clock Styles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allybot-chess-clock-'))
  try {
    const dbPath = join(dir, 'allybot-chess.sqlite')
    const chess = new ChessService(dbPath, logger)
    chess.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })

    // 1. Verify 4 Time Control specifications
    assert.equal(TIME_CONTROLS.bullet.bankMs, 3 * 60 * 1000)
    assert.equal(TIME_CONTROLS.bullet.maxTurnMs, 90 * 1000)
    assert.equal(TIME_CONTROLS.blitz.bankMs, 7 * 60 * 1000)
    assert.equal(TIME_CONTROLS.blitz.maxTurnMs, 3 * 60 * 1000)
    assert.equal(TIME_CONTROLS.rapid.bankMs, 15 * 60 * 1000)
    assert.equal(TIME_CONTROLS.rapid.maxTurnMs, 5 * 60 * 1000)
    assert.equal(TIME_CONTROLS.casual.bankMs, 0)
    assert.equal(TIME_CONTROLS.casual.rated, false)
    assert.equal(formatClockMs(7 * 60 * 1000), '07:00')
    assert.equal(formatClockMs(59 * 1000), '00:59')

    // 2. Verify Move-1 AFK Abort (Zero ELO penalty when < 1 move played)
    const chatAfk = '120363000001@g.us'
    const wJid = '6281111111@s.whatsapp.net'
    const bJid = '6282222222@s.whatsapp.net'
    const startTs = 1_700_000_000_000

    const afkGame = chess.createGame({
      chatJid: chatAfk,
      whiteJid: wJid,
      whiteName: 'WhiteAFK',
      blackJid: bJid,
      blackName: 'BlackWait',
      timeControl: 'bullet',
      nowMs: startTs,
    })
    assert.ok(!('error' in afkGame))
    // Advance past 90s single-turn limit on Move 1
    const afkCheck = chess.checkClockExpiration(afkGame, startTs + 95_000)
    assert.equal(afkCheck.expired, true)
    assert.equal(afkCheck.abortedMove1, true)
    assert.equal(afkGame.gameOver, true)
    assert.equal(afkCheck.eloResult?.applied, false)
    assert.equal(chess.getPlayerElo(wJid, 'WhiteAFK', 'bullet').elo, BASE_STARTING_ELO)

    // 3. Verify Bank Decrement & Flag Fall / Timeout after Move 1 awards ELO
    const chatFlag = '120363000002@g.us'
    const flagGame = chess.createGame({
      chatJid: chatFlag,
      whiteJid: wJid,
      whiteName: 'WhiteFast',
      blackJid: bJid,
      blackName: 'BlackSlow',
      timeControl: 'blitz',
      nowMs: startTs,
    })
    assert.ok(!('error' in flagGame))

    // White plays e4 after 10 seconds -> White bank should be 7m - 10s = 410_000ms
    const move1 = chess.executeMove(chatFlag, 'e4', startTs + 10_000)
    assert.ok(!('error' in move1))
    assert.equal(move1.state.whiteRemainingMs, 7 * 60 * 1000 - 10_000)

    // Black takes 190 seconds (> 3m single-turn limit in Blitz)
    const move2Timeout = chess.executeMove(chatFlag, 'e5', startTs + 10_000 + 190_000)
    assert.ok(!('error' in move2Timeout))
    assert.equal(move2Timeout.state.gameOver, true)
    assert.equal(move2Timeout.state.winner, 'w')
    assert.equal(move2Timeout.state.resultTitle, 'WAKTU HABIS (FLAG FALL)')
    assert.equal(move2Timeout.eloResult?.applied, true)
    assert.equal(move2Timeout.eloResult?.whiteAfter, 432)
    assert.equal(move2Timeout.eloResult?.blackAfter, 368)

    // 4. Verify Satori Digital Clock Pill Styles (Active Green, Inactive Dark, <60s Critical Red)
    const barActive = makePlayerBar('Putih', 400, 'w', [], 0, null, {
      remainingMs: 300_000,
      isActiveTurn: true,
      showClock: true,
    })
    const activeChildren = barActive.props.children
    const activePill = activeChildren[activeChildren.length - 1]
    assert.equal(activePill.props.style.backgroundColor, '#273b18')
    assert.equal(activePill.props.style.color, '#a3d160')
    assert.equal(activePill.props.style.border, '1px solid #53782b')

    const barInactive = makePlayerBar('Hitam', 400, 'b', [], 0, null, {
      remainingMs: 300_000,
      isActiveTurn: false,
      showClock: true,
    })
    const inactiveChildren = barInactive.props.children
    const inactivePill = inactiveChildren[inactiveChildren.length - 1]
    assert.equal(inactivePill.props.style.backgroundColor, '#1f1e1b')
    assert.equal(inactivePill.props.style.color, '#73716d')

    const barLow = makePlayerBar('PutihKritis', 400, 'w', [], 0, null, {
      remainingMs: 45_000,
      isActiveTurn: true,
      showClock: true,
    })
    const lowChildren = barLow.props.children
    const lowPill = lowChildren[lowChildren.length - 1]
    assert.equal(lowPill.props.style.backgroundColor, '#450a0a')
    assert.equal(lowPill.props.style.color, '#f87171')
    assert.equal(lowPill.props.style.border, '1px solid #991b1b')

    chess.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Feature B: Multi-ELO Base 400 Ladder, Turbo Calibration (K=64 -> K=24) & Category Isolation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allybot-chess-elo-'))
  try {
    const dbPath = join(dir, 'allybot-chess.sqlite')
    const chess = new ChessService(dbPath, logger)
    chess.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })

    // 1. Verify Base 400 & 5 RPG ELO Tiers
    assert.equal(BASE_STARTING_ELO, 400)
    assert.equal(getEloTier(400).title, 'Novice')
    assert.equal(getEloTier(699).title, 'Novice')
    assert.equal(getEloTier(700).title, 'Apprentice')
    assert.equal(getEloTier(1000).title, 'Tactician')
    assert.equal(getEloTier(1300).title, 'Master')
    assert.equal(getEloTier(1600).title, 'Grandmaster')

    // 2. Verify Turbo K-Factor (Matches 1..5 -> K=64, Match 6+ -> K=24)
    assert.equal(getKFactor(0), 64)
    assert.equal(getKFactor(4), 64)
    assert.equal(getKFactor(5), 24)
    assert.equal(getKFactor(20), 24)

    const turboCalc = calculateEloUpdate(400, 400, 1, 0, 0)
    assert.equal(turboCalc.whiteDelta, 32)
    assert.equal(turboCalc.blackDelta, -32)

    const stableCalc = calculateEloUpdate(400, 400, 1, 5, 5)
    assert.equal(stableCalc.whiteDelta, 12)
    assert.equal(stableCalc.blackDelta, -12)

    // 3. Verify Independent Category Ratings (Blitz vs Rapid vs Bullet)
    const p1 = '6281000001@s.whatsapp.net'
    const p2 = '6282000002@s.whatsapp.net'

    const profileInit = chess.getPlayerElo(p1, 'PlayerOne')
    assert.equal(profileInit.blitz.elo, 400)
    assert.equal(profileInit.rapid.elo, 400)
    assert.equal(profileInit.bullet.elo, 400)

    // Play a Rapid game and resign to award Rapid ELO
    const rapidChat = '120363000010@g.us'
    chess.createGame({
      chatJid: rapidChat,
      whiteJid: p1,
      whiteName: 'PlayerOne',
      blackJid: p2,
      blackName: 'PlayerTwo',
      timeControl: 'rapid',
    })
    const resignRes = chess.resignGame(rapidChat, 'b')
    assert.ok(resignRes)
    assert.equal(resignRes.eloResult.category, 'rapid')
    assert.equal(resignRes.eloResult.whiteAfter, 432)

    const p1After = chess.getPlayerElo(p1, 'PlayerOne')
    assert.equal(p1After.rapid.elo, 432)
    assert.equal(p1After.blitz.elo, 400)
    assert.equal(p1After.bullet.elo, 400)

    chess.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Feature C: PvE Mode vs Stockfish Bot (Levels 1-4) & Bot Slayer Trophies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'allybot-chess-bot-'))
  try {
    const dbPath = join(dir, 'allybot-chess.sqlite')
    const chess = new ChessService(dbPath, logger)
    chess.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })

    // 1. Verify Bot Profiles Lv 1..4
    assert.equal(BOT_PROFILES[1].elo, 600)
    assert.equal(BOT_PROFILES[2].elo, 1000)
    assert.equal(BOT_PROFILES[3].elo, 1500)
    assert.equal(BOT_PROFILES[4].elo, 2200)

    // 2. Start PvE game against Bot Level 1 and verify AI auto-reply
    const chatBot = '120363000020@g.us'
    const humanJid = '6289999999@s.whatsapp.net'
    const game = chess.createGame({
      chatJid: chatBot,
      whiteJid: humanJid,
      whiteName: 'HumanHero',
      blackJid: 'bot:stockfish:1',
      blackName: BOT_PROFILES[1].name,
      timeControl: 'casual',
      botLevel: 1,
      botColor: 'b',
    })
    assert.ok(!('error' in game))
    assert.equal(game.isBotMatch, true)
    assert.equal(game.rated, false)

    // Human plays 1. e4
    const hMove = chess.executeMove(chatBot, 'e4')
    assert.ok(!('error' in hMove))
    assert.equal(hMove.state.turn, 'b')

    // Bot replies automatically
    const botReply = await chess.executeBotReply(chatBot)
    assert.ok(botReply && !('error' in botReply))
    assert.equal(botReply.state.turn, 'w')
    assert.equal(botReply.state.moveHistory.length, 2)

    // Simulate Bot resignation / defeat -> Human unlocks Bot Slayer Trophy Lv 1 without changing PvP ELO
    const botDefeat = chess.resignGame(chatBot, 'b')
    assert.ok(botDefeat)
    assert.equal(botDefeat.eloResult.applied, false)
    assert.equal(botDefeat.eloResult.trophyUnlocked, 1)

    const humanProfile = chess.getPlayerElo(humanJid, 'HumanHero')
    assert.deepEqual(humanProfile.botTrophies, [1])
    assert.equal(humanProfile.blitz.elo, 400)

    chess.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Feature D: 80+ ECO Opening Book, Scholar Mate, Satori PNG, Review MP4 & Plugin Commands', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'allybot-chess-full-'))
  try {
    const dbPath = join(dir, 'allybot-chess.sqlite')
    const chess = new ChessService(dbPath, logger)
    chess.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })

    // 1. Verify 80+ ECO Opening Book & lookupOpeningBook
    assert.ok(OPENING_BOOK.length >= 80, `Expected >= 80 openings, got ${OPENING_BOOK.length}`)
    const ruyLopez = lookupOpeningBook(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])
    assert.ok(ruyLopez)
    assert.equal(ruyLopez.eco, 'C60')
    assert.match(ruyLopez.name, /Ruy Lopez/)

    // 2. Play Scholar's Mate & verify Book moves + Blunder detection
    const chatJid = '120363000030@g.us'
    const whiteJid = '6281111111@s.whatsapp.net'
    const blackJid = '6282222222@s.whatsapp.net'

    const game = chess.createGame({
      chatJid,
      whiteJid,
      whiteName: 'PutihMaster',
      blackJid,
      blackName: 'HitamLearner',
      timeControl: 'blitz',
    })
    assert.ok(!('error' in game))

    const moves = ['e4', 'e7e5', 'Gajah c4', 'Nc6', 'Qh5', 'Kuda f6', 'Qxf7']
    let lastRes = null
    for (const m of moves) {
      lastRes = chess.executeMove(chatJid, m)
      assert.ok(!('error' in lastRes), `Move ${m} failed: ${lastRes?.error}`)
    }

    assert.equal(lastRes.state.gameOver, true)
    assert.equal(lastRes.state.winner, 'w')
    assert.equal(lastRes.record.san, 'Qxf7#')
    assert.equal(lastRes.eloResult?.applied, true)
    assert.equal(lastRes.eloResult?.whiteAfter, 432)
    assert.equal(lastRes.eloResult?.blackAfter, 368)

    // 3. Verify Game Review Summary & Book classification (0 CPL on 1.e4 e5 2.Bc4 Nc6)
    const review = await analyzeGameHistory(lastRes.state, 432, 368)
    assert.equal(review.steps.length, 7)
    assert.equal(review.steps[0].classification, 'Book')
    assert.equal(review.steps[0].cpLoss, 0)
    assert.equal(review.steps[1].classification, 'Book')
    assert.ok(review.counts.w.Book >= 2)
    assert.ok(review.counts.b.Blunder >= 1 || review.counts.b.Mistake >= 1)

    // 4. Verify Satori Board PNG, Leaderboard PNG & Review MP4 Video rendering
    const boardPng = await chess.renderBoardPng(lastRes.state)
    assert.ok(Buffer.isBuffer(boardPng) && boardPng.length > 100)

    const topBlitz = chess.getLeaderboard(10, 'blitz')
    assert.equal(topBlitz.length, 2)
    const lbPng = await chess.renderLeaderboardCardPng(topBlitz, 'blitz')
    assert.ok(Buffer.isBuffer(lbPng) && lbPng.length > 100)

    const { mp4Buffer } = await chess.renderReviewVideoMp4(lastRes.state)
    assert.ok(Buffer.isBuffer(mp4Buffer) && mp4Buffer.length > 200)

    // 5. Verify Official Allybot Box Borders & Plugin Challenge Lifecycle
    const profileText = formatPlayerProfileCaption(chess, whiteJid, 'PutihMaster')
    assert.ok(profileText.includes('─꯭──꯭──    .  .  .    ▭▬▭▬▭'))
    assert.ok(profileText.includes('━━━━━━━━━━━━━━━━━━━━'))
    assert.ok(profileText.includes('🔥 Blitz (7m)  : *432*'))

    // Verify AI Chlona Reply Guard
    assert.equal(isChessMoveOrReply('Nf3'), true)
    assert.equal(isChessNotationOrBoardReply('e4', 'CATUR ALLYBOT • Giliran Jalan'), true)
    assert.equal(isChessMoveOrReply('Halo apa kabar semuanya hari ini'), false)

    // Verify Plugin Open Challenge & Self-Join Prevention
    clearOpenChallenges()
    const replies = []
    const mockWhatsapp = {
      sendText: async (_jid, text) => {
        replies.push(text)
      },
      sendMedia: async (_jid, media) => {
        replies.push(media.caption ?? '')
      },
      sendPresence: async () => {},
    }
    const plugin = createChessPlugin(mockWhatsapp, { botDelayMs: 0 })
    const ctxContainer = createTestContext(chess, mockWhatsapp)
    await plugin.load(ctxContainer)

    const caturCmd = ctxContainer.commands.get('catur')
    assert.ok(caturCmd)

    const openRoom = '120363000099@g.us'
    await caturCmd.handler({
      args: ['open', 'rapid', 'hitam'],
      prefix: '!',
      whatsapp: mockWhatsapp,
      logger,
      message: { remoteJid: openRoom, senderJid: whiteJid, pushName: 'HostUser' },
      reply: async (t) => replies.push(t),
      react: async () => {},
    })
    assert.ok(replies[replies.length - 1].includes('TANTANGAN CATUR TERBUKA'))

    // Host tries to join own challenge -> prevented
    await caturCmd.handler({
      args: ['join'],
      prefix: '!',
      whatsapp: mockWhatsapp,
      logger,
      message: { remoteJid: openRoom, senderJid: whiteJid, pushName: 'HostUser' },
      reply: async (t) => replies.push(t),
      react: async () => {},
    })
    assert.ok(replies[replies.length - 1].includes('tidak bisa menerima tantanganmu sendiri'))

    chess.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Feature E: Visual !elochess Profile Card (1000x667 PNG), #Ranking, Weekly Deltas & Tactical Puzzle ELO', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'allybot-chess-profile-'))
  try {
    const dbPath = join(dir, 'allybot-chess.sqlite')
    const chess = new ChessService(dbPath, logger)
    chess.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })

    assert.ok(PROFILE_CARD_BASEPLATE_DATA_URL.startsWith('data:image/jpeg;base64,'))
    assert.ok(TACTICAL_PUZZLES.length >= 6)

    const p1 = '6281111111@s.whatsapp.net'
    const p2 = '6282222222@s.whatsapp.net'

    // 1. Play rated games across Bullet, Blitz, and Rapid to generate weekly deltas
    const bulletChat = '120363000101@g.us'
    chess.createGame({
      chatJid: bulletChat,
      whiteJid: p1,
      whiteName: 'Username',
      blackJid: p2,
      blackName: 'RivalPlayer',
      timeControl: 'bullet',
    })
    const bulletRes = chess.resignGame(bulletChat, 'b')
    assert.ok(bulletRes)
    assert.equal(bulletRes.eloResult.whiteDelta, 32)
    assert.equal(bulletRes.eloResult.blackDelta, -32)

    const blitzChat = '120363000102@g.us'
    chess.createGame({
      chatJid: blitzChat,
      whiteJid: p1,
      whiteName: 'Username',
      blackJid: p2,
      blackName: 'RivalPlayer',
      timeControl: 'blitz',
    })
    const blitzRes = chess.resignGame(blitzChat, 'b')
    assert.ok(blitzRes)
    assert.equal(blitzRes.eloResult.whiteDelta, 32)

    const rapidChat = '120363000103@g.us'
    chess.createGame({
      chatJid: rapidChat,
      whiteJid: p1,
      whiteName: 'Username',
      blackJid: p2,
      blackName: 'RivalPlayer',
      timeControl: 'rapid',
    })
    // p1 resigns in Rapid -> negative weekly delta in Rapid (-32 this week ↓)
    const rapidRes = chess.resignGame(rapidChat, 'w')
    assert.ok(rapidRes)
    assert.equal(rapidRes.eloResult.whiteDelta, -32)

    // 2. Start & solve a Tactical Puzzle to earn Puzzle ELO + weekly delta
    const pzSession = chess.startPuzzle(blitzChat, p1, 'Username', 'PZ-01')
    assert.equal(pzSession.puzzle.id, 'PZ-01')
    const pzSolve = chess.solvePuzzle(blitzChat, p1, 'Username', 'Re8#')
    assert.ok(!('error' in pzSolve))
    assert.equal(pzSolve.solved, true)
    assert.ok(pzSolve.delta > 0)
    assert.ok(pzSolve.after > 400)

    // 3. Verify Weekly Deltas & Global #Ranking
    const deltas = chess.getWeeklyEloDeltas(p1)
    assert.equal(deltas.bullet, 32)
    assert.equal(deltas.blitz, 32)
    assert.equal(deltas.rapid, -32)
    assert.equal(deltas.puzzle, pzSolve.delta)

    assert.equal(chess.getPlayerRank(p1), 1)
    assert.equal(chess.getPlayerRank(p2), 2)

    // 4. Verify 1000x667 Visual Profile Card PNG rendering
    const cardPng = await chess.renderProfileCardPng(p1, 'Username')
    assert.ok(Buffer.isBuffer(cardPng) && cardPng.length > 500)
    // Verify PNG signature and exact IHDR width=1000, height=667
    assert.equal(cardPng[0], 0x89)
    assert.equal(cardPng[1], 0x50)
    assert.equal(cardPng.readUInt32BE(16), 1000)
    assert.equal(cardPng.readUInt32BE(20), 667)

    // 5. Verify !elochess & !catur puzzle plugin command execution
    const sentMedia = []
    const sentTexts = []
    const mockWhatsapp = {
      sendText: async (_jid, text) => sentTexts.push(text),
      sendMedia: async (_jid, media) => sentMedia.push(media),
      sendPresence: async () => {},
    }
    const plugin = createChessPlugin(mockWhatsapp, { botDelayMs: 0 })
    const ctxContainer = createTestContext(chess, mockWhatsapp)
    await plugin.load(ctxContainer)

    const eloCmd = ctxContainer.commands.get('elochess')
    assert.ok(eloCmd)
    await eloCmd.handler({
      args: [],
      prefix: '!',
      whatsapp: mockWhatsapp,
      logger,
      message: { remoteJid: blitzChat, senderJid: p1, pushName: 'Username' },
      reply: async (t) => sentTexts.push(t),
      react: async () => {},
    })
    assert.equal(sentMedia.length, 1)
    assert.equal(sentMedia[0].kind, 'image')
    assert.equal(sentMedia[0].mimeType, 'image/png')
    assert.ok(sentMedia[0].caption.includes('PROFIL CATUR ALLYBOT'))
    assert.ok(sentMedia[0].caption.includes('#1'))
    assert.ok(sentMedia[0].caption.includes('+32 this week ↑'))
    assert.ok(sentMedia[0].caption.includes('-32 this week ↓'))
    assert.ok(sentMedia[0].caption.includes('🧩 Puzzle'))

    chess.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

