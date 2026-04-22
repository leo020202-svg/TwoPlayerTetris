export const COLS = 10;
export const ROWS = 20;

export const SHAPES = {
  I: [
    [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    [[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]],
    [[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]],
    [[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]],
  ],
  O: [
    [[1,1],[1,1]],
    [[1,1],[1,1]],
    [[1,1],[1,1]],
    [[1,1],[1,1]],
  ],
  T: [
    [[0,1,0],[1,1,1],[0,0,0]],
    [[0,1,0],[0,1,1],[0,1,0]],
    [[0,0,0],[1,1,1],[0,1,0]],
    [[0,1,0],[1,1,0],[0,1,0]],
  ],
  S: [
    [[0,1,1],[1,1,0],[0,0,0]],
    [[0,1,0],[0,1,1],[0,0,1]],
    [[0,0,0],[0,1,1],[1,1,0]],
    [[1,0,0],[1,1,0],[0,1,0]],
  ],
  Z: [
    [[1,1,0],[0,1,1],[0,0,0]],
    [[0,0,1],[0,1,1],[0,1,0]],
    [[0,0,0],[1,1,0],[0,1,1]],
    [[0,1,0],[1,1,0],[1,0,0]],
  ],
  J: [
    [[1,0,0],[1,1,1],[0,0,0]],
    [[0,1,1],[0,1,0],[0,1,0]],
    [[0,0,0],[1,1,1],[0,0,1]],
    [[0,1,0],[0,1,0],[1,1,0]],
  ],
  L: [
    [[0,0,1],[1,1,1],[0,0,0]],
    [[0,1,0],[0,1,0],[0,1,1]],
    [[0,0,0],[1,1,1],[1,0,0]],
    [[1,1,0],[0,1,0],[0,1,0]],
  ],
};

export const COLOR_INDEX = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };
export const TYPES = Object.keys(SHAPES);

export function getShape(piece) { return SHAPES[piece.type][piece.rot]; }

export function pieceCells(piece) {
  const shape = getShape(piece);
  const cells = [];
  for (let r = 0; r < shape.length; r++) {
    for (let c = 0; c < shape[r].length; c++) {
      if (shape[r][c]) cells.push([piece.x + c, piece.y + r]);
    }
  }
  return cells;
}

export function collides(board, piece) {
  for (const [x, y] of pieceCells(piece)) {
    if (x < 0 || x >= COLS || y >= ROWS) return true;
    if (y >= 0 && board[y][x]) return true;
  }
  return false;
}

export function ghostCells(board, piece) {
  let dy = 0;
  while (!collides(board, { ...piece, y: piece.y + dy + 1 })) dy++;
  return pieceCells({ ...piece, y: piece.y + dy });
}

export function tryMove(board, piece, dx, dy) {
  const next = { ...piece, x: piece.x + dx, y: piece.y + dy };
  if (!collides(board, next)) return next;
  return null;
}

export function tryRotate(board, piece) {
  const next = { ...piece, rot: (piece.rot + 1) % 4 };
  for (const kx of [0, -1, 1, -2, 2]) {
    const test = { ...next, x: next.x + kx };
    if (!collides(board, test)) return test;
  }
  return null;
}

export function hardDropPos(board, piece) {
  let p = piece;
  while (true) {
    const next = { ...p, y: p.y + 1 };
    if (collides(board, next)) break;
    p = next;
  }
  return p;
}
