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
const { spawn, execSync, spawnSync } = require('child_process');

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
const IS_LINUX      = process.platform === 'linux';
const vpnCountryArg = c => String(c).trim().replace(/\s+/g, '_');   // Linux CLI wants United_Kingdom
const NORDVPN_EXE   = IS_LINUX ? 'nordvpn' : 'C:\\Program Files\\NordVPN\\NordVPN.exe';

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
    if (IS_LINUX) {
      const out = execSync('nordvpn status 2>&1', { timeout: 8000, encoding: 'utf8' });
      return /Status:\s*Connected/i.test(out);
    }
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

// ── Records (CSV-backed "database") ────────────────────────────────────────
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some(v => v.trim())) rows.push(row);
      row = [];
    } else cur += c;
  }
  row.push(cur);
  if (row.some(v => v.trim())) rows.push(row);
  return rows;
}

function readRecords(fpath) {
  try {
    const rows = parseCsv(fs.readFileSync(fpath, 'utf8'));
    const head = (rows.shift() || []).map(h => h.trim());
    const ei = head.indexOf('email'), ti = head.indexOf('timestamp'), ni = head.indexOf('note');
    return rows.map(r => ({ email: r[ei] || '', timestamp: r[ti] || '', note: r[ni] || '' }))
               .filter(r => r.email);
  } catch { return []; }
}

const RECORD_FILES = { success: SUCCESS_CSV, failed: FAILED_CSV, cancelled: CANCELLED_CSV };

app.get('/api/records', (req, res) => {
  const type = req.query.type;
  if (type === 'emails') {
    // never expose passwords / tokens — email address and status only
    const done = new Set([...readRecords(SUCCESS_CSV), ...readRecords(FAILED_CSV)].map(r => r.email));
    try {
      const items = fs.readFileSync(EMAILS_CSV, 'utf8').split('\n')
        .filter(l => l.trim() && !l.startsWith('#'))
        .map(l => { const e = l.split('|')[0].trim(); return { email: e, status: done.has(e) ? 'used' : 'pending' }; });
      return res.json({ items });
    } catch { return res.json({ items: [] }); }
  }
  if (!RECORD_FILES[type]) return res.status(400).json({ error: 'bad type' });
  res.json({ items: readRecords(RECORD_FILES[type]).reverse() });
});

