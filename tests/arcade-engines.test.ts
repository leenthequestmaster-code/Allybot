import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  BlackjackEngine,
  CashAndGunsEngine,
  HotPotatoEngine,
  KBBI_5_LETTER_WORDS,
  LUDO_FINISH_STEP,
  LmsQuizEngine,
  LudoEngine,
  SPEED_MONOPOLY_BOARD_16,
  SnakesAndLaddersEngine,
  SpeedMonopolyEngine,
  TAROT_DECK_78,
  TarotEngine,
  UnoEngine,
  WordleEngine,
  buildStandardDeck52,
  buildUnoDeck108,
  createAllArcadeEngines,
  createArcadeEngineRegistry,
  evaluateBlackjackHand,
  evaluateWordleGuess,
} from '../src/services/arcade/index.js';
import { ArcadeService } from '../src/services/arcade/arcade-service.js';
import { createArcadePlugin, isArcadeMoveOrDm } from '../src/framework/plugins/arcade.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOST = { jid: '6281110001@s.whatsapp.net', name: 'HostAndi', joinedAt: 1_700_000_000_000 };
const P2 = { jid: '6281110002@s.whatsapp.net', name: 'Budi', joinedAt: 1_700_000_001_000 };
const P3 = { jid: '6281110003@s.whatsapp.net', name: 'Citra', joinedAt: 1_700_000_002_000 };
const GROUP_JID = '120363000888@g.us';

test('0. Unified Registry & Contract Compliance Across All 10 Engines', () => {
  const engines = createAllArcadeEngines();
  assert.equal(engines.length, 10);

  const expectedTypes = [
    'wordle',
    'tarot',
    'hot_potato',
    'lms_quiz',
    'blackjack',
    'uno',
    'cash_and_guns',
    'ular_tangga',
    'ludo',
    'speed_monopoly',
  ];
  assert.deepEqual(
    engines.map((e) => e.gameType),
    expectedTypes,
  );

  for (const engine of engines) {
    assert.ok(['instant', 'grid', 'party', 'board', 'card'].includes(engine.category));
    assert.ok(engine.minPlayers >= 1);
    assert.ok(engine.maxPlayers >= engine.minPlayers);
    assert.ok(engine.defaultTurnTimeoutMs > 0);
    assert.equal(typeof engine.createInitialState, 'function');
    assert.equal(typeof engine.processAction, 'function');
    assert.equal(typeof engine.handleTurnTimeout, 'function');
  }

  const registry = createArcadeEngineRegistry();
  assert.equal(registry.wordle.gameType, 'wordle');
  assert.equal(registry.speed_monopoly.gameType, 'speed_monopoly');
});

test('1. WordleEngine: 5-Letter KBBI Dictionary, Duplicate-Letter Evaluation & 6-Attempt Lifecycle', () => {
  assert.ok(KBBI_5_LETTER_WORDS.length >= 100);
  assert.ok(KBBI_5_LETTER_WORDS.every((w) => /^[A-Z]{5}$/.test(w)));

  // Verify two-pass duplicate letter evaluation: Target = "PAPAN", Guess = "PAPAP"
  // P(0)=correct, A(1)=correct, P(2)=correct, A(3)=correct, P(4)=absent (only two P's in PAPAN!)
  const evalCells = evaluateWordleGuess('PAPAP', 'PAPAN');
  assert.deepEqual(
    evalCells.map((c) => c.status),
    ['correct', 'correct', 'correct', 'correct', 'absent'],
  );

  const engine = new WordleEngine();
  let state = engine.createInitialState({
    gameId: 'wd-1',
    groupJid: GROUP_JID,
    host: HOST,
    customConfig: { targetWord: 'CATUR' },
  });

  // Invalid length rejected
  const bad = engine.processAction(state, {
    type: 'GUESS',
    playerJid: HOST.jid,
    payload: { word: 'CAT' },
  });
  assert.equal(bad.success, false);

  // First guess: "CAMAT" -> C(🟩), A(🟩), M(⬛), A(⬛), T(🟨)
  const g1 = engine.processAction(state, {
    type: 'GUESS',
    playerJid: HOST.jid,
    payload: { word: 'CAMAT' },
  });
  assert.equal(g1.success, true);
  assert.equal(g1.isGameOver, false);
  assert.equal(g1.state.attempts[0].emojiRow, '🟩🟩⬛⬛🟨');
  state = g1.state;

  // Winning guess: "CATUR"
  const g2 = engine.processAction(state, {
    type: 'GUESS',
    playerJid: P2.jid,
    payload: { word: 'CATUR', playerName: 'Budi' },
  });
  assert.equal(g2.success, true);
  assert.equal(g2.isGameOver, true);
  assert.deepEqual(g2.winnerJids, [P2.jid]);
  assert.equal(g2.state.status, 'won');
});

