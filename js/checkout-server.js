'use strict';

/**
 * SERVER VARIANT (Ubuntu: Linux nordvpn CLI, Chrome under Xvfb).
 * Launched by server/app.js via xvfb-run. Keep in sync with checkout.js.
 *
 * Playwright + real Chrome checkout for xpatfone.com
 *
 * Setup:
 *   npm install
 *   npx playwright install chrome
 *   node checkout.js
 *
 * Requires Node >= 18 (built-in fetch + AbortSignal.timeout)
 */

const { chromium }  = require('patchright');
const fs            = require('fs');
const path          = require('path');
const os            = require('os');
const readline      = require('readline');
const { spawnSync } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────

const _cfgRaw = fs.readFileSync(path.join(__dirname, '..', 'config', 'config.json'), 'utf8').replace(/^\uFEFF/, '');
const CFG = JSON.parse(_cfgRaw);

const CF_WORKER     = CFG.cf_worker_url;
const CF_EMAIL_CHK  = CFG.cf_emailcheck_url;
const PROXY_CFG     = CFG.proxy;
const NORDVPN_CTRY  = CFG.nordvpn.country;
const NORDVPN_EVERY = CFG.nordvpn.reconnect_every;
const GMAIL_API_URL = CFG.gmail?.api_url ?? 'https://gmail-token-api.apoh59620.workers.dev/api';
const GMAIL_BASE    = CFG.gmail?.base    ?? 'jokertgolerty';
const GMAIL_DOMAIN  = CFG.gmail?.domain  ?? 'gmail.com';
const DO_MAIL_CHECK = CFG.do_mail_check !== false;
const DO_CANCEL     = CFG.do_cancel     !== false;
const ADDRESSES     = CFG.addresses ?? [];


const SUCCESS_CSV       = path.join(__dirname, 'success.csv');
const SUCCESS_FULL_CSV  = path.join(__dirname, 'successemailfull.csv');
const FAILED_CSV        = path.join(__dirname, 'failed.csv');
const CODES_CSV         = path.join(__dirname, 'codes.csv');
const CANCELLED_CSV     = path.join(__dirname, 'cancelled.csv');
const CANCEL_FAILED_CSV = path.join(__dirname, 'cancel_failed.csv');
const CARDS_TXT         = path.join(__dirname, '..', 'cards.txt');
const FIRSTNAME_TXT     = path.join(__dirname, '..', 'config', 'firstname.txt');
const LASTNAME_TXT      = path.join(__dirname, '..', 'config', 'lastname.txt');

const START_URL   = 'https://xpatfone.com/pricing';
const LOGIN_URL   = 'https://xpatfone.com/login';
const ACCOUNT_URL = 'https://xpatfone.com/account';
const IFRAME_ID   = '#cb-frame';
const TIMEOUT     = 45_000;

const NETWORK_ERRORS = [
  'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_RESET',
  'ERR_PROXY_CONNECTION_FAILED', 'Target page, context or browser has been closed',
];

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
const pick  = arr => arr[Math.floor(Math.random() * arr.length)];

function loadLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

// Hotmail pool (shared with the dashboard): email|password|token per line
const EMAIL_SOURCE = CFG.email_source ?? 'gmail';
const EMAILS_CSV   = path.join(__dirname, '..', '1', 'emails.csv');
function readHotmail() {
  return loadLines(EMAILS_CSV).filter(l => !l.startsWith('#')).map(l => l.split('|')[0].trim()).filter(Boolean);
}

function askCount() {
  const envN = parseInt(process.env.AUTO_COUNT || '', 10);
  if (envN > 0) { console.log(`[Auto] Count: ${envN}`); return Promise.resolve(envN); }
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => rl.question('How many emails to generate? ', ans => {
      const n = parseInt(ans.trim(), 10);
      if (n > 0) { rl.close(); resolve(n); }
      else { console.log('Enter a number greater than 0.'); ask(); }
    });
    ask();
  });
}

