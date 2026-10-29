/**
 * @file arcade.ts
 * @description Official Allybot Plugin for the 10-Minigame Arcade Suite.
 * Commands registered:
 *   - !wordle (aliases: !katla)
 *   - !tarot (aliases: !arcana)
 *   - !bom (aliases: !hotpotato)
 *   - !lms (aliases: !kuislms)
 *   - !blackjack (aliases: !bj, !21)
 *   - !uno (aliases: !kartuuno)
 *   - !cashguns (aliases: !cng)
 *   - !ulartangga (aliases: !ut, !snakes)
 *   - !ludo (aliases: !ludoking)
 *   - !monopoli (aliases: !monopoly)
 *   - !arcade (aliases: !arcadelb, !arcadestats)
 *
 * Hooks `message.received` for ambient gameplay moves and secret DM answers/aiming.
 */

import type {
  CommandContext,
  CoreMessage,
  Plugin,
  PluginContext,
  WhatsAppPort,
} from '../contracts.js';
import {
  ArcadeService,
  type ArcadeDispatchOutput,
  normalizeWhatsAppUserJid,
} from '../../services/arcade/arcade-service.js';
import type { ArcadeGameType } from '../../services/arcade/arcade-engines.js';
import { renderArcadeGameStatePng } from '../../services/arcade/arcade-renderer.js';

export interface ArcadePluginOptions {
  service?: ArcadeService;
  dbPath?: string;
  whatsapp?: WhatsAppPort;
}

let sharedService: ArcadeService | null = null;

function getSharedService(options: ArcadePluginOptions = {}): ArcadeService {
  if (!sharedService) {
    sharedService = options.service ?? new ArcadeService({ dbPath: options.dbPath });
  }
  return sharedService;
}

export function isArcadeMoveOrDm(
  service: ArcadeService,
  msg: { remoteJid: string; senderJid?: string; text?: string; isDirectMessage?: boolean },
): boolean {
  const text = (msg.text || '').trim();
  if (!text) return false;

  const isDm = msg.isDirectMessage ?? !msg.remoteJid.endsWith('@g.us');
  if (isDm && msg.senderJid) {
    const dmSession = service.getActiveSessionForPlayerDm(msg.senderJid);
    if (!dmSession) return false;
    if (dmSession.gameType === 'lms_quiz' && /^(?:!?(?:lms|jawab|answer)\s+)?[A-Da-d]$/.test(text)) {
      return true;
    }
    if (
      dmSession.gameType === 'cash_and_guns' &&
      /^(?:!?aim|bidik|tembak)\s+/i.test(text)
    ) {
      return true;
    }
    return false;
  }

  const session = service.getActiveSession(msg.remoteJid);
  if (!session) return false;

  if (session.gameType === 'hot_potato' && /^\.pass\b/i.test(text)) {
    return true;
  }
  if (session.gameType === 'wordle' && /^[A-Za-z]{5}$/.test(text)) {
    return true;
  }
  if (session.gameType === 'blackjack' && /^(hit|stand|double)$/i.test(text)) {
    return true;
  }
  if (
    (session.gameType === 'ular_tangga' ||
      session.gameType === 'ludo' ||
      session.gameType === 'speed_monopoly') &&
    /^(roll|kocok|lempar|buy|beli|skip|lewat)$/i.test(text)
  ) {
    return true;
  }

  return false;
}

