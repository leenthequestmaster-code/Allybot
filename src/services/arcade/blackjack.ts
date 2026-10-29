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
// 5. BLACKJACK ENGINE (52 KARTU STANDAR, DEALER HIT S/D 17, PAYOUT 3:2)
// ============================================================================

export type StandardSuit = '♠' | '♥' | '♦' | '♣';
export type StandardRank = 'A' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'J' | 'Q' | 'K';

export interface PlayingCard {
  readonly rank: StandardRank;
  readonly suit: StandardSuit;
  readonly code: string;
}

export type BlackjackHandOutcome = 'pending' | 'blackjack_3_2' | 'win' | 'push' | 'lose' | 'bust';

export interface BlackjackPlayerSlot {
  readonly player: GamePlayer;
  bet: number;
  cards: PlayingCard[];
  status: 'playing' | 'stood' | 'doubled' | 'blackjack' | 'bust';
  outcome: BlackjackHandOutcome;
  netDelta: number; // +1.5x bet on natural blackjack, +1x on win, 0 on push, -1x on lose/bust
  totalPayout: number;
}

export interface BlackjackState {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: 'blackjack';
  status: 'lobby' | 'player_turns' | 'finished';
  seed: number;
  hostJid: string;
  baseWager: number;
  shoe: PlayingCard[];
  dealerCards: PlayingCard[];
  dealerHoleRevealed: boolean;
  seats: BlackjackPlayerSlot[];
  activeSeatIndex: number;
  winnerJids: string[];
}

export interface BlackjackAction extends BaseGameAction {
  readonly type: 'JOIN' | 'START' | 'HIT' | 'STAND' | 'DOUBLE';
  readonly payload?: {
    readonly playerName?: string;
    readonly bet?: number;
  };
}

const STANDARD_SUITS: readonly StandardSuit[] = ['♠', '♥', '♦', '♣'];
const STANDARD_RANKS: readonly StandardRank[] = [
  'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K',
];

export function buildStandardDeck52(): PlayingCard[] {
  const deck: PlayingCard[] = [];
  for (const suit of STANDARD_SUITS) {
    for (const rank of STANDARD_RANKS) {
      deck.push({ rank, suit, code: `${rank}${suit}` });
    }
  }
  return deck;
}

export function evaluateBlackjackHand(cards: readonly PlayingCard[]): {
  total: number;
  isSoft: boolean;
  isBlackjack: boolean;
  isBust: boolean;
} {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') {
      total += 11;
      aces += 1;
    } else if (['10', 'J', 'Q', 'K'].includes(c.rank)) {
      total += 10;
    } else {
      total += Number(c.rank);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return {
    total,
    isSoft: aces > 0,
    isBlackjack: cards.length === 2 && total === 21,
    isBust: total > 21,
  };
}

export class BlackjackEngine implements GameEngine<BlackjackState, BlackjackAction> {
  readonly gameType = 'blackjack';
  readonly displayName = 'Blackjack 21 (Dealer AI 17 & Payout 3:2)';
  readonly category = 'card' as const;
  readonly minPlayers = 1;
  readonly maxPlayers = 7;
  readonly defaultTurnTimeoutMs = 45_000;

