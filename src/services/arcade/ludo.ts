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
// 9. LUDO ENGINE (4 WARNA, 2-4 PION, KELUAR BASE ANGKA 6, MAKAN PION, FINISH)
// ============================================================================

export type LudoColor = 'RED' | 'GREEN' | 'YELLOW' | 'BLUE';

export interface LudoToken {
  readonly tokenIndex: number;
  readonly ownerJid: string;
  readonly color: LudoColor;
  /**
   * step = -1     -> In home BASE (needs 6 to exit to step 0)
   * step = 0..50  -> On main 52-tile circular track
   * step = 51..55 -> On colored home stretch (Jalur Finish)
   * step = 56     -> Reached FINISH!
   */
  step: number;
}

export interface LudoState {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: 'ludo';
  status: 'lobby' | 'playing' | 'finished';
  seed: number;
  hostJid: string;
  tokensPerPlayer: number;
  players: GamePlayer[];
  playerColors: Record<string, LudoColor>;
  tokens: Record<string, LudoToken[]>;
  currentTurnIndex: number;
  phase: 'awaiting_roll' | 'awaiting_move';
  pendingDice: number | null;
  consecutiveSixes: number;
  winnerJid?: string;
  wagerAmount: number;
}

export interface LudoAction extends BaseGameAction {
  readonly type: 'JOIN' | 'START' | 'ROLL' | 'MOVE_TOKEN';
  readonly payload?: {
    readonly playerName?: string;
    readonly forcedDice?: number;
    readonly tokenIndex?: number;
  };
}

const LUDO_COLORS: readonly LudoColor[] = ['RED', 'GREEN', 'YELLOW', 'BLUE'];
const LUDO_COLOR_OFFSETS: Readonly<Record<LudoColor, number>> = {
  RED: 0,
  GREEN: 13,
  YELLOW: 26,
  BLUE: 39,
};
export const LUDO_SAFE_GLOBAL_SQUARES: readonly number[] = [0, 8, 13, 21, 26, 34, 39, 47];
export const LUDO_FINISH_STEP = 56;

export function getLudoGlobalTrackSquare(color: LudoColor, step: number): number | null {
  if (step < 0 || step > 50) return null;
  return (LUDO_COLOR_OFFSETS[color] + step) % 52;
}

export function canLudoTokenMove(token: LudoToken, dice: number): boolean {
  if (token.step === -1) {
    return dice === 6;
  }
  if (token.step >= LUDO_FINISH_STEP) {
    return false;
  }
  return token.step + dice <= LUDO_FINISH_STEP;
}

export class LudoEngine implements GameEngine<LudoState, LudoAction> {
  readonly gameType = 'ludo';
  readonly displayName = 'Ludo Klasik (4 Warna, Keluar Base 6 & Makan Pion)';
  readonly category = 'board' as const;
  readonly minPlayers = 2;
  readonly maxPlayers = 4;
  readonly defaultTurnTimeoutMs = 45_000;

