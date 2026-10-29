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
// 10. SPEED MONOPOLY ENGINE (16 PETAK, 4 KELOMPOK PROPERTI, MAKS 15 PUTARAN)
// ============================================================================

export type MonopolyColorGroup = 'BROWN' | 'CYAN' | 'AMBER' | 'EMERALD';
export type MonopolyTileKind =
  | 'START'
  | 'PROPERTY'
  | 'CHEST'
  | 'TAX'
  | 'JAIL'
  | 'FREE_PARKING'
  | 'CHANCE'
  | 'GO_TO_JAIL';

export interface MonopolyTileSpec {
  readonly index: number; // 0..15
  readonly name: string;
  readonly kind: MonopolyTileKind;
  readonly group?: MonopolyColorGroup;
  readonly price?: number;
  readonly baseRent?: number;
  readonly upgradeCost?: number;
  readonly taxAmount?: number;
}

export interface MonopolyPropertyOwnership {
  ownerJid: string;
  houses: number; // 0..3
}

export interface SpeedMonopolyState {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: 'speed_monopoly';
  status: 'lobby' | 'playing' | 'finished';
  seed: number;
  hostJid: string;
  maxRounds: number;
  round: number;
  players: GamePlayer[];
  cash: Record<string, number>;
  positions: Record<string, number>; // 0..15
  properties: Record<number, MonopolyPropertyOwnership>;
  freeParkingPot: number;
  currentTurnIndex: number;
  turnPhase: 'awaiting_roll' | 'awaiting_buy_decision';
  pendingPropertyTile: number | null;
  winnerJids: string[];
  wagerAmount: number;
}

export interface SpeedMonopolyAction extends BaseGameAction {
  readonly type: 'JOIN' | 'START' | 'ROLL' | 'BUY' | 'SKIP_BUY' | 'UPGRADE';
  readonly payload?: {
    readonly playerName?: string;
    readonly forcedDice?: number;
    readonly autoBuy?: boolean;
    readonly tileIndex?: number;
  };
}

export const SPEED_MONOPOLY_BOARD_16: readonly MonopolyTileSpec[] = [
  { index: 0, name: 'START (GO)', kind: 'START' },
  {
    index: 1,
    name: 'Medan Baru',
    kind: 'PROPERTY',
    group: 'BROWN',
    price: 100,
    baseRent: 35,
    upgradeCost: 60,
  },
  { index: 2, name: 'Dana Umum', kind: 'CHEST' },
  {
    index: 3,
    name: 'Malioboro Jogja',
    kind: 'PROPERTY',
    group: 'BROWN',
    price: 120,
    baseRent: 45,
    upgradeCost: 60,
  },
  { index: 4, name: 'Pajak Kota', kind: 'TAX', taxAmount: 100 },
  {
    index: 5,
    name: 'Braga Bandung',
    kind: 'PROPERTY',
    group: 'CYAN',
    price: 150,
    baseRent: 55,
    upgradeCost: 80,
  },
  { index: 6, name: 'Penjara / Kunjungan', kind: 'JAIL' },
  {
    index: 7,
    name: 'Tunjungan Surabaya',
    kind: 'PROPERTY',
    group: 'CYAN',
    price: 170,
    baseRent: 65,
    upgradeCost: 80,
  },
  { index: 8, name: 'Parkir Bebas', kind: 'FREE_PARKING' },
  {
    index: 9,
    name: 'Kuta Bali',
    kind: 'PROPERTY',
    group: 'AMBER',
    price: 200,
    baseRent: 80,
    upgradeCost: 100,
  },
  { index: 10, name: 'Kesempatan', kind: 'CHANCE' },
  {
    index: 11,
    name: 'Ubud Bali',
    kind: 'PROPERTY',
    group: 'AMBER',
    price: 220,
    baseRent: 90,
    upgradeCost: 100,
  },
  { index: 12, name: 'Masuk Penjara!', kind: 'GO_TO_JAIL' },
  {
    index: 13,
    name: 'Menteng Jakarta',
    kind: 'PROPERTY',
    group: 'EMERALD',
    price: 260,
    baseRent: 110,
    upgradeCost: 130,
  },
  { index: 14, name: 'Pajak Barang Mewah', kind: 'TAX', taxAmount: 120 },
  {
    index: 15,
    name: 'SCBD Sudirman',
    kind: 'PROPERTY',
    group: 'EMERALD',
    price: 300,
    baseRent: 130,
    upgradeCost: 130,
  },
];

