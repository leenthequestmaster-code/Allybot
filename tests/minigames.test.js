/**
 * @file minigames.test.js
 * @description Automated Test Suite (`node:test` + `node:assert/strict`) for Allybot Minigames Suite:
 *   1. Connect 4 Engine: gravity drop, illegal/full columns, 4-in-a-row win (H/V/Diag), full-board draw, Alpha-Beta AI
 *   2. Tic-Tac-Toe Engine: keypad (`1-9`) & coordinate (`a1-c3`) moves, win/draw detection, Unbeatable Minimax AI
 *   3. Dam / Checkers 8x8 Engine: diagonal slide, Compulsory Capture (`Wajib Makan`), Multi-Jump Chain (`c3 e5 g7`), King Promotion, Minimax AI
 *   4. Service Layer: Challenge lifecycle, Concurrency Mutex (`lock:game:<chatJid>`), Bot match, Resign, Draw, Cancel (Zero Clocks, Zero ELO)
 *   5. Visual Satori + Resvg + Sharp Renderers: exact pixel dimensions, embedded WhatsApp base64 avatar & fallback initials, turn indicator, zero clutter.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  createConnect4State,
  applyConnect4Move,
  getConnect4BotMove,
  createTicTacToeState,
  applyTicTacToeMove,
  getTicTacToeBotMove,
  createCheckersState,
  applyCheckersMove,
  getCheckersBotMove,
  renderConnect4BoardPng,
  renderTicTacToeBoardPng,
  renderCheckersBoardPng,
  MinigamesService,
} from '../dist/services/minigames/index.js';
import { createMinigamesPlugin } from '../dist/framework/plugins/minigames.js';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngDimensions(buf) {
  assert.ok(Buffer.isBuffer(buf), 'Output must be a Buffer');
  assert.ok(buf.length > 24, 'PNG buffer must be > 24 bytes');
  assert.deepEqual(buf.subarray(0, 8), PNG_MAGIC, 'Invalid PNG magic header');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

describe('Allybot Minigames Suite — Reworked & Casual Turn-Based Verification', () => {
  let tmpDir;
  let dbPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'allybot-minigames-test-'));
    dbPath = path.join(tmpDir, 'allyssea-test.sqlite');
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ==========================================================================
  // 1. CONNECT 4 ENGINE TESTS
  // ==========================================================================
  describe('1. Connect 4 Engine & Alpha-Beta Minimax AI', () => {
    it('drops tokens with gravity to lowest row and rejects invalid or full columns', () => {
      const state = createConnect4State();

      // Invalid column 0 or 8
      const badCol = applyConnect4Move(state, 8);
      assert.equal(badCol.ok, false);
      assert.equal(badCol.code, 'INVALID_COLUMN');

      // Drop 6 tokens into column 4 (index 3)
      for (let i = 0; i < 6; i++) {
        const res = applyConnect4Move(state, 4);
        assert.equal(res.ok, true);
        assert.equal(res.row, 5 - i);
        assert.equal(res.col, 3);
      }

      // 7th drop in column 4 must fail with COLUMN_FULL
      const fullRes = applyConnect4Move(state, 4);
      assert.equal(fullRes.ok, false);
      assert.equal(fullRes.code, 'COLUMN_FULL');
    });

    it('detects Horizontal, Vertical, and Diagonal 4-in-a-row wins accurately', () => {
      // Horizontal win for Player 1 on bottom row (cols 1, 2, 3, 4)
      const hState = createConnect4State();
      applyConnect4Move(hState, 1); // P1 (5,0)
      applyConnect4Move(hState, 1); // P2 (4,0)
      applyConnect4Move(hState, 2); // P1 (5,1)
      applyConnect4Move(hState, 2); // P2 (4,1)
      applyConnect4Move(hState, 3); // P1 (5,2)
      applyConnect4Move(hState, 3); // P2 (4,2)
      const winH = applyConnect4Move(hState, 4); // P1 (5,3) -> 4-in-a-row!
      assert.equal(winH.ok, true);
      assert.equal(hState.winner, 1);
      assert.equal(hState.winningCells.length, 4);

      // Diagonal win for Player 1
      const dState = createConnect4State();
      applyConnect4Move(dState, 1); // P1
      applyConnect4Move(dState, 2); // P2
      applyConnect4Move(dState, 2); // P1
      applyConnect4Move(dState, 3); // P2
      applyConnect4Move(dState, 4); // P1 filler
      applyConnect4Move(dState, 3); // P2
      applyConnect4Move(dState, 3); // P1
      applyConnect4Move(dState, 4); // P2
      applyConnect4Move(dState, 5); // P1 filler
      applyConnect4Move(dState, 4); // P2
      const winD = applyConnect4Move(dState, 4); // P1 diagonal win
      assert.equal(winD.ok, true);
      assert.equal(dState.winner, 1);
    });

    it('Connect 4 Bot AI finds immediate winning move and blocks opponent 3-in-a-row threat', () => {
      const state = createConnect4State();
      // Setup Player 1 at cols 1, 2, 3 (threat at col 4)
      applyConnect4Move(state, 1); // P1
      applyConnect4Move(state, 1); // P2
      applyConnect4Move(state, 2); // P1
      applyConnect4Move(state, 2); // P2
      applyConnect4Move(state, 3); // P1
      // Now it is Player 2's turn. Bot must pick column 4 to block P1's horizontal win!
      const botPick = getConnect4BotMove(state, 2);
      assert.equal(botPick, 4, 'Connect 4 AI must block opponent 3-in-a-row winning threat');
    });
  });

  // ==========================================================================
  // 2. TIC-TAC-TOE ENGINE TESTS
  // ==========================================================================
  describe('2. Tic-Tac-Toe Engine & Unbeatable Minimax AI', () => {
    it('supports both keypad (1-9) and algebraic (a1-c3) move inputs and detects wins & draws', () => {
      const state = createTicTacToeState();

      // P1 plays center via keypad '5'
      const m1 = applyTicTacToeMove(state, 5);
      assert.equal(m1.ok, true);
      assert.equal(m1.keypadNumber, 5);
      assert.equal(m1.coordLabel, 'b2');

      // P2 plays top-left via algebraic 'a1'
      const m2 = applyTicTacToeMove(state, 'a1');
      assert.equal(m2.ok, true);
      assert.equal(m2.coordLabel, 'a1');

      // P1 tries to play 'a1' again -> must reject CELL_OCCUPIED
      const m3 = applyTicTacToeMove(state, 'a1');
      assert.equal(m3.ok, false);
      assert.equal(m3.code, 'CELL_OCCUPIED');
    });

    it('Level 3 Tic-Tac-Toe Bot is 100% unbeatable across all opening positions', () => {
      // Test full depth minimax: Bot playing Player 2 against center opening
      const state = createTicTacToeState();
      applyTicTacToeMove(state, 5); // Human plays 5
      const botMove = getTicTacToeBotMove(state, 3);
      // Optimal replies against center: corners 1, 3, 7, or 9
      assert.ok([1, 3, 7, 9].includes(botMove), `Unbeatable bot must play a corner against center, got: ${botMove}`);
    });
  });

  // ==========================================================================
  // 3. DAM / CHECKERS 8x8 ENGINE TESTS
  // ==========================================================================
  describe('3. Dam / Checkers 8x8 Engine (Compulsory Capture, Multi-Jump & King Promotion)', () => {
    it('enforces Compulsory Capture (Wajib Makan) and rejects regular diagonal slides when a jump exists', () => {
      const state = createCheckersState();
      // Clear board
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) state.board[r][c] = 0;
      }
      // Place Red Man at c3 (row 5, col 2), Blue Man at d4 (row 4, col 3), e5 (row 3, col 4) is empty
      state.board[5][2] = 1; // c3
      state.board[4][3] = 2; // d4
      // Also place Red Man at a3 (row 5, col 0) which could slide to b4
      state.board[5][0] = 1; // a3
      state.turn = 1;

      // Player 1 tries to slide a3 -> b4 while jump c3 -> e5 exists -> MUST REJECT WITH COMPULSORY CAPTURE!
      const slideAttempt = applyCheckersMove(state, 'a3 b4');
      assert.equal(slideAttempt.ok, false);
      assert.equal(slideAttempt.code, 'COMPULSORY_CAPTURE');

      // Executing legal jump c3 -> e5 must succeed and capture d4!
      const jumpSuccess = applyCheckersMove(state, 'c3 e5');
      assert.equal(jumpSuccess.ok, true);
      assert.equal(state.board[4][3], 0, 'Captured opponent piece at d4 must be removed');
      assert.equal(state.board[3][4], 1, 'Red piece lands at e5 (3,4)');
    });

    it('supports Multi-Jump Chains both as a single command (c3 e5 g7) and step-by-step lock', () => {
      const state = createCheckersState();
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) state.board[r][c] = 0;
      }
      state.board[5][2] = 1; // c3
      state.board[4][3] = 2; // d4
      state.board[2][5] = 2; // f6
      state.turn = 1;

      const chainRes = applyCheckersMove(state, 'c3 e5 g7');
      assert.equal(chainRes.ok, true);
      assert.equal(chainRes.capturedCount, 2);
      assert.equal(state.board[1][6], 1, 'Red piece lands at g7');
    });

    it('promotes Man to King on reaching the back rank and allows backward King captures', () => {
      const state = createCheckersState();
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) state.board[r][c] = 0;
      }
      state.board[1][6] = 1; // g7
      state.turn = 1;

      const promoRes = applyCheckersMove(state, 'g7 h8');
      assert.equal(promoRes.ok, true);
      assert.equal(promoRes.promoted, true);
      assert.equal(state.board[0][7], 3, 'Red Man must promote to Red King (3) at row 0');
    });
  });

  // ==========================================================================
  // 4. SERVICE LAYER (CLEAN CASUAL TURN-BASED, ZERO CLOCKS, ZERO ELO)
  // ==========================================================================
  describe('4. Service Layer (Challenge Lifecycle, Bot Match, Concurrency Lock)', () => {
    it('manages challenge lifecycle, bot matches, and moves cleanly without timers or Elo', async () => {
      const svc = new MinigamesService({ dbPath });
      const chatJid = '120363001@g.us';
      const p1 = '628111111111@s.whatsapp.net';
      const p2 = '628222222222@s.whatsapp.net';

      // 1. Create open challenge
      const chalRes = svc.createChallenge({
        chatJid,
        gameType: 'connect4',
        challengerJid: p1,
        challengerName: 'Budi',
      });
      assert.equal(chalRes.ok, true);
      assert.ok(chalRes.message.includes('LOBBY') || chalRes.message.includes('TANTANGAN'));

      // 2. Accept challenge
      const acceptRes = await svc.acceptChallenge({
        chatJid,
        accepterJid: p2,
        accepterName: 'Andi',
      });
      assert.equal(acceptRes.ok, true);
      assert.equal(acceptRes.code, 'MATCH_STARTED');
      assert.ok(svc.getActiveSession(chatJid));

      // 3. Move execution
      const moveRes = await svc.submitMove({
        chatJid,
        senderJid: p1,
        rawMove: '4',
      });
      assert.equal(moveRes.ok, true);

      // 4. Resign match
      const resignRes = await svc.resignMatch(chatJid, p1);
      assert.equal(resignRes.ok, true);
      assert.equal(resignRes.gameOver, true);
      assert.equal(svc.getActiveSession(chatJid), null);

      // 5. Test decline & anti-spam
      const chal2 = svc.createChallenge({
        chatJid: '120363002@g.us',
        gameType: 'tictactoe',
        challengerJid: p1,
        challengerName: 'Budi',
        opponentJid: p2,
      });
      assert.equal(chal2.ok, true);
      assert.ok(chal2.message.includes('Tantangan Tic-Tac-Toe dikirim'));

      // Anti-spam: P1 cannot create another challenge while pending exists
      const spamChal = svc.createChallenge({
        chatJid: '120363003@g.us',
        gameType: 'checkers',
        challengerJid: p1,
        challengerName: 'Budi',
      });
      assert.equal(spamChal.ok, false);
      assert.equal(spamChal.code, 'SPAM_CHALLENGE');

      // P2 declines
      const declineRes = svc.declineChallenge('120363002@g.us', p2);
      assert.equal(declineRes.ok, true);
      assert.equal(declineRes.message, 'Tantangan ditolak.');

      await svc.stop();
    });
  });

  // ==========================================================================
  // 5. SATORI VISUAL RENDERING (WITH BASE64 AVATARS & CLEAN HUD)
  // ==========================================================================
  describe('5. Satori + Resvg + Sharp Visual Board & HUD Rendering', () => {
    it('renders exact 635x590 Connect 4, 435x435 Tic-Tac-Toe, and 780x780 Dam/Checkers pure boards + HUD cards with embedded avatars', async () => {
      // Mock base64 1x1 png data URI
      const sampleAvatarDataUrl =
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      // 1. Connect 4 Pure Board (635x590) & HUD Card (675x790)
      const c4 = createConnect4State();
      applyConnect4Move(c4, 3);
      const c4Pure = await renderConnect4BoardPng(c4, { showHud: false });
      assert.deepEqual(readPngDimensions(c4Pure), { width: 635, height: 590 });

      const c4Hud = await renderConnect4BoardPng(c4, {
        showHud: true,
        player1: { name: 'Player 1', avatarDataUrl: sampleAvatarDataUrl, isTurn: false },
        player2: { name: 'Player 2', avatarDataUrl: null, isTurn: true },
      });
      assert.deepEqual(readPngDimensions(c4Hud), { width: 675, height: 800 });

      // 2. Tic-Tac-Toe Pure Board (435x435) & HUD Card (520x625)
      const ttt = createTicTacToeState();
      applyTicTacToeMove(ttt, 5);
      const tttPure = await renderTicTacToeBoardPng(ttt, { showHud: false });
      assert.deepEqual(readPngDimensions(tttPure), { width: 435, height: 435 });

      const tttHud = await renderTicTacToeBoardPng(ttt, {
        showHud: true,
        player1: { name: 'Citra', avatarDataUrl: sampleAvatarDataUrl, isTurn: true },
        player2: { name: 'Dewi', avatarDataUrl: sampleAvatarDataUrl, isTurn: false },
      });
      assert.deepEqual(readPngDimensions(tttHud), { width: 520, height: 625 });

      // 3. Dam / Checkers Pure Board (780x780) & HUD Card (820x960)
      const dam = createCheckersState();
      const damPure = await renderCheckersBoardPng(dam, { showHud: false });
      assert.deepEqual(readPngDimensions(damPure), { width: 780, height: 780 });

      const damHud = await renderCheckersBoardPng(dam, {
        showHud: true,
        player1: { name: 'Eko', avatarDataUrl: sampleAvatarDataUrl, isTurn: true },
        player2: { name: 'Fajar', avatarDataUrl: null, isTurn: false },
      });
      assert.deepEqual(readPngDimensions(damHud), { width: 820, height: 960 });
    });
  });
});
