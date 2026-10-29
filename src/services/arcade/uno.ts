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
// 6. UNO ENGINE (108 KARTU WARNA + DRAW 2, SKIP, REVERSE, WILD, WILD DRAW 4)
// ============================================================================

export type UnoColor = 'red' | 'yellow' | 'green' | 'blue';
export type UnoCardColor = UnoColor | 'wild';
export type UnoCardValue =
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
  | 'skip' | 'reverse' | 'draw2' | 'wild' | 'wild_draw4';

export interface UnoCard {
  readonly id: string;
  readonly color: UnoCardColor;
  readonly value: UnoCardValue;
  readonly label: string;
}

export interface UnoState {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: 'uno';
  status: 'lobby' | 'playing' | 'finished';
  seed: number;
  hostJid: string;
  players: GamePlayer[];
  hands: Record<string, UnoCard[]>;
  drawPile: UnoCard[];
  discardPile: UnoCard[];
  activeColor: UnoColor;
  currentTurnIndex: number;
  direction: 1 | -1;
  hasDrawnThisTurn: boolean;
  unoCalled: Record<string, boolean>;
  winnerJid?: string;
  wagerAmount: number;
}

export interface UnoAction extends BaseGameAction {
  readonly type: 'JOIN' | 'START' | 'PLAY_CARD' | 'DRAW_CARD' | 'PASS_TURN' | 'CALL_UNO';
  readonly payload?: {
    readonly playerName?: string;
    readonly cardId?: string;
    readonly cardIndex?: number;
    readonly chosenColor?: UnoColor;
  };
}

const UNO_COLORS: readonly UnoColor[] = ['red', 'yellow', 'green', 'blue'];
const UNO_COLOR_NAMES_ID: Readonly<Record<UnoColor, string>> = {
  red: '🟥 Merah',
  yellow: '🟨 Kuning',
  green: '🟩 Hijau',
  blue: '🟦 Biru',
};

/**
 * Builds the official 108-card Uno deck:
 * - 4 colors × (one '0' + two each of '1'..'9' + two 'skip' + two 'reverse' + two 'draw2') = 100 cards
 * - 4 'wild' + 4 'wild_draw4' = 8 cards
 * Total = 108 cards.
 */
