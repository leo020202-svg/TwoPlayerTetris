import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import { WebSocketServer } from 'ws';
import {
  COLS, ROWS, COLOR_INDEX, TYPES,
  pieceCells, collides, ghostCells,
  tryMove as tryMoveShared,
  tryRotate as tryRotateShared,
  hardDropPos,
} from './public/shared.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(__dirname, 'public', urlPath);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VALID_MODES = ['shared', 'split', 'garbage', 'relay', 'duo', 'architect'];

const DUO_P1_ACTIONS = new Set(['left', 'right', 'down', 'drop']);
const DUO_P2_ACTIONS = new Set(['rotate', 'hold', 'down']);

const GAME_ACTIONS = new Set(['left', 'right', 'down', 'rotate', 'drop', 'hold']);

const GARBAGE_INTERVAL_MS = 10000;
const GARBAGE_COLOR = 8;
const SPLIT_DIVIDER_COL = 5;

const ARCHITECT_LEVELS = [
  { name: 'tiny block', pattern: [
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '....##....', '....##....', '..........',
  ]},
  { name: 'small T', pattern: [
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '...###....', '....#.....', '....#.....', '..........',
  ]},
  { name: 'plus', pattern: [
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '....#.....',
    '...###....', '....#.....', '..........', '..........',
  ]},
  { name: 'small house', pattern: [
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '....#.....', '...###....', '..#####...',
    '..#...#...', '..#####...', '..........', '..........',
  ]},
  { name: 'diamond', pattern: [
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '....#.....', '...###....', '..#####...',
    '...###....', '....#.....', '..........', '..........',
  ]},
  { name: 'small heart', pattern: [
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..#.#.....', '.#####....', '.#####....', '..###.....',
    '...#......', '..........', '..........', '..........',
  ]},
  { name: 'arrow', pattern: [
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '..........', '....##....', '...####...',
    '..######..', '.########.', '....##....', '....##....',
    '....##....', '....##....', '....##....', '..........',
  ]},
  { name: 'letter A', pattern: [
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..........', '....##....', '...####...', '..##..##..',
    '..##..##..', '..######..', '..######..', '..##..##..',
    '..##..##..', '..##..##..', '..........', '..........',
  ]},
  { name: 'heart', pattern: [
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..........',
    '..##.##...', '.#######..', '.#######..', '.#######..',
    '..#####...', '...###....', '....#.....', '..........',
    '..........', '..........', '..........', '..........',
  ]},
  { name: 'smiley', pattern: [
    '..........', '..........', '..........', '..........',
    '..........', '..........', '..........', '..########',
    '.#........', '#.........', '#..#...#..', '#.........',
    '#.#.....#.', '#..#####..', '.#........', '..########',
    '..........', '..........', '..........', '..........',
  ]},
];

function silhouetteCells(pattern) {
  const cells = [];
  for (let y = 0; y < pattern.length; y++) {
    const row = pattern[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '#') cells.push([x, y]);
    }
  }
  return cells;
}

function pickSilhouette(level) {
  const idx = (Math.max(1, level || 1) - 1) % ARCHITECT_LEVELS.length;
  const lvl = ARCHITECT_LEVELS[idx];
  return { name: lvl.name, cells: silhouetteCells(lvl.pattern) };
}

function silhouetteProgress(room) {
  if (!room.silhouette) return { filled: 0, total: 0 };
  let filled = 0;
  for (const [x, y] of room.silhouette.cells) {
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS && room.board[y][x]) filled++;
  }
  return { filled, total: room.silhouette.cells.length, name: room.silhouette.name };
}

const rooms = new Map();
let nextPlayerId = 1;

function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

function generateCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = generateCode();
  const room = {
    code,
    mode: 'shared',
    board: emptyBoard(),
    players: {},
    order: [],
    sockets: {},
    running: false,
    gameOver: false,
    score: 0,
    lines: 0,
    level: 1,
    clearAnim: 0,
    tickInterval: null,
    garbageInterval: null,
    nextGarbageAt: 0,
    activeController: null,
    silhouette: null,
    architectLevel: 1,
    architectWinAt: 0,
  };
  rooms.set(code, room);
  return room;
}

function deleteRoomIfEmpty(room) {
  if (room.order.length === 0) {
    clearRoomTimers(room);
    rooms.delete(room.code);
  }
}

