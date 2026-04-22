import {
  COLS, ROWS, COLOR_INDEX,
  pieceCells, ghostCells,
  tryMove as sharedTryMove,
  tryRotate as sharedTryRotate,
  hardDropPos,
} from './shared.js';

const BLOCK_SHARED = 30;
const BLOCK_SPLIT = 24;

const canvas1 = document.getElementById('board');
const ctx1 = canvas1.getContext('2d');
const canvas2 = document.getElementById('board2');
const ctx2 = canvas2.getContext('2d');

const LOCKED_COLORS = [
  '#05080f',
  '#4ccfff', '#ffd93d', '#c77dff', '#7ae582', '#ff5c7a', '#5c7aff', '#ff9f43',
];

const PLAYER_COLORS = ['#4ccfff', '#ff4d6d'];

const SHAPES_PREVIEW = {
  I: [[1,1,1,1]],
  O: [[1,1],[1,1]],
  T: [[0,1,0],[1,1,1]],
  S: [[0,1,1],[1,1,0]],
  Z: [[1,1,0],[0,1,1]],
  J: [[1,0,0],[1,1,1]],
  L: [[0,0,1],[1,1,1]],
};

let myId = null;
let mySlot = -1;
let myCode = '----';
let state = null;
let lastClearAnim = 0;
let flashUntil = 0;
let highScore = Number(localStorage.getItem('tetrisHighScore') || 0);

let myPredicted = null;
let inputSeq = 0;
let lastSentSeq = 0;

const roomCodeEl = document.getElementById('roomCode');
const roomMsgEl = document.getElementById('roomMsg');
const joinInput = document.getElementById('joinInput');
const joinForm = document.getElementById('joinForm');
const copyBtn = document.getElementById('copyCode');
const newRoomBtn = document.getElementById('newRoomBtn');
const modeSharedBtn = document.getElementById('modeShared');
const modeSplitBtn = document.getElementById('modeSplit');
const gameAreaEl = document.querySelector('.gameArea');

document.getElementById('highScore').textContent = highScore;

const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProto}//${location.host}`);

ws.addEventListener('open', () => setStatus('Connecting...'));
ws.addEventListener('close', () => setStatus('Disconnected. Refresh to reconnect.'));

ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'welcome') {
    myId = msg.id;
    mySlot = msg.slot;
    myCode = msg.code;
    roomCodeEl.textContent = myCode;
    document.getElementById('p1You').hidden = mySlot !== 0;
    document.getElementById('p2You').hidden = mySlot !== 1;
    myPredicted = null;
    inputSeq = 0;
    lastSentSeq = 0;
    setRoomMsg('');
  } else if (msg.type === 'error') {
    setRoomMsg(msg.message, 'error');
  } else if (msg.type === 'state') {
    state = msg;
    applyModeLayout(state.mode);
    if (state.code && state.code !== myCode) {
      myCode = state.code;
      roomCodeEl.textContent = myCode;
    }
    if (state.clearAnim && state.clearAnim !== lastClearAnim) {
      lastClearAnim = state.clearAnim;
      flashUntil = performance.now() + 220;
    }
    if (state.score > highScore) {
      highScore = state.score;
      localStorage.setItem('tetrisHighScore', String(highScore));
    }
    reconcileMyPiece();
    scheduleRender();
    updateHUD();
  }
});

function applyModeLayout(mode) {
  if (mode === 'split') {
    gameAreaEl.classList.add('split');
    canvas2.hidden = false;
    setCanvasSize(canvas1, BLOCK_SPLIT);
    setCanvasSize(canvas2, BLOCK_SPLIT);
  } else {
    gameAreaEl.classList.remove('split');
    canvas2.hidden = true;
    setCanvasSize(canvas1, BLOCK_SHARED);
  }
  modeSharedBtn.classList.toggle('active', mode !== 'split');
  modeSplitBtn.classList.toggle('active', mode === 'split');
}

function setCanvasSize(c, block) {
  c.width = COLS * block;
  c.height = ROWS * block;
  c.style.width = (COLS * block) + 'px';
  c.style.height = (ROWS * block) + 'px';
}

