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
// 7. CASH & GUNS ENGINE (BIDIK RAHASIA DM, BERTAHAN/MENYERAH, CLICK/BANG, LOOT)
// ============================================================================

export type BulletType = 'CLICK' | 'BANG';
export type CourageChoice = 'STAND' | 'DUCK';

export interface CashGunsAimRecord {
  readonly shooterJid: string;
  readonly targetJid: string;
  readonly bullet: BulletType;
}

export interface CashGunsState {
  readonly gameId: string;
  readonly groupJid: string;
  readonly gameType: 'cash_and_guns';
  status: 'lobby' | 'aiming' | 'courage' | 'finished';
  seed: number;
  hostJid: string;
  maxRounds: number;
  round: number;
  players: GamePlayer[];
  magazines: Record<string, { clickRemaining: number; bangRemaining: number }>;
  currentLootPot: number;
  pendingAims: Record<string, CashGunsAimRecord>;
  courageDecisions: Record<string, CourageChoice>;
  winnerJids: string[];
  wagerAmount: number;
}

export interface CashGunsAction extends BaseGameAction {
  readonly type: 'JOIN' | 'START' | 'AIM' | 'COURAGE';
  readonly payload?: {
    readonly playerName?: string;
    readonly targetJid?: string;
    readonly bullet?: BulletType;
    readonly decision?: CourageChoice | 'BERTAHAN' | 'MENYERAH';
  };
}

export class CashAndGunsEngine implements GameEngine<CashGunsState, CashGunsAction> {
  readonly gameType = 'cash_and_guns';
  readonly displayName = 'Cash & Guns (Bluffing Peluru Click/Bang & Bagi Jarahan)';
  readonly category = 'party' as const;
  readonly minPlayers = 2; // Supports 2–8 players (classic 3–8, 2 allowed for duel heist)
  readonly maxPlayers = 8;
  readonly defaultTurnTimeoutMs = 45_000;

  createInitialState(options: {
    gameId: string;
    groupJid: string;
    host: GamePlayer;
    wagerAmount?: number;
    customConfig?: Record<string, unknown>;
  }): CashGunsState {
    const initialSeed = resolveInitialSeed(options.customConfig, options.gameId);
    const maxRounds = typeof options.customConfig?.maxRounds === 'number'
      ? Math.max(1, Math.min(8, Math.floor(options.customConfig.maxRounds)))
      : 8;

    const hostPlayer: GamePlayer = {
      ...options.host,
      score: options.host.score ?? 0,
      wounds: 0,
      isEliminated: false,
    };

    return {
      gameId: options.gameId,
      groupJid: options.groupJid,
      gameType: 'cash_and_guns',
      status: 'lobby',
      seed: initialSeed,
      hostJid: options.host.jid,
      maxRounds,
      round: 0,
      players: [hostPlayer],
      magazines: {
        [hostPlayer.jid]: { clickRemaining: 5, bangRemaining: 3 },
      },
      currentLootPot: 0,
      pendingAims: {},
      courageDecisions: {},
      winnerJids: [],
      wagerAmount: options.wagerAmount ?? 0,
    };
  }

  private rollLootPot(state: CashGunsState): number {
    const step = nextInt(state.seed, 4, 12);
    state.seed = step.nextSeed;
    return step.value * 10_000; // $40,000 .. $120,000 per round
  }

  private startNewHeistRound(state: CashGunsState): void {
    state.round += 1;
    state.status = 'aiming';
    state.currentLootPot = this.rollLootPot(state);
    state.pendingAims = {};
    state.courageDecisions = {};
  }

  private finishGame(state: CashGunsState, headerNote: string): GameActionResult<CashGunsState> {
    state.status = 'finished';
    const survivors = state.players.filter((p) => !p.isEliminated);
    const pool = survivors.length > 0 ? survivors : state.players;
    const maxScore = Math.max(...pool.map((p) => p.score ?? 0), 0);
    state.winnerJids = pool.filter((p) => (p.score ?? 0) === maxScore).map((p) => p.jid);

    const standings = [...state.players]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map(
        (p, i) =>
          `${i + 1}. ${formatPlayerTag(p.jid)} — *$${(p.score ?? 0).toLocaleString('en-US')}* (${p.isEliminated ? '💀 Gugur' : `❤️ Luka: ${p.wounds ?? 0}/3`})`,
      );

    return {
      success: true,
      state,
      isGameOver: true,
      winnerJids: state.winnerJids,
      mentions: state.players.map((p) => p.jid),
      broadcastMessage: [
        headerNote,
        '',
        `💰 *KLASEMEN AKHIR CASH & GUNS:*`,
        ...standings,
        '',
        `🏆 *PEMENANG UTAMA:* ${state.winnerJids.map((j) => formatPlayerTag(j)).join(', ')}`,
      ].join('\n'),
    };
  }