function clearRoomTimers(room) {
  if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
  if (room.garbageInterval) { clearInterval(room.garbageInterval); room.garbageInterval = null; }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function ensureQueue(room, playerId) {
  const p = room.players[playerId];
  while (p.queue.length < 4) {
    if (!p.bag || p.bag.length === 0) p.bag = shuffle(TYPES);
    p.queue.push(p.bag.shift());
  }
}

function playerHalf(room, playerId) {
  const slot = room.order.indexOf(playerId);
  return slot === 0 ? [0, SPLIT_DIVIDER_COL - 1] : [SPLIT_DIVIDER_COL, COLS - 1];
}

function collidesInHalf(board, piece, halfMin, halfMax) {
  const cells = pieceCells(piece);
  let outside = 0;
  for (const [x, y] of cells) {
    if (x < 0 || x >= COLS || y >= ROWS) return true;
    if (y >= 0 && board[y][x]) return true;
    if (x < halfMin || x > halfMax) outside++;
  }
  if (outside * 2 > cells.length) return true;
  return false;
}

function tryMoveInHalf(board, piece, dx, dy, halfMin, halfMax) {
  const next = { ...piece, x: piece.x + dx, y: piece.y + dy };
  if (!collidesInHalf(board, next, halfMin, halfMax)) return next;
  return null;
}

function tryRotateInHalf(board, piece, halfMin, halfMax) {
  const next = { ...piece, rot: (piece.rot + 1) % 4 };
  for (const kx of [0, -1, 1, -2, 2]) {
    const test = { ...next, x: next.x + kx };
    if (!collidesInHalf(board, test, halfMin, halfMax)) return test;
  }
  return null;
}

function hardDropPosInHalf(board, piece, halfMin, halfMax) {
  let p = piece;
  while (true) {
    const next = { ...p, y: p.y + 1 };
    if (collidesInHalf(board, next, halfMin, halfMax)) break;
    p = next;
  }
  return p;
}

function endGameIfNeeded(room) {
  room.running = false;
  clearRoomTimers(room);
}

function spawnPiece(room, playerId, forcedType = null) {
  const p = room.players[playerId];
  ensureQueue(room, playerId);
  const type = forcedType ?? p.queue.shift();
  ensureQueue(room, playerId);
  const slot = room.order.indexOf(playerId);
  let x;
  if (room.mode === 'split') x = slot === 0 ? 1 : 6;
  else if (room.mode === 'relay' || room.mode === 'duo' || room.mode === 'architect' || room.mode === 'garbage') x = 3;
  else x = slot === 0 ? 2 : 5;
  const piece = { type, rot: 0, x, y: 0 };
  let bad = false;
  if (room.mode === 'split') {
    const [hMin, hMax] = playerHalf(room, playerId);
    bad = collidesInHalf(room.board, piece, hMin, hMax);
  } else {
    bad = collides(room.board, piece);
  }
  if (bad) {
    room.gameOver = true;
    endGameIfNeeded(room);
    return null;
  }
  return piece;
}

function resolveBoardOverlap(room, playerId) {
  const p = room.players[playerId];
  while (pieceCells(p.piece).some(([x, y]) =>
    y >= 0 && y < ROWS && x >= 0 && x < COLS && room.board[y][x]
  )) {
    p.piece = { ...p.piece, y: p.piece.y - 1 };
    if (pieceCells(p.piece).every(([, y]) => y < 0)) {
      room.gameOver = true;
      endGameIfNeeded(room);
      p.piece = null;
      return false;
    }
  }
  return true;
}

function lockPiece(room, playerId) {
  const p = room.players[playerId];
  if (!p?.piece) return;
  if (!resolveBoardOverlap(room, playerId)) return;
  const slot = room.order.indexOf(playerId);
  const color = 100 + slot;
  for (const [x, y] of pieceCells(p.piece)) {
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS) room.board[y][x] = color;
  }
  let cleared = 0;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (room.board[r].every(v => v !== 0)) {
      room.board.splice(r, 1);
      room.board.unshift(Array(COLS).fill(0));
      cleared++;
      r++;
    }
  }
  if (cleared) {
    const pts = [0, 100, 300, 500, 800][cleared] * room.level;
    p.score += pts;
    room.score += pts;
    room.lines += cleared;
    const newLevel = 1 + Math.floor(room.lines / 10);
    if (newLevel !== room.level) {
      room.level = newLevel;
      restartTick(room);
    }
    room.clearAnim = Date.now();
  }

  for (const otherId of room.order) {
    if (otherId === playerId) continue;
    const other = room.players[otherId];
    if (!other?.piece) continue;
    resolveBoardOverlap(room, otherId);
  }

  p.holdUsed = false;

  if (room.mode === 'architect' && room.silhouette) {
    const allFilled = room.silhouette.cells.every(([x, y]) =>
      y >= 0 && y < ROWS && x >= 0 && x < COLS && room.board[y][x]
    );
    if (allFilled) {
      const bonus = 500 * room.architectLevel;
      room.score += bonus;
      p.score += bonus;
      room.architectLevel += 1;
      room.silhouette = pickSilhouette(room.architectLevel);
      room.board = emptyBoard();
      room.architectWinAt = Date.now();
      for (const id of room.order) {
        const pl = room.players[id];
        pl.holdUsed = false;
        pl.piece = spawnPiece(room, id);
      }
      return;
    }
  }

  if (room.mode === 'relay') {
    p.piece = null;
    const currIdx = room.order.indexOf(playerId);
    const nextId = room.order[(currIdx + 1) % room.order.length];
    room.activeController = nextId;
    room.players[nextId].piece = spawnPiece(room, nextId);
  } else if (room.mode === 'duo') {
    const slot0Id = room.order[0];
    room.players[slot0Id].piece = spawnPiece(room, slot0Id);
  } else {
    p.piece = spawnPiece(room, playerId);
  }
}