test('2. TarotEngine: 78-Card Major & Minor Arcana Deck, 1-Card & 3-Card Spreads + Upright/Reversed', () => {
  assert.equal(TAROT_DECK_78.length, 78);
  const majorCount = TAROT_DECK_78.filter((c) => c.arcana === 'major').length;
  const minorCount = TAROT_DECK_78.filter((c) => c.arcana === 'minor').length;
  assert.equal(majorCount, 22);
  assert.equal(minorCount, 56);

  const engine = new TarotEngine();
  const state1 = engine.createInitialState({
    gameId: 'tr-1',
    groupJid: GROUP_JID,
    host: HOST,
    customConfig: { seed: 42 },
  });

  // Draw 3-card spread (Masa Lalu, Sekarang, Masa Depan)
  const res3 = engine.processAction(state1, {
    type: 'DRAW',
    playerJid: HOST.jid,
    payload: { spreadType: 'three', question: 'Bagaimana karir tahun ini?' },
  });
  assert.equal(res3.success, true);
  assert.equal(res3.isGameOver, true);
  assert.equal(res3.state.drawnCards.length, 3);
  assert.deepEqual(
    res3.state.drawnCards.map((d) => d.positionLabel),
    ['Masa Lalu', 'Sekarang', 'Masa Depan'],
  );
  for (const d of res3.state.drawnCards) {
    assert.ok(d.orientation === 'tegak' || d.orientation === 'terbalik');
    assert.ok(d.activeMeaning.length > 10);
  }
});

test('3. HotPotatoEngine: 30-75s Random Fuse, .pass @target Relay & Explosion Elimination', () => {
  const engine = new HotPotatoEngine();
  let state = engine.createInitialState({
    gameId: 'hp-1',
    groupJid: GROUP_JID,
    host: HOST,
    customConfig: { seed: 101 },
  });

  state = engine.processAction(state, {
    type: 'JOIN',
    playerJid: P2.jid,
    payload: { playerName: P2.name },
  }).state;
  state = engine.processAction(state, {
    type: 'JOIN',
    playerJid: P3.jid,
    payload: { playerName: P3.name },
  }).state;

  const startMs = 1_700_000_000_000;
  const started = engine.processAction(state, {
    type: 'START',
    playerJid: HOST.jid,
    payload: { nowMs: startMs },
  });
  assert.equal(started.success, true);
  state = started.state;

  // Verify random timer is strictly between 30,000ms and 75,000ms
  assert.ok(state.fuseDurationMs >= 30_000 && state.fuseDurationMs <= 75_000);
  const firstHolder = state.currentHolderJid;
  assert.ok(firstHolder);

  const otherAlive = state.players.find((p) => p.jid !== firstHolder);

  // Pass bomb to otherAlive before timer expires
  const passRes = engine.processAction(state, {
    type: 'PASS',
    playerJid: firstHolder,
    payload: { targetJid: otherAlive.jid, nowMs: startMs + 5_000 },
  });
  assert.equal(passRes.success, true);
  assert.equal(passRes.state.currentHolderJid, otherAlive.jid);
  state = passRes.state;

  // Timeout triggers explosion on current holder (otherAlive) -> 2 players left -> Round 2 starts
  const boom1 = engine.handleTurnTimeout(state);
  assert.equal(boom1.success, true);
  assert.equal(boom1.isGameOver, false);
  assert.equal(boom1.state.round, 2);
  const eliminatedPlayer = boom1.state.players.find((p) => p.jid === otherAlive.jid);
  assert.equal(eliminatedPlayer?.isEliminated, true);
  state = boom1.state;

  // Second explosion eliminates the 2nd player -> Last Man Standing wins!
  const boom2 = engine.handleTurnTimeout(state);
  assert.equal(boom2.success, true);
  assert.equal(boom2.isGameOver, true);
  assert.equal(boom2.winnerJids?.length, 1);
});

