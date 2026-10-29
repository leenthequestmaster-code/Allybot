// ============================================================================
// ALLYBOT 10-MINIGAME ARCADE VISUAL RENDERER (SATORI + RESVG + SHARP)
// Renders clean, high-contrast 1:1 / 4:3 PNG boards & HUD cards for all 10 games
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { Canvas, loadImage, type Image } from 'skia-canvas';
import type { WhatsAppPort } from '../../framework/contracts.js';
import type {
  HotPotatoState,
  LmsQuizState,
  TarotState,
  WordleState,
} from './arcade-engines.js';
import {
  type BlackjackState,
  type CashGunsState,
  type UnoState,
  evaluateBlackjackHand,
} from './arcade-engines.js';
import {
  type LudoState,
  type SnakesAndLaddersState,
  type SpeedMonopolyState,
  SPEED_MONOPOLY_BOARD_16,
} from './arcade-engines.js';

let cachedRegularFont: Buffer | null = null;
let cachedBoldFont: Buffer | null = null;

const REGULAR_FONT_PATHS = [
  path.join(process.cwd(), 'assets', 'fonts', 'Inter.ttf'),
  path.join(process.cwd(), 'assets', 'fonts', 'Inter-Regular.ttf'),
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
];

const BOLD_FONT_PATHS = [
  path.join(process.cwd(), 'assets', 'fonts', 'Inter-Bold.ttf'),
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
];

function loadFontBuffer(paths: string[]): Buffer {
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p);
    }
  }
  throw new Error('Font file not found');
}

function getSatoriFonts(): Array<{
  name: string;
  data: Buffer;
  weight: 400 | 700;
  style: 'normal';
}> {
  if (!cachedRegularFont) cachedRegularFont = loadFontBuffer(REGULAR_FONT_PATHS);
  if (!cachedBoldFont) cachedBoldFont = loadFontBuffer(BOLD_FONT_PATHS);

  return [
    { name: 'Inter', data: cachedRegularFont, weight: 400, style: 'normal' },
    { name: 'Inter', data: cachedBoldFont, weight: 700, style: 'normal' },
  ];
}

async function renderTreeToPng(tree: any, width: number, height: number): Promise<Buffer> {
  const fonts = getSatoriFonts();
  const svg = await satori(tree, { width, height, fonts });
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: width } });
  const rawPng = Buffer.from(resvg.render().asPng());
  return await sharp(rawPng).png().toBuffer();
}

// ============================================================================
// 1. WORDLE 6x5 GRID + KEYBOARD RENDERER
// ============================================================================

export async function renderWordlePng(state: WordleState): Promise<Buffer> {
  const rows: any[] = [];
  for (let r = 0; r < state.maxAttempts; r++) {
    const attempt = state.attempts[r];
    const cells: any[] = [];
    for (let c = 0; c < 5; c++) {
      const cell = attempt?.cells[c];
      const bg =
        cell?.status === 'correct'
          ? '#538d4e'
          : cell?.status === 'present'
            ? '#b59f3b'
            : cell
              ? '#3a3a3c'
              : '#121213';
      const border = cell ? `2px solid ${bg}` : '2px solid #3a3a3c';
      cells.push({
        type: 'div',
        props: {
          style: {
            width: '68px',
            height: '68px',
            backgroundColor: bg,
            border,
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '32px',
            fontWeight: 700,
            color: '#ffffff',
          },
          children: cell ? cell.letter : '',
        },
      });
    }
    rows.push({
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'row', gap: '10px' },
        children: cells,
      },
    });
  }

  const kbRows = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
  const kbNodes = kbRows.map((rowStr) => ({
    type: 'div',
    props: {
      style: { display: 'flex', flexDirection: 'row', gap: '6px', justifyContent: 'center' },
      children: rowStr.split('').map((ch) => {
        const st = state.keyboardStatus[ch];
        const bg =
          st === 'correct'
            ? '#538d4e'
            : st === 'present'
              ? '#b59f3b'
              : st === 'absent'
                ? '#272729'
                : '#818384';
        return {
          type: 'div',
          props: {
            style: {
              width: '38px',
              height: '44px',
              backgroundColor: bg,
              borderRadius: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '16px',
              fontWeight: 700,
              color: '#ffffff',
            },
            children: ch,
          },
        };
      }),
    },
  }));

  const statusText =
    state.status === 'won'
      ? `TERPECAHKAN: ${state.targetWord}`
      : state.status === 'lost'
        ? `JAWABAN: ${state.targetWord}`
        : `PERCOBAAN ${state.attempts.length}/${state.maxAttempts}`;

  const tree = {
    type: 'div',
    props: {
      style: {
        width: '600px',
        height: '760px',
        backgroundColor: '#121213',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontFamily: 'Inter',
        color: '#ffffff',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              width: '552px',
              height: '56px',
              backgroundColor: '#1e1e20',
              borderRadius: '10px',
              padding: '0 18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            },
            children: [
              {
                type: 'span',
                props: {
                  style: { fontSize: '22px', fontWeight: 700, color: '#ffffff' },
                  children: 'WORDLE INDONESIA',
                },
              },
              {
                type: 'span',
                props: {
                  style: { fontSize: '15px', fontWeight: 700, color: '#a3d160' },
                  children: statusText,
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'center' },
            children: rows,
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'center' },
            children: kbNodes,
          },
        },
      ],
    },
  };

  return await renderTreeToPng(tree, 600, 760);
}

// ============================================================================
// 2. TAROT ARCANA SPREAD RENDERER (1 OR 3 CARDS)
// ============================================================================

export async function renderTarotPng(state: TarotState): Promise<Buffer> {
  const cardBoxes = state.drawnCards.map((item) => {
    const isUpright = item.orientation === 'tegak';
    return {
      type: 'div',
      props: {
        style: {
          width: state.drawnCards.length === 1 ? '440px' : '240px',
          height: '380px',
          backgroundColor: '#1b162a',
          border: `2px solid ${isUpright ? '#eab308' : '#a855f7'}`,
          borderRadius: '12px',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        },
        children: [
          {
            type: 'div',
            props: {
              style: { display: 'flex', flexDirection: 'column', gap: '6px' },
              children: [
                {
                  type: 'span',
                  props: {
                    style: { fontSize: '13px', fontWeight: 700, color: '#facc15' },
                    children: item.positionLabel.toUpperCase(),
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: { fontSize: '18px', fontWeight: 700, color: '#ffffff' },
                    children: item.card.nameId.slice(0, 28),
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: {
                      fontSize: '12px',
                      fontWeight: 700,
                      color: isUpright ? '#4ade80' : '#f472b6',
                    },
                    children: isUpright ? 'POSISI TEGAK (UPRIGHT)' : 'POSISI TERBALIK (REVERSED)',
                  },
                },
              ],
            },
          },
          {
            type: 'div',
            props: {
              style: {
                padding: '12px',
                backgroundColor: '#110d1d',
                borderRadius: '8px',
                display: 'flex',
                flexDirection: 'column',
                gap: '6px',
              },
              children: [
                {
                  type: 'span',
                  props: {
                    style: { fontSize: '12px', fontWeight: 700, color: '#c084fc' },
                    children: item.card.keywords.join(' • '),
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: { fontSize: '13px', color: '#e2e8f0' },
                    children: item.activeMeaning.slice(0, 120),
                  },
                },
              ],
            },
          },
          {
            type: 'span',
            props: {
              style: { fontSize: '12px', fontWeight: 700, color: '#94a3b8' },
              children: `${item.card.code} • ${item.card.suit.toUpperCase()}`,
            },
          },
        ],
      },
    };
  });

  const tree = {
    type: 'div',
    props: {
      style: {
        width: '800px',
        height: '520px',
        backgroundColor: '#0f0b1a',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontFamily: 'Inter',
        color: '#ffffff',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              width: '752px',
              height: '58px',
              backgroundColor: '#1b162a',
              borderRadius: '10px',
              padding: '0 20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              border: '1px solid #4c1d95',
            },
            children: [
              {
                type: 'span',
                props: {
                  style: { fontSize: '20px', fontWeight: 700, color: '#facc15' },
                  children: 'TAROT ARCANA — ALLYBOT',
                },
              },
              {
                type: 'span',
                props: {
                  style: { fontSize: '14px', fontWeight: 700, color: '#cbd5e1' },
                  children: `Penanya: ${state.host.name.slice(0, 20)}`,
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'row',
              gap: '16px',
              justifyContent: 'center',
              alignItems: 'center',
            },
            children: cardBoxes,
          },
        },
      ],
    },
  };

  return await renderTreeToPng(tree, 800, 520);
}