  private resolveCourageAndShootout(next: CashGunsState): GameActionResult<CashGunsState> {
    const alive = next.players.filter((p) => !p.isEliminated);
    const logs: string[] = [
      `🔫 *RESOLUSI BAKU TEMBAK — RONDE ${next.round}/${next.maxRounds}* (Pot Jarahan: *$${next.currentLootPot.toLocaleString('en-US')}*)`,
    ];

    // 1. Identify who ducked
    for (const p of alive) {
      const dec = next.courageDecisions[p.jid] ?? 'STAND';
      if (dec === 'DUCK') {
        logs.push(`🏳️ ${formatPlayerTag(p.jid)} memilih *MENYERAH (Duck)* dan berlindung di balik meja!`);
      }
    }

    // 2. Standing players fire their loaded cartridge
    for (const p of alive) {
      const shooterDecision = next.courageDecisions[p.jid] ?? 'STAND';
      const aim = next.pendingAims[p.jid];
      if (!aim) continue;

      if (shooterDecision === 'DUCK') {
        logs.push(`💨 ${formatPlayerTag(p.jid)} menurunkan pistolnya (tidak jadi menembak).`);
        continue;
      }

      const target = next.players.find((t) => t.jid === aim.targetJid);
      if (!target) continue;
      const targetDecision = next.courageDecisions[target.jid] ?? 'STAND';

      if (targetDecision === 'DUCK') {
        logs.push(
          `🛡️ ${formatPlayerTag(p.jid)} menarik pelatuk (*${aim.bullet}*) ke arah ${formatPlayerTag(target.jid)}, namun target sudah tiarap!`,
        );
        continue;
      }

      if (aim.bullet === 'CLICK') {
        logs.push(
          `😮‍💨 *KLIK!* Pistol ${formatPlayerTag(p.jid)} ke arah ${formatPlayerTag(target.jid)} hanya berisi peluru kosong!`,
        );
      } else {
        target.wounds = (target.wounds ?? 0) + 1;
        if (target.wounds >= 3) {
          target.isEliminated = true;
          logs.push(
            `💥 *DOR! (BANG)* ${formatPlayerTag(p.jid)} menembak ${formatPlayerTag(target.jid)}! Luka mencapai 3/3 — *GUGUR!*`,
          );
        } else {
          logs.push(
            `💥 *DOR! (BANG)* ${formatPlayerTag(p.jid)} melukai ${formatPlayerTag(target.jid)}! (Luka: ${target.wounds}/3)`,
          );
        }
      }
    }

    // 3. Divide loot among standing players who are still alive
    const lootEligible = next.players.filter(
      (p) => !p.isEliminated && (next.courageDecisions[p.jid] ?? 'STAND') === 'STAND',
    );

    if (lootEligible.length > 0) {
      const share = Math.floor(next.currentLootPot / lootEligible.length);
      for (const earner of lootEligible) {
        earner.score = (earner.score ?? 0) + share;
      }
      logs.push(
        `💵 *BAGI JARAHAN:* ${lootEligible.map((e) => formatPlayerTag(e.jid)).join(', ')} masing-masing mengantongi *$${share.toLocaleString('en-US')}*!`,
      );
    } else {
      logs.push(`💼 Tidak ada gangster yang berdiri tegak; jarahan *$${next.currentLootPot.toLocaleString('en-US')}* hangus!`);
    }

    const remainingSurvivors = next.players.filter((p) => !p.isEliminated);
    if (remainingSurvivors.length <= 1 || next.round >= next.maxRounds) {
      return this.finishGame(next, logs.join('\n'));
    }

    this.startNewHeistRound(next);
    logs.push(
      '',
      `💰 *RONDE ${next.round}/${next.maxRounds} DIMULAI!* Jarahan di meja: *$${next.currentLootPot.toLocaleString('en-US')}*`,
      `🔒 Kirim aksi *AIM* secara rahasia via DM (*target* + peluru *CLICK* / *BANG*)!`,
    );

    return {
      success: true,
      state: next,
      isGameOver: false,
      mentions: remainingSurvivors.map((p) => p.jid),
      broadcastMessage: logs.join('\n'),
    };
  }