  createInitialState(options: {
    gameId: string;
    groupJid: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): BlackjackState {
    const initialSeed = resolveInitialSeed(options.customConfig, options.gameId);
    const baseWager = Math.max(10, Math.floor(options.wagerAmount ?? 100));
    const customShoe = Array.isArray(options.customConfig?.shoe)
      ? [...(options.customConfig?.shoe as PlayingCard[])]
      : undefined;

    let shoe: PlayingCard[];
    let nextSeed = initialSeed;
    if (customShoe && customShoe.length >= 10) {
      shoe = customShoe;
    } else {
      const shuffled = shuffleWithSeed(buildStandardDeck52(), initialSeed);
      shoe = shuffled.items;
      nextSeed = shuffled.nextSeed;
    }

    const hostSeat: BlackjackPlayerSlot = {
      player: { ...options.host, score: options.host.score ?? 0 },
      bet: baseWager,
      cards: [],
      status: 'playing',
      outcome: 'pending',
      netDelta: 0,
      totalPayout: 0,
    };

    const state: BlackjackState = {
      gameId: options.gameId,
      groupJid: options.groupJid,
      gameType: 'blackjack',
      status: 'lobby',
      seed: nextSeed,
      hostJid: options.host.jid,
      baseWager,
      shoe,
      dealerCards: [],
      dealerHoleRevealed: false,
      seats: [hostSeat],
      activeSeatIndex: 0,
      winnerJids: [],
    };

    if (options.customConfig?.autoStart !== false) {
      this.dealOpeningHands(state);
    }

    return state;
  }

  private drawCard(state: BlackjackState): PlayingCard {
    if (state.shoe.length === 0) {
      const reshuffled = shuffleWithSeed(buildStandardDeck52(), state.seed);
      state.shoe = reshuffled.items;
      state.seed = reshuffled.nextSeed;
    }
    return state.shoe.shift()!;
  }

  private dealOpeningHands(state: BlackjackState): void {
    state.status = 'player_turns';
    state.dealerCards = [];
    state.dealerHoleRevealed = false;

    for (const seat of state.seats) {
      seat.cards = [this.drawCard(state)];
    }
    state.dealerCards.push(this.drawCard(state));

    for (const seat of state.seats) {
      seat.cards.push(this.drawCard(state));
      const evalHand = evaluateBlackjackHand(seat.cards);
      if (evalHand.isBlackjack) {
        seat.status = 'blackjack';
      } else {
        seat.status = 'playing';
      }
    }
    state.dealerCards.push(this.drawCard(state));

    // Find first seat that still needs to act
    const firstPlaying = state.seats.findIndex((s) => s.status === 'playing');
    if (firstPlaying === -1) {
      this.resolveDealerAndSettle(state);
    } else {
      state.activeSeatIndex = firstPlaying;
    }
  }

  private resolveDealerAndSettle(state: BlackjackState): void {
    state.dealerHoleRevealed = true;
    const anyLiveContender = state.seats.some(
      (s) => s.status === 'stood' || s.status === 'doubled' || s.status === 'blackjack',
    );

    // Dealer AI hits until total >= 17 if at least one non-bust contender exists
    if (anyLiveContender) {
      while (evaluateBlackjackHand(state.dealerCards).total < 17) {
        state.dealerCards.push(this.drawCard(state));
      }
    }

    const dealerEval = evaluateBlackjackHand(state.dealerCards);
    const winners: string[] = [];

    for (const seat of state.seats) {
      const pEval = evaluateBlackjackHand(seat.cards);
      if (pEval.isBust) {
        seat.outcome = 'bust';
        seat.netDelta = -seat.bet;
        seat.totalPayout = 0;
      } else if (pEval.isBlackjack) {
        if (dealerEval.isBlackjack) {
          seat.outcome = 'push';
          seat.netDelta = 0;
          seat.totalPayout = seat.bet;
        } else {
          // Authentic 3:2 Blackjack payout
          seat.outcome = 'blackjack_3_2';
          seat.netDelta = Math.floor(seat.bet * 1.5);
          seat.totalPayout = seat.bet + seat.netDelta;
          winners.push(seat.player.jid);
        }
      } else if (dealerEval.isBlackjack) {
        seat.outcome = 'lose';
        seat.netDelta = -seat.bet;
        seat.totalPayout = 0;
      } else if (dealerEval.isBust || pEval.total > dealerEval.total) {
        seat.outcome = 'win';
        seat.netDelta = seat.bet;
        seat.totalPayout = seat.bet * 2;
        winners.push(seat.player.jid);
      } else if (pEval.total === dealerEval.total) {
        seat.outcome = 'push';
        seat.netDelta = 0;
        seat.totalPayout = seat.bet;
      } else {
        seat.outcome = 'lose';
        seat.netDelta = -seat.bet;
        seat.totalPayout = 0;
      }

      seat.player.score = (seat.player.score ?? 0) + seat.netDelta;
    }

    state.status = 'finished';
    state.winnerJids = winners;
  }

  private advanceTurnOrResolve(state: BlackjackState): void {
    const nextIdx = state.seats.findIndex(
      (s, idx) => idx > state.activeSeatIndex && s.status === 'playing',
    );
    if (nextIdx !== -1) {
      state.activeSeatIndex = nextIdx;
    } else {
      this.resolveDealerAndSettle(state);
    }
  }

  private formatTableSummary(state: BlackjackState): string {
    const dealerVisible = state.dealerHoleRevealed
      ? `${state.dealerCards.map((c) => c.code).join(' ')} (${evaluateBlackjackHand(state.dealerCards).total})`
      : `${state.dealerCards[0]?.code ?? '??'} [🂠]`;

    const lines: string[] = [
      `🃏 *MEJA BLACKJACK 21*`,
      `Bandar (Dealer): *${dealerVisible}*`,
      '',
    ];

    for (let i = 0; i < state.seats.length; i++) {
      const s = state.seats[i];
      const h = evaluateBlackjackHand(s.cards);
      const turnArrow = state.status === 'player_turns' && i === state.activeSeatIndex ? '👉 ' : '';
      const outcomeBadge =
        state.status === 'finished'
          ? ` — *${s.outcome.toUpperCase()}* (${s.netDelta >= 0 ? '+' : ''}${s.netDelta})`
          : '';
      lines.push(
        `${turnArrow}${formatPlayerTag(s.player.jid)}: ${s.cards.map((c) => c.code).join(' ')} = *${h.total}* [Poin: ${s.bet}]${outcomeBadge}`,
      );
    }

    if (state.status === 'player_turns') {
      const current = state.seats[state.activeSeatIndex];
      if (current) {
        lines.push(
          '',
          `Giliran ${formatPlayerTag(current.player.jid)}: Ketik *hit*, *stand*, atau *double*!`,
        );
      }
    }

    return lines.join('\n');
  }

  processAction(state: BlackjackState, action: BlackjackAction): GameActionResult<BlackjackState> {
    const next = cloneState(state);

    if (action.type === 'JOIN') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Meja Blackjack sudah membagikan kartu.', state: next };
      }
      if (next.seats.some((s) => s.player.jid === action.playerJid)) {
        return { success: false, error: 'Kamu sudah duduk di meja Blackjack ini.', state: next };
      }
      if (next.seats.length >= this.maxPlayers) {
        return { success: false, error: 'Meja Blackjack sudah penuh (maks 7 kursi).', state: next };
      }
      const bet = Math.max(10, Math.floor(action.payload?.bet ?? next.baseWager));
      next.seats.push({
        player: {
          jid: action.playerJid,
          name: action.payload?.playerName ?? formatPlayerTag(action.playerJid),
          score: 0,
          joinedAt: Date.now(),
        },
        bet,
        cards: [],
        status: 'playing',
        outcome: 'pending',
        netDelta: 0,
        totalPayout: 0,
      });
      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        broadcastMessage: `🃏 ${formatPlayerTag(action.playerJid)} duduk di meja Blackjack (Taruhan: ${bet}).`,
      };
    }

    if (action.type === 'START') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Blackjack sudah dimulai.', state: next };
      }
      this.dealOpeningHands(next);
      const isOver = (next.status as string) === 'finished';
      return {
        success: true,
        state: next,
        isGameOver: isOver,
        winnerJids: next.winnerJids,
        mentions: next.seats.map((s) => s.player.jid),
        broadcastMessage: this.formatTableSummary(next),
      };
    }

    if (next.status !== 'player_turns') {
      return {
        success: false,
        error: 'Permainan Blackjack sudah selesai atau belum dimulai.',
        state: next,
        isGameOver: next.status === 'finished',
        winnerJids: next.winnerJids,
      };
    }

    const activeSeat = next.seats[next.activeSeatIndex];
    if (!activeSeat || activeSeat.player.jid !== action.playerJid) {
      return {
        success: false,
        error: `Sekarang adalah giliran ${activeSeat ? formatPlayerTag(activeSeat.player.jid) : 'pemain lain'}!`,
        state: next,
      };
    }

    if (action.type === 'HIT') {
      activeSeat.cards.push(this.drawCard(next));
      const evalHand = evaluateBlackjackHand(activeSeat.cards);
      if (evalHand.isBust) {
        activeSeat.status = 'bust';
        this.advanceTurnOrResolve(next);
      } else if (evalHand.total === 21) {
        activeSeat.status = 'stood';
        this.advanceTurnOrResolve(next);
      }
      return {
        success: true,
        state: next,
        isGameOver: (next.status as string) === 'finished',
        winnerJids: next.winnerJids,
        mentions: next.seats.map((s) => s.player.jid),
        broadcastMessage: this.formatTableSummary(next),
      };
    }

    if (action.type === 'STAND') {
      activeSeat.status = 'stood';
      this.advanceTurnOrResolve(next);
      return {
        success: true,
        state: next,
        isGameOver: (next.status as string) === 'finished',
        winnerJids: next.winnerJids,
        mentions: next.seats.map((s) => s.player.jid),
        broadcastMessage: this.formatTableSummary(next),
      };
    }

    if (action.type === 'DOUBLE') {
      if (activeSeat.cards.length !== 2) {
        return {
          success: false,
          error: 'Double Down hanya bisa dilakukan pada 2 kartu pertama!',
          state: next,
        };
      }
      activeSeat.bet *= 2;
      activeSeat.cards.push(this.drawCard(next));
      const evalHand = evaluateBlackjackHand(activeSeat.cards);
      activeSeat.status = evalHand.isBust ? 'bust' : 'doubled';
      this.advanceTurnOrResolve(next);
      return {
        success: true,
        state: next,
        isGameOver: (next.status as string) === 'finished',
        winnerJids: next.winnerJids,
        mentions: next.seats.map((s) => s.player.jid),
        broadcastMessage: this.formatTableSummary(next),
      };
    }

    return {
      success: false,
      error: `Aksi Blackjack tidak dikenal: ${String(action.type)}`,
      state: next,
    };
  }

  handleTurnTimeout(state: BlackjackState): GameActionResult<BlackjackState> {
    const next = cloneState(state);
    if (next.status !== 'player_turns') {
      return {
        success: false,
        error: 'Tidak ada giliran aktif di meja Blackjack.',
        state: next,
      };
    }
    const activeSeat = next.seats[next.activeSeatIndex];
    if (activeSeat && activeSeat.status === 'playing') {
      activeSeat.status = 'stood';
    }
    this.advanceTurnOrResolve(next);
    return {
      success: true,
      state: next,
      isGameOver: (next.status as string) === 'finished',
      winnerJids: next.winnerJids,
      mentions: next.seats.map((s) => s.player.jid),
      broadcastMessage: `⏰ Waktu giliran habis (Auto-Stand)!\n\n${this.formatTableSummary(next)}`,
    };
  }
}