// ============================================================================
// 8. ULAR TANGGA 100-SQUARE BOARD RENDERER
// ============================================================================

export async function renderSnakesAndLaddersPng(state: SnakesAndLaddersState): Promise<Buffer> {
  const tokenPalette = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#a855f7', '#ec4899'];
  const squareCells: any[] = [];

  for (let row = 0; row < 10; row++) {
    const rankFromBottom = 9 - row; // 9 down to 0
    for (let col = 0; col < 10; col++) {
      const isLeftToRight = rankFromBottom % 2 === 0;
      const sqNum = rankFromBottom * 10 + (isLeftToRight ? col + 1 : 10 - col);
      const isLadderStart = state.ladders[sqNum] !== undefined;
      const isSnakeStart = state.snakes[sqNum] !== undefined;

      const bg =
        sqNum === 100
          ? '#eab308'
          : isLadderStart
            ? '#14532d'
            : isSnakeStart
              ? '#7f1d1d'
              : (row + col) % 2 === 0
                ? '#262421'
                : '#1f1e1b';

      const occupants = state.players
        .map((p, idx) => ({ p, idx }))
        .filter(({ p }) => state.positions[p.jid] === sqNum);

      const children: any[] = [
        {
          type: 'span',
          props: {
            style: {
              position: 'absolute',
              top: '4px',
              left: '5px',
              fontSize: '12px',
              fontWeight: 700,
              color: sqNum === 100 ? '#111827' : '#9ca3af',
            },
            children: String(sqNum),
          },
        },
      ];

      if (isLadderStart) {
        children.push({
          type: 'span',
          props: {
            style: {
              position: 'absolute',
              bottom: '4px',
              right: '4px',
              fontSize: '11px',
              fontWeight: 700,
              color: '#4ade80',
            },
            children: `+${state.ladders[sqNum]}`,
          },
        });
      } else if (isSnakeStart) {
        children.push({
          type: 'span',
          props: {
            style: {
              position: 'absolute',
              bottom: '4px',
              right: '4px',
              fontSize: '11px',
              fontWeight: 700,
              color: '#f87171',
            },
            children: `->${state.snakes[sqNum]}`,
          },
        });
      }

      if (occupants.length > 0) {
        children.push({
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'row', gap: '3px' },
            children: occupants.slice(0, 3).map(({ p, idx }) => ({
              type: 'div',
              props: {
                style: {
                  width: '22px',
                  height: '22px',
                  borderRadius: '11px',
                  backgroundColor: tokenPalette[idx % tokenPalette.length],
                  border: '2px solid #ffffff',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '11px',
                  fontWeight: 700,
                  color: '#ffffff',
                },
                children: (p.name[0] || 'P').toUpperCase(),
              },
            })),
          },
        });
      }

      squareCells.push({
        type: 'div',
        props: {
          style: {
            width: '64px',
            height: '64px',
            backgroundColor: bg,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            position: 'relative',
          },
          children,
        },
      });
    }
  }

  const activePlayer = state.players[state.currentTurnIndex];

  const tree = {
    type: 'div',
    props: {
      style: {
        width: '688px',
        height: '760px',
        backgroundColor: '#18181b',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontFamily: 'Inter',
        color: '#ffffff',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              width: '640px',
              height: '56px',
              backgroundColor: '#27272a',
              borderRadius: '8px',
              padding: '0 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            },
            children: [
              {
                type: 'span',
                props: {
                  style: { fontSize: '18px', fontWeight: 700, color: '#facc15' },
                  children: 'ULAR TANGGA 100 PETAK',
                },
              },
              {
                type: 'span',
                props: {
                  style: { fontSize: '14px', fontWeight: 700, color: '#4ade80' },
                  children: state.winnerJid
                    ? `Pemenang: ${state.players.find((p) => p.jid === state.winnerJid)?.name ?? ''}`
                    : `Giliran: ${activePlayer?.name ?? '-'} (Petak ${state.positions[activePlayer?.jid ?? ''] ?? 0})`,
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              width: '640px',
              height: '640px',
              display: 'flex',
              flexDirection: 'row',
              flexWrap: 'wrap',
              borderRadius: '8px',
              overflow: 'hidden',
            },
            children: squareCells,
          },
        },
      ],
    },
  };

  return await renderTreeToPng(tree, 688, 760);
}

// ============================================================================
// 10. SPEED MONOPOLY 16-TILE BOARD RENDERER
// ============================================================================