export const ARCADE_GAME_GUIDES: Record<ArcadeGameType, (prefix: string) => string> = {
  wordle: (p) => [
    '🟩 *PANDUAN WORDLE INDONESIA (KBBI)*',
    '',
    'Tebak kata rahasia 5 huruf baku dalam 6 kesempatan.',
    '',
    '• 🟩 *Hijau* : Huruf tepat pada posisinya',
    '• 🟨 *Kuning*: Huruf ada di kata tapi posisinya salah',
    '• ⬛ *Abu*   : Huruf tidak ada di dalam kata',
    '',
    '*Perintah:*',
    `• \`${p}wordle start\` : Mulai permainan kata baru`,
    `• \`${p}wordle <kata5huruf>\` : Tebak kata (atau ketik langsung 5 huruf)`,
    `• \`${p}wordle board\` : Tampilkan papan tebakan`,
    `• \`${p}wordle cancel\` : Batalkan sesi kata`,
    '',
    'Contoh: Ketik `!wordle start` lalu ketik `SURGA`',
  ].join('\n'),

  tarot: (p) => [
    '🔮 *PANDUAN TAROT READING (78 ARCANA)*',
    '',
    'Penarikan kartu Tarot lengkap (22 Major Arcana + 56 Minor Arcana).',
    'Setiap kartu memiliki interpretasi Tegak (Upright) atau Terbalik (Reversed).',
    '',
    '*Pilihan Tebaran (Spread):*',
    `• \`${p}tarot 1 [pertanyaan]\` : 1 Kartu (Fokus Utama / Insight harian)`,
    `• \`${p}tarot 3 [pertanyaan]\` : 3 Kartu (Masa Lalu, Sekarang, Masa Depan)`,
    '',
    '*Contoh:*',
    `• \`${p}tarot 1 bagaimana energiku hari ini?\``,
    `• \`${p}tarot 3 apakah usaha baruku akan lancar?\``,
  ].join('\n'),

  hot_potato: (p) => [
    '💣 *PANDUAN HOT POTATO BOM*',
    '',
    'Estafet bom berisiko tinggi! Bom memiliki sumbu rahasia acak (30–75 detik).',
    'Oper bom secepatnya sebelum meledak di tanganmu!',
    '',
    '*Alur Permainan:*',
    `1. Host buka lobi: \`${p}bom start [taruhan_vela]\``,
    `2. Pemain lain gabung: \`${p}bom join\``,
    `3. Host mulai: \`${p}bom mulai\``,
    `4. Pemegang bom oper cepat: \`.pass @target\` (bisa tanpa prefix)`,
    '',
    'Pemain yang memegang bom saat meledak langsung tereliminasi!',
  ].join('\n'),

  lms_quiz: (p) => [
    '🧠 *PANDUAN LAST MAN STANDING (LMS QUIZ)*',
    '',
    'Kuis eliminasi massal bertahan hidup.',
    'Soal dikirim di grup, semua pemain WAJIB menjawab secara RAHASIA via DM bot!',
    '',
    '*Alur Permainan:*',
    `1. Host buka kuis: \`${p}lms start [taruhan_vela]\``,
    `2. Pemain lain gabung: \`${p}lms join\``,
    `3. Host mulai: \`${p}lms mulai\``,
    `4. Jawab rahasia via DM bot: ketik \`A\`, \`B\`, \`C\`, atau \`D\` di chat pribadi bot`,
    '',
    'Pemain yang salah atau tidak menjawab sebelum batas waktu langsung gugur!',
  ].join('\n'),

  blackjack: (p) => [
    '🃏 *PANDUAN BLACKJACK 21 (VS DEALER AI)*',
    '',
    'Dapatkan nilai kartu sedekat mungkin ke 21 tanpa melebihi (Bust).',
    'Dealer AI wajib hit sampai minimal 17. Natural Blackjack bayar 3:2!',
    '',
    '*Alur Permainan:*',
    `1. Buka meja: \`${p}bj start [taruhan_vela]\``,
    `2. Gabung meja: \`${p}bj join\``,
    `3. Mulai deal: \`${p}bj deal\` (atau \`${p}bj start\`)`,
    '',
    '*Aksi Saat Giliranmu:*',
    `• \`${p}bj hit\` (atau ketik \`hit\`) : Tambah 1 kartu`,
    `• \`${p}bj stand\` (atau ketik \`stand\`) : Tahan kartu saat ini`,
    `• \`${p}bj double\` (atau ketik \`double\`) : Gandakan taruhan & ambil 1 kartu terakhir`,
  ].join('\n'),

  uno: (p) => [
    '🎴 *PANDUAN KARTU UNO (108 KARTU RESMI)*',
    '',
    'Buang kartu yang cocok warna atau angkanya dengan kartu di meja.',
    'Kartu di tanganmu dikirim secara rahasia via DM oleh bot!',
    '',
    '*Kartu Aksi:*',
    '• *Draw 2* : Lawan berikutnya ambil 2 kartu & giliran dilewati',
    '• *Skip* : Lewati giliran pemain berikutnya',
    '• *Reverse* : Balikkan arah putaran giliran',
    '• *Wild* : Bebas buang & tentukan warna aktif',
    '• *Wild Draw 4* : Lawan ambil 4 kartu & tentukan warna aktif',
    '',
    '*Perintah:*',
    `• \`${p}uno start [taruhan]\` : Buka meja Uno`,
    `• \`${p}uno join\` : Ikut bermain`,
    `• \`${p}uno mulai\` : Mulai bagikan kartu`,
    `• \`${p}uno play <id_kartu> [warna]\` : Buang kartu (Contoh: \`${p}uno play UNO-5\` atau \`${p}uno play UNO-12 merah\`)`,
    `• \`${p}uno draw\` : Ambil 1 kartu dari deck`,
    `• \`${p}uno pass\` : Lewati giliran setelah mengambil kartu`,
  ].join('\n'),

  cash_and_guns: (p) => [
    '🔫 *PANDUAN CASH & GUNS (BLUFFING HEIST)*',
    '',
    'Game gertakan perampokan & bagi jarahan Vela!',
    'Setiap pemain dibekali pistol berisi 5 peluru kosong (CLICK) dan 3 peluru asli (BANG).',
    '',
    '*Alur Permainan Per Ronde:*',
    `1. Buka lobi: \`${p}cng start\``,
    `2. Gabung: \`${p}cng join\` | Mulai: \`${p}cng mulai\``,
    `3. *Fase Bidik (via DM)*: Ketik \`aim @target click\` atau \`aim @target bang\` di chat pribadi bot`,
    `4. *Fase Nyali (di grup)*: Pilih \`${p}cng stand\` (bertahan) atau \`${p}cng duck\` (tiarap/menyerah)`,
    '',
    'Pemain yang terkena peluru BANG mendapat 1 luka (3 luka = gugur). Yang bertahan membagi jarahan!',
  ].join('\n'),

  ular_tangga: (p) => [
    '🎲 *PANDUAN ULAR TANGGA 100 PETAK*',
    '',
    'Berlomba mencapai petak 100 dengan lemparan dadu 1–6.',
    'Petak tangga membawamu naik, petak ular membuatmu merosot.',
    'Wajib tiba tepat di petak 100 (kelebihan langkah memantul mundur)!',
    '',
    '*Perintah:*',
    `• \`${p}ut start [taruhan]\` : Buka lobi permainan`,
    `• \`${p}ut join\` : Ikut bermain`,
    `• \`${p}ut mulai\` : Mulai permainan`,
    `• \`${p}ut roll\` (atau ketik \`kocok\` / \`roll\`) : Lempar dadu`,
    `• \`${p}ut board\` : Tampilkan posisi papan saat ini`,
  ].join('\n'),

  ludo: (p) => [
    '🔴 *PANDUAN LUDO KLASIK 4 WARNA*',
    '',
    'Kelilingi 52 petak jalur utama menuju Jalur Finish (Step 56).',
    '',
    '*Aturan Kunci:*',
    '• Butuh dadu angka 6 untuk mengeluarkan pion dari Base ke jalur utama.',
    '• Menimpa pion lawan = pion lawan dimakan dan kembali ke Base!',
    '• Petak berbintang adalah Petak Aman (Safe Tiles, pion kebal).',
    '• Dadu angka 6 memberikan bonus lemparan 1x lagi.',
    '',
    '*Perintah:*',
    `• \`${p}ludo start [taruhan]\` : Buka meja Ludo`,
    `• \`${p}ludo join\` : Ikut bermain`,
    `• \`${p}ludo mulai\` : Mulai permainan`,
    `• \`${p}ludo roll\` (atau ketik \`kocok\` / \`roll\`) : Lempar dadu`,
    `• \`${p}ludo pion <1-4>\` : Pilih pion yang akan digerakkan`,
  ].join('\n'),

  speed_monopoly: (p) => [
    '🏠 *PANDUAN SPEED MONOPOLY (16 PETAK CEPAT)*',
    '',
    'Monopoli cepat 16 petak keliling kota-kota Indonesia. Maksimal 15 putaran!',
    '',
    '*Kelompok Properti:*',
    '• 🟤 Brown : Medan Baru (100) & Malioboro (120)',
    '• 🔵 Cyan  : Braga (200) & Kuta Bali (220)',
    '• 🟡 Amber : Simpang Lima (300) & Tunjungan (320)',
    '• 🟢 Emerald: Sudirman (400) & Thamrin (450)',
    '',
    '*Perintah:*',
    `• \`${p}monopoli start [taruhan]\` : Buka meja Monopoli`,
    `• \`${p}monopoli join\` : Ikut bermain`,
    `• \`${p}monopoli mulai\` : Mulai permainan`,
    `• \`${p}monopoli roll\` (atau ketik \`kocok\` / \`roll\`) : Lempar dadu`,
    `• \`${p}monopoli buy\` (atau ketik \`beli\`) : Beli tanah yang diinjak`,
    `• \`${p}monopoli upgrade <petak>\` : Bangun rumah`,
    `• \`${p}monopoli skip\` : Lewati beli tanah`,
  ].join('\n'),
};

