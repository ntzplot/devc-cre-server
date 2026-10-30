// Check whether the Devyce login code can be read from a Hotmail inbox.
//   node js/check-code.js                       → every account in 1/emails.csv
//   node js/check-code.js email@hotmail.com     → one account from 1/emails.csv
//   node js/check-code.js "email|pass|token|client_id"   → creds given directly
const fs   = require('fs');
const path = require('path');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'config.json'), 'utf8'));
const API = (CFG.smail1s && CFG.smail1s.api_url) || 'https://smail1s.com/get_messages';
const MODE = (CFG.smail1s && CFG.smail1s.mode) || 'oauth';

function parseDevyceCode(html) {
  const text = String(html || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = text.match(/Your app code is\s+([A-Z0-9]{4,10})\b/) || text.match(/Login using your code:?\s+([A-Z0-9]{4,10})\b/);
  return m ? m[1] : null;
}

async function check(creds) {
  const email = creds.split('|')[0];
  try {
    const res = await fetch(API, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      body: JSON.stringify({ mode: MODE, data: creds }), signal: AbortSignal.timeout(30_000),
    });
    const j = await res.json();
    const msgs = (j.data || []).flatMap(a => a.messages || []);
    const hit = msgs.map(m => ({ subject: m.subject, code: parseDevyceCode(m.message) })).find(x => x.code);
    console.log(`${email}: ${msgs.length} message(s) → ${hit ? 'CODE ' + hit.code + '  (' + hit.subject + ')' : 'no Devyce code found'}`);
  } catch (e) { console.log(`${email}: error — ${e.message}`); }
}

(async () => {
  const arg = process.argv[2];
  const pool = fs.existsSync(path.join(__dirname, '..', '1', 'emails.csv'))
    ? fs.readFileSync(path.join(__dirname, '..', '1', 'emails.csv'), 'utf8').split(/\r?\n/).filter(l => l.includes('|') && !l.startsWith('#'))
    : [];
  const list = arg && arg.includes('|') ? [arg] : arg ? pool.filter(l => l.split('|')[0].toLowerCase() === arg.toLowerCase()) : pool;
  if (!list.length) return console.log('no accounts to check');
  for (const c of list) await check(c.trim());
})();
