import {
  type BaseGameAction,
  type GameActionResult,
  type GameEngine,
  type GamePlayer,
  cloneState,
  formatPlayerTag,
  nextInt,
  nextRandom,
  resolveInitialSeed,
  shuffleWithSeed,
} from './types.js';

// ============================================================================
// 3. HOT POTATO BOM ENGINE (TIMER ACAK 30-75 DETIK, ESTAFET .pass @target)
// ============================================================================

export interface HotPotatoPassEntry {
  readonly fromJid: string;
  readonly toJid: string;
  readonly round: number;
  readonly timestamp: number;
}

export interface HotPotatoState {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: 'hot_potato';
  status: 'lobby' | 'playing' | 'finished';
  seed: number;
  hostJid: string;
  players: GamePlayer[];
  round: number;
  currentHolderJid: string | null;
  fuseDurationMs: number; // Strictly randomized in [30_000, 75_000]
  roundStartedAt: number;
  bombExplodesAt: number;
  passCount: number;
  passHistory: HotPotatoPassEntry[];
  eliminatedOrder: string[];
  winnerJid?: string;
  wagerAmount: number;
}

export interface HotPotatoAction extends BaseGameAction {
  readonly type: 'JOIN' | 'LEAVE' | 'START' | 'PASS' | 'TICK';
  readonly payload?: {
    readonly playerName?: string;
    readonly targetJid?: string;
    readonly nowMs?: number;
  };
}

export class HotPotatoEngine implements GameEngine<HotPotatoState, HotPotatoAction> {
  readonly gameType = 'hot_potato';
  readonly displayName = 'Hot Potato Bom (Estafet Bom 30-75d)';
  readonly category = 'party' as const;
  readonly minPlayers = 2;
  readonly maxPlayers = 16;
  readonly defaultTurnTimeoutMs = 45_000;