function boardForSlot(slot) {
  if (!state) return null;
  if (state.mode === 'split') return state.players[slot]?.board ?? null;
  return state.board;
}

function myBoard() {
  return boardForSlot(mySlot);
}

function reconcileMyPiece() {
  const me = state.players.find(p => p.id === myId);
  if (!me?.piece) { myPredicted = null; return; }
  const server = me.piece;
  if (!myPredicted
      || myPredicted.type !== server.type
      || (me.lastSeq || 0) >= lastSentSeq) {
    myPredicted = { type: server.type, rot: server.rot, x: server.x, y: server.y };
  }
}

function send(payload) {
  if (ws.readyState !== 1) return;
  const obj = typeof payload === 'string' ? { type: payload } : payload;
  const action = obj.type;
  if (['left','right','down','rotate','drop','hold'].includes(action)) {
    inputSeq++;
    lastSentSeq = inputSeq;
    obj.seq = inputSeq;
  }
  ws.send(JSON.stringify(obj));
}

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(myCode);
    setRoomMsg('Code copied', 'info');
    setTimeout(() => setRoomMsg(''), 1500);
  } catch {
    setRoomMsg('Copy failed — select the code manually', 'error');
  }
});

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = joinInput.value.trim().toUpperCase();
  if (!/^[A-Z2-9]{4}$/.test(code)) { setRoomMsg('Enter a 4-letter code', 'error'); return; }
  send({ type: 'join', code });
  joinInput.value = '';
  joinInput.blur();
});

newRoomBtn.addEventListener('click', () => {
  send({ type: 'newRoom' });
  setRoomMsg('New room created', 'info');
  setTimeout(() => setRoomMsg(''), 1500);
});

modeSharedBtn.addEventListener('click', () => send({ type: 'setMode', mode: 'shared' }));
modeSplitBtn.addEventListener('click', () => send({ type: 'setMode', mode: 'split' }));

joinInput.addEventListener('input', () => {
  joinInput.value = joinInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4);
});

const DAS_MS = 140;
const ARR_MS = 40;
const SOFT_DROP_REPEAT = 35;
const keyTimers = {};

function canControl() {
  return mySlot >= 0 && state?.running && myPredicted && myBoard();
}

function attemptLocalMove(dx, dy) {
  if (!canControl()) return false;
  const next = sharedTryMove(myBoard(), myPredicted, dx, dy);
  if (next) { myPredicted = next; return true; }
  return false;
}

function attemptLocalRotate() {
  if (!canControl()) return false;
  const next = sharedTryRotate(myBoard(), myPredicted);
  if (next) { myPredicted = next; return true; }
  return false;
}

function attemptLocalHardDrop() {
  if (!canControl()) return false;
  myPredicted = hardDropPos(myBoard(), myPredicted);
  return true;
}

function doMove(action) {
  let moved = false;
  if (action === 'left') moved = attemptLocalMove(-1, 0);
  else if (action === 'right') moved = attemptLocalMove(1, 0);
  else if (action === 'down') moved = attemptLocalMove(0, 1);
  else if (action === 'rotate') moved = attemptLocalRotate();
  else if (action === 'drop') moved = attemptLocalHardDrop();
  send(action);
  if (moved) scheduleRender();
}

function startRepeat(key, action, softDrop = false) {
  stopRepeat(key);
  doMove(action);
  const delay = softDrop ? SOFT_DROP_REPEAT : DAS_MS;
  keyTimers[key] = {
    timeout: setTimeout(() => {
      keyTimers[key] = {
        interval: setInterval(() => doMove(action), softDrop ? SOFT_DROP_REPEAT : ARR_MS),
      };
    }, delay),
  };
}

function stopRepeat(key) {
  const t = keyTimers[key];
  if (!t) return;
  if (t.timeout) clearTimeout(t.timeout);
  if (t.interval) clearInterval(t.interval);
  delete keyTimers[key];
}

