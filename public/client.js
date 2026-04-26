import {
  COLS, ROWS, COLOR_INDEX,
  pieceCells, ghostCells,
  tryMove as sharedTryMove,
  tryRotate as sharedTryRotate,
  hardDropPos,
} from './shared.js';

const BLOCK = 30;
const SPLIT_DIVIDER_COL = 5;

const canvas1 = document.getElementById('board');
const ctx1 = canvas1.getContext('2d');
const canvas2 = document.getElementById('board2');
if (canvas2) canvas2.hidden = true;

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
  split: 'Split: one board, divided down the middle. P1 plays the left 5 columns, P2 the right 5. Fill full 10-wide rows together to clear lines.',
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
let lastArchitectWinAt = 0;
let architectCelebrateUntil = 0;
let highScore = Number(localStorage.getItem('tetrisHighScore') || 0);

let myPredicted = null;
let inputSeq = 0;
let lastSentSeq = 0;
let lastWasGameOver = false;
let localGravityInterval = null;
let localGravityMs = null;
let lastSavedKey = null;
let playerName = (localStorage.getItem('tetrisPlayerName') || '').slice(0, 20);

const LEADERBOARD_KEY = 'tetrisLeaderboard';
const MAX_LEADERBOARD = 50;

const MODE_LABELS = {
  shared: 'Shared',
  split: 'Split',
  garbage: 'Garbage',
  relay: 'Relay',
  duo: 'Duo',
  architect: 'Architect',
};

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
const nameInput = document.getElementById('nameInput');
const leaderboardBody = document.getElementById('leaderboardBody');
const clearLeaderboardBtn = document.getElementById('clearLeaderboard');

if (nameInput) nameInput.value = playerName;
nameInput?.addEventListener('input', () => {
  playerName = nameInput.value.slice(0, 20);
  localStorage.setItem('tetrisPlayerName', playerName);
});
clearLeaderboardBtn?.addEventListener('click', () => {
  if (!confirm('Clear all saved leaderboard scores? This cannot be undone.')) return;
  localStorage.removeItem(LEADERBOARD_KEY);
  renderLeaderboard();
});

setCanvasSize(canvas1, BLOCK);
document.getElementById('highScore').textContent = highScore;
renderLeaderboard();

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
    if (state.architectWinAt && state.architectWinAt !== lastArchitectWinAt) {
      lastArchitectWinAt = state.architectWinAt;
      architectCelebrateUntil = performance.now() + 1800;
    }
    if (state.score > highScore) {
      highScore = state.score;
      localStorage.setItem('tetrisHighScore', String(highScore));
    }
    if (state.gameOver && !lastWasGameOver) {
      saveScoreEntry();
    }
    if (!state.gameOver && lastWasGameOver) {
      lastSavedKey = null;
    }
    lastWasGameOver = !!state.gameOver;
    reconcileMyPiece();
    setupLocalGravity();
    scheduleRender();
    updateHUD();
  }
});

function applyModeLayout(mode) {
  const modes = ['shared', 'split', 'garbage', 'relay', 'duo', 'architect'];
  for (const m of modes) gameAreaEl.classList.remove(`mode-${m}`);
  gameAreaEl.classList.add(`mode-${mode}`);
  gameAreaEl.classList.remove('split');

  if (canvas2) canvas2.hidden = true;
  setCanvasSize(canvas1, BLOCK);

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

function myBoard() {
  return state?.board ?? null;
}

function halfBoundsForSlot(slot) {
  return slot === 0 ? [0, SPLIT_DIVIDER_COL - 1] : [SPLIT_DIVIDER_COL, COLS - 1];
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
    if (!myPredicted || myPredicted.type !== srv.type) {
      myPredicted = { ...srv };
    } else if ((me.lastSeq || 0) >= lastSentSeq) {
      myPredicted = { type: srv.type, rot: srv.rot, x: srv.x, y: Math.max(srv.y, myPredicted.y) };
    }
    return;
  }
  const me = state.players.find(p => p.id === myId);
  if (!me?.piece) { myPredicted = null; return; }
  const srv = me.piece;
  if (!myPredicted || myPredicted.type !== srv.type) {
    myPredicted = { type: srv.type, rot: srv.rot, x: srv.x, y: srv.y };
  } else if ((me.lastSeq || 0) >= lastSentSeq) {
    myPredicted = { type: srv.type, rot: srv.rot, x: srv.x, y: Math.max(srv.y, myPredicted.y) };
  }
}

