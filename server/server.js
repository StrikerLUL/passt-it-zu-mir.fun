// „Passt IT zu mir?" – Messe-Server. Ohne externe Pakete, braucht nur Node.js 18+ und git.
// Start:  ADMIN_KEY=geheim PORT=3847 node server.js
// Lauscht standardmäßig nur auf 127.0.0.1 – nach außen geht es über nginx.
//
//  GET  /                → Handy-Fragebogen (public/index.html)
//  GET  /api/stats       → Zähler heute + gesamt
//  POST /api/result      → { mode: 'si'|'ae'|'tie'|'none'|'unclear', source: 'phone'|'kiosk', cid }
//  GET  /api/config      → { threshold, otherJobs }
//  POST /api/config      → { threshold?, otherJobs? } (Header X-Admin-Key)
//  POST /api/reset       → { scope: 'today'|'all' } (Header X-Admin-Key)
//  GET  /api/version     → aktueller Git-Stand (Server + Bildschirm-Datei)
//  POST /api/update      → holt den neuesten Stand von GitHub und startet neu (Header X-Admin-Key)
//  GET  /api/kiosk       → neueste Bildschirm-Datei zum Herunterladen (Header X-Admin-Key)
//  POST /api/deploy      → GitHub-Webhook bei jedem Push (signiert mit WEBHOOK_SECRET)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '3847', 10);
const HOST = process.env.HOST || '127.0.0.1';
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(6).toString('hex');
if (!process.env.ADMIN_KEY) console.log(`Kein ADMIN_KEY gesetzt – zufälliger Schlüssel für diesen Start: ${ADMIN_KEY}`);

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const REPO_DIR = process.env.REPO_DIR || path.join(__dirname, '..');
const BRANCH = process.env.BRANCH || 'main';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const KIOSK_REL = 'kiosk/messe-bildschirm.html';
const DATA_FILE = path.join(DATA_DIR, 'stats.json');
const MODES = ['si', 'ae', 'tie', 'none', 'unclear'];

fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { days: {}, config: { threshold: 40, otherJobs: '' }, lastDeploy: null };
try { const f = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); db.days = f.days || {}; db.config = Object.assign(db.config, f.config || {}); db.lastDeploy = f.lastDeploy || null; } catch { /* erster Start */ }

let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); } catch (e) { console.error('Speichern fehlgeschlagen:', e.message); }
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE + '.tmp', JSON.stringify(db), err => {
      if (!err) fs.rename(DATA_FILE + '.tmp', DATA_FILE, () => {});
    });
  }, 300);
}

const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
const emptyDay = () => ({ si: 0, ae: 0, tie: 0, none: 0, unclear: 0, phone: 0, kiosk: 0 });

function summary(day) {
  const d = Object.assign(emptyDay(), day || {});
  return { ...d, total: MODES.reduce((s, m) => s + (d[m] || 0), 0) };
}
function stats() {
  const all = emptyDay();
  for (const d of Object.values(db.days)) for (const k in all) all[k] += d[k] || 0;
  return { date: today(), today: summary(db.days[today()]), all: summary(all), threshold: db.config.threshold };
}

