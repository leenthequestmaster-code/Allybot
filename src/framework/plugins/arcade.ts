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

  if (session.gameType === 'wordle' && /^[A-Za-z]{5}$/.test(text)) {
    return true;
  }
  if (session.gameType === 'blackjack' && /^(hit|stand|double)$/i.test(text)) {
    return true;
  }
  if (session.gameType === 'ludo' && /^(roll|kocok|lempar)$/i.test(text)) {
    return true;
  }

  return false;
}

export const ARCADE_GAME_GUIDES: Partial<Record<ArcadeGameType, (prefix: string) => string>> = {
  wordle: (p) => [
    '🟩 *WORDLE INDONESIA (KBBI)*',
    '',
    'Tebak kata rahasia 5 huruf baku dalam 6 kesempatan.',
    '',
    '• 🟩 *Hijau* : Huruf & posisi tepat',
    '• 🟨 *Kuning*: Huruf ada, posisi salah',
    '• ⬛ *Abu*   : Huruf tidak ada',
    '',
    '*Perintah:*',
    `• \`${p}wordle start\` — Mulai kata baru`,
    `• \`${p}wordle <kata>\` — Tebak kata (atau ketik langsung 5 huruf)`,
    `• \`${p}wordle board\` — Lihat papan tebakan`,
    `• \`${p}wordle cancel\` — Batalkan sesi`,
  ].join('\n'),

  lms_quiz: (p) => [
    '🧠 *LAST MAN STANDING (LMS QUIZ)*',
    '',
    'Kuis eliminasi massal. Soal di grup, jawab RAHASIA di DM bot.',
    '',
    '*Cara Main:*',
    `1. Buka kuis: \`${p}lms start\``,
    `2. Gabung: \`${p}lms join\``,
    `3. Mulai: \`${p}lms mulai\``,
    `4. Jawab di DM bot: ketik \`A\`, \`B\`, \`C\`, atau \`D\` di chat pribadi bot`,
    '',
    'Jawaban salah atau telat = langsung gugur.',
  ].join('\n'),

  blackjack: (p) => [
    '🃏 *BLACKJACK 21 (VS DEALER AI)*',
    '',
    'Dekati angka 21 tanpa lewat (Bust). Dealer hit s/d 17.',
    '',
    '*Cara Main:*',
    `1. Buka meja: \`${p}bj start\``,
    `2. Gabung meja: \`${p}bj join\``,
    `3. Mulai deal: \`${p}bj deal\``,
    '',
    '*Aksi Saat Giliranmu:*',
    `• \`${p}bj hit\` (atau ketik \`hit\`) — Ambil 1 kartu`,
    `• \`${p}bj stand\` (atau ketik \`stand\`) — Tahan kartu`,
    `• \`${p}bj double\` (atau ketik \`double\`) — Gandakan poin & ambil 1 kartu terakhir`,
  ].join('\n'),

  uno: (p) => [
    '🎴 *KARTU UNO (108 KARTU)*',
    '',
    'Buang kartu yang cocok warna atau angka dengan kartu meja.',
    'Kartu tangan dikirim rahasia via DM oleh bot.',
    '',
    '*Perintah:*',
    `• \`${p}uno start\` — Buka meja Uno`,
    `• \`${p}uno join\` — Ikut main | \`${p}uno mulai\` — Bagikan kartu`,
    `• \`${p}uno play <id> [warna]\` — Buang kartu (contoh: \`${p}uno play UNO-5\`)`,
    `• \`${p}uno draw\` — Ambil kartu dari deck`,
    `• \`${p}uno pass\` — Lewati giliran`,
  ].join('\n'),

  cash_and_guns: (p) => [
    '🔫 *CASH & GUNS (BLUFFING HEIST)*',
    '',
    'Game gertakan nodong & rebut jarahan.',
    'Pistol berisi 5 peluru kosong (CLICK) dan 3 peluru asli (BANG).',
    '',
    '*Ronde:*',
    `1. Lobi: \`${p}cng start\` | Gabung: \`${p}cng join\` | Mulai: \`${p}cng mulai\``,
    `2. *Fase Bidik (di DM)*: ketik \`aim @target click\` atau \`aim @target bang\``,
    `3. *Fase Nyali (di grup)*: pilih \`${p}cng stand\` (tahan) atau \`${p}cng duck\` (tiarap)`,
    '',
    'Kena 3 peluru BANG = gugur. Yang bertahan membagi jarahan.',
  ].join('\n'),

  ludo: (p) => [
    '🔴 *LUDO KLASIK 4 WARNA*',
    '',
    'Kelilingi 52 petak jalur utama menuju Finish (Step 56).',
    'Dadu 6 untuk keluar Base. Makan pion lawan untuk kirim balik ke Base.',
    '',
    '*Perintah:*',
    `• \`${p}ludo start\` — Buka meja | \`${p}ludo join\` — Gabung | \`${p}ludo mulai\` — Mulai`,
    `• \`${p}ludo roll\` (atau ketik \`kocok\` / \`roll\`) — Lempar dadu`,
    `• \`${p}ludo pion <1-4>\` — Gerakkan pion`,
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

      // Pure arcade: zero wager
      const wagerAmount = 0;

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

      // 2. LMS Quiz
      context.commands.register({
        name: 'lms',
        aliases: ['kuislms', 'lastman'],
        description: 'Kuis eliminasi massal: jawab rahasia via DM, yang salah gugur',
        category: 'fun',
        menuOrder: 21,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'lms_quiz', activeWhatsapp);
        },
      });

      // 3. Blackjack
      context.commands.register({
        name: 'blackjack',
        aliases: ['bj', '21'],
        description: 'Mainkan Blackjack 21 kasino vs Dealer AI (hit, stand, double)',
        category: 'fun',
        menuOrder: 22,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'blackjack', activeWhatsapp);
        },
      });

      // 4. Uno
      context.commands.register({
        name: 'uno',
        aliases: ['kartuuno'],
        description: 'Mainkan Uno 108 kartu resmi (Draw 2, Skip, Reverse, Wild)',
        category: 'fun',
        menuOrder: 23,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'uno', activeWhatsapp);
        },
      });

      // 5. Cash & Guns
      context.commands.register({
        name: 'cashguns',
        aliases: ['cng'],
        description: 'Cash & Guns: bidik rahasia via DM, gertak bertahan/menyerah, bagi jarahan',
        category: 'fun',
        menuOrder: 24,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'cash_and_guns', activeWhatsapp);
        },
      });

      // 6. Ludo
      context.commands.register({
        name: 'ludo',
        aliases: ['ludoking'],
        description: 'Ludo 4 warna (keluar base angka 6, makan pion lawan, jalur finish)',
        category: 'fun',
        menuOrder: 25,
        cooldownMs: 1500,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'ludo', activeWhatsapp);
        },
      });

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