function stopAllRepeats() { for (const k of Object.keys(keyTimers)) stopRepeat(k); }

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (state?.gameOver && (e.key === 'Enter' || e.key === 'r' || e.key === 'R')) {
    send({ type: 'restart' }); return;
  }
  if (mySlot < 0) return;
  if (e.repeat) return;
  const k = e.key;
  if (k === 'ArrowLeft'  || k === 'a' || k === 'A') { startRepeat('L', 'left');  e.preventDefault(); }
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') { startRepeat('R', 'right'); e.preventDefault(); }
  else if (k === 'ArrowDown'  || k === 's' || k === 'S') { startRepeat('D', 'down', true); e.preventDefault(); }
  else if (k === 'ArrowUp'    || k === 'w' || k === 'W') { doMove('rotate'); e.preventDefault(); }
  else if (k === ' ') { doMove('drop'); e.preventDefault(); }
  else if (k === 'c' || k === 'C' || k === 'Shift') { doMove('hold'); e.preventDefault(); }
});

document.addEventListener('keyup', (e) => {
  const k = e.key;
  if (k === 'ArrowLeft'  || k === 'a' || k === 'A') stopRepeat('L');
  else if (k === 'ArrowRight' || k === 'd' || k === 'D') stopRepeat('R');
  else if (k === 'ArrowDown'  || k === 's' || k === 'S') stopRepeat('D');
});

window.addEventListener('blur', stopAllRepeats);

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}

