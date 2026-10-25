/**
 * @file minigames-service.ts
 * @description Unified Service Layer for Allybot Minigames Suite (Connect 4, Tic-Tac-Toe, Dam/Checkers 8x8).
 * Features:
 *   - Redis 8 Concurrency Mutex (`lock:game:<chatJid>`, SET NX PX 5000) with In-Memory Fallback
 *   - Native WhatsApp Profile Picture (PP WA) avatar extraction & base64 embedding
 *   - Clean casual turn-based play (zero clocks, zero Elo, zero ranking fluff)
 *   - Seamless PvP Challenge Lobby & PvE Bot AI Execution
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { WhatsAppPort } from '../../framework/contracts.js';
import {
  type MinigameType,
  type BotDifficulty,
  type PlayerSlot,
  type Connect4State,
  type TicTacToeState,
  type CheckersState,
  type CheckersCoord,
  createConnect4State,
  applyConnect4Move,
  getConnect4BotMove,
  parseConnect4MoveInput,
  createTicTacToeState,
  applyTicTacToeMove,
  getTicTacToeBotMove,
  parseTicTacToeMoveInput,
  indexToTicTacToeCoord,
  createCheckersState,
  applyCheckersMove,
  getCheckersBotMove,
  parseCheckersMoveTokens,
  coordToCheckersAlgebraic,
} from './minigames-engine.js';
import {
  renderConnect4BoardPng,
  renderTicTacToeBoardPng,
  renderCheckersBoardPng,
  type BoardRenderOptions,
  type HudPlayerInfo,
} from './minigames-renderer.js';

export const BOT_JID = 'allybot@s.whatsapp.net';

export const BOT_PROFILES: Record<
  BotDifficulty,
  { level: BotDifficulty; name: string; title: string }
> = {
  1: { level: 1, name: 'AllyBot (Novice)', title: 'AI Level 1 (Mudah)' },
  2: { level: 2, name: 'AllyBot (Tactical)', title: 'AI Level 2 (Sedang)' },
  3: { level: 3, name: 'AllyBot (Master)', title: 'AI Level 3 (Sulit)' },
};

export interface RedisLikeClient {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean>;
  del(key: string): Promise<boolean>;
}

export interface PendingMinigameChallenge {
  id: string;
  chatJid: string;
  gameType: MinigameType;
  challengerJid: string;
  challengerName: string;
  opponentJid: string | null; // null = open challenge
  createdAt: number;
}

export type AnyMinigameBoardState = Connect4State | TicTacToeState | CheckersState;

export interface ActiveMinigameSession {
  matchId: string;
  chatJid: string;
  gameType: MinigameType;
  isBotMatch: boolean;
  botDifficulty: BotDifficulty | null;
  p1Jid: string;
  p1Name: string;
  p2Jid: string;
  p2Name: string;
  createdAt: number;
  lastMoveAt: number;
  drawOfferedBy: PlayerSlot | null;
  lastBoardMessageId: string | null;
  state: AnyMinigameBoardState;
}

export interface MinigameActionResponse {
  ok: boolean;
  code?: string;
  message: string;
  mentions?: string[];
  boardPng?: Buffer;
  session?: ActiveMinigameSession;
  gameOver?: boolean;
  aborted?: boolean;
  winner?: PlayerSlot | 'draw' | null;
  winReason?: string;
  botMoveNotation?: string | null;
}

export interface MinigamesServiceOptions {
  dbPath?: string;
  redis?: RedisLikeClient | null;
  lockTtlMs?: number;
}

export function normalizeUserJid(jid: string): string {
  if (!jid) return '';
  const trimmed = jid.trim();
  if (trimmed === BOT_JID) return BOT_JID;
  const [userPart, domainPart] = trimmed.split('@');
  const cleanUser = (userPart ?? '').split(':')[0];
  return `${cleanUser}@${domainPart || 's.whatsapp.net'}`;
}

export function formatMentionTag(jid: string): string {
  const clean = normalizeUserJid(jid);
  const num = clean.split('@')[0];
  return `@${num}`;
}

export function getGameDisplayName(gameType: MinigameType): string {
  if (gameType === 'connect4') return 'Connect 4';
  if (gameType === 'tictactoe') return 'Tic-Tac-Toe';
  return 'Dam / Checkers 8x8';
}

export class MinigamesService {
  public readonly name = 'minigames';
  private db!: Database.Database;
  private readonly dbPath: string;
  private readonly redis: RedisLikeClient | null;
  private readonly lockTtlMs: number;

  private readonly sessions = new Map<string, ActiveMinigameSession>();
  private readonly challenges = new Map<string, PendingMinigameChallenge>();
  private readonly localLocks = new Map<string, { token: string; expiresAt: number }>();
  private readonly avatarCache = new Map<string, { dataUrl: string | null; expiresAt: number }>();

  constructor(options: MinigamesServiceOptions = {}) {
    this.dbPath =
      options.dbPath ?? path.resolve(process.cwd(), 'data', 'allyssea.sqlite');
    this.redis = options.redis ?? null;
    this.lockTtlMs = options.lockTtlMs ?? 5000;
    this.initDatabase();
  }

  private initDatabase(): void {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS minigames_match_history (
        match_id TEXT PRIMARY KEY,
        chat_jid TEXT NOT NULL,
        game_type TEXT NOT NULL,
        is_bot_match INTEGER NOT NULL DEFAULT 0,
        bot_difficulty INTEGER,
        p1_jid TEXT NOT NULL,
        p2_jid TEXT NOT NULL,
        winner TEXT NOT NULL,
        reason TEXT NOT NULL,
        moves_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  public async start(): Promise<void> {}

  public async stop(): Promise<void> {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }

  public initialize(): void {}

  public shutdown(): void {
    if (this.db && this.db.open) {
      this.db.close();
    }
  }

  // ==========================================================================
  // WHATSAPP PROFILE PICTURE (PP WA) AVATAR EXTRACTION (BASE64 DATA URI)
  // ==========================================================================

  public async getAvatarDataUrl(
    whatsapp: WhatsAppPort | undefined,
    jid: string,
  ): Promise<string | null> {
    if (!jid || jid.startsWith('bot:')) return null;
    const cleanJid = normalizeUserJid(jid);
    const now = Date.now();
    const cached = this.avatarCache.get(cleanJid);
    if (cached && cached.expiresAt > now) {
      return cached.dataUrl;
    }

    if (!whatsapp?.getProfilePictureUrl) {
      this.avatarCache.set(cleanJid, { dataUrl: null, expiresAt: now + 30 * 60 * 1000 });
      return null;
    }

    try {
      const url = await whatsapp.getProfilePictureUrl(cleanJid, 'preview', 3000);
      if (!url) {
        this.avatarCache.set(cleanJid, { dataUrl: null, expiresAt: now + 30 * 60 * 1000 });
        return null;
      }
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) {
        this.avatarCache.set(cleanJid, { dataUrl: null, expiresAt: now + 30 * 60 * 1000 });
        return null;
      }
      const arrayBuf = await res.arrayBuffer();
      const mime = res.headers.get('content-type') || 'image/jpeg';
      const base64 = Buffer.from(arrayBuf).toString('base64');
      const dataUrl = `data:${mime};base64,${base64}`;
      this.avatarCache.set(cleanJid, { dataUrl, expiresAt: now + 30 * 60 * 1000 });
      return dataUrl;
    } catch {
      this.avatarCache.set(cleanJid, { dataUrl: null, expiresAt: now + 30 * 60 * 1000 });
      return null;
    }
  }

  // ==========================================================================
  // REDIS 8 / IN-MEMORY ATOMIC CONCURRENCY LOCK (`lock:game:<chatJid>`)
  // ==========================================================================

  public async acquireGameLock(
    chatJid: string,
    ttlMs = this.lockTtlMs,
  ): Promise<(() => Promise<void>) | null> {
    const lockKey = `lock:game:${chatJid}`;
    const token = crypto.randomUUID();
    const now = Date.now();

    if (this.redis) {
      try {
        const existing = await this.redis.get<string>(lockKey);
        if (existing) return null;
        const ok = await this.redis.set(lockKey, token, Math.max(1, Math.ceil(ttlMs / 1000)));
        if (!ok) return null;
        return async () => {
          try {
            const current = await this.redis!.get<string>(lockKey);
            if (current === token) {
              await this.redis!.del(lockKey);
            }
          } catch {}
        };
      } catch {
        // Fallback to local memory lock on Redis failure
      }
    }

    // In-Memory Mutex Fallback
    const existing = this.localLocks.get(lockKey);
    if (existing && existing.expiresAt > now) {
      return null;
    }

    this.localLocks.set(lockKey, { token, expiresAt: now + ttlMs });
    return async () => {
      const cur = this.localLocks.get(lockKey);
      if (cur && cur.token === token) {
        this.localLocks.delete(lockKey);
      }
    };
  }

  // ==========================================================================
  // SESSION & CHALLENGE QUERIES
  // ==========================================================================

  public getActiveSession(chatJid: string): ActiveMinigameSession | null {
    return this.sessions.get(chatJid) ?? null;
  }

  public getPendingChallenge(chatJid: string): PendingMinigameChallenge | null {
    return this.challenges.get(chatJid) ?? null;
  }

  public setLastBoardMessageId(chatJid: string, messageId: string): void {
    const s = this.sessions.get(chatJid);
    if (s) {
      s.lastBoardMessageId = messageId;
    }
  }

  // ==========================================================================
  // IN-MEMORY SATORI VISUAL CARD RENDERING (WITH EMBEDDED PP WA)
  // ==========================================================================

  public async renderSessionBoardPng(
    session: ActiveMinigameSession,
    whatsapp?: WhatsAppPort,
  ): Promise<Buffer> {
    const p1Avatar = await this.getAvatarDataUrl(whatsapp, session.p1Jid);
    const p2Avatar = await this.getAvatarDataUrl(whatsapp, session.p2Jid);

    const isP1Turn = session.state.turn === 1;
    const isGameOver = session.state.winner !== null;
    const isP1Winner = session.state.winner === 1;
    const isP2Winner = session.state.winner === 2;
    const isDraw = session.state.winner === 'draw';

    const p1Info: HudPlayerInfo = {
      name: session.p1Name,
      avatarDataUrl: p1Avatar,
      isTurn: !isGameOver && isP1Turn,
      isWinner: isP1Winner,
      isDraw,
    };

    const p2Info: HudPlayerInfo = {
      name: session.p2Name,
      avatarDataUrl: p2Avatar,
      isTurn: !isGameOver && !isP1Turn,
      isWinner: isP2Winner,
      isDraw,
    };

    const options: BoardRenderOptions = {
      showHud: true,
      player1: p1Info,
      player2: p2Info,
    };

    if (session.gameType === 'connect4') {
      return renderConnect4BoardPng(session.state as Connect4State, options);
    }
    if (session.gameType === 'tictactoe') {
      return renderTicTacToeBoardPng(session.state as TicTacToeState, options);
    }
    return renderCheckersBoardPng(session.state as CheckersState, options);
  }

  // ==========================================================================
  // CHALLENGE LIFECYCLE (PVP & PVE BOT)
  // ==========================================================================

  public createChallenge(params: {
    chatJid: string;
    gameType: MinigameType;
    challengerJid: string;
    challengerName: string;
    opponentJid?: string | null;
  }): MinigameActionResponse {
    const { chatJid, gameType } = params;
    const challengerJid = normalizeUserJid(params.challengerJid);
    const opponentJid = params.opponentJid ? normalizeUserJid(params.opponentJid) : null;
    const gameLabel = getGameDisplayName(gameType);
    const cmdAlias = gameType === 'connect4' ? '!c4' : gameType === 'tictactoe' ? '!ttt' : '!dam';

    if (this.sessions.has(chatJid)) {
      return {
        ok: false,
        code: 'MATCH_IN_PROGRESS',
        message: '⚠️ Masih ada permainan yang sedang berlangsung di chat ini. Selesaikan terlebih dahulu!',
      };
    }

    if (opponentJid && challengerJid === opponentJid) {
      return {
        ok: false,
        code: 'SELF_CHALLENGE',
        message: '⚠️ Kamu tidak bisa menantang diri sendiri! Gunakan `bot` untuk bermain solo.',
      };
    }

    const challengeId = crypto.randomUUID();
    const challenge: PendingMinigameChallenge = {
      id: challengeId,
      chatJid,
      gameType,
      challengerJid,
      challengerName: params.challengerName,
      opponentJid,
      createdAt: Date.now(),
    };

    this.challenges.set(chatJid, challenge);

    if (opponentJid) {
      return {
        ok: true,
        code: 'CHALLENGE_CREATED',
        mentions: [challengerJid, opponentJid],
        message:
          `🎮 *TANTANGAN ${gameLabel.toUpperCase()}*\n\n` +
          `👤 Penantang: ${formatMentionTag(challengerJid)}\n` +
          `🎯 Lawan: ${formatMentionTag(opponentJid)}\n\n` +
          `Ketik \`${cmdAlias} join\` untuk menerima tantangan!`,
      };
    }

    return {
      ok: true,
      code: 'OPEN_CHALLENGE_CREATED',
      mentions: [challengerJid],
      message:
        `🌐 *OPEN LOBBY ${gameLabel.toUpperCase()}*\n\n` +
        `👤 Host: ${formatMentionTag(challengerJid)}\n\n` +
        `Siapa saja di grup ini bisa mengetik \`${cmdAlias} join\` untuk langsung bertanding!`,
    };
  }

  public async acceptChallenge(params: {
    chatJid: string;
    accepterJid: string;
    accepterName: string;
    whatsapp?: WhatsAppPort;
  }): Promise<MinigameActionResponse> {
    const challenge = this.challenges.get(params.chatJid);
    if (!challenge) {
      return {
        ok: false,
        code: 'NO_CHALLENGE',
        message: '⚠️ Tidak ada tantangan yang sedang menunggu di chat ini.',
      };
    }

    const accepterJid = normalizeUserJid(params.accepterJid);
    if (challenge.challengerJid === accepterJid) {
      return {
        ok: false,
        code: 'CANNOT_ACCEPT_OWN',
        message: '⚠️ Kamu tidak bisa menerima tantangan buatanmu sendiri!',
      };
    }

    if (challenge.opponentJid && challenge.opponentJid !== accepterJid) {
      return {
        ok: false,
        code: 'WRONG_OPPONENT',
        mentions: [challenge.opponentJid],
        message: `⚠️ Tantangan ini ditujukan khusus untuk ${formatMentionTag(challenge.opponentJid)}!`,
      };
    }

    this.challenges.delete(params.chatJid);

    const p1Jid = challenge.challengerJid;
    const p1Name = challenge.challengerName;
    const p2Jid = accepterJid;
    const p2Name = params.accepterName;

    const session = this.buildInitialSession({
      chatJid: params.chatJid,
      gameType: challenge.gameType,
      isBotMatch: false,
      botDifficulty: null,
      p1Jid,
      p1Name,
      p2Jid,
      p2Name,
    });

    this.sessions.set(params.chatJid, session);
    const gameLabel = getGameDisplayName(session.gameType);

    const instructions =
      session.gameType === 'connect4'
        ? '💡 Ketik angka kolom `1-7` untuk menjatuhkan koin.'
        : session.gameType === 'tictactoe'
          ? '💡 Ketik angka `1-9` (layout keypad) atau koordinat `a1-c3`.'
          : '💡 Ketik asal dan tujuan langkah (contoh: `c3 d4` atau `c3 e5 g7`).';

    const boardPng = await this.renderSessionBoardPng(session, params.whatsapp);

    return {
      ok: true,
      code: 'MATCH_STARTED',
      session,
      boardPng,
      mentions: [p1Jid, p2Jid],
      message:
        `🚀 *GAME ${gameLabel.toUpperCase()} DIMULAI!*\n\n` +
        `🔵 Pemain 1: ${formatMentionTag(p1Jid)} (${p1Name})\n` +
        `🔴 Pemain 2: ${formatMentionTag(p2Jid)} (${p2Name})\n\n` +
        `👉 Giliran pertama: ${formatMentionTag(session.state.turn === 1 ? p1Jid : p2Jid)}\n` +
        `${instructions}`,
    };
  }

  public async startBotMatch(params: {
    chatJid: string;
    gameType: MinigameType;
    playerJid: string;
    playerName: string;
    difficulty?: BotDifficulty;
    whatsapp?: WhatsAppPort;
  }): Promise<MinigameActionResponse> {
    const { chatJid, gameType } = params;
    const playerJid = normalizeUserJid(params.playerJid);
    const diff = params.difficulty ?? 2;
    const bot = BOT_PROFILES[diff];

    if (this.sessions.has(chatJid)) {
      return {
        ok: false,
        code: 'MATCH_IN_PROGRESS',
        message: '⚠️ Masih ada permainan yang sedang berlangsung di chat ini. Selesaikan terlebih dahulu!',
      };
    }

    const session = this.buildInitialSession({
      chatJid,
      gameType,
      isBotMatch: true,
      botDifficulty: diff,
      p1Jid: playerJid,
      p1Name: params.playerName,
      p2Jid: BOT_JID,
      p2Name: bot.name,
    });

    this.sessions.set(chatJid, session);
    const gameLabel = getGameDisplayName(gameType);

    const instructions =
      gameType === 'connect4'
        ? '💡 Ketik angka kolom `1-7` untuk menjatuhkan koin.'
        : gameType === 'tictactoe'
          ? '💡 Ketik angka `1-9` atau koordinat `a1-c3`.'
          : '💡 Ketik asal dan tujuan langkah (contoh: `c3 d4` atau `c3 e5 g7`).';

    const boardPng = await this.renderSessionBoardPng(session, params.whatsapp);

    return {
      ok: true,
      code: 'BOT_MATCH_STARTED',
      session,
      boardPng,
      mentions: [playerJid],
      message:
        `🤖 *PVE BOT MATCH ${gameLabel.toUpperCase()}*\n\n` +
        `👤 Pemain: ${formatMentionTag(playerJid)}\n` +
        `🤖 Lawan: *${bot.title}*\n\n` +
        `👉 Giliran: ${formatMentionTag(playerJid)}\n` +
        `${instructions}`,
    };
  }

  private buildInitialSession(params: {
    chatJid: string;
    gameType: MinigameType;
    isBotMatch: boolean;
    botDifficulty: BotDifficulty | null;
    p1Jid: string;
    p1Name: string;
    p2Jid: string;
    p2Name: string;
  }): ActiveMinigameSession {
    const now = Date.now();
    let state: AnyMinigameBoardState;

    if (params.gameType === 'connect4') {
      state = createConnect4State();
    } else if (params.gameType === 'tictactoe') {
      state = createTicTacToeState();
    } else {
      state = createCheckersState();
    }

    return {
      matchId: crypto.randomUUID().slice(0, 8),
      chatJid: params.chatJid,
      gameType: params.gameType,
      isBotMatch: params.isBotMatch,
      botDifficulty: params.botDifficulty,
      p1Jid: params.p1Jid,
      p1Name: params.p1Name,
      p2Jid: params.p2Jid,
      p2Name: params.p2Name,
      createdAt: now,
      lastMoveAt: now,
      drawOfferedBy: null,
      lastBoardMessageId: null,
      state,
    };
  }

  // ==========================================================================
  // MOVE EXECUTION (WITH ATOMIC LOCK & OPTIONAL AUTO BOT TURN)
  // ==========================================================================

  public async submitMove(params: {
    chatJid: string;
    senderJid: string;
    rawMove: string;
    whatsapp?: WhatsAppPort;
  }): Promise<MinigameActionResponse> {
    const releaseLock = await this.acquireGameLock(params.chatJid);
    if (!releaseLock) {
      return {
        ok: false,
        code: 'RACE_LOCK',
        message: '⏳ Tunggu sebentar, langkah sebelumnya sedang diproses...',
      };
    }

    try {
      return await this.executeMoveInternal(params);
    } finally {
      await releaseLock();
    }
  }

  private async executeMoveInternal(params: {
    chatJid: string;
    senderJid: string;
    rawMove: string;
    whatsapp?: WhatsAppPort;
  }): Promise<MinigameActionResponse> {
    const session = this.sessions.get(params.chatJid);
    if (!session) {
      return {
        ok: false,
        code: 'NO_ACTIVE_MATCH',
        message: '⚠️ Tidak ada pertandingan yang aktif di obrolan ini.',
      };
    }

    const senderJid = normalizeUserJid(params.senderJid);
    const expectedJid = session.state.turn === 1 ? session.p1Jid : session.p2Jid;

    if (senderJid !== expectedJid) {
      return {
        ok: false,
        code: 'WRONG_TURN',
        mentions: [expectedJid],
        message: `⚠️ Bukan giliranmu! Saat ini giliran ${formatMentionTag(expectedJid)}.`,
      };
    }

    let humanMoveNotation = '';

    // 1. CONNECT 4
    if (session.state.kind === 'connect4') {
      const col = parseConnect4MoveInput(params.rawMove);
      if (col === null) {
        return {
          ok: false,
          code: 'INVALID_SYNTAX',
          message: '⚠️ Input kolom tidak valid. Masukkan angka `1` sampai `7`.',
        };
      }
      const res = applyConnect4Move(session.state, col);
      if (!res.ok) {
        return {
          ok: false,
          code: res.code ?? 'MOVE_REJECTED',
          message: `⚠️ ${res.error ?? 'Langkah tidak valid.'}`,
        };
      }
      humanMoveNotation = `Kolom ${col}`;
    }

    // 2. TIC-TAC-TOE
    else if (session.state.kind === 'tictactoe') {
      const cellIndex = parseTicTacToeMoveInput(params.rawMove);
      if (cellIndex === null) {
        return {
          ok: false,
          code: 'INVALID_SYNTAX',
          message: '⚠️ Input kotak tidak valid. Masukkan angka `1-9` atau koordinat `a1-c3`.',
        };
      }
      const res = applyTicTacToeMove(session.state, cellIndex);
      if (!res.ok) {
        return {
          ok: false,
          code: res.code ?? 'MOVE_REJECTED',
          message: `⚠️ ${res.error ?? 'Kotak sudah terisi.'}`,
        };
      }
      humanMoveNotation = `Kotak ${cellIndex} (${res.coordLabel?.toUpperCase()})`;
    }

    // 3. DAM / CHECKERS 8x8
    else {
      const coords = parseCheckersMoveTokens(params.rawMove);
      if (coords === null || coords.length < 2) {
        return {
          ok: false,
          code: 'INVALID_SYNTAX',
          message: '⚠️ Format langkah tidak valid. Masukkan asal dan tujuan (contoh: `c3 d4` atau `c3 e5 g7`).',
        };
      }
      const res = applyCheckersMove(session.state, coords);
      if (!res.ok) {
        return {
          ok: false,
          code: res.code ?? 'MOVE_REJECTED',
          message: `⚠️ ${res.error ?? 'Langkah tidak sah sesuai aturan Dam 8x8.'}`,
        };
      }
      humanMoveNotation = coords.map(coordToCheckersAlgebraic).join(' → ');

      // If in the middle of a multi-jump sequence
      if (res.chainContinued) {
        const boardPng = await this.renderSessionBoardPng(session, params.whatsapp);
        const avail = (res.nextAvailableJumps ?? [])
          .map((j) => coordToCheckersAlgebraic(j.to))
          .join(', ');
        return {
          ok: true,
          code: 'MULTI_JUMP_CHAIN',
          session,
          boardPng,
          mentions: [senderJid],
          message:
            `⚔️ *LOMPATAN BERANTAI!*\n` +
            `Bidakmu di *${coordToCheckersAlgebraic(session.state.mustContinueJumpFrom!)}* wajib melanjutkan makan lawan!\n` +
            `🎯 Sasaran lompat tersedia: *${avail}*`,
        };
      }
    }

    session.lastMoveAt = Date.now();
    session.drawOfferedBy = null;

    // Check if Human move completed the game
    if (session.state.winner !== null) {
      return this.finalizeCompletedMatch(session, humanMoveNotation, null, params.whatsapp);
    }

    // If PvE Bot match and it is now Bot's turn (slot 2):
    let botMoveNotation: string | null = null;
    if (session.isBotMatch && session.state.turn === 2 && session.state.winner === null) {
      const diff = session.botDifficulty ?? 2;
      if (session.state.kind === 'connect4') {
        const botCol = getConnect4BotMove(session.state, diff);
        applyConnect4Move(session.state, botCol);
        botMoveNotation = `Kolom ${botCol}`;
      } else if (session.state.kind === 'tictactoe') {
        const botCell = getTicTacToeBotMove(session.state, diff);
        const bRes = applyTicTacToeMove(session.state, botCell);
        botMoveNotation = `Kotak ${botCell} (${bRes.coordLabel?.toUpperCase()})`;
      } else {
        const botSeq: CheckersCoord[] = getCheckersBotMove(session.state, diff);
        if (botSeq.length >= 2) {
          applyCheckersMove(session.state, botSeq);
          botMoveNotation = botSeq.map(coordToCheckersAlgebraic).join(' → ');
        }
      }
      session.lastMoveAt = Date.now();

      if (session.state.winner !== null) {
        return this.finalizeCompletedMatch(session, humanMoveNotation, botMoveNotation, params.whatsapp);
      }
    }

    const nextJid = session.state.turn === 1 ? session.p1Jid : session.p2Jid;
    const boardPng = await this.renderSessionBoardPng(session, params.whatsapp);

    let caption = `👉 Giliran ${formatMentionTag(nextJid)}.`;
    if (botMoveNotation) {
      caption = `🤖 Bot melangkah: *${botMoveNotation}*\n👉 Giliran ${formatMentionTag(nextJid)}.`;
    }

    return {
      ok: true,
      code: 'MOVE_APPLIED',
      session,
      boardPng,
      mentions: [nextJid],
      botMoveNotation,
      message: caption,
    };
  }

  // ==========================================================================
  // MATCH FINALIZATION (ZERO ELO, PURE WIN / DRAW)
  // ==========================================================================

  private async finalizeCompletedMatch(
    session: ActiveMinigameSession,
    lastMove: string,
    botMove: string | null,
    whatsapp?: WhatsAppPort,
  ): Promise<MinigameActionResponse> {
    this.sessions.delete(session.chatJid);

    const winner = session.state.winner;
    const isP1Win = winner === 1;
    const isP2Win = winner === 2;
    const isDraw = winner === 'draw';

    const winnerJid = isP1Win ? session.p1Jid : isP2Win ? session.p2Jid : null;
    const winnerName = isP1Win ? session.p1Name : isP2Win ? session.p2Name : null;

    const gameLabel = getGameDisplayName(session.gameType);

    // Save history record in SQLite
    try {
      this.db
        .prepare(
          `INSERT INTO minigames_match_history
           (match_id, chat_jid, game_type, is_bot_match, bot_difficulty, p1_jid, p2_jid, winner, reason, moves_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          session.matchId,
          session.chatJid,
          session.gameType,
          session.isBotMatch ? 1 : 0,
          session.botDifficulty,
          session.p1Jid,
          session.p2Jid,
          isDraw ? 'DRAW' : winnerJid!,
          isDraw ? 'DRAW' : 'WIN',
          JSON.stringify(session.state.history),
          Date.now(),
        );
    } catch {}

    const boardPng = await this.renderSessionBoardPng(session, whatsapp);

    let resultBanner = '';
    if (isDraw) {
      resultBanner = `🤝 *PERMAINAN SERI (DRAW)!*\nKedua pemain bermain seimbang di ${gameLabel}.`;
    } else {
      resultBanner = `🏆 *SKAKMAT / KEMENANGAN!*\nSelamat ${formatMentionTag(winnerJid!)} (${winnerName}) keluar sebagai pemenang!`;
    }

    const mentions = [session.p1Jid, session.p2Jid].filter(
      (j) => j && j !== BOT_JID,
    );

    return {
      ok: true,
      code: 'GAME_OVER',
      session,
      boardPng,
      gameOver: true,
      winner,
      mentions,
      botMoveNotation: botMove,
      message: resultBanner,
    };
  }

  // ==========================================================================
  // UTILITY ACTIONS (RESIGN, DRAW, CANCEL)
  // ==========================================================================

  public async resignMatch(chatJid: string, senderJid: string): Promise<MinigameActionResponse> {
    const session = this.sessions.get(chatJid);
    if (!session) {
      return {
        ok: false,
        code: 'NO_ACTIVE_MATCH',
        message: '⚠️ Tidak ada pertandingan yang aktif di obrolan ini.',
      };
    }

    const cleanSender = normalizeUserJid(senderJid);
    const isP1 = session.p1Jid === cleanSender;
    const isP2 = session.p2Jid === cleanSender;

    if (!isP1 && !isP2) {
      return {
        ok: false,
        code: 'NOT_PARTICIPANT',
        message: '⚠️ Hanya pemain yang sedang bertanding yang bisa menyerah!',
      };
    }

    session.state.winner = isP1 ? 2 : 1;
    return this.finalizeCompletedMatch(session, 'RESIGN', null);
  }

  public async offerOrAcceptDraw(chatJid: string, senderJid: string): Promise<MinigameActionResponse> {
    const session = this.sessions.get(chatJid);
    if (!session) {
      return {
        ok: false,
        code: 'NO_ACTIVE_MATCH',
        message: '⚠️ Tidak ada pertandingan yang aktif di obrolan ini.',
      };
    }

    if (session.isBotMatch) {
      return {
        ok: false,
        code: 'BOT_NO_DRAW',
        message: '⚠️ AI Bot tidak menerima tawaran seri. Selesaikan permainan hingga akhir!',
      };
    }

    const cleanSender = normalizeUserJid(senderJid);
    const slot: PlayerSlot | null =
      session.p1Jid === cleanSender ? 1 : session.p2Jid === cleanSender ? 2 : null;

    if (!slot) {
      return {
        ok: false,
        code: 'NOT_PARTICIPANT',
        message: '⚠️ Hanya pemain yang bertanding yang dapat mengajukan atau menerima remis.',
      };
    }

    if (session.drawOfferedBy && session.drawOfferedBy !== slot) {
      session.state.winner = 'draw';
      return this.finalizeCompletedMatch(session, 'DRAW_AGREED', null);
    }

    session.drawOfferedBy = slot;
    const opponentJid = slot === 1 ? session.p2Jid : session.p1Jid;

    return {
      ok: true,
      code: 'DRAW_OFFERED',
      mentions: [opponentJid],
      message:
        `🤝 ${formatMentionTag(cleanSender)} menawarkan *REMIS (Seri)* kepada ${formatMentionTag(opponentJid)}!\n` +
        `Ketik \`remis\` untuk menerima tawaran, atau lanjutkan melangkah untuk menolak.`,
    };
  }

  public cancelChallengeOrAbort(chatJid: string, senderJid: string): MinigameActionResponse {
    const cleanSender = normalizeUserJid(senderJid);
    const challenge = this.challenges.get(chatJid);

    if (challenge) {
      if (challenge.challengerJid !== cleanSender) {
        return {
          ok: false,
          code: 'NOT_CHALLENGER',
          message: '⚠️ Hanya pembuat tantangan yang dapat membatalkan lobi terbuka ini.',
        };
      }
      this.challenges.delete(chatJid);
      return {
        ok: true,
        code: 'CHALLENGE_CANCELLED',
        message: '🛑 Tantangan permainan berhasil dibatalkan.',
      };
    }

    const session = this.sessions.get(chatJid);
    if (session) {
      const isP1 = session.p1Jid === cleanSender;
      const isP2 = session.p2Jid === cleanSender;
      if (!isP1 && !isP2) {
        return {
          ok: false,
          code: 'NOT_PARTICIPANT',
          message: '⚠️ Hanya pemain yang bertanding yang dapat membatalkan permainan ini.',
        };
      }

      if (session.state.moveCount <= 1) {
        this.sessions.delete(chatJid);
        return {
          ok: true,
          code: 'MATCH_ABORTED',
          aborted: true,
          message: '🛑 Pertandingan dibatalkan di awal langkah.',
        };
      }
    }

    return {
      ok: false,
      code: 'NOTHING_TO_CANCEL',
      message: '⚠️ Tidak ada tantangan atau pertandingan awal yang bisa dibatalkan.',
    };
  }

  // ==========================================================================
  // DIRECT REPLY & MOVE GUARDS (PREVENTS CHLONA AI INTERCEPTION)
  // ==========================================================================

  public isMinigameMoveOrReply(params: {
    chatJid: string;
    senderJid?: string;
    text: string;
    quotedMessageId?: string | null;
  }): boolean {
    const session = this.sessions.get(params.chatJid);
    if (!session) return false;

    if (params.senderJid) {
      const cleanSender = normalizeUserJid(params.senderJid);
      const expected = session.state.turn === 1 ? session.p1Jid : session.p2Jid;
      if (cleanSender !== expected) return false;
    }

    const trimmed = params.text.trim();
    if (!trimmed) return false;

    if (session.gameType === 'connect4') {
      return parseConnect4MoveInput(trimmed) !== null;
    }
    if (session.gameType === 'tictactoe') {
      return parseTicTacToeMoveInput(trimmed) !== null;
    }
    return parseCheckersMoveTokens(trimmed) !== null;
  }
}
