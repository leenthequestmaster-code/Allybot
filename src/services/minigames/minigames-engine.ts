/**
 * @file minigames-engine.ts
 * @description Pure TypeScript Zero-Allocation-Friendly Game Engines & Minimax AI Bots
 * for Allybot Minigames Suite:
 *   1. Connect 4 (7x6 Grid + Gravity Drop + Alpha-Beta Minimax AI)
 *   2. Tic-Tac-Toe (3x3 Grid + Keypad/Algebraic Input + Unbeatable 9-Ply Minimax AI)
 *   3. Dam / Checkers 8x8 (Compulsory Capture, Multi-Jump Chain, King Promotion & Heuristic Minimax AI)
 *
 * Target Runtime: Node.js 22 LTS (ESM, strict TypeScript)
 */

export type MinigameType = 'connect4' | 'tictactoe' | 'checkers';
export type BotDifficulty = 1 | 2 | 3;
export type PlayerSlot = 1 | 2;

// ============================================================================
// 1. CONNECT 4 ENGINE (7 Columns x 6 Rows)
// ============================================================================

export const C4_ROWS = 6;
export const C4_COLS = 7;
export type Connect4Cell = 0 | 1 | 2; // 0 = Empty, 1 = Player 1 (Teal), 2 = Player 2 (Coral Red)

export interface Connect4Coord {
  row: number;
  col: number;
}

export interface Connect4State {
  kind: 'connect4';
  /** 6 rows x 7 cols matrix (row 0 = top, row 5 = bottom) */
  board: Connect4Cell[][];
  turn: PlayerSlot;
  moveCount: number;
  lastMove: { row: number; col: number; player: PlayerSlot } | null;
  winner: PlayerSlot | 'draw' | null;
  winningCells: Connect4Coord[];
  history: number[]; // 1-indexed columns (1..7)
}

export interface Connect4MoveResult {
  ok: boolean;
  code?: 'INVALID_COLUMN' | 'COLUMN_FULL' | 'GAME_ALREADY_OVER';
  error?: string;
  row?: number;
  col?: number; // 0-indexed (0..6)
  colDisplay?: number; // 1-indexed (1..7)
  player?: PlayerSlot;
  winner?: PlayerSlot | 'draw' | null;
  winningCells?: Connect4Coord[];
}

export function createConnect4State(): Connect4State {
  const board: Connect4Cell[][] = Array.from({ length: C4_ROWS }, () =>
    Array.from({ length: C4_COLS }, () => 0 as Connect4Cell),
  );
  return {
    kind: 'connect4',
    board,
    turn: 1,
    moveCount: 0,
    lastMove: null,
    winner: null,
    winningCells: [],
    history: [],
  };
}

export function cloneConnect4State(state: Connect4State): Connect4State {
  return {
    kind: 'connect4',
    board: state.board.map((row) => [...row]),
    turn: state.turn,
    moveCount: state.moveCount,
    lastMove: state.lastMove ? { ...state.lastMove } : null,
    winner: state.winner,
    winningCells: state.winningCells.map((c) => ({ ...c })),
    history: [...state.history],
  };
}