export function calculatePlayerNetWorth(state: SpeedMonopolyState, playerJid: string): number {
  let worth = state.cash[playerJid] ?? 0;
  for (const [tileIdxStr, prop] of Object.entries(state.properties)) {
    if (prop.ownerJid === playerJid) {
      const spec = SPEED_MONOPOLY_BOARD_16[Number(tileIdxStr)];
      if (spec) {
        worth += (spec.price ?? 0) + prop.houses * (spec.upgradeCost ?? 0);
      }
    }
  }
  return worth;
}

export function ownsFullMonopolyGroup(
  state: SpeedMonopolyState,
  ownerJid: string,
  group?: MonopolyColorGroup,
): boolean {
  if (!group) return false;
  const groupTiles = SPEED_MONOPOLY_BOARD_16.filter(
    (t) => t.kind === 'PROPERTY' && t.group === group,
  );
  return (
    groupTiles.length > 0 &&
    groupTiles.every((t) => state.properties[t.index]?.ownerJid === ownerJid)
  );
}

export class SpeedMonopolyEngine
  implements GameEngine<SpeedMonopolyState, SpeedMonopolyAction>
{
  readonly gameType = 'speed_monopoly';
  readonly displayName = 'Speed Monopoly (16 Petak, 4 Grup Properti, Maks 15 Putaran)';
  readonly category = 'board' as const;
  readonly minPlayers = 2;
  readonly maxPlayers = 6;
  readonly defaultTurnTimeoutMs = 45_000;

  createInitialState(options: {
    gameId: string;
    groupJid: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): SpeedMonopolyState {
    const seed = resolveInitialSeed(options.customConfig, options.gameId);
    const maxRounds = typeof options.customConfig?.maxRounds === 'number'
      ? Math.max(1, Math.min(30, Math.floor(options.customConfig.maxRounds)))
      : 15;
    const startingCash = typeof options.customConfig?.startingCash === 'number'
      ? Math.max(200, Math.floor(options.customConfig.startingCash))
      : 1000;

    return {
      gameId: options.gameId,
      groupJid: options.groupJid,
      gameType: 'speed_monopoly',
      status: 'lobby',
      seed,
      hostJid: options.host.jid,
      maxRounds,
      round: 1,
      players: [
        {
          ...options.host,
          score: startingCash,
          isEliminated: false,
        },
      ],
      cash: { [options.host.jid]: startingCash },
      positions: { [options.host.jid]: 0 },
      properties: {},
      freeParkingPot: 100,
      currentTurnIndex: 0,
      turnPhase: 'awaiting_roll',
      pendingPropertyTile: null,
      winnerJids: [],
      wagerAmount: options.wagerAmount ?? 0,
    };
  }

  private syncScores(state: SpeedMonopolyState): void {
    for (const p of state.players) {
      p.score = calculatePlayerNetWorth(state, p.jid);
    }
  }

  private finalizeMonopolyGame(
    state: SpeedMonopolyState,
    prefixLines: string[],
  ): GameActionResult<SpeedMonopolyState> {
    state.status = 'finished';
    state.turnPhase = 'awaiting_roll';
    state.pendingPropertyTile = null;
    this.syncScores(state);

    const alive = state.players.filter((p) => !p.isEliminated);
    const pool = alive.length > 0 ? alive : state.players;
    const maxWorth = Math.max(...pool.map((p) => p.score ?? 0), 0);
    state.winnerJids = pool.filter((p) => (p.score ?? 0) === maxWorth).map((p) => p.jid);

    const leaderboard = [...state.players]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map(
        (p, idx) =>
          `${idx + 1}. ${formatPlayerTag(p.jid)} — Kekayaan Bersih: *$${(p.score ?? 0).toLocaleString('en-US')}* (Kas: $${(state.cash[p.jid] ?? 0).toLocaleString('en-US')})${p.isEliminated ? ' [Bangkrut]' : ''}`,
      );

    return {
      success: true,
      state,
      isGameOver: true,
      winnerJids: state.winnerJids,
      mentions: state.players.map((p) => p.jid),
      broadcastMessage: [
        ...prefixLines,
        '',
        `🏦 *KLASEMEN AKHIR SPEED MONOPOLY:*`,
        ...leaderboard,
        '',
        `🏆 *PEMENANG:* ${state.winnerJids.map((j) => formatPlayerTag(j)).join(', ')}`,
      ].join('\n'),
    };
  }

  private advanceToNextTurn(
    state: SpeedMonopolyState,
    logs: string[],
  ): GameActionResult<SpeedMonopolyState> {
    this.syncScores(state);
    const alive = state.players.filter((p) => !p.isEliminated);
    if (alive.length <= 1) {
      return this.finalizeMonopolyGame(state, logs);
    }

    const totalPlayers = state.players.length;
    let nextIdx = (state.currentTurnIndex + 1) % totalPlayers;
    let wrappedAround = nextIdx <= state.currentTurnIndex;

    let guard = 0;
    while (state.players[nextIdx]?.isEliminated && guard < totalPlayers) {
      const prev = nextIdx;
      nextIdx = (nextIdx + 1) % totalPlayers;
      if (nextIdx <= prev) wrappedAround = true;
      guard += 1;
    }

    if (wrappedAround) {
      state.round += 1;
      if (state.round > state.maxRounds) {
        logs.push(`🏁 *Batas Maksimum ${state.maxRounds} Putaran Tercapai!*`);
        return this.finalizeMonopolyGame(state, logs);
      }
    }

    state.currentTurnIndex = nextIdx;
    state.turnPhase = 'awaiting_roll';
    state.pendingPropertyTile = null;

    const nextPlayer = state.players[state.currentTurnIndex];
    logs.push(
      `👉 *Putaran ${state.round}/${state.maxRounds}* — Giliran ${formatPlayerTag(nextPlayer.jid)} (Kas: *$${state.cash[nextPlayer.jid]}*)`,
    );

    return {
      success: true,
      state,
      isGameOver: false,
      mentions: [nextPlayer.jid],
      broadcastMessage: logs.join('\n'),
    };
  }

  private handleBankruptcyIfNeeded(
    state: SpeedMonopolyState,
    player: GamePlayer,
    creditorJid: string | null,
    logs: string[],
  ): void {
    if ((state.cash[player.jid] ?? 0) >= 0) return;

    // Liquidate properties at 100% value until solvent or out of properties
    for (const [tileIdxStr, prop] of Object.entries(state.properties)) {
      if ((state.cash[player.jid] ?? 0) >= 0) break;
      if (prop.ownerJid === player.jid) {
        const idx = Number(tileIdxStr);
        const spec = SPEED_MONOPOLY_BOARD_16[idx];
        const liquidationValue = (spec?.price ?? 100) + prop.houses * (spec?.upgradeCost ?? 50);
        state.cash[player.jid] += liquidationValue;
        delete state.properties[idx];
        logs.push(
          `🏚️ ${formatPlayerTag(player.jid)} menjual aset *${spec?.name}* senilai *$${liquidationValue}* untuk menutup utang!`,
        );
      }
    }

    if ((state.cash[player.jid] ?? 0) < 0) {
      if (creditorJid && state.cash[creditorJid] !== undefined) {
        // Adjust creditor for unpaid shortfall
        state.cash[creditorJid] += state.cash[player.jid];
      }
      state.cash[player.jid] = 0;
      player.isEliminated = true;
      logs.push(`💀 *BANGKRUT!* ${formatPlayerTag(player.jid)} kehabisan uang dan aset sehingga tereliminasi!`);
    }
  }

  processAction(
    state: SpeedMonopolyState,
    action: SpeedMonopolyAction,
  ): GameActionResult<SpeedMonopolyState> {
    const next = cloneState(state);

    if (action.type === 'JOIN') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Speed Monopoly sudah dimulai.', state: next };
      }
      if (next.players.some((p) => p.jid === action.playerJid)) {
        return { success: false, error: 'Kamu sudah terdaftar di lobi Speed Monopoly.', state: next };
      }
      if (next.players.length >= this.maxPlayers) {
        return { success: false, error: 'Lobi Speed Monopoly sudah penuh.', state: next };
      }
      const startCash = next.cash[next.hostJid] ?? 1000;
      next.players.push({
        jid: action.playerJid,
        name: action.payload?.playerName ?? formatPlayerTag(action.playerJid),
        score: startCash,
        isEliminated: false,
        joinedAt: Date.now(),
      });
      next.cash[action.playerJid] = startCash;
      next.positions[action.playerJid] = 0;
      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        broadcastMessage: `🎩 ${formatPlayerTag(action.playerJid)} bergabung ke Speed Monopoly! (Modal awal: *$${startCash}* • Total: ${next.players.length} pemain)`,
      };
    }

    if (action.type === 'START') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Speed Monopoly sudah berjalan.', state: next };
      }
      if (next.players.length < this.minPlayers) {
        return {
          success: false,
          error: `Minimal ${this.minPlayers} pemain diperlukan untuk memulai Speed Monopoly.`,
          state: next,
        };
      }
      next.status = 'playing';
      next.round = 1;
      next.currentTurnIndex = 0;
      next.turnPhase = 'awaiting_roll';
      const first = next.players[0];
      return {
        success: true,
        state: next,
        mentions: next.players.map((p) => p.jid),
        broadcastMessage: [
          `🎩 *SPEED MONOPOLY 16 PETAK DIMULAI!* (Maks ${next.maxRounds} Putaran)`,
          `Giliran Pertama: ${formatPlayerTag(first.jid)} (Kas: *$${next.cash[first.jid]}*) — Ketik *roll* untuk melangkah!`,
        ].join('\n'),
      };
    }

    if (next.status !== 'playing') {
      return {
        success: false,
        error: 'Permainan Speed Monopoly belum dimulai atau sudah selesai.',
        state: next,
      };
    }

    const activePlayer = next.players[next.currentTurnIndex];
    if (!activePlayer || activePlayer.jid !== action.playerJid) {
      return {
        success: false,
        error: `Sekarang adalah giliran ${activePlayer ? formatPlayerTag(activePlayer.jid) : 'pemain lain'}!`,
        state: next,
      };
    }

    if (action.type === 'UPGRADE') {
      const tileIdx = action.payload?.tileIndex ?? next.positions[activePlayer.jid];
      const spec = SPEED_MONOPOLY_BOARD_16[tileIdx];
      const ownership = next.properties[tileIdx];
      if (!spec || spec.kind !== 'PROPERTY' || !ownership || ownership.ownerJid !== activePlayer.jid) {
        return {
          success: false,
          error: 'Kamu hanya bisa membangun upgrade pada properti milikmu sendiri.',
          state: next,
        };
      }
      if (!ownsFullMonopolyGroup(next, activePlayer.jid, spec.group)) {
        return {
          success: false,
          error: `Kamu harus memiliki seluruh properti di grup warna *${spec.group}* untuk membangun upgrade!`,
          state: next,
        };
      }
      if (ownership.houses >= 3) {
        return {
          success: false,
          error: `Properti *${spec.name}* sudah mencapai level upgrade maksimum (3 rumah/hotel).`,
          state: next,
        };
      }
      const cost = spec.upgradeCost ?? 80;
      if ((next.cash[activePlayer.jid] ?? 0) < cost) {
        return {
          success: false,
          error: `Kas tidak cukup untuk upgrade *${spec.name}* (Biaya: $${cost}).`,
          state: next,
        };
      }
      next.cash[activePlayer.jid] -= cost;
      ownership.houses += 1;
      this.syncScores(next);
      return {
        success: true,
        state: next,
        mentions: [activePlayer.jid],
        broadcastMessage: `🏗️ ${formatPlayerTag(activePlayer.jid)} membangun Rumah Level ${ownership.houses} di *${spec.name}* (-$${cost} • Sisa Kas: *$${next.cash[activePlayer.jid]}*)!`,
      };
    }

    if (action.type === 'BUY') {
      if (next.turnPhase !== 'awaiting_buy_decision' || next.pendingPropertyTile === null) {
        return {
          success: false,
          error: 'Tidak ada properti yang sedang ditawarkan untuk dibeli.',
          state: next,
        };
      }
      const tile = SPEED_MONOPOLY_BOARD_16[next.pendingPropertyTile];
      const price = tile.price ?? 100;
      if ((next.cash[activePlayer.jid] ?? 0) < price) {
        return {
          success: false,
          error: `Uang kas tidak mencukupi untuk membeli *${tile.name}* ($${price}).`,
          state: next,
        };
      }
      next.cash[activePlayer.jid] -= price;
      next.properties[tile.index] = {
        ownerJid: activePlayer.jid,
        houses: 0,
      };
      const logs = [
        `🏠 *BELI PROPERTI!* ${formatPlayerTag(activePlayer.jid)} membeli *${tile.name}* (${tile.group}) seharga *$${price}*! (Sisa Kas: *$${next.cash[activePlayer.jid]}*)`,
      ];
      return this.advanceToNextTurn(next, logs);
    }

    if (action.type === 'SKIP_BUY') {
      if (next.turnPhase !== 'awaiting_buy_decision' || next.pendingPropertyTile === null) {
        return {
          success: false,
          error: 'Tidak ada tawaran pembelian properti yang perlu dilewati.',
          state: next,
        };
      }
      const tile = SPEED_MONOPOLY_BOARD_16[next.pendingPropertyTile];
      const logs = [
        `⏭️ ${formatPlayerTag(activePlayer.jid)} memilih tidak membeli *${tile.name}*.`,
      ];
      return this.advanceToNextTurn(next, logs);
    }

    if (action.type === 'ROLL') {
      if (next.turnPhase !== 'awaiting_roll') {
        return {
          success: false,
          error: 'Putuskan terlebih dahulu untuk membeli (*BUY*) atau melewati (*SKIP_BUY*) properti saat ini!',
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

      const prevPos = next.positions[activePlayer.jid] ?? 0;
      const rawNext = prevPos + dice;
      const passedGo = rawNext >= 16;
      const newPos = rawNext % 16;
      next.positions[activePlayer.jid] = newPos;

      const tile = SPEED_MONOPOLY_BOARD_16[newPos];
      const logs: string[] = [
        `🎲 ${formatPlayerTag(activePlayer.jid)} melempar dadu *[ ${dice} ]* → mendarat di Petak #${newPos} *${tile.name}*!`,
      ];

      if (passedGo) {
        next.cash[activePlayer.jid] = (next.cash[activePlayer.jid] ?? 0) + 200;
        logs.push(`💵 *Melewati START (GO)!* Gaji *+$200* diterima (Kas: *$${next.cash[activePlayer.jid]}*).`);
      }

      if (tile.kind === 'TAX') {
        const tax = tile.taxAmount ?? 100;
        next.cash[activePlayer.jid] -= tax;
        next.freeParkingPot += tax;
        logs.push(`🏛️ Membayar *${tile.name}* sebesar *-$${tax}* ke kas Parkir Bebas!`);
        this.handleBankruptcyIfNeeded(next, activePlayer, null, logs);
        return this.advanceToNextTurn(next, logs);
      }

      if (tile.kind === 'FREE_PARKING') {
        const jackpot = Math.max(50, next.freeParkingPot);
        next.cash[activePlayer.jid] += jackpot;
        next.freeParkingPot = 50;
        logs.push(`🅿️ *JACKPOT PARKIR BEBAS!* ${formatPlayerTag(activePlayer.jid)} memanen dana terkumpul *+$${jackpot}*!`);
        return this.advanceToNextTurn(next, logs);
      }

      if (tile.kind === 'GO_TO_JAIL') {
        next.positions[activePlayer.jid] = 6;
        const bail = 75;
        next.cash[activePlayer.jid] -= bail;
        next.freeParkingPot += bail;
        logs.push(`🚓 *MASUK PENJARA!* Dipindahkan ke Petak #6 dan membayar tebusan kilat *-$${bail}*!`);
        this.handleBankruptcyIfNeeded(next, activePlayer, null, logs);
        return this.advanceToNextTurn(next, logs);
      }

      if (tile.kind === 'CHEST' || tile.kind === 'CHANCE') {
        const cardPick = nextInt(next.seed, 0, 2);
        next.seed = cardPick.nextSeed;
        if (cardPick.value === 0) {
          next.cash[activePlayer.jid] += 150;
          logs.push(`🎁 Kartu *${tile.name}*: Dividen investasi cair *+$150*!`);
        } else if (cardPick.value === 1) {
          next.cash[activePlayer.jid] += 100;
          logs.push(`🎁 Kartu *${tile.name}*: Hadiah kompetisi bisnis *+$100*!`);
        } else {
          next.cash[activePlayer.jid] -= 60;
          next.freeParkingPot += 60;
          logs.push(`📄 Kartu *${tile.name}*: Biaya renovasi gedung *-$60*!`);
          this.handleBankruptcyIfNeeded(next, activePlayer, null, logs);
        }
        return this.advanceToNextTurn(next, logs);
      }

      if (tile.kind === 'PROPERTY') {
        const existingOwner = next.properties[tile.index];
        if (!existingOwner) {
          const price = tile.price ?? 100;
          if ((next.cash[activePlayer.jid] ?? 0) >= price) {
            if (action.payload?.autoBuy) {
              next.cash[activePlayer.jid] -= price;
              next.properties[tile.index] = { ownerJid: activePlayer.jid, houses: 0 };
              logs.push(
                `🏠 *AUTO-BUY!* ${formatPlayerTag(activePlayer.jid)} membeli *${tile.name}* seharga *$${price}*!`,
              );
              return this.advanceToNextTurn(next, logs);
            }
            next.turnPhase = 'awaiting_buy_decision';
            next.pendingPropertyTile = tile.index;
            this.syncScores(next);
            logs.push(
              `🏷️ *${tile.name}* (${tile.group}) belum bertuan! Harga: *$${price}* (Sewa Dasar: $${tile.baseRent}).`,
              `Ketik *BUY* untuk membeli atau *SKIP_BUY* untuk melewati!`,
            );
            return {
              success: true,
              state: next,
              isGameOver: false,
              mentions: [activePlayer.jid],
              broadcastMessage: logs.join('\n'),
            };
          }
          logs.push(`💸 Kas tidak cukup untuk membeli *${tile.name}* ($${price}).`);
          return this.advanceToNextTurn(next, logs);
        }

        if (existingOwner.ownerJid === activePlayer.jid) {
          logs.push(`🏡 Mendarat di properti milik sendiri (*${tile.name}*).`);
          return this.advanceToNextTurn(next, logs);
        }

        // Pay rent to property owner
        const baseRent = tile.baseRent ?? 40;
        const hasMonopoly = ownsFullMonopolyGroup(next, existingOwner.ownerJid, tile.group);
        const multiplier = (hasMonopoly ? 2 : 1) + existingOwner.houses;
        const rent = baseRent * multiplier;

        next.cash[activePlayer.jid] -= rent;
        next.cash[existingOwner.ownerJid] = (next.cash[existingOwner.ownerJid] ?? 0) + rent;
        logs.push(
          `💸 *BAYAR SEWA!* ${formatPlayerTag(activePlayer.jid)} membayar sewa *$${rent}* kepada ${formatPlayerTag(existingOwner.ownerJid)} di *${tile.name}*${hasMonopoly ? ' (Monopoli Warna 2x)' : ''}!`,
        );
        this.handleBankruptcyIfNeeded(next, activePlayer, existingOwner.ownerJid, logs);
        return this.advanceToNextTurn(next, logs);
      }

      return this.advanceToNextTurn(next, logs);
    }

    return {
      success: false,
      error: `Aksi Speed Monopoly tidak dikenal: ${String(action.type)}`,
      state: next,
    };
  }

  handleTurnTimeout(state: SpeedMonopolyState): GameActionResult<SpeedMonopolyState> {
    const next = cloneState(state);
    if (next.status !== 'playing') {
      return {
        success: false,
        error: 'Tidak ada permainan Speed Monopoly yang sedang aktif.',
        state: next,
      };
    }
    const activePlayer = next.players[next.currentTurnIndex];
    const logs = [`⏰ Waktu giliran ${formatPlayerTag(activePlayer.jid)} habis!`];
    return this.advanceToNextTurn(next, logs);
  }
}