export function buildUnoDeck108(): UnoCard[] {
  const deck: UnoCard[] = [];
  let seq = 1;

  for (const color of UNO_COLORS) {
    const cPrefix = color[0].toUpperCase();
    deck.push({
      id: `UNO-${seq++}`,
      color,
      value: '0',
      label: `${cPrefix}-0`,
    });

    const doubledValues: readonly UnoCardValue[] = [
      '1', '2', '3', '4', '5', '6', '7', '8', '9',
      'skip', 'reverse', 'draw2',
    ];
    for (const val of doubledValues) {
      for (let copy = 0; copy < 2; copy++) {
        deck.push({
          id: `UNO-${seq++}`,
          color,
          value: val,
          label: `${cPrefix}-${val.toUpperCase()}`,
        });
      }
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push({
      id: `UNO-${seq++}`,
      color: 'wild',
      value: 'wild',
      label: 'WILD',
    });
    deck.push({
      id: `UNO-${seq++}`,
      color: 'wild',
      value: 'wild_draw4',
      label: 'WILD+4',
    });
  }

  return deck;
}

export function isValidUnoPlay(
  card: UnoCard,
  topDiscard: UnoCard,
  activeColor: UnoColor,
): boolean {
  if (card.color === 'wild') return true;
  if (card.color === activeColor) return true;
  if (card.value === topDiscard.value) return true;
  return false;
}

export class UnoEngine implements GameEngine<UnoState, UnoAction> {
  readonly gameType = 'uno';
  readonly displayName = 'Uno Klasik (108 Kartu Resmi)';
  readonly category = 'card' as const;
  readonly minPlayers = 2;
  readonly maxPlayers = 10;
  readonly defaultTurnTimeoutMs = 45_000;

  createInitialState(options: {
    gameId: string;
    groupJid: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): UnoState {
    const initialSeed = resolveInitialSeed(options.customConfig, options.gameId);
    const shuffled = shuffleWithSeed(buildUnoDeck108(), initialSeed);

    return {
      gameId: options.gameId,
      groupJid: options.groupJid,
      gameType: 'uno',
      status: 'lobby',
      seed: shuffled.nextSeed,
      hostJid: options.host.jid,
      players: [{ ...options.host, score: options.host.score ?? 0 }],
      hands: {},
      drawPile: shuffled.items,
      discardPile: [],
      activeColor: 'red',
      currentTurnIndex: 0,
      direction: 1,
      hasDrawnThisTurn: false,
      unoCalled: {},
      wagerAmount: options.wagerAmount ?? 0,
    };
  }

  private drawFromPile(state: UnoState, count: number): UnoCard[] {
    const drawn: UnoCard[] = [];
    for (let i = 0; i < count; i++) {
      if (state.drawPile.length === 0) {
        if (state.discardPile.length <= 1) break;
        const top = state.discardPile.pop()!;
        const reshuffled = shuffleWithSeed(state.discardPile, state.seed);
        state.drawPile = reshuffled.items;
        state.seed = reshuffled.nextSeed;
        state.discardPile = [top];
      }
      const nextCard = state.drawPile.shift();
      if (nextCard) drawn.push(nextCard);
    }
    return drawn;
  }

  private stepIndex(state: UnoState, fromIndex: number, steps = 1): number {
    const n = state.players.length;
    return (((fromIndex + steps * state.direction) % n) + n) % n;
  }

  private formatHandDm(playerJid: string, state: UnoState): { recipientJid: string; text: string } {
    const hand = state.hands[playerJid] ?? [];
    const list = hand.map((c, idx) => `${idx + 1}. [${c.label}] (${c.id})`).join('\n');
    return {
      recipientJid: playerJid,
      text: `🃏 *KARTU UNO KAMU (${hand.length} Kartu):*\n${list || '(Kosong)'}`,
    };
  }

  processAction(state: UnoState, action: UnoAction): GameActionResult<UnoState> {
    const next = cloneState(state);

    if (action.type === 'JOIN') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Uno sudah dimulai.', state: next };
      }
      if (next.players.some((p) => p.jid === action.playerJid)) {
        return { success: false, error: 'Kamu sudah berada di lobi Uno.', state: next };
      }
      if (next.players.length >= this.maxPlayers) {
        return { success: false, error: 'Lobi Uno sudah penuh.', state: next };
      }
      next.players.push({
        jid: action.playerJid,
        name: action.payload?.playerName ?? formatPlayerTag(action.playerJid),
        score: 0,
        joinedAt: Date.now(),
      });
      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        broadcastMessage: `🎴 ${formatPlayerTag(action.playerJid)} bergabung ke lobi Uno! (${next.players.length} pemain)`,
      };
    }

    if (action.type === 'START') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Uno sudah berjalan.', state: next };
      }
      if (next.players.length < this.minPlayers) {
        return {
          success: false,
          error: `Minimal ${this.minPlayers} pemain diperlukan untuk memulai Uno.`,
          state: next,
        };
      }

      next.status = 'playing';
      for (const p of next.players) {
        next.hands[p.jid] = this.drawFromPile(next, 7);
        next.unoCalled[p.jid] = false;
      }

      // Flip initial starter card (ensure it is a colored card)
      let starter = this.drawFromPile(next, 1)[0];
      while (starter && starter.color === 'wild' && next.drawPile.length > 0) {
        next.drawPile.push(starter);
        starter = this.drawFromPile(next, 1)[0];
      }
      if (!starter) {
        starter = { id: 'UNO-INIT', color: 'red', value: '0', label: 'R-0' };
      }
      next.discardPile = [starter];
      next.activeColor = starter.color === 'wild' ? 'red' : starter.color;
      next.currentTurnIndex = 0;
      next.hasDrawnThisTurn = false;

      const dms = next.players.map((p) => this.formatHandDm(p.jid, next));
      const activePlayer = next.players[next.currentTurnIndex];

      return {
        success: true,
        state: next,
        mentions: next.players.map((p) => p.jid),
        directMessages: dms,
        broadcastMessage: [
          `🎴 *UNO DIMULAI!* (${next.players.length} Pemain • 108 Kartu)`,
          `Kartu Atas: *[${starter.label}]* • Warna Aktif: *${UNO_COLOR_NAMES_ID[next.activeColor]}*`,
          `Giliran Pertama: ${formatPlayerTag(activePlayer.jid)}`,
        ].join('\n'),
      };
    }

    if (next.status !== 'playing') {
      return {
        success: false,
        error: 'Permainan Uno belum dimulai atau sudah selesai.',
        state: next,
      };
    }

    if (action.type === 'CALL_UNO') {
      const hand = next.hands[action.playerJid] ?? [];
      if (hand.length > 2) {
        return {
          success: false,
          error: 'Teriakan UNO! hanya bisa dilakukan saat kartumu tersisa 1 atau 2 lembar.',
          state: next,
        };
      }
      next.unoCalled[action.playerJid] = true;
      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        broadcastMessage: `📢 *UNO!* ${formatPlayerTag(action.playerJid)} menyisakan ${hand.length} kartu!`,
      };
    }

    const currentPlayer = next.players[next.currentTurnIndex];
    if (!currentPlayer || currentPlayer.jid !== action.playerJid) {
      return {
        success: false,
        error: `Sekarang adalah giliran ${currentPlayer ? formatPlayerTag(currentPlayer.jid) : 'pemain lain'}!`,
        state: next,
      };
    }

    const playerHand = next.hands[action.playerJid] ?? [];
    const topDiscard = next.discardPile[next.discardPile.length - 1];

    if (action.type === 'DRAW_CARD') {
      if (next.hasDrawnThisTurn) {
        return {
          success: false,
          error: 'Kamu sudah mengambil kartu pada giliran ini. Mainkan kartu atau lewati giliran (PASS_TURN).',
          state: next,
        };
      }
      const drawn = this.drawFromPile(next, 1);
      playerHand.push(...drawn);
      next.hasDrawnThisTurn = true;
      next.unoCalled[action.playerJid] = false;

      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        directMessages: [this.formatHandDm(action.playerJid, next)],
        broadcastMessage: `📥 ${formatPlayerTag(action.playerJid)} mengambil 1 kartu dari tumpukan. (Total kartu: ${playerHand.length})`,
      };
    }

    if (action.type === 'PASS_TURN') {
      if (!next.hasDrawnThisTurn) {
        return {
          success: false,
          error: 'Kamu wajib mengambil 1 kartu (DRAW_CARD) terlebih dahulu sebelum melewati giliran!',
          state: next,
        };
      }
      next.currentTurnIndex = this.stepIndex(next, next.currentTurnIndex, 1);
      next.hasDrawnThisTurn = false;
      const nextPlayer = next.players[next.currentTurnIndex];

      return {
        success: true,
        state: next,
        mentions: [action.playerJid, nextPlayer.jid],
        broadcastMessage: `⏭️ ${formatPlayerTag(action.playerJid)} melewati giliran. Sekarang giliran ${formatPlayerTag(nextPlayer.jid)}!`,
      };
    }

    if (action.type === 'PLAY_CARD') {
      let cardIdx = -1;
      if (typeof action.payload?.cardIndex === 'number') {
        cardIdx = action.payload.cardIndex;
      } else if (typeof action.payload?.cardId === 'string') {
        const targetId = action.payload.cardId.trim().toUpperCase();
        cardIdx = playerHand.findIndex(
          (c) => c.id.toUpperCase() === targetId || c.label.toUpperCase() === targetId,
        );
      }

      if (cardIdx < 0 || cardIdx >= playerHand.length) {
        return {
          success: false,
          error: 'Kartu yang dipilih tidak ditemukan di tanganmu.',
          state: next,
        };
      }

      const chosenCard = playerHand[cardIdx];
      if (!isValidUnoPlay(chosenCard, topDiscard, next.activeColor)) {
        return {
          success: false,
          error: `Kartu *[${chosenCard.label}]* tidak cocok dengan kartu atas *[${topDiscard.label}]* atau warna aktif *${UNO_COLOR_NAMES_ID[next.activeColor]}*!`,
          state: next,
        };
      }

      if (chosenCard.color === 'wild') {
        const pickedColor = action.payload?.chosenColor;
        if (pickedColor && !UNO_COLORS.includes(pickedColor)) {
          return {
            success: false,
            error: 'Pilihan warna Wild harus red, yellow, green, atau blue.',
            state: next,
          };
        }
        next.activeColor = pickedColor ?? 'red';
      } else {
        next.activeColor = chosenCard.color;
      }

      // Remove played card from hand and push to discard pile
      playerHand.splice(cardIdx, 1);
      next.discardPile.push(chosenCard);
      next.hasDrawnThisTurn = false;

      // Check victory
      if (playerHand.length === 0) {
        next.status = 'finished';
        next.winnerJid = action.playerJid;
        currentPlayer.score = (currentPlayer.score ?? 0) + 150;
        return {
          success: true,
          state: next,
          isGameOver: true,
          winnerJids: [action.playerJid],
          mentions: next.players.map((p) => p.jid),
          broadcastMessage: `🏆 *UNO SELESAI!* ${formatPlayerTag(action.playerJid)} membuang kartu terakhir *[${chosenCard.label}]* dan memenangkan pertandingan!`,
        };
      }

      const dms: Array<{ recipientJid: string; text: string }> = [
        this.formatHandDm(action.playerJid, next),
      ];
      let effectNote = '';
      let stepAdvance = 1;

      if (chosenCard.value === 'reverse') {
        if (next.players.length === 2) {
          // Official 2-player Uno rule: Reverse acts like Skip
          stepAdvance = 2;
          effectNote = '🔄 *REVERSE (2 Pemain = Skip)!* Giliran kembali ke kamu!';
        } else {
          next.direction = (next.direction === 1 ? -1 : 1) as 1 | -1;
          stepAdvance = 1;
          effectNote = `🔄 *REVERSE!* Arah putaran berbalik menjadi ${next.direction === 1 ? 'Searah Jarum Jam' : 'Berlawanan Jarum Jam'}!`;
        }
      } else if (chosenCard.value === 'skip') {
        const skippedIdx = this.stepIndex(next, next.currentTurnIndex, 1);
        const skippedPlayer = next.players[skippedIdx];
        stepAdvance = 2;
        effectNote = `🚫 *SKIP!* Giliran ${formatPlayerTag(skippedPlayer.jid)} dilewati!`;
      } else if (chosenCard.value === 'draw2') {
        const victimIdx = this.stepIndex(next, next.currentTurnIndex, 1);
        const victim = next.players[victimIdx];
        const penalty = this.drawFromPile(next, 2);
        next.hands[victim.jid].push(...penalty);
        dms.push(this.formatHandDm(victim.jid, next));
        stepAdvance = 2;
        effectNote = `💥 *DRAW +2!* ${formatPlayerTag(victim.jid)} mengambil 2 kartu dan kehilangan giliran!`;
      } else if (chosenCard.value === 'wild_draw4') {
        const victimIdx = this.stepIndex(next, next.currentTurnIndex, 1);
        const victim = next.players[victimIdx];
        const penalty = this.drawFromPile(next, 4);
        next.hands[victim.jid].push(...penalty);
        dms.push(this.formatHandDm(victim.jid, next));
        stepAdvance = 2;
        effectNote = `🔥 *WILD DRAW +4!* Warna berubah ke *${UNO_COLOR_NAMES_ID[next.activeColor]}*, dan ${formatPlayerTag(victim.jid)} mengambil 4 kartu!`;
      } else if (chosenCard.value === 'wild') {
        effectNote = `🌈 *WILD!* Warna aktif diubah menjadi *${UNO_COLOR_NAMES_ID[next.activeColor]}*!`;
      }

      next.currentTurnIndex = this.stepIndex(next, next.currentTurnIndex, stepAdvance);
      const nextPlayer = next.players[next.currentTurnIndex];

      return {
        success: true,
        state: next,
        isGameOver: false,
        mentions: [action.playerJid, nextPlayer.jid],
        directMessages: dms,
        broadcastMessage: [
          `🎴 ${formatPlayerTag(action.playerJid)} memainkan *[${chosenCard.label}]* (Sisa: ${playerHand.length} kartu)${playerHand.length === 1 ? ' — *UNO!*' : ''}`,
          effectNote,
          `Warna Aktif: *${UNO_COLOR_NAMES_ID[next.activeColor]}* • Giliran Selanjutnya: ${formatPlayerTag(nextPlayer.jid)}`,
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }

    return {
      success: false,
      error: `Aksi Uno tidak dikenal: ${String(action.type)}`,
      state: next,
    };
  }

  handleTurnTimeout(state: UnoState): GameActionResult<UnoState> {
    const next = cloneState(state);
    if (next.status !== 'playing') {
      return { success: false, error: 'Tidak ada permainan Uno yang sedang aktif.', state: next };
    }
    const timedOutPlayer = next.players[next.currentTurnIndex];
    if (!next.hasDrawnThisTurn) {
      const drawn = this.drawFromPile(next, 1);
      next.hands[timedOutPlayer.jid].push(...drawn);
    }
    next.currentTurnIndex = this.stepIndex(next, next.currentTurnIndex, 1);
    next.hasDrawnThisTurn = false;
    const nextPlayer = next.players[next.currentTurnIndex];

    return {
      success: true,
      state: next,
      mentions: [timedOutPlayer.jid, nextPlayer.jid],
      directMessages: [this.formatHandDm(timedOutPlayer.jid, next)],
      broadcastMessage: `⏰ Waktu habis! ${formatPlayerTag(timedOutPlayer.jid)} otomatis mengambil 1 kartu. Giliran berpindah ke ${formatPlayerTag(nextPlayer.jid)}!`,
    };
  }
}