export async function renderSpeedMonopolyPng(state: SpeedMonopolyState): Promise<Buffer> {
  const groupColors: Record<string, string> = {
    BROWN: '#92400e',
    CYAN: '#0284c7',
    AMBER: '#d97706',
    EMERALD: '#059669',
  };

  const tileCards = SPEED_MONOPOLY_BOARD_16.map((tile) => {
    const owner = state.properties[tile.index];
    const ownerObj = owner ? state.players.find((p) => p.jid === owner.ownerJid) : undefined;
    const occupants = state.players.filter((p) => !p.isEliminated && state.positions[p.jid] === tile.index);
    const barColor = tile.group ? groupColors[tile.group] : '#475569';

    return {
      type: 'div',
      props: {
        style: {
          width: '150px',
          height: '115px',
          backgroundColor: '#1e293b',
          border: '2px solid #334155',
          borderRadius: '8px',
          padding: '8px',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
        },
        children: [
          {
            type: 'div',
            props: {
              style: {
                width: '130px',
                height: '20px',
                backgroundColor: barColor,
                borderRadius: '4px',
                padding: '0 6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              },
              children: [
                {
                  type: 'span',
                  props: {
                    style: { fontSize: '11px', fontWeight: 700, color: '#ffffff' },
                    children: `#${tile.index}`,
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: { fontSize: '11px', fontWeight: 700, color: '#ffffff' },
                    children: tile.price ? `$${tile.price}` : tile.kind,
                  },
                },
              ],
            },
          },
          {
            type: 'span',
            props: {
              style: { fontSize: '13px', fontWeight: 700, color: '#f8fafc' },
              children: tile.name.slice(0, 18),
            },
          },
          {
            type: 'div',
            props: {
              style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
              children: [
                {
                  type: 'span',
                  props: {
                    style: { fontSize: '11px', fontWeight: 700, color: ownerObj ? '#4ade80' : '#94a3b8' },
                    children: ownerObj
                      ? `${ownerObj.name.slice(0, 8)} (${owner.houses}H)`
                      : 'Kosong',
                  },
                },
                {
                  type: 'span',
                  props: {
                    style: { fontSize: '11px', fontWeight: 700, color: '#facc15' },
                    children: occupants.map((o) => `[${(o.name[0] || 'P').toUpperCase()}]`).join(''),
                  },
                },
              ],
            },
          },
        ],
      },
    };
  });

  const activePlayer = state.players[state.currentTurnIndex];

  const tree = {
    type: 'div',
    props: {
      style: {
        width: '688px',
        height: '640px',
        backgroundColor: '#0f172a',
        padding: '20px 24px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontFamily: 'Inter',
        color: '#ffffff',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              width: '640px',
              height: '54px',
              backgroundColor: '#1e293b',
              borderRadius: '8px',
              padding: '0 16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            },
            children: [
              {
                type: 'span',
                props: {
                  style: { fontSize: '18px', fontWeight: 700, color: '#38bdf8' },
                  children: `SPEED MONOPOLY (PUTARAN ${state.round}/${state.maxRounds})`,
                },
              },
              {
                type: 'span',
                props: {
                  style: { fontSize: '14px', fontWeight: 700, color: '#4ade80' },
                  children: `Giliran: ${activePlayer?.name ?? '-'} ($${state.cash[activePlayer?.jid ?? ''] ?? 0})`,
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: {
              width: '640px',
              height: '510px',
              display: 'flex',
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: '12px',
              justifyContent: 'center',
            },
            children: tileCards,
          },
        },
      ],
    },
  };

  return await renderTreeToPng(tree, 688, 640);
}

// ============================================================================
// GENERIC HIGH-CONTRAST STATUS CARD FOR PARTY / CARD / LUDO GAMES
// ============================================================================

export 
// ============================================================================
// CASH & GUNS IMMERSIVE SKIA-CANVAS RENDERER (NATIVE ASSETS + AVATAR PP WA)
// ============================================================================

const avatarCache = new Map<string, { img: Image | null; expiresAt: number }>();

export async function getPlayerAvatarImage(
  whatsapp: WhatsAppPort | undefined,
  jid: string,
): Promise<Image | null> {
  if (!jid || jid.startsWith('bot:')) return null;
  const now = Date.now();
  const cached = avatarCache.get(jid);
  if (cached && cached.expiresAt > now) {
    return cached.img;
  }

  if (!whatsapp?.getProfilePictureUrl) {
    avatarCache.set(jid, { img: null, expiresAt: now + 15 * 60 * 1000 });
    return null;
  }

  try {
    const url = await whatsapp.getProfilePictureUrl(jid, 'preview', 3000);
    if (!url) {
      avatarCache.set(jid, { img: null, expiresAt: now + 15 * 60 * 1000 });
      return null;
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      avatarCache.set(jid, { img: null, expiresAt: now + 15 * 60 * 1000 });
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const img = await loadImage(buf);
    avatarCache.set(jid, { img, expiresAt: now + 30 * 60 * 1000 });
    return img;
  } catch {
    avatarCache.set(jid, { img: null, expiresAt: now + 15 * 60 * 1000 });
    return null;
  }
}

let cachedHeistAssets: {
  bg: Image;
  gun: Image;
  cash: Image;
  diamond: Image;
  wound: Image;
  click: Image;
  bang: Image;
} | null = null;

async function loadHeistAssets(): Promise<typeof cachedHeistAssets> {
  if (cachedHeistAssets) return cachedHeistAssets;

  const baseCandidates = [
    path.join(process.cwd(), 'assets', 'games', 'cashguns'),
    path.join(process.cwd(), 'dist', 'assets', 'games', 'cashguns'),
  ];
  let assetDir = '';
  for (const d of baseCandidates) {
    if (fs.existsSync(path.join(d, 'gun.png'))) {
      assetDir = d;
      break;
    }
  }

  if (!assetDir) return null;

  try {
    const [bg, gun, cash, diamond, wound, click, bang] = await Promise.all([
      loadImage(path.join(assetDir, 'tabletop.jpg')),
      loadImage(path.join(assetDir, 'gun.png')),
      loadImage(path.join(assetDir, 'cash.png')),
      loadImage(path.join(assetDir, 'diamond.png')),
      loadImage(path.join(assetDir, 'wound_token.png')),
      loadImage(path.join(assetDir, 'card_click.png')),
      loadImage(path.join(assetDir, 'card_bang.png')),
    ]);
    cachedHeistAssets = { bg, gun, cash, diamond, wound, click, bang };
    return cachedHeistAssets;
  } catch {
    return null;
  }
}

export async function renderCashGunsSkiaPng(
  state: CashGunsState,
  whatsapp?: WhatsAppPort,
): Promise<Buffer> {
  const assets = await loadHeistAssets();
  if (!assets) {
    // Fallback to summary card if assets missing
    return await renderArcadeSummaryCardPng({
      title: 'CASH & GUNS',
      subtitle: `Ronde ${state.round}/${state.maxRounds} • Pot $${state.currentLootPot.toLocaleString('en-US')}`,
      rows: state.players.map((p) => ({
        left: `${p.name} (Luka: ${p.wounds ?? 0}/3)`,
        right: p.isEliminated ? 'Gugur' : `$${(p.score ?? 0).toLocaleString('en-US')}`,
        highlight: !p.isEliminated,
      })),
      footer: `Fase: ${state.status.toUpperCase()}`,
    });
  }

  const width = 1200;
  const height = 896;
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext('2d');

  // Background
  ctx.drawImage(assets.bg, 0, 0, width, height);
  const vignette = ctx.createRadialGradient(width / 2, height / 2, 280, width / 2, height / 2, 680);
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, width, height);

  // Header Banner
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(40, 22, width - 80, 52, 8);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#eab308';
  ctx.stroke();

  ctx.font = 'bold 20px sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText("🔫 CA$H 'N GUNS — MEJA PERAMPOKAN", 65, 48);

  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.fillText('(Kapasitas: Min 2 — Maks 8 Pemain)', 480, 48);

  ctx.textAlign = 'right';
  ctx.font = 'bold 15px sans-serif';
  ctx.fillStyle = '#facc15';
  ctx.fillText(`RONDE ${state.round} / ${state.maxRounds} • FASE ${state.status.toUpperCase()}`, width - 65, 48);
  ctx.restore();

  // Center Loot Vault
  const cx = width / 2;
  const cy = height / 2 - 10;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetY = 10;
  ctx.beginPath();
  ctx.roundRect(cx - 200, cy - 130, 400, 260, 14);
  ctx.fillStyle = 'rgba(20, 20, 24, 0.85)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(212, 175, 55, 0.5)';
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.font = 'bold 14px sans-serif';
  ctx.fillStyle = '#facc15';
  ctx.textAlign = 'center';
  ctx.letterSpacing = '1.5px';
  ctx.fillText(`JARAHAN BRANKAS: $${state.currentLootPot.toLocaleString('en-US')}`, cx, cy - 100);
  ctx.restore();

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 6;
  ctx.drawImage(assets.cash, cx - 145, cy - 85, 220, 220);
  ctx.restore();

  ctx.save();
  ctx.shadowColor = 'rgba(56, 189, 248, 0.7)';
  ctx.shadowBlur = 16;
  ctx.drawImage(assets.diamond, cx + 50, cy - 35, 120, 120);
  ctx.restore();

  // Helper Heart
  function drawHeart(hx: number, hy: number, size: number, isAlive = true) {
    ctx.save();
    ctx.translate(hx, hy);
    const s = size / 30;
    ctx.scale(s, s);

    ctx.beginPath();
    ctx.moveTo(0, 8);
    ctx.bezierCurveTo(0, 0, -15, -8, -15, 8);
    ctx.bezierCurveTo(-15, 18, 0, 26, 0, 32);
    ctx.bezierCurveTo(0, 26, 15, 18, 15, 8);
    ctx.bezierCurveTo(15, -8, 0, 0, 0, 8);
    ctx.closePath();

    if (isAlive) {
      ctx.fillStyle = '#ef4444';
      ctx.shadowColor = 'rgba(239, 68, 68, 0.6)';
      ctx.shadowBlur = 6;
      ctx.fill();
    } else {
      ctx.fillStyle = '#27272a';
      ctx.fill();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = '#52525b';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-4, 4);
      ctx.lineTo(2, 14);
      ctx.lineTo(-2, 22);
      ctx.lineTo(3, 30);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#ef4444';
      ctx.stroke();
    }
    ctx.restore();
  }

  // Helper Avatar with WhatsApp PP support
  function drawAvatarPP(x: number, y: number, radius: number, name: string, ppImg: Image | null, isGodfather = false) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.beginPath();
    ctx.arc(x, y, radius + 3, 0, Math.PI * 2);
    ctx.fillStyle = isGodfather ? '#f59e0b' : '#38bdf8';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.clip();

    if (ppImg) {
      ctx.drawImage(ppImg, x - radius, y - radius, radius * 2, radius * 2);
    } else {
      const grad = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
      grad.addColorStop(0, '#0284c7');
      grad.addColorStop(1, '#0f172a');
      ctx.fillStyle = grad;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);

      ctx.font = `bold ${Math.round(radius * 0.95)}px sans-serif`;
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name.slice(0, 1).toUpperCase(), x, y + 2);
    }
    ctx.restore();

    if (isGodfather) {
      ctx.save();
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('👑', x, y - radius - 2);
      ctx.restore();
    }
  }

  // Helper Gun with collinear alignment & grip flip
  function drawAlignedGunAndLaser(pivotX: number, pivotY: number, targetX: number, targetY: number, isDucking = false) {
    if (isDucking) {
      ctx.save();
      ctx.translate(pivotX, pivotY);
      ctx.rotate(Math.PI / 2);
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 8;
      const gW = 105;
      const scale = gW / 804;
      ctx.drawImage(assets!.gun, -180 * scale, -108 * scale, gW, 578 * scale);
      ctx.restore();
      return;
    }

    const dx = targetX - pivotX;
    const dy = targetY - pivotY;
    const angle = Math.atan2(dy, dx);

    const gW = 125;
    const scale = gW / 804;
    const muzzleDist = (804 - 180) * scale;
    const muzzleWorldX = pivotX + muzzleDist * Math.cos(angle);
    const muzzleWorldY = pivotY + muzzleDist * Math.sin(angle);

    ctx.save();
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.9)';
    ctx.shadowColor = '#ef4444';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(muzzleWorldX, muzzleWorldY);
    ctx.lineTo(targetX, targetY);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(targetX, targetY, 8, 0, Math.PI * 2);
    ctx.fillStyle = '#ef4444';
    ctx.fill();
    ctx.restore();

    const isAimingLeft = Math.abs(angle) > Math.PI / 2;
    ctx.save();
    ctx.translate(pivotX, pivotY);
    ctx.rotate(angle);
    if (isAimingLeft) {
      ctx.scale(1, -1);
    }
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;
    ctx.drawImage(assets!.gun, -180 * scale, -108 * scale, gW, 578 * scale);
    ctx.restore();
  }

  // Pre-fetch player avatars
  const avatarImgs = new Map<string, Image | null>();
  await Promise.all(
    state.players.map(async (p) => {
      const img = await getPlayerAvatarImage(whatsapp, p.jid);
      avatarImgs.set(p.jid, img);
    }),
  );

  // 8 Player Positions Map (Clean perimeter)
  const layout8 = [
    { x: 50, y: 95, gunPivot: { x: 395, y: 150 }, isLeft: true },
    { x: 810, y: 95, gunPivot: { x: 775, y: 200 }, isLeft: false },
    { x: 50, y: 635, gunPivot: { x: 395, y: 690 }, isLeft: true },
    { x: 810, y: 635, gunPivot: { x: 775, y: 690 }, isLeft: false },
    { x: 50, y: 275, gunPivot: { x: 395, y: 330 }, isLeft: true },
    { x: 810, y: 275, gunPivot: { x: 775, y: 330 }, isLeft: false },
    { x: 50, y: 455, gunPivot: { x: 395, y: 510 }, isLeft: true },
    { x: 810, y: 455, gunPivot: { x: 775, y: 510 }, isLeft: false },
  ];

  const cardW = 340;
  const cardH = 155;

  // Station mapping
  const activeStations = state.players.map((p, idx) => {
    const pos = layout8[idx % layout8.length];
    const isGodfather = p.jid === state.hostJid;
    const aim = state.pendingAims[p.jid];
    const stance = state.courageDecisions[p.jid] || 'PENDING';
    return {
      player: p,
      isGodfather,
      aim,
      stance,
      x: pos.x,
      y: pos.y,
      gunPivot: pos.gunPivot,
      avatarPos: { x: pos.x + 46, y: pos.y + 55 },
    };
  });

  // Draw Aiming Guns First
  for (const st of activeStations) {
    if (st.aim?.targetJid && st.stance !== 'DUCK') {
      const targetSt = activeStations.find((s) => s.player.jid === st.aim!.targetJid);
      if (targetSt) {
        drawAlignedGunAndLaser(st.gunPivot.x, st.gunPivot.y, targetSt.avatarPos.x, targetSt.avatarPos.y, false);
      }
    } else {
      drawAlignedGunAndLaser(st.gunPivot.x, st.gunPivot.y, st.gunPivot.x, st.gunPivot.y, true);
    }
  }

  // Draw Station Cards
  for (const st of activeStations) {
    const p = st.player;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 6;
    ctx.beginPath();
    ctx.roundRect(st.x, st.y, cardW, cardH, 12);
    ctx.fillStyle = 'rgba(24, 24, 27, 0.94)';
    ctx.fill();
    ctx.lineWidth = st.isGodfather ? 2.5 : 1.5;
    ctx.strokeStyle = st.isGodfather ? '#facc15' : '#52525b';
    ctx.stroke();
    ctx.restore();

    // 1. Avatar PP WA
    const avImg = avatarImgs.get(p.jid) || null;
    drawAvatarPP(st.avatarPos.x, st.avatarPos.y, 30, p.name, avImg, st.isGodfather);

    // 2. Info
    const infoX = st.x + 92;
    ctx.font = 'bold 17px sans-serif';
    ctx.fillStyle = st.isGodfather ? '#facc15' : '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(p.name, infoX, st.y + 32);

    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = st.isGodfather ? '#fde047' : '#a1a1aa';
    ctx.fillText(st.isGodfather ? 'THE GODFATHER' : 'PERAMPOK', infoX, st.y + 50);

    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = '#4ade80';
    ctx.fillText(`Loot: $${(p.score ?? 0).toLocaleString('en-US')}`, infoX, st.y + 76);

    // Hearts
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = '#a1a1aa';
    ctx.fillText('Nyawa:', infoX, st.y + 104);
    const maxLives = 3;
    const remainingLives = Math.max(0, maxLives - (p.wounds ?? 0));
    for (let l = 0; l < maxLives; l++) {
      const hx = infoX + 54 + l * 25;
      const hy = st.y + 92;
      drawHeart(hx, hy, 18, l < remainingLives);
    }

    // Stance
    const isStand = st.stance === 'STAND';
    const isDuck = st.stance === 'DUCK';
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(infoX, st.y + 118, 140, 26, 4);
    ctx.fillStyle = isStand ? '#14532d' : isDuck ? '#713f12' : '#27272a';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = isStand ? '#4ade80' : isDuck ? '#facc15' : '#52525b';
    ctx.stroke();

    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(isStand ? '🛡️ STAND (TAHAN)' : isDuck ? '🪖 DUCK (TIARAP)' : '⏳ MENUNGGU NYALI', infoX + 70, st.y + 131);
    ctx.restore();

    // 3. Bullet Card Inset Slot
    const slotX = st.x + cardW - 95;
    const slotY = st.y + 14;
    const slotW = 80;
    const slotH = 126;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(slotX, slotY, slotW, slotH, 6);
    ctx.fillStyle = '#111318';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#3f3f46';
    ctx.stroke();

    ctx.font = 'bold 9px sans-serif';
    ctx.fillStyle = '#71717a';
    ctx.textAlign = 'center';
    ctx.fillText('AMUNISI', slotX + slotW / 2, slotY + 12);

    const cardPad = 4;
    const cInX = slotX + cardPad;
    const cInY = slotY + 18;
    const cInW = slotW - cardPad * 2;
    const cInH = slotH - 22;

    const isRevealed = state.status === 'finished' || (state.status as string) === 'resolved';

    if (!isRevealed || !st.aim?.bullet) {
      ctx.beginPath();
      ctx.roundRect(cInX, cInY, cInW, cInH, 4);
      ctx.fillStyle = '#1e1b4b';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#4338ca';
      ctx.stroke();
      ctx.font = 'bold 18px sans-serif';
      ctx.fillStyle = '#818cf8';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🔒', cInX + cInW / 2, cInY + cInH / 2);
    } else if (st.aim.bullet === 'BANG') {
      ctx.beginPath();
      ctx.roundRect(cInX, cInY, cInW, cInH, 4);
      ctx.clip();
      ctx.drawImage(assets!.bang, cInX, cInY, cInW, cInH);
    } else {
      ctx.beginPath();
      ctx.roundRect(cInX, cInY, cInW, cInH, 4);
      ctx.clip();
      ctx.drawImage(assets!.click, cInX, cInY, cInW, cInH);
    }
    ctx.restore();
  }

  // Bottom Directive
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(40, height - 68, width - 80, 46, 8);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#ef4444';
  ctx.stroke();
  ctx.font = 'bold 15px sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚡ PILIH NYALI DI GRUP: Ketik !cng stand (tahan) atau !cng duck (tiarap) sebelum waktu habis!', width / 2, height - 45);
  ctx.restore();

  return await canvas.toBuffer('png');
}