function csvEscape(...fields) {
  return fields.map(f => `"${String(f ?? '').replace(/"/g, '""')}"`).join(',');
}

// ── Random identity picker ────────────────────────────────────────────────────

function pickIdentity() {
  const firstNames = loadLines(FIRSTNAME_TXT);
  const lastNames  = loadLines(LASTNAME_TXT);
  const addr       = pick(ADDRESSES);
  return {
    first: pick(firstNames),
    last:  pick(lastNames),
    street: addr.street,
    city:   addr.city,
    state:  addr.state,
    zip:    addr.zip,
  };
}

// ── Human mouse movement (bezier curve) ──────────────────────────────────────

async function humanMove(page, tx, ty) {
  const sx  = tx + rand(-220, 220);
  const sy  = ty + rand(-160, 160);
  const cpx = (sx + tx) / 2 + rand(-90, 90);
  const cpy = (sy + ty) / 2 + rand(-70, 70);
  const steps = rand(18, 34);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) ** 2 * sx + 2 * (1 - t) * t * cpx + t ** 2 * tx;
    const y = (1 - t) ** 2 * sy + 2 * (1 - t) * t * cpy + t ** 2 * ty;
    await page.mouse.move(
      x + (Math.random() - 0.5) * 1.5,
      y + (Math.random() - 0.5) * 1.5,
    );
    await sleep(rand(7, 17));
  }
}

// ── Email generation & inbox polling ─────────────────────────────────────────

const GMAIL_MODE     = CFG.gmail?.email_mode ?? 'both';
const USED_DOTS_FILE = path.join(__dirname, 'used_dots.txt');

function dotVariants(base) {
  const out = [];
  for (let i = 1; i < base.length; i++) out.push(`${base.slice(0, i)}.${base.slice(i)}`);
  return out;
}

function loadUsedDots() {
  if (!fs.existsSync(USED_DOTS_FILE)) return new Set();
  return new Set(
    fs.readFileSync(USED_DOTS_FILE, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  );
}

function markDotUsed(email) {
  fs.appendFileSync(USED_DOTS_FILE, email + '\n', 'utf8');
}

function generateEmail() {
  if (GMAIL_MODE === 'dot' || GMAIL_MODE === 'both') {
    const variants = dotVariants(GMAIL_BASE);
    const used     = loadUsedDots();
    const unused   = variants.filter(v => !used.has(`${v}@${GMAIL_DOMAIN}`));
    if (unused.length) {
      const local = unused[Math.floor(Math.random() * unused.length)];
      const email = `${local}@${GMAIL_DOMAIN}`;
      markDotUsed(email);
      return email;
    }
    if (GMAIL_MODE === 'dot') throw new Error(`All ${variants.length} dot variants exhausted`);
  }
  const chars  = 'abcdefghijklmnopqrstuvwxyz';
  const len    = 4 + Math.floor(Math.random() * 2);
  const suffix = Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${GMAIL_BASE}+${suffix}@${GMAIL_DOMAIN}`;
}

async function fetchDevyceCode(email, timeoutMs = 120_000) {
  const url      = `${GMAIL_API_URL}/emails?email=${encodeURIComponent(email)}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const res  = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10_000),
      });
      const data = await res.json();
      for (const msg of data?.data?.emails ?? []) {
        const body = msg.body || '';
        const m = body.match(/Login using your code[:\s\r\n*]+([A-Z0-9]{4,10})/);
        if (m) return m[1].trim();
      }
    } catch (e) { console.log(`  [Gmail poll] ${e.message}`); }
  }
  return null;
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function alreadyProcessed(files = [SUCCESS_CSV, FAILED_CSV]) {
  const done = new Set();
  for (const p of files) {
    if (!fs.existsSync(p)) continue;
    for (const row of fs.readFileSync(p, 'utf8').split(/\r?\n/).slice(1)) {
      const email = row.split(',')[0]?.replace(/^"|"$/g, '').trim();
      if (email) done.add(email);
    }
  }
  return done;
}

