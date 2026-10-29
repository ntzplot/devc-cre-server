'use strict';

/**
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

const _cfgRaw = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8').replace(/^\uFEFF/, '');
const CFG = JSON.parse(_cfgRaw);

const CF_WORKER    = CFG.cf_worker_url;
const CF_EMAIL_CHK = CFG.cf_emailcheck_url;
const PROXY_CFG    = CFG.proxy;
const NORDVPN_CTRY = CFG.nordvpn.country;
const NORDVPN_EVERY= CFG.nordvpn.reconnect_every;
const GMAIL_API_URL = CFG.gmail?.api_url ?? 'https://gmail-token-api.apoh59620.workers.dev/api';
const GMAIL_BASE    = CFG.gmail?.base   ?? 'jokertgolerty';
const GMAIL_DOMAIN  = CFG.gmail?.domain ?? 'gmail.com';

const { first_name: FIRST_NAME, last_name: LAST_NAME,
        street: STREET, city: CITY, state: STATE, zip: ZIP } = CFG.billing;

const NORDVPN_EXE = 'C:\\Program Files\\NordVPN\\NordVPN.exe';

const SUCCESS_CSV      = path.join(__dirname, 'success.csv');
const SUCCESS_FULL_CSV = path.join(__dirname, 'successemailfull.csv');
const FAILED_CSV       = path.join(__dirname, 'failed.csv');
const CODES_CSV        = path.join(__dirname, 'codes.csv');
const CANCELLED_CSV    = path.join(__dirname, 'cancelled.csv');
const CANCEL_FAILED_CSV= path.join(__dirname, 'cancel_failed.csv');
const CARDS_TXT        = path.join(__dirname, '..', 'cards.txt');

const START_URL  = 'https://xpatfone.com/pricing';
const LOGIN_URL  = 'https://xpatfone.com/login';
const ACCOUNT_URL= 'https://xpatfone.com/account';
const IFRAME_ID  = '#cb-frame';
const TIMEOUT    = 45_000;

const NETWORK_ERRORS = [
  'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED',
  'ERR_NAME_NOT_RESOLVED', 'ERR_CONNECTION_RESET',
  'ERR_PROXY_CONNECTION_FAILED',
];

// ── Utilities ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rand  = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;

function askCount() {
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

// ── Email generation & inbox polling ─────────────────────────────────────────

const GMAIL_MODE      = CFG.gmail?.email_mode ?? 'both'; // "plus" | "dot" | "both"
const USED_DOTS_FILE  = path.join(__dirname, 'used_dots.txt');

function dotVariants(base) {
  const out = [];
  for (let i = 1; i < base.length; i++) out.push(`${base.slice(0, i)}.${base.slice(i)}`);
  return out;
}

function loadUsedDots() {
  if (!fs.existsSync(USED_DOTS_FILE)) return new Set();
  return new Set(fs.readFileSync(USED_DOTS_FILE, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(Boolean));
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
  // plus mode or fallback
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

function alreadyProcessed() {
  const done = new Set();
  for (const p of [SUCCESS_CSV, FAILED_CSV]) {
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
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      "Get-NetAdapter | Where-Object { $_.Name -like 'Nord*' -or " +
      "$_.InterfaceDescription -like 'Nord*' } | Select-Object -ExpandProperty Status",
    ], { encoding: 'utf8', timeout: 10_000 });
    return r.stdout.includes('Up');
  } catch { return false; }
}

async function nordvpnConnect(country = NORDVPN_CTRY) {
  console.log(`[NordVPN] Connecting to ${country}...`);
  try { spawnSync(NORDVPN_EXE, ['-c', '-g', country], { timeout: 30_000 }); }
  catch (e) { console.log(`[NordVPN] Connect error: ${e.message}`); return; }
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    if (nordvpnAdapterUp()) { console.log(`[NordVPN] Connected to ${country}`); return; }
  }
  console.log('[NordVPN] Warning: adapter not Up after 60s — continuing');
}

async function nordvpnDisconnect() {
  console.log('[NordVPN] Disconnecting...');
  try { spawnSync(NORDVPN_EXE, ['-d'], { timeout: 15_000 }); }
  catch (e) { console.log(`[NordVPN] Disconnect error: ${e.message}`); return; }
  for (let i = 0; i < 5; i++) {
    await sleep(2000);
    if (!nordvpnAdapterUp()) { console.log('[NordVPN] Disconnected'); return; }
  }
  console.log('[NordVPN] Warning: adapter still Up — continuing');
}

// ── OTP poller ────────────────────────────────────────────────────────────────

async function waitForOtp(startTime, email = 'default', timeoutMs = 90_000) {
  const sinceMs = startTime - 3000;
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
        const raw = data.otp || '';
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

async function makeBrowser(prefix = 'chrome_tmp_') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const opts = {
    headless: false,
    channel: 'chrome',
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized'],
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
  return { ctx, tmpDir };
}

async function humanType(locator, text) {
  await locator.click();
  await sleep(rand(150, 350));
  await locator.pressSequentially(text, { delay: rand(80, 160) });
}

async function waitClick(locator, timeout = TIMEOUT) {
  await locator.waitFor({ state: 'visible', timeout });
  await locator.scrollIntoViewIfNeeded();
  await sleep(rand(400, 900));
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

async function checkout(page, email, card) {
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await sleep(rand(2000, 3000));

  await waitClick(page.locator('[data-cb-type="checkout"][data-cb-plan-id="devyce-solo-xpat-int"]'));

  const iframeEl = await page.waitForSelector(IFRAME_ID, { timeout: TIMEOUT });
  await sleep(2000);
  const cb    = page.frameLocator(IFRAME_ID);
  const frame = await iframeEl.contentFrame();

  await waitClick(cb.locator('[data-cb-id="cart_submit"]'));
  await sleep(1200);

  const emailField = cb.locator('#email');
  await emailField.waitFor({ state: 'visible', timeout: TIMEOUT });
  await emailField.fill(email);
  await sleep(600);
  await waitClick(cb.locator('[data-cb-id="auth_submit"]'));
  await sleep(2000);

  await cb.locator('#first_name').waitFor({ state: 'visible', timeout: TIMEOUT });
  await humanType(cb.locator('#first_name'), FIRST_NAME);
  await sleep(300);
  await humanType(cb.locator('#last_name'), LAST_NAME);
  await sleep(300);
  await cb.locator('#line1').waitFor({ state: 'visible', timeout: TIMEOUT });
  await frame.evaluate(v => {
    const el = document.getElementById('line1');
    el.value = v;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, STREET);
  await sleep(300);
  await humanType(cb.locator('#city'),  CITY);
  await sleep(300);
  await humanType(cb.locator('#state'), STATE);
  await sleep(300);
  await humanType(cb.locator('#zip'),   ZIP);
  await sleep(600);
  await waitClick(cb.locator('[data-cb-id="address_submit"]'));
  await sleep(2500);

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
  await waitClick(cb.locator('[data-cb-id="card_payment_submit"]'));

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
  await waitClick(cb.locator('[data-cb-id="review_submit"]'));
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
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await sleep(2000);

    const codeField = page.locator('input[type="text"], input[name="code"], input[placeholder*="code" i]').first();
    await codeField.waitFor({ state: 'visible', timeout: TIMEOUT });
    await humanType(codeField, code);
    await sleep(500);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await sleep(3000);

    await page.goto(ACCOUNT_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await sleep(2000);

    const cancelBtn = page.locator(
      'a:has-text("Cancel"), button:has-text("Cancel subscription"), ' +
      'a:has-text("Manage subscription"), a:has-text("Cancel plan")'
    ).first();
    await cancelBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
    await cancelBtn.click();
    await sleep(2000);

    try {
      const confirm = page.locator(
        'button:has-text("Confirm"), button:has-text("Yes, cancel"), button:has-text("Cancel subscription")'
      ).first();
      await confirm.waitFor({ state: 'visible', timeout: 10_000 });
      await confirm.click();
      await sleep(2000);
    } catch {}

    try {
      await page.waitForSelector(
        ':text("cancelled"), :text("Cancelled"), :text("subscription has been cancelled")',
        { timeout: 15_000 }
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

async function run() {
  console.log(`Proxy: ${PROXY_CFG.enabled ? 'ON' : 'OFF'} | NordVPN: ${NORDVPN_CTRY} every ${NORDVPN_EVERY}\n`);

  const count = await askCount();
  const done  = alreadyProcessed();
  const cards = readCards();

  console.log(`\n[GPTMail] Generating ${count} emails...`);
  const pending = [];
  for (let i = 0; i < count; i++) {
    try {
      const email = await generateEmail();
      if (!done.has(email)) pending.push(email);
      await sleep(350);
    } catch (e) {
      console.log(`[GPTMail] Generate error: ${e.message}`);
      await sleep(2000);
    }
  }
  console.log(`Generated: ${pending.length} fresh emails | Cards: ${cards.length}\n`);
  if (!pending.length) { console.log('Nothing to process.'); return; }

  await nordvpnConnect();

  const exhausted = new Set();

  for (let idx = 0; idx < pending.length; idx++) {
    const num   = idx + 1;
    const email = pending[idx];

    if (num > 1 && (num - 1) % NORDVPN_EVERY === 0) {
      await nordvpnDisconnect();
      await nordvpnConnect();
    }

    let cardIdx = null;
    for (let offset = 0; offset < cards.length; offset++) {
      const candidate = (idx + offset) % cards.length;
      if (!exhausted.has(candidate)) { cardIdx = candidate; break; }
    }
    if (cardIdx === null) { console.log('All cards exhausted — stopping.'); break; }

    const card = cards[cardIdx];
    console.log(`[${num}/${pending.length}] ${email}  (card ${cardIdx + 1}/${cards.length}: ...${card.number.slice(-4)})`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const { ctx, tmpDir } = await makeBrowser();
      const page = await ctx.newPage();
      try {
        await checkout(page, email, card);
        appendResult(SUCCESS_CSV, email);
        await postSuccessLine(email);
        console.log('  ✓ success — fetching Devyce code...');

        const code = await fetchDevyceCode(email);
        if (code) {
          appendCode(email, code);
          console.log(`  📧 Code: ${code}`);
          console.log('  🔄 Cancelling subscription...');
          try {
            await cancelSubscription(email, code);
            appendResult(CANCELLED_CSV, email);
            console.log('  ✓ subscription cancelled\n');
          } catch (e) {
            appendResult(CANCEL_FAILED_CSV, email, e.message.split('\n')[0]);
            console.log(`  ⚠ cancel failed — ${e.message}\n`);
          }
        } else {
          console.log('  ⚠ Code not received within timeout\n');
        }
        break;

      } catch (err) {
        const reason = err.message.split('\n')[0];
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
          console.log('  ↻ retrying now...');
          continue;
        }

        appendResult(FAILED_CSV, email, reason);
        await postFailedLine(email);
        console.log(`  ✗ failed — ${reason}\n`);
        console.error(err.stack);
        break;

      } finally {
        try { await ctx.close(); } catch {}
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      }
    }

    await sleep(rand(3000, 6000));
  }

  console.log('\nDone.');
  console.log(`  Success    → ${SUCCESS_CSV}`);
  console.log(`  Failed     → ${FAILED_CSV}`);
  console.log(`  Codes      → ${CODES_CSV}`);
  console.log(`  Cancelled  → ${CANCELLED_CSV}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