test('4. LmsQuizEngine: Secret DM Answers Enforcement, Mercy Rule & Knockout Victory', () => {
  const engine = new LmsQuizEngine();
  let state = engine.createInitialState({
    gameId: 'lms-1',
    groupJid: GROUP_JID,
    host: HOST,
    customConfig: { seed: 7 },
  });

  state = engine.processAction(state, {
    type: 'JOIN',
    playerJid: P2.jid,
    payload: { playerName: P2.name },
  }).state;

  state = engine.processAction(state, {
    type: 'START',
    playerJid: HOST.jid,
  }).state;
  assert.equal(state.status, 'question_open');
  const q1Correct = state.currentQuestion.correctOption;
  const q1Wrong = q1Correct === 'A' ? 'B' : 'A';

  // Non-DM answer in group chat MUST be rejected
  const groupAttempt = engine.processAction(state, {
    type: 'ANSWER',
    playerJid: HOST.jid,
    isDirectMessage: false,
    payload: { choice: q1Correct },
  });
  assert.equal(groupAttempt.success, false);
  assert.ok(groupAttempt.error?.includes('DM'));

  // Test Mercy Rule: both players answer wrong via DM -> neither is eliminated!
  state = engine.processAction(state, {
    type: 'ANSWER',
    playerJid: HOST.jid,
    isDirectMessage: true,
    payload: { choice: q1Wrong },
  }).state;
  const mercyRound = engine.processAction(state, {
    type: 'ANSWER',
    playerJid: P2.jid,
    isDirectMessage: true,
    payload: { choice: q1Wrong },
  });
  assert.equal(mercyRound.success, true);
  assert.equal(mercyRound.isGameOver, false);
  assert.equal(mercyRound.state.round, 2);
  assert.ok(mercyRound.state.players.every((p) => !p.isEliminated));
  state = mercyRound.state;

  // Round 2: HOST answers correctly via DM, P2 answers wrong via DM -> HOST wins!
  const q2Correct = state.currentQuestion.correctOption;
  const q2Wrong = q2Correct === 'A' ? 'B' : 'A';
  state = engine.processAction(state, {
    type: 'ANSWER',
    playerJid: HOST.jid,
    isDirectMessage: true,
    payload: { choice: q2Correct },
  }).state;
  const finalRound = engine.processAction(state, {
    type: 'ANSWER',
    playerJid: P2.jid,
    isDirectMessage: true,
    payload: { choice: q2Wrong },
  });
  assert.equal(finalRound.success, true);
  assert.equal(finalRound.isGameOver, true);
  assert.deepEqual(finalRound.winnerJids, [HOST.jid]);
});