export function parseConnect4MoveInput(raw: string): number | null {
  const cleaned = raw.trim().replace(/^[!./#]/, '').trim();
  if (!/^[1-7]$/.test(cleaned)) {
    return null;
  }
  return Number.parseInt(cleaned, 10);
}

export function getLegalConnect4Columns(board: Connect4Cell[][]): number[] {
  const cols: number[] = [];
  for (let c = 0; c < C4_COLS; c++) {
    if (board[0][c] === 0) {
      cols.push(c);
    }
  }
  return cols;
}

export function checkConnect4Win(
  board: Connect4Cell[][],
  lastRow: number,
  lastCol: number,
  player: PlayerSlot,
): Connect4Coord[] | null {
  const directions: Array<[number, number]> = [
    [0, 1],  // Horizontal
    [1, 0],  // Vertical
    [1, 1],  // Diagonal \
    [1, -1], // Diagonal /
  ];

  for (const [dr, dc] of directions) {
    const line: Connect4Coord[] = [{ row: lastRow, col: lastCol }];

    // Forward direction
    for (let step = 1; step < 4; step++) {
      const r = lastRow + dr * step;
      const c = lastCol + dc * step;
      if (r < 0 || r >= C4_ROWS || c < 0 || c >= C4_COLS || board[r][c] !== player) {
        break;
      }
      line.push({ row: r, col: c });
    }

    // Backward direction
    for (let step = 1; step < 4; step++) {
      const r = lastRow - dr * step;
      const c = lastCol - dc * step;
      if (r < 0 || r >= C4_ROWS || c < 0 || c >= C4_COLS || board[r][c] !== player) {
        break;
      }
      line.unshift({ row: r, col: c });
    }

    if (line.length >= 4) {
      return line.slice(0, 4);
    }
  }

  return null;
}

export function applyConnect4Move(
  state: Connect4State,
  colInput: number | string,
): Connect4MoveResult {
  if (state.winner !== null) {
    return {
      ok: false,
      code: 'GAME_ALREADY_OVER',
      error: 'Permainan Connect 4 sudah selesai.',
    };
  }

  const colDisplay =
    typeof colInput === 'number' ? colInput : (parseConnect4MoveInput(colInput) ?? -1);
  if (!Number.isInteger(colDisplay) || colDisplay < 1 || colDisplay > C4_COLS) {
    return {
      ok: false,
      code: 'INVALID_COLUMN',
      error: 'Kolom tidak valid! Ketik angka kolom `1` sampai `7`.',
    };
  }

  const col = colDisplay - 1;
  if (state.board[0][col] !== 0) {
    return {
      ok: false,
      code: 'COLUMN_FULL',
      error: `Kolom ${colDisplay} sudah penuh! Pilih kolom lain yang masih kosong.`,
    };
  }

  // Gravity drop: find lowest empty row from bottom (5) to top (0)
  let targetRow = -1;
  for (let r = C4_ROWS - 1; r >= 0; r--) {
    if (state.board[r][col] === 0) {
      targetRow = r;
      break;
    }
  }

  const player = state.turn;
  state.board[targetRow][col] = player;
  state.moveCount += 1;
  state.lastMove = { row: targetRow, col, player };
  state.history.push(colDisplay);

  const winLine = checkConnect4Win(state.board, targetRow, col, player);
  if (winLine) {
    state.winner = player;
    state.winningCells = winLine;
  } else if (state.moveCount >= C4_ROWS * C4_COLS) {
    state.winner = 'draw';
    state.winningCells = [];
  } else {
    state.turn = player === 1 ? 2 : 1;
  }

  return {
    ok: true,
    row: targetRow,
    col,
    colDisplay,
    player,
    winner: state.winner,
    winningCells: state.winningCells,
  };
}

function scoreConnect4Window(
  c0: Connect4Cell,
  c1: Connect4Cell,
  c2: Connect4Cell,
  c3: Connect4Cell,
  botPlayer: PlayerSlot,
): number {
  const oppPlayer: PlayerSlot = botPlayer === 1 ? 2 : 1;
  let botCount = 0;
  let oppCount = 0;
  let emptyCount = 0;

  const cells = [c0, c1, c2, c3];
  for (let i = 0; i < 4; i++) {
    if (cells[i] === botPlayer) botCount++;
    else if (cells[i] === oppPlayer) oppCount++;
    else emptyCount++;
  }

  if (botCount === 4) return 100_000;
  if (oppCount === 4) return -100_000;
  if (botCount === 3 && emptyCount === 1) return 60;
  if (botCount === 2 && emptyCount === 2) return 12;
  if (oppCount === 3 && emptyCount === 1) return -85;
  if (oppCount === 2 && emptyCount === 2) return -14;
  return 0;
}

function evaluateConnect4Board(board: Connect4Cell[][], botPlayer: PlayerSlot): number {
  const oppPlayer: PlayerSlot = botPlayer === 1 ? 2 : 1;
  let score = 0;

  // Center column control preference
  const centerCol = 3;
  for (let r = 0; r < C4_ROWS; r++) {
    if (board[r][centerCol] === botPlayer) score += 6;
    else if (board[r][centerCol] === oppPlayer) score -= 6;
  }

  // Horizontal windows
  for (let r = 0; r < C4_ROWS; r++) {
    for (let c = 0; c <= C4_COLS - 4; c++) {
      score += scoreConnect4Window(
        board[r][c],
        board[r][c + 1],
        board[r][c + 2],
        board[r][c + 3],
        botPlayer,
      );
    }
  }

  // Vertical windows
  for (let c = 0; c < C4_COLS; c++) {
    for (let r = 0; r <= C4_ROWS - 4; r++) {
      score += scoreConnect4Window(
        board[r][c],
        board[r + 1][c],
        board[r + 2][c],
        board[r + 3][c],
        botPlayer,
      );
    }
  }

  // Positive slope & Negative slope diagonals
  for (let r = 0; r <= C4_ROWS - 4; r++) {
    for (let c = 0; c <= C4_COLS - 4; c++) {
      score += scoreConnect4Window(
        board[r][c],
        board[r + 1][c + 1],
        board[r + 2][c + 2],
        board[r + 3][c + 3],
        botPlayer,
      );
      score += scoreConnect4Window(
        board[r + 3][c],
        board[r + 2][c + 1],
        board[r + 1][c + 2],
        board[r][c + 3],
        botPlayer,
      );
    }
  }

  return score;
}

const C4_COLUMN_ORDER = [3, 2, 4, 1, 5, 0, 6];

/**
 * Alpha-Beta Pruning Minimax AI for Connect 4.
 * Returns 1-indexed column (1..7).
 */
export function getConnect4BotMove(
  state: Connect4State,
  difficulty: BotDifficulty = 2,
): number {
  const botPlayer = state.turn;
  const oppPlayer: PlayerSlot = botPlayer === 1 ? 2 : 1;
  const legalCols = C4_COLUMN_ORDER.filter((c) => state.board[0][c] === 0);
  if (legalCols.length === 0) return 4;

  const findDropRow = (board: Connect4Cell[][], col: number): number => {
    for (let r = C4_ROWS - 1; r >= 0; r--) {
      if (board[r][col] === 0) return r;
    }
    return -1;
  };

  // 1. Immediate winning move check
  for (const col of legalCols) {
    const r = findDropRow(state.board, col);
    state.board[r][col] = botPlayer;
    const wins = checkConnect4Win(state.board, r, col, botPlayer);
    state.board[r][col] = 0;
    if (wins) return col + 1;
  }

  // 2. Immediate opponent win block check (always block on difficulty >= 2, 70% on difficulty 1)
  if (difficulty >= 2 || Math.random() < 0.7) {
    for (const col of legalCols) {
      const r = findDropRow(state.board, col);
      state.board[r][col] = oppPlayer;
      const oppWins = checkConnect4Win(state.board, r, col, oppPlayer);
      state.board[r][col] = 0;
      if (oppWins) return col + 1;
    }
  }

  if (difficulty === 1 && Math.random() < 0.35) {
    const randomCol = legalCols[Math.floor(Math.random() * legalCols.length)];
    return randomCol + 1;
  }

  const maxDepth = difficulty === 1 ? 2 : difficulty === 2 ? 4 : 6;
  const board = state.board.map((row) => [...row]);

  const alphabeta = (
    depth: number,
    alpha: number,
    beta: number,
    maximizingPlayer: boolean,
    movesMade: number,
  ): number => {
    if (movesMade >= C4_ROWS * C4_COLS) return 0;
    if (depth === 0) {
      return evaluateConnect4Board(board, botPlayer);
    }

    const validCols = C4_COLUMN_ORDER.filter((c) => board[0][c] === 0);
    if (validCols.length === 0) return 0;

    if (maximizingPlayer) {
      let value = -Infinity;
      for (const col of validCols) {
        const r = findDropRow(board, col);
        board[r][col] = botPlayer;
        let childScore: number;
        if (checkConnect4Win(board, r, col, botPlayer)) {
          childScore = 100_000 + depth * 100;
        } else {
          childScore = alphabeta(depth - 1, alpha, beta, false, movesMade + 1);
        }
        board[r][col] = 0;
        if (childScore > value) value = childScore;
        if (value > alpha) alpha = value;
        if (alpha >= beta) break;
      }
      return value;
    } else {
      let value = Infinity;
      for (const col of validCols) {
        const r = findDropRow(board, col);
        board[r][col] = oppPlayer;
        let childScore: number;
        if (checkConnect4Win(board, r, col, oppPlayer)) {
          childScore = -100_000 - depth * 100;
        } else {
          childScore = alphabeta(depth - 1, alpha, beta, true, movesMade + 1);
        }
        board[r][col] = 0;
        if (childScore < value) value = childScore;
        if (value < beta) beta = value;
        if (alpha >= beta) break;
      }
      return value;
    }
  };

  let bestCol = legalCols[0];
  let bestScore = -Infinity;

  for (const col of legalCols) {
    const r = findDropRow(board, col);
    board[r][col] = botPlayer;
    const score = alphabeta(maxDepth - 1, -Infinity, Infinity, false, state.moveCount + 1);
    board[r][col] = 0;
    if (score > bestScore) {
      bestScore = score;
      bestCol = col;
    }
  }

  return bestCol + 1;
}

// ============================================================================
// 2. TIC-TAC-TOE ENGINE (3x3 Grid + Unbeatable 9-Ply Minimax AI)
// ============================================================================

export type TicTacToeCell = 0 | 1 | 2; // 0 = Empty, 1 = X (Blue), 2 = O (Red)

export interface TicTacToeState {
  kind: 'tictactoe';
  /** 9 cells in row-major order (0..8) */
  cells: TicTacToeCell[];
  turn: PlayerSlot;
  moveCount: number;
  lastMoveIndex: number | null;
  winner: PlayerSlot | 'draw' | null;
  winningCells: number[];
  history: number[]; // 1..9 keypad positions
}

export interface TicTacToeMoveResult {
  ok: boolean;
  code?: 'INVALID_CELL' | 'CELL_OCCUPIED' | 'GAME_ALREADY_OVER';
  error?: string;
  cellIndex?: number; // 0..8
  keypadNumber?: number; // 1..9
  coordLabel?: string; // e.g. 'b2'
  player?: PlayerSlot;
  winner?: PlayerSlot | 'draw' | null;
  winningCells?: number[];
}

export const TTT_WIN_LINES: ReadonlyArray< readonly [number, number, number] > = [
  [0, 1, 2], // Row 0
  [3, 4, 5], // Row 1
  [6, 7, 8], // Row 2
  [0, 3, 6], // Col 0
  [1, 4, 7], // Col 1
  [2, 5, 8], // Col 2
  [0, 4, 8], // Main diagonal
  [2, 4, 6], // Anti-diagonal
];

export function createTicTacToeState(): TicTacToeState {
  return {
    kind: 'tictactoe',
    cells: Array.from({ length: 9 }, () => 0 as TicTacToeCell),
    turn: 1,
    moveCount: 0,
    lastMoveIndex: null,
    winner: null,
    winningCells: [],
    history: [],
  };
}

export function cloneTicTacToeState(state: TicTacToeState): TicTacToeState {
  return {
    kind: 'tictactoe',
    cells: [...state.cells],
    turn: state.turn,
    moveCount: state.moveCount,
    lastMoveIndex: state.lastMoveIndex,
    winner: state.winner,
    winningCells: [...state.winningCells],
    history: [...state.history],
  };
}

export function indexToTicTacToeCoord(index: number): string {
  const row = Math.floor(index / 3);
  const col = index % 3;
  return `${String.fromCharCode(97 + col)}${row + 1}`;
}

/**
 * Parses either keypad `1..9` or algebraic `a1..c3` / `1a..3c` into 0-based index `0..8`.
 */
export function parseTicTacToeMoveInput(raw: string): number | null {
  const cleaned = raw.trim().toLowerCase().replace(/^[!./#]/, '').trim();
  if (/^[1-9]$/.test(cleaned)) {
    return Number.parseInt(cleaned, 10) - 1;
  }
  if (/^[abc][123]$/.test(cleaned)) {
    const col = cleaned.charCodeAt(0) - 97;
    const row = Number.parseInt(cleaned[1], 10) - 1;
    return row * 3 + col;
  }
  if (/^[123][abc]$/.test(cleaned)) {
    const row = Number.parseInt(cleaned[0], 10) - 1;
    const col = cleaned.charCodeAt(1) - 97;
    return row * 3 + col;
  }
  return null;
}

export function checkTicTacToeWin(cells: TicTacToeCell[]): {
  winner: PlayerSlot;
  line: number[];
} | null {
  for (const [a, b, c] of TTT_WIN_LINES) {
    const v = cells[a];
    if (v !== 0 && v === cells[b] && v === cells[c]) {
      return { winner: v, line: [a, b, c] };
    }
  }
  return null;
}

export function applyTicTacToeMove(
  state: TicTacToeState,
  input: number | string,
): TicTacToeMoveResult {
  if (state.winner !== null) {
    return {
      ok: false,
      code: 'GAME_ALREADY_OVER',
      error: 'Permainan Tic-Tac-Toe sudah selesai.',
    };
  }

  let cellIndex: number | null = null;
  if (typeof input === 'number') {
    if (input >= 1 && input <= 9) cellIndex = input - 1;
  } else {
    cellIndex = parseTicTacToeMoveInput(input);
  }

  if (cellIndex === null || cellIndex < 0 || cellIndex > 8) {
    return {
      ok: false,
      code: 'INVALID_CELL',
      error: 'Posisi tidak valid! Ketik angka `1-9` atau koordinat `a1-c3`.',
    };
  }

  if (state.cells[cellIndex] !== 0) {
    return {
      ok: false,
      code: 'CELL_OCCUPIED',
      error: `Kotak ${cellIndex + 1} (${indexToTicTacToeCoord(cellIndex)}) sudah terisi! Pilih kotak yang masih kosong.`,
    };
  }

  const player = state.turn;
  state.cells[cellIndex] = player;
  state.moveCount += 1;
  state.lastMoveIndex = cellIndex;
  state.history.push(cellIndex + 1);

  const winInfo = checkTicTacToeWin(state.cells);
  if (winInfo) {
    state.winner = winInfo.winner;
    state.winningCells = winInfo.line;
  } else if (state.moveCount >= 9) {
    state.winner = 'draw';
    state.winningCells = [];
  } else {
    state.turn = player === 1 ? 2 : 1;
  }

  return {
    ok: true,
    cellIndex,
    keypadNumber: cellIndex + 1,
    coordLabel: indexToTicTacToeCoord(cellIndex),
    player,
    winner: state.winner,
    winningCells: state.winningCells,
  };
}

/**
 * Unbeatable 9-Ply Minimax AI for Tic-Tac-Toe (Level 3) + Tuned Level 1 & 2.
 * Returns 1-indexed keypad move (1..9).
 */
export function getTicTacToeBotMove(
  state: TicTacToeState,
  difficulty: BotDifficulty = 3,
): number {
  const botPlayer = state.turn;
  const oppPlayer: PlayerSlot = botPlayer === 1 ? 2 : 1;
  const emptyIndices: number[] = [];
  for (let i = 0; i < 9; i++) {
    if (state.cells[i] === 0) emptyIndices.push(i);
  }
  if (emptyIndices.length === 0) return 5;

  // Level 1 (Novice): 55% random move
  if (difficulty === 1 && Math.random() < 0.55) {
    const pick = emptyIndices[Math.floor(Math.random() * emptyIndices.length)];
    return pick + 1;
  }

  // Immediate win check
  for (const idx of emptyIndices) {
    state.cells[idx] = botPlayer;
    const win = checkTicTacToeWin(state.cells);
    state.cells[idx] = 0;
    if (win) return idx + 1;
  }

  // Immediate block check
  for (const idx of emptyIndices) {
    state.cells[idx] = oppPlayer;
    const oppWin = checkTicTacToeWin(state.cells);
    state.cells[idx] = 0;
    if (oppWin) return idx + 1;
  }

  if (difficulty === 2 && Math.random() < 0.25) {
    const preferred = [4, 0, 2, 6, 8, 1, 3, 5, 7].filter((i) => state.cells[i] === 0);
    return preferred[0] + 1;
  }

  // Full 9-ply Minimax (Unbeatable)
  const cells = [...state.cells];
  const minimax = (depth: number, isMax: boolean): number => {
    const win = checkTicTacToeWin(cells);
    if (win) {
      return win.winner === botPlayer ? 100 - depth : depth - 100;
    }
    let hasEmpty = false;
    for (let i = 0; i < 9; i++) {
      if (cells[i] === 0) {
        hasEmpty = true;
        break;
      }
    }
    if (!hasEmpty) return 0;

    if (isMax) {
      let best = -Infinity;
      for (let i = 0; i < 9; i++) {
        if (cells[i] === 0) {
          cells[i] = botPlayer;
          const score = minimax(depth + 1, false);
          cells[i] = 0;
          if (score > best) best = score;
        }
      }
      return best;
    } else {
      let best = Infinity;
      for (let i = 0; i < 9; i++) {
        if (cells[i] === 0) {
          cells[i] = oppPlayer;
          const score = minimax(depth + 1, true);
          cells[i] = 0;
          if (score < best) best = score;
        }
      }
      return best;
    }
  };

  // Prefer center (4), then corners (0,2,6,8), then edges (1,3,5,7) on tie
  const orderedMoves = [4, 0, 2, 6, 8, 1, 3, 5, 7].filter((i) => cells[i] === 0);
  let bestMove = orderedMoves[0];
  let bestVal = -Infinity;

  for (const idx of orderedMoves) {
    cells[idx] = botPlayer;
    const val = minimax(0, false);
    cells[idx] = 0;
    if (val > bestVal) {
      bestVal = val;
      bestMove = idx;
    }
  }

  return bestMove + 1;
}

// ============================================================================
// 3. DAM / CHECKERS 8x8 ENGINE (Compulsory Capture, Multi-Jump & King Promotion)
// ============================================================================

/**
 * Piece encoding on the 8x8 Checkers board:
 *   0 = Empty square
 *   1 = Red Man   (Player 1 — bottom rows 5..7 at start, moves UP dr = -1, promotes at row 0)
 *   2 = Blue Man  (Player 2 — top rows 0..2 at start, moves DOWN dr = +1, promotes at row 7)
 *   3 = Red King  (Player 1 — moves/jumps in all 4 diagonal directions)
 *   4 = Blue King (Player 2 — moves/jumps in all 4 diagonal directions)
 */
export type CheckersCell = 0 | 1 | 2 | 3 | 4;

export interface CheckersCoord {
  row: number; // 0..7 (0 is top rank 8, 7 is bottom rank 1)
  col: number; // 0..7 (0 is file 'a', 7 is file 'h')
}

export interface CheckersStepMove {
  from: CheckersCoord;
  to: CheckersCoord;
  isCapture: boolean;
  captured?: CheckersCoord;
}

export interface CheckersState {
  kind: 'checkers';
  board: CheckersCell[][];
  turn: PlayerSlot; // 1 = Red (Bottom), 2 = Blue (Top)
  moveCount: number;
  noCaptureCount: number;
  /** When a piece mid-turn has another mandatory jump available, it is locked here */
  mustContinueJumpFrom: CheckersCoord | null;
  /** Optional UI highlight square (e.g. selected piece or last moved piece) */
  selectedSquare: CheckersCoord | null;
  lastMove: {
    from: CheckersCoord;
    to: CheckersCoord;
    path: CheckersCoord[];
    captured: CheckersCoord[];
    promoted: boolean;
    player: PlayerSlot;
  } | null;
  winner: PlayerSlot | 'draw' | null;
  winReason?: 'elimination' | 'stalemate' | 'draw_limit' | null;
  history: string[];
}

export interface CheckersMoveResult {
  ok: boolean;
  code?:
    | 'INVALID_SYNTAX'
    | 'INVALID_SQUARE'
    | 'NOT_YOUR_PIECE'
    | 'COMPULSORY_CAPTURE'
    | 'MUST_CONTINUE_CHAIN'
    | 'ILLEGAL_MOVE'
    | 'GAME_ALREADY_OVER';
  error?: string;
  notation?: string;
  player?: PlayerSlot;
  capturedCount?: number;
  promoted?: boolean;
  chainContinued?: boolean;
  nextAvailableJumps?: CheckersStepMove[];
  winner?: PlayerSlot | 'draw' | null;
}

export function belongsToCheckersPlayer(cell: CheckersCell, player: PlayerSlot): boolean {
  if (player === 1) return cell === 1 || cell === 3;
  return cell === 2 || cell === 4;
}

export function isCheckersKing(cell: CheckersCell): boolean {
  return cell === 3 || cell === 4;
}

export function coordToCheckersAlgebraic(coord: CheckersCoord): string {
  const file = String.fromCharCode(97 + coord.col);
  const rank = 8 - coord.row;
  return `${file}${rank}`;
}

export function algebraicToCheckersCoord(token: string): CheckersCoord | null {
  const cleaned = token.trim().toLowerCase();
  if (!/^[a-h][1-8]$/.test(cleaned)) return null;
  const col = cleaned.charCodeAt(0) - 97;
  const rank = Number.parseInt(cleaned[1], 10);
  const row = 8 - rank;
  return { row, col };
}

export function createCheckersState(): CheckersState {
  const board: CheckersCell[][] = Array.from({ length: 8 }, () =>
    Array.from({ length: 8 }, () => 0 as CheckersCell),
  );

  // Top 3 rows (0, 1, 2): Player 2 (Blue Man = 2) on dark squares (r + c) % 2 === 1
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        board[r][c] = 2;
      }
    }
  }

  // Bottom 3 rows (5, 6, 7): Player 1 (Red Man = 1) on dark squares (r + c) % 2 === 1
  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) {
        board[r][c] = 1;
      }
    }
  }

  return {
    kind: 'checkers',
    board,
    turn: 1, // Player 1 (Red) moves first
    moveCount: 0,
    noCaptureCount: 0,
    mustContinueJumpFrom: null,
    selectedSquare: null,
    lastMove: null,
    winner: null,
    winReason: null,
    history: [],
  };
}