  processAction(state: CashGunsState, action: CashGunsAction): GameActionResult<CashGunsState> {
    const next = cloneState(state);

    if (action.type === 'JOIN') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Cash & Guns sudah dimulai.', state: next };
      }
      if (next.players.some((p) => p.jid === action.playerJid)) {
        return { success: false, error: 'Kamu sudah terdaftar di lobi Cash & Guns.', state: next };
      }
      if (next.players.length >= this.maxPlayers) {
        return { success: false, error: 'Lobi Cash & Guns sudah penuh.', state: next };
      }
      next.players.push({
        jid: action.playerJid,
        name: action.payload?.playerName ?? formatPlayerTag(action.playerJid),
        score: 0,
        wounds: 0,
        isEliminated: false,
        joinedAt: Date.now(),
      });
      next.magazines[action.playerJid] = { clickRemaining: 5, bangRemaining: 3 };
      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        broadcastMessage: `🔫 ${formatPlayerTag(action.playerJid)} bergabung ke geng Cash & Guns! (Total: ${next.players.length} pemain)`,
      };
    }

    if (action.type === 'START') {
      if (next.status !== 'lobby') {
        return { success: false, error: 'Permainan Cash & Guns sudah berjalan.', state: next };
      }
      if (next.players.length < this.minPlayers) {
        return {
          success: false,
          error: `Minimal ${this.minPlayers} pemain diperlukan untuk memulai Cash & Guns.`,
          state: next,
        };
      }
      this.startNewHeistRound(next);
      return {
        success: true,
        state: next,
        mentions: next.players.map((p) => p.jid),
        broadcastMessage: [
          `🔫 *CASH & GUNS DIMULAI!* (Ronde 1/${next.maxRounds} • Jarahan: *$${next.currentLootPot.toLocaleString('en-US')}*)`,
          `Setiap pemain dibekali *5 Peluru CLICK (Kosong)* dan *3 Peluru BANG (Tajam)*.`,
          `🔒 *FASE BIDIK RAHASIA (DM):* Kirim target bidikan dan jenis peluru (*CLICK* / *BANG*) melalui DM ke bot!`,
        ].join('\n'),
      };
    }

    if (action.type === 'AIM') {
      if (next.status !== 'aiming') {
        return { success: false, error: 'Sekarang bukan fase membidik (AIM).', state: next };
      }
      if (!action.isDirectMessage) {
        return {
          success: false,
          error: '🔒 Aksi AIM (memilih peluru CLICK/BANG & target) WAJIB dikirim secara rahasia via DM!',
          state: next,
        };
      }
      const shooter = next.players.find((p) => p.jid === action.playerJid);
      if (!shooter || shooter.isEliminated) {
        return { success: false, error: 'Kamu bukan peserta aktif di ronde ini.', state: next };
      }
      if (next.pendingAims[action.playerJid]) {
        return { success: false, error: 'Kamu sudah mengunci bidikan dan peluru di ronde ini!', state: next };
      }

      const targetJid = action.payload?.targetJid?.trim();
      if (!targetJid || targetJid === action.playerJid) {
        return { success: false, error: 'Pilih pemain lawan yang valid sebagai target bidikan!', state: next };
      }
      const target = next.players.find((p) => p.jid === targetJid && !p.isEliminated);
      if (!target) {
        return { success: false, error: 'Target tidak ditemukan atau sudah tereliminasi.', state: next };
      }

      const bulletRaw = (action.payload?.bullet ?? 'CLICK').toUpperCase();
      if (bulletRaw !== 'CLICK' && bulletRaw !== 'BANG') {
        return { success: false, error: 'Jenis peluru harus CLICK atau BANG.', state: next };
      }
      const bullet = bulletRaw as BulletType;
      const mag = next.magazines[action.playerJid];
      if (bullet === 'BANG' && mag.bangRemaining <= 0) {
        return { success: false, error: 'Peluru BANG (Tajam) milikmu sudah habis! Gunakan CLICK.', state: next };
      }
      if (bullet === 'CLICK' && mag.clickRemaining <= 0) {
        return { success: false, error: 'Peluru CLICK (Kosong) milikmu sudah habis! Gunakan BANG.', state: next };
      }

      if (bullet === 'BANG') mag.bangRemaining -= 1;
      else mag.clickRemaining -= 1;

      next.pendingAims[action.playerJid] = {
        shooterJid: action.playerJid,
        targetJid,
        bullet,
      };

      const alive = next.players.filter((p) => !p.isEliminated);
      const aimedCount = alive.filter((p) => Boolean(next.pendingAims[p.jid])).length;

      if (aimedCount >= alive.length) {
        next.status = 'courage';
        const aimLines = alive.map((p) => {
          const a = next.pendingAims[p.jid]!;
          return `• ${formatPlayerTag(p.jid)} 🔫 menodong ${formatPlayerTag(a.targetJid)}`;
        });
        return {
          success: true,
          state: next,
          mentions: alive.map((p) => p.jid),
          directMessages: [
            {
              recipientJid: action.playerJid,
              text: `✅ Bidikan ke ${formatPlayerTag(targetJid)} dengan peluru *${bullet}* dikunci!`,
            },
          ],
          broadcastMessage: [
            `🎯 *SEMUA PISTOL TERACUNG! (FASE NYALI — RONDE ${next.round})*`,
            ...aimLines,
            '',
            `Pilih keputusanmu sekarang: *STAND* (Bertahan demi bagi jarahan) atau *DUCK* (Menyerah/Tiarap agar selamat dari tembakan)!`,
          ].join('\n'),
        };
      }

      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        directMessages: [
          {
            recipientJid: action.playerJid,
            text: `✅ Bidikan ke ${formatPlayerTag(targetJid)} dengan peluru *${bullet}* dikunci! (Sisa CLICK: ${mag.clickRemaining}, BANG: ${mag.bangRemaining})`,
          },
        ],
        broadcastMessage: `🔫 ${formatPlayerTag(action.playerJid)} telah menyiapkan pistolnya! (${aimedCount}/${alive.length} siap)`,
      };
    }

    if (action.type === 'COURAGE') {
      if (next.status !== 'courage') {
        return { success: false, error: 'Sekarang bukan fase memilih Bertahan/Menyerah (COURAGE).', state: next };
      }
      const player = next.players.find((p) => p.jid === action.playerJid);
      if (!player || player.isEliminated) {
        return { success: false, error: 'Kamu bukan peserta aktif di ronde ini.', state: next };
      }
      const rawDec = (action.payload?.decision ?? 'STAND').toUpperCase();
      const decision: CourageChoice =
        rawDec === 'DUCK' || rawDec === 'MENYERAH' ? 'DUCK' : 'STAND';

      next.courageDecisions[action.playerJid] = decision;

      const alive = next.players.filter((p) => !p.isEliminated);
      const decidedCount = alive.filter((p) => Boolean(next.courageDecisions[p.jid])).length;

      if (decidedCount >= alive.length) {
        return this.resolveCourageAndShootout(next);
      }

      return {
        success: true,
        state: next,
        mentions: [action.playerJid],
        broadcastMessage: `🛡️ ${formatPlayerTag(action.playerJid)} telah mengambil sikap! (${decidedCount}/${alive.length} siap)`,
      };
    }

    return {
      success: false,
      error: `Aksi Cash & Guns tidak dikenal: ${String(action.type)}`,
      state: next,
    };
  }

  handleTurnTimeout(state: CashGunsState): GameActionResult<CashGunsState> {
    const next = cloneState(state);
    const alive = next.players.filter((p) => !p.isEliminated);

    if (next.status === 'aiming') {
      for (const p of alive) {
        if (!next.pendingAims[p.jid]) {
          const others = alive.filter((o) => o.jid !== p.jid);
          const target = others[0] ?? p;
          const mag = next.magazines[p.jid];
          const bullet: BulletType = mag.clickRemaining > 0 ? 'CLICK' : 'BANG';
          if (bullet === 'CLICK' && mag.clickRemaining > 0) mag.clickRemaining -= 1;
          else if (mag.bangRemaining > 0) mag.bangRemaining -= 1;
          next.pendingAims[p.jid] = {
            shooterJid: p.jid,
            targetJid: target.jid,
            bullet,
          };
        }
      }
      next.status = 'courage';
      return {
        success: true,
        state: next,
        mentions: alive.map((p) => p.jid),
        broadcastMessage: `⏰ Waktu membidik habis! Pemain yang belum memilih otomatis membidik dengan peluru default. Sekarang fase *COURAGE* (STAND / DUCK)!`,
      };
    }

    if (next.status === 'courage') {
      for (const p of alive) {
        if (!next.courageDecisions[p.jid]) {
          next.courageDecisions[p.jid] = 'STAND';
        }
      }
      return this.resolveCourageAndShootout(next);
    }

    return {
      success: false,
      error: 'Tidak ada fase aktif untuk dieksekusi timeout pada Cash & Guns.',
      state: next,
    };
  }
}
