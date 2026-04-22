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
  };
  rooms.set(code, room);
  return room;
}

function deleteRoomIfEmpty(room) {
  if (room.order.length === 0) {
    if (room.tickInterval) clearInterval(room.tickInterval);
    rooms.delete(room.code);
  }
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

function boardFor(room, playerId) {
  return room.mode === 'split' ? room.players[playerId].board : room.board;
}

function endGameIfNeeded(room) {
  if (room.mode === 'split') {
    const allDone = room.order.length > 0 && room.order.every(id => room.players[id].gameOver);
    if (allDone) {
      room.gameOver = true;
      room.running = false;
      if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
    }
  } else {
    room.running = false;
    if (room.tickInterval) { clearInterval(room.tickInterval); room.tickInterval = null; }
  }
}

function spawnPiece(room, playerId, forcedType = null) {
  const p = room.players[playerId];
  ensureQueue(room, playerId);
  const type = forcedType ?? p.queue.shift();
  ensureQueue(room, playerId);
  const slot = room.order.indexOf(playerId);
  const x = room.mode === 'split' ? 3 : (slot === 0 ? 2 : 5);
  const piece = { type, rot: 0, x, y: 0 };
  const board = boardFor(room, playerId);
  if (collides(board, piece)) {
    if (room.mode === 'split') {
      p.gameOver = true;
      endGameIfNeeded(room);
    } else {
      room.gameOver = true;
      endGameIfNeeded(room);
    }
    return null;
  }
  return piece;
}

function resolveBoardOverlap(room, playerId) {
  const p = room.players[playerId];
  const board = boardFor(room, playerId);
  while (pieceCells(p.piece).some(([x, y]) =>
    y >= 0 && y < ROWS && x >= 0 && x < COLS && board[y][x]
  )) {
    p.piece = { ...p.piece, y: p.piece.y - 1 };
    if (pieceCells(p.piece).every(([, y]) => y < 0)) {
      if (room.mode === 'split') {
        p.gameOver = true;
        endGameIfNeeded(room);
      } else {
        room.gameOver = true;
        endGameIfNeeded(room);
      }
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
  const board = boardFor(room, playerId);
  const color = COLOR_INDEX[p.piece.type];
  for (const [x, y] of pieceCells(p.piece)) {
    if (y >= 0 && y < ROWS && x >= 0 && x < COLS) board[y][x] = color;
  }
  let cleared = 0;
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r].every(v => v !== 0)) {
      board.splice(r, 1);
      board.unshift(Array(COLS).fill(0));
      cleared++;
      r++;
    }
  }
  if (cleared) {
    if (room.mode === 'split') {
      const pts = [0, 100, 300, 500, 800][cleared] * (p.level || 1);
      p.score += pts;
      p.lines = (p.lines || 0) + cleared;
      const newLevel = 1 + Math.floor(p.lines / 10);
      if (newLevel !== p.level) {
        p.level = newLevel;
        restartTick(room);
      }
      room.score = room.order.reduce((s, id) => s + (room.players[id].score || 0), 0);
      room.lines = room.order.reduce((s, id) => s + (room.players[id].lines || 0), 0);
      room.level = Math.max(...room.order.map(id => room.players[id].level || 1));
    } else {
      const pts = [0, 100, 300, 500, 800][cleared] * room.level;
      p.score += pts;
      room.score += pts;
      room.lines += cleared;
      const newLevel = 1 + Math.floor(room.lines / 10);
      if (newLevel !== room.level) {
        room.level = newLevel;
        restartTick(room);
      }
    }
    room.clearAnim = Date.now();
  }
  if (room.mode === 'shared') {
    for (const otherId of room.order) {
      if (otherId === playerId) continue;
      const other = room.players[otherId];
      if (!other?.piece) continue;
      resolveBoardOverlap(room, otherId);
    }
  }
  p.holdUsed = false;
  p.piece = spawnPiece(room, playerId);
}

function tickSpeedMs(room) {
  const lvl = room.level || 1;
  return Math.max(100, 650 - (lvl - 1) * 55);
}

function restartTick(room) {
  if (room.tickInterval) clearInterval(room.tickInterval);
  room.tickInterval = setInterval(() => tick(room), tickSpeedMs(room));
}