// ============================================================================
// BLACKJACK 21 IMMERSIVE SKIA-CANVAS RENDERER (CASINO FELT TABLE)
// ============================================================================

export async function renderBlackjackSkiaPng(
  state: BlackjackState,
  whatsapp?: WhatsAppPort,
): Promise<Buffer> {
  const width = 840;
  const height = 560;
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext('2d');

  // Deep matte casino felt green
  const felt = ctx.createRadialGradient(420, 240, 40, 420, 280, 480);
  felt.addColorStop(0, '#0e522c');
  felt.addColorStop(0.7, '#093e20');
  felt.addColorStop(1, '#052914');
  ctx.fillStyle = felt;
  ctx.fillRect(0, 0, width, height);

  // Mahogany wood rail
  ctx.lineWidth = 14;
  ctx.strokeStyle = '#1a0d06';
  ctx.strokeRect(7, 7, width - 14, height - 14);

  // Gold felt line
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(212, 175, 55, 0.4)';
  ctx.strokeRect(20, 20, width - 40, height - 40);

  // Printed felt rules
  ctx.save();
  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.textAlign = 'center';
  ctx.letterSpacing = '2px';
  ctx.fillText('BLACKJACK PAYS 3 TO 2', 420, 185);
  ctx.font = '11px sans-serif';
  ctx.fillText('Dealer must draw to 16 and stand on all 17s', 420, 205);
  ctx.restore();

  // Helper Playing Card
  function drawPlayingCard(x: number, y: number, rank: string, suit: string, isFaceDown = false) {
    const w = 70;
    const h = 100;

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 3;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 6);
    ctx.clip();

    if (isFaceDown) {
      ctx.fillStyle = '#991b1b';
      ctx.fillRect(x, y, w, h);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
      for (let d = -h; d < w + h; d += 8) {
        ctx.beginPath();
        ctx.moveTo(x + d, y);
        ctx.lineTo(x + d - h, y + h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + d, y);
        ctx.lineTo(x + d + h, y + h);
        ctx.stroke();
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(x + 5, y + 5, w - 10, h - 10);
      ctx.restore();
      return;
    }

    ctx.lineWidth = 1;
    ctx.strokeStyle = '#d1d5db';
    ctx.stroke();

    const isRed = suit === '♥' || suit === '♦';
    const color = isRed ? '#b91c1c' : '#111827';

    ctx.fillStyle = color;
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(rank, x + 6, y + 18);
    ctx.font = '13px sans-serif';
    ctx.fillText(suit, x + 7, y + 32);

    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(suit, x + w / 2, y + h / 2 + 10);

    ctx.save();
    ctx.translate(x + w - 6, y + h - 6);
    ctx.rotate(Math.PI);
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(rank, 0, 0);
    ctx.font = '13px sans-serif';
    ctx.fillText(suit, 1, 14);
    ctx.restore();

    ctx.restore();
  }

  // Dealer Section
  ctx.save();
  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = '#e5e7eb';
  ctx.textAlign = 'center';
  const dealerEval = evaluateBlackjackHand(state.dealerCards);
  const dealerTotal = state.dealerHoleRevealed ? String(dealerEval.total) : '?';
  ctx.fillText(`DEALER (Total: ${dealerTotal})`, 420, 50);

  const startDx = 420 - (state.dealerCards.length * 28);
  for (let i = 0; i < state.dealerCards.length; i++) {
    const c = state.dealerCards[i];
    const isHidden = !state.dealerHoleRevealed && i === 1;
    drawPlayingCard(startDx + i * 36, 62, c.rank, c.suit, isHidden);
  }
  ctx.restore();

  // Players Layout (Arc betting circles)
  const seatCount = state.seats.length;
  const seatPositions = [
    { x: 420, y: 390 }, // Center
    { x: 220, y: 360 }, // Left 1
    { x: 620, y: 360 }, // Right 1
    { x: 90,  y: 330 }, // Left 2
    { x: 750, y: 330 }, // Right 2
  ];

  for (let idx = 0; idx < seatCount; idx++) {
    const seat = state.seats[idx];
    const pos = seatPositions[idx % seatPositions.length];
    const h = evaluateBlackjackHand(seat.cards);
    const isCurrent = state.status === 'player_turns' && idx === state.activeSeatIndex;

    // Betting circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 44, 0, Math.PI * 2);
    ctx.lineWidth = isCurrent ? 3 : 2;
    ctx.strokeStyle = isCurrent ? '#facc15' : 'rgba(212, 175, 55, 0.5)';
    ctx.stroke();

    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = isCurrent ? '#facc15' : 'rgba(255, 255, 255, 0.4)';
    ctx.textAlign = 'center';
    ctx.fillText(h.isBlackjack ? 'BJ' : String(h.total), pos.x, pos.y + 4);
    ctx.restore();

    // Cards
    const startCx = pos.x - 35 - ((seat.cards.length - 1) * 15);
    for (let cIdx = 0; cIdx < seat.cards.length; cIdx++) {
      const c = seat.cards[cIdx];
      drawPlayingCard(startCx + cIdx * 28, pos.y - 70, c.rank, c.suit);
    }

    // Name & Status
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = isCurrent ? '#facc15' : '#ffffff';
    ctx.textAlign = 'center';
    const tag = isCurrent ? `👉 ${seat.player.name}` : seat.player.name;
    ctx.fillText(tag, pos.x, pos.y + 60);

    const statusBadge =
      state.status === 'finished'
        ? seat.outcome.toUpperCase()
        : seat.status.toUpperCase();
    ctx.font = '11px sans-serif';
    ctx.fillStyle = seat.outcome === 'win' || seat.outcome === 'blackjack_3_2' ? '#4ade80' : seat.outcome === 'bust' || seat.outcome === 'lose' ? '#f87171' : '#9ca3af';
    ctx.fillText(`${statusBadge} [Poin: ${seat.bet}]`, pos.x, pos.y + 76);
  }

  return await canvas.toBuffer('png');
}

