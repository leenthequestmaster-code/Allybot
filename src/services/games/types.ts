/**
 * @file types.ts
 * @description Core types and interface contracts for the Allybot PlayMatrix Game Platform.
 * All minigames (Wordle, Tarot, LMS, Blackjack, Uno, Ular Tangga, etc.) adhere to these contracts.
 */

export type GameCategory = 'instant' | 'grid' | 'party' | 'board' | 'card';

export type GameStatus = 'lobby' | 'active' | 'finished' | 'aborted';

export interface GamePlayer {
  readonly jid: string;
  readonly name: string;
  readonly avatarUrl?: string | null;
  score?: number;
  wounds?: number;
  isEliminated?: boolean;
  isAfk?: boolean;
  joinedAt: number;
  meta?: Record<string, unknown>;
}

export interface BaseGameAction {
  readonly type: string;
  readonly playerJid: string;
  readonly payload?: unknown;
  readonly isDirectMessage?: boolean;
}

export interface GameActionResult<TState = unknown> {
  readonly success: boolean;
  readonly error?: string;
  readonly state: TState;
  readonly broadcastMessage?: string;
  readonly directMessages?: Array<{
    readonly recipientJid: string;
    readonly text: string;
  }>;
  readonly boardPng?: Buffer;
  readonly isGameOver?: boolean;
  readonly winnerJids?: string[];
  readonly mentions?: string[];
}

export interface GameEngine<TState = unknown, TAction extends BaseGameAction = BaseGameAction> {
  readonly gameType: string;
  readonly displayName: string;
  readonly category: GameCategory;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  readonly defaultTurnTimeoutMs: number;

  createInitialState(options: {
    gameId: string;
    groupJid: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): TState;

  processAction(state: TState, action: TAction): Promise<GameActionResult<TState>> | GameActionResult<TState>;

  handleTurnTimeout(state: TState): Promise<GameActionResult<TState>> | GameActionResult<TState>;

  renderVisualState?(state: TState): Promise<Buffer | null> | Buffer | null;
}

export interface ActiveGameRoom<TState = unknown> {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: string;
  readonly hostJid: string;
  status: GameStatus;
  readonly players: Map<string, GamePlayer>;
  wagerAmount: number;
  readonly createdAt: number;
  lastActivityAt: number;
  turnExpiresAt?: number;
  activePlayerJid?: string;
  state: TState;
}

export interface EscrowHold {
  readonly holdId: string;
  readonly gameId: string;
  readonly groupJid: string;
  readonly playerJid: string;
  readonly amount: number;
  readonly createdAt: number;
  isSettled: boolean;
}