// Bremse gegen Spam: pro Handy (zufällige Geräte-ID) max. 1 Ergebnis alle 20 s,
// pro IP max. 40 pro Minute – im Messe-WLAN teilen sich viele Handys eine IP.
const lastByClient = new Map();
const ipWindow = new Map();
setInterval(() => {
  const cut = Date.now() - 60000;
  for (const [k, t] of lastByClient) if (t < cut) lastByClient.delete(k);
  for (const [k, arr] of ipWindow) { const f = arr.filter(t => t > cut); f.length ? ipWindow.set(k, f) : ipWindow.delete(k); }
}, 60000);
function allowed(ip, cid) {
  const now = Date.now();
  const arr = (ipWindow.get(ip) || []).filter(t => t > now - 60000);
  if (arr.length >= 40) return false;
  const key = cid ? 'c:' + String(cid).slice(0, 40) : 'i:' + ip;
  if (now - (lastByClient.get(key) || 0) < 20000) return false;
  arr.push(now); ipWindow.set(ip, arr); lastByClient.set(key, now);
  return true;
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
    'Access-Control-Expose-Headers': 'Content-Disposition',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { req.destroy(); reject(new Error('zu groß')); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
const isAdmin = req => !!req.headers['x-admin-key'] && safeEqual(req.headers['x-admin-key'], ADMIN_KEY);

/* ======================== GIT / UPDATES ======================== */
function git(args, timeout = 60000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', REPO_DIR, ...args], { timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout, stderr) => err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim()));
  });
}
let versionCache = null;
async function version() {
  if (versionCache) return versionCache;
  try {
    const [commit, date, ...msg] = (await git(['log', '-1', '--format=%h%n%cI%n%s'])).split('\n');
    const kiosk = await git(['log', '-1', '--format=%h', '--', KIOSK_REL]).catch(() => '');
    versionCache = { git: true, branch: BRANCH, commit, date, message: msg.join(' '), kiosk: kiosk || commit };
  } catch (e) {
    versionCache = { git: false, commit: 'unbekannt', kiosk: 'unbekannt', error: e.message };
  }
  return versionCache;
}
let updating = false;
async function update(source) {
  if (updating) return { ok: false, error: 'Update läuft bereits' };
  updating = true;
  const time = new Date().toISOString();
  try {
    await git(['fetch', '--quiet', 'origin', BRANCH]);
    const from = await git(['rev-parse', '--short', 'HEAD']);
    const to = await git(['rev-parse', '--short', `origin/${BRANCH}`]);
    if (from === to) {
      db.lastDeploy = { time, source, result: 'schon aktuell', commit: to }; save();
      return { ok: true, updated: false, commit: to };
    }
    await git(['reset', '--hard', `origin/${BRANCH}`]);
    db.lastDeploy = { time, source, result: 'aktualisiert', from, to }; saveNow();
    console.log(`Update ${from} -> ${to} (${source}) – starte neu`);
    // Neustart, damit der neue Code läuft – systemd (Restart=always) startet den Dienst sofort wieder
    setTimeout(() => process.exit(0), 700);
    return { ok: true, updated: true, from, to };
  } catch (e) {
    db.lastDeploy = { time, source, result: 'Fehler', error: e.message.slice(0, 300) }; save();
    return { ok: false, error: e.message };
  } finally { updating = false; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (url.pathname.startsWith('/api/')) {
    if (req.method === 'OPTIONS') return send(res, 204, {});

    if (url.pathname === '/api/stats' && req.method === 'GET') return send(res, 200, stats());
    if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, db.config);

    if (url.pathname === '/api/result' && req.method === 'POST') {
      const body = await readBody(req);
      if (!MODES.includes(body.mode)) return send(res, 400, { error: 'mode ungültig' });
      const admin = isAdmin(req);
      if (!admin && !allowed(ip, body.cid)) return send(res, 429, { error: 'zu schnell' });
      const key = today();
      const d = db.days[key] || (db.days[key] = emptyDay());
      d[body.mode] = (d[body.mode] || 0) + 1;
      d[admin && body.source === 'kiosk' ? 'kiosk' : 'phone']++;
      save();
      return send(res, 200, stats());
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Schlüssel falsch' });
      const body = await readBody(req);
      if ('threshold' in body) {
        const t = Math.round(Number(body.threshold));
        if (!(t >= 0 && t <= 100)) return send(res, 400, { error: 'threshold 0–100' });
        db.config.threshold = t;
      }
      if (typeof body.otherJobs === 'string') db.config.otherJobs = body.otherJobs.replace(/[<>]/g, '').trim().slice(0, 200);
      save();
      return send(res, 200, db.config);
    }

    if (url.pathname === '/api/reset' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Schlüssel falsch' });
      const body = await readBody(req);
      if (body.scope === 'all') db.days = {}; else delete db.days[today()];
      save();
      return send(res, 200, stats());
    }
    if (url.pathname === '/api/version' && req.method === 'GET') {
      return send(res, 200, { ...(await version()), lastDeploy: db.lastDeploy, webhook: !!WEBHOOK_SECRET });
    }

    if (url.pathname === '/api/update' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Schlüssel falsch' });
      const r = await update('admin');
      return send(res, r.ok ? 200 : 500, r);
    }

    if (url.pathname === '/api/kiosk' && req.method === 'GET') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Admin-Schlüssel falsch' });
      const v = await version();
      return fs.readFile(path.join(REPO_DIR, KIOSK_REL), 'utf8', (err, html) => {
        if (err) return send(res, 404, { error: 'Bildschirm-Datei nicht gefunden' });
        html = html.replace("'__KIOSK_VERSION__'", `'${String(v.kiosk).replace(/[^0-9a-z]/gi, '')}'`);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': 'attachment; filename="messe-bildschirm.html"',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Disposition',
          'Cache-Control': 'no-store',
        });
        res.end(html);
      });
    }

    if (url.pathname === '/api/deploy' && req.method === 'POST') {
      if (!WEBHOOK_SECRET) return send(res, 503, { error: 'WEBHOOK_SECRET ist nicht gesetzt' });
      let raw;
      try { raw = await readRaw(req, 5 * 1024 * 1024); } catch { return send(res, 413, { error: 'zu groß' }); }
      const expected = 'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
      if (!safeEqual(req.headers['x-hub-signature-256'] || '', expected)) return send(res, 401, { error: 'Signatur ungültig' });
      const event = req.headers['x-github-event'];
      if (event === 'ping') return send(res, 200, { ok: true, pong: true });
      if (event !== 'push') return send(res, 200, { ok: true, ignoriert: event });
      let payload = {};
      try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'Im Webhook bitte Content type application/json einstellen' }); }
      if (payload.ref !== `refs/heads/${BRANCH}`) return send(res, 200, { ok: true, ignoriert: payload.ref });
      const r = await update('github');
      return send(res, r.ok ? 200 : 500, r);
    }

    return send(res, 404, { error: 'unbekannt' });
  }

  // statische Dateien (nur aus public/)
  let file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Nicht gefunden'); }
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} ist schon belegt – bitte mit PORT=... einen anderen wählen.`);
  else console.error(err);
  process.exit(1);
});
process.on('SIGTERM', () => { saveNow(); process.exit(0); });
server.listen(PORT, HOST, () => version().then(v => console.log(`Messe-Server läuft auf http://${HOST}:${PORT} – Stand ${v.commit}`)));