export function cloneCheckersState(state: CheckersState): CheckersState {
  return {
    kind: 'checkers',
    board: state.board.map((row) => [...row]),
    turn: state.turn,
    moveCount: state.moveCount,
    noCaptureCount: state.noCaptureCount,
    mustContinueJumpFrom: state.mustContinueJumpFrom
      ? { ...state.mustContinueJumpFrom }
      : null,
    selectedSquare: state.selectedSquare ? { ...state.selectedSquare } : null,
    lastMove: state.lastMove
      ? {
          from: { ...state.lastMove.from },
          to: { ...state.lastMove.to },
          path: state.lastMove.path.map((p) => ({ ...p })),
          captured: state.lastMove.captured.map((p) => ({ ...p })),
          promoted: state.lastMove.promoted,
          player: state.lastMove.player,
        }
      : null,
    winner: state.winner,
    winReason: state.winReason ?? null,
    history: [...state.history],
  };
}

function getAllowedDirections(cell: CheckersCell): ReadonlyArray<readonly [number, number]> {
  if (cell === 1) {
    // Red Man moves UP (towards row 0)
    return [
      [-1, -1],
      [-1, 1],
    ];
  }
  if (cell === 2) {
    // Blue Man moves DOWN (towards row 7)
    return [
      [1, -1],
      [1, 1],
    ];
  }
  // Kings move in all 4 diagonal directions
  return [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ];
}

