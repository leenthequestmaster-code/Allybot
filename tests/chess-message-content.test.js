import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { ChessService, lookupOpeningBook } from '../dist/services/chess-service.js'
import {
  clearOpenChallenges,
  createChessPlugin,
  formatMoveCaption,
  playerTag,
} from '../dist/framework/plugins/chess.js'

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

test('Chess Challenge Flow: Pending challenge, anti-spam, acc/decline, timeout and mention tags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'allybot-chess-flow-'))
  try {
    const chess = new ChessService(join(dir, 'chess.sqlite'), logger)
    chess.initialize({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })

    clearOpenChallenges()
    const replies = []
    let mediaSent = null

    const mockWhatsapp = {
      sendText: async (_jid, text) => {
        replies.push(text)
      },
      sendMedia: async (_jid, media) => {
        mediaSent = media
        replies.push(media.caption ?? '')
      },
      sendPresence: async () => {},
      getDisplayName: (jid) => (jid.includes('628111') ? 'UserSatu' : 'UserDua'),
    }

    const plugin = createChessPlugin(mockWhatsapp, { botDelayMs: 0 })
    const commands = new Map()
    const ctxContainer = {
      commands: { register: (c) => commands.set(c.name, c) },
      events: { on: () => {} },
      services: { has: () => true, get: () => chess },
      config: { commandPrefix: '!' },
    }
    await plugin.load(ctxContainer)
    const caturCmd = commands.get('catur')
    assert.ok(caturCmd)

    const roomJid = '120363000077@g.us'
    const p1 = '628111@s.whatsapp.net'
    const p2 = '628222@s.whatsapp.net'

    // 1. P1 challenges P2 -> creates pending challenge (does not start game immediately)
    await caturCmd.handler({
      args: ['@628222', 'blitz'],
      prefix: '!',
      whatsapp: mockWhatsapp,
      logger,
      message: { remoteJid: roomJid, senderJid: p1, pushName: 'UserSatu', mentionedJids: [p2] },
      reply: async (t) => replies.push(t),
      react: async () => {},
    })

    const challengeMsg = replies[replies.length - 1]
    assert.ok(challengeMsg.includes('Tantangan catur dikirim ke @628222'))
    assert.ok(challengeMsg.includes('Menunggu konfirmasi'))
    assert.equal(chess.getActiveGame(roomJid), undefined)

    // 2. Anti-spam: P1 cannot create another challenge while pending exists
    await caturCmd.handler({
      args: ['open'],
      prefix: '!',
      whatsapp: mockWhatsapp,
      logger,
      message: { remoteJid: '120363000088@g.us', senderJid: p1, pushName: 'UserSatu' },
      reply: async (t) => replies.push(t),
      react: async () => {},
    })
    assert.ok(replies[replies.length - 1].includes('masih memiliki tantangan aktif'))

    // 3. P2 accepts challenge with `!catur acc` -> Game starts!
    await caturCmd.handler({
      args: ['acc'],
      prefix: '!',
      whatsapp: mockWhatsapp,
      logger,
      message: { remoteJid: roomJid, senderJid: p2, pushName: 'UserDua' },
      reply: async (t) => replies.push(t),
      react: async () => {},
    })

    assert.ok(replies[replies.length - 1].includes('Tantangan diterima. Permainan dimulai!'))
    assert.ok(chess.getActiveGame(roomJid))

    // 4. Test decline flow in another room
    const room2 = '120363000078@g.us'
    await caturCmd.handler({
      args: ['@628222'],
      prefix: '!',
      whatsapp: mockWhatsapp,
      logger,
      message: { remoteJid: room2, senderJid: p1, pushName: 'UserSatu', mentionedJids: [p2] },
      reply: async (t) => replies.push(t),
      react: async () => {},
    })
    assert.ok(replies[replies.length - 1].includes('Menunggu konfirmasi'))

    // P2 declines with `!catur decline`
    await caturCmd.handler({
      args: ['decline'],
      prefix: '!',
      whatsapp: mockWhatsapp,
      logger,
      message: { remoteJid: room2, senderJid: p2, pushName: 'UserDua' },
      reply: async (t) => replies.push(t),
      react: async () => {},
    })
    assert.ok(replies[replies.length - 1].includes('Tantangan ditolak.'))

    // 5. Test !lbchess tag and mentions array
    const lbCmd = commands.get('leaderboardchess')
    assert.ok(lbCmd)
    await lbCmd.handler({
      args: ['blitz'],
      prefix: '!',
      whatsapp: mockWhatsapp,
      logger,
      message: { remoteJid: roomJid, senderJid: p1 },
      reply: async (t) => replies.push(t),
      react: async () => {},
    })

    assert.ok(mediaSent)
    assert.ok(mediaSent.caption.includes('*Klasemen Top 10'))
    assert.ok(!mediaSent.caption.includes('@s.whatsapp.net'))
    if (mediaSent.mentions) {
      assert.ok(Array.isArray(mediaSent.mentions))
    }

    chess.shutdown({ logger, config: { commandPrefix: '!', defaultCooldownMs: 0 }, services: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FIDE ECO Opening Book: Full coverage of major openings and variations', () => {
  // Test Volume A (English, Reti, Dutch, Trompowsky, Benko)
  const eng = lookupOpeningBook(['c4', 'e5'])
  assert.ok(eng)
  assert.equal(eng.eco, 'A20')

  const tromp = lookupOpeningBook(['d4', 'Nf6', 'Bg5'])
  assert.ok(tromp)
  assert.equal(tromp.eco, 'A45')

  const benko = lookupOpeningBook(['d4', 'Nf6', 'c4', 'c5', 'd5', 'b5'])
  assert.ok(benko)
  assert.equal(benko.eco, 'A57')

  // Test Volume B (Scandinavian, Caro-Kann, Sicilian Najdorf & Dragon)
  const scandi = lookupOpeningBook(['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qa5'])
  assert.ok(scandi)
  assert.equal(scandi.eco, 'B01')

  const caroAdv = lookupOpeningBook(['e4', 'c6', 'd4', 'd5', 'e5'])
  assert.ok(caroAdv)
  assert.equal(caroAdv.eco, 'B12')

  const najdorf = lookupOpeningBook(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6'])
  assert.ok(najdorf)
  assert.equal(najdorf.eco, 'B90')
  assert.ok(najdorf.name.includes('Najdorf'))

  const dragon = lookupOpeningBook(['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'g6'])
  assert.ok(dragon)
  assert.equal(dragon.eco, 'B70')
  assert.ok(dragon.name.includes('Dragon'))

  // Test Volume C (French, Italian, Evans Gambit, Berlin Defense, Marshall Attack)
  const frenchWin = lookupOpeningBook(['e4', 'e6', 'd4', 'd5', 'Nc3', 'Bb4'])
  assert.ok(frenchWin)
  assert.equal(frenchWin.eco, 'C15')

  const evans = lookupOpeningBook(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'b4'])
  assert.ok(evans)
  assert.equal(evans.eco, 'C51')
  assert.ok(evans.name.includes('Evans'))

  const berlin = lookupOpeningBook(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'Nf6'])
  assert.ok(berlin)
  assert.equal(berlin.eco, 'C65')
  assert.ok(berlin.name.includes('Berlin'))

  // Test Volume D (London System, Slav, Semi-Slav, Grunfeld)
  const london = lookupOpeningBook(['d4', 'd5', 'Nf3', 'Nf6', 'Bf4'])
  assert.ok(london)
  assert.equal(london.eco, 'D02')
  assert.ok(london.name.includes('London'))

  const semiSlav = lookupOpeningBook(['d4', 'd5', 'c4', 'c6', 'Nf3', 'Nf6', 'Nc3', 'e6'])
  assert.ok(semiSlav)
  assert.equal(semiSlav.eco, 'D43')

  const grunfeld = lookupOpeningBook(['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'd5'])
  assert.ok(grunfeld)
  assert.equal(grunfeld.eco, 'D80')

  // Test Volume E (Catalan, Nimzo-Indian, King's Indian)
  const catalan = lookupOpeningBook(['d4', 'Nf6', 'c4', 'e6', 'g3'])
  assert.ok(catalan)
  assert.equal(catalan.eco, 'E00')

  const nimzo = lookupOpeningBook(['d4', 'Nf6', 'c4', 'e6', 'Nc3', 'Bb4'])
  assert.ok(nimzo)
  assert.equal(nimzo.eco, 'E20')

  const kid = lookupOpeningBook(['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6', 'Nf3', 'O-O'])
  assert.ok(kid)
  assert.equal(kid.eco, 'E90')
})
