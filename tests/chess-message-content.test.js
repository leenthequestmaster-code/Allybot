import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ChessService } from '../dist/services/chess-service.js'
import { formatMoveCaption, playerTag } from '../dist/framework/plugins/chess.js'

const logger = pino({ level: 'silent' })

test('Chess Message Content: Clean formatting, zero raw JIDs, zero AI slop, and smart guidance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'allybot-chess-msg-'))
  try {
    const chess = new ChessService(join(dir, 'chess.sqlite'), logger)
    chess.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })

    const whiteJid = '628123456789@s.whatsapp.net'
    const blackJid = '628987654321@s.whatsapp.net'
    const botJid = 'bot:stockfish:2'
    const lidJid = '268848477552831@lid'

    // 1. Verify playerTag strips raw domains and formats as valid mention or clean name
    assert.equal(playerTag(whiteJid, 'Budi'), '@628123456789')
    assert.equal(playerTag(blackJid, 'Siti'), '@628987654321')
    assert.equal(playerTag(botJid), 'Bot Lv.2 (Casual)')
    assert.equal(playerTag(lidJid, 'Cyrus'), '@Cyrus')
    assert.ok(!playerTag(whiteJid).includes('@s.whatsapp.net'))
    assert.ok(!playerTag(lidJid).includes('@lid'))

    // 2. Start game: check initial move 0 caption
    const game = chess.createGame({
      chatJid: '120363000001@g.us',
      whiteJid,
      whiteName: 'Budi',
      blackJid,
      blackName: 'Siti',
      timeControl: 'blitz',
    })
    assert.ok(!('error' in game))

    const startCaption = formatMoveCaption(game)
    assert.ok(startCaption.includes('Game catur dimulai: @628123456789 (Putih) vs @628987654321 (Hitam).'))
    assert.ok(startCaption.includes('Giliran @628123456789 (Putih).'))
    assert.ok(!startCaption.includes('─꯭──꯭──'))
    assert.ok(!startCaption.includes('━━━━━━━━━━━━━━━━━━━━'))
    assert.ok(startCaption.split('\n').length <= 4)

    // 3. Valid move caption
    const move1 = chess.executeMove('120363000001@g.us', 'e4')
    assert.ok(!('error' in move1))
    const move1Caption = formatMoveCaption(move1.state, 'e4')
    assert.ok(move1Caption.includes('Giliran @628987654321 (Hitam). Langkah terakhir: e4.'))
    assert.ok(!move1Caption.includes('@s.whatsapp.net'))
    assert.ok(move1Caption.split('\n').length <= 3)

    // 4. Invalid move: wrong format guidance
    const badSyntax = chess.executeMove('120363000001@g.us', 'maju dong')
    assert.ok('error' in badSyntax)
    assert.ok(badSyntax.error.includes('Langkah tidak valid. Format salah.'))
    assert.ok(badSyntax.error.includes('Contoh: e4, Nf3, O-O, exd5.'))
    assert.ok(badSyntax.error.split('\n').length <= 3)

    // 5. Invalid move: backward pawn
    const move2 = chess.executeMove('120363000001@g.us', 'e5')
    assert.ok(!('error' in move2))
    const move3 = chess.executeMove('120363000001@g.us', 'd4')
    assert.ok(!('error' in move3))
    const move4 = chess.executeMove('120363000001@g.us', 'd6')
    assert.ok(!('error' in move4))

    // White tries to move pawn e4 backward to e3
    const backwardPawn = chess.executeMove('120363000001@g.us', 'e4e3')
    assert.ok('error' in backwardPawn)
    assert.ok(backwardPawn.error.includes('Pion tidak bisa mundur.'))
    assert.ok(backwardPawn.error.split('\n').length <= 3)

    // 6. Resign caption
    const resigned = chess.resignGame('120363000001@g.us', 'b')
    assert.ok(resigned)
    const resignCaption = formatMoveCaption(resigned.state, undefined, resigned.eloResult)
    assert.ok(resignCaption.includes('@628987654321 menyerah. @628123456789 menang.'))
    assert.ok(resignCaption.includes('Rating: Putih *432* (+32) | Hitam *368* (-32)'))
    assert.ok(resignCaption.split('\n').length <= 3)

    chess.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
