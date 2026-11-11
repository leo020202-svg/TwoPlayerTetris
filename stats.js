// Internal visitor stats for twoplayertetris.com. Only the owner sees them.
//
// The report is served at /stats, and only with the right STATS_KEY (a Fly
// secret). Without the key the URL is an ordinary 404, so visitors never see it.
//
// Privacy: no IP addresses or browser strings are stored. Unique visitors are
// counted with a salted hash, and the salt is replaced every day, so nobody can
// be followed from one day to the next.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const NUM_FIELDS = ['visitors', 'pageViews', 'gameLoads', 'friendsJoined', 'rounds', 'mobile', 'bots'];
const MAX_KEYS = 60; // distinct pages/sources kept per day, so junk referrers can't bloat the file
const DAY_MS = 86_400_000;

// Real browsers start with "Mozilla/5.0" and don't name themselves as tools.
const BOT_UA = /bot|crawl|spider|slurp|lighthouse|headless|preview|scan|monitor|uptime|pingdom|statuscake|gtmetrix|pagespeed|curl|wget|python|httpclient|okhttp|java\/|go-http|node|axios|undici|facebookexternalhit|embedly|whatsapp|telegram|discord|skype|vkshare|pinterest|yandex|baidu|ahrefs|semrush|mj12|petal|gpt|claude|anthropic|perplexity|bytespider|ccbot|dataforseo|screaming|inspectiontool|googleother|feedfetcher|validator/i;
const MOBILE_UA = /Mobi|Android|iPhone|iPad|iPod/i;

const KNOWN_SOURCES = [
  [/(^|\.)google\.[a-z.]+$/, 'google'],
  [/(^|\.)bing\.com$/, 'bing'],
  [/(^|\.)duckduckgo\.com$/, 'duckduckgo'],
  [/(^|\.)yahoo\.[a-z.]+$/, 'yahoo'],
  [/(^|\.)facebook\.com$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)reddit\.com$/, 'reddit'],
  [/^(t\.co|x\.com|twitter\.com)$/, 'x/twitter'],
  [/(^|\.)youtube\.com$/, 'youtube'],
  [/(^|\.)tiktok\.com$/, 'tiktok'],
  [/(^|\.)discord(app)?\.com$/, 'discord'],
  [/^com\.google\.android\.gm$/, 'gmail app'],
];

const today = () => new Date().toISOString().slice(0, 10);
const daysBack = (n) => Array.from({ length: n }, (_, i) => new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10));
const emptyDay = () => ({
  visitors: 0, pageViews: 0, gameLoads: 0, friendsJoined: 0, rounds: 0, mobile: 0, bots: 0,
  pages: {}, sources: {},
});

function isHuman(ua) {
  return typeof ua === 'string' && ua.startsWith('Mozilla/5.0') && !BOT_UA.test(ua);
}

function isInternal(req) {
  return /(?:^|;\s*)tpt_internal=1(?:;|$)/.test(req.headers.cookie || '');
}

function bump(counts, key) {
  if (!(key in counts) && Object.keys(counts).length >= MAX_KEYS) key = '(other)';
  counts[key] = (counts[key] || 0) + 1;
}

