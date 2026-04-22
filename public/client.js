import {
  COLS, ROWS, COLOR_INDEX,
  pieceCells, collides, ghostCells,
  tryMove as sharedTryMove,
  tryRotate as sharedTryRotate,
  hardDropPos,
  SHAPES,
} from './shared.js';

const BLOCK = 30;

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

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
let board = null;
let lastClearAnim = 0;
let flashUntil = 0;
let highScore = Number(localStorage.getItem('tetrisHighScore') || 0);

let myPredicted = null;   // locally predicted piece position
let inputSeq = 0;         // monotonic counter for inputs we send
let lastSentSeq = 0;      // last seq we actually sent

const roomCodeEl = document.getElementById('roomCode');
const roomMsgEl = document.getElementById('roomMsg');
const joinInput = document.getElementById('joinInput');
const joinForm = document.getElementById('joinForm');
const copyBtn = document.getElementById('copyCode');
const newRoomBtn = document.getElementById('newRoomBtn');

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
    board = msg.board;
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

function reconcileMyPiece() {
  const me = state.players.find(p => p.id === myId);
  if (!me?.piece) {
    myPredicted = null;
    return;
  }
  const server = me.piece;
  if (!myPredicted
      || myPredicted.type !== server.type
      || (me.lastSeq || 0) >= lastSentSeq) {
    // No prediction in flight: trust server completely.
    myPredicted = { type: server.type, rot: server.rot, x: server.x, y: server.y };
  }
  // Else: keep predicted state; server hasn't caught up yet.
}

function send(action, extra = null) {
  if (ws.readyState !== 1) return;
  if (['left','right','down','rotate','drop','hold'].includes(action)) {
    inputSeq++;
    lastSentSeq = inputSeq;
    const payload = { type: action, seq: inputSeq };
    if (extra) Object.assign(payload, extra);
    ws.send(JSON.stringify(payload));
  } else {
    const payload = typeof action === 'string' ? { type: action } : action;
    ws.send(JSON.stringify(payload));
  }
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
  if (!/^[A-Z2-9]{4}$/.test(code)) {
    setRoomMsg('Enter a 4-letter code', 'error');
    return;
  }
  send({ type: 'join', code });
  joinInput.value = '';
  joinInput.blur();
});

newRoomBtn.addEventListener('click', () => {
  send({ type: 'newRoom' });
  setRoomMsg('New room created', 'info');
  setTimeout(() => setRoomMsg(''), 1500);
});

joinInput.addEventListener('input', () => {
  joinInput.value = joinInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4);
});

const DAS_MS = 140;
const ARR_MS = 40;
const SOFT_DROP_REPEAT = 35;

const keyTimers = {};

function canControl() {
  return mySlot >= 0 && state?.running && myPredicted && board;
}

function attemptLocalMove(dx, dy) {
  if (!canControl()) return false;
  const next = sharedTryMove(board, myPredicted, dx, dy);
  if (next) { myPredicted = next; return true; }
  return false;
}

function attemptLocalRotate() {
  if (!canControl()) return false;
  const next = sharedTryRotate(board, myPredicted);
  if (next) { myPredicted = next; return true; }
  return false;
}

function attemptLocalHardDrop() {
  if (!canControl()) return false;
  myPredicted = hardDropPos(board, myPredicted);
  return true;
}

function doMove(action) {
  let moved = false;
  if (action === 'left')   moved = attemptLocalMove(-1, 0);
  else if (action === 'right') moved = attemptLocalMove(1, 0);
  else if (action === 'down')  moved = attemptLocalMove(0, 1);
  else if (action === 'rotate') moved = attemptLocalRotate();
  else if (action === 'drop')   moved = attemptLocalHardDrop();
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

function stopAllRepeats() {
  for (const k of Object.keys(keyTimers)) stopRepeat(k);
}

document.addEventListener('keydown', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

  if (state?.gameOver && (e.key === 'Enter' || e.key === 'r' || e.key === 'R')) {
    send({ type: 'restart' });
    return;
  }
  if (mySlot < 0) return;
  if (e.repeat) return; // we handle repeat ourselves

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
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  if (!state || !board) return;
  ctx.fillStyle = '#05080f';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = board[r][c];
      if (v) drawBlock(ctx, c * BLOCK, r * BLOCK, BLOCK, LOCKED_COLORS[v], 'rgba(0,0,0,0.35)');
      else drawGridCell(c, r);
    }
  }

  // ghosts
  for (const p of state.players) {
    if (!p.piece) continue;
    const effective = (p.id === myId && myPredicted) ? myPredicted : p.piece;
    const color = PLAYER_COLORS[p.slot] || '#fff';
    for (const [x, y] of ghostCells(board, effective)) {
      if (y < 0) continue;
      drawGhost(x, y, color);
    }
  }

  // active pieces
  for (const p of state.players) {
    if (!p.piece) continue;
    const effective = (p.id === myId && myPredicted) ? myPredicted : p.piece;
    const color = PLAYER_COLORS[p.slot] || '#fff';
    const isMe = p.id === myId;
    for (const [x, y] of pieceCells(effective)) {
      if (y < 0) continue;
      drawBlock(ctx, x * BLOCK, y * BLOCK, BLOCK, color, isMe ? '#fff' : 'rgba(255,255,255,0.4)');
    }
  }

  if (performance.now() < flashUntil) {
    const alpha = (flashUntil - performance.now()) / 220;
    ctx.fillStyle = `rgba(255,255,255,${alpha * 0.35})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    scheduleRender();
  }

  if (state.gameOver) overlay('GAME OVER', 'Press R or Enter to restart');
  else if (!state.running && state.playerCount < 2) {
    overlay(`Share code: ${myCode}`, 'Waiting for player 2…');
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

function drawGhost(x, y, color) {
  const px = x * BLOCK, py = y * BLOCK;
  ctx.fillStyle = hexToRgba(color, 0.10);
  ctx.fillRect(px, py, BLOCK, BLOCK);
  ctx.strokeStyle = hexToRgba(color, 0.55);
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(px + 2, py + 2, BLOCK - 4, BLOCK - 4);
  ctx.setLineDash([]);
}

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

function drawGridCell(x, y) {
  ctx.strokeStyle = '#0f1830';
  ctx.lineWidth = 1;
  ctx.strokeRect(x * BLOCK, y * BLOCK, BLOCK, BLOCK);
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

function overlay(title, subtitle) {
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 22px ui-sans-serif, system-ui, sans-serif';
  ctx.fillText(title, canvas.width / 2, canvas.height / 2 - 8);
  ctx.font = '14px ui-sans-serif, system-ui, sans-serif';
  ctx.fillStyle = '#cfd4e6';
  ctx.fillText(subtitle, canvas.width / 2, canvas.height / 2 + 20);
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
  if (state?.playerCount === 1) parts.push(`Alone in room ${myCode} — share the code.`);
  else if (state?.playerCount === 2 && state?.running) parts.push('Playing.');
  else if (state?.gameOver) parts.push('Game over — press R or Enter to restart.');
  else parts.push('Waiting...');
  setStatus(parts.join(' '));
}

function setStatus(text) {
  document.getElementById('statusLine').textContent = text;
}

function setRoomMsg(text, kind) {
  roomMsgEl.textContent = text;
  roomMsgEl.className = 'room-msg' + (kind === 'info' ? ' info' : '');
}