function renderBoardOnCanvas(canvas, ctx, board, pieces, block, isMySideIdx) {
  ctx.fillStyle = '#05080f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!board) return;

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = board[r][c];
      if (v) drawBlock(ctx, c * block, r * block, block, LOCKED_COLORS[v], 'rgba(0,0,0,0.35)');
      else drawGridCell(ctx, c, r, block);
    }
  }

  for (const p of pieces) {
    const effective = p.isMe ? myPredicted : p.piece;
    if (!effective) continue;
    const color = PLAYER_COLORS[p.slot] || '#fff';
    for (const [x, y] of ghostCells(board, effective)) {
      if (y < 0) continue;
      drawGhost(ctx, x, y, color, block);
    }
  }

  for (const p of pieces) {
    const effective = p.isMe ? myPredicted : p.piece;
    if (!effective) continue;
    const color = PLAYER_COLORS[p.slot] || '#fff';
    for (const [x, y] of pieceCells(effective)) {
      if (y < 0) continue;
      drawBlock(ctx, x * block, y * block, block, color, p.isMe ? '#fff' : 'rgba(255,255,255,0.4)');
    }
  }

  if (performance.now() < flashUntil) {
    const alpha = (flashUntil - performance.now()) / 220;
    ctx.fillStyle = `rgba(255,255,255,${alpha * 0.35})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    scheduleRender();
  }

  const p = state.players[isMySideIdx];
  if (state.mode === 'split' && p?.gameOver && !state.gameOver) {
    overlayOn(ctx, canvas, 'TOPPED OUT', 'Waiting for other player...');
  } else if (state.gameOver) {
    overlayOn(ctx, canvas, 'GAME OVER', 'Press R or Enter to restart');
  } else if (!state.running && state.playerCount < 2 && isMySideIdx === mySlot) {
    overlayOn(ctx, canvas, `Share code: ${myCode}`, 'Waiting for player 2…');
  }
}

function render() {
  if (!state) return;

  if (state.mode === 'split') {
    const boards = [state.players[0]?.board, state.players[1]?.board];
    for (let slot = 0; slot < 2; slot++) {
      const c = slot === 0 ? canvas1 : canvas2;
      const ctx = slot === 0 ? ctx1 : ctx2;
      const pieceInfo = state.players[slot]
        ? [{ piece: state.players[slot].piece, slot, isMe: state.players[slot].id === myId }]
        : [];
      renderBoardOnCanvas(c, ctx, boards[slot] || null, pieceInfo, BLOCK_SPLIT, slot);
    }
  } else {
    const board = state.board;
    const pieces = state.players.map(p => ({
      piece: p.piece, slot: p.slot, isMe: p.id === myId,
    }));
    renderBoardOnCanvas(canvas1, ctx1, board, pieces, BLOCK_SHARED, mySlot);
  }

  for (let slot = 0; slot < 2; slot++) {
    const pl = state.players[slot];
    const prefix = `p${slot + 1}`;
    drawPreview(`${prefix}Hold`, pl?.hold, PLAYER_COLORS[slot]);
    for (let i = 0; i < 3; i++) {
      drawPreview(`${prefix}Next${i}`, pl?.next?.[i], PLAYER_COLORS[slot]);
    }
  }
}

function drawBlock(g, px, py, size, fill, stroke) {
  g.fillStyle = fill;
  g.fillRect(px, py, size, size);
  g.strokeStyle = stroke;
  g.lineWidth = 2;
  g.strokeRect(px + 1, py + 1, size - 2, size - 2);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(px + 2, py + 2, size - 4, Math.max(3, Math.floor(size * 0.15)));
}

function drawGhost(g, x, y, color, block) {
  const px = x * block, py = y * block;
  g.fillStyle = hexToRgba(color, 0.10);
  g.fillRect(px, py, block, block);
  g.strokeStyle = hexToRgba(color, 0.55);
  g.lineWidth = 2;
  g.setLineDash([4, 3]);
  g.strokeRect(px + 2, py + 2, block - 4, block - 4);
  g.setLineDash([]);
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

function drawGridCell(g, x, y, block) {
  g.strokeStyle = '#0f1830';
  g.lineWidth = 1;
  g.strokeRect(x * block, y * block, block, block);
}

function drawPreview(canvasId, type, accent) {
  const c = document.getElementById(canvasId);
  if (!c) return;
  const g = c.getContext('2d');
  g.fillStyle = '#05080f';
  g.fillRect(0, 0, c.width, c.height);
  if (!type) return;
  const shape = SHAPES_PREVIEW[type];
  const h = shape.length, w = shape[0].length;
  const cell = Math.floor(Math.min((c.width - 12) / w, (c.height - 12) / h));
  const ox = Math.floor((c.width - cell * w) / 2);
  const oy = Math.floor((c.height - cell * h) / 2);
  const fill = LOCKED_COLORS[COLOR_INDEX[type]] || accent;
  for (let r = 0; r < h; r++) {
    for (let col = 0; col < w; col++) {
      if (!shape[r][col]) continue;
      drawBlock(g, ox + col * cell, oy + r * cell, cell, fill, 'rgba(0,0,0,0.35)');
    }
  }
}

function overlayOn(g, c, title, subtitle) {
  g.fillStyle = 'rgba(0,0,0,0.7)';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.font = 'bold 18px ui-sans-serif, system-ui, sans-serif';
  g.fillText(title, c.width / 2, c.height / 2 - 6);
  g.font = '12px ui-sans-serif, system-ui, sans-serif';
  g.fillStyle = '#cfd4e6';
  g.fillText(subtitle, c.width / 2, c.height / 2 + 16);
}

function updateHUD() {
  document.getElementById('teamScore').textContent = state?.score ?? 0;
  document.getElementById('lines').textContent = state?.lines ?? 0;
  document.getElementById('level').textContent = state?.level ?? 1;
  document.getElementById('highScore').textContent = highScore;
  document.getElementById('p1Score').textContent = state?.players?.[0]?.score ?? 0;
  document.getElementById('p2Score').textContent = state?.players?.[1]?.score ?? 0;

  const parts = [];
  if (mySlot === 0) parts.push('You are Player 1 (cyan).');
  else if (mySlot === 1) parts.push('You are Player 2 (pink).');
  if (state?.mode === 'split') parts.push('Split mode: each player has their own board.');
  else parts.push('Shared mode: same board, pieces pass through.');
  if (state?.playerCount === 1) parts.push(`Share code ${myCode} to start.`);
  else if (state?.playerCount === 2 && state?.running) parts.push('Playing.');
  else if (state?.gameOver) parts.push('Game over — press R or Enter to restart.');
  setStatus(parts.join(' '));
}

function setStatus(text) {
  document.getElementById('statusLine').textContent = text;
}

function setRoomMsg(text, kind) {
  roomMsgEl.textContent = text;
  roomMsgEl.className = 'room-msg' + (kind === 'info' ? ' info' : '');
}
