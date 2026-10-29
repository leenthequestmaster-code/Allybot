// ============================================================================
// ALLYBOT 10-MINIGAME ARCADE VISUAL RENDERER (SATORI + RESVG + SHARP)
// Renders clean, high-contrast 1:1 / 4:3 PNG boards & HUD cards for all 10 games
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
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

export async function renderArcadeSummaryCardPng(params: {
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
      const dTotal = s.dealerHoleRevealed
        ? String(evaluateBlackjackHand(s.dealerCards).total)
        : '?';
      return await renderArcadeSummaryCardPng({
        title: 'BLACKJACK 21',
        subtitle: `Bandar: ${s.dealerHoleRevealed ? s.dealerCards.map((c) => c.code).join(' ') : `${s.dealerCards[0]?.code ?? ''} [?]`} (${dTotal})`,
        rows: s.seats.map((seat, idx) => ({
          left: `${seat.player.name}: ${seat.cards.map((c) => c.code).join(' ')}`,
          right: `${evaluateBlackjackHand(seat.cards).total} • ${seat.status.toUpperCase()}`,
          highlight: s.status === 'player_turns' && idx === s.activeSeatIndex,
        })),
        footer: 'Aksi: hit | stand | double (Payout Blackjack 3:2)',
      });
    }
    case 'uno': {
      const s = state as UnoState;
      const top = s.discardPile[s.discardPile.length - 1];
      return await renderArcadeSummaryCardPng({
        title: 'UNO 108 KARTU',
        subtitle: `Atas: [${top?.label ?? '-'}] • ${s.activeColor.toUpperCase()}`,
        rows: s.players.map((p, idx) => ({
          left: p.name,
          right: `${(s.hands[p.jid] ?? []).length} Kartu`,
          highlight: s.status === 'playing' && idx === s.currentTurnIndex,
        })),
        footer: `Arah: ${s.direction === 1 ? 'Searah Jarum Jam' : 'Berlawanan Arah'}`,
      });
    }
    case 'cash_and_guns': {
      const s = state as CashGunsState;
      return await renderArcadeSummaryCardPng({
        title: 'CASH & GUNS',
        subtitle: `Ronde ${s.round}/${s.maxRounds} • Pot $${s.currentLootPot.toLocaleString('en-US')}`,
        rows: s.players.map((p) => ({
          left: `${p.name} (Luka: ${p.wounds ?? 0}/3)`,
          right: p.isEliminated ? 'Gugur' : `$${(p.score ?? 0).toLocaleString('en-US')}`,
          highlight: !p.isEliminated,
        })),
        footer: `Fase: ${s.status.toUpperCase()} (AIM via DM / COURAGE di Grup)`,
      });
    }
    case 'ludo': {
      const s = state as LudoState;
      return await renderArcadeSummaryCardPng({
        title: 'LUDO 4 WARNA',
        subtitle: `Status: ${s.status.toUpperCase()}`,
        rows: s.players.map((p, idx) => {
          const toks = s.tokens[p.jid] ?? [];
          const summary = toks
            .map((t) => (t.step === -1 ? 'Base' : t.step === 56 ? 'FIN' : `S${t.step}`))
            .join('/');
          return {
            left: `${p.name} (${s.playerColors[p.jid]})`,
            right: summary,
            highlight: s.status === 'playing' && idx === s.currentTurnIndex,
          };
        }),
        footer: 'Lempar dadu 6 untuk keluar Base & makan pion lawan!',
      });
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