// Where a visit came from: utm_source if the link had one, else the referring
// site. Returns null for clicks between our own pages (not a new arrival).
function sourceOf(req, query, ownHosts) {
  const utm = (query.get('utm_source') || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  if (utm) return `utm:${utm}`;
  const ref = req.headers.referer || '';
  if (!ref) {
    if (query.has('fbclid')) return 'facebook';
    if (query.has('gclid')) return 'google ads';
    return '(direct)';
  }
  let host;
  try { host = new URL(ref).hostname.toLowerCase(); } catch { return '(direct)'; }
  host = host.replace(/^(www|m|l|lm|out|old)\./, '');
  if (!host) return '(direct)';
  if (ownHosts.has(host)) return null;
  for (const [re, name] of KNOWN_SOURCES) if (re.test(host)) return name;
  return host.slice(0, 60);
}

export function createStats({ file, ownHosts, saveMs = 30_000, keepDays = 400, logErr = console.error }) {
  let dirty = false;
  const state = load() || { version: 1, since: new Date().toISOString(), days: {}, current: null };
  let visitorHashes = new Set(state.current?.date === today() ? state.current.hashes || [] : []);
  rollover();
  setInterval(save, saveMs).unref();

  function load() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved?.version === 1 && saved.days && typeof saved.since === 'string') return saved;
      throw new Error('unexpected format');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      logErr(`stats: could not read ${file} (${err.message}); starting fresh, old file kept as .bad`);
      try { fs.renameSync(file, `${file}.bad-${Date.now()}`); } catch {}
      return null;
    }
  }

  function save() {
    if (!dirty) return;
    try {
      state.current.hashes = [...visitorHashes];
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
      dirty = false;
    } catch (err) {
      logErr(`stats: save failed: ${err.message}`);
    }
  }

  // New UTC day: fresh salt, forget yesterday's visitor hashes, drop old days.
  function rollover() {
    const day = today();
    if (state.current?.date === day) return;
    state.current = { date: day, salt: crypto.randomBytes(16).toString('hex'), hashes: [] };
    visitorHashes = new Set();
    const cutoff = new Date(Date.now() - keepDays * DAY_MS).toISOString().slice(0, 10);
    for (const key of Object.keys(state.days)) if (key < cutoff) delete state.days[key];
    dirty = true;
  }

  function currentDay() {
    rollover();
    return (state.days[state.current.date] ??= emptyDay());
  }

  function countVisitor(day, ip, ua) {
    const hash = crypto.createHash('sha256').update(`${state.current.salt}|${ip}|${ua}`).digest('hex').slice(0, 16);
    if (visitorHashes.has(hash)) return;
    visitorHashes.add(hash);
    day.visitors = visitorHashes.size;
  }

  return {
    isInternal,

    // An HTML page was served: 200, or 304 when the browser already had it.
    pageView(req, pathname, query, ip, status) {
      if (req.method !== 'GET' || (status !== 200 && status !== 304)) return;
      if (/prefetch|prerender/i.test(req.headers['sec-purpose'] || req.headers.purpose || '')) return;
      if (isInternal(req)) return;
      const ua = req.headers['user-agent'] || '';
      const day = currentDay();
      dirty = true;
      if (!isHuman(ua)) { day.bots++; return; }
      day.pageViews++;
      if (MOBILE_UA.test(ua)) day.mobile++;
      bump(day.pages, pathname);
      const source = sourceOf(req, query, ownHosts);
      if (source) bump(day.sources, source);
      countVisitor(day, ip, ua);
    },

    // The game page opened its connection to the server.
    gameLoad(req, ip, internal) {
      if (internal) return;
      const ua = req.headers['user-agent'] || '';
      const day = currentDay();
      dirty = true;
      if (!isHuman(ua)) { day.bots++; return; }
      day.gameLoads++;
      countVisitor(day, ip, ua);
    },

    friendJoined() { currentDay().friendsJoined++; dirty = true; },
    roundStarted() { currentDay().rounds++; dirty = true; },

    keyOk(given) {
      const key = process.env.STATS_KEY;
      if (!key || typeof given !== 'string' || !given) return false;
      const a = crypto.createHash('sha256').update(given).digest();
      const b = crypto.createHash('sha256').update(key).digest();
      return crypto.timingSafeEqual(a, b);
    },

    flush: save,

    report(format) {
      rollover();
      if (format === 'json') {
        const body = JSON.stringify({ since: state.since, generatedAt: new Date().toISOString(), days: state.days }, null, 2);
        return { type: 'application/json; charset=utf-8', body };
      }
      return { type: 'text/html; charset=utf-8', body: renderHtml(state) };
    },
  };
}

// ---- Report page --------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (n || 0).toLocaleString('en-US');
const dayLabel = (key) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

function sumDays(days, keys) {
  const total = emptyDay();
  for (const key of keys) {
    const day = days[key];
    if (!day) continue;
    for (const f of NUM_FIELDS) total[f] += day[f] || 0;
    for (const [k, n] of Object.entries(day.pages || {})) total.pages[k] = (total.pages[k] || 0) + n;
    for (const [k, n] of Object.entries(day.sources || {})) total.sources[k] = (total.sources[k] || 0) + n;
  }
  return total;
}

const sorted = (counts) => Object.entries(counts).sort((a, b) => b[1] - a[1]);