app.get('/api/stats', (req, res) => {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    days.push(d.toLocaleDateString('sv-SE'));
  }
  const series = { success: [], failed: [], cancelled: [] };
  const reasons = {};
  for (const [k, f] of Object.entries(RECORD_FILES)) {
    const recs = readRecords(f);
    series[k] = days.map(day => recs.filter(r => r.timestamp.startsWith(day)).length);
    if (k === 'failed') recs.forEach(r => {
      const n = (r.note || 'unknown').slice(0, 60);
      reasons[n] = (reasons[n] || 0) + 1;
    });
  }
  const topReasons = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
  res.json({ days, series, topReasons });
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
    // Linux VPS: run the server variant inside a virtual display so real (headed) Chrome works
    const [cmd, args] = IS_LINUX
      ? ['xvfb-run', ['-a', '--server-args=-screen 0 1920x1080x24', 'node', path.join(cwd, 'checkout-server.js')]]
      : ['node', [path.join(cwd, 'checkout.js')]];
    const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('error', e => pushLog(`✗ failed to launch (${cmd}): ${e.message}`));
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

function buyAccounts(qty) {
  const shop = loadCfg().shop_api || {};
  const { api_key, product_id, base_url = 'https://codecraftdeveloper.com/api' } = shop;
  if (!api_key || !product_id) return Promise.reject(new Error('shop_api not configured in config.json'));
  const body = Buffer.from(new URLSearchParams({ action: 'buyProduct', id: product_id, amount: qty, api_key }).toString());
  return new Promise((resolve, reject) => {
    const url = new URL(`${base_url}/buy_product`);
    const r = (url.protocol === 'https:' ? https : http).request({
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
  }).then(data => {
    const items = (data.data || []).map(String);
    if (items.length) {
      fs.appendFileSync(PURCHASED_TXT, items.join('\n') + '\n', 'utf8');
      // bought hotmail accounts go straight into the pool the run reads
      fs.mkdirSync(path.dirname(EMAILS_CSV), { recursive: true });
      const cur = fs.existsSync(EMAILS_CSV) ? fs.readFileSync(EMAILS_CSV, 'utf8') : '';
      fs.appendFileSync(EMAILS_CSV, (cur && !cur.endsWith('\n') ? '\n' : '') + items.join('\n') + '\n', 'utf8');
      pushLog(`[Buy] Purchased ${items.length} account(s) — added to email pool`);
    }
    return { items, status: data.status, trans_id: data.trans_id, msg: data.msg };
  });
}

app.post('/api/buy', async (req, res) => {
  try { res.json({ ok: true, ...(await buyAccounts(parseInt(req.body?.amount) || 1)) }); }
  catch (e) { res.status(e.message.includes('not configured') ? 400 : 500).json({ error: e.message }); }
});

// ── Auto-buy while a run is active: keep the email pool topped up ──────────
let _autoBuying = false, _lastAutoBuy = 0;
setInterval(async () => {
  if (_autoBuying || !(_proc && _proc.exitCode === null)) return;
  const ab = loadCfg().shop_api?.auto_buy || {};
  if (!ab.enabled || Date.now() - _lastAutoBuy < 60_000) return;
  if (countEmails().pending > (parseInt(ab.min_accounts) || 0)) return;
  _autoBuying = true; _lastAutoBuy = Date.now();
  try { pushLog(`[Buy] Pool low — buying ${parseInt(ab.amount) || 5}...`); await buyAccounts(parseInt(ab.amount) || 5); }
  catch (e) { pushLog(`[Buy] Auto-buy failed: ${e.message}`); }
  _autoBuying = false;
}, 15_000);

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

app.post('/api/vpn/login', (req, res) => {
  const token = (req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });
  const r = spawnSync('nordvpn', ['login', '--token', token], { timeout: 15000, encoding: 'utf8' });
  const out = (r.stdout + r.stderr).trim();
  pushLog('[VPN] ' + out);
  if (r.status === 0) res.json({ ok: true, msg: out });
  else res.status(500).json({ error: out || 'login failed' });
});

// ── Cards (cards.txt manager) ──────────────────────────────────────────────
// line format: first|last|number|exp_month|exp_year|cvv|kyash_email
function readCardLines() {
  try { return fs.readFileSync(CARDS_TXT, 'utf8').split(/\r?\n/); } catch { return []; }
}
function cardView(line, i) {
  const p = line.split('|').map(s => s.trim());
  return { id: i, name: `${p[0] || ''} ${p[1] || ''}`.trim(), last4: (p[2] || '').slice(-4), bin: (p[2] || '').slice(0, 6),
           exp: `${p[3] || '??'}/${p[4] || '??'}`, tag: p[6] || '' };
}
app.get('/api/cards', (req, res) => {
  const items = [];
  readCardLines().forEach((l, i) => {
    if (l.trim() && !l.trim().startsWith('#') && l.split('|').length >= 6) items.push(cardView(l, i));
  });
  res.json({ items });
});
app.post('/api/cards', (req, res) => {
  const lines = String(req.body?.text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const good = lines.filter(l => l.split('|').length >= 6);
  if (!good.length) return res.status(400).json({ error: 'no valid lines (need first|last|number|mm|yy|cvv|tag)' });
  const existing = new Set(readCardLines().map(l => l.trim()));
  const add = [...new Set(good)].filter(l => !existing.has(l));
  if (add.length) {
    const cur = fs.existsSync(CARDS_TXT) ? fs.readFileSync(CARDS_TXT, 'utf8') : '';
    fs.writeFileSync(CARDS_TXT, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n', 'utf8');
  }
  res.json({ ok: true, added: add.length, skipped: lines.length - add.length });
});
app.delete('/api/cards', (req, res) => {
  const ids = new Set((req.body?.ids || []).map(Number));
  if (!ids.size) return res.status(400).json({ error: 'no ids' });
  const lines = readCardLines();
  const kept = lines.filter((_, i) => !ids.has(i));
  fs.writeFileSync(CARDS_TXT, kept.join('\n'), 'utf8');
  res.json({ ok: true, removed: lines.length - kept.length });
});

// ── VPN status / test ──────────────────────────────────────────────────────
const { execFile } = require('child_process');
function run(cmd, args, timeout = 15000) {
  return new Promise(resolve => execFile(cmd, args, { timeout, encoding: 'utf8' },
    (err, stdout, stderr) => resolve({ ok: !err, out: ((stdout || '') + (stderr || '')).replace(/[\r\x00-\x08]|\x1b\[[0-9;?]*[A-Za-z]|[-\\|/]\s{2,}/g, '').trim() })));
}
async function publicIp(tries = 1) {
  for (let i = 0; i < tries; i++) {
    for (const u of ['https://api.ipify.org?format=json', 'https://ipinfo.io/json']) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
        const ip = (await r.json()).ip;
        if (ip) return ip;
      } catch {}
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}
// Keep SSH + dashboard reachable while the VPN is up (otherwise connecting cuts them off)
async function vpnProtectAccess() {
  if (!IS_LINUX) return;
  for (const port of ['22', '5050']) {
    // v6 renamed whitelist -> allowlist; already-present is a harmless error
    const r = await run('nordvpn', ['allowlist', 'add', 'port', port]);
    if (/doesn't exist/i.test(r.out)) await run('nordvpn', ['whitelist', 'add', 'port', port]);
  }
  await run('nordvpn', ['set', 'killswitch', 'off']);
}
async function vpnInfo() {
  if (!IS_LINUX) return { cli: false, logged_in: null, connected: vpnUp(), detail: 'Login status is only available with the Linux CLI.' };
  const acc = await run('nordvpn', ['account']);
  const st  = await run('nordvpn', ['status']);
  const notLogged = /not logged in|log in/i.test(acc.out) || (!acc.ok && /login/i.test(acc.out));
  const missing = !acc.ok && /ENOENT|not found/i.test(acc.out);
  return {
    cli: !missing,
    logged_in: missing ? false : !notLogged && acc.ok,
    account: acc.out.split('\n').find(l => /email/i.test(l))?.replace(/^.*?:\s*/, '') || null,
    connected: /Status:\s*Connected/i.test(st.out),
    country: st.out.match(/Country:\s*(.+)/i)?.[1]?.trim() || null,
    ip: st.out.match(/\bIP:\s*(\S+)/i)?.[1] || null,
    detail: missing ? 'nordvpn CLI not installed' : (notLogged ? 'Not logged in' : ''),
  };
}
app.get('/api/vpn/status', async (req, res) => res.json(await vpnInfo()));

let _vpnTesting = false;
app.post('/api/vpn/test', async (req, res) => {
  if (_vpnTesting) return res.status(400).json({ error: 'test already running' });
  _vpnTesting = true;
  const country = req.body?.country || loadCfg().nordvpn?.country || 'United Kingdom';
  const steps = [];
  const step = (name, ok, detail = '') => { steps.push({ name, ok, detail }); pushLog(`[VPN] test: ${name} ${ok ? 'OK' : 'FAILED'} ${detail}`); };
  try {
    if (!IS_LINUX) {
      step('connect', false, 'Test needs the Linux nordvpn CLI');
      return res.json({ ok: false, steps });
    }
    const info = await vpnInfo();
    step('logged in', !!info.logged_in, info.account || info.detail);
    if (!info.logged_in) return res.json({ ok: false, steps });

    const ipBefore = await publicIp();
    step('public IP (before)', !!ipBefore, ipBefore || 'lookup failed');

    await vpnProtectAccess();
    const c = await run('nordvpn', ['connect', vpnCountryArg(country)], 60000);
    const after = await vpnInfo();
    step('connect', c.ok && after.connected, after.connected ? `${after.country || country}` : c.out.split('\n').pop());

    const ipVpn = after.connected ? await publicIp(5) : null;
    step('public IP (on VPN)', !!ipVpn && ipVpn !== ipBefore, ipVpn ? `${ipVpn}${ipVpn === ipBefore ? ' (unchanged)' : ''}` : 'lookup failed');

    const d = await run('nordvpn', ['disconnect'], 30000);
    const end = await vpnInfo();
    step('disconnect', d.ok && !end.connected, end.connected ? 'still connected' : '');

    res.json({ ok: steps.every(s => s.ok), steps, ip_before: ipBefore, ip_vpn: ipVpn });
  } catch (e) {
    res.status(500).json({ error: e.message, steps });
  } finally { _vpnTesting = false; }
});

app.post('/api/vpn/connect', async (req, res) => {
  const cfg     = loadCfg();
  const country = req.body?.country || cfg.nordvpn?.country || 'United Kingdom';
  await vpnProtectAccess();
  const args    = IS_LINUX ? ['connect', vpnCountryArg(country)] : ['-c', '-g', country];
  spawn(NORDVPN_EXE, args, { detached: true, stdio: 'ignore' });
  pushLog(`[VPN] Connecting to ${country}...`);
  res.json({ ok: true });
});

app.post('/api/vpn/disconnect', (req, res) => {
  const args = IS_LINUX ? ['disconnect'] : ['-d'];
  spawn(NORDVPN_EXE, args, { detached: true, stdio: 'ignore' });
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

// ── Provision VPS (Xvfb + Chrome + js deps) if anything is missing ─────────
if (IS_LINUX && process.getuid?.() === 0) {
  const missing = spawnSync('bash', ['-c', 'command -v xvfb-run && command -v google-chrome'], { encoding: 'utf8' }).status !== 0
    || !fs.existsSync(path.join(BASE, 'js', 'node_modules', 'patchright'));
  if (missing) {
    pushLog('[Setup] Installing Chrome, Xvfb and checkout dependencies (first run)...');
    const p = spawn('bash', [path.join(__dirname, 'provision.sh')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const cap = d => String(d).split(/\r?\n/).forEach(l => { if (l.trim()) pushLog(l.slice(0, 200)); });
    p.stdout.on('data', cap); p.stderr.on('data', cap);
    p.on('exit', c => pushLog(c === 0 ? '[Setup] ✓ complete' : `[Setup] ✗ failed (exit ${c}) — see logs`));
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
app.listen(5050, '0.0.0.0', () => console.log('Dashboard → http://localhost:5050'));