export function getPieceJumpMoves(
  board: CheckersCell[][],
  row: number,
  col: number,
): CheckersStepMove[] {
  const cell = board[row][col];
  if (cell === 0) return [];
  const player: PlayerSlot = cell === 1 || cell === 3 ? 1 : 2;
  const oppPlayer: PlayerSlot = player === 1 ? 2 : 1;
  const dirs = getAllowedDirections(cell);
  const jumps: CheckersStepMove[] = [];

  for (const [dr, dc] of dirs) {
    const midR = row + dr;
    const midC = col + dc;
    const landR = row + dr * 2;
    const landC = col + dc * 2;
    if (
      landR >= 0 &&
      landR < 8 &&
      landC >= 0 &&
      landC < 8 &&
      belongsToCheckersPlayer(board[midR][midC], oppPlayer) &&
      board[landR][landC] === 0
    ) {
      jumps.push({
        from: { row, col },
        to: { row: landR, col: landC },
        isCapture: true,
        captured: { row: midR, col: midC },
      });
    }
  }

  return jumps;
}

export function getPieceSlideMoves(
  board: CheckersCell[][],
  row: number,
  col: number,
): CheckersStepMove[] {
  const cell = board[row][col];
  if (cell === 0) return [];
  const dirs = getAllowedDirections(cell);
  const slides: CheckersStepMove[] = [];

  for (const [dr, dc] of dirs) {
    const toR = row + dr;
    const toC = col + dc;
    if (toR >= 0 && toR < 8 && toC >= 0 && toC < 8 && board[toR][toC] === 0) {
      slides.push({
        from: { row, col },
        to: { row: toR, col: toC },
        isCapture: false,
      });
    }
  }

  return slides;
}

