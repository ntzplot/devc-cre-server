/**
 * XPAT Control Server — Node.js/Express
 * Run: node app.js   (or: npm start)
 * Dashboard: http://localhost:5050
 *
 * npm install   (installs express + multer)
 */

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const http     = require('http');
const https    = require('https');
const { spawn, execSync } = require('child_process');

const app    = express();
const upload = multer({ storage: multer.memoryStorage() });

const BASE          = path.join(__dirname, '..');
const CFG_PATH      = path.join(BASE, 'config', 'config.json');
const EMAILS_CSV    = path.join(BASE, '1', 'emails.csv');
const CARDS_TXT     = path.join(BASE, '1', 'cards.txt');
const SUCCESS_CSV   = path.join(BASE, '1', 'success.csv');
const FAILED_CSV    = path.join(BASE, '1', 'failed.csv');
const CANCELLED_CSV = path.join(BASE, '1', 'cancelled.csv');
const PURCHASED_TXT = path.join(BASE, 'purchased.txt');
const NORDVPN_EXE   = 'C:\\Program Files\\NordVPN\\NordVPN.exe';

// ── State ──────────────────────────────────────────────────────────────────
let _proc     = null;
let _logs     = [];
let _logIdx   = 0;
let _schedule = null;   // { time, count, fires_at, timer }

// ── Config ─────────────────────────────────────────────────────────────────
function loadCfg() {
  try { return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch { return {}; }
}
function saveCfg(data) {
  fs.writeFileSync(CFG_PATH, JSON.stringify(data, null, 2), 'utf8');
}

// ── Logs ───────────────────────────────────────────────────────────────────
function pushLog(msg) {
  _logs.push({ i: _logIdx++, t: new Date().toLocaleTimeString('en-GB'), m: String(msg).trimEnd() });
  if (_logs.length > 600) _logs.shift();
}

// ── Stats ──────────────────────────────────────────────────────────────────
function countCsv(fpath) {
  try {
    const lines  = fs.readFileSync(fpath, 'utf8').split('\n');
    const header = lines[0]?.split(',') || [];
    const ei     = header.findIndex(h => h.trim() === 'email');
    if (ei < 0) return 0;
    return lines.slice(1).filter(l => l.trim() && l.split(',')[ei]?.trim()).length;
  } catch { return 0; }
}

function countEmails() {
  try {
    const lines = fs.readFileSync(EMAILS_CSV, 'utf8')
      .split('\n').filter(l => l.trim() && !l.startsWith('#'));
    const total = lines.length;
    const done_ = new Set();
    for (const p of [SUCCESS_CSV, FAILED_CSV]) {
      try {
        const rows = fs.readFileSync(p, 'utf8').split('\n');
        const ei   = rows[0]?.split(',').findIndex(h => h.trim() === 'email') ?? -1;
        if (ei >= 0) rows.slice(1).forEach(r => { const v = r.split(',')[ei]?.trim(); if (v) done_.add(v); });
      } catch {}
    }
    const done = lines.filter(l => done_.has(l.split('|')[0].trim())).length;
    return { total, done, pending: Math.max(0, total - done) };
  } catch { return { total: 0, done: 0, pending: 0 }; }
}

function countCards() {
  try {
    return fs.readFileSync(CARDS_TXT, 'utf8')
      .split('\n').filter(l => l.trim() && !l.startsWith('#')).length;
  } catch { return 0; }
}

function vpnUp() {
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-NetAdapter | Where-Object { $_.Name -like 'Nord*' -or $_.InterfaceDescription -like 'Nord*' } | Select-Object -ExpandProperty Status"`,
      { timeout: 8000, encoding: 'utf8' }
    );
    return out.includes('Up');
  } catch { return false; }
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(express.json());

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

app.get('/api/status', (req, res) => {
  const running = _proc && _proc.exitCode === null;
  const cfg     = loadCfg();
  const sched   = _schedule ? { time: _schedule.time, count: _schedule.count, fires_at: _schedule.fires_at } : null;
  res.json({
    running,
    success:       countCsv(SUCCESS_CSV),
    failed:        countCsv(FAILED_CSV),
    cancelled:     countCsv(CANCELLED_CSV),
    emails:        countEmails(),
    cards:         countCards(),
    vpn_connected: vpnUp(),
    vpn_country:   cfg.nordvpn?.country || '—',
    proxy_on:      cfg.proxy?.enabled || false,
    mail_source:   cfg.email_source || 'hotmail',
    do_mail_check: cfg.do_mail_check !== false,
    do_cancel:     cfg.do_cancel !== false,
    schedule:      sched,
    updated_at:    new Date().toLocaleTimeString('en-GB'),
  });
});

app.get('/api/logs', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json({ lines: _logs.filter(l => l.i >= since) });
});

app.get('/api/config',  (req, res) => res.json(loadCfg()));