  createInitialState(options: {
    gameId: string;
    groupJid: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): HotPotatoState {
    const seed = resolveInitialSeed(options.customConfig, options.gameId);
    const initialPlayers: GamePlayer[] = [
      {
        ...options.host,
        score: options.host.score ?? 0,
        wounds: 0,
        isEliminated: false,
      },
    ];

    return {
      gameId: options.gameId,
      groupJid: options.groupJid,
      gameType: 'hot_potato',
      status: 'lobby',
      seed,
      hostJid: options.host.jid,
      players: initialPlayers,
      round: 0,
      currentHolderJid: null,
      fuseDurationMs: 45_000,
      roundStartedAt: 0,
      bombExplodesAt: 0,
      passCount: 0,
      passHistory: [],
      eliminatedOrder: [],
      wagerAmount: options.wagerAmount ?? 0,
    };
  }

  private startNewBombRound(next: HotPotatoState, nowMs: number): void {
    const alive = next.players.filter((p) => !p.isEliminated);
    const holderPick = nextInt(next.seed, 0, alive.length - 1);
    next.seed = holderPick.nextSeed;

    // Random bomb fuse strictly between 30,000ms (30s) and 75,000ms (75s)
    const fusePick = nextInt(next.seed, 30_000, 75_000);
    next.seed = fusePick.nextSeed;

    next.round += 1;
    next.currentHolderJid = alive[holderPick.value]?.jid ?? alive[0].jid;
    next.fuseDurationMs = fusePick.value;
    next.roundStartedAt = nowMs;
    next.bombExplodesAt = nowMs + next.fuseDurationMs;
  }

  private triggerExplosion(next: HotPotatoState, nowMs: number): GameActionResult<HotPotatoState> {
    const victimJid = next.currentHolderJid;
    const victim = next.players.find((p) => p.jid === victimJid);
    if (victim) {
      victim.isEliminated = true;
      victim.wounds = (victim.wounds ?? 0) + 1;
      next.eliminatedOrder.push(victim.jid);
    }

    const alive = next.players.filter((p) => !p.isEliminated);
    if (alive.length <= 1) {
      next.status = 'finished';
      const winner = alive[0];
      next.winnerJid = winner?.jid;
      if (winner) {
        winner.score = (winner.score ?? 0) + 100;
      }
      return {
        success: true,
        state: next,
        isGameOver: true,
        winnerJids: winner ? [winner.jid] : [],
        mentions: [victimJid, winner?.jid].filter((x): x is string => Boolean(x)),
        broadcastMessage: [
          `💥 *KABOOM!* Bom meledak di tangan ${victim ? formatPlayerTag(victim.jid) : 'pemain'}!`,
          winner
            ? `🏆 *PEMENANG HOT POTATO:* ${formatPlayerTag(winner.jid)} (${winner.name}) selamat sebagai penyintas terakhir!`
            : 'Permainan berakhir tanpa penyintas.',
        ].join('\n'),
      };
    }

    this.startNewBombRound(next, nowMs);
    return {
      success: true,
      state: next,
      isGameOver: false,
      mentions: [victimJid, next.currentHolderJid].filter((x): x is string => Boolean(x)),
      broadcastMessage: [
        `💥 *BOOM!* Bom meledak di tangan ${victim ? formatPlayerTag(victim.jid) : 'pemain'} dan tereliminasi!`,
        `🔥 *Ronde ${next.round}* dimulai! Bom baru telah menyala di tangan ${formatPlayerTag(next.currentHolderJid!)}.`,
        `Segera oper dengan *.pass @target* sebelum meledak! (Sisa pemain: ${alive.length})`,
      ].join('\n'),
    };
  }

  processAction(state: HotPotatoState, action: HotPotatoAction): GameActionResult<HotPotatoState> {
    const next = cloneState(state);
    const nowMs = action.payload?.nowMs ?? Date.now();

    if (action.type === 'JOIN') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Hot Potato sudah dimulai.', state: next };
      }
      if (next.players.some((p) => p.jid === action.playerJid)) {
        return { success: false, error: 'Kamu sudah terdaftar di lobi Hot Potato.', state: next };
      }
      if (next.players.length >= this.maxPlayers) {
        return { success: false, error: 'Lobi Hot Potato sudah penuh.', state: next };
      }
      const name = action.payload?.playerName ?? formatPlayerTag(action.playerJid);
      next.players.push({
        jid: action.playerJid,
        name,
        score: 0,
        wounds: 0,
        isEliminated: false,
        joinedAt: nowMs,
      });
      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        broadcastMessage: `💣 ${formatPlayerTag(action.playerJid)} bergabung ke Hot Potato Bom! (Total: ${next.players.length} pemain)`,
      };
    }

    if (action.type === 'LEAVE') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Tidak bisa keluar dari lobi saat bom sudah menyala.', state: next };
      }
      next.players = next.players.filter((p) => p.jid !== action.playerJid);
      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        broadcastMessage: `👋 ${formatPlayerTag(action.playerJid)} keluar dari lobi Hot Potato.`,
      };
    }

    if (action.type === 'START') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan sudah berlangsung.', state: next };
      }
      if (next.players.length < this.minPlayers) {
        return {
          success: false,
          error: `Minimal ${this.minPlayers} pemain diperlukan untuk memulai Hot Potato Bom.`,
          state: next,
        };
      }
      next.status = 'playing';
      this.startNewBombRound(next, nowMs);
      return {
        success: true,
        state: next,
        mentions: next.currentHolderJid ? [next.currentHolderJid] : [],
        broadcastMessage: [
          `💣 *HOT POTATO BOM DIMULAI!* (Ronde 1 • ${next.players.length} Pemain)`,
          `Pemegang bom pertama: ${formatPlayerTag(next.currentHolderJid!)}`,
          `Ketik *.pass @target* untuk mengoper bom sebelum sumbu habis!`,
        ].join('\n'),
      };
    }

    if (next.status !== 'playing') {
      return { success: false, error: 'Permainan Hot Potato belum dimulai atau sudah selesai.', state: next };
    }

    if (action.type === 'TICK') {
      if (nowMs >= next.bombExplodesAt) {
        return this.triggerExplosion(next, nowMs);
      }
      return {
        success: true,
        state: next,
        broadcastMessage: `⏳ Sumbu bom masih menyala di tangan ${formatPlayerTag(next.currentHolderJid!)}!`,
        mentions: next.currentHolderJid ? [next.currentHolderJid] : [],
      };
    }

    if (action.type === 'PASS') {
      if (nowMs >= next.bombExplodesAt) {
        return this.triggerExplosion(next, nowMs);
      }
      if (action.playerJid !== next.currentHolderJid) {
        return {
          success: false,
          error: `Kamu sedang tidak memegang bom! Bom ada di tangan ${formatPlayerTag(next.currentHolderJid!)}.`,
          state: next,
        };
      }
      const targetJid = action.payload?.targetJid?.trim();
      if (!targetJid) {
        return {
          success: false,
          error: 'Tentukan target operan bom (contoh: .pass @target).',
          state: next,
        };
      }
      if (targetJid === action.playerJid) {
        return {
          success: false,
          error: 'Tidak bisa mengoper bom ke diri sendiri!',
          state: next,
        };
      }
      const targetPlayer = next.players.find((p) => p.jid === targetJid);
      if (!targetPlayer) {
        return {
          success: false,
          error: 'Target bukan peserta dalam permainan Hot Potato ini.',
          state: next,
        };
      }
      if (targetPlayer.isEliminated) {
        return {
          success: false,
          error: 'Target sudah tereliminasi di ronde sebelumnya!',
          state: next,
        };
      }

      next.currentHolderJid = targetJid;
      next.passCount += 1;
      next.passHistory.push({
        fromJid: action.playerJid,
        toJid: targetJid,
        round: next.round,
        timestamp: nowMs,
      });

      return {
        success: true,
        state: next,
        mentions: [action.playerJid, targetJid],
        broadcastMessage: `🔥 *OPER BOM!* ${formatPlayerTag(action.playerJid)} mengoper bom menyala ke ${formatPlayerTag(targetJid)}! Cepat oper lagi dengan *.pass @target*!`,
      };
    }

    return {
      success: false,
      error: `Aksi Hot Potato tidak dikenal: ${String(action.type)}`,
      state: next,
    };
  }

  handleTurnTimeout(state: HotPotatoState): GameActionResult<HotPotatoState> {
    const next = cloneState(state);
    if (next.status !== 'playing') {
      return {
        success: false,
        error: 'Tidak ada ronde aktif untuk diledakkan.',
        state: next,
      };
    }
    return this.triggerExplosion(next, Date.now());
  }
}
