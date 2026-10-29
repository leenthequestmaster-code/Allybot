/**
 * @file dual-channel-bridge.ts
 * @description Dual-Channel Router for WhatsApp.
 * Enables private/secret actions via DM (e.g. `.jawab <opsi>`, `.bidik @user`, `.hit`, `.stand`)
 * while synchronizing state and outcomes to the public group game room.
 */

import type { GameSessionManager } from './session-manager.js';
import type { BaseGameAction, GameActionResult } from '../types.js';

export interface DualChannelInbound {
  readonly senderJid: string;
  readonly text: string;
  readonly isDirectMessage: boolean;
}

export class DualChannelBridge {
  constructor(private readonly sessionManager: GameSessionManager) {}

  /**
   * Determine if an incoming message is a game action candidate.
   * Recognizes standard command prefixes like `.jawab`, `.bidik`, `.kartu`, `.hit`, `.stand`.
   */
  public isSecretGameAction(text: string): boolean {
    const trimmed = text.trim().toLowerCase();
    const actionPrefixes = [
      '.jawab', '!jawab', '/jawab',
      '.bidik', '!bidik', '/bidik',
      '.kartu', '!kartu', '/kartu',
      '.tahan', '!tahan', '/tahan',
      '.menyerah', '!menyerah', '/menyerah',
      '.hit', '!hit', '/hit',
      '.stand', '!stand', '/stand',
      '.double', '!double', '/double',
    ];
    return actionPrefixes.some((p) => trimmed.startsWith(p));
  }

  /**
   * Process an incoming action (either in DM or in Group) and dispatch to the matching GameEngine.
   */
  public async handleInboundMessage(
    inbound: DualChannelInbound,
    actionParser: (text: string, senderJid: string, isDm: boolean) => BaseGameAction | null
  ): Promise<{
    handled: boolean;
    groupJid?: string;
    result?: GameActionResult;
  }> {
    const action = actionParser(inbound.text, inbound.senderJid, inbound.isDirectMessage);
    if (!action) {
      return { handled: false };
    }

    const room = this.sessionManager.getRoomByPlayerJid(inbound.senderJid);
    if (!room) {
      return { handled: false };
    }

    const engine = this.sessionManager.getEngine(room.gameType);
    if (!engine) {
      return { handled: false };
    }

    const lockToken = await this.sessionManager.acquireLock(room.groupJid);
    if (!lockToken) {
      return {
        handled: true,
        groupJid: room.groupJid,
        result: {
          success: false,
          error: 'Game sedang memproses aksi lain, coba sesaat lagi.',
          state: room.state,
        },
      };
    }

    try {
      const result = await engine.processAction(room.state, action);
      room.state = result.state;
      room.lastActivityAt = Date.now();

      if (result.isGameOver) {
        room.status = 'finished';
      }

      return {
        handled: true,
        groupJid: room.groupJid,
        result,
      };
    } finally {
      await this.sessionManager.releaseLock(room.groupJid, lockToken);
    }
  }
}
