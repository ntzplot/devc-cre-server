#!/usr/bin/env node
// XPAT PC agent — keeps this PC connected to the dashboard so the checkout can run here
// (with your local NordVPN) while everything is controlled from the dashboard on the VPS.
//
//   node agent/agent.js http://<vps>:5050 <agent-token>      (first run saves them)
//   node agent/agent.js                                       (afterwards)
//
// No dependencies; needs Node 18+. The agent only makes outbound requests to the dashboard.

const fs   = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT  = path.join(__dirname, '..');
const JSDIR = path.join(ROOT, 'js');
const CONF  = path.join(__dirname, 'agent.config.json');

let conf = {};
try { conf = JSON.parse(fs.readFileSync(CONF, 'utf8')); } catch {}
if (process.argv[2]) conf.server = process.argv[2];
if (process.argv[3]) conf.token  = process.argv[3];
conf.server = (process.env.XPAT_SERVER || conf.server || '').replace(/\/+$/, '');
conf.token  = process.env.XPAT_TOKEN  || conf.token;
if (!conf.server || !conf.token) {
  console.error('Usage: node agent/agent.js http://<vps-ip>:5050 <agent-token>\nThe token is shown on the dashboard Run page.');
  process.exit(1);
}
fs.writeFileSync(CONF, JSON.stringify({ server: conf.server, token: conf.token }, null, 2));

const RESULT_FILES = ['js/success.csv', 'js/failed.csv', 'js/successemailfull.csv', 'js/cancelled.csv', 'js/codes.csv', 'js/cancel_failed.csv'];
const JS_SCRIPT = process.platform === 'win32' ? 'checkout.js' : 'checkout-server.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString('en-GB');
const say   = m => console.log(`${stamp()}  [agent] ${m}`);

async function api(method, route, body, extra = {}) {
  const headers = { 'x-agent-token': conf.token, ...(extra.headers || {}) };
  let payload;
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) payload = body;
    else { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  }
  const r = await fetch(conf.server + route, { method, headers, body: payload, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${route} → HTTP ${r.status}`);
  return r.json();
}

// ── state ─────────────────────────────────────────────────────────────────────
let child = null, starting = false;
let logBuf = [];
const sentResults = {};
let lastFrame = 0;

const pushLine = l => { if (String(l).trim()) logBuf.push(String(l).replace(/\r$/, '')); };
async function flushLogs() {
  if (!logBuf.length) return;
  const lines = logBuf; logBuf = [];
  try { await api('POST', '/api/agent/log', { lines }); } catch { logBuf = lines.concat(logBuf); }
}

function readLocal(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; } }
async function uploadResults(force = false) {
  const files = {};
  for (const rel of RESULT_FILES) {
    const t = readLocal(rel);
    if (t && (force || sentResults[rel] !== t)) files[rel] = t;
  }
  if (!Object.keys(files).length) return;
  try {
    await api('POST', '/api/agent/results', { files });
    for (const rel of Object.keys(files)) sentResults[rel] = files[rel];
  } catch (e) { say('result upload failed: ' + e.message); }
}

async function syncDown(only) {
  const q = only ? '?only=' + encodeURIComponent(only.join(',')) : '';
  const { files } = await api('GET', '/api/agent/bundle' + q);
  for (const [rel, text] of Object.entries(files)) {
    const f = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    if (rel === 'config/config.json' || text || !fs.existsSync(f)) {
      const tmp = f + '.tmp'; fs.writeFileSync(tmp, text, 'utf8'); fs.renameSync(tmp, f);
    }
    if (RESULT_FILES.includes(rel)) sentResults[rel] = text;
  }
}

async function uploadFrame() {
  const jpg = path.join(JSDIR, 'debug', 'live.jpg');
  try {
    const st = fs.statSync(jpg);
    if (st.mtimeMs === lastFrame || Date.now() - st.mtimeMs > 30_000) return;
    lastFrame = st.mtimeMs;
    let url = '';
    try { url = JSON.parse(fs.readFileSync(path.join(JSDIR, 'debug', 'live.json'), 'utf8')).url || ''; } catch {}
    await api('POST', '/api/agent/frame', fs.readFileSync(jpg), { headers: { 'content-type': 'image/jpeg', 'x-url': url } });
  } catch {}
}

function killChild() {
  if (!child) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  else try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
}

async function startRun(count, script = 'js') {
  starting = true;
  try {
    await uploadResults();               // don't lose anything produced offline
    await syncDown();                    // config, cards, email pool, results from the dashboard

    let cmd, args, cwd;
    if (script === 'working') {
      cwd  = path.join(ROOT, 'working', '1');
      cmd  = 'python';
      args = [path.join(cwd, 'checkout.py')];
    } else {
      cwd  = JSDIR;
      cmd  = process.execPath;
      args = [path.join(JSDIR, JS_SCRIPT)];
    }

    say(`starting ${script} (count=${count})`);
    const p = spawn(cmd, args, {
      cwd, env: { ...process.env, AUTO_COUNT: String(count) },
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    child = p;
    let rest = '';
    const cap = d => { const parts = (rest + d).split('\n'); rest = parts.pop(); parts.forEach(pushLine); };
    p.stdout.on('data', cap); p.stderr.on('data', cap);
    p.on('error', e => pushLine('✗ agent failed to launch checkout: ' + e.message));
    p.on('exit', async code => {
      if (rest) pushLine(rest);
      pushLine(`── process exited (PC, code ${code}) ──`);
      child = null;
      await flushLogs(); await uploadResults(true);
    });
  } catch (e) {
    pushLine('✗ agent could not start: ' + e.message);
  } finally { starting = false; }
}

// ── main loops ────────────────────────────────────────────────────────────────
(async function pollLoop() {
  say(`connected to ${conf.server} — waiting for commands (Ctrl+C to quit)`);
  let warned = false;
  while (true) {
    try {
      const r = await api('POST', '/api/agent/poll', { busy: !!child || starting });
      warned = false;
      if (r.cmd === 'start' && !child && !starting) startRun(r.count, r.script || 'js');
      if (r.cmd === 'stop' && child) { say('stop requested'); pushLine('── stopped by user ──'); killChild(); }
    } catch (e) {
      if (!warned) say('dashboard unreachable: ' + e.message + ' (retrying)');
      warned = true;
    }
    await sleep(3000);
  }
})();

setInterval(async () => { await flushLogs(); if (child) await uploadFrame(); }, 1000);
setInterval(() => { if (child) uploadResults(); }, 5000);
setInterval(() => { if (child) syncDown(['1/emails.csv']).catch(() => {}); }, 10_000);   // pick up auto-bought accounts

process.on('SIGINT', () => { killChild(); process.exit(0); });