// ============================================================================
// UNO 108 KARTU IMMERSIVE SKIA-CANVAS RENDERER (OFFICIAL TABLETOPS)
// ============================================================================

export async function renderUnoSkiaPng(
  state: UnoState,
  whatsapp?: WhatsAppPort,
): Promise<Buffer> {
  const width = 840;
  const height = 560;
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext('2d');

  // Matte Tabletop
  ctx.fillStyle = '#1e222b';
  ctx.fillRect(0, 0, width, height);

  ctx.lineWidth = 1;
  ctx.strokeStyle = '#333d4f';
  ctx.strokeRect(16, 16, width - 32, height - 32);

  const colors: Record<string, string> = {
    red: '#d7263d',
    yellow: '#e5a914',
    green: '#268c5b',
    blue: '#1d71b8',
    wild: '#0f172a',
  };

  function drawUnoCard(x: number, y: number, colorKey: string, value: string, tilt = 0, isFaceDown = false, scale = 1) {
    const w = 78 * scale;
    const h = 118 * scale;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);

    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 8 * scale;
    ctx.shadowOffsetY = 4 * scale;

    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 8 * scale);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(tilt);
    ctx.beginPath();
    ctx.roundRect(-w / 2, -h / 2, w, h, 8 * scale);
    ctx.clip();

    if (isFaceDown) {
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.save();
      ctx.rotate(-0.35);
      ctx.beginPath();
      ctx.ellipse(0, 0, 30 * scale, 18 * scale, 0, 0, Math.PI * 2);
      ctx.fillStyle = '#d7263d';
      ctx.fill();
      ctx.font = `italic bold ${15 * scale}px sans-serif`;
      ctx.fillStyle = '#facc15';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('UNO', 0, 2);
      ctx.restore();
      ctx.restore();
      return;
    }

    const cHex = colors[colorKey] || '#1d71b8';
    const m = 5 * scale;
    ctx.beginPath();
    ctx.roundRect(-w / 2 + m, -h / 2 + m, w - m * 2, h - m * 2, 6 * scale);
    ctx.fillStyle = cHex;
    ctx.fill();

    ctx.save();
    ctx.rotate(-0.35);
    ctx.beginPath();
    ctx.ellipse(0, 0, 28 * scale, 18 * scale, 0, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.fillStyle = cHex;
    ctx.font = `bold ${24 * scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(value, 0, 2);
    ctx.restore();

    ctx.font = `bold ${12 * scale}px sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(value, -w / 2 + 8 * scale, -h / 2 + 8 * scale);

    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(value, w / 2 - 8 * scale, h / 2 - 8 * scale);

    ctx.restore();
  }

  // Draw Pile (Stacked)
  drawUnoCard(360, 260, 'wild', '', 0.04, true);
  drawUnoCard(362, 258, 'wild', '', -0.02, true);
  drawUnoCard(364, 256, 'wild', '', 0, true);

  // Discard Pile (Top card)
  const top = state.discardPile[state.discardPile.length - 1];
  if (top) {
    const valLabel = top.value.startsWith('wild') ? (top.value === 'wild_draw4' ? '+4' : 'W') : top.value.toUpperCase();
    drawUnoCard(470, 256, top.color, valLabel, -0.08);
  }

  // Active Table Color Chip
  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  ctx.fillText('WARNA MEJA', 470, 350);

  ctx.beginPath();
  ctx.roundRect(420, 362, 100, 26, 4);
  ctx.fillStyle = colors[state.activeColor] || '#1d71b8';
  ctx.fill();
  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(state.activeColor.toUpperCase(), 470, 379);

  // Header Bar
  ctx.font = 'bold 16px sans-serif';
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'left';
  ctx.fillText('🎴 UNO 108 KARTU RESMI', 36, 48);

  ctx.font = '13px sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'right';
  ctx.fillText(`Putaran: ${state.direction === 1 ? '↻ Searah Jarum Jam' : '↺ Berlawanan Arah'}`, 804, 48);

  // Players Around the Table
  const pCount = state.players.length;
  const pLayouts = [
    { x: 300, y: 430, isTurn: 0 },
    { x: 50,  y: 220, isTurn: 1 },
    { x: 420, y: 90,  isTurn: 2 },
    { x: 670, y: 220, isTurn: 3 },
  ];

  for (let i = 0; i < pCount; i++) {
    const p = state.players[i];
    const isTurn = state.status === 'playing' && i === state.currentTurnIndex;
    const cardCount = (state.hands[p.jid] ?? []).length;
    const pos = pLayouts[i % pLayouts.length];

    ctx.save();
    if (i === 0) {
      // Bottom Player (Host / First viewer)
      ctx.beginPath();
      ctx.roundRect(pos.x, pos.y, 240, 80, 8);
      ctx.fillStyle = '#0f172a';
      ctx.fill();
      ctx.lineWidth = isTurn ? 2 : 1;
      ctx.strokeStyle = isTurn ? '#38bdf8' : '#334155';
      ctx.stroke();

      ctx.font = 'bold 14px sans-serif';
      ctx.fillStyle = isTurn ? '#38bdf8' : '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(`${isTurn ? '👉 ' : ''}${p.name}`, pos.x + 18, pos.y + 28);

      ctx.font = '12px sans-serif';
      ctx.fillStyle = '#e2e8f0';
      ctx.fillText(`${cardCount} Kartu di tangan (Cek DM)`, pos.x + 18, pos.y + 54);
    } else {
      ctx.font = isTurn ? 'bold 14px sans-serif' : '13px sans-serif';
      ctx.fillStyle = isTurn ? '#38bdf8' : '#e2e8f0';
      ctx.textAlign = i === 2 ? 'center' : i === 1 ? 'left' : 'left';
      ctx.fillText(`${isTurn ? '👉 ' : ''}${p.name} (${cardCount} kartu${cardCount === 1 ? ' • UNO!' : ''})`, pos.x, pos.y);
    }
    ctx.restore();
  }

  return await canvas.toBuffer('png');
}