function setupLocalGravity() {
  const ms = state?.tickMs;
  const wantRunning = !!(state?.running && ms && myPredicted
                         && state.mode !== 'duo'
                         && !(state.mode === 'relay' && state.activeSlot !== mySlot));
  if (!wantRunning) {
    if (localGravityInterval) { clearInterval(localGravityInterval); localGravityInterval = null; localGravityMs = null; }
    return;
  }
  if (ms !== localGravityMs) {
    if (localGravityInterval) clearInterval(localGravityInterval);
    localGravityMs = ms;
    localGravityInterval = setInterval(localGravityTick, ms);
  }
}

function localGravityTick() {
  if (!state?.running || !myPredicted) return;
  if (state.mode === 'duo') return;
  if (state.mode === 'relay' && state.activeSlot !== mySlot) return;
  const next = localTryMove(myPredicted, 0, 1);
  if (next) {
    myPredicted = next;
    scheduleRender();
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

function wouldCollideInHalf(board, piece, hMin, hMax) {
  const cells = pieceCells(piece);
  let outside = 0;
  for (const [x, y] of cells) {
    if (x < 0 || x >= COLS || y >= ROWS) return true;
    if (y >= 0 && board[y][x]) return true;
    if (x < hMin || x > hMax) outside++;
  }
  if (outside * 2 > cells.length) return true;
  return false;
}

function localTryMove(piece, dx, dy) {
  if (state?.mode === 'split') {
    const [hMin, hMax] = halfBoundsForSlot(mySlot);
    const next = { ...piece, x: piece.x + dx, y: piece.y + dy };
    return wouldCollideInHalf(myBoard(), next, hMin, hMax) ? null : next;
  }
  return sharedTryMove(myBoard(), piece, dx, dy);
}

function localTryRotate(piece) {
  if (state?.mode === 'split') {
    const [hMin, hMax] = halfBoundsForSlot(mySlot);
    const next = { ...piece, rot: (piece.rot + 1) % 4 };
    for (const kx of [0, -1, 1, -2, 2]) {
      const test = { ...next, x: next.x + kx };
      if (!wouldCollideInHalf(myBoard(), test, hMin, hMax)) return test;
    }
    return null;
  }
  return sharedTryRotate(myBoard(), piece);
}

function localHardDrop(piece) {
  if (state?.mode === 'split') {
    let p = piece;
    while (true) {
      const next = localTryMove(p, 0, 1);
      if (!next) break;
      p = next;
    }
    return p;
  }
  return hardDropPos(myBoard(), piece);
}

function attemptLocalMove(dx, dy) {
  if (!canControl() || !myPredicted) return false;
  if (state.mode === 'duo') return false;
  const next = localTryMove(myPredicted, dx, dy);
  if (next) { myPredicted = next; return true; }
  return false;
}

function attemptLocalRotate() {
  if (!canControl() || !myPredicted) return false;
  if (state.mode === 'duo') return false;
  const next = localTryRotate(myPredicted);
  if (next) { myPredicted = next; return true; }
  return false;
}

function attemptLocalHardDrop() {
  if (!canControl() || !myPredicted) return false;
  if (state.mode === 'duo') return false;
  myPredicted = localHardDrop(myPredicted);
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

function ghostCellsClamped(board, piece, slot) {
  if (state?.mode === 'split') {
    const [hMin, hMax] = halfBoundsForSlot(slot);
    let dy = 0;
    while (!wouldCollideInHalf(board, { ...piece, y: piece.y + dy + 1 }, hMin, hMax)) dy++;
    return pieceCells({ ...piece, y: piece.y + dy });
  }
  return ghostCells(board, piece);
}

function stackedGhostsForPieces(board, pieces) {
  const items = pieces.map((p, idx) => {
    const eff = p.isMe ? myPredicted : p.piece;
    return { idx, slot: p.slot, eff };
  }).filter(it => it.eff);

  // Whichever piece is currently lower on the board lands first; the other
  // stacks on top of its ghost. Tie break by slot for determinism.
  items.sort((a, b) => {
    if (a.eff.y !== b.eff.y) return b.eff.y - a.eff.y;
    return a.slot - b.slot;
  });

  const virt = board.map(row => row.slice());
  const result = new Array(pieces.length).fill(null);

  for (const it of items) {
    const ghost = ghostCellsClamped(virt, it.eff, it.slot);
    for (const [x, y] of ghost) {
      if (y >= 0 && y < ROWS && x >= 0 && x < COLS) virt[y][x] = 1;
    }
    result[it.idx] = ghost;
  }
  return result;
}

function render() {
  if (!state) return;
  const board = state.board;
  const ctx = ctx1;
  const c = canvas1;

  updateModeBanner();

  ctx.fillStyle = '#05080f';
  ctx.fillRect(0, 0, c.width, c.height);

  if (state.mode === 'architect' && state.silhouette) {
    for (const [x, y] of state.silhouette) {
      if (y < 0 || y >= ROWS || x < 0 || x >= COLS) continue;
      const filled = board?.[y]?.[x];
      drawSilhouetteCell(ctx, x, y, BLOCK, filled);
    }
  }

  if (board) {
    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const v = board[r][col];
        if (v) drawBlock(ctx, col * BLOCK, r * BLOCK, BLOCK, LOCKED_COLORS[v] || '#888', 'rgba(0,0,0,0.35)');
        else if (state.mode !== 'architect' || !isSilhouetteCell(col, r)) drawGridCell(ctx, col, r, BLOCK);
      }
    }
  }

  let pieces;
  if (state.mode === 'duo' || state.mode === 'relay') {
    const active = state.players.find(p => p.piece);
    pieces = active ? [{ piece: active.piece, slot: active.slot, isMe: active.id === myId }] : [];
  } else {
    pieces = state.players.map(p => ({
      piece: p.piece, slot: p.slot, isMe: p.id === myId,
    }));
  }

  if (board) {
    const ghostList = stackedGhostsForPieces(board, pieces);
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      const ghost = ghostList[i];
      if (!ghost) continue;
      const color = PLAYER_COLORS[p.slot] || '#fff';
      for (const [x, y] of ghost) {
        if (y < 0) continue;
        drawGhost(ctx, x, y, color, BLOCK);
      }
    }

    for (const p of pieces) {
      const effective = p.isMe ? myPredicted : p.piece;
      if (!effective) continue;
      const color = PLAYER_COLORS[p.slot] || '#fff';
      for (const [x, y] of pieceCells(effective)) {
        if (y < 0) continue;
        drawBlock(ctx, x * BLOCK, y * BLOCK, BLOCK, color, p.isMe ? '#fff' : 'rgba(255,255,255,0.4)');
      }
    }
  }

  if (state.mode === 'split') drawDivider(ctx, c);

  if (performance.now() < flashUntil) {
    const alpha = (flashUntil - performance.now()) / 220;
    ctx.fillStyle = `rgba(255,255,255,${alpha * 0.35})`;
    ctx.fillRect(0, 0, c.width, c.height);
    scheduleRender();
  }

  if (performance.now() < architectCelebrateUntil) {
    drawArchitectCelebration(ctx, c, state.architectLevel);
    scheduleRender();
  }

  if (state.gameOver) overlayOn(ctx, c, 'GAME OVER', 'Press R or Enter to restart');
  else if (!state.running && state.playerCount < 2) {
    overlayOn(ctx, c, `Share code: ${myCode}`, 'Waiting for player 2…');
  }

  if (state.mode === 'architect' && state.running && state.silhouette) {
    scheduleRender();
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

function drawDivider(ctx, canvas) {
  const x = SPLIT_DIVIDER_COL * BLOCK;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  const grad = ctx.createLinearGradient(x - 3, 0, x + 3, 0);
  grad.addColorStop(0, 'rgba(76,207,255,0.0)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,77,109,0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x - 3, 0, 6, canvas.height);
  ctx.restore();
}

function isSilhouetteCell(x, y) {
  if (!state?.silhouette) return false;
  return state.silhouette.some(([sx, sy]) => sx === x && sy === y);
}

function drawSilhouetteCell(g, x, y, block, satisfied) {
  const px = x * block, py = y * block;
  const baseColor = satisfied ? '#ffd93d' : '#7fdaff';
  const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 380);

  g.save();
  g.shadowColor = baseColor;
  g.shadowBlur = satisfied ? 18 : 14;

  g.fillStyle = satisfied
    ? `rgba(255,217,61,${0.22 + 0.18 * pulse})`
    : `rgba(127,218,255,${0.16 + 0.18 * pulse})`;
  g.fillRect(px + 2, py + 2, block - 4, block - 4);

  g.shadowBlur = satisfied ? 12 : 10;
  g.strokeStyle = baseColor;
  g.globalAlpha = 0.85;
  g.lineWidth = 2;
  g.setLineDash(satisfied ? [] : [4, 3]);
  g.strokeRect(px + 2.5, py + 2.5, block - 5, block - 5);
  g.setLineDash([]);

  g.shadowBlur = 0;
  g.globalAlpha = 1;
  g.fillStyle = `rgba(255,255,255,${0.10 + 0.10 * pulse})`;
  g.fillRect(px + 4, py + 4, block - 8, 2);

  g.restore();
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
    const { filled, total, name } = state.silhouetteProgress;
    const lvl = state.architectLevel || 1;
    text = `LEVEL ${lvl} — ${name?.toUpperCase() ?? ''} — ${filled} / ${total}`;
    kind = 'architect';
  } else if (state.mode === 'duo' && state.running) {
    text = mySlot === 0
      ? 'YOU: MOVE + HARD DROP  (P2: rotate + hold)'
      : mySlot === 1
      ? 'YOU: ROTATE + HOLD  (P1: move + hard drop)'
      : 'Duo Controls';
    kind = 'duo';
  } else if (state.mode === 'split' && state.running) {
    text = mySlot === 0 ? 'YOU: LEFT HALF' : mySlot === 1 ? 'YOU: RIGHT HALF' : 'Split';
    kind = mySlot === 0 ? 'relay-p1' : 'relay-p2';
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

function drawArchitectCelebration(g, c, level) {
  const remaining = architectCelebrateUntil - performance.now();
  const total = 1800;
  const t = 1 - remaining / total;
  const alpha = remaining > total - 250
    ? (total - remaining) / 250
    : remaining < 400 ? remaining / 400 : 1;

  g.save();
  g.globalAlpha = alpha;
  g.fillStyle = 'rgba(255,217,61,0.18)';
  g.fillRect(0, 0, c.width, c.height);

  g.textAlign = 'center';
  g.fillStyle = '#ffd93d';
  g.font = 'bold 38px ui-sans-serif, system-ui, sans-serif';
  g.fillText(`LEVEL ${(level || 1) - 1} COMPLETE!`, c.width / 2, c.height / 2 - 12);
  g.fillStyle = '#ffffff';
  g.font = 'bold 18px ui-sans-serif, system-ui, sans-serif';
  g.fillText(`Now: Level ${level || 1}`, c.width / 2, c.height / 2 + 22);

  for (let i = 0; i < 24; i++) {
    const seed = (i * 9301 + 49297) % 233280;
    const cx = (seed / 233280) * c.width;
    const cy = ((t * 1.3 + i * 0.15) % 1) * c.height;
    g.fillStyle = ['#ffd93d', '#4ccfff', '#ff4d6d', '#7ae582', '#c77dff'][i % 5];
    g.fillRect(cx, cy, 6, 6);
  }
  g.restore();
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

function saveScoreEntry() {
  if (!state || state.score <= 0) return;
  const key = `${state.code || 'no-code'}|${state.score}|${state.lines}|${state.mode}`;
  if (key === lastSavedKey) return;
  lastSavedKey = key;
  const name = (playerName || '').trim() || 'Anonymous';
  const entry = {
    name: name.slice(0, 20),
    score: state.score,
    lines: state.lines || 0,
    mode: state.mode,
    ts: Date.now(),
  };
  const list = readLeaderboard();
  list.push(entry);
  list.sort((a, b) => b.score - a.score);
  const trimmed = list.slice(0, MAX_LEADERBOARD);
  try { localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(trimmed)); } catch {}
  renderLeaderboard();
}

function readLeaderboard() {
  try { return JSON.parse(localStorage.getItem(LEADERBOARD_KEY) || '[]'); }
  catch { return []; }
}

function renderLeaderboard() {
  if (!leaderboardBody) return;
  const list = readLeaderboard();
  leaderboardBody.innerHTML = '';
  if (list.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="6" class="empty">No scores yet. Finish a game and yours will appear here.</td>';
    leaderboardBody.appendChild(tr);
    return;
  }
  list.slice(0, 20).forEach((e, i) => {
    const row = document.createElement('tr');
    const rank = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1);
    const cells = [
      ['rank', rank],
      ['name', e.name],
      ['num', e.score],
      ['num', e.lines],
      ['', MODE_LABELS[e.mode] || e.mode],
      ['when', formatRelative(e.ts)],
    ];
    for (const [cls, val] of cells) {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = String(val);
      row.appendChild(td);
    }
    leaderboardBody.appendChild(row);
  });
}

function formatRelative(ts) {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 30) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const date = new Date(ts);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
