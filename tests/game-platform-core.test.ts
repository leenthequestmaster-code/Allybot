import { describe, it, expect } from 'vitest';
import {
  GameSessionManager,
  DualChannelBridge,
  VelaEscrowManager,
  type GameEngine,
  type GamePlayer,
  type BaseGameAction,
  type GameActionResult,
} from '../src/services/games/index.js';

// Dummy Quiz Game Engine for testing Core Architecture
interface QuizState {
  gameId: string;
  round: number;
  question: string;
  answers: Map<string, string>;
  eliminated: Set<string>;
}

const mockQuizEngine: GameEngine<QuizState> = {
  gameType: 'lms_quiz',
  displayName: 'Last Man Standing',
  category: 'party',
  minPlayers: 2,
  maxPlayers: 10,
  defaultTurnTimeoutMs: 20000,

  createInitialState(opts) {
    return {
      gameId: opts.gameId,
      round: 1,
      question: 'Ibukota Indonesia adalah?',
      answers: new Map(),
      eliminated: new Set(),
    };
  },

  processAction(state, action) {
    if (action.type === 'answer') {
      const choice = String(action.payload);
      state.answers.set(action.playerJid, choice);
      return {
        success: true,
        state,
        broadcastMessage: `Player menjawab di DM.`,
      };
    }
    return { success: false, state, error: 'Aksi tidak dikenal' };
  },

  handleTurnTimeout(state) {
    return {
      success: true,
      state,
      broadcastMessage: `Waktu ronde habis!`,
      isGameOver: true,
    };
  },
};

describe('PlayMatrix Game Platform - Core Architecture', () => {
  const host: GamePlayer = {
    jid: '6281111111111@s.whatsapp.net',
    name: 'Cyrus',
    joinedAt: Date.now(),
  };

  const p2: GamePlayer = {
    jid: '6282222222222@s.whatsapp.net',
    name: 'Budi',
    joinedAt: Date.now(),
  };

  const groupJid = '120363999999999999@g.us';

  it('GameSessionManager: creates room, locks, registers players, and manages lifecycle', async () => {
    const manager = new GameSessionManager();
    manager.registerEngine(mockQuizEngine);

    const room = manager.createRoom<QuizState>({
      groupJid,
      gameType: 'lms_quiz',
      host,
      wagerAmount: 500,
    });

    expect(room.gameId).toBeDefined();
    expect(room.status).toBe('lobby');
    expect(room.players.size).toBe(1);

    // Join player 2
    const joined = manager.addPlayer(groupJid, p2);
    expect(joined).toBe(true);
    expect(room.players.size).toBe(2);

    // Concurrency Lock
    const token = await manager.acquireLock(groupJid);
    expect(token).toBeTypeOf('string');
    // Concurrent acquire should fail
    const token2 = await manager.acquireLock(groupJid);
    expect(token2).toBeNull();

    await manager.releaseLock(groupJid, token!);
    // Next acquire should succeed
    const token3 = await manager.acquireLock(groupJid);
    expect(token3).toBeTypeOf('string');
    await manager.releaseLock(groupJid, token3!);

    // Close room cleans index
    manager.closeRoom(groupJid);
    expect(manager.getRoom(groupJid)).toBeUndefined();
    expect(manager.getRoomByPlayerJid(host.jid)).toBeUndefined();
  });

  it('DualChannelBridge: routes secret DM actions to active group room', async () => {
    const manager = new GameSessionManager();
    manager.registerEngine(mockQuizEngine);
    manager.createRoom<QuizState>({ groupJid, gameType: 'lms_quiz', host });
    manager.addPlayer(groupJid, p2);
    manager.setStatus(groupJid, 'active');

    const bridge = new DualChannelBridge(manager);

    expect(bridge.isSecretGameAction('.jawab B')).toBe(true);
    expect(bridge.isSecretGameAction('.bidik @someone')).toBe(true);
    expect(bridge.isSecretGameAction('halo apa kabar')).toBe(false);

    // Process player answer in DM
    const parser = (text: string, sender: string): BaseGameAction | null => {
      if (text.startsWith('.jawab ')) {
        return {
          type: 'answer',
          playerJid: sender,
          payload: text.slice(7).trim(),
          isDirectMessage: true,
        };
      }
      return null;
    };

    const dispatch = await bridge.handleInboundMessage(
      { senderJid: p2.jid, text: '.jawab B', isDirectMessage: true },
      parser
    );

    expect(dispatch.handled).toBe(true);
    expect(dispatch.groupJid).toBe(groupJid);
    expect(dispatch.result?.success).toBe(true);

    const room = manager.getRoom<QuizState>(groupJid);
    expect(room?.state.answers.get(p2.jid)).toBe('B');
  });

  it('VelaEscrowManager: holds wagers, calculates pot, and handles payouts & refunds', async () => {
    const balances = new Map<string, number>([
      [host.jid, 2000],
      [p2.jid, 1500],
    ]);

    const fakeEconomyPort = {
      async getBalance(_g: string, u: string) {
        return balances.get(u) ?? 0;
      },
      async deductBalance(_g: string, u: string, amount: number) {
        const cur = balances.get(u) ?? 0;
        if (cur < amount) return false;
        balances.set(u, cur - amount);
        return true;
      },
      async creditBalance(_g: string, u: string, amount: number) {
        const cur = balances.get(u) ?? 0;
        balances.set(u, cur + amount);
        return true;
      },
    };

    const escrow = new VelaEscrowManager(fakeEconomyPort);
    const gameId = 'game_abc123';

    // Hold wagers
    await escrow.holdWager({
      gameId,
      groupJid,
      playerJid: host.jid,
      amount: 500,
      gameLabel: 'LMS Quiz',
    });
    await escrow.holdWager({
      gameId,
      groupJid,
      playerJid: p2.jid,
      amount: 500,
      gameLabel: 'LMS Quiz',
    });

    expect(balances.get(host.jid)).toBe(1500);
    expect(balances.get(p2.jid)).toBe(1000);

    // Settle payout: Host wins full pot
    const payout = await escrow.settlePayout({
      gameId,
      winnerJids: [host.jid],
      gameLabel: 'LMS Quiz',
    });

    expect(payout.totalPot).toBe(1000);
    expect(payout.perWinnerPayout).toBe(1000);
    expect(balances.get(host.jid)).toBe(2500); // 1500 + 1000 pot
  });

  it('VelaEscrowManager: refunds wagers on aborted match', async () => {
    const balances = new Map<string, number>([[host.jid, 1000]]);
    const fakeEconomy = {
      async getBalance(_g: string, u: string) {
        return balances.get(u) ?? 0;
      },
      async deductBalance(_g: string, u: string, amount: number) {
        balances.set(u, (balances.get(u) ?? 0) - amount);
        return true;
      },
      async creditBalance(_g: string, u: string, amount: number) {
        balances.set(u, (balances.get(u) ?? 0) + amount);
        return true;
      },
    };

    const escrow = new VelaEscrowManager(fakeEconomy);
    const gameId = 'game_abort_test';

    await escrow.holdWager({
      gameId,
      groupJid,
      playerJid: host.jid,
      amount: 300,
      gameLabel: 'Test',
    });
    expect(balances.get(host.jid)).toBe(700);

    const refunded = await escrow.refundAll(gameId, 'Pemain keluar/batal');
    expect(refunded).toBe(1);
    expect(balances.get(host.jid)).toBe(1000);
  });
});
