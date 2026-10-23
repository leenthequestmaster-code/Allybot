import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import pino from 'pino'
import {
  ChessService,
  analyzeGameHistory,
  parseFen,
  toFen,
  createInitialBoard,
  getEloTier,
} from '../dist/services/chess-service.js'

const logger = pino({ level: 'silent' })

test('ChessService FIDE Super-Engine: FEN, Scholar Mate, ELO rating, and Tactical Review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'allybot-chess-test-'))
  try {
    const dbPath = join(dir, 'allybot.sqlite')
    const chess = new ChessService(dbPath, logger)
    chess.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })

    // 1. Verify initial FEN
    const initFen = toFen(createInitialBoard(), 'w', { wK: true, wQ: true, bK: true, bQ: true }, null, 0, 1)
    assert.equal(initFen, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
    const parsedFen = parseFen(initFen)
    assert.ok(!('error' in parsedFen))

    // 2. Create match between two distinct players and play Scholar's Mate
    const chatJid = '120363000000@g.us'
    const whiteJid = '6281111111@s.whatsapp.net'
    const blackJid = '6282222222@s.whatsapp.net'

    const game = chess.createGame({
      chatJid,
      whiteJid,
      whiteName: 'putihPlayer',
      blackJid,
      blackName: 'hitamPlayer',
    })
    assert.ok(!('error' in game))

    // Play moves using mixed SAN, UCI, and Indonesian notation
    const moves = [
      'e4',           // 1. e4 (SAN)
      'e7e5',         // 1... e5 (UCI)
      'Gajah c4',     // 2. Bc4 (Indonesian casual)
      'Nc6',          // 2... Nc6
      'Qh5',          // 3. Qh5
      'Kuda f6',      // 3... Nf6 (Blunder allowing mate in 1)
      'Qxf7',         // 4. Qxf7#
    ]

    let lastRes = null
    for (const m of moves) {
      lastRes = chess.executeMove(chatJid, m)
      assert.ok(!('error' in lastRes), `Move ${m} failed: ${lastRes?.error}`)
    }

    assert.equal(lastRes.state.gameOver, true)
    assert.equal(lastRes.state.winner, 'w')
    assert.equal(lastRes.record.san, 'Qxf7#')
    assert.ok(lastRes.eloResult?.applied)
    assert.ok(lastRes.eloResult.whiteAfter > 1200)
    assert.ok(lastRes.eloResult.blackAfter < 1200)

    // 3. Verify Leaderboard & ELO Tier
    const lb = chess.getLeaderboard(10)
    assert.equal(lb.length, 2)
    assert.equal(lb[0].userJid, whiteJid)
    assert.equal(getEloTier(1220).title, 'Tactician')

    // 4. Verify Tactical Game Review (Blunder detection on 3...Nf6)
    const review = await analyzeGameHistory(lastRes.state, lb[0].elo, lb[1].elo)
    assert.equal(review.steps.length, 7)
    assert.ok(review.counts.b.Blunder >= 1 || review.counts.b.Mistake >= 1)
    assert.ok(review.whiteAccuracy >= 80)

    chess.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