test('5. BlackjackEngine: 52-Card Shoe, Natural 3:2 Payout, Double Down & Dealer AI Hits to 17', () => {
  const deck52 = buildStandardDeck52();
  assert.equal(deck52.length, 52);

  // Soft Ace evaluation check: A + 6 = 17 (soft), A + 6 + 10 = 17 (hard)
  assert.equal(
    evaluateBlackjackHand([
      { rank: 'A', suit: '♠', code: 'A♠' },
      { rank: '6', suit: '♥', code: '6♥' },
    ]).total,
    17,
  );
  assert.equal(
    evaluateBlackjackHand([
      { rank: 'A', suit: '♠', code: 'A♠' },
      { rank: '6', suit: '♥', code: '6♥' },
      { rank: '10', suit: '♦', code: '10♦' },
    ]).total,
    17,
  );

  const engine = new BlackjackEngine();

  // Case A: Natural Blackjack pays 3:2 (bet 100 -> netDelta +150, totalPayout 250)
  const bjShoe = [
    { rank: 'A', suit: '♠', code: 'A♠' }, // Player card 1
    { rank: '9', suit: '♣', code: '9♣' }, // Dealer upcard
    { rank: 'K', suit: '♠', code: 'K♠' }, // Player card 2 -> 21 Blackjack!
    { rank: '8', suit: '♦', code: '8♦' }, // Dealer hole card -> 17
    ...deck52,
  ];
  const naturalState = engine.createInitialState({
    gameId: 'bj-nat',
    groupJid: GROUP_JID,
    host: HOST,
    wagerAmount: 100,
    customConfig: { shoe: bjShoe },
  });
  assert.equal(naturalState.status, 'finished');
  assert.equal(naturalState.seats[0].outcome, 'blackjack_3_2');
  assert.equal(naturalState.seats[0].netDelta, 150);
  assert.equal(naturalState.seats[0].totalPayout, 250);

  // Case B: Player Double Down (11 -> draws 9 = 20) vs Dealer 16 -> Dealer AI hits 2 -> 18 -> Player wins 2x bet!
  const doubleShoe = [
    { rank: '5', suit: '♠', code: '5♠' }, // Player card 1
    { rank: '10', suit: '♣', code: '10♣' }, // Dealer upcard
    { rank: '6', suit: '♥', code: '6♥' }, // Player card 2 (total 11)
    { rank: '6', suit: '♦', code: '6♦' }, // Dealer hole card (total 16)
    { rank: '9', suit: '♠', code: '9♠' }, // Player double-down draw (total 20)
    { rank: '2', suit: '♣', code: '2♣' }, // Dealer hit draw (16 + 2 = 18 >= 17, stands)
    ...deck52,
  ];
  const game2 = engine.createInitialState({
    gameId: 'bj-dbl',
    groupJid: GROUP_JID,
    host: HOST,
    wagerAmount: 100,
    customConfig: { shoe: doubleShoe },
  });
  assert.equal(game2.status, 'player_turns');
  const dblRes = engine.processAction(game2, {
    type: 'DOUBLE',
    playerJid: HOST.jid,
  });
  assert.equal(dblRes.success, true);
  assert.equal(dblRes.isGameOver, true);
  assert.equal(dblRes.state.seats[0].bet, 200);
  assert.equal(dblRes.state.seats[0].netDelta, 200);
  assert.equal(evaluateBlackjackHand(dblRes.state.dealerCards).total, 18);
});