  createInitialState(options: {
    gameId: string;
    groupJid: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): LudoState {
    const seed = resolveInitialSeed(options.customConfig, options.gameId);
    const rawTokens = options.customConfig?.tokensPerPlayer;
    const tokensPerPlayer = typeof rawTokens === 'number'
      ? Math.max(2, Math.min(4, Math.floor(rawTokens)))
      : 4;

    const hostColor: LudoColor = 'RED';
    const hostTokens: LudoToken[] = Array.from({ length: tokensPerPlayer }, (_, idx) => ({
      tokenIndex: idx,
      ownerJid: options.host.jid,
      color: hostColor,
      step: -1,
    }));

    return {
      gameId: options.gameId,
      groupJid: options.groupJid,
      gameType: 'ludo',
      status: 'lobby',
      seed,
      hostJid: options.host.jid,
      tokensPerPlayer,
      players: [{ ...options.host, score: options.host.score ?? 0 }],
      playerColors: { [options.host.jid]: hostColor },
      tokens: { [options.host.jid]: hostTokens },
      currentTurnIndex: 0,
      phase: 'awaiting_roll',
      pendingDice: null,
      consecutiveSixes: 0,
      wagerAmount: options.wagerAmount ?? 0,
    };
  }

  private executeTokenMove(
    next: LudoState,
    player: GamePlayer,
    tokenIndex: number,
    dice: number,
  ): GameActionResult<LudoState> {
    const playerTokens = next.tokens[player.jid] ?? [];
    const token = playerTokens[tokenIndex];
    if (!token || !canLudoTokenMove(token, dice)) {
      return {
        success: false,
        error: `Pion #${tokenIndex + 1} tidak dapat digerakkan dengan angka dadu ${dice}.`,
        state: next,
      };
    }

    const prevStep = token.step;
    if (token.step === -1) {
      token.step = 0;
    } else {
      token.step += dice;
    }

    const logs: string[] = [];
    if (prevStep === -1) {
      logs.push(
        `🚀 *KELUAR BASE!* ${formatPlayerTag(player.jid)} mengeluarkan Pion #${tokenIndex + 1} (${token.color}) ke petak awal!`,
      );
    } else if (token.step === LUDO_FINISH_STEP) {
      logs.push(
        `🏁 *MASUK FINISH!* Pion #${tokenIndex + 1} milik ${formatPlayerTag(player.jid)} tiba di garis akhir!`,
      );
    } else {
      logs.push(
        `🏃 ${formatPlayerTag(player.jid)} memajukan Pion #${tokenIndex + 1} (${token.color}) sejauh ${dice} langkah (Step ${prevStep} → ${token.step}).`,
      );
    }

    // Check capture on main circular track (steps 0..50)
    let capturedCount = 0;
    const globalSq = getLudoGlobalTrackSquare(token.color, token.step);
    if (globalSq !== null && !LUDO_SAFE_GLOBAL_SQUARES.includes(globalSq)) {
      for (const otherPlayer of next.players) {
        if (otherPlayer.jid === player.jid) continue;
        const oppTokens = next.tokens[otherPlayer.jid] ?? [];
        for (const oppToken of oppTokens) {
          const oppGlobal = getLudoGlobalTrackSquare(oppToken.color, oppToken.step);
          if (oppGlobal === globalSq) {
            oppToken.step = -1; // Sent back to BASE!
            capturedCount += 1;
            logs.push(
              `⚔️ *MAKAN PION LAWAN!* Pion #${oppToken.tokenIndex + 1} milik ${formatPlayerTag(otherPlayer.jid)} tertangkap di petak #${globalSq} dan dipulangkan ke BASE!`,
            );
          }
        }
      }
    }

    next.pendingDice = null;
    next.phase = 'awaiting_roll';

    // Check if all tokens of current player reached FINISH
    if (playerTokens.every((t) => t.step === LUDO_FINISH_STEP)) {
      next.status = 'finished';
      next.winnerJid = player.jid;
      player.score = (player.score ?? 0) + 200;
      logs.push(
        `🏆 *LUDO SELESAI!* Seluruh pion ${formatPlayerTag(player.jid)} (${player.name}) telah masuk Finish!`,
      );
      return {
        success: true,
        state: next,
        isGameOver: true,
        winnerJids: [player.jid],
        mentions: next.players.map((p) => p.jid),
        broadcastMessage: logs.join('\n'),
      };
    }

    const reachedFinishNow = token.step === LUDO_FINISH_STEP;
    const getsBonusTurn =
      (dice === 6 && next.consecutiveSixes < 2) || capturedCount > 0 || reachedFinishNow;

    if (getsBonusTurn) {
      if (dice === 6) next.consecutiveSixes += 1;
      logs.push(`✨ *Bonus Giliran!* ${formatPlayerTag(player.jid)} berhak melempar dadu lagi!`);
    } else {
      next.consecutiveSixes = 0;
      next.currentTurnIndex = (next.currentTurnIndex + 1) % next.players.length;
      const nextP = next.players[next.currentTurnIndex];
      logs.push(`👉 Giliran selanjutnya: ${formatPlayerTag(nextP.jid)} (${next.playerColors[nextP.jid]})`);
    }

    return {
      success: true,
      state: next,
      isGameOver: false,
      mentions: [player.jid, next.players[next.currentTurnIndex].jid],
      broadcastMessage: logs.join('\n'),
    };
  }

  processAction(state: LudoState, action: LudoAction): GameActionResult<LudoState> {
    const next = cloneState(state);

    if (action.type === 'JOIN') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Ludo sudah dimulai.', state: next };
      }
      if (next.players.some((p) => p.jid === action.playerJid)) {
        return { success: false, error: 'Kamu sudah terdaftar di lobi Ludo.', state: next };
      }
      if (next.players.length >= this.maxPlayers) {
        return { success: false, error: 'Lobi Ludo sudah penuh (maks 4 pemain).', state: next };
      }
      const assignedColor = LUDO_COLORS[next.players.length];
      next.players.push({
        jid: action.playerJid,
        name: action.payload?.playerName ?? formatPlayerTag(action.playerJid),
        score: 0,
        joinedAt: Date.now(),
      });
      next.playerColors[action.playerJid] = assignedColor;
      next.tokens[action.playerJid] = Array.from({ length: next.tokensPerPlayer }, (_, idx) => ({
        tokenIndex: idx,
        ownerJid: action.playerJid,
        color: assignedColor,
        step: -1,
      }));
      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        broadcastMessage: `🎲 ${formatPlayerTag(action.playerJid)} bergabung ke Ludo sebagai warna *${assignedColor}*! (${next.players.length}/4 pemain)`,
      };
    }

    if (action.type === 'START') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Ludo sudah berlangsung.', state: next };
      }
      if (next.players.length < this.minPlayers) {
        return {
          success: false,
          error: `Minimal ${this.minPlayers} pemain diperlukan untuk memulai Ludo.`,
          state: next,
        };
      }
      next.status = 'playing';
      next.currentTurnIndex = 0;
      next.phase = 'awaiting_roll';
      next.pendingDice = null;
      next.consecutiveSixes = 0;
      const first = next.players[0];
      return {
        success: true,
        state: next,
        mentions: next.players.map((p) => p.jid),
        broadcastMessage: [
          `🎲 *LUDO DIMULAI!* (${next.players.length} Pemain • ${next.tokensPerPlayer} Pion/Pemain)`,
          `Aturan: Lempar angka *6* untuk mengeluarkan pion dari Base, tangkap pion lawan di petak non-aman, dan bawa semua pion ke Finish!`,
          `Giliran Pertama: ${formatPlayerTag(first.jid)} (*${next.playerColors[first.jid]}*)`,
        ].join('\n'),
      };
    }

    if (next.status !== 'playing') {
      return { success: false, error: 'Permainan Ludo belum dimulai atau sudah selesai.', state: next };
    }

    const activePlayer = next.players[next.currentTurnIndex];
    if (!activePlayer || activePlayer.jid !== action.playerJid) {
      return {
        success: false,
        error: `Sekarang adalah giliran ${activePlayer ? formatPlayerTag(activePlayer.jid) : 'pemain lain'}!`,
        state: next,
      };
    }

    if (action.type === 'ROLL') {
      if (next.phase !== 'awaiting_roll') {
        return {
          success: false,
          error: `Kamu sudah melempar dadu (${next.pendingDice}). Pilih pion untuk digerakkan (MOVE_TOKEN)!`,
          state: next,
        };
      }

      let dice: number;
      if (
        typeof action.payload?.forcedDice === 'number' &&
        action.payload.forcedDice >= 1 &&
        action.payload.forcedDice <= 6
      ) {
        dice = Math.floor(action.payload.forcedDice);
      } else {
        const step = nextInt(next.seed, 1, 6);
        next.seed = step.nextSeed;
        dice = step.value;
      }

      const playerTokens = next.tokens[activePlayer.jid] ?? [];
      const movable = playerTokens.filter((t) => canLudoTokenMove(t, dice));

      if (movable.length === 0) {
        next.consecutiveSixes = 0;
        next.currentTurnIndex = (next.currentTurnIndex + 1) % next.players.length;
        const nextP = next.players[next.currentTurnIndex];
        return {
          success: true,
          state: next,
          mentions: [activePlayer.jid, nextP.jid],
          broadcastMessage: `🎲 ${formatPlayerTag(activePlayer.jid)} melempar *[ ${dice} ]*, tetapi tidak ada pion yang bisa bergerak. Giliran berpindah ke ${formatPlayerTag(nextP.jid)}!`,
        };
      }

      // If caller passed preferred tokenIndex or only 1 unique move exists, execute immediately
      const requestedIdx = action.payload?.tokenIndex;
      if (typeof requestedIdx === 'number' && movable.some((m) => m.tokenIndex === requestedIdx)) {
        return this.executeTokenMove(next, activePlayer, requestedIdx, dice);
      }

      const allSameStep = movable.every((m) => m.step === movable[0].step);
      if (movable.length === 1 || allSameStep) {
        return this.executeTokenMove(next, activePlayer, movable[0].tokenIndex, dice);
      }

      next.phase = 'awaiting_move';
      next.pendingDice = dice;
      const optionsText = movable
        .map((m) => `Pion #${m.tokenIndex + 1} (${m.step === -1 ? 'Di Base' : `Step ${m.step}`})`)
        .join(', ');

      return {
        success: true,
        state: next,
        mentions: [activePlayer.jid],
        broadcastMessage: `🎲 ${formatPlayerTag(activePlayer.jid)} mendapat dadu *[ ${dice} ]*! Pilih pion yang ingin dijalankan: ${optionsText}`,
      };
    }

    if (action.type === 'MOVE_TOKEN') {
      if (next.phase !== 'awaiting_move' || next.pendingDice === null) {
        return {
          success: false,
          error: 'Lempar dadu terlebih dahulu (ROLL) sebelum memilih pion!',
          state: next,
        };
      }
      const tokenIdx = action.payload?.tokenIndex ?? 0;
      return this.executeTokenMove(next, activePlayer, tokenIdx, next.pendingDice);
    }

    return {
      success: false,
      error: `Aksi Ludo tidak dikenal: ${String(action.type)}`,
      state: next,
    };
  }

  handleTurnTimeout(state: LudoState): GameActionResult<LudoState> {
    const next = cloneState(state);
    if (next.status !== 'playing') {
      return { success: false, error: 'Tidak ada permainan Ludo yang sedang aktif.', state: next };
    }
    const activePlayer = next.players[next.currentTurnIndex];
    if (next.phase === 'awaiting_move' && next.pendingDice !== null) {
      const movable = (next.tokens[activePlayer.jid] ?? []).find((t) =>
        canLudoTokenMove(t, next.pendingDice!),
      );
      if (movable) {
        return this.executeTokenMove(next, activePlayer, movable.tokenIndex, next.pendingDice);
      }
    }
    next.pendingDice = null;
    next.phase = 'awaiting_roll';
    next.consecutiveSixes = 0;
    next.currentTurnIndex = (next.currentTurnIndex + 1) % next.players.length;
    const nextP = next.players[next.currentTurnIndex];

    return {
      success: true,
      state: next,
      mentions: [activePlayer.jid, nextP.jid],
      broadcastMessage: `⏰ Waktu giliran ${formatPlayerTag(activePlayer.jid)} habis! Giliran berpindah ke ${formatPlayerTag(nextP.jid)}.`,
    };
  }
}