// ============================================================================
// LAST MAN STANDING (LMS QUIZ) IMMERSIVE SKIA-CANVAS RENDERER
// ============================================================================

export async function renderLmsQuizSkiaPng(
  state: LmsQuizState,
  whatsapp?: WhatsAppPort,
): Promise<Buffer> {
  const width = 840;
  const height = 560;
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext('2d');

  // Deep matte ink background
  ctx.fillStyle = '#0c1017';
  ctx.fillRect(0, 0, width, height);

  ctx.lineWidth = 1;
  ctx.strokeStyle = '#1e293b';
  ctx.strokeRect(16, 16, width - 32, height - 32);

  // Header Bar
  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.letterSpacing = '1.5px';
  ctx.textAlign = 'left';
  ctx.fillText('LAST MAN STANDING QUIZ', 40, 48);

  const aliveCount = state.players.filter((p) => !p.isEliminated).length;
  ctx.textAlign = 'right';
  ctx.fillStyle = '#f59e0b';
  ctx.fillText(`RONDE ${state.round} • ${aliveCount} PESERTA TERSISA`, 800, 48);

  const q = state.currentQuestion;

  // Question Card
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(40, 70, 760, 140, 8);
  ctx.fillStyle = '#161e2e';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#283548';
  ctx.stroke();

  ctx.font = 'bold 11px sans-serif';
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'left';
  ctx.fillText(`KATEGORI: ${(q?.category ?? 'UMUM').toUpperCase()}`, 65, 102);

  ctx.font = 'bold 17px sans-serif';
  ctx.fillStyle = '#f8fafc';
  const promptText = q ? q.prompt : 'Menunggu pertanyaan ronde berikutnya...';
  // Break prompt text if long
  if (promptText.length > 60) {
    ctx.fillText(promptText.slice(0, 58) + '...', 65, 136);
    ctx.fillText(promptText.slice(58, 120), 65, 164);
  } else {
    ctx.fillText(promptText, 65, 145);
  }
  ctx.restore();

  // 4 Option Blocks (2x2 Grid)
  const options = q
    ? [
        { key: 'A', text: q.options.A, x: 40, y: 230 },
        { key: 'B', text: q.options.B, x: 430, y: 230 },
        { key: 'C', text: q.options.C, x: 40, y: 310 },
        { key: 'D', text: q.options.D, x: 430, y: 310 },
      ]
    : [];

  for (const opt of options) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(opt.x, opt.y, 370, 64, 6);
    ctx.fillStyle = '#161e2e';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#283548';
    ctx.stroke();

    ctx.beginPath();
    ctx.roundRect(opt.x + 14, opt.y + 14, 36, 36, 4);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#38bdf8';
    ctx.stroke();

    ctx.font = 'bold 15px sans-serif';
    ctx.fillStyle = '#38bdf8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opt.key, opt.x + 32, opt.y + 32);

    ctx.font = 'bold 14px sans-serif';
    ctx.fillStyle = '#f1f5f9';
    ctx.textAlign = 'left';
    ctx.fillText(opt.text.slice(0, 36), opt.x + 64, opt.y + 32);
    ctx.restore();
  }

  // Participant Survival Tray (Bottom)
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(40, 395, 760, 80, 8);
  ctx.fillStyle = '#111827';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#1f2937';
  ctx.stroke();

  ctx.font = 'bold 11px sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'left';
  ctx.fillText('STATUS PESERTA:', 60, 420);

  let pX = 60;
  for (const p of state.players.slice(0, 4)) {
    const isAnswered = state.secretAnswers[p.jid] !== undefined;
    const statusText = p.isEliminated ? 'Gugur' : isAnswered ? 'Terkunci' : 'Menunggu';
    const colorHex = p.isEliminated ? '#ef4444' : isAnswered ? '#22c55e' : '#f59e0b';

    ctx.font = p.isEliminated ? '13px sans-serif' : 'bold 13px sans-serif';
    ctx.fillStyle = p.isEliminated ? '#6b7280' : '#e5e7eb';
    ctx.fillText(p.name, pX, 448);

    ctx.font = '11px sans-serif';
    ctx.fillStyle = colorHex;
    ctx.fillText(statusText, pX, 464);

    pX += 175;
  }
  ctx.restore();

  // Clean Footer
  ctx.font = '12px sans-serif';
  ctx.fillStyle = '#94a3b8';
  ctx.textAlign = 'center';
  ctx.fillText('🔒 JAWAB RAHASIA VIA DM BOT: Ketik A, B, C, atau D di chat pribadi bot!', 420, 510);

  return await canvas.toBuffer('png');
}