test('6. UnoEngine: 108-Card Official Deck, Discard Validation, Action Cards & Victory', () => {
  const unoDeck = buildUnoDeck108();
  assert.equal(unoDeck.length, 108);

  const engine = new UnoEngine();
  let state = engine.createInitialState({
    gameId: 'uno-1',
    groupJid: GROUP_JID,
    host: HOST,
    customConfig: { seed: 99 },
  });
  state = engine.processAction(state, {
    type: 'JOIN',
    playerJid: P2.jid,
    payload: { playerName: P2.name },
  }).state;

  const started = engine.processAction(state, {
    type: 'START',
    playerJid: HOST.jid,
  });
  assert.equal(started.success, true);
  assert.equal(started.directMessages?.length, 2);
  state = started.state;
  assert.equal(state.hands[HOST.jid].length, 7);
  assert.equal(state.hands[P2.jid].length, 7);

  // Set controlled hand for HOST to test invalid card rejection, Wild+4, and winning last card
  state.activeColor = 'red';
  state.discardPile = [{ id: 'TOP-R5', color: 'red', value: '5', label: 'R-5' }];
  state.hands[HOST.jid] = [
    { id: 'C-B9', color: 'blue', value: '9', label: 'B-9' }, // Invalid on Red 5
    { id: 'C-W4', color: 'wild', value: 'wild_draw4', label: 'WILD+4' },
    { id: 'C-G2', color: 'green', value: '2', label: 'G-2' },
  ];

  // Playing Blue 9 on Red 5 must fail
  const invalidPlay = engine.processAction(state, {
    type: 'PLAY_CARD',
    playerJid: HOST.jid,
    payload: { cardId: 'C-B9' },
  });
  assert.equal(invalidPlay.success, false);

  // Playing WILD+4 and choosing 'green' skips P2 (in 2-player mode, turn comes back to HOST!) and forces P2 to draw 4 cards
  const w4Play = engine.processAction(state, {
    type: 'PLAY_CARD',
    playerJid: HOST.jid,
    payload: { cardId: 'C-W4', chosenColor: 'green' },
  });
  assert.equal(w4Play.success, true);
  assert.equal(w4Play.state.activeColor, 'green');
  assert.equal(w4Play.state.hands[P2.jid].length, 11);
  assert.equal(w4Play.state.players[w4Play.state.currentTurnIndex].jid, HOST.jid);
  state = w4Play.state;

  // Remove C-B9 so G-2 is HOST's last card and win the game!
  state.hands[HOST.jid] = [{ id: 'C-G2', color: 'green', value: '2', label: 'G-2' }];
  const winPlay = engine.processAction(state, {
    type: 'PLAY_CARD',
    playerJid: HOST.jid,
    payload: { cardId: 'C-G2' },
  });
  assert.equal(winPlay.success, true);
  assert.equal(winPlay.isGameOver, true);
  assert.deepEqual(winPlay.winnerJids, [HOST.jid]);
});

test('7. CashAndGunsEngine: Secret DM Aiming, Stand/Duck Courage Phase, Click/Bang Wounds & Loot Split', () => {
  const engine = new CashAndGunsEngine();
  let state = engine.createInitialState({
    gameId: 'cg-1',
    groupJid: GROUP_JID,
    host: HOST,
    customConfig: { seed: 55, maxRounds: 1 },
  });
  state = engine.processAction(state, { type: 'JOIN', playerJid: P2.jid, payload: { playerName: P2.name } }).state;
  state = engine.processAction(state, { type: 'JOIN', playerJid: P3.jid, payload: { playerName: P3.name } }).state;

  state = engine.processAction(state, { type: 'START', playerJid: HOST.jid }).state;
  assert.equal(state.status, 'aiming');
  const pot = state.currentLootPot;
  assert.ok(pot >= 40_000);

  // Reject non-DM AIM
  const publicAim = engine.processAction(state, {
    type: 'AIM',
    playerJid: HOST.jid,
    isDirectMessage: false,
    payload: { targetJid: P2.jid, bullet: 'BANG' },
  });
  assert.equal(publicAim.success, false);

  // Secret DM Aims:
  // HOST aims BANG at P2
  // P2 aims CLICK at P3
  // P3 aims BANG at HOST
  state = engine.processAction(state, {
    type: 'AIM',
    playerJid: HOST.jid,
    isDirectMessage: true,
    payload: { targetJid: P2.jid, bullet: 'BANG' },
  }).state;
  state = engine.processAction(state, {
    type: 'AIM',
    playerJid: P2.jid,
    isDirectMessage: true,
    payload: { targetJid: P3.jid, bullet: 'CLICK' },
  }).state;
  const aimDone = engine.processAction(state, {
    type: 'AIM',
    playerJid: P3.jid,
    isDirectMessage: true,
    payload: { targetJid: HOST.jid, bullet: 'BANG' },
  });
  assert.equal(aimDone.success, true);
  assert.equal(aimDone.state.status, 'courage');
  state = aimDone.state;

  // Courage decisions:
  // HOST stands, P2 ducks (dodges HOST's BANG!), P3 stands (shoots HOST with BANG!)
  state = engine.processAction(state, {
    type: 'COURAGE',
    playerJid: HOST.jid,
    payload: { decision: 'STAND' },
  }).state;
  state = engine.processAction(state, {
    type: 'COURAGE',
    playerJid: P2.jid,
    payload: { decision: 'DUCK' },
  }).state;
  const resolved = engine.processAction(state, {
    type: 'COURAGE',
    playerJid: P3.jid,
    payload: { decision: 'STAND' },
  });

  assert.equal(resolved.success, true);
  assert.equal(resolved.isGameOver, true); // maxRounds = 1
  const hostAfter = resolved.state.players.find((p) => p.jid === HOST.jid);
  const p2After = resolved.state.players.find((p) => p.jid === P2.jid);
  const p3After = resolved.state.players.find((p) => p.jid === P3.jid);

  assert.equal(hostAfter.wounds, 1); // Shot by P3
  assert.equal(p2After.wounds, 0); // Ducked!
  assert.equal(p2After.score, 0); // Ducked players get no loot
  assert.equal(hostAfter.score, Math.floor(pot / 2));
  assert.equal(p3After.score, Math.floor(pot / 2));
});