/**
 * Returns all legal step moves for the active player, enforcing:
 *   1. Active multi-jump lock (`mustContinueJumpFrom`)
 *   2. Compulsory capture (`Wajib Makan` — if any jump exists, slides are excluded)
 */
export function getLegalCheckersMoves(state: CheckersState): {
  moves: CheckersStepMove[];
  hasCompulsoryCapture: boolean;
} {
  if (state.mustContinueJumpFrom) {
    const { row, col } = state.mustContinueJumpFrom;
    const jumps = getPieceJumpMoves(state.board, row, col);
    return { moves: jumps, hasCompulsoryCapture: true };
  }

  const allJumps: CheckersStepMove[] = [];
  const allSlides: CheckersStepMove[] = [];

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = state.board[r][c];
      if (!belongsToCheckersPlayer(cell, state.turn)) continue;
      const jumps = getPieceJumpMoves(state.board, r, c);
      if (jumps.length > 0) {
        allJumps.push(...jumps);
      } else if (allJumps.length === 0) {
        allSlides.push(...getPieceSlideMoves(state.board, r, c));
      }
    }
  }

  if (allJumps.length > 0) {
    return { moves: allJumps, hasCompulsoryCapture: true };
  }
  return { moves: allSlides, hasCompulsoryCapture: false };
}