function tickSpeedMs(room) {
  const lvl = room.level || 1;
  return Math.max(200, 650 - (lvl - 1) * 50);
}

function restartTick(room) {
  if (room.tickInterval) clearInterval(room.tickInterval);
  room.tickInterval = setInterval(() => tick(room), tickSpeedMs(room));
}

function tryPlayerMove(room, playerId, dx, dy) {
  const p = room.players[playerId];
  if (!p?.piece) return false;
  let next;
  if (room.mode === 'split') {
    const [hMin, hMax] = playerHalf(room, playerId);
    next = tryMoveInHalf(room.board, p.piece, dx, dy, hMin, hMax);
  } else {
    next = tryMoveShared(room.board, p.piece, dx, dy);
  }
  if (next) { p.piece = next; return true; }
  return false;
}

function tryPlayerRotate(room, playerId) {
  const p = room.players[playerId];
  if (!p?.piece) return false;
  let next;
  if (room.mode === 'split') {
    const [hMin, hMax] = playerHalf(room, playerId);
    next = tryRotateInHalf(room.board, p.piece, hMin, hMax);
  } else {
    next = tryRotateShared(room.board, p.piece);
  }
  if (next) { p.piece = next; return true; }
  return false;
}

function hardDrop(room, playerId) {
  const p = room.players[playerId];
  if (!p?.piece) return;
  if (room.mode === 'split') {
    const [hMin, hMax] = playerHalf(room, playerId);
    p.piece = hardDropPosInHalf(room.board, p.piece, hMin, hMax);
  } else {
    p.piece = hardDropPos(room.board, p.piece);
  }
  lockPiece(room, playerId);
}

function doHold(room, playerId) {
  const p = room.players[playerId];
  if (!p?.piece || p.holdUsed) return;
  const curType = p.piece.type;
  if (p.hold) {
    const swapType = p.hold;
    p.hold = curType;
    p.piece = spawnPiece(room, playerId, swapType);
  } else {
    p.hold = curType;
    p.piece = spawnPiece(room, playerId);
  }
  p.holdUsed = true;
}

function tick(room) {
  if (!room.running) return;
  for (const id of room.order) {
    const p = room.players[id];
    if (!p?.piece) continue;
    if (!tryPlayerMove(room, id, 0, 1)) lockPiece(room, id);
  }
  broadcast(room);
}

function raiseGarbage(room) {
  if (!room.running || room.mode !== 'garbage') {
    if (room.garbageInterval) { clearInterval(room.garbageInterval); room.garbageInterval = null; }
    return;
  }
  if (room.board[0].some(v => v)) {
    room.gameOver = true;
    endGameIfNeeded(room);
    broadcast(room);
    return;
  }
  room.board.shift();
  const hole = Math.floor(Math.random() * COLS);
  const newRow = Array(COLS).fill(GARBAGE_COLOR);
  newRow[hole] = 0;
  room.board.push(newRow);
  for (const id of room.order) {
    const p = room.players[id];
    if (p?.piece) resolveBoardOverlap(room, id);
  }
  room.nextGarbageAt = Date.now() + GARBAGE_INTERVAL_MS;
  broadcast(room);
}