test('8. SnakesAndLaddersEngine: Ladders, Snakes, Bounce-Back at 100 & Exact-100 Victory', () => {
  const engine = new SnakesAndLaddersEngine();
  let state = engine.createInitialState({
    gameId: 'ut-1',
    groupJid: GROUP_JID,
    host: HOST,
    customConfig: { seed: 12 },
  });
  state = engine.processAction(state, { type: 'JOIN', playerJid: P2.jid, payload: { playerName: P2.name } }).state;
  state = engine.processAction(state, { type: 'START', playerJid: HOST.jid }).state;

  // 1. HOST rolls 4 -> lands on square 4 (Ladder 4 -> 25!)
  const r1 = engine.processAction(state, {
    type: 'ROLL',
    playerJid: HOST.jid,
    payload: { forcedDice: 4 },
  });
  assert.equal(r1.success, true);
  assert.equal(r1.state.positions[HOST.jid], 25);
  assert.equal(r1.state.lastMove?.event, 'ladder');
  state = r1.state;

  // 2. Place P2 at 97 and roll 5 -> 97 + 5 = 102 -> bounces back to 98 -> Snake at 98 slides down to 28!
  state.positions[P2.jid] = 97;
  const r2 = engine.processAction(state, {
    type: 'ROLL',
    playerJid: P2.jid,
    payload: { forcedDice: 5 },
  });
  assert.equal(r2.success, true);
  assert.equal(r2.state.positions[P2.jid], 28);
  assert.equal(r2.state.lastMove?.event, 'bounce_snake');
  state = r2.state;

  // 3. Place HOST at 96 and roll 4 -> Exact 100 -> Win!
  state.positions[HOST.jid] = 96;
  const r3 = engine.processAction(state, {
    type: 'ROLL',
    playerJid: HOST.jid,
    payload: { forcedDice: 4 },
  });
  assert.equal(r3.success, true);
  assert.equal(r3.isGameOver, true);
  assert.deepEqual(r3.winnerJids, [HOST.jid]);
  assert.equal(r3.state.positions[HOST.jid], 100);
});