/**
 * Returns all squares containing pieces of `state.turn` that currently have at least one legal move.
 * Used by the renderer to draw the glowing white halo around movable pieces!
 */
export function getMovableCheckersSquares(state: CheckersState): Set<string> {
  const { moves } = getLegalCheckersMoves(state);
  const set = new Set<string>();
  for (const m of moves) {
    set.add(`${m.from.row},${m.from.col}`);
  }
  return set;
}

/**
 * Parses a Checkers move string such as:
 *   - `"c3 d4"` or `"c3-d4"` or `"c3->d4"` or `"c3xd4"`
 *   - Multi-jump chain `"c3 e5 g7"` or `"c3-e5-g7"`
 *   - Single destination `"g7"` when `mustContinueJumpFrom` is active
 */
export function parseCheckersMoveTokens(
  raw: string,
  mustContinueJumpFrom: CheckersCoord | null = null,
): CheckersCoord[] | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^[!./#](?:dam|checkers|draughts)\s+/i, '')
    .trim();

  const matches = cleaned.match(/[a-h][1-8]/g);
  if (!matches || matches.length === 0) return null;

  // Verify the entire string is only composed of coordinates and separators
  const stripped = cleaned.replace(/[a-h][1-8]/g, '').replace(/[\s\-x>:to,]+/g, '');
  if (stripped.length > 0) return null;

  const coords = matches
    .map((m) => algebraicToCheckersCoord(m))
    .filter((c): c is CheckersCoord => c !== null);

  if (coords.length === 1 && mustContinueJumpFrom) {
    return [mustContinueJumpFrom, coords[0]];
  }

  if (coords.length < 2) return null;
  return coords;
}

function evaluateCheckersWinnerAfterTurn(state: CheckersState): void {
  let p1Pieces = 0;
  let p2Pieces = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = state.board[r][c];
      if (cell === 1 || cell === 3) p1Pieces++;
      else if (cell === 2 || cell === 4) p2Pieces++;
    }
  }

  if (p1Pieces === 0) {
    state.winner = 2;
    state.winReason = 'elimination';
    return;
  }
  if (p2Pieces === 0) {
    state.winner = 1;
    state.winReason = 'elimination';
    return;
  }

  const nextLegal = getLegalCheckersMoves(state);
  if (nextLegal.moves.length === 0) {
    // Active player has no legal moves (Stalemate = Loss in Checkers)
    state.winner = state.turn === 1 ? 2 : 1;
    state.winReason = 'stalemate';
    return;
  }

  if (state.noCaptureCount >= 80) {
    state.winner = 'draw';
    state.winReason = 'draw_limit';
  }
}

