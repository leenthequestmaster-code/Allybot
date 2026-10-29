// ============================================================================
// ALLYBOT 10-MINIGAME ARCADE SERVICE (SESSION MANAGER, DM ROUTER, TIMERS & DB)
// Coordinates Pure TypeScript GameEngines with SQLite 3, Timers, Vela Escrow & Satori PNGs
// ============================================================================

import path from 'node:path';
import { initSqliteDatabase, type DatabaseInstance } from '../../storage-helpers.js';
import {
  type ArcadeGameType,
  type BaseGameAction,
  type GameActionResult,
  type GameEngine,
  type GamePlayer,
  createArcadeEngineRegistry,
} from './arcade-engines.js';
import { renderArcadeGameStatePng } from './arcade-renderer.js';
import { VelaEscrowManager } from '../games/core/vela-escrow.js';
import type { WhatsAppPort } from '../../framework/contracts.js';

export interface ActiveArcadeSession {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: ArcadeGameType;
  readonly hostJid: string;
  state: any;
  createdAt: number;
  updatedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ArcadeDispatchOutput {
  readonly handled: boolean;
  readonly groupJid?: string;
  readonly gameType?: ArcadeGameType;
  readonly result?: GameActionResult<any>;
  readonly boardPng?: Buffer;
}

export interface ArcadeLeaderboardEntry {
  readonly userJid: string;
  readonly displayName: string;
  readonly totalGames: number;
  readonly totalWins: number;
  readonly totalScore: number;
  readonly updatedAt: number;
}

export function normalizeWhatsAppUserJid(rawJid: string): string {
  const trimmed = (rawJid || '').trim();
  if (!trimmed) return '';
  if (trimmed.endsWith('@g.us')) return trimmed;
  const userPart = trimmed.split('@')[0]?.split(':')[0] ?? trimmed;
  return `${userPart}@s.whatsapp.net`;
}

export class ArcadeService {
  public readonly name = 'arcade';
  private readonly engines = createArcadeEngineRegistry();
  private readonly sessions = new Map<string, ActiveArcadeSession>();
  private readonly playerGroupIndex = new Map<string, string>();
  private readonly memoryStats = new Map<string, ArcadeLeaderboardEntry>();
  private db: DatabaseInstance | null = null;
  private readonly dbPath: string;
  private readonly enableAutoTimers: boolean;
  private readonly escrowManager?: VelaEscrowManager;
  public whatsapp?: WhatsAppPort;
  private readonly onTimeoutBroadcast?: (
    groupJid: string,
    output: ArcadeDispatchOutput,
  ) => Promise<void>;

  constructor(options?: {
    dbPath?: string;
    enableAutoTimers?: boolean;
    escrowManager?: VelaEscrowManager;
    whatsapp?: WhatsAppPort;
    onTimeoutBroadcast?: (groupJid: string, output: ArcadeDispatchOutput) => Promise<void>;
  }) {
    this.dbPath = options?.dbPath ?? path.join(process.cwd(), 'data', 'allybot-arcade.sqlite');
    this.enableAutoTimers = options?.enableAutoTimers ?? false;
    this.escrowManager = options?.escrowManager;
    this.whatsapp = options?.whatsapp;
    this.onTimeoutBroadcast = options?.onTimeoutBroadcast;
  }