// ============================================================================
// LUDO 4 WARNA IMMERSIVE SKIA-CANVAS RENDERER (15x15 GEOMETRIC BOARD)
// ============================================================================

export async function renderLudoSkiaPng(
  state: LudoState,
  whatsapp?: WhatsAppPort,
): Promise<Buffer> {
  const width = 660;
  const height = 660;
  const canvas = new Canvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, width, height);

  const ox = 30;
  const oy = 30;
  const cellSize = 40;
  const boardSize = 600;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(ox, oy, boardSize, boardSize);

  const colors: Record<string, string> = {
    RED: '#dc2626',
    GREEN: '#16a34a',
    YELLOW: '#eab308',
    BLUE: '#2563eb',
  };

  function drawBase(gx: number, gy: number, colorHex: string) {
    const bx = ox + gx * cellSize;
    const by = oy + gy * cellSize;
    const bw = 6 * cellSize;
    ctx.fillStyle = colorHex;
    ctx.fillRect(bx, by, bw, bw);

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(bx + cellSize, by + cellSize, 4 * cellSize, 4 * cellSize);

    const coords = [
      [bx + 2 * cellSize, by + 2 * cellSize],
      [bx + 4 * cellSize, by + 2 * cellSize],
      [bx + 2 * cellSize, by + 4 * cellSize],
      [bx + 4 * cellSize, by + 4 * cellSize],
    ];
    for (const [cx, cy] of coords) {
      ctx.beginPath();
      ctx.arc(cx, cy, 18, 0, Math.PI * 2);
      ctx.fillStyle = colorHex;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }
  }

  drawBase(0, 0, colors.RED);
  drawBase(9, 0, colors.GREEN);
  drawBase(0, 9, colors.BLUE);
  drawBase(9, 9, colors.YELLOW);

  // Track Grid Lines
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#cbd5e1';
  for (let r = 0; r <= 15; r++) {
    ctx.beginPath();
    ctx.moveTo(ox, oy + r * cellSize);
    ctx.lineTo(ox + boardSize, oy + r * cellSize);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(ox + r * cellSize, oy);
    ctx.lineTo(ox + r * cellSize, oy + boardSize);
    ctx.stroke();
  }

  // Colored Home Stretches
  ctx.fillStyle = colors.RED;
  for (let c = 1; c <= 5; c++) ctx.fillRect(ox + c * cellSize, oy + 7 * cellSize, cellSize, cellSize);
  ctx.fillRect(ox + cellSize, oy + 6 * cellSize, cellSize, cellSize);

  ctx.fillStyle = colors.GREEN;
  for (let r = 1; r <= 5; r++) ctx.fillRect(ox + 7 * cellSize, oy + r * cellSize, cellSize, cellSize);
  ctx.fillRect(ox + 8 * cellSize, oy + cellSize, cellSize, cellSize);

  ctx.fillStyle = colors.YELLOW;
  for (let c = 9; c <= 13; c++) ctx.fillRect(ox + c * cellSize, oy + 7 * cellSize, cellSize, cellSize);
  ctx.fillRect(ox + 13 * cellSize, oy + 8 * cellSize, cellSize, cellSize);

  ctx.fillStyle = colors.BLUE;
  for (let r = 9; r <= 13; r++) ctx.fillRect(ox + 7 * cellSize, oy + r * cellSize, cellSize, cellSize);
  ctx.fillRect(ox + 6 * cellSize, oy + 13 * cellSize, cellSize, cellSize);

  // Center Finish Triangles
  const cx = ox + 7.5 * cellSize;
  const cy = oy + 7.5 * cellSize;

  ctx.beginPath();
  ctx.moveTo(ox + 6 * cellSize, oy + 6 * cellSize);
  ctx.lineTo(cx, cy);
  ctx.lineTo(ox + 6 * cellSize, oy + 9 * cellSize);
  ctx.fillStyle = colors.RED;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(ox + 6 * cellSize, oy + 6 * cellSize);
  ctx.lineTo(cx, cy);
  ctx.lineTo(ox + 9 * cellSize, oy + 6 * cellSize);
  ctx.fillStyle = colors.GREEN;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(ox + 9 * cellSize, oy + 6 * cellSize);
  ctx.lineTo(cx, cy);
  ctx.lineTo(ox + 9 * cellSize, oy + 9 * cellSize);
  ctx.fillStyle = colors.YELLOW;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(ox + 6 * cellSize, oy + 9 * cellSize);
  ctx.lineTo(cx, cy);
  ctx.lineTo(ox + 9 * cellSize, oy + 9 * cellSize);
  ctx.fillStyle = colors.BLUE;
  ctx.fill();

  // Safe Stars
  ctx.font = 'bold 20px sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const stars = [
    [1, 6], [2, 8], [6, 1], [6, 12], [8, 2], [8, 13], [12, 6], [13, 8]
  ];
  for (const [c, r] of stars) {
    ctx.fillText('★', ox + (c + 0.5) * cellSize, oy + (r + 0.5) * cellSize);
  }

  // Draw Pawns
  function drawPawn(gx: number, gy: number, colorHex: string, label: string) {
    const px = ox + (gx + 0.5) * cellSize;
    const py = oy + (gy + 0.5) * cellSize;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 3;

    ctx.beginPath();
    ctx.arc(px, py, 15, 0, Math.PI * 2);
    ctx.fillStyle = colorHex;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText(label, px, py);
    ctx.restore();
  }

  // Draw active player pawns
  const startPawnCoords: Record<string, [number, number]> = {
    RED: [1, 6],
    GREEN: [8, 1],
    YELLOW: [13, 8],
    BLUE: [6, 13],
  };

  for (const p of state.players) {
    const cKey = state.playerColors[p.jid] || 'RED';
    const hex = colors[cKey] || '#dc2626';
    const coords = startPawnCoords[cKey] || [1, 6];
    drawPawn(coords[0], coords[1], hex, p.name.slice(0, 2).toUpperCase());
  }

  return await canvas.toBuffer('png');
}