function broadcast(room) {
  const payload = {
    type: 'state',
    code: room.code,
    mode: room.mode,
    board: room.board,
    players: room.order.map((id, i) => {
      const pl = room.players[id];
      return {
        id, slot: i,
        piece: pl?.piece
          ? { type: pl.piece.type, rot: pl.piece.rot, x: pl.piece.x, y: pl.piece.y }
          : null,
        hold: pl?.hold ?? null,
        next: (pl?.queue ?? []).slice(0, 3),
        score: pl?.score ?? 0,
        lastSeq: pl?.lastSeq ?? 0,
        color: pl?.color ?? null,
      };
    }),
    running: room.running,
    gameOver: room.gameOver,
    score: room.score,
    lines: room.lines,
    level: room.level,
    playerCount: room.order.length,
    clearAnim: room.clearAnim,
    tickMs: tickSpeedMs(room),
    nextGarbageAt: room.mode === 'garbage' ? room.nextGarbageAt : null,
    activeSlot: room.mode === 'relay'
      ? room.order.indexOf(room.activeController)
      : null,
    silhouette: room.mode === 'architect' && room.silhouette ? room.silhouette.cells : null,
    silhouetteProgress: room.mode === 'architect' ? silhouetteProgress(room) : null,
    architectLevel: room.mode === 'architect' ? room.architectLevel : null,
    architectWinAt: room.mode === 'architect' ? room.architectWinAt : null,
  };
  const msg = JSON.stringify(payload);
  for (const playerId of room.order) {
    const ws = room.sockets[playerId];
    if (ws && ws.readyState === 1) ws.send(msg);
  }
}

function startGame(room) {
  clearRoomTimers(room);
  room.running = true;
  room.gameOver = false;
  room.score = 0;
  room.lines = 0;
  room.level = 1;
  room.clearAnim = 0;
  room.board = emptyBoard();
  room.activeController = null;
  room.silhouette = null;
  room.nextGarbageAt = 0;

  if (room.mode === 'relay') {
    room.activeController = room.order[0];
  }
  if (room.mode === 'architect') {
    room.architectLevel = 1;
    room.architectWinAt = 0;
    room.silhouette = pickSilhouette(room.architectLevel);
  }

  for (const id of room.order) {
    const p = room.players[id];
    p.bag = shuffle(TYPES);
    p.queue = [];
    p.hold = null;
    p.holdUsed = false;
    p.score = 0;
    p.lastSeq = 0;
    p.piece = null;
    ensureQueue(room, id);
  }

  if (room.mode === 'relay') {
    const activeId = room.activeController;
    room.players[activeId].piece = spawnPiece(room, activeId);
  } else if (room.mode === 'duo') {
    const slot0Id = room.order[0];
    room.players[slot0Id].piece = spawnPiece(room, slot0Id);
  } else {
    for (const id of room.order) {
      room.players[id].piece = spawnPiece(room, id);
    }
  }

  restartTick(room);

  if (room.mode === 'garbage') {
    room.nextGarbageAt = Date.now() + GARBAGE_INTERVAL_MS;
    room.garbageInterval = setInterval(() => raiseGarbage(room), GARBAGE_INTERVAL_MS);
  }

  broadcast(room);
}

function stopGame(room) {
  clearRoomTimers(room);
  room.running = false;
}

function addPlayerToRoom(room, ws, playerId) {
  room.order.push(playerId);
  room.players[playerId] = {
    piece: null, hold: null, holdUsed: false,
    queue: [], bag: [], score: 0, lastSeq: 0, color: null,
  };
  room.sockets[playerId] = ws;
  ws.roomCode = room.code;
}

function removePlayerFromRoom(room, playerId) {
  if (!room.players[playerId]) return;
  delete room.players[playerId];
  delete room.sockets[playerId];
  room.order = room.order.filter(x => x !== playerId);
  if (room.order.length < 2) {
    stopGame(room);
    room.gameOver = false;
    room.board = emptyBoard();
    for (const id of room.order) {
      const p = room.players[id];
      p.piece = null;
    }
  }
}