test('9. LudoEngine: Exit Base on 6, Capture Opponent Token & Reach Finish', () => {
  const engine = new LudoEngine();
  let state = engine.createInitialState({
    gameId: 'ludo-1',
    groupJid: GROUP_JID,
    host: HOST,
    customConfig: { tokensPerPlayer: 2, seed: 33 },
  });
  state = engine.processAction(state, { type: 'JOIN', playerJid: P2.jid, payload: { playerName: P2.name } }).state;
  state = engine.processAction(state, { type: 'START', playerJid: HOST.jid }).state;

  // Rolling 4 while all tokens are in BASE (-1) cannot move -> turn passes to P2
  const noExit = engine.processAction(state, {
    type: 'ROLL',
    playerJid: HOST.jid,
    payload: { forcedDice: 4 },
  });
  assert.equal(noExit.success, true);
  assert.equal(noExit.state.tokens[HOST.jid][0].step, -1);
  assert.equal(noExit.state.currentTurnIndex, 1);
  state = noExit.state;

  // P2 rolls 6 -> exits base to step 0 (Global square 13 for GREEN) and gets bonus turn!
  const p2Exit = engine.processAction(state, {
    type: 'ROLL',
    playerJid: P2.jid,
    payload: { forcedDice: 6 },
  });
  assert.equal(p2Exit.success, true);
  assert.equal(p2Exit.state.tokens[P2.jid][0].step, 0);
  assert.equal(p2Exit.state.currentTurnIndex, 1); // Bonus turn on 6!
  state = p2Exit.state;

  // P2 rolls 2 -> advances token 0 to step 2 (Global square 15, non-safe)
  state = engine.processAction(state, {
    type: 'ROLL',
    playerJid: P2.jid,
    payload: { forcedDice: 2, tokenIndex: 0 },
  }).state;
  assert.equal(state.tokens[P2.jid][0].step, 2);
  assert.equal(state.currentTurnIndex, 0); // Back to HOST (RED)

  // Place HOST token 0 at step 11 (Global 11) and roll 4 -> lands on step 15 (Global 15) -> Captures P2 token 0!
  state.tokens[HOST.jid][0].step = 11;
  const captureRes = engine.processAction(state, {
    type: 'ROLL',
    playerJid: HOST.jid,
    payload: { forcedDice: 4, tokenIndex: 0 },
  });
  assert.equal(captureRes.success, true);
  assert.equal(captureRes.state.tokens[HOST.jid][0].step, 15);
  assert.equal(captureRes.state.tokens[P2.jid][0].step, -1); // Captured back to BASE!
  assert.equal(captureRes.state.currentTurnIndex, 0); // Bonus roll for capture!
  state = captureRes.state;

  // Put both HOST tokens near finish (56 and 54) and roll 2 -> Wins game!
  state.tokens[HOST.jid][0].step = LUDO_FINISH_STEP;
  state.tokens[HOST.jid][1].step = 54;
  const winRes = engine.processAction(state, {
    type: 'ROLL',
    playerJid: HOST.jid,
    payload: { forcedDice: 2, tokenIndex: 1 },
  });
  assert.equal(winRes.success, true);
  assert.equal(winRes.isGameOver, true);
  assert.deepEqual(winRes.winnerJids, [HOST.jid]);
});

test('10. SpeedMonopolyEngine: 16 Tiles, 4 Color Groups, Buy, Monopoly Rent, Upgrade & 15-Round Cap', () => {
  assert.equal(SPEED_MONOPOLY_BOARD_16.length, 16);
  const propCount = SPEED_MONOPOLY_BOARD_16.filter((t) => t.kind === 'PROPERTY').length;
  assert.equal(propCount, 8);

  const engine = new SpeedMonopolyEngine();
  let state = engine.createInitialState({
    gameId: 'sm-1',
    groupJid: GROUP_JID,
    host: HOST,
    customConfig: { maxRounds: 2, startingCash: 1000, seed: 88 },
  });
  state = engine.processAction(state, { type: 'JOIN', playerJid: P2.jid, payload: { playerName: P2.name } }).state;
  state = engine.processAction(state, { type: 'START', playerJid: HOST.jid }).state;

  // Round 1, Turn 1: HOST rolls 1 -> lands on Tile 1 (Medan Baru, BROWN, $100) and buys it
  state = engine.processAction(state, {
    type: 'ROLL',
    playerJid: HOST.jid,
    payload: { forcedDice: 1 },
  }).state;
  assert.equal(state.turnPhase, 'awaiting_buy_decision');
  state = engine.processAction(state, {
    type: 'BUY',
    playerJid: HOST.jid,
  }).state;
  assert.equal(state.properties[1]?.ownerJid, HOST.jid);
  assert.equal(state.cash[HOST.jid], 900);

  // Give HOST Tile 3 (Malioboro Jogja, BROWN) as well so HOST owns the full BROWN monopoly group
  state.properties[3] = { ownerJid: HOST.jid, houses: 0 };

  // Round 1, Turn 2: P2 rolls 3 -> lands on Tile 3 (Malioboro, Base Rent $45, doubled to $90 for Monopoly!)
  const p2Roll = engine.processAction(state, {
    type: 'ROLL',
    playerJid: P2.jid,
    payload: { forcedDice: 3 },
  });
  assert.equal(p2Roll.success, true);
  assert.equal(p2Roll.state.cash[P2.jid], 1000 - 90);
  assert.equal(p2Roll.state.cash[HOST.jid], 900 + 90);
  assert.equal(p2Roll.state.round, 2);
  state = p2Roll.state;

  // Round 2, Turn 1: HOST upgrades Tile 1 (Medan Baru, upgradeCost $60) then rolls 3 (lands on Tile 4 Tax -$100)
  const upg = engine.processAction(state, {
    type: 'UPGRADE',
    playerJid: HOST.jid,
    payload: { tileIndex: 1 },
  });
  assert.equal(upg.success, true);
  assert.equal(upg.state.properties[1].houses, 1);
  state = upg.state;

  state = engine.processAction(state, {
    type: 'ROLL',
    playerJid: HOST.jid,
    payload: { forcedDice: 3 },
  }).state;

  // Round 2, Turn 2: P2 rolls 5 -> lands on Tile 8 (Free Parking Jackpot!) -> End of Round 2 (maxRounds=2) -> Game Over!
  const finalTurn = engine.processAction(state, {
    type: 'ROLL',
    playerJid: P2.jid,
    payload: { forcedDice: 5 },
  });
  assert.equal(finalTurn.success, true);
  assert.equal(finalTurn.isGameOver, true);
  assert.ok((finalTurn.winnerJids?.length ?? 0) >= 1);
});