function tryPlayerMove(room, playerId, dx, dy) {
  const p = room.players[playerId];
  if (!p?.piece || p.gameOver) return false;
  const next = tryMoveShared(boardFor(room, playerId), p.piece, dx, dy);
  if (next) { p.piece = next; return true; }
  return false;
}

function tryPlayerRotate(room, playerId) {
  const p = room.players[playerId];
  if (!p?.piece || p.gameOver) return false;
  const next = tryRotateShared(boardFor(room, playerId), p.piece);
  if (next) { p.piece = next; return true; }
  return false;
}

function hardDrop(room, playerId) {
  const p = room.players[playerId];
  if (!p?.piece || p.gameOver) return;
  p.piece = hardDropPos(boardFor(room, playerId), p.piece);
  lockPiece(room, playerId);
}

function doHold(room, playerId) {
  const p = room.players[playerId];
  if (!p?.piece || p.holdUsed || p.gameOver) return;
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
    if (p.gameOver) continue;
    if (!tryPlayerMove(room, id, 0, 1)) lockPiece(room, id);
  }
  broadcast(room);
}

function broadcast(room) {
  const payload = {
    type: 'state',
    code: room.code,
    mode: room.mode,
    board: room.mode === 'shared' ? room.board : null,
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
        board: room.mode === 'split' ? pl?.board : null,
        lines: room.mode === 'split' ? (pl?.lines ?? 0) : null,
        level: room.mode === 'split' ? (pl?.level ?? 1) : null,
        gameOver: pl?.gameOver ?? false,
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
  };
  const msg = JSON.stringify(payload);
  for (const playerId of room.order) {
    const ws = room.sockets[playerId];
    if (ws && ws.readyState === 1) ws.send(msg);
  }
}

function startGame(room) {
  room.running = true;
  room.gameOver = false;
  room.score = 0;
  room.lines = 0;
  room.level = 1;
  room.clearAnim = 0;
  room.board = emptyBoard();
  for (const id of room.order) {
    const p = room.players[id];
    p.bag = shuffle(TYPES);
    p.queue = [];
    p.hold = null;
    p.holdUsed = false;
    p.score = 0;
    p.lastSeq = 0;
    p.board = emptyBoard();
    p.lines = 0;
    p.level = 1;
    p.gameOver = false;
    ensureQueue(room, id);
    p.piece = spawnPiece(room, id);
  }
  restartTick(room);
  broadcast(room);
}

function stopGame(room) {
  if (room.tickInterval) clearInterval(room.tickInterval);
  room.tickInterval = null;
  room.running = false;
}

function addPlayerToRoom(room, ws, playerId) {
  room.order.push(playerId);
  room.players[playerId] = {
    piece: null, hold: null, holdUsed: false,
    queue: [], bag: [], score: 0, lastSeq: 0,
    board: emptyBoard(), lines: 0, level: 1, gameOver: false,
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
      p.board = emptyBoard();
      p.lines = 0;
      p.level = 1;
      p.gameOver = false;
    }
  }
}

function setRoomMode(room, mode) {
  if (mode !== 'shared' && mode !== 'split') return;
  if (room.mode === mode) return;
  room.mode = mode;
  if (room.order.length === 2) {
    startGame(room);
  } else {
    stopGame(room);
    room.gameOver = false;
    room.board = emptyBoard();
    for (const id of room.order) {
      const p = room.players[id];
      p.board = emptyBoard();
      p.lines = 0;
      p.level = 1;
      p.gameOver = false;
      p.piece = null;
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
      const newMode = msg.mode === 'split' ? 'split' : 'shared';
      setRoomMode(currentRoom, newMode);
      return;
    }

    if (msg.type === 'restart' && currentRoom.gameOver) {
      if (currentRoom.order.length >= 2) startGame(currentRoom);
      return;
    }

    if (!currentRoom.running) return;
    const p = currentRoom.players[playerId];
    if (!p) return;

    recordSeq(p, msg);

    switch (msg.type) {
      case 'left':   tryPlayerMove(currentRoom, playerId, -1, 0); break;
      case 'right':  tryPlayerMove(currentRoom, playerId,  1, 0); break;
      case 'down':   tryPlayerMove(currentRoom, playerId,  0, 1); break;
      case 'rotate': tryPlayerRotate(currentRoom, playerId); break;
      case 'drop':   hardDrop(currentRoom, playerId); break;
      case 'hold':   doHold(currentRoom, playerId); break;
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
