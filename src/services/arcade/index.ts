// ============================================================================
// ALLYBOT 10-MINIGAME PURE ENGINE SUITE — UNIFIED REGISTRY & BARREL EXPORTS
// Pure TypeScript ESM — Zero External Dependencies
// ============================================================================

export * from './types.js';
export * from './wordle.js';
export * from './tarot.js';
export * from './hot-potato.js';
export * from './lms-quiz.js';
export * from './blackjack.js';
export * from './uno.js';
export * from './cash-and-guns.js';
export * from './ular-tangga.js';
export * from './ludo.js';
export * from './speed-monopoly.js';

import type { BaseGameAction, GameEngine } from './types.js';
import { WordleEngine } from './wordle.js';
import { TarotEngine } from './tarot.js';
import { HotPotatoEngine } from './hot-potato.js';
import { LmsQuizEngine } from './lms-quiz.js';
import { BlackjackEngine } from './blackjack.js';
import { UnoEngine } from './uno.js';
import { CashAndGunsEngine } from './cash-and-guns.js';
import { SnakesAndLaddersEngine } from './ular-tangga.js';
import { LudoEngine } from './ludo.js';
import { SpeedMonopolyEngine } from './speed-monopoly.js';

export type ArcadeGameType =
  | 'wordle'
  | 'tarot'
  | 'hot_potato'
  | 'lms_quiz'
  | 'blackjack'
  | 'uno'
  | 'cash_and_guns'
  | 'ular_tangga'
  | 'ludo'
  | 'speed_monopoly';

export interface ArcadeEngineMap {
  readonly wordle: WordleEngine;
  readonly tarot: TarotEngine;
  readonly hot_potato: HotPotatoEngine;
  readonly lms_quiz: LmsQuizEngine;
  readonly blackjack: BlackjackEngine;
  readonly uno: UnoEngine;
  readonly cash_and_guns: CashAndGunsEngine;
  readonly ular_tangga: SnakesAndLaddersEngine;
  readonly ludo: LudoEngine;
  readonly speed_monopoly: SpeedMonopolyEngine;
}

export function createArcadeEngineRegistry(): ArcadeEngineMap {
  return {
    wordle: new WordleEngine(),
    tarot: new TarotEngine(),
    hot_potato: new HotPotatoEngine(),
    lms_quiz: new LmsQuizEngine(),
    blackjack: new BlackjackEngine(),
    uno: new UnoEngine(),
    cash_and_guns: new CashAndGunsEngine(),
    ular_tangga: new SnakesAndLaddersEngine(),
    ludo: new LudoEngine(),
    speed_monopoly: new SpeedMonopolyEngine(),
  };
}

export function createAllArcadeEngines(): GameEngine<any, BaseGameAction>[] {
  const reg = createArcadeEngineRegistry();
  return [
    reg.wordle,
    reg.tarot,
    reg.hot_potato,
    reg.lms_quiz,
    reg.blackjack,
    reg.uno,
    reg.cash_and_guns,
    reg.ular_tangga,
    reg.ludo,
    reg.speed_monopoly,
  ];
}