test('11. Full-Stack Integration: ArcadeService, DM-to-Group Router, Satori PNG Renderer & Plugin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'allybot-arcade-svc-'));
  try {
    const dbPath = join(dir, 'allybot-arcade.sqlite');
    const service = new ArcadeService({ dbPath, enableAutoTimers: false });

    // 1. Start LMS Quiz in group
    const startOut = await service.startGame({
      groupJid: GROUP_JID,
      gameType: 'lms_quiz',
      hostJid: HOST.jid,
      hostName: HOST.name,
      renderPng: true,
    });
    assert.ok(startOut.handled);
    assert.ok(service.getActiveSession(GROUP_JID));
    assert.ok(startOut.boardPng);

    // P2 joins
    const joinOut = await service.dispatchAction({
      groupJid: GROUP_JID,
      action: {
        type: 'JOIN',
        playerJid: P2.jid,
        payload: { playerName: P2.name },
      },
      renderPng: true,
    });
    assert.ok(joinOut.result?.success);

    // Host starts question
    const roundOut = await service.dispatchAction({
      groupJid: GROUP_JID,
      action: {
        type: 'START',
        playerJid: HOST.jid,
      },
      renderPng: true,
    });
    assert.ok(roundOut.result?.success);

    const activeSession = service.getActiveSession(GROUP_JID);
    assert.ok(activeSession);
    assert.equal(activeSession.state.status, 'question_open');
    const correctAns = activeSession.state.currentQuestion.correctOption;
    const wrongAns = correctAns === 'A' ? 'B' : 'A';

    // Verify anti-collision guard detects secret DM answer
    assert.equal(
      isArcadeMoveOrDm(service, {
        remoteJid: HOST.jid,
        senderJid: HOST.jid,
        text: correctAns,
        isDirectMessage: true,
      }),
      true,
    );

    // 2. Players send secret answers via DM
    const hostDm = await service.dispatchDirectMessageAction({
      senderJid: HOST.jid,
      text: correctAns,
      renderPng: true,
    });
    assert.ok(hostDm.handled);

    const p2Dm = await service.dispatchDirectMessageAction({
      senderJid: P2.jid,
      text: wrongAns,
      renderPng: true,
    });
    assert.ok(p2Dm.handled);

    // Game should be finished, HOST won, and leaderboard updated in SQLite!
    assert.equal(service.getActiveSession(GROUP_JID), undefined);
    const lb = service.getLeaderboard(10);
    assert.equal(lb.length, 2);
    assert.equal(lb[0].userJid, HOST.jid);
    assert.equal(lb[0].totalWins, 1);

    service.shutdown();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
