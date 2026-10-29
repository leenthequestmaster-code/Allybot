// ============================================================================
// ALLYBOT ARCADE ENGINE SUITE — CORE TYPES & DETERMINISTIC PRNG HELPERS
// Runtime: Node.js 22 LTS (Pure TypeScript ESM, Zero External Dependencies)
// ============================================================================

export type GameCategory = 'instant' | 'grid' | 'party' | 'board' | 'card';

export interface GamePlayer {
  readonly jid: string;
  readonly name: string;
  score?: number;
  wounds?: number;
  isEliminated?: boolean;
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

  processAction(state: TState, action: TAction): GameActionResult<TState>;

  handleTurnTimeout(state: TState): GameActionResult<TState>;
}

// ============================================================================
// PURE DETERMINISTIC / SEEDABLE PRNG (MULBERRY32) FOR ZERO-FLAKINESS ENGINE LOGIC
// ============================================================================

export interface RngStep {
  readonly value: number; // Float in [0, 1)
  readonly nextSeed: number;
}

/**
 * Generates an initial 32-bit seed from an optional number/string seed or current time.
 */
export function resolveInitialSeed(customConfig?: Record<string, unknown>, fallbackEntropy = ''): number {
  const rawSeed = customConfig?.seed;
  if (typeof rawSeed === 'number' && Number.isFinite(rawSeed)) {
    return (Math.floor(rawSeed) >>> 0) || 0x6d2b79f5;
  }
  if (typeof rawSeed === 'string' && rawSeed.trim().length > 0) {
    return hashStringToSeed(rawSeed.trim());
  }
  const mixed = `${Date.now()}:${Math.random()}:${fallbackEntropy}`;
  return hashStringToSeed(mixed);
}

export function hashStringToSeed(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h || 0x12345678;
}

/**
 * Pure Mulberry32 PRNG step: takes a 32-bit state seed and returns { value, nextSeed }.
 */
export function nextRandom(seed: number): RngStep {
  const nextSeed = (seed + 0x6d2b79f5) >>> 0;
  let t = nextSeed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, nextSeed };
}

/**
 * Generates an integer in [minInclusive, maxInclusive] using the pure PRNG.
 */
export function nextInt(seed: number, minInclusive: number, maxInclusive: number): { value: number; nextSeed: number } {
  const step = nextRandom(seed);
  const span = Math.max(1, maxInclusive - minInclusive + 1);
  const intVal = minInclusive + Math.floor(step.value * span);
  return { value: Math.min(maxInclusive, intVal), nextSeed: step.nextSeed };
}

/**
 * Pure Fisher-Yates shuffle returning a new array and the updated PRNG seed.
 */
export function shuffleWithSeed<T>(items: readonly T[], seed: number): { items: T[]; nextSeed: number } {
  const copy = [...items];
  let curSeed = seed >>> 0;
  for (let i = copy.length - 1; i > 0; i--) {
    const step = nextInt(curSeed, 0, i);
    curSeed = step.nextSeed;
    const j = step.value;
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return { items: copy, nextSeed: curSeed };
}

/**
 * Formats a WhatsApp JID into a short @mention tag (e.g. "628123@s.whatsapp.net" -> "@628123").
 */
export function formatPlayerTag(jid: string): string {
  const base = jid.split('@')[0]?.split(':')[0] ?? jid;
  return `@${base}`;
}

/**
 * Helper to deep-clone plain state objects safely without mutating the input state.
 */
export function cloneState<T>(state: T): T {
  return structuredClone(state);
}