function appendResult(filePath, email, note = '') {
  const writeHeader = !fs.existsSync(filePath);
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (writeHeader) fs.appendFileSync(filePath, 'email,timestamp,note\n', 'utf8');
  fs.appendFileSync(filePath, csvEscape(email, ts, note) + '\n', 'utf8');
}

function appendCode(email, code) {
  const writeHeader = !fs.existsSync(CODES_CSV);
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  if (writeHeader) fs.appendFileSync(CODES_CSV, 'email,code,timestamp\n', 'utf8');
  fs.appendFileSync(CODES_CSV, csvEscape(email, code, ts) + '\n', 'utf8');
}

function readCards() {
  const cards = [];
  for (const raw of fs.readFileSync(CARDS_TXT, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split('|').map(s => s.trim());
    if (p.length >= 6) cards.push({
      first: p[0], last: p[1], number: p[2],
      exp_month: p[3], exp_year: p[4], cvv: p[5],
      kyash_email: p[6] || 'default',
    });
  }
  if (!cards.length) throw new Error('cards.txt is empty or has no valid entries');
  return cards;
}

async function cfPost(url, body) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

async function postSuccessLine(fullLine) {
  fs.appendFileSync(SUCCESS_FULL_CSV, fullLine + '\n', 'utf8');
  await cfPost(`${CF_WORKER}/success`, fullLine);
  await cfPost(`${CF_EMAIL_CHK}/import`, fullLine);
}

async function postFailedLine(fullLine) {
  await cfPost(`${CF_EMAIL_CHK}/failed`, fullLine);
}

// ── NordVPN ───────────────────────────────────────────────────────────────────

function nordvpnAdapterUp() {
  try {
    const r = spawnSync('nordvpn', ['status'], { encoding: 'utf8', timeout: 10_000 });
    return /Status:\s*Connected/i.test(r.stdout || '');
  } catch { return false; }
}

async function nordvpnConnect(country = NORDVPN_CTRY) {
  // keep SSH + dashboard reachable while the VPN is up
  for (const port of ['22', '5050']) {
    const r = spawnSync('nordvpn', ['allowlist', 'add', 'port', port], { encoding: 'utf8', timeout: 10_000 });
    if (/doesn't exist/i.test((r.stdout || '') + (r.stderr || ''))) spawnSync('nordvpn', ['whitelist', 'add', 'port', port], { timeout: 10_000 });
  }
  spawnSync('nordvpn', ['set', 'killswitch', 'off'], { timeout: 10_000 });
  console.log(`[NordVPN] Connecting to ${country}...`);
  try { spawnSync('nordvpn', ['connect', country.trim().replace(/\s+/g, '_')], { timeout: 60_000 }); }
  catch (e) { console.log(`[NordVPN] Connect error: ${e.message}`); return; }
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    if (nordvpnAdapterUp()) { console.log(`[NordVPN] Connected to ${country}`); return; }
  }
  console.log('[NordVPN] Warning: adapter not Up after 60s — continuing');
}

async function nordvpnDisconnect() {
  console.log('[NordVPN] Disconnecting...');
  try { spawnSync('nordvpn', ['disconnect'], { timeout: 30_000 }); }
  catch (e) { console.log(`[NordVPN] Disconnect error: ${e.message}`); return; }
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    if (!nordvpnAdapterUp()) { console.log('[NordVPN] Disconnected'); return; }
  }
  console.log('[NordVPN] Warning: adapter still Up — continuing');
}

// ── OTP poller ────────────────────────────────────────────────────────────────