function setRoomMode(room, mode) {
  if (!VALID_MODES.includes(mode)) return;
  if (room.mode === mode) return;
  room.mode = mode;
  if (room.order.length === 2) {
    startGame(room);
  } else {
    stopGame(room);
    room.gameOver = false;
    room.board = emptyBoard();
    room.silhouette = null;
    room.activeController = null;
    for (const id of room.order) {
      room.players[id].piece = null;
    }
    broadcast(room);
  }
}

function sendWelcome(ws, room, playerId) {
  ws.send(JSON.stringify({
    type: 'welcome',
    id: playerId,
    slot: room.order.indexOf(playerId),
    code: room.code,
  }));
}

function sendError(ws, message) {
  if (ws.readyState !== 1) return;
  ws.send(JSON.stringify({ type: 'error', message }));
}

function recordSeq(p, msg) {
  if (p && typeof msg.seq === 'number' && msg.seq > (p.lastSeq || 0)) {
    p.lastSeq = msg.seq;
  }
}

wss.on('connection', (ws) => {
  const playerId = String(nextPlayerId++);
  ws.playerId = playerId;

  const room = createRoom();
  addPlayerToRoom(room, ws, playerId);
  sendWelcome(ws, room, playerId);
  broadcast(room);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const currentRoom = rooms.get(ws.roomCode);
    if (!currentRoom) return;

    if (msg.type === 'join') {
      const target = typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '';
      if (!/^[A-Z2-9]{4}$/.test(target)) { sendError(ws, 'Invalid code'); return; }
      if (target === currentRoom.code) { sendError(ws, "You're already in this room"); return; }
      const targetRoom = rooms.get(target);
      if (!targetRoom) { sendError(ws, 'Room not found'); return; }
      if (targetRoom.order.length >= 2) { sendError(ws, 'Room is full'); return; }
      removePlayerFromRoom(currentRoom, playerId);
      broadcast(currentRoom);
      deleteRoomIfEmpty(currentRoom);
      addPlayerToRoom(targetRoom, ws, playerId);
      sendWelcome(ws, targetRoom, playerId);
      if (targetRoom.order.length === 2 && !targetRoom.running && !targetRoom.gameOver) {
        startGame(targetRoom);
      } else {
        broadcast(targetRoom);
      }
      return;
    }

    if (msg.type === 'newRoom') {
      removePlayerFromRoom(currentRoom, playerId);
      broadcast(currentRoom);
      deleteRoomIfEmpty(currentRoom);
      const fresh = createRoom();
      addPlayerToRoom(fresh, ws, playerId);
      sendWelcome(ws, fresh, playerId);
      broadcast(fresh);
      return;
    }

    if (msg.type === 'setMode') {
      setRoomMode(currentRoom, msg.mode);
      return;
    }

    if (msg.type === 'setColor') {
      const c = typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color)
        ? msg.color : null;
      const p = currentRoom.players[playerId];
      if (p) {
        p.color = c;
        broadcast(currentRoom);
      }
      return;
    }

    if (msg.type === 'restart' && currentRoom.gameOver) {
      if (currentRoom.order.length >= 2) startGame(currentRoom);
      return;
    }

    if (!currentRoom.running) return;

    let effectiveId = playerId;

    if (currentRoom.mode === 'relay') {
      if (playerId !== currentRoom.activeController) return;
    } else if (currentRoom.mode === 'duo' && GAME_ACTIONS.has(msg.type)) {
      const senderSlot = currentRoom.order.indexOf(playerId);
      const allowed = senderSlot === 0 ? DUO_P1_ACTIONS : DUO_P2_ACTIONS;
      if (!allowed.has(msg.type)) return;
      effectiveId = currentRoom.order[0];
    }

    const p = currentRoom.players[effectiveId];
    if (!p) return;
    recordSeq(p, msg);

    switch (msg.type) {
      case 'left':   tryPlayerMove(currentRoom, effectiveId, -1, 0); break;
      case 'right':  tryPlayerMove(currentRoom, effectiveId,  1, 0); break;
      case 'down':   tryPlayerMove(currentRoom, effectiveId,  0, 1); break;
      case 'rotate': tryPlayerRotate(currentRoom, effectiveId); break;
      case 'drop':   hardDrop(currentRoom, effectiveId); break;
      case 'hold':   doHold(currentRoom, effectiveId); break;
      default: return;
    }
    broadcast(currentRoom);
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    removePlayerFromRoom(room, playerId);
    broadcast(room);
    deleteRoomIfEmpty(room);
  });
});

server.listen(PORT, () => {
  console.log(`Co-op Tetris running at http://localhost:${PORT}`);
});