async function renderArcadeSummaryCardPng(params: {
  title: string;
  subtitle: string;
  rows: Array<{ left: string; right: string; highlight?: boolean }>;
  footer: string;
}): Promise<Buffer> {
  const rowNodes = params.rows.slice(0, 8).map((r) => ({
    type: 'div',
    props: {
      style: {
        width: '600px',
        height: '46px',
        backgroundColor: r.highlight ? '#14532d' : '#27272a',
        border: r.highlight ? '1px solid #4ade80' : '1px solid #3f3f46',
        borderRadius: '8px',
        padding: '0 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      },
      children: [
        {
          type: 'span',
          props: {
            style: { fontSize: '15px', fontWeight: 700, color: '#f4f4f5' },
            children: r.left.slice(0, 38),
          },
        },
        {
          type: 'span',
          props: {
            style: { fontSize: '14px', fontWeight: 700, color: r.highlight ? '#4ade80' : '#facc15' },
            children: r.right.slice(0, 28),
          },
        },
      ],
    },
  }));

  const height = Math.max(320, 170 + rowNodes.length * 56);
  const tree = {
    type: 'div',
    props: {
      style: {
        width: '648px',
        height: `${height}px`,
        backgroundColor: '#18181b',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        alignItems: 'center',
        fontFamily: 'Inter',
        color: '#ffffff',
      },
      children: [
        {
          type: 'div',
          props: {
            style: {
              width: '600px',
              height: '60px',
              backgroundColor: '#27272a',
              borderRadius: '10px',
              padding: '0 18px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            },
            children: [
              {
                type: 'span',
                props: {
                  style: { fontSize: '20px', fontWeight: 700, color: '#facc15' },
                  children: params.title.slice(0, 32),
                },
              },
              {
                type: 'span',
                props: {
                  style: { fontSize: '14px', fontWeight: 700, color: '#a1a1aa' },
                  children: params.subtitle.slice(0, 26),
                },
              },
            ],
          },
        },
        {
          type: 'div',
          props: {
            style: { display: 'flex', flexDirection: 'column', gap: '8px' },
            children: rowNodes,
          },
        },
        {
          type: 'span',
          props: {
            style: { fontSize: '13px', fontWeight: 700, color: '#a3d160' },
            children: params.footer.slice(0, 64),
          },
        },
      ],
    },
  };

  return await renderTreeToPng(tree, 648, height);
}

/**
 * Unified visual dispatcher that renders any of the 10 Arcade game states into a PNG Buffer.
 */
export async function renderArcadeGameStatePng(
  gameType: string,
  state: unknown,
  whatsapp?: WhatsAppPort,
): Promise<Buffer> {
  switch (gameType) {
    case 'wordle':
      return await renderWordlePng(state as WordleState);
    case 'tarot':
      return await renderTarotPng(state as TarotState);
    case 'ular_tangga':
      return await renderSnakesAndLaddersPng(state as SnakesAndLaddersState);
    case 'speed_monopoly':
      return await renderSpeedMonopolyPng(state as SpeedMonopolyState);
    case 'hot_potato': {
      const s = state as HotPotatoState;
      return await renderArcadeSummaryCardPng({
        title: 'HOT POTATO BOM',
        subtitle: `Ronde ${s.round} • ${s.status.toUpperCase()}`,
        rows: s.players.map((p) => ({
          left: p.name,
          right: p.isEliminated
            ? 'MELEDAK (Gugur)'
            : s.currentHolderJid === p.jid
              ? 'MEMEGANG BOM!'
              : 'Aman',
          highlight: s.currentHolderJid === p.jid,
        })),
        footer: s.winnerJid
          ? `Pemenang: ${s.players.find((p) => p.jid === s.winnerJid)?.name ?? ''}`
          : 'Ketik .pass @target untuk mengoper bom!',
      });
    }
    case 'lms_quiz': {
      const s = state as LmsQuizState;
      const q = s.currentQuestion;
      return await renderArcadeSummaryCardPng({
        title: 'LAST MAN STANDING QUIZ',
        subtitle: `Ronde ${s.round} • ${q?.category ?? 'Lobby'}`,
        rows: q
          ? [
              { left: `A. ${q.options.A}`, right: 'Via DM' },
              { left: `B. ${q.options.B}`, right: 'Via DM' },
              { left: `C. ${q.options.C}`, right: 'Via DM' },
              { left: `D. ${q.options.D}`, right: 'Via DM' },
            ]
          : s.players.map((p) => ({
              left: p.name,
              right: p.isEliminated ? 'Gugur' : `${p.score ?? 0} Poin`,
              highlight: !p.isEliminated,
            })),
        footer: q ? q.prompt.slice(0, 64) : 'Jawab rahasia via DM ke bot!',
      });
    }
    case 'blackjack': {
      const s = state as BlackjackState;
      return await renderBlackjackSkiaPng(s, whatsapp);
    }
    case 'uno': {
      const s = state as UnoState;
      return await renderUnoSkiaPng(s, whatsapp);
    }
    case 'cash_and_guns': {
      const s = state as CashGunsState;
      return await renderCashGunsSkiaPng(s, whatsapp);
    }
    case 'lms_quiz': {
      const s = state as LmsQuizState;
      return await renderLmsQuizSkiaPng(s, whatsapp);
    }
    case 'ludo': {
      const s = state as LudoState;
      return await renderLudoSkiaPng(s, whatsapp);
    }
    default:
      return await renderArcadeSummaryCardPng({
        title: 'ALLYBOT ARCADE',
        subtitle: gameType.toUpperCase(),
        rows: [{ left: 'Status', right: 'Aktif', highlight: true }],
        footer: 'Allybot Modular Arcade Engine',
      });
  }
}
