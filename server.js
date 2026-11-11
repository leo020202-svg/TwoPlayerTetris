import http from 'http';
import fs from 'fs';
import path from 'path';
import url from 'url';
import zlib from 'zlib';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { WebSocketServer } from 'ws';
import { createStats } from './stats.js';
import {
  COLS, ROWS, COLOR_INDEX, TYPES,
  pieceCells, collides, ghostCells,
  tryMove as tryMoveShared,
  tryRotate as tryRotateShared,
  hardDropPos,
} from './public/shared.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

function logLine(...args) {
  console.log(new Date().toISOString(), ...args);
}
function logRoom(room, ...args) {
  logLine(`room=${room?.code ?? '----'}`, ...args);
}
function logErr(...args) {
  console.error(new Date().toISOString(), 'ERR', ...args);
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const CANONICAL_ORIGIN = process.env.CANONICAL_ORIGIN || 'https://twoplayertetris.com';
const CANONICAL_HOST = new URL(CANONICAL_ORIGIN).host;
// Alternate hostnames that serve the same app; 301 them to the canonical origin.
const REDIRECT_HOSTS = new Set([`www.${CANONICAL_HOST}`, 'twoplayertetris.fly.dev']);

// Internal-only visitor counts (see stats.js). On Fly the file lives on the
// stats_data volume, so the numbers survive deploys and restarts.
const stats = createStats({
  file: process.env.STATS_FILE || path.join(__dirname, 'data', 'stats.json'),
  ownHosts: new Set([CANONICAL_HOST, 'twoplayertetris.fly.dev', 'localhost', '127.0.0.1']),
  saveMs: Number(process.env.STATS_SAVE_MS) || 30_000,
  logErr,
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.xml':  'application/xml; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.ico', '.svg', '.xml', '.txt']);

// If the game is ever listed on a portal that iframes it (itch.io, CrazyGames...),
// add that origin to frame-ancestors.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; '),
};

// Referenced as ?v=<hash> so browsers can cache them for a year; the hash changes
// whenever the file does. Dependencies first (client.js imports shared.js).
const VERSIONED = ['shared.js', 'style.css', 'client.js'];
// Served only as the 404 body, never at its own URL.
const HIDDEN_FILES = new Set(['404.html']);

function loadAssets() {
  const raw = new Map();
  for (const name of fs.readdirSync(PUBLIC_DIR)) {
    const full = path.join(PUBLIC_DIR, name);
    if (fs.statSync(full).isFile()) raw.set(name, fs.readFileSync(full));
  }

  const versions = {};
  const addVersions = (name, buf) => {
    if (!['.html', '.js', '.css'].includes(path.extname(name))) return buf;
    let text = buf.toString('utf8');
    for (const [dep, v] of Object.entries(versions)) {
      const re = new RegExp(`(["'])(\\.?/)${dep.replace(/\./g, '\\.')}\\1`, 'g');
      text = text.replace(re, `$1$2${dep}?v=${v}$1`);
    }
    return Buffer.from(text);
  };

  const assets = new Map();
  const add = (name) => {
    const body = addVersions(name, raw.get(name));
    const ext = path.extname(name);
    const hash = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
    const asset = { name, ext, body, hash, etag: `W/"${hash}"`, type: MIME[ext] || 'application/octet-stream' };
    if (COMPRESSIBLE.has(ext) && body.length > 512) {
      asset.br = zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
      asset.gzip = zlib.gzipSync(body, { level: 9 });
    }
    assets.set(name, asset);
    return asset;
  };
  for (const name of VERSIONED) if (raw.has(name)) versions[name] = add(name).hash;
  for (const name of raw.keys()) if (!assets.has(name)) add(name);
  return assets;
}

const assets = loadAssets();

function cacheControlFor(asset, query) {
  if (query.has('v')) {
    return query.get('v') === asset.hash ? 'public, max-age=31536000, immutable' : 'no-cache';
  }
  // Unversioned code and text revalidate via ETag so a deploy is picked up at once.
  if (['.html', '.js', '.css', '.xml', '.txt'].includes(asset.ext)) return 'no-cache';
  return 'public, max-age=86400';
}

// Returns { asset } to serve, { redirect } to 301 to, or null for a 404.
function resolvePath(pathname) {
  if (pathname === '/') return { asset: assets.get('index.html') };
  if (pathname.length > 1 && pathname.endsWith('/')) return { redirect: pathname.replace(/\/+$/, '') || '/' };

  const name = pathname.slice(1);
  if (HIDDEN_FILES.has(name) || HIDDEN_FILES.has(`${name}.html`)) return null;
  if (name.endsWith('.html') && assets.has(name)) {
    return { redirect: name === 'index.html' ? '/' : `/${name.slice(0, -5)}` };
  }
  if (!path.extname(name) && assets.has(`${name}.html`)) return { asset: assets.get(`${name}.html`) };
  if (assets.has(name) && !name.endsWith('.html')) return { asset: assets.get(name) };
  return null;
}

function sendAsset(req, res, asset, query, status = 200) {
  const headers = {
    ...SECURITY_HEADERS,
    'Content-Type': asset.type,
    'Cache-Control': status === 200 ? cacheControlFor(asset, query) : 'no-cache',
    'Vary': 'Accept-Encoding',
  };
  if (status === 200) {
    headers.ETag = asset.etag;
    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304, headers);
      res.end();
      return 304;
    }
  }
  let body = asset.body;
  const accept = req.headers['accept-encoding'] || '';
  if (asset.br && /\bbr\b/.test(accept)) { body = asset.br; headers['Content-Encoding'] = 'br'; }
  else if (asset.gzip && /\bgzip\b/.test(accept)) { body = asset.gzip; headers['Content-Encoding'] = 'gzip'; }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return status;
}