function topSource(day) {
  const best = sorted(day.sources || {}).find(([s]) => s !== '(direct)');
  if (best) return `${best[0]} (${best[1]})`;
  return day.sources?.['(direct)'] ? 'direct' : '';
}

const CSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0e1014;color:#e7e9ee;font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:13px;margin:28px 0 8px;color:#aab0bb;font-weight:600}
p{margin:0 0 12px}
.muted{color:#8b919c}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{padding:6px 10px;border-bottom:1px solid #1f232b;text-align:right;white-space:nowrap}
th:first-child,td:first-child{text-align:left}
th{color:#8b919c;font-weight:500;font-size:12px;white-space:normal;vertical-align:bottom}
td.src{text-align:left;color:#aab0bb}
tr.zero td{color:#4f5560}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
@media (max-width:640px){
  body{font-size:13px}
  th,td{padding:6px 5px}
  th{font-size:11px}
  .cols{grid-template-columns:1fr;gap:0}
}
`;

function renderHtml(state) {
  const days = state.days;
  const sinceKey = state.since.slice(0, 10);
  const last30 = daysBack(30).filter((k) => k >= sinceKey);
  const month = sumDays(days, last30);

  const periods = [
    ['Today', daysBack(1)],
    ['Last 7 days', daysBack(7)],
    ['Last 30 days', daysBack(30)],
    ['All time', Object.keys(days)],
  ].map(([label, keys]) => [label, sumDays(days, keys)]);

  const summaryRows = periods.map(([label, t]) => `<tr><td>${label}</td><td>${num(t.visitors)}</td><td>${num(t.pageViews)}</td><td>${num(t.gameLoads)}</td><td>${num(t.friendsJoined)}</td><td>${num(t.rounds)}</td></tr>`).join('');

  const dailyRows = last30.map((key) => {
    const d = days[key] || emptyDay();
    const zero = !d.pageViews && !d.gameLoads;
    const mobile = d.pageViews ? `${Math.round((100 * d.mobile) / d.pageViews)}%` : '';
    return `<tr${zero ? ' class="zero"' : ''}><td>${dayLabel(key)}</td><td>${num(d.visitors)}</td><td>${num(d.pageViews)}</td><td>${num(d.gameLoads)}</td><td>${num(d.friendsJoined)}</td><td>${num(d.rounds)}</td><td>${mobile}</td><td class="src">${esc(topSource(d))}</td></tr>`;
  }).join('');

  const listRows = (counts) => sorted(counts).slice(0, 15).map(([k, n]) => `<tr><td>${esc(k)}</td><td>${num(n)}</td></tr>`).join('')
    || '<tr><td class="muted">Nothing yet</td><td></td></tr>';

  const sinceLabel = new Date(`${sinceKey}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const asOf = new Date().toISOString().slice(11, 16);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Visitor stats · Two Player Tetris</title><style>${CSS}</style></head>
<body><main>
<h1>Two Player Tetris visitors</h1>
<p class="muted">Internal page. Counting since ${sinceLabel}. As of ${asOf} UTC. People only: bots and this browser are left out.</p>
<div class="scroll"><table>
<tr><th></th><th>Visitors</th><th>Page views</th><th>Game opened</th><th>Friend joined</th><th>Rounds</th></tr>
${summaryRows}
</table></div>
<h2>Last 30 days</h2>
<div class="scroll"><table>
<tr><th>Day (UTC)</th><th>Visitors</th><th>Page views</th><th>Game opened</th><th>Friend joined</th><th>Rounds</th><th>Mobile</th><th>Top source</th></tr>
${dailyRows}
</table></div>
<div class="cols">
<section><h2>Where visits came from (30 days)</h2><table>${listRows(month.sources)}</table></section>
<section><h2>Pages (30 days)</h2><table>${listRows(month.pages)}</table></section>
</div>
<h2>What the columns mean</h2>
<p class="muted">Visitors: different people per day; the multi-day rows add the days up. Game opened: the game connected to the server. Friend joined: a second player came into a room, so two people played together. Rounds: games started with two players, restarts included. Bots seen in 30 days: ${num(month.bots)}.</p>
<p class="muted">Opening this page marks this browser as yours, so your own visits stop counting. Raw numbers: add &amp;format=json to this page's address.</p>
</main></body></html>`;
}
