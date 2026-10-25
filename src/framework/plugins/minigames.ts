/**
 * @file minigames.ts
 * @description Allybot Plugin for the Minigames Suite (Connect 4, Tic-Tac-Toe, Dam/Checkers 8x8).
 * Registers commands:
 *   - !connect4 (aliases: !c4, !fourinrow)
 *   - !tictactoe (aliases: !ttt, !xo)
 *   - !dam (aliases: !checkers, !draughts)
 *
 * Hooks `message.received` for seamless direct reply moves (`1-7`, `1-9`/`a1-c3`, `c3 d4`)
 * and exports `isMinigameMoveOrReply` to prevent AI Chlona interception.
 */

import type {
  CommandContext,
  CoreMessage,
  Plugin,
  PluginContext,
  WhatsAppPort,
} from '../contracts.js';
import {
  MinigamesService,
  type MinigameType,
  type BotDifficulty,
  type MinigameActionResponse,
  normalizeUserJid,
  getGameDisplayName,
} from '../../services/minigames/index.js';

export interface MinigamesPluginOptions {
  service?: MinigamesService;
  dbPath?: string;
  whatsapp?: WhatsAppPort;
}

function parseBotDifficultyArg(tokens: readonly string[]): BotDifficulty {
  for (const t of tokens) {
    const n = Number(t.replace(/^lv/i, ''));
    if (n === 1 || n === 2 || n === 3) return n;
  }
  return 2;
}

