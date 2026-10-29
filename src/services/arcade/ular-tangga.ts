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
// 8. ULAR TANGGA ENGINE (GRID 100 KOTAK, DADU 1-6, BOUNCE-BACK TEPAT 100)
// ============================================================================

export interface SnakesAndLaddersMoveLog {
  readonly playerJid: string;
  readonly dice: number;
  readonly fromSquare: number;
  readonly rawSquare: number;
  readonly finalSquare: number;
  readonly event: 'normal' | 'ladder' | 'snake' | 'bounce' | 'bounce_snake' | 'win';
}

export interface SnakesAndLaddersState {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: 'ular_tangga';
  status: 'lobby' | 'playing' | 'finished';
  seed: number;
  hostJid: string;
  players: GamePlayer[];
  positions: Record<string, number>; // 1..100 (starts at 1 or 0; default 0 before first roll)
  currentTurnIndex: number;
  consecutiveSixes: number;
  ladders: Readonly<Record<number, number>>;
  snakes: Readonly<Record<number, number>>;
  lastMove?: SnakesAndLaddersMoveLog;
  winnerJid?: string;
  wagerAmount: number;
}

export interface SnakesAndLaddersAction extends BaseGameAction {
  readonly type: 'JOIN' | 'START' | 'ROLL';
  readonly payload?: {
    readonly playerName?: string;
    readonly forcedDice?: number;
  };
}

export const DEFAULT_LADDERS_MAP: Readonly<Record<number, number>> = {
  4: 25,
  13: 46,
  33: 49,
  42: 63,
  50: 69,
  62: 81,
  74: 92,
};

export const DEFAULT_SNAKES_MAP: Readonly<Record<number, number>> = {
  46: 5,
  48: 9,
  52: 11,
  59: 17,
  64: 36,
  69: 33,
  73: 1,
  83: 19,
  92: 51,
  95: 56,
  98: 28,
};

