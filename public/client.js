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
  '#6b7280',
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

const MODE_BLURBS = {
  shared: 'Shared field: one board, pieces pass through each other mid-flight.',
  split: 'Split (1v1): each player has their own 10×20 board side by side.',
  garbage: 'Garbage Survival: every 10 seconds, a new garbage row rises from the bottom. Keep the stack down.',
  relay: 'Relay: one piece at a time. Control alternates after every lock.',
  duo: 'Duo Controls: one shared piece. P1 moves and hard-drops, P2 rotates and holds.',
  architect: 'Architect: fill the dashed target silhouette together. No win/lose — just collaborate.',
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
const modeGarbageBtn = document.getElementById('modeGarbage');
const modeRelayBtn = document.getElementById('modeRelay');
const modeDuoBtn = document.getElementById('modeDuo');
const modeArchitectBtn = document.getElementById('modeArchitect');
const modeBannerEl = document.getElementById('modeBanner');
const controlsDefaultEl = document.getElementById('controlsDefault');
const controlsDuoEl = document.getElementById('controlsDuo');
const modeBlurbEl = document.getElementById('modeBlurb');
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
  const modes = ['shared', 'split', 'garbage', 'relay', 'duo', 'architect'];
  for (const m of modes) gameAreaEl.classList.remove(`mode-${m}`);
  gameAreaEl.classList.add(`mode-${mode}`);

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

  [modeSharedBtn, modeSplitBtn, modeGarbageBtn, modeRelayBtn, modeDuoBtn, modeArchitectBtn]
    .forEach(b => b && b.classList.remove('active'));
  const activeBtn = {
    shared: modeSharedBtn, split: modeSplitBtn,
    garbage: modeGarbageBtn, relay: modeRelayBtn,
    duo: modeDuoBtn, architect: modeArchitectBtn,
  }[mode];
  if (activeBtn) activeBtn.classList.add('active');

  controlsDefaultEl.hidden = mode === 'duo';
  controlsDuoEl.hidden = mode !== 'duo';

  modeBlurbEl.textContent = MODE_BLURBS[mode] || '';
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
  if (state?.mode === 'duo') {
    const slot0 = state.players.find(p => p.slot === 0);
    const srv = slot0?.piece;
    myPredicted = srv ? { ...srv } : null;
    return;
  }
  if (state?.mode === 'relay') {
    if (state.activeSlot !== mySlot) { myPredicted = null; return; }
    const me = state.players.find(p => p.id === myId);
    const srv = me?.piece;
    if (!srv) { myPredicted = null; return; }
    if (!myPredicted || myPredicted.type !== srv.type || (me.lastSeq || 0) >= lastSentSeq) {
      myPredicted = { ...srv };
    }
    return;
  }
  const me = state.players.find(p => p.id === myId);
  if (!me?.piece) { myPredicted = null; return; }
  const srv = me.piece;
  if (!myPredicted
      || myPredicted.type !== srv.type
      || (me.lastSeq || 0) >= lastSentSeq) {
    myPredicted = { type: srv.type, rot: srv.rot, x: srv.x, y: srv.y };
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
modeGarbageBtn.addEventListener('click', () => send({ type: 'setMode', mode: 'garbage' }));
modeRelayBtn.addEventListener('click', () => send({ type: 'setMode', mode: 'relay' }));
modeDuoBtn.addEventListener('click', () => send({ type: 'setMode', mode: 'duo' }));
modeArchitectBtn.addEventListener('click', () => send({ type: 'setMode', mode: 'architect' }));

joinInput.addEventListener('input', () => {
  joinInput.value = joinInput.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 4);
});

const DAS_MS = 140;
const ARR_MS = 40;
const SOFT_DROP_REPEAT = 35;
const keyTimers = {};

function canControl() {
  if (mySlot < 0 || !state?.running) return false;
  if (state.mode === 'relay' && state.activeSlot !== mySlot) return false;
  if (!myBoard()) return false;
  return true;
}

function isDuoActionAllowed(action) {
  if (state?.mode !== 'duo') return true;
  const allowedP1 = new Set(['left', 'right', 'down', 'drop']);
  const allowedP2 = new Set(['rotate', 'hold', 'down']);
  return mySlot === 0 ? allowedP1.has(action) : allowedP2.has(action);
}

function attemptLocalMove(dx, dy) {
  if (!canControl() || !myPredicted) return false;
  if (state.mode === 'duo') return false;
  const next = sharedTryMove(myBoard(), myPredicted, dx, dy);
  if (next) { myPredicted = next; return true; }
  return false;
}

function attemptLocalRotate() {
  if (!canControl() || !myPredicted) return false;
  if (state.mode === 'duo') return false;
  const next = sharedTryRotate(myBoard(), myPredicted);
  if (next) { myPredicted = next; return true; }
  return false;
}

function attemptLocalHardDrop() {
  if (!canControl() || !myPredicted) return false;
  if (state.mode === 'duo') return false;
  myPredicted = hardDropPos(myBoard(), myPredicted);
  return true;
}

function doMove(action) {
  if (!isDuoActionAllowed(action)) return;
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

  if (state.mode === 'architect' && state.silhouette) {
    for (const [x, y] of state.silhouette) {
      if (y < 0 || y >= ROWS || x < 0 || x >= COLS) continue;
      const filled = board[y][x];
      drawSilhouetteCell(ctx, x, y, block, filled);
    }
  }

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const v = board[r][c];
      if (v) drawBlock(ctx, c * block, r * block, block, LOCKED_COLORS[v] || '#888', 'rgba(0,0,0,0.35)');
      else if (state.mode !== 'architect' || !isSilhouetteCell(c, r)) drawGridCell(ctx, c, r, block);
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

function isSilhouetteCell(x, y) {
  if (!state?.silhouette) return false;
  return state.silhouette.some(([sx, sy]) => sx === x && sy === y);
}

function drawSilhouetteCell(g, x, y, block, satisfied) {
  const px = x * block, py = y * block;
  g.fillStyle = satisfied ? 'rgba(255,217,61,0.10)' : 'rgba(255,255,255,0.04)';
  g.fillRect(px, py, block, block);
  g.strokeStyle = satisfied ? 'rgba(255,217,61,0.7)' : 'rgba(255,255,255,0.22)';
  g.lineWidth = 1;
  g.setLineDash([3, 2]);
  g.strokeRect(px + 1.5, py + 1.5, block - 3, block - 3);
  g.setLineDash([]);
}

function render() {
  if (!state) return;

  updateModeBanner();

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
    let pieces;
    if (state.mode === 'duo' || state.mode === 'relay') {
      const active = state.players.find(p => p.piece);
      pieces = active ? [{ piece: active.piece, slot: active.slot, isMe: active.id === myId }] : [];
    } else {
      pieces = state.players.map(p => ({
        piece: p.piece, slot: p.slot, isMe: p.id === myId,
      }));
    }
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

let bannerTickHandle = null;
function updateModeBanner() {
  if (!state) { modeBannerEl.hidden = true; return; }
  let text = '';
  let kind = '';
  if (state.mode === 'garbage' && state.running && state.nextGarbageAt) {
    const ms = Math.max(0, state.nextGarbageAt - Date.now());
    const s = Math.ceil(ms / 1000);
    text = `NEXT GARBAGE IN ${s}s`;
    kind = 'garbage';
  } else if (state.mode === 'relay' && state.running && typeof state.activeSlot === 'number') {
    if (state.activeSlot === mySlot) {
      text = 'YOUR TURN';
      kind = mySlot === 0 ? 'relay-p1' : 'relay-p2';
    } else {
      text = `PLAYER ${state.activeSlot + 1}'S TURN`;
      kind = 'relay-wait';
    }
  } else if (state.mode === 'architect' && state.silhouetteProgress) {
    const { filled, total } = state.silhouetteProgress;
    text = `ARCHITECT: ${filled} / ${total} cells`;
    kind = 'architect';
  } else if (state.mode === 'duo' && state.running) {
    text = mySlot === 0
      ? 'YOU: MOVE + HARD DROP  (P2: rotate + hold)'
      : mySlot === 1
      ? 'YOU: ROTATE + HOLD  (P1: move + hard drop)'
      : 'Duo Controls';
    kind = 'duo';
  }
  modeBannerEl.textContent = text;
  modeBannerEl.className = 'mode-banner' + (kind ? ` ${kind}` : '');
  modeBannerEl.hidden = !text;

  if (state.mode === 'garbage' && state.running) {
    if (!bannerTickHandle) {
      bannerTickHandle = setInterval(() => {
        if (state?.mode === 'garbage' && state?.running) updateModeBanner();
        else { clearInterval(bannerTickHandle); bannerTickHandle = null; }
      }, 250);
    }
  } else if (bannerTickHandle) {
    clearInterval(bannerTickHandle);
    bannerTickHandle = null;
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
  g.font = 'bold 22px ui-sans-serif, system-ui, sans-serif';
  g.fillText(title, c.width / 2, c.height / 2 - 8);
  g.font = '14px ui-sans-serif, system-ui, sans-serif';
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