export function createMinigamesPlugin(
  whatsapp: WhatsAppPort,
  options: MinigamesPluginOptions = {},
): Plugin {
  let service: MinigamesService | null = options.service ?? null;

  const ensureService = (): MinigamesService => {
    if (!service) {
      service = new MinigamesService({ dbPath: options.dbPath });
    }
    return service;
  };

  const dispatchAction = async (
    ctx: CommandContext,
    res: MinigameActionResponse,
    activeWhatsapp: WhatsAppPort,
  ): Promise<void> => {
    const chatJid = ctx.message.remoteJid;
    const mentions = (res.mentions ?? []).filter((j) => j && !j.startsWith('bot:'));

    if (res.boardPng && activeWhatsapp.sendMedia) {
      await activeWhatsapp.sendMedia(chatJid, {
        kind: 'image',
        data: new Uint8Array(res.boardPng),
        mimeType: 'image/png',
        caption: res.message,
        mentions: mentions.length > 0 ? mentions : undefined,
      });
      return;
    }

    await ctx.reply(res.message, mentions.length > 0 ? { mentions } : undefined);
  };

  const handleGameCommand = async (
    ctx: CommandContext,
    gameType: MinigameType,
    activeWhatsapp: WhatsAppPort,
  ): Promise<void> => {
    const svc = ensureService();
    const chatJid = ctx.message.remoteJid;
    const senderJid = ctx.message.senderJid ? normalizeUserJid(ctx.message.senderJid) : chatJid;
    const senderName = ctx.message.pushName || 'Player';
    const sub = ctx.args[0]?.toLowerCase() ?? '';
    const gameLabel = getGameDisplayName(gameType);
    const cmdAlias = gameType === 'connect4' ? 'c4' : gameType === 'tictactoe' ? 'ttt' : 'dam';

    // 1. No subcommand: Show active board or help guide
    if (!sub) {
      const active = svc.getActiveSession(chatJid);
      if (active && active.gameType === gameType) {
        await ctx.react('🎮');
        const boardPng = await svc.renderSessionBoardPng(active, activeWhatsapp);
        const nextJid = active.state.turn === 1 ? active.p1Jid : active.p2Jid;
        await dispatchAction(
          ctx,
          {
            ok: true,
            boardPng,
            mentions: [nextJid],
            message: `👉 Giliran @${nextJid.split('@')[0]}.`,
          },
          activeWhatsapp,
        );
        return;
      }

      const instructions =
        gameType === 'connect4'
          ? `• Langkah: ketik angka kolom \`1-7\`\n• Pemenang: susun 4 koin berurutan (horizontal/vertikal/diagonal)`
          : gameType === 'tictactoe'
            ? `• Langkah: ketik angka \`1-9\` atau \`a1-c3\`\n• Pemenang: susun 3 simbol berurutan`
            : `• Langkah: ketik asal & tujuan (\`c3 d4\` atau \`c3 e5 g7\`)\n• Aturan: Wajib Makan & Promosi Raja`;

      await ctx.reply(
        [
          `*Panduan Game ${gameLabel} Allybot*`,
          '',
          `• Tantang teman: \`${ctx.prefix}${cmdAlias} @lawan\``,
          `• Buka lobi grup: \`${ctx.prefix}${cmdAlias} open\` | Gabung: \`${ctx.prefix}${cmdAlias} join\``,
          `• Lawan bot: \`${ctx.prefix}${cmdAlias} bot [1-3]\``,
          `• Lihat papan: \`${ctx.prefix}${cmdAlias} board\``,
          `• Batalkan: \`${ctx.prefix}${cmdAlias} cancel\``,
          `• Menyerah / Remis: \`${ctx.prefix}${cmdAlias} menyerah\` | \`${ctx.prefix}${cmdAlias} remis\``,
          '',
          instructions,
        ].join('\n'),
      );
      return;
    }

    // 2. Subcommand: open
    if (sub === 'open' || sub === 'buka') {
      const res = svc.createChallenge({
        chatJid,
        gameType,
        challengerJid: senderJid,
        challengerName: senderName,
        opponentJid: null,
      });
      await dispatchAction(ctx, res, activeWhatsapp);
      return;
    }

    // 3. Subcommand: join / terima / gabung
    if (sub === 'join' || sub === 'terima' || sub === 'gabung') {
      const res = await svc.acceptChallenge({
        chatJid,
        accepterJid: senderJid,
        accepterName: senderName,
        whatsapp: activeWhatsapp,
      });
      if (res.ok) await ctx.react('🎮');
      await dispatchAction(ctx, res, activeWhatsapp);
      return;
    }

    // 4. Subcommand: bot [1|2|3]
    if (sub === 'bot' || sub === 'ai') {
      const difficulty = parseBotDifficultyArg(ctx.args.slice(1));
      const res = await svc.startBotMatch({
        chatJid,
        gameType,
        playerJid: senderJid,
        playerName: senderName,
        difficulty,
        whatsapp: activeWhatsapp,
      });
      if (res.ok) await ctx.react('🤖');
      await dispatchAction(ctx, res, activeWhatsapp);
      return;
    }

    // 5. Subcommand: resign / menyerah / nyerah
    if (sub === 'resign' || sub === 'menyerah' || sub === 'nyerah') {
      const res = await svc.resignMatch(chatJid, senderJid);
      await dispatchAction(ctx, res, activeWhatsapp);
      return;
    }

    // 6. Subcommand: draw / remis / seri
    if (sub === 'draw' || sub === 'remis' || sub === 'seri') {
      const res = await svc.offerOrAcceptDraw(chatJid, senderJid);
      await dispatchAction(ctx, res, activeWhatsapp);
      return;
    }

    // 7. Subcommand: cancel / batal / abort
    if (sub === 'cancel' || sub === 'batal' || sub === 'abort') {
      const res = svc.cancelChallengeOrAbort(chatJid, senderJid);
      await dispatchAction(ctx, res, activeWhatsapp);
      return;
    }

    // 8. Subcommand: board / papan
    if (sub === 'board' || sub === 'papan') {
      const active = svc.getActiveSession(chatJid);
      if (!active || active.gameType !== gameType) {
        await ctx.reply(`⚠️ Tidak ada game ${gameLabel} yang sedang berlangsung di obrolan ini.`);
        return;
      }
      const boardPng = await svc.renderSessionBoardPng(active, activeWhatsapp);
      const nextJid = active.state.turn === 1 ? active.p1Jid : active.p2Jid;
      await dispatchAction(
        ctx,
        {
          ok: true,
          boardPng,
          mentions: [nextJid],
          message: `👉 Giliran @${nextJid.split('@')[0]}.`,
        },
        activeWhatsapp,
      );
      return;
    }

    // 9. Mention challenge: !c4 @user
    const targetRaw = ctx.message.mentionedJids?.[0] || ctx.message.quotedSenderJid;
    if (sub.startsWith('@') || targetRaw) {
      if (!targetRaw) {
        await ctx.reply(`Tag lawan yang ingin kamu tantang. Contoh: \`${ctx.prefix}${cmdAlias} @lawan\``);
        return;
      }
      const opponentJid = normalizeUserJid(targetRaw);
      const res = svc.createChallenge({
        chatJid,
        gameType,
        challengerJid: senderJid,
        challengerName: senderName,
        opponentJid,
      });
      await dispatchAction(ctx, res, activeWhatsapp);
      return;
    }

    // 10. Direct move via command (e.g. `!c4 4`, `!ttt 5`, `!dam c3 d4`)
    const active = svc.getActiveSession(chatJid);
    if (active && active.gameType === gameType) {
      const rawMove = ctx.args.join(' ').trim();
      const res = await svc.submitMove({
        chatJid,
        senderJid,
        rawMove,
        whatsapp: activeWhatsapp,
      });
      await dispatchAction(ctx, res, activeWhatsapp);
      return;
    }

    await ctx.reply(
      `⚠️ Perintah tidak dikenali. Ketik \`${ctx.prefix}${cmdAlias}\` tanpa argumen untuk panduan.`,
    );
  };

  return {
    name: 'minigames',
    version: '1.0.0',
    load(context: PluginContext) {
      const activeWhatsapp = whatsapp;
      let svc = service;
      if (!svc && context.services?.has?.('minigames')) {
        try {
          svc = context.services.get<MinigamesService>('minigames');
        } catch {
          svc = ensureService();
        }
      } else if (!svc) {
        svc = ensureService();
      }
      svc.start();

      context.commands.register({
        name: 'connect4',
        aliases: ['c4', 'fourinrow'],
        description: 'Mainkan Connect 4 (7x6) PvP atau lawan AI Bot',
        category: 'fun',
        menuOrder: 10,
        cooldownMs: 1000,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'connect4', activeWhatsapp);
        },
      });

      context.commands.register({
        name: 'tictactoe',
        aliases: ['ttt', 'xo'],
        description: 'Mainkan Tic-Tac-Toe (3x3) PvP atau lawan AI Bot',
        category: 'fun',
        menuOrder: 11,
        cooldownMs: 1000,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'tictactoe', activeWhatsapp);
        },
      });

      context.commands.register({
        name: 'dam',
        aliases: ['checkers', 'draughts'],
        description: 'Mainkan Dam / Checkers 8x8 (Wajib Makan & Multi-Jump)',
        category: 'fun',
        menuOrder: 12,
        cooldownMs: 1000,
        handler: async (ctx: CommandContext) => {
          await handleGameCommand(ctx, 'checkers', activeWhatsapp);
        },
      });

      // Hook ambient chat listener for natural move typing (e.g. typing "4", "5", "c3 d4")
      context.events.on('message.received', async (message: CoreMessage) => {
        if (message.fromMe || !message.senderJid || !message.text) return;
        const chatJid = message.remoteJid;
        const senderJid = normalizeUserJid(message.senderJid);
        const rawText = message.text.trim();

        if (
          !svc.isMinigameMoveOrReply({
            chatJid,
            senderJid,
            text: rawText,
            quotedMessageId: message.quotedMessageId,
          })
        ) {
          return;
        }

        const res = await svc.submitMove({
          chatJid,
          senderJid,
          rawMove: rawText,
          whatsapp: activeWhatsapp,
        });

        const mentions = (res.mentions ?? []).filter((j) => j && !j.startsWith('bot:'));
        if (res.boardPng && activeWhatsapp.sendMedia) {
          await activeWhatsapp.sendMedia(chatJid, {
            kind: 'image',
            data: new Uint8Array(res.boardPng),
            mimeType: 'image/png',
            caption: res.message,
            mentions: mentions.length > 0 ? mentions : undefined,
          });
        } else if (res.message) {
          await activeWhatsapp.sendText(chatJid, res.message, mentions.length > 0 ? { mentions } : undefined);
        }
      });
    },

    unload() {
      if (service) {
        service.stop();
      }
    },
  };
}

export default createMinigamesPlugin;