async function waitForOtp(startTime, email = 'default', timeoutMs = 90_000) {
  const sinceMs  = startTime - 3000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const url = `${CF_WORKER}/otp?email=${encodeURIComponent(email)}&since=${sinceMs}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        const raw  = data.otp || '';
        if (raw) {
          const m = raw.match(/パスワードは(\d{6})に/) || raw.match(/\b(\d{6})\b/);
          return m ? m[1] : raw;
        }
      }
    } catch (e) { console.log(`  [CF poll error] ${e.message}`); }
  }
  return null;
}

// ── Browser ───────────────────────────────────────────────────────────────────

// Per-session random seeds for fingerprint noise (regenerated each makeBrowser call)
function makeFpSeeds() {
  return {
    canvasShift: rand(1, 9),
    webglVendor:  pick(['Intel Inc.', 'Google Inc. (Intel)', 'NVIDIA Corporation', 'AMD']),
    webglRenderer: pick([
      'Intel Iris OpenGL Engine',
      'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)',
      'ANGLE (NVIDIA, NVIDIA GeForce GTX 1060 Direct3D11 vs_5_0 ps_5_0)',
      'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0)',
    ]),
    audioNoise: (Math.random() * 0.0002 - 0.0001).toFixed(7),
    hardwareConcurrency: pick([4, 6, 8, 12, 16]),
    deviceMemory: pick([4, 8, 16]),
  };
}

async function makeBrowser(prefix = 'chrome_tmp_') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const seeds  = makeFpSeeds();

  const opts = {
    headless: false,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
      '--no-sandbox',            // running as root on the VPS
      '--disable-dev-shm-usage',
      '--window-size=1920,1080',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-notifications',
      '--disable-popup-blocking',
      '--metrics-recording-only',
      '--use-mock-keychain',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: null,
    locale: 'en-GB',
    timezoneId: 'Europe/London',
  };

  if (PROXY_CFG.enabled) {
    opts.proxy = {
      server:   PROXY_CFG.server,
      username: PROXY_CFG.username,
      password: PROXY_CFG.password,
    };
  }

  const ctx = await chromium.launchPersistentContext(tmpDir, opts);

  // Inject per-session fingerprint spoofing
  await ctx.addInitScript(({ seeds: s }) => {
    // webdriver
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // hardware signals
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => s.hardwareConcurrency });
    Object.defineProperty(navigator, 'deviceMemory',        { get: () => s.deviceMemory });
    Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-GB', 'en'] });

    // chrome object
    window.chrome = {
      runtime:    { connect: () => {}, sendMessage: () => {} },
      loadTimes:  () => ({}),
      csi:        () => ({}),
      app:        { isInstalled: false },
    };

    // Canvas noise — add imperceptible per-session shift to pixel values
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const ctx2d = this.getContext('2d');
      if (ctx2d) {
        const img  = ctx2d.getImageData(0, 0, this.width || 1, this.height || 1);
        img.data[0] = (img.data[0] + s.canvasShift) & 0xff;
        ctx2d.putImageData(img, 0, 0);
      }
      return origToDataURL.apply(this, args);
    };

    // WebGL vendor / renderer
    const origGetParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return s.webglVendor;
      if (p === 37446) return s.webglRenderer;
      return origGetParam.call(this, p);
    };
    const origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (p) {
      if (p === 37445) return s.webglVendor;
      if (p === 37446) return s.webglRenderer;
      return origGetParam2.call(this, p);
    };

    // AudioContext noise
    const origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = function (ch) {
      const data = origGetChannelData.call(this, ch);
      for (let i = 0; i < data.length; i += 100) {
        data[i] += parseFloat(s.audioNoise);
      }
      return data;
    };

    // Permissions API — pretend no automation permissions
    const origQuery = window.Permissions && window.Permissions.prototype.query;
    if (origQuery) {
      window.Permissions.prototype.query = function (perm) {
        if (perm.name === 'notifications') {
          return Promise.resolve({ state: 'denied', onchange: null });
        }
        return origQuery.call(this, perm);
      };
    }
  }, { seeds });

  return { ctx, tmpDir };
}

// ── Browser interaction helpers ───────────────────────────────────────────────

async function humanType(locator, text) {
  await locator.click();
  await sleep(rand(150, 350));
  await locator.pressSequentially(text, { delay: rand(80, 160) });
}

async function waitClick(locator, timeout = TIMEOUT, page = null) {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded();
  await sleep(rand(350, 750));
  if (page) {
    const box = await locator.boundingBox().catch(() => null);
    if (box) {
      const tx = box.x + box.width  * (0.2 + Math.random() * 0.6);
      const ty = box.y + box.height * (0.2 + Math.random() * 0.6);
      await humanMove(page, tx, ty);
      await sleep(rand(40, 110));
      await page.mouse.click(tx, ty);
      return;
    }
  }
  await locator.click();
}

// ── 3DS handler ───────────────────────────────────────────────────────────────

class ThreeDSError extends Error {}

async function find3dsFrame(page) {
  for (const frame of page.frames()) {
    try { if (await frame.locator('#CredentialId-1a').count() > 0) return frame; }
    catch {}
  }
  return null;
}

async function handle3ds(page, kyashEmail = 'default') {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (page.url().startsWith('https://xpatfone.com/thanks/')) return;
    const frame = await find3dsFrame(page);
    if (frame) {
      console.log('  ⚠ 3DS detected — selecting push notification...');
      try {
        const startTime = Date.now();
        const label = frame.locator('label[for="CredentialId-1a"]');
        await label.waitFor({ state: 'visible', timeout: 15_000 });
        await sleep(1500);
        await label.click();
        await sleep(500);
        const btn = frame.locator('#ContinueButton');
        await btn.waitFor({ state: 'visible', timeout: 10_000 });
        await sleep(500);
        await btn.click();
        await sleep(2000);
        console.log('  ⏳ Waiting for OTP (90s)...');
        const otp = await waitForOtp(startTime, kyashEmail, 90_000);
        if (!otp) throw new ThreeDSError('3DS OTP timeout — no code in 90s');
        console.log(`  📲 OTP: ${otp}`);
        const otpInput = frame.locator('#CredentialValidateInput');
        await otpInput.waitFor({ state: 'visible', timeout: 10_000 });
        await otpInput.fill(otp);
        await sleep(500);
        const validateBtn = frame.locator('#ValidateButton');
        await validateBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await validateBtn.click();
        await page.waitForURL('https://xpatfone.com/thanks/', { timeout: 30_000 });
        return;
      } catch (e) {
        if (e instanceof ThreeDSError) throw e;
        throw new ThreeDSError('3DS completed but /thanks/ not reached');
      }
    }
    await sleep(1000);
  }
  throw new ThreeDSError('Timed out waiting for /thanks/ or 3DS challenge');
}

// ── Checkout ──────────────────────────────────────────────────────────────────

async function checkout(page, email, card, identity) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(rand(2000, 3000));

  await waitClick(
    page.locator('[data-cb-type="checkout"][data-cb-plan-id="devyce-solo-xpat-int"]'),
    TIMEOUT, page,
  );

  const iframeEl = await page.waitForSelector(IFRAME_ID, { timeout: TIMEOUT });
  await sleep(2000);
  const cb    = page.frameLocator(IFRAME_ID);
  const frame = await iframeEl.contentFrame();

  await waitClick(cb.locator('[data-cb-id="cart_submit"]'), TIMEOUT, page);
  await sleep(1200);

  const emailField = cb.locator('#email');
  await emailField.waitFor({ state: 'visible', timeout: TIMEOUT });
  await emailField.fill(email);
  await sleep(600);
  await waitClick(cb.locator('[data-cb-id="auth_submit"]'), TIMEOUT, page);
  await sleep(2000);

  // Billing address
  await cb.locator('#first_name').waitFor({ state: 'visible', timeout: TIMEOUT });
  await humanType(cb.locator('#first_name'), identity.first);
  await sleep(300);
  await humanType(cb.locator('#last_name'), identity.last);
  await sleep(300);
  await cb.locator('#line1').waitFor({ state: 'visible', timeout: TIMEOUT });
  await frame.evaluate(v => {
    const el = document.getElementById('line1');
    el.value = v;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, identity.street);
  await sleep(300);
  await humanType(cb.locator('#city'),  identity.city);
  await sleep(300);
  await humanType(cb.locator('#state'), identity.state);
  await sleep(300);
  await humanType(cb.locator('#zip'),   identity.zip);
  await sleep(600);
  await waitClick(cb.locator('[data-cb-id="address_submit"]'), TIMEOUT, page);
  await sleep(2500);

  // Card details
  const fn = cb.locator('input[autocomplete="cc-given-name"]');
  await fn.waitFor({ state: 'visible', timeout: TIMEOUT });
  await sleep(rand(800, 1500));
  await humanType(fn, card.first);
  await sleep(rand(400, 800));
  await humanType(cb.locator('input[autocomplete="cc-family-name"]'), card.last);
  await sleep(rand(600, 1200));
  await cb.locator('#number').fill(card.number);
  await sleep(rand(500, 1000));
  await cb.locator('#exp_month').fill(card.exp_month);
  await sleep(rand(300, 600));
  await cb.locator('#exp_year').fill(card.exp_year);
  await sleep(rand(400, 800));
  await cb.locator('#cvv').fill(card.cvv);
  await sleep(rand(1000, 2000));
  await waitClick(cb.locator('[data-cb-id="card_payment_submit"]'), TIMEOUT, page);

  try {
    await cb.locator('[data-cb-id="review_submit"]').waitFor({ state: 'visible', timeout: 20_000 });
  } catch {
    throw new ThreeDSError('3DS triggered after card — card retired');
  }

  const mkt = cb.locator('#cs_email_marketing');
  try {
    await mkt.waitFor({ state: 'visible', timeout: 5000 });
    if (!await mkt.isChecked()) await mkt.check();
  } catch {}

  const tos = cb.locator('#tos_agreed_1');
  await tos.waitFor({ state: 'visible', timeout: TIMEOUT });
  if (!await tos.isChecked()) await tos.check();

  await sleep(800);
  await waitClick(cb.locator('[data-cb-id="review_submit"]'), TIMEOUT, page);
  await handle3ds(page, card.kyash_email);
}

// ── Cancel subscription ───────────────────────────────────────────────────────

async function cancelSubscription(email, code) {
  const { ctx, tmpDir } = await makeBrowser('chrome_cancel_');
  const page = await ctx.newPage();
  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(rand(2000, 3000));

    const emailField = page.locator('input[type="email"], input[name="email"], #email').first();
    await emailField.waitFor({ state: 'visible', timeout: TIMEOUT });
    await emailField.fill(email);
    await sleep(500);
    await waitClick(
      page.locator('button[type="submit"], input[type="submit"]').first(),
      TIMEOUT, page,
    );
    await sleep(2000);

    const codeField = page.locator(
      'input[type="text"], input[name="code"], input[placeholder*="code" i]'
    ).first();
    await codeField.waitFor({ state: 'visible', timeout: TIMEOUT });
    await humanType(codeField, code);
    await sleep(500);
    await waitClick(
      page.locator('button[type="submit"], input[type="submit"]').first(),
      TIMEOUT, page,
    );
    await sleep(3000);

    await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(2000);

    const cancelBtn = page.locator(
      'a:has-text("Cancel"), button:has-text("Cancel subscription"), ' +
      'a:has-text("Manage subscription"), a:has-text("Cancel plan")'
    ).first();
    await waitClick(cancelBtn, TIMEOUT, page);
    await sleep(2000);

    try {
      const confirm = page.locator(
        'button:has-text("Confirm"), button:has-text("Yes, cancel"), ' +
        'button:has-text("Cancel subscription")'
      ).first();
      await confirm.waitFor({ state: 'visible', timeout: 10_000 });
      await waitClick(confirm, 10_000, page);
      await sleep(2000);
    } catch {}

    try {
      await page.waitForSelector(
        ':text("cancelled"), :text("Cancelled"), :text("subscription has been cancelled")',
        { timeout: 15_000 },
      );
    } catch {
      throw new Error('Cancellation confirmation not found on page');
    }
  } finally {
    try { await ctx.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

// Live preview: snapshot the page every ~1s so the dashboard can show what the browser sees.
function startLive(page) {
  const dir = path.join(__dirname, 'debug');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  let busy = false;
  const t = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      const tmp = path.join(dir, 'live.tmp.jpg');
      await page.screenshot({ path: tmp, type: 'jpeg', quality: 55, timeout: 4000 });
      fs.renameSync(tmp, path.join(dir, 'live.jpg'));
      fs.writeFileSync(path.join(dir, 'live.json'), JSON.stringify({ url: page.url(), ts: Date.now() }));
    } catch {}
    busy = false;
  }, 1000);
  return () => clearInterval(t);
}

// Hotmail accounts not yet succeeded/tried this run. If the pool is empty, wait (the
// dashboard auto-buys while a run is active) and re-read emails.csv until some arrive.
async function hotmailBatch(n, done, tried) {
  const deadline = Date.now() + 5 * 60_000;
  let announced = false;
  while (true) {
    const list = readHotmail().filter(e => !done.has(e) && !tried.has(e)).slice(0, n);
    if (list.length) return list;
    if (Date.now() > deadline) { console.log('Pool still empty after 5 min - stopping.'); return list; }
    if (!announced) { console.log('[Hotmail] pool empty - waiting for auto-buy to add accounts...'); announced = true; }
    await sleep(10_000);
  }
}

async function run() {
  console.log(`Proxy: ${PROXY_CFG.enabled ? 'ON' : 'OFF'} | NordVPN: ${NORDVPN_CTRY} every ${NORDVPN_EVERY}`);
  console.log(`Mail check: ${DO_MAIL_CHECK ? 'ON' : 'OFF'} | Auto-cancel: ${DO_CANCEL ? 'ON' : 'OFF'}`);
  console.log(`Addresses loaded: ${ADDRESSES.length} | Names: ${loadLines(FIRSTNAME_TXT).length} first / ${loadLines(LASTNAME_TXT).length} last\n`);

  const count = await askCount();
  const done  = alreadyProcessed(EMAIL_SOURCE === 'hotmail' ? [SUCCESS_CSV] : undefined);
  const cards = readCards();

  let pending = [];
  const tried = new Set();
  if (EMAIL_SOURCE === 'hotmail') {
    pending = await hotmailBatch(count, done, tried);
    console.log(`\n[Hotmail] ${pending.length} to process | Cards: ${cards.length}\n`);
    if (DO_MAIL_CHECK) console.log('[Hotmail] mail check is not supported in the JS checkout - skipping login-code fetch');
  } else {
    console.log(`\n[Mail] Generating ${count} emails...`);
    for (let i = 0; i < count; i++) {
      try {
        const email = generateEmail();
        if (!done.has(email)) pending.push(email);
        await sleep(350);
      } catch (e) {
        console.log(`[Mail] Generate error: ${e.message}`);
        await sleep(2000);
      }
    }
    console.log(`Generated: ${pending.length} fresh emails | Cards: ${cards.length}\n`);
  }
  if (!pending.length) { console.log(EMAIL_SOURCE === 'hotmail' ? 'Nothing to process: every Hotmail account in 1/emails.csv already succeeded (or the pool is empty). Add more accounts (Emails page / Auto Buy).' : 'Nothing to process.'); return; }

  await nordvpnConnect();

  const exhausted = new Set();
  let processed = 0;

  while (true) {
  for (let idx = 0; idx < pending.length; idx++) {
    tried.add(pending[idx]);
    const num      = idx + 1;
    const email    = pending[idx];
    const identity = pickIdentity();

    if (num > 1 && (num - 1) % NORDVPN_EVERY === 0) {
      await nordvpnDisconnect();
      await nordvpnConnect();
    }

    let cardIdx = null;
    for (let offset = 0; offset < cards.length; offset++) {
      const candidate = (processed + idx + offset) % cards.length;
      if (!exhausted.has(candidate)) { cardIdx = candidate; break; }
    }
    if (cardIdx === null) { console.log('All cards exhausted — stopping.'); break; }

    const card = cards[cardIdx];
    console.log(
      `[${num}/${pending.length}] ${email}` +
      `  name: ${identity.first} ${identity.last}` +
      `  addr: ${identity.city} ${identity.zip}` +
      `  card: ...${card.number.slice(-4)}`
    );

    for (let attempt = 1; attempt <= 3; attempt++) {
      const { ctx, tmpDir } = await makeBrowser();
      const page = await ctx.newPage();
      const stopLive = startLive(page);
      try {
        await checkout(page, email, card, identity);
        appendResult(SUCCESS_CSV, email);
        await postSuccessLine(email);
        console.log('  ✓ checkout success');

        if (DO_MAIL_CHECK && EMAIL_SOURCE !== 'hotmail') {
          console.log('  📩 Fetching Devyce code...');
          const code = await fetchDevyceCode(email);
          if (code) {
            appendCode(email, code);
            console.log(`  📧 Code: ${code}`);
            if (DO_CANCEL) {
              console.log('  🔄 Cancelling subscription...');
              try {
                await cancelSubscription(email, code);
                appendResult(CANCELLED_CSV, email);
                console.log('  ✓ cancelled\n');
              } catch (e) {
                appendResult(CANCEL_FAILED_CSV, email, e.message.split('\n')[0]);
                console.log(`  ⚠ cancel failed — ${e.message}\n`);
              }
            } else {
              console.log('  ⏭ cancel skipped (do_cancel=false)\n');
            }
          } else {
            console.log('  ⚠ Code not received within timeout\n');
          }
        } else {
          console.log('  ⏭ mail check skipped (do_mail_check=false)\n');
        }

        break;

      } catch (err) {
        // debug: keep a screenshot of what the page looked like when it failed
        try {
          const dbg = path.join(__dirname, 'debug'); fs.mkdirSync(dbg, { recursive: true });
          const f = path.join(dbg, `fail-${Date.now()}.png`);
          await page.screenshot({ path: f, timeout: 8000 });
          console.log(`  [debug] url=${page.url()} screenshot=${f}`);
        } catch {}
        const reason    = err.message.split('\n')[0];
        const isNetwork = NETWORK_ERRORS.some(e => reason.includes(e));

        if (err instanceof ThreeDSError) {
          exhausted.add(cardIdx);
          appendResult(FAILED_CSV, email, reason);
          await postFailedLine(email);
          console.log(`  ⚠ 3DS — card ${cardIdx + 1} retired (${exhausted.size}/${cards.length})\n`);
          break;
        }

        if (isNetwork && attempt < 3) {
          const waitMs = (8 + attempt * 6) * 1000;
          console.log(`  ↻ network error (attempt ${attempt}/3) — waiting for VPN adapter...`);
          for (let i = 0; i < 30; i++) {
            await sleep(2000);
            if (nordvpnAdapterUp()) break;
          }
          await sleep(waitMs);
          console.log('  ↻ retrying...');
          continue;
        }

        appendResult(FAILED_CSV, email, reason);
        await postFailedLine(email);
        console.log(`  ✗ failed — ${reason}\n`);
        console.error(err.stack);
        break;

      } finally {
        stopLive();
        try { await ctx.close(); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }

    await sleep(rand(3000, 6000));
  }

  processed += pending.length;
  if (EMAIL_SOURCE !== 'hotmail' || processed >= count || exhausted.size >= cards.length) break;
  // pool ran dry mid-run: the dashboard auto-buys; wait for fresh accounts and carry on
  pending = await hotmailBatch(count - processed, alreadyProcessed([SUCCESS_CSV]), tried);
  if (!pending.length) break;
  }

  console.log('\nDone.');
  console.log(`  Success   → ${SUCCESS_CSV}`);
  console.log(`  Failed    → ${FAILED_CSV}`);
  console.log(`  Codes     → ${CODES_CSV}`);
  console.log(`  Cancelled → ${CANCELLED_CSV}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