export class SnakesAndLaddersEngine
  implements GameEngine<SnakesAndLaddersState, SnakesAndLaddersAction>
{
  readonly gameType = 'ular_tangga';
  readonly displayName = 'Ular Tangga 100 Petak (Tepat Kotak 100)';
  readonly category = 'board' as const;
  readonly minPlayers = 2;
  readonly maxPlayers = 6;
  readonly defaultTurnTimeoutMs = 45_000;

  createInitialState(options: {
    gameId: string;
    groupJid: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): SnakesAndLaddersState {
    const seed = resolveInitialSeed(options.customConfig, options.gameId);
    const startSquare = typeof options.customConfig?.startSquare === 'number'
      ? Math.max(0, Math.min(99, Math.floor(options.customConfig.startSquare)))
      : 0;

    return {
      gameId: options.gameId,
      groupJid: options.groupJid,
      gameType: 'ular_tangga',
      status: 'lobby',
      seed,
      hostJid: options.host.jid,
      players: [{ ...options.host, score: options.host.score ?? 0 }],
      positions: { [options.host.jid]: startSquare },
      currentTurnIndex: 0,
      consecutiveSixes: 0,
      ladders: DEFAULT_LADDERS_MAP,
      snakes: DEFAULT_SNAKES_MAP,
      wagerAmount: options.wagerAmount ?? 0,
    };
  }

  private executeRollForCurrentPlayer(
    next: SnakesAndLaddersState,
    forcedDice?: number,
  ): GameActionResult<SnakesAndLaddersState> {
    const player = next.players[next.currentTurnIndex];
    let dice: number;
    if (typeof forcedDice === 'number' && forcedDice >= 1 && forcedDice <= 6) {
      dice = Math.floor(forcedDice);
    } else {
      const step = nextInt(next.seed, 1, 6);
      next.seed = step.nextSeed;
      dice = step.value;
    }

    const fromSquare = next.positions[player.jid] ?? 0;
    let rawSquare = fromSquare + dice;
    let bounced = false;

    if (rawSquare > 100) {
      bounced = true;
      rawSquare = 100 - (rawSquare - 100);
    }

    let finalSquare = rawSquare;
    let event: SnakesAndLaddersMoveLog['event'] = bounced ? 'bounce' : 'normal';
    const notes: string[] = [
      `🎲 ${formatPlayerTag(player.jid)} melempar dadu: *[ ${dice} ]* (${fromSquare} → ${rawSquare})`,
    ];

    if (bounced) {
      notes.push(`↩️ *Terpental dari petak 100!* Mundur kembali ke petak *${rawSquare}*.`);
    }

    if (finalSquare === 100) {
      event = 'win';
      next.positions[player.jid] = 100;
      next.status = 'finished';
      next.winnerJid = player.jid;
      player.score = (player.score ?? 0) + 150;
      next.lastMove = {
        playerJid: player.jid,
        dice,
        fromSquare,
        rawSquare,
        finalSquare: 100,
        event,
      };
      notes.push(
        `🏆 *TEPAT DI KOTAK 100!* ${formatPlayerTag(player.jid)} (${player.name}) memenangkan Ular Tangga!`,
      );
      return {
        success: true,
        state: next,
        isGameOver: true,
        winnerJids: [player.jid],
        mentions: next.players.map((p) => p.jid),
        broadcastMessage: notes.join('\n'),
      };
    }

    if (next.ladders[rawSquare] !== undefined) {
      finalSquare = next.ladders[rawSquare];
      event = 'ladder';
      notes.push(`🪜 *NAIK TANGGA!* Dari petak ${rawSquare} melesat naik ke petak *${finalSquare}*!`);
    } else if (next.snakes[rawSquare] !== undefined) {
      finalSquare = next.snakes[rawSquare];
      event = bounced ? 'bounce_snake' : 'snake';
      notes.push(`🐍 *DIPATUK ULAR!* Dari petak ${rawSquare} melorot turun ke petak *${finalSquare}*!`);
    }

    next.positions[player.jid] = finalSquare;
    next.lastMove = {
      playerJid: player.jid,
      dice,
      fromSquare,
      rawSquare,
      finalSquare,
      event,
    };

    // Bonus roll on 6 (max 2 consecutive bonus rolls)
    if (dice === 6 && next.consecutiveSixes < 2) {
      next.consecutiveSixes += 1;
      notes.push(`✨ *Dadu 6!* ${formatPlayerTag(player.jid)} mendapat bonus lemparan lagi!`);
    } else {
      next.consecutiveSixes = 0;
      next.currentTurnIndex = (next.currentTurnIndex + 1) % next.players.length;
      const nextPlayer = next.players[next.currentTurnIndex];
      notes.push(`👉 Giliran selanjutnya: ${formatPlayerTag(nextPlayer.jid)} (Petak ${next.positions[nextPlayer.jid] ?? 0})`);
    }

    return {
      success: true,
      state: next,
      isGameOver: false,
      mentions: [player.jid, next.players[next.currentTurnIndex].jid],
      broadcastMessage: notes.join('\n'),
    };
  }

  processAction(
    state: SnakesAndLaddersState,
    action: SnakesAndLaddersAction,
  ): GameActionResult<SnakesAndLaddersState> {
    const next = cloneState(state);

    if (action.type === 'JOIN') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Ular Tangga sudah dimulai.', state: next };
      }
      if (next.players.some((p) => p.jid === action.playerJid)) {
        return { success: false, error: 'Kamu sudah berada di lobi Ular Tangga.', state: next };
      }
      if (next.players.length >= this.maxPlayers) {
        return { success: false, error: 'Lobi Ular Tangga sudah penuh.', state: next };
      }
      next.players.push({
        jid: action.playerJid,
        name: action.payload?.playerName ?? formatPlayerTag(action.playerJid),
        score: 0,
        joinedAt: Date.now(),
      });
      next.positions[action.playerJid] = 0;
      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        broadcastMessage: `🐍 ${formatPlayerTag(action.playerJid)} bergabung ke Ular Tangga! (Total: ${next.players.length} pemain)`,
      };
    }

    if (action.type === 'START') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Ular Tangga sudah berjalan.', state: next };
      }
      if (next.players.length < this.minPlayers) {
        return {
          success: false,
          error: `Minimal ${this.minPlayers} pemain diperlukan untuk memulai Ular Tangga.`,
          state: next,
        };
      }
      next.status = 'playing';
      next.currentTurnIndex = 0;
      next.consecutiveSixes = 0;
      const first = next.players[0];
      return {
        success: true,
        state: next,
        mentions: next.players.map((p) => p.jid),
        broadcastMessage: [
          `🐍🪜 *ULAR TANGGA 100 PETAK DIMULAI!* (${next.players.length} Pemain)`,
          `Aturan: Wajib mendarat *tepat di petak 100* untuk menang (kelebihan angka akan terpental mundur).`,
          `Giliran Pertama: ${formatPlayerTag(first.jid)} — Ketik *roll* untuk melempar dadu!`,
        ].join('\n'),
      };
    }

    if (next.status !== 'playing') {
      return {
        success: false,
        error: 'Permainan Ular Tangga belum dimulai atau sudah selesai.',
        state: next,
      };
    }

    if (action.type === 'ROLL') {
      const current = next.players[next.currentTurnIndex];
      if (!current || current.jid !== action.playerJid) {
        return {
          success: false,
          error: `Sekarang adalah giliran ${current ? formatPlayerTag(current.jid) : 'pemain lain'}!`,
          state: next,
        };
      }
      return this.executeRollForCurrentPlayer(next, action.payload?.forcedDice);
    }

    return {
      success: false,
      error: `Aksi Ular Tangga tidak dikenal: ${String(action.type)}`,
      state: next,
    };
  }

  handleTurnTimeout(state: SnakesAndLaddersState): GameActionResult<SnakesAndLaddersState> {
    const next = cloneState(state);
    if (next.status !== 'playing') {
      return { success: false, error: 'Tidak ada permainan Ular Tangga yang aktif.', state: next };
    }
    const res = this.executeRollForCurrentPlayer(next);
    return {
      ...res,
      broadcastMessage: `⏰ Waktu giliran habis (Auto-Roll)!\n${res.broadcastMessage ?? ''}`,
    };
  }
}