export function createArcadePlugin(
  whatsapp: WhatsAppPort,
  options: ArcadePluginOptions = {},
): Plugin {
  if (options.service) {
    sharedService = options.service;
  }

  const dispatchOutput = async (
    ctx: CommandContext | null,
    out: ArcadeDispatchOutput,
    activeWhatsapp: WhatsAppPort,
    fallbackChatJid: string,
  ): Promise<void> => {
    if (!out.handled || !out.result) return;
    const targetJid = out.groupJid ?? fallbackChatJid;
    const mentions = (out.result.mentions ?? []).filter((j) => j && !j.startsWith('bot:'));

    // 1. Deliver any private Direct Messages (e.g., Uno hands, LMS confirmations)
    if (Array.isArray(out.result.directMessages) && activeWhatsapp.sendText) {
      for (const dm of out.result.directMessages) {
        await activeWhatsapp.sendText(dm.recipientJid, dm.text).catch(() => undefined);
      }
    }

    // 2. Deliver group broadcast or error
    if (!out.result.success && out.result.error) {
      const errMsg = `❌ ${out.result.error}`;
      if (ctx) {
        await ctx.reply(errMsg);
      } else if (activeWhatsapp.sendText) {
        await activeWhatsapp.sendText(targetJid, errMsg);
      }
      return;
    }

    const caption = out.result.broadcastMessage || '🎮 Giliran diperbarui!';

    if (out.boardPng && activeWhatsapp.sendMedia) {
      await activeWhatsapp.sendMedia(targetJid, {
        kind: 'image',
        data: new Uint8Array(out.boardPng),
        mimeType: 'image/png',
        caption,
        mentions: mentions.length > 0 ? mentions : undefined,
      });
      return;
    }

    if (caption) {
      if (ctx) {
        await ctx.reply(caption, mentions.length > 0 ? { mentions } : undefined);
      } else if (activeWhatsapp.sendText) {
        await activeWhatsapp.sendText(targetJid, caption, mentions.length > 0 ? { mentions } : undefined);
      }
    }
  };


  const handleGameCommand = async (
    ctx: CommandContext,
    gameType: ArcadeGameType,
    activeWhatsapp: WhatsAppPort,
  ): Promise<void> => {
    const svc = getSharedService(options);
    const chatJid = ctx.message.remoteJid;
    const senderJid = ctx.message.senderJid ? normalizeWhatsAppUserJid(ctx.message.senderJid) : chatJid;
    const senderName = ctx.message.pushName || 'Player';
    const sub = ctx.args[0]?.toLowerCase() ?? '';

    // Check if session exists in this chat
    const session = svc.getActiveSession(chatJid);

    // 1. Leaderboard / Status
    if (sub === 'leaderboard' || sub === 'top' || sub === 'lb') {
      const top = svc.getLeaderboard(10);
      if (top.length === 0) {
        await ctx.reply('📊 Belum ada data pertandingan arcade yang tercatat.');
        return;
      }
      const lines = top.map((t, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
        return `${medal} *${t.displayName}* — Skor: ${t.totalScore} | Menang: ${t.totalWins}/${t.totalGames}`;
      });
      await ctx.reply(`🏆 *ARCADE LEADERBOARD TOP 10*\n\n${lines.join('\n')}`);
      return;
    }

    // 2. Cancel active game
    if (sub === 'cancel' || sub === 'batal' || sub === 'stop') {
      if (!session || session.gameType !== gameType) {
        await ctx.reply(`⚠️ Tidak ada game *${gameType}* yang sedang aktif di grup ini.`);
        return;
      }
      const cancelled = await svc.cancelSession(chatJid);
      if (cancelled) {
        await ctx.reply(`🛑 Sesi game *${gameType}* telah dibatalkan.`);
      }
      return;
    }

    // 3. Bare command (No args) OR Help command
    if (!sub || sub === 'help' || sub === 'bantuan' || sub === 'panduan') {
      // If there is an active session for this game, show board/status
      if (session && session.gameType === gameType) {
        await ctx.react('🎮');
        const boardPng = await renderArcadeGameStatePng(session.gameType, session.state);
        await dispatchOutput(
          ctx,
          {
            handled: true,
            groupJid: chatJid,
            gameType: session.gameType,
            boardPng,
            result: {
              success: true,
              state: session.state,
              broadcastMessage: `👉 Sesi *${session.gameType}* sedang aktif di grup ini.`,
            },
          },
          activeWhatsapp,
          chatJid,
        );
        return;
      }

      // No active game: Show curated guide!
      const guideFn = ARCADE_GAME_GUIDES[gameType];
      if (guideFn) {
        await ctx.reply(guideFn(ctx.prefix));
        return;
      }
    }

    // 4. Board / Papan inspection
    if (sub === 'board' || sub === 'papan' || sub === 'status') {
      if (!session || session.gameType !== gameType) {
        await ctx.reply(`⚠️ Tidak ada game *${gameType}* yang sedang aktif di grup ini.`);
        return;
      }
      await ctx.react('🎮');
      const boardPng = await renderArcadeGameStatePng(session.gameType, session.state);
      await dispatchOutput(
        ctx,
        {
          handled: true,
          groupJid: chatJid,
          gameType: session.gameType,
          boardPng,
          result: {
            success: true,
            state: session.state,
            broadcastMessage: `👉 Papan status *${session.gameType}* terkini.`,
          },
        },
        activeWhatsapp,
        chatJid,
      );
      return;
    }

    // 5. Start new game (explicit triggers)
    const isStartTrigger =
      sub === 'start' ||
      sub === 'mulai' ||
      sub === 'open' ||
      sub === 'buka' ||
      sub === 'deal' ||
      sub === 'main' ||
      sub === 'create' ||
      (gameType === 'tarot' && (sub === '1' || sub === '3' || sub === 'single' || sub === 'three' || sub === 'tarik' || sub === 'draw')) ||
      (gameType === 'wordle' && /^[a-z]{5}$/i.test(sub));

    if (!session) {
      if (!isStartTrigger) {
        const guideFn = ARCADE_GAME_GUIDES[gameType];
        await ctx.reply(
          `⚠️ Belum ada game *${gameType}* yang aktif di grup ini.\nKetik \`${ctx.prefix}${ctx.commandName} start\` untuk memulai, atau lihat panduan:\n\n${guideFn ? guideFn(ctx.prefix) : ''}`
        );
        return;
      }

      // Parse optional wager
      let wagerAmount = 0;
      for (const arg of ctx.args) {
        const n = Number(arg);
        if (Number.isFinite(n) && n > 0) {
          wagerAmount = Math.floor(n);
          break;
        }
      }

      // Custom config for Tarot
      let customConfig: Record<string, unknown> | undefined;
      if (gameType === 'tarot') {
        const count = sub === '3' || sub === 'three' ? 3 : 1;
        const qWords = ctx.args.slice(1).join(' ').trim();
        customConfig = { count, question: qWords || undefined };
      }

      await ctx.react('🎮');
      const out = await svc.startGame({
        groupJid: chatJid,
        gameType,
        hostJid: senderJid,
        hostName: senderName,
        wagerAmount,
        customConfig,
      });

      // If Wordle was started directly with a 5-letter guess word:
      if (gameType === 'wordle' && /^[a-z]{5}$/i.test(sub) && out.handled && svc.getActiveSession(chatJid)) {
        await dispatchOutput(ctx, out, activeWhatsapp, chatJid);
        const guessOut = await svc.dispatchAction({
          groupJid: chatJid,
          action: {
            type: 'GUESS',
            playerJid: senderJid,
            payload: { word: sub.toUpperCase(), playerName: senderName },
          },
        });
        await dispatchOutput(ctx, guessOut, activeWhatsapp, chatJid);
        return;
      }

      await dispatchOutput(ctx, out, activeWhatsapp, chatJid);
      return;
    }

    // 6. Game active: Join or Action
    if (sub === 'join' || sub === 'ikut') {
      const out = await svc.dispatchAction({
        groupJid: chatJid,
        action: {
          type: 'JOIN',
          playerJid: senderJid,
          payload: { playerName: senderName },
        },
      });
      await dispatchOutput(ctx, out, activeWhatsapp, chatJid);
      return;
    }

    if (sub === 'start' || sub === 'mulai') {
      const out = await svc.dispatchAction({
        groupJid: chatJid,
        action: {
          type: 'START',
          playerJid: senderJid,
        },
      });
      await dispatchOutput(ctx, out, activeWhatsapp, chatJid);
      return;
    }

    // Pass custom actions (e.g. `!uno play <card>`, `!bj hit`, `!ut roll`)
    const actionType = sub.toUpperCase();
    const out = await svc.dispatchAction({
      groupJid: chatJid,
      action: {
        type: actionType,
        playerJid: senderJid,
        payload: {
          playerName: senderName,
          choice: ctx.args[1],
          cardId: ctx.args[1],
          word: ctx.args[0],
        },
      },
    });
    await dispatchOutput(ctx, out, activeWhatsapp, chatJid);
  };

  return {
    name: 'arcade',
    async load(context: PluginContext) {
      const activeWhatsapp = whatsapp;

      // 1. Wordle
      context.commands.register({
        name: 'wordle',
        aliases: ['katla'],
        description: 'Tebak kata 5 huruf KBBI dalam 6 kesempatan (hijau/kuning/abu)',
        category: 'fun',
        menuOrder: 20,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'wordle', activeWhatsapp);
        },
      });

      // 2. Tarot
      context.commands.register({
        name: 'tarot',
        aliases: ['arcana'],
        description: 'Tarik 1 atau 3 kartu Tarot (78 Arcana) dengan ramalan mendalam',
        category: 'fun',
        menuOrder: 21,
        cooldownMs: 2000,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'tarot', activeWhatsapp);
        },
      });

      // 3. Hot Potato Bom
      context.commands.register({
        name: 'bom',
        aliases: ['hotpotato', 'kentang'],
        description: 'Estafet bom acak 30-75 detik (.pass @target) sebelum meledak',
        category: 'fun',
        menuOrder: 22,
        cooldownMs: 1000,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'hot_potato', activeWhatsapp);
        },
      });

      // 4. LMS Quiz
      context.commands.register({
        name: 'lms',
        aliases: ['kuislms', 'lastman'],
        description: 'Kuis eliminasi massal: jawab rahasia via DM, yang salah gugur',
        category: 'fun',
        menuOrder: 23,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'lms_quiz', activeWhatsapp);
        },
      });

      // 5. Blackjack
      context.commands.register({
        name: 'blackjack',
        aliases: ['bj', '21'],
        description: 'Mainkan Blackjack 21 kasino vs Dealer AI (hit, stand, double)',
        category: 'fun',
        menuOrder: 24,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'blackjack', activeWhatsapp);
        },
      });

      // 6. Uno
      context.commands.register({
        name: 'uno',
        aliases: ['kartuuno'],
        description: 'Mainkan Uno 108 kartu resmi (Draw 2, Skip, Reverse, Wild)',
        category: 'fun',
        menuOrder: 25,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'uno', activeWhatsapp);
        },
      });

      // 7. Cash & Guns
      context.commands.register({
        name: 'cashguns',
        aliases: ['cng'],
        description: 'Cash & Guns: bidik rahasia via DM, gertak bertahan/menyerah, bagi jarahan',
        category: 'fun',
        menuOrder: 26,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'cash_and_guns', activeWhatsapp);
        },
      });

      // 8. Ular Tangga
      context.commands.register({
        name: 'ulartangga',
        aliases: ['ut', 'snakes'],
        description: 'Ular Tangga 100 petak klasik (tangga naik, ular turun, tepat 100)',
        category: 'fun',
        menuOrder: 27,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'ular_tangga', activeWhatsapp);
        },
      });

      // 9. Ludo
      context.commands.register({
        name: 'ludo',
        aliases: ['ludoking'],
        description: 'Ludo 4 warna (keluar base angka 6, makan pion lawan, jalur finish)',
        category: 'fun',
        menuOrder: 28,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'ludo', activeWhatsapp);
        },
      });

      // 10. Speed Monopoly
      context.commands.register({
        name: 'monopoli',
        aliases: ['monopoly'],
        description: 'Speed Monopoly 16 petak cepat (beli tanah, sewa, kas, maks 15 ronde)',
        category: 'fun',
        menuOrder: 29,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'speed_monopoly', activeWhatsapp);
        },
      });

      // 11. Arcade Leaderboard
      context.commands.register({
        name: 'arcade',
        aliases: ['arcadelb', 'arcadestats'],
        description: 'Lihat leaderboard skor dan statistik 10 Minigames Arcade',
        category: 'fun',
        menuOrder: 30,
        cooldownMs: 2000,
        handler: async (ctx: CommandContext) => {
          const svc = getSharedService(options);
          const top = svc.getLeaderboard(10);
          if (top.length === 0) {
            await ctx.reply('📊 Belum ada data pertandingan arcade yang tercatat.');
            return;
          }
          const lines = top.map((t, idx) => {
            const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
            return `${medal} *${t.displayName}* — Skor: ${t.totalScore} | Menang: ${t.totalWins}/${t.totalGames}`;
          });
          await ctx.reply(`🏆 *ARCADE LEADERBOARD TOP 10*\n\n${lines.join('\n')}`);
        },
      });

      // Ambient chat & Secret DM Hook
      context.events.on('message.received', async (message: CoreMessage) => {
        if (message.fromMe || !message.text) return;
        const svc = getSharedService(options);
        const isDm = !message.remoteJid.endsWith('@g.us');
        const rawText = message.text.trim();

        // 1. Direct Message (DM) Secret Actions (LMS Quiz or Cash & Guns)
        if (isDm && message.senderJid) {
          const out = await svc.dispatchDirectMessageAction({
            senderJid: message.senderJid,
            text: rawText,
            mentionedJids: message.mentionedJids ? [...message.mentionedJids] : undefined,
          });
          if (out.handled) {
            await dispatchOutput(null, out, activeWhatsapp, message.remoteJid);
          }
          return;
        }

        // 2. In-Group Ambient Game Actions
        const session = svc.getActiveSession(message.remoteJid);
        if (!session) return;

        // Skip standard prefixed commands
        const prefix = context.config?.commandPrefix || '!';
        if (rawText.startsWith(prefix)) return;

        if (!isArcadeMoveOrDm(svc, { remoteJid: message.remoteJid, senderJid: message.senderJid, text: rawText })) {
          return;
        }

        const senderJid = message.senderJid ? normalizeWhatsAppUserJid(message.senderJid) : message.remoteJid;
        const senderName = message.pushName || 'Player';

        // Hot Potato `.pass @target`
        if (session.gameType === 'hot_potato' && /^\.pass\b/i.test(rawText)) {
          const targetRaw = message.mentionedJids?.[0];
          if (!targetRaw) return;
          const out = await svc.dispatchAction({
            groupJid: message.remoteJid,
            action: {
              type: 'PASS',
              playerJid: senderJid,
              payload: { targetJid: targetRaw, playerName: senderName },
            },
          });
          await dispatchOutput(null, out, activeWhatsapp, message.remoteJid);
          return;
        }

        // Wordle 5-letter guess
        if (session.gameType === 'wordle' && /^[A-Za-z]{5}$/.test(rawText)) {
          const out = await svc.dispatchAction({
            groupJid: message.remoteJid,
            action: {
              type: 'GUESS',
              playerJid: senderJid,
              payload: { word: rawText, playerName: senderName },
            },
          });
          await dispatchOutput(null, out, activeWhatsapp, message.remoteJid);
          return;
        }

        // Blackjack hit / stand / double
        if (session.gameType === 'blackjack' && /^(hit|stand|double)$/i.test(rawText)) {
          const out = await svc.dispatchAction({
            groupJid: message.remoteJid,
            action: {
              type: rawText.toUpperCase() as any,
              playerJid: senderJid,
              payload: { playerName: senderName },
            },
          });
          await dispatchOutput(null, out, activeWhatsapp, message.remoteJid);
          return;
        }

        // Board games roll / buy / skip
        if (
          (session.gameType === 'ular_tangga' ||
            session.gameType === 'ludo' ||
            session.gameType === 'speed_monopoly') &&
          /^(roll|kocok|lempar|buy|beli|skip|lewat)$/i.test(rawText)
        ) {
          let actionType = 'ROLL';
          if (/^(buy|beli)$/i.test(rawText)) actionType = 'BUY';
          if (/^(skip|lewat)$/i.test(rawText)) actionType = 'SKIP_BUY';

          const out = await svc.dispatchAction({
            groupJid: message.remoteJid,
            action: {
              type: actionType,
              playerJid: senderJid,
              payload: { playerName: senderName },
            },
          });
          await dispatchOutput(null, out, activeWhatsapp, message.remoteJid);
        }
      });
    },
  };
}