  private ensureDb(): DatabaseInstance | null {
    if (this.db) return this.db;
    try {
      const db = initSqliteDatabase(this.dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS arcade_player_stats (
          user_jid TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          total_games INTEGER NOT NULL DEFAULT 0,
          total_wins INTEGER NOT NULL DEFAULT 0,
          total_score INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS arcade_match_history (
          game_id TEXT PRIMARY KEY,
          group_jid TEXT NOT NULL,
          game_type TEXT NOT NULL,
          winner_jids TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      this.db = db;
      return db;
    } catch {
      return null;
    }
  }

  public getEngine<K extends ArcadeGameType>(gameType: K): GameEngine<any, BaseGameAction> {
    return this.engines[gameType];
  }

  public getActiveSession(groupJid: string): ActiveArcadeSession | undefined {
    return this.sessions.get(groupJid);
  }

  public getActiveSessionForPlayerDm(playerJid: string): ActiveArcadeSession | undefined {
    const norm = normalizeWhatsAppUserJid(playerJid);
    const groupJid = this.playerGroupIndex.get(norm);
    if (!groupJid) return undefined;
    return this.sessions.get(groupJid);
  }

  private indexSessionPlayers(session: ActiveArcadeSession): void {
    const s = session.state;
    const jids = new Set<string>();
    if (s?.host?.jid) jids.add(normalizeWhatsAppUserJid(s.host.jid));
    if (typeof s?.hostJid === 'string') jids.add(normalizeWhatsAppUserJid(s.hostJid));
    if (Array.isArray(s?.players)) {
      for (const p of s.players) {
        if (p?.jid) jids.add(normalizeWhatsAppUserJid(p.jid));
      }
    } else if (s?.players && typeof s.players === 'object') {
      for (const k of Object.keys(s.players)) {
        jids.add(normalizeWhatsAppUserJid(k));
      }
    }
    if (Array.isArray(s?.seats)) {
      for (const seat of s.seats) {
        if (seat?.player?.jid) jids.add(normalizeWhatsAppUserJid(seat.player.jid));
      }
    }
    for (const jid of jids) {
      if (jid) this.playerGroupIndex.set(jid, session.groupJid);
    }
  }

  private clearSessionTimer(session: ActiveArcadeSession): void {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  private scheduleSessionTimerIfNeeded(session: ActiveArcadeSession): void {
    this.clearSessionTimer(session);
    if (!this.enableAutoTimers) return;

    const engine = this.engines[session.gameType];
    const timeoutMs =
      session.gameType === 'hot_potato' &&
      session.state?.status === 'playing' &&
      typeof session.state?.fuseDurationMs === 'number'
        ? session.state.fuseDurationMs
        : engine.defaultTurnTimeoutMs;

    session.timer = setTimeout(async () => {
      const out = await this.triggerTurnTimeout(session.groupJid);
      if (out.handled && this.onTimeoutBroadcast) {
        await this.onTimeoutBroadcast(session.groupJid, out).catch(() => undefined);
      }
    }, timeoutMs);
  }

  private async recordFinishedMatch(session: ActiveArcadeSession, winnerJids: string[]): Promise<void> {
    const db = this.ensureDb();
    const now = Date.now();
    const s = session.state;
    const engine = this.engines[session.gameType];

    // Settle Vela escrow payout if active
    if (this.escrowManager && winnerJids.length > 0) {
      try {
        await this.escrowManager.settlePayout({
          gameId: session.gameId,
          winnerJids,
          gameLabel: engine.displayName,
        });
      } catch {
        // Log & proceed
      }
    }

    const participantList: GamePlayer[] = [];
    if (Array.isArray(s?.players)) {
      participantList.push(...s.players);
    } else if (s?.players && typeof s.players === 'object') {
      participantList.push(...(Object.values(s.players) as GamePlayer[]));
    } else if (Array.isArray(s?.seats)) {
      participantList.push(...s.seats.map((st: any) => st.player).filter(Boolean));
    }

    const winnersSet = new Set(winnerJids.map(normalizeWhatsAppUserJid));

    for (const p of participantList) {
      const uJid = normalizeWhatsAppUserJid(p.jid);
      if (!uJid) continue;
      const isWinner = winnersSet.has(uJid);
      const deltaScore = Math.max(0, p.score ?? (isWinner ? 100 : 10));

      if (db) {
        const existing = db
          .prepare('SELECT user_jid, display_name, total_games, total_wins, total_score FROM arcade_player_stats WHERE user_jid = ?')
          .get(uJid) as any;

        if (!existing) {
          db.prepare(
            `INSERT INTO arcade_player_stats (user_jid, display_name, total_games, total_wins, total_score, updated_at)
             VALUES (?, ?, 1, ?, ?, ?)`
          ).run(uJid, p.name || 'Pemain', isWinner ? 1 : 0, deltaScore, now);
        } else {
          db.prepare(
            `UPDATE arcade_player_stats
             SET display_name = ?,
                 total_games = total_games + 1,
                 total_wins = total_wins + ?,
                 total_score = total_score + ?,
                 updated_at = ?
             WHERE user_jid = ?`
          ).run(p.name || existing.display_name, isWinner ? 1 : 0, deltaScore, now, uJid);
        }
      } else {
        const prev = this.memoryStats.get(uJid);
        this.memoryStats.set(uJid, {
          userJid: uJid,
          displayName: p.name || prev?.displayName || 'Pemain',
          totalGames: (prev?.totalGames ?? 0) + 1,
          totalWins: (prev?.totalWins ?? 0) + (isWinner ? 1 : 0),
          totalScore: (prev?.totalScore ?? 0) + deltaScore,
          updatedAt: now,
        });
      }
    }

    if (db) {
      db.prepare(
        `INSERT OR REPLACE INTO arcade_match_history (game_id, group_jid, game_type, winner_jids, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(session.gameId, session.groupJid, session.gameType, JSON.stringify(winnerJids), now);
    }
  }

  public async startGame(params: {
    groupJid: string;
    gameType: ArcadeGameType;
    hostJid: string;
    hostName: string;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
    renderPng?: boolean;
  }): Promise<ArcadeDispatchOutput> {
    const existing = this.sessions.get(params.groupJid);
    if (existing) {
      return {
        handled: true,
        groupJid: params.groupJid,
        gameType: existing.gameType,
        result: {
          success: false,
          error: `Masih ada sesi *${this.engines[existing.gameType].displayName}* yang aktif di grup ini!`,
          state: existing.state,
        },
      };
    }

    const hostJid = normalizeWhatsAppUserJid(params.hostJid);
    const engine = this.engines[params.gameType];
    const gameId = `${params.gameType.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

    // Hold wager if Vela Escrow is active
    if (this.escrowManager && params.wagerAmount && params.wagerAmount > 0) {
      try {
        await this.escrowManager.holdWager({
          gameId,
          groupJid: params.groupJid,
          playerJid: hostJid,
          amount: params.wagerAmount,
          gameLabel: engine.displayName,
        });
      } catch (err: any) {
        return {
          handled: true,
          groupJid: params.groupJid,
          gameType: params.gameType,
          result: {
            success: false,
            error: err.message || 'Gagal mengunci taruhan Vela.',
            state: null,
          },
        };
      }
    }

    const initialState = engine.createInitialState({
      gameId,
      groupJid: params.groupJid,
      host: {
        jid: hostJid,
        name: params.hostName,
        score: 0,
        wounds: 0,
        isEliminated: false,
        joinedAt: Date.now(),
      },
      wagerAmount: params.wagerAmount,
      customConfig: params.customConfig,
    });

    const session: ActiveArcadeSession = {
      gameId,
      groupJid: params.groupJid,
      gameType: params.gameType,
      hostJid,
      state: initialState,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      timer: null,
    };

    const isImmediateComplete =
      initialState.status === 'completed' || initialState.status === 'finished';

    if (!isImmediateComplete) {
      this.sessions.set(params.groupJid, session);
      this.indexSessionPlayers(session);
      this.scheduleSessionTimerIfNeeded(session);
    } else {
      await this.recordFinishedMatch(session, (initialState as any).winnerJids ?? [hostJid]);
    }

    const boardPng =
      params.renderPng !== false
        ? await renderArcadeGameStatePng(params.gameType, initialState, this.whatsapp)
        : undefined;

    return {
      handled: true,
      groupJid: params.groupJid,
      gameType: params.gameType,
      boardPng,
      result: {
        success: true,
        state: initialState,
        isGameOver: isImmediateComplete,
        winnerJids: (initialState as any).winnerJids ?? (isImmediateComplete ? [hostJid] : []),
        mentions: [hostJid],
        broadcastMessage: `🎮 *${engine.displayName}* berhasil disiapkan!`,
      },
    };
  }

  public async dispatchAction(params: {
    groupJid: string;
    action: BaseGameAction;
    renderPng?: boolean;
  }): Promise<ArcadeDispatchOutput> {
    const session = this.sessions.get(params.groupJid);
    if (!session) {
      return { handled: false };
    }

    const engine = this.engines[session.gameType];
    const normalizedAction: BaseGameAction = {
      ...params.action,
      playerJid: normalizeWhatsAppUserJid(params.action.playerJid),
    };

    // Hold wager if action is JOIN and wagerAmount > 0
    if (
      normalizedAction.type === 'JOIN' &&
      this.escrowManager &&
      session.state?.wagerAmount &&
      session.state.wagerAmount > 0
    ) {
      try {
        await this.escrowManager.holdWager({
          gameId: session.gameId,
          groupJid: params.groupJid,
          playerJid: normalizedAction.playerJid,
          amount: session.state.wagerAmount,
          gameLabel: engine.displayName,
        });
      } catch (err: any) {
        return {
          handled: true,
          groupJid: params.groupJid,
          gameType: session.gameType,
          result: {
            success: false,
            error: err.message || 'Gagal mengunci taruhan Vela pemain.',
            state: session.state,
          },
        };
      }
    }

    const res = engine.processAction(session.state, normalizedAction as any);
    session.state = res.state;
    session.updatedAt = Date.now();
    this.indexSessionPlayers(session);

    if (res.isGameOver) {
      this.clearSessionTimer(session);
      this.sessions.delete(params.groupJid);
      await this.recordFinishedMatch(session, res.winnerJids ?? []);
    } else if (res.success) {
      this.scheduleSessionTimerIfNeeded(session);
    }

    const boardPng =
      res.success && params.renderPng !== false
        ? await renderArcadeGameStatePng(session.gameType, session.state, this.whatsapp)
        : undefined;

    return {
      handled: true,
      groupJid: params.groupJid,
      gameType: session.gameType,
      result: res,
      boardPng,
    };
  }

  public async dispatchDirectMessageAction(params: {
    senderJid: string;
    text: string;
    mentionedJids?: string[];
    renderPng?: boolean;
  }): Promise<ArcadeDispatchOutput> {
    const playerJid = normalizeWhatsAppUserJid(params.senderJid);
    const session = this.getActiveSessionForPlayerDm(playerJid);
    if (!session) {
      return { handled: false };
    }

    const clean = params.text.trim();

    // 1. LMS Quiz secret DM answer: "A" | "B" | "C" | "D" or "!lms A"
    if (session.gameType === 'lms_quiz' && session.state.status === 'question_open') {
      const m = clean.match(/^(?:!?(?:lms|jawab|answer)\s+)?([A-Da-d])$/);
      if (m) {
        return await this.dispatchAction({
          groupJid: session.groupJid,
          renderPng: params.renderPng,
          action: {
            type: 'ANSWER',
            playerJid,
            isDirectMessage: true,
            payload: { choice: m[1].toUpperCase() },
          },
        });
      }
    }

    // 2. Cash & Guns secret DM aim: "aim @target click|bang"
    if (session.gameType === 'cash_and_guns' && session.state.status === 'aiming') {
      const m = clean.match(/^(?:!?aim|bidik|tembak)\s+(?:@?(\d+))?\s*(click|bang)$/i);
      if (m) {
        const rawTarget = params.mentionedJids?.[0] || (m[1] ? `${m[1]}@s.whatsapp.net` : '');
        const targetJid = normalizeWhatsAppUserJid(rawTarget);
        const bullet = m[2].toUpperCase() as 'CLICK' | 'BANG';
        return await this.dispatchAction({
          groupJid: session.groupJid,
          renderPng: params.renderPng,
          action: {
            type: 'AIM',
            playerJid,
            isDirectMessage: true,
            payload: { targetJid, bullet },
          },
        });
      }
    }

    return { handled: false };
  }

  public async triggerTurnTimeout(
    groupJid: string,
    renderPng = true,
  ): Promise<ArcadeDispatchOutput> {
    const session = this.sessions.get(groupJid);
    if (!session) return { handled: false };

    this.clearSessionTimer(session);
    const engine = this.engines[session.gameType];
    const res = engine.handleTurnTimeout(session.state);
    session.state = res.state;
    session.updatedAt = Date.now();

    if (res.isGameOver) {
      this.sessions.delete(groupJid);
      await this.recordFinishedMatch(session, res.winnerJids ?? []);
    } else if (res.success) {
      this.scheduleSessionTimerIfNeeded(session);
    }

    const boardPng =
      res.success && renderPng
        ? await renderArcadeGameStatePng(session.gameType, session.state, this.whatsapp)
        : undefined;

    return {
      handled: true,
      groupJid,
      gameType: session.gameType,
      result: res,
      boardPng,
    };
  }

  public async cancelSession(groupJid: string, reason = 'Permainan dibatalkan'): Promise<boolean> {
    const session = this.sessions.get(groupJid);
    if (!session) return false;
    this.clearSessionTimer(session);
    this.sessions.delete(groupJid);

    // Refund wagers if active
    if (this.escrowManager) {
      try {
        await this.escrowManager.refundAll(session.gameId, reason);
      } catch {
        // ignore
      }
    }

    return true;
  }

  public getLeaderboard(limit = 10): ArcadeLeaderboardEntry[] {
    const db = this.ensureDb();
    if (db) {
      const rows = db
        .prepare(
          `SELECT user_jid, display_name, total_games, total_wins, total_score, updated_at
           FROM arcade_player_stats
           ORDER BY total_score DESC, total_wins DESC
           LIMIT ?`,
        )
        .all(limit) as any[];

      return rows.map((r) => ({
        userJid: r.user_jid,
        displayName: r.display_name,
        totalGames: Number(r.total_games),
        totalWins: Number(r.total_wins),
        totalScore: Number(r.total_score),
        updatedAt: Number(r.updated_at),
      }));
    }

    return Array.from(this.memoryStats.values())
      .sort((a, b) => b.totalScore - a.totalScore || b.totalWins - a.totalWins)
      .slice(0, limit);
  }

  public shutdown(): void {
    for (const session of this.sessions.values()) {
      this.clearSessionTimer(session);
    }
    this.sessions.clear();
    this.playerGroupIndex.clear();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