function sendRedirect(res, location) {
  res.writeHead(301, { ...SECURITY_HEADERS, Location: location, 'Cache-Control': 'public, max-age=3600' });
  res.end();
}

function sendNotFound(req, res) {
  const page = assets.get('404.html');
  if (page) return sendAsset(req, res, page, new URLSearchParams(), 404);
  res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
  return 404;
}

// The internal stats report. Only reached with the right STATS_KEY.
function sendStats(req, res, query) {
  const report = stats.report(query.get('format'));
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
    'Content-Type': report.type,
    // Marks the owner's browser so their own visits stop counting.
    'Set-Cookie': 'tpt_internal=1; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=Lax',
  });
  res.end(req.method === 'HEAD' ? undefined : report.body);
  return 200;
}

// ---- Feedback form -> email ------------------------------------------------
// The recipient lives only in the FEEDBACK_TO secret so it never appears in the
// page or this (public) repo. Without SMTP settings, feedback is written to the
// server log instead of being emailed.
const FEEDBACK_TO = process.env.FEEDBACK_TO || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
const mailer = FEEDBACK_TO && process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

const FEEDBACK_MAX_BYTES = 16 * 1024;
const FEEDBACK_WINDOW_MS = 60 * 60 * 1000;
const FEEDBACK_MAX_PER_WINDOW = 5;
const feedbackHits = new Map();

function feedbackRateLimited(ip) {
  const now = Date.now();
  const recent = (feedbackHits.get(ip) || []).filter(t => now - t < FEEDBACK_WINDOW_MS);
  if (recent.length >= FEEDBACK_MAX_PER_WINDOW) { feedbackHits.set(ip, recent); return true; }
  recent.push(now);
  feedbackHits.set(ip, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of feedbackHits) {
    if (hits.every(t => now - t >= FEEDBACK_WINDOW_MS)) feedbackHits.delete(ip);
  }
}, FEEDBACK_WINDOW_MS).unref();

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error('too large'), { tooLarge: true }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const oneLine = (s, max) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

async function handleFeedback(req, res, ip) {
  const isForm = (req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded');
  const reply = (status, error) => {
    if (isForm) {
      res.writeHead(303, { ...SECURITY_HEADERS, Location: error ? '/feedback?error=1' : '/feedback-sent' });
      res.end();
    } else {
      res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(error ? { ok: false, error } : { ok: true }));
    }
  };

  let fields;
  try {
    const body = await readBody(req, FEEDBACK_MAX_BYTES);
    fields = isForm ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body);
  } catch (err) {
    if (err?.tooLarge) return reply(413, 'Your message is too long.');
    return reply(400, 'Could not read your message.');
  }

  // Honeypot: a field real visitors never see. Pretend success so bots move on.
  if (fields.website) { logLine(`feedback honeypot ip=${ip}`); return reply(200); }

  const message = String(fields.message ?? '').trim().slice(0, 4000);
  const name = oneLine(fields.name, 60);
  let email = oneLine(fields.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) email = '';
  if (message.length < 3) return reply(400, 'Please write a message.');
  if (feedbackRateLimited(ip)) return reply(429, 'Too many messages — please try again later.');

  const ua = oneLine(req.headers['user-agent'], 200);
  if (!mailer) {
    logLine(`feedback (email not configured) name="${name}" email="${email}" message=${JSON.stringify(message)}`);
    return reply(200);
  }
  try {
    await mailer.sendMail({
      from: { name: 'Two Player Tetris feedback', address: process.env.SMTP_USER },
      to: FEEDBACK_TO,
      replyTo: email || undefined,
      subject: `Feedback: ${oneLine(message, 60)}`,
      text: `${message}\n\n---\nName: ${name || '(not given)'}\nReply-to: ${email || '(not given)'}\nBrowser: ${ua}\nSent: ${new Date().toISOString()}`,
    });
    logLine(`feedback emailed ip=${ip} chars=${message.length}`);
    return reply(200);
  } catch (err) {
    logErr(`feedback email failed: ${err?.message || err} message=${JSON.stringify(message)}`);
    return reply(502, 'Sorry, your message could not be sent. Please try again later.');
  }
}

