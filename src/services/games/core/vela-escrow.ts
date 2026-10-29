/**
 * @file vela-escrow.ts
 * @description Atomic Vela Currency Escrow for Allybot Minigames.
 * Locks bets at lobby join, transfers pot to winner(s) on completion,
 * and refunds 100% of wagers on crash, timeout, or cancellation.
 */

import crypto from 'node:crypto';
import type { EscrowHold } from '../types.js';

export interface VelaEconomyPort {
  getBalance(groupJid: string, userJid: string): Promise<number>;
  deductBalance(groupJid: string, userJid: string, amount: number, reason: string): Promise<boolean>;
  creditBalance(groupJid: string, userJid: string, amount: number, reason: string): Promise<boolean>;
}

export class VelaEscrowManager {
  private readonly holds = new Map<string, EscrowHold>(); // holdId -> EscrowHold
  private readonly gameHoldsIndex = new Map<string, string[]>(); // gameId -> holdId[]

  constructor(private readonly economyPort?: VelaEconomyPort) {}

  public async holdWager(options: {
    gameId: string;
    groupJid: string;
    playerJid: string;
    amount: number;
    gameLabel: string;
  }): Promise<EscrowHold> {
    const { gameId, groupJid, playerJid, amount, gameLabel } = options;

    if (amount <= 0) {
      const hold: EscrowHold = {
        holdId: `free_${crypto.randomUUID().slice(0, 8)}`,
        gameId,
        groupJid,
        playerJid,
        amount: 0,
        createdAt: Date.now(),
        isSettled: false,
      };
      return hold;
    }

    if (this.economyPort) {
      const balance = await this.economyPort.getBalance(groupJid, playerJid);
      if (balance < amount) {
        throw new Error(`Saldo Vela tidak mencukupi untuk taruhan ${amount.toLocaleString('id-ID')} Vela.`);
      }

      const deducted = await this.economyPort.deductBalance(
        groupJid,
        playerJid,
        amount,
        `Taruhan ${gameLabel} [${gameId}]`
      );
      if (!deducted) {
        throw new Error(`Gagal memotong taruhan Vela dari dompet.`);
      }
    }

    const holdId = crypto.randomUUID();
    const hold: EscrowHold = {
      holdId,
      gameId,
      groupJid,
      playerJid,
      amount,
      createdAt: Date.now(),
      isSettled: false,
    };

    this.holds.set(holdId, hold);
    const existing = this.gameHoldsIndex.get(gameId) ?? [];
    existing.push(holdId);
    this.gameHoldsIndex.set(gameId, existing);

    return hold;
  }

  public async settlePayout(options: {
    gameId: string;
    winnerJids: string[];
    gameLabel: string;
  }): Promise<{ totalPot: number; perWinnerPayout: number }> {
    const { gameId, winnerJids, gameLabel } = options;
    const holdIds = this.gameHoldsIndex.get(gameId) ?? [];

    let totalPot = 0;
    for (const hId of holdIds) {
      const hold = this.holds.get(hId);
      if (hold && !hold.isSettled) {
        totalPot += hold.amount;
        hold.isSettled = true;
      }
    }

    if (totalPot > 0 && winnerJids.length > 0 && this.economyPort) {
      const share = Math.floor(totalPot / winnerJids.length);
      for (const wJid of winnerJids) {
        const hold = holdIds.map((id) => this.holds.get(id)).find((h) => h?.playerJid === wJid);
        const groupJid = hold?.groupJid || '';
        if (groupJid) {
          await this.economyPort.creditBalance(
            groupJid,
            wJid,
            share,
            `Kemenangan ${gameLabel} [${gameId}]`
          );
        }
      }
      return { totalPot, perWinnerPayout: share };
    }

    return { totalPot, perWinnerPayout: winnerJids.length > 0 ? Math.floor(totalPot / winnerJids.length) : 0 };
  }

  public async refundAll(gameId: string, reason: string): Promise<number> {
    const holdIds = this.gameHoldsIndex.get(gameId) ?? [];
    let refundedCount = 0;

    for (const hId of holdIds) {
      const hold = this.holds.get(hId);
      if (hold && !hold.isSettled && hold.amount > 0) {
        if (this.economyPort) {
          await this.economyPort.creditBalance(
            hold.groupJid,
            hold.playerJid,
            hold.amount,
            `Pengembalian Taruhan: ${reason}`
          );
        }
        hold.isSettled = true;
        refundedCount++;
      }
    }

    return refundedCount;
  }
}
