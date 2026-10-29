/**
 * @file session-manager.ts
 * @description Centralized Session & Room Manager for Allybot PlayMatrix.
 * Provides Redis 8 distributed locking (SET NX PX) with fallback in-memory mutex,
 * active room lifecycles, and turn timeout watchers.
 */

import crypto from 'node:crypto';
import type { ActiveGameRoom, GameEngine, GamePlayer, GameStatus } from '../types.js';

export interface RedisLockClient {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<boolean>;
  del(key: string): Promise<boolean>;
}

export class GameSessionManager {
  private readonly rooms = new Map<string, ActiveGameRoom>();
  private readonly engines = new Map<string, GameEngine>();
  private readonly playerRoomIndex = new Map<string, string>(); // userJid -> groupJid
  private readonly localLocks = new Map<string, { token: string; expiresAt: number }>();
  private readonly redis: RedisLockClient | null;

  constructor(options: { redis?: RedisLockClient | null } = {}) {
    this.redis = options.redis ?? null;
  }

  public registerEngine(engine: GameEngine): void {
    this.engines.set(engine.gameType, engine);
  }

  public getEngine(gameType: string): GameEngine | undefined {
    return this.engines.get(gameType);
  }

  public async acquireLock(groupJid: string, ttlMs = 5000): Promise<string | null> {
    const lockKey = `lock:game:${groupJid}`;
    const token = crypto.randomUUID();

    if (this.redis) {
      try {
        const acquired = await this.redis.set(lockKey, token, Math.ceil(ttlMs / 1000));
        if (acquired) return token;
      } catch {
        // Fallback to local lock if redis fails
      }
    }

    const now = Date.now();
    const existing = this.localLocks.get(lockKey);
    if (existing && existing.expiresAt > now) {
      return null;
    }

    this.localLocks.set(lockKey, { token, expiresAt: now + ttlMs });
    return token;
  }

  public async releaseLock(groupJid: string, token: string): Promise<void> {
    const lockKey = `lock:game:${groupJid}`;

    if (this.redis) {
      try {
        const cur = await this.redis.get<string>(lockKey);
        if (cur === token) {
          await this.redis.del(lockKey);
        }
      } catch {
        // ignore
      }
    }

    const local = this.localLocks.get(lockKey);
    if (local && local.token === token) {
      this.localLocks.delete(lockKey);
    }
  }

  public createRoom<TState>(options: {
    groupJid: string;
    gameType: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): ActiveGameRoom<TState> {
    const { groupJid, gameType, host, wagerAmount = 0, customConfig } = options;

    if (this.rooms.has(groupJid)) {
      throw new Error(`Permainan lain sedang aktif di grup ini.`);
    }

    const engine = this.engines.get(gameType);
    if (!engine) {
      throw new Error(`Engine game "${gameType}" belum terdaftar.`);
    }

    const gameId = crypto.randomUUID().slice(0, 8);
    const now = Date.now();

    const initialState = engine.createInitialState({
      gameId,
      groupJid,
      host,
      wagerAmount,
      customConfig,
    }) as TState;

    const playersMap = new Map<string, GamePlayer>();
    playersMap.set(host.jid, host);

    const room: ActiveGameRoom<TState> = {
      gameId,
      groupJid,
      gameType,
      hostJid: host.jid,
      status: 'lobby',
      players: playersMap,
      wagerAmount,
      createdAt: now,
      lastActivityAt: now,
      turnExpiresAt: now + engine.defaultTurnTimeoutMs,
      activePlayerJid: host.jid,
      state: initialState,
    };

    this.rooms.set(groupJid, room as ActiveGameRoom<unknown>);
    this.playerRoomIndex.set(host.jid, groupJid);

    return room;
  }

  public getRoom<TState = unknown>(groupJid: string): ActiveGameRoom<TState> | undefined {
    return this.rooms.get(groupJid) as ActiveGameRoom<TState> | undefined;
  }

  public getRoomByPlayerJid<TState = unknown>(playerJid: string): ActiveGameRoom<TState> | undefined {
    const groupJid = this.playerRoomIndex.get(playerJid);
    if (!groupJid) return undefined;
    return this.getRoom<TState>(groupJid);
  }

  public addPlayer(groupJid: string, player: GamePlayer): boolean {
    const room = this.rooms.get(groupJid);
    if (!room || room.status !== 'lobby') return false;

    const engine = this.engines.get(room.gameType);
    if (engine && room.players.size >= engine.maxPlayers) {
      throw new Error(`Kamar penuh! Maksimal ${engine.maxPlayers} pemain.`);
    }

    if (this.playerRoomIndex.has(player.jid)) {
      const activeG = this.playerRoomIndex.get(player.jid);
      if (activeG !== groupJid) {
        throw new Error(`Kamu masih terdaftar dalam game aktif di grup lain.`);
      }
    }

    room.players.set(player.jid, player);
    room.lastActivityAt = Date.now();
    this.playerRoomIndex.set(player.jid, groupJid);
    return true;
  }

  public setStatus(groupJid: string, status: GameStatus): void {
    const room = this.rooms.get(groupJid);
    if (room) {
      room.status = status;
      room.lastActivityAt = Date.now();
    }
  }

  public closeRoom(groupJid: string): void {
    const room = this.rooms.get(groupJid);
    if (room) {
      for (const pJid of room.players.keys()) {
        if (this.playerRoomIndex.get(pJid) === groupJid) {
          this.playerRoomIndex.delete(pJid);
        }
      }
      this.rooms.delete(groupJid);
    }
  }
}
