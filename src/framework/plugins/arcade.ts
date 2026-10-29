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

    // 3. No active game: Start new game
    if (!session) {
      // Parse optional wager
      let wagerAmount = 0;
      for (const arg of ctx.args) {
        const n = Number(arg);
        if (Number.isFinite(n) && n > 0) {
          wagerAmount = Math.floor(n);
          break;
        }
      }

      await ctx.react('🎮');
      const out = await svc.startGame({
        groupJid: chatJid,
        gameType,
        hostJid: senderJid,
        hostName: senderName,
        wagerAmount,
      });

      await dispatchOutput(ctx, out, activeWhatsapp, chatJid);
      return;
    }

    // 4. Game active: Join or Action
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