export function applyCheckersMove(
  state: CheckersState,
  rawInput: string | CheckersCoord[],
): CheckersMoveResult {
  if (state.winner !== null) {
    return {
      ok: false,
      code: 'GAME_ALREADY_OVER',
      error: 'Permainan Dam / Checkers sudah selesai.',
    };
  }

  const coords =
    typeof rawInput === 'string'
      ? parseCheckersMoveTokens(rawInput, state.mustContinueJumpFrom)
      : rawInput;

  if (!coords || coords.length < 2) {
    return {
      ok: false,
      code: 'INVALID_SYNTAX',
      error:
        'Format langkah Dam tidak valid! Gunakan koordinat asal & tujuan, contoh: `c3 d4` atau lompatan beruntun `c3 e5 g7`.',
    };
  }

  for (const pt of coords) {
    if (pt.row < 0 || pt.row > 7 || pt.col < 0 || pt.col > 7) {
      return {
        ok: false,
        code: 'INVALID_SQUARE',
        error: 'Koordinat berada di luar papan 8x8 (`a1` sampai `h8`).',
      };
    }
  }

  const player = state.turn;
  const start = coords[0];

  if (
    state.mustContinueJumpFrom &&
    (start.row !== state.mustContinueJumpFrom.row ||
      start.col !== state.mustContinueJumpFrom.col)
  ) {
    const lockedSq = coordToCheckersAlgebraic(state.mustContinueJumpFrom);
    return {
      ok: false,
      code: 'MUST_CONTINUE_CHAIN',
      error: `Kamu sedang dalam rantai *Multi-Jump*! Wajib melanjutkan lompatan dari bidak di *${lockedSq.toUpperCase()}*.`,
    };
  }

  const startCell = state.board[start.row][start.col];
  if (!belongsToCheckersPlayer(startCell, player)) {
    return {
      ok: false,
      code: 'NOT_YOUR_PIECE',
      error: `Tidak ada bidak milikmu di petak *${coordToCheckersAlgebraic(start).toUpperCase()}*.`,
    };
  }

  // Work on a cloned state so multi-step validation is atomic
  const working = cloneCheckersState(state);
  const path: CheckersCoord[] = [{ ...start }];
  const capturedList: CheckersCoord[] = [];
  let promoted = false;
  let currentPos = { ...start };

  for (let i = 1; i < coords.length; i++) {
    const target = coords[i];
    const legal = getLegalCheckersMoves(working);

    const matchingMove = legal.moves.find(
      (m) =>
        m.from.row === currentPos.row &&
        m.from.col === currentPos.col &&
        m.to.row === target.row &&
        m.to.col === target.col,
    );

    if (!matchingMove) {
      // Check if player tried a slide move while a compulsory capture exists!
      if (legal.hasCompulsoryCapture) {
        const slidesFromStart = getPieceSlideMoves(working.board, currentPos.row, currentPos.col);
        const triedSlide = slidesFromStart.some(
          (s) => s.to.row === target.row && s.to.col === target.col,
        );
        const availableJumpStr = legal.moves
          .map(
            (m) =>
              `${coordToCheckersAlgebraic(m.from)} -> ${coordToCheckersAlgebraic(m.to)}`,
          )
          .join(', ');

        if (triedSlide || i === 1) {
          return {
            ok: false,
            code: 'COMPULSORY_CAPTURE',
            error: `⚠️ *WAJIB MAKAN (Compulsory Capture)!* Kamu tidak boleh menggeser biasa saat ada bidak lawan yang bisa dimakan.\nLangkah makan yang tersedia: *${availableJumpStr}*`,
          };
        }
      }

      return {
        ok: false,
        code: 'ILLEGAL_MOVE',
        error: `Langkah dari *${coordToCheckersAlgebraic(currentPos).toUpperCase()}* ke *${coordToCheckersAlgebraic(target).toUpperCase()}* tidak sah!`,
      };
    }

    // Execute this step on `working`
    const movingPiece = working.board[currentPos.row][currentPos.col];
    working.board[currentPos.row][currentPos.col] = 0;
    working.board[target.row][target.col] = movingPiece;

    if (matchingMove.isCapture && matchingMove.captured) {
      working.board[matchingMove.captured.row][matchingMove.captured.col] = 0;
      capturedList.push({ ...matchingMove.captured });
    }

    currentPos = { ...target };
    path.push({ ...currentPos });

    // Check promotion on reaching the back rank
    const landedPiece = working.board[currentPos.row][currentPos.col];
    if (landedPiece === 1 && currentPos.row === 0) {
      working.board[currentPos.row][currentPos.col] = 3; // Red King
      promoted = true;
    } else if (landedPiece === 2 && currentPos.row === 7) {
      working.board[currentPos.row][currentPos.col] = 4; // Blue King
      promoted = true;
    }

    // Check if more jumps are possible in this turn
    if (matchingMove.isCapture && !promoted) {
      const followUpJumps = getPieceJumpMoves(
        working.board,
        currentPos.row,
        currentPos.col,
      );
      if (followUpJumps.length > 0) {
        working.mustContinueJumpFrom = { ...currentPos };
      } else {
        working.mustContinueJumpFrom = null;
      }
    } else {
      working.mustContinueJumpFrom = null;
    }

    // If the user supplied more steps in `coords` after the turn already finished, reject
    if (i < coords.length - 1 && working.mustContinueJumpFrom === null) {
      return {
        ok: false,
        code: 'ILLEGAL_MOVE',
        error: `Langkah beruntun tidak valid setelah petak *${coordToCheckersAlgebraic(currentPos).toUpperCase()}*.`,
      };
    }
  }

  // Commit `working` back into `state`
  state.board = working.board;
  state.mustContinueJumpFrom = working.mustContinueJumpFrom;
  state.selectedSquare = null;

  const notation = path
    .map((p) => coordToCheckersAlgebraic(p))
    .join(capturedList.length > 0 ? 'x' : '-');

  state.lastMove = {
    from: path[0],
    to: path[path.length - 1],
    path,
    captured: capturedList,
    promoted,
    player,
  };

  if (state.mustContinueJumpFrom !== null) {
    // Player MUST continue multi-jump chain on the same turn!
    const nextAvailableJumps = getPieceJumpMoves(
      state.board,
      state.mustContinueJumpFrom.row,
      state.mustContinueJumpFrom.col,
    );
    return {
      ok: true,
      notation,
      player,
      capturedCount: capturedList.length,
      promoted,
      chainContinued: true,
      nextAvailableJumps,
      winner: null,
    };
  }

  // Turn completes
  state.moveCount += 1;
  if (capturedList.length > 0) {
    state.noCaptureCount = 0;
  } else {
    state.noCaptureCount += 1;
  }
  state.history.push(notation);
  state.turn = player === 1 ? 2 : 1;

  evaluateCheckersWinnerAfterTurn(state);

  return {
    ok: true,
    notation,
    player,
    capturedCount: capturedList.length,
    promoted,
    chainContinued: false,
    nextAvailableJumps: [],
    winner: state.winner,
  };
}

/**
 * Generates all complete turn sequences (expanding multi-jump chains to completion)
 * for the active player in `state`.
 */