app.post('/api/config', (req, res) => {
  try { saveCfg(req.body); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/start', (req, res) => {
  if (_proc && _proc.exitCode === null)
    return res.status(400).json({ error: 'already running' });

  const count = parseInt(req.body?.count) || 1;
  const env   = { ...process.env, AUTO_COUNT: String(count) };
  const cwd   = path.join(BASE, 'js');

  try {
    const proc = spawn('node', [path.join(cwd, 'checkout.js')], {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    _proc   = proc;
    _logs   = [];
    _logIdx = 0;
    pushLog(`── started JS checkout (count=${count}) ──`);

    const cap = data => String(data).split('\n').forEach(l => { if (l.trim()) pushLog(l); });
    proc.stdout.on('data', cap);
    proc.stderr.on('data', cap);
    proc.on('exit', () => { pushLog('── process exited ──'); if (_proc === proc) _proc = null; });

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stop', (req, res) => {
  if (!_proc || _proc.exitCode !== null)
    return res.status(400).json({ error: 'not running' });
  _proc.kill('SIGTERM');
  pushLog('── stopped by user ──');
  res.json({ ok: true });
});

app.post('/api/upload/emails', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const content = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '');
  const lines   = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  fs.mkdirSync(path.dirname(EMAILS_CSV), { recursive: true });
  fs.writeFileSync(EMAILS_CSV, lines.join('\n') + '\n', 'utf8');
  res.json({ ok: true, count: lines.length });
});

app.post('/api/buy', async (req, res) => {
  const qty  = parseInt(req.body?.amount) || 1;
  const cfg  = loadCfg();
  const shop = cfg.shop_api || {};
  const { api_key, product_id, base_url = 'https://codecraftdeveloper.com/api' } = shop;
  if (!api_key || !product_id)
    return res.status(400).json({ error: 'shop_api not configured in config.json' });

  const payload = new URLSearchParams({ action: 'buyProduct', id: product_id, amount: qty, api_key }).toString();

  try {
    const data = await new Promise((resolve, reject) => {
      const url  = new URL(`${base_url}/buy_product`);
      const mod  = url.protocol === 'https:' ? https : http;
      const body = Buffer.from(payload);
      const r = mod.request({
        hostname: url.hostname, path: url.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length, 'User-Agent': 'Mozilla/5.0' },
      }, resp => {
        let raw = '';
        resp.on('data', d => raw += d);
        resp.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ msg: raw }); } });
      });
      r.on('error', reject);
      r.setTimeout(20000, () => r.destroy(new Error('timeout')));
      r.write(body); r.end();
    });

    const items = data.data || [];
    if (items.length) {
      fs.appendFileSync(PURCHASED_TXT, items.join('\n') + '\n', 'utf8');
      pushLog(`[Buy] Purchased ${items.length} items — saved to purchased.txt`);
    }
    res.json({ ok: true, status: data.status, items, trans_id: data.trans_id, msg: data.msg });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/schedule', (req, res) => {
  const { time: timeStr, count = 1 } = req.body || {};
  if (!timeStr) return res.status(400).json({ error: 'time required' });

  const [h, m] = timeStr.split(':').map(Number);
  const target = new Date(); target.setHours(h, m, 0, 0);
  if (target <= Date.now()) target.setDate(target.getDate() + 1);
  const delay  = target - Date.now();

  if (_schedule?.timer) clearTimeout(_schedule.timer);

  const timer = setTimeout(() => {
    pushLog(`[Schedule] Auto-starting JS checkout (count=${count})...`);
    const body = JSON.stringify({ count });
    const r = http.request({ hostname: '127.0.0.1', port: 5050, path: '/api/start', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, () => {});
    r.write(body); r.end();
  }, delay);

  const firesAt = target.toLocaleString('en-GB');
  _schedule = { time: timeStr, count, fires_at: firesAt, timer };
  res.json({ ok: true, fires_at: firesAt, delay_seconds: Math.round(delay / 1000) });
});

app.delete('/api/schedule', (req, res) => {
  if (_schedule?.timer) clearTimeout(_schedule.timer);
  _schedule = null;
  res.json({ ok: true });
});

app.post('/api/vpn/connect', (req, res) => {
  const cfg     = loadCfg();
  const country = req.body?.country || cfg.nordvpn?.country || 'United Kingdom';
  spawn(NORDVPN_EXE, ['-c', '-g', country], { detached: true, stdio: 'ignore' });
  pushLog(`[VPN] Connecting to ${country}...`);
  res.json({ ok: true });
});

app.post('/api/vpn/disconnect', (req, res) => {
  spawn(NORDVPN_EXE, ['-d'], { detached: true, stdio: 'ignore' });
  pushLog('[VPN] Disconnecting...');
  res.json({ ok: true });
});

// ── Auto-deploy webhook (GitHub → POST /api/update?token=...) ─────────────
app.post('/api/update', (req, res) => {
  const secret = process.env.DEPLOY_TOKEN || 'xpat_deploy';
  if (req.query.token !== secret) return res.status(403).json({ error: 'forbidden' });
  res.json({ ok: true, msg: 'deploying...' });
  setTimeout(() => {
    const out = execSync('git -C .. pull origin main 2>&1 && cd ../server && npm install 2>&1').toString();
    pushLog('[Deploy] ' + out.trim());
    pushLog('[Deploy] Restarting...');
    // PM2 restart if running under PM2, otherwise nothing needed (process manager handles it)
    try { execSync('pm2 restart xpat 2>&1'); } catch {}
  }, 200);
});

// ── Boot ───────────────────────────────────────────────────────────────────
app.listen(5050, '0.0.0.0', () => console.log('Dashboard → http://localhost:5050'));