const server = http.createServer((req, res) => {
  const ip = req.headers['fly-client-ip'] || req.socket.remoteAddress || '?';
  const host = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  if (REDIRECT_HOSTS.has(host)) {
    sendRedirect(res, `${CANONICAL_ORIGIN}${req.url}`);
    logLine(`http 301 ${req.method} ${host}${req.url} -> canonical ip=${ip}`);
    return;
  }

  let parsed;
  try { parsed = new URL(req.url, CANONICAL_ORIGIN); }
  catch { res.writeHead(400, SECURITY_HEADERS); res.end(); return; }
  const { pathname, searchParams, search } = parsed;

  if (req.method === 'POST' && pathname === '/api/feedback') {
    handleFeedback(req, res, ip).catch((err) => {
      logErr(`feedback handler: ${err?.message || err}`);
      if (!res.headersSent) { res.writeHead(500, SECURITY_HEADERS); res.end(); }
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...SECURITY_HEADERS, Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  if (pathname === '/stats') {
    // Without the key this is an ordinary 404. Only the path is logged, never the key.
    const status = stats.keyOk(searchParams.get('key')) ? sendStats(req, res, searchParams) : sendNotFound(req, res);
    logLine(`http ${status} ${req.method} ${pathname} ip=${ip}`);
    return;
  }

  const route = resolvePath(pathname);
  let status;
  if (route?.redirect) { sendRedirect(res, route.redirect + search); status = 301; }
  else if (route?.asset) {
    status = sendAsset(req, res, route.asset, searchParams);
    if (route.asset.ext === '.html') stats.pageView(req, pathname, searchParams, ip, status);
  }
  else status = sendNotFound(req, res);
  logLine(`http ${status} ${req.method} ${pathname} ip=${ip} ua="${(req.headers['user-agent']||'').slice(0,60)}"`);
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
  logLine(`room=${code} created (total rooms=${rooms.size + 1})`);
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
    logLine(`room=${room.code} deleted (total rooms=${rooms.size})`);
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
    logRoom(room, `top-out on spawn slot=${slot} type=${type} mode=${room.mode}`);
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
  const lockSlot = room.order.indexOf(playerId);
  const lockType = p.piece.type;
  const lockX = p.piece.x;
  const lockY = p.piece.y;
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
  logRoom(room, `lock slot=${lockSlot} type=${lockType} pos=(${lockX},${lockY}) cleared=${cleared} score=${room.score} lines=${room.lines} level=${room.level}`);

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
  // Only duo and relay drive piece gravity from the server. All other modes
  // are client-authoritative for piece position; clients send 'down' / 'drop'
  // on their own gravity timer.
  if (room.mode !== 'duo' && room.mode !== 'relay') return;
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
    logRoom(room, `garbage rise pushed top-out — game over`);
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
  logRoom(room, `garbage rose hole=col${hole}`);
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

  if (!roomIsInternal(room)) stats.roundStarted();
  logRoom(room, `game started mode=${room.mode} players=${room.order.length} silhouette=${room.silhouette?.name || '-'} tickMs=${tickSpeedMs(room)}`);
  broadcast(room);
}

// Rooms with the owner's own browser in them don't count toward the stats.
function roomIsInternal(room) {
  return room.order.some((id) => room.sockets[id]?.internal);
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
  if (!VALID_MODES.includes(mode)) {
    logRoom(room, `setMode rejected: invalid mode "${mode}"`);
    return;
  }
  if (room.mode === mode) return;
  logRoom(room, `mode changed ${room.mode} -> ${mode}`);
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

wss.on('connection', (ws, req) => {
  const playerId = String(nextPlayerId++);
  ws.playerId = playerId;
  ws.connectIp = (req?.headers?.['fly-client-ip']) || req?.socket?.remoteAddress || '?';
  ws.internal = stats.isInternal(req);
  stats.gameLoad(req, ws.connectIp, ws.internal);

  const room = createRoom();
  addPlayerToRoom(room, ws, playerId);
  sendWelcome(ws, room, playerId);
  logLine(`player=${playerId} connected ip=${ws.connectIp} room=${room.code} slot=0`);
  broadcast(room);

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const currentRoom = rooms.get(ws.roomCode);
    if (!currentRoom) return;

    if (msg.type === 'join') {
      const target = typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '';
      if (!/^[A-Z2-9]{4}$/.test(target)) {
        logLine(`player=${playerId} join rejected: invalid format "${msg.code}"`);
        sendError(ws, 'Invalid code'); return;
      }
      if (target === currentRoom.code) { sendError(ws, "You're already in this room"); return; }
      const targetRoom = rooms.get(target);
      if (!targetRoom) {
        logLine(`player=${playerId} join rejected: room=${target} not found`);
        sendError(ws, 'Room not found'); return;
      }
      if (targetRoom.order.length >= 2) {
        logLine(`player=${playerId} join rejected: room=${target} full`);
        sendError(ws, 'Room is full'); return;
      }
      const oldCode = currentRoom.code;
      removePlayerFromRoom(currentRoom, playerId);
      broadcast(currentRoom);
      deleteRoomIfEmpty(currentRoom);
      addPlayerToRoom(targetRoom, ws, playerId);
      sendWelcome(ws, targetRoom, playerId);
      if (targetRoom.order.length === 2 && !roomIsInternal(targetRoom)) stats.friendJoined();
      logLine(`player=${playerId} joined room=${targetRoom.code} slot=${targetRoom.order.indexOf(playerId)} (left room=${oldCode})`);
      if (targetRoom.order.length === 2 && !targetRoom.running && !targetRoom.gameOver) {
        startGame(targetRoom);
      } else {
        broadcast(targetRoom);
      }
      return;
    }

    if (msg.type === 'newRoom') {
      const oldCode = currentRoom.code;
      removePlayerFromRoom(currentRoom, playerId);
      broadcast(currentRoom);
      deleteRoomIfEmpty(currentRoom);
      const fresh = createRoom();
      addPlayerToRoom(fresh, ws, playerId);
      sendWelcome(ws, fresh, playerId);
      logLine(`player=${playerId} newRoom room=${fresh.code} (left room=${oldCode})`);
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
        logRoom(currentRoom, `color slot=${currentRoom.order.indexOf(playerId)} color=${c || 'default'}`);
        broadcast(currentRoom);
      }
      return;
    }

    if (msg.type === 'restart' && currentRoom.gameOver) {
      logRoom(currentRoom, `restart requested by slot=${currentRoom.order.indexOf(playerId)}`);
      if (currentRoom.order.length >= 2) startGame(currentRoom);
      return;
    }

    if (msg.type === 'piece' && currentRoom.running) {
      if (currentRoom.mode === 'duo' || currentRoom.mode === 'relay') return;
      const pi = msg.piece;
      const p2 = currentRoom.players[playerId];
      if (!p2 || !pi) return;
      if (typeof pi.type !== 'string' || !TYPES.includes(pi.type)) return;
      if (typeof pi.rot !== 'number' || typeof pi.x !== 'number' || typeof pi.y !== 'number') return;
      if (!p2.piece || p2.piece.type === pi.type) {
        p2.piece = { type: pi.type, rot: pi.rot | 0, x: pi.x | 0, y: pi.y | 0 };
        broadcast(currentRoom);
      }
      return;
    }

    if (msg.type === 'gameOver' && currentRoom.running) {
      if (currentRoom.mode === 'duo' || currentRoom.mode === 'relay') return;
      logRoom(currentRoom, `game over signaled by slot=${currentRoom.order.indexOf(playerId)} score=${currentRoom.score} lines=${currentRoom.lines} level=${currentRoom.level}`);
      currentRoom.gameOver = true;
      endGameIfNeeded(currentRoom);
      broadcast(currentRoom);
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

  ws.on('close', (code, reason) => {
    const room = rooms.get(ws.roomCode);
    const reasonStr = reason ? reason.toString() : '';
    logLine(`player=${playerId} disconnected code=${code} reason="${reasonStr.slice(0,80)}" room=${ws.roomCode || '-'}`);
    if (!room) return;
    removePlayerFromRoom(room, playerId);
    broadcast(room);
    deleteRoomIfEmpty(room);
  });

  ws.on('error', (err) => {
    logErr(`player=${playerId} ws error: ${err?.message || err}`);
  });
});

server.listen(PORT, () => {
  logLine(`Co-op Tetris running at http://localhost:${PORT}`);
});

process.on('uncaughtException', (err) => {
  logErr(`uncaughtException: ${err?.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  logErr(`unhandledRejection: ${reason}`);
});

// Fly stops the machine with SIGINT on deploys and restarts: save the counts first.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stats.flush();
    logLine(`${signal}: stats saved, shutting down`);
    process.exit(0);
  });
}