export function generateAllCheckersTurnSequences(
  state: CheckersState,
): CheckersCoord[][] {
  const legal = getLegalCheckersMoves(state);
  if (legal.moves.length === 0) return [];

  if (!legal.hasCompulsoryCapture) {
    return legal.moves.map((m) => [m.from, m.to]);
  }

  const sequences: CheckersCoord[][] = [];

  const expandJumps = (curState: CheckersState, pathSoFar: CheckersCoord[]) => {
    const lastSq = pathSoFar[pathSoFar.length - 1];
    const jumps = getPieceJumpMoves(curState.board, lastSq.row, lastSq.col);
    if (jumps.length === 0) {
      sequences.push(pathSoFar);
      return;
    }

    for (const j of jumps) {
      const nextState = cloneCheckersState(curState);
      const piece = nextState.board[j.from.row][j.from.col];
      nextState.board[j.from.row][j.from.col] = 0;
      nextState.board[j.to.row][j.to.col] = piece;
      if (j.captured) {
        nextState.board[j.captured.row][j.captured.col] = 0;
      }

      let crowned = false;
      if (piece === 1 && j.to.row === 0) {
        nextState.board[j.to.row][j.to.col] = 3;
        crowned = true;
      } else if (piece === 2 && j.to.row === 7) {
        nextState.board[j.to.row][j.to.col] = 4;
        crowned = true;
      }

      const nextPath = [...pathSoFar, j.to];
      if (crowned) {
        sequences.push(nextPath);
      } else {
        const more = getPieceJumpMoves(nextState.board, j.to.row, j.to.col);
        if (more.length === 0) {
          sequences.push(nextPath);
        } else {
          expandJumps(nextState, nextPath);
        }
      }
    }
  };

  for (const firstJump of legal.moves) {
    const nextState = cloneCheckersState(state);
    const piece = nextState.board[firstJump.from.row][firstJump.from.col];
    nextState.board[firstJump.from.row][firstJump.from.col] = 0;
    nextState.board[firstJump.to.row][firstJump.to.col] = piece;
    if (firstJump.captured) {
      nextState.board[firstJump.captured.row][firstJump.captured.col] = 0;
    }

    let crowned = false;
    if (piece === 1 && firstJump.to.row === 0) {
      nextState.board[firstJump.to.row][firstJump.to.col] = 3;
      crowned = true;
    } else if (piece === 2 && firstJump.to.row === 7) {
      nextState.board[firstJump.to.row][firstJump.to.col] = 4;
      crowned = true;
    }

    const basePath = [firstJump.from, firstJump.to];
    if (crowned) {
      sequences.push(basePath);
    } else {
      expandJumps(nextState, basePath);
    }
  }

  return sequences;
}

function evaluateCheckersBoard(state: CheckersState, botPlayer: PlayerSlot): number {
  if (state.winner !== null) {
    if (state.winner === 'draw') return 0;
    return state.winner === botPlayer ? 50_000 : -50_000;
  }

  let score = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = state.board[r][c];
      if (cell === 0) continue;

      const isP1 = cell === 1 || cell === 3;
      const owner: PlayerSlot = isP1 ? 1 : 2;
      const sign = owner === botPlayer ? 1 : -1;

      if (cell === 1) {
        // Red Man (moves towards row 0)
        const advancement = (7 - r) * 6;
        const backRowBonus = r === 7 ? 10 : 0;
        const centerBonus = r >= 2 && r <= 5 && c >= 2 && c <= 5 ? 8 : 0;
        score += sign * (100 + advancement + backRowBonus + centerBonus);
      } else if (cell === 2) {
        // Blue Man (moves towards row 7)
        const advancement = r * 6;
        const backRowBonus = r === 0 ? 10 : 0;
        const centerBonus = r >= 2 && r <= 5 && c >= 2 && c <= 5 ? 8 : 0;
        score += sign * (100 + advancement + backRowBonus + centerBonus);
      } else {
        // King (3 or 4)
        const centerBonus = r >= 2 && r <= 5 && c >= 2 && c <= 5 ? 12 : 0;
        score += sign * (180 + centerBonus);
      }
    }
  }

  return score;
}

/**
 * Heuristic Alpha-Beta Minimax AI for Dam / Checkers 8x8.
 * Returns the full coordinate sequence for the bot's turn (including multi-jumps).
 */
export function getCheckersBotMove(
  state: CheckersState,
  difficulty: BotDifficulty = 2,
): CheckersCoord[] {
  const sequences = generateAllCheckersTurnSequences(state);
  if (sequences.length === 0) return [];
  if (sequences.length === 1) return sequences[0];

  if (difficulty === 1 && Math.random() < 0.4) {
    return sequences[Math.floor(Math.random() * sequences.length)];
  }

  const botPlayer = state.turn;
  const maxDepth = difficulty === 1 ? 2 : difficulty === 2 ? 4 : 6;

  const alphabeta = (
    cur: CheckersState,
    depth: number,
    alpha: number,
    beta: number,
  ): number => {
    if (cur.winner !== null || depth === 0) {
      return evaluateCheckersBoard(cur, botPlayer);
    }

    const seqs = generateAllCheckersTurnSequences(cur);
    if (seqs.length === 0) {
      return cur.turn === botPlayer ? -50_000 : 50_000;
    }

    const isMaximizing = cur.turn === botPlayer;
    if (isMaximizing) {
      let value = -Infinity;
      for (const seq of seqs) {
        const child = cloneCheckersState(cur);
        applyCheckersMove(child, seq);
        const childScore = alphabeta(child, depth - 1, alpha, beta);
        if (childScore > value) value = childScore;
        if (value > alpha) alpha = value;
        if (alpha >= beta) break;
      }
      return value;
    } else {
      let value = Infinity;
      for (const seq of seqs) {
        const child = cloneCheckersState(cur);
        applyCheckersMove(child, seq);
        const childScore = alphabeta(child, depth - 1, alpha, beta);
        if (childScore < value) value = childScore;
        if (value < beta) beta = value;
        if (alpha >= beta) break;
      }
      return value;
    }
  };

  let bestSeq = sequences[0];
  let bestScore = -Infinity;

  for (const seq of sequences) {
    const child = cloneCheckersState(state);
    applyCheckersMove(child, seq);
    const score = alphabeta(child, maxDepth - 1, -Infinity, Infinity);
    if (score > bestScore) {
      bestScore = score;
      bestSeq = seq;
    }
  }

  return bestSeq;
}
