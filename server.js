const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const CAP = parseInt(process.env.CAP || '12', 10);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ITEMS = [
  { id: 'candle', name: '聖誕燭台', emoji: '🕯️' },
  { id: 'poinsettia', name: '聖誕紅組盆', emoji: '🌺' },
  { id: 'lipbalm', name: '手作護唇膏3支', emoji: '💄' },
];
const ITEM = Object.fromEntries(ITEMS.map(i => [i.id, i]));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: (process.env.DATABASE_URL || '').includes('render.com') ? { rejectUnauthorized: false } : false,
  max: 5,
});

const cleanName = s => String(s || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const normName = s => cleanName(s).toLowerCase();
const newCode = () => String(crypto.randomInt(0, 10000)).padStart(4, '0');

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS signups (
      id SERIAL PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id),
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- v2 migration: drop phone, add normalized name + change code, one signup per person
    DROP INDEX IF EXISTS signups_dedupe;
    ALTER TABLE signups DROP COLUMN IF EXISTS phone;
    ALTER TABLE signups ADD COLUMN IF NOT EXISTS norm_name TEXT;
    ALTER TABLE signups ADD COLUMN IF NOT EXISTS code TEXT;
    ALTER TABLE signups ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
    UPDATE signups SET norm_name = lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) WHERE norm_name IS NULL;
    UPDATE signups SET code = lpad((floor(random()*10000))::int::text, 4, '0') WHERE code IS NULL;
    ALTER TABLE signups ALTER COLUMN norm_name SET NOT NULL;
    ALTER TABLE signups ALTER COLUMN code SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS signups_one_per_person ON signups (norm_name);
  `);
  for (const it of ITEMS) {
    await pool.query('INSERT INTO items (id, name) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name', [it.id, it.name]);
  }
}

async function counts() {
  const r = await pool.query('SELECT item_id, count(*)::int AS n FROM signups GROUP BY item_id');
  const m = Object.fromEntries(r.rows.map(x => [x.item_id, x.n]));
  return ITEMS.map(it => ({ ...it, taken: m[it.id] || 0, left: Math.max(0, CAP - (m[it.id] || 0)), full: (m[it.id] || 0) >= CAP }));
}

async function tx(fn) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}
class UserError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// Move a signup to another item, respecting the cap. Locks the target item row so
// concurrent signups/moves into the same item are serialized.
async function moveSignup(c, signupId, toItem) {
  if (!ITEM[toItem]) throw new UserError(400, '請選擇一個項目');
  const s = (await c.query('SELECT * FROM signups WHERE id=$1 FOR UPDATE', [signupId])).rows[0];
  if (!s) throw new UserError(404, '找不到這筆報名');
  if (s.item_id === toItem) return s;
  await c.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [toItem]);
  const n = (await c.query('SELECT count(*)::int AS n FROM signups WHERE item_id=$1', [toItem])).rows[0].n;
  if (n >= CAP) throw new UserError(409, `「${ITEM[toItem].name}」已額滿，你的報名維持「${ITEM[s.item_id].name}」`);
  return (await c.query('UPDATE signups SET item_id=$1, updated_at=now() WHERE id=$2 RETURNING *', [toItem, signupId])).rows[0];
}

// Simple in-memory limiter for wrong name+code attempts (per IP).
const fails = new Map();
function tooManyFails(ip) {
  const f = fails.get(ip); const now = Date.now();
  if (!f || now - f.t > 15 * 60e3) return false;
  return f.n >= 30;
}
function noteFail(ip) {
  const now = Date.now(); const f = fails.get(ip);
  if (!f || now - f.t > 15 * 60e3) fails.set(ip, { n: 1, t: now }); else f.n++;
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

const view = s => ({ name: s.name, code: s.code, itemId: s.item_id, item: ITEM[s.item_id].name });
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (e) {
    if (e instanceof UserError) return res.status(e.status).json({ error: e.message });
    console.error(e); res.status(500).json({ error: '系統忙碌，請稍後再試' });
  }
};

app.get('/api/status', wrap(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ cap: CAP, items: await counts() });
}));

app.post('/api/signup', wrap(async (req, res) => {
  const itemId = String(req.body.item || '');
  const name = cleanName(req.body.name);
  if (!ITEM[itemId]) throw new UserError(400, '請選擇一個項目');
  if (name.length < 2 || name.length > 30) throw new UserError(400, '請填寫真實姓名（2–30 字）');
  const s = await tx(async c => {
    await c.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [itemId]);
    const ex = (await c.query('SELECT item_id FROM signups WHERE norm_name=$1', [normName(name)])).rows[0];
    if (ex) throw new UserError(409, `你已經報名了「${ITEM[ex.item_id].name}」，要改課程請用下面的修改`);
    const n = (await c.query('SELECT count(*)::int AS n FROM signups WHERE item_id=$1', [itemId])).rows[0].n;
    if (n >= CAP) throw new UserError(409, '這個項目已額滿，請選擇其他項目');
    return (await c.query('INSERT INTO signups (item_id, name, norm_name, code) VALUES ($1,$2,$3,$4) RETURNING *',
      [itemId, name, normName(name), newCode()])).rows[0];
  }).catch(async e => {
    if (e.code === '23505') { // concurrent duplicate name
      const ex = (await pool.query('SELECT item_id FROM signups WHERE norm_name=$1', [normName(name)])).rows[0];
      throw new UserError(409, `你已經報名了「${ITEM[ex ? ex.item_id : itemId].name}」，要改課程請用下面的修改`);
    }
    throw e;
  });
  res.json({ ok: true, ...view(s) });
}));

// name + code authenticated self-service
async function findOwn(req, c = pool, lock = false) {
  const ip = req.ip;
  if (tooManyFails(ip)) throw new UserError(429, '嘗試太多次，請 15 分鐘後再試，或請主辦人協助');
  const nn = normName(req.body.name); const code = String(req.body.code || '').trim();
  const s = (await c.query(`SELECT * FROM signups WHERE norm_name=$1 AND code=$2${lock ? ' FOR UPDATE' : ''}`, [nn, code])).rows[0];
  if (!s) { noteFail(ip); throw new UserError(404, '找不到報名，請確認姓名和修改碼'); }
  return s;
}

app.post('/api/lookup', wrap(async (req, res) => {
  res.json({ ok: true, ...view(await findOwn(req)) });
}));

app.post('/api/change', wrap(async (req, res) => {
  const s = await tx(async c => moveSignup(c, (await findOwn(req, c, true)).id, String(req.body.item || '')));
  res.json({ ok: true, ...view(s) });
}));

app.post('/api/cancel', wrap(async (req, res) => {
  const s = await tx(async c => {
    const s = await findOwn(req, c, true);
    await c.query('DELETE FROM signups WHERE id=$1', [s.id]);
    return s;
  });
  res.json({ ok: true, ...view(s) });
}));

// ---- Admin ----
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const COOKIE = 'xs_admin';
const sign = exp => crypto.createHmac('sha256', ADMIN_PASSWORD).update('admin:' + exp).digest('base64url');
function readCookie(req) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  return m ? decodeURIComponent(m.slice(COOKIE.length + 1)) : '';
}
// Returns { q } (query suffix to keep on links) when authorized, else null.
function adminAuth(req) {
  if (ADMIN_PASSWORD) {
    const [exp, sig] = readCookie(req).split('.');
    if (exp && sig && Number(exp) > Date.now() && safeEq(sig, sign(exp))) return { q: '' };
    return null;
  }
  if (ADMIN_KEY && typeof req.query.key === 'string' && safeEq(req.query.key, ADMIN_KEY)) return { q: '?key=' + encodeURIComponent(req.query.key) };
  return null;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const twTime = d => new Date(d).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
const STYLE = `<style>body{font-family:system-ui,"PingFang TC","Noto Sans TC",sans-serif;max-width:860px;margin:0 auto;padding:16px;background:#fbf7f0;color:#222}h1{color:#b3122e;font-size:24px}h2{margin-top:28px;color:#14532d}h2 span{font-size:.8em;color:#555}h2 span.full{color:#b3122e}
table{width:100%;border-collapse:collapse;background:#fff;font-size:15px}td,th{border:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:middle}th{background:#f3e9d2}.empty{color:#999;text-align:center}
button{background:#b3122e;color:#fff;border:0;border-radius:6px;padding:5px 10px;font-size:14px}button.mv{background:#14532d}select{font-size:14px;padding:4px}form.in{display:inline}
a.btn{display:inline-block;background:#14532d;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;margin:0 8px 8px 0}.code{font-family:ui-monospace,monospace;font-size:16px;letter-spacing:2px}
.flash{padding:10px;border-radius:8px;background:#ffe5e5;color:#9d0f27}.ok{background:#e3f6e8;color:#14532d}.muted{color:#777;font-size:13px}
.login{max-width:340px;margin:60px auto;background:#fff;padding:24px;border-radius:14px;border:2px solid #d4a72c}.login input{width:100%;font-size:17px;padding:10px;margin:10px 0;box-sizing:border-box}.login button{width:100%;padding:12px;font-size:17px}</style>`;
const page = (title, body) => `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title}</title>${STYLE}</head><body>${body}</body></html>`;
function adminHeaders(res) { res.set('Cache-Control', 'no-store'); res.set('X-Robots-Tag', 'noindex, nofollow'); }

app.get('/admin', wrap(async (req, res) => {
  adminHeaders(res);
  const a = adminAuth(req);
  if (!a) {
    if (!ADMIN_PASSWORD) return res.status(404).send('Not found');
    const err = req.query.e ? '<p class="flash">密碼錯誤</p>' : '';
    return res.send(page('報名後台登入', `<form class="login" method="post" action="/admin/login"><h1>🎄 報名後台</h1>${err}<input type="password" name="password" placeholder="請輸入後台密碼" autofocus required><button>登入</button></form>`));
  }
  const rows = (await pool.query('SELECT * FROM signups ORDER BY created_at, id')).rows;
  const q = a.q; const amp = q ? q + '&' : '?';
  const flash = req.query.msg ? `<p class="flash ${req.query.ok ? 'ok' : ''}">${esc(req.query.msg)}</p>` : '';
  const sections = ITEMS.map(it => {
    const list = rows.filter(r => r.item_id === it.id);
    const opts = ITEMS.filter(o => o.id !== it.id).map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
    const trs = list.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td class="code">${esc(r.code)}</td><td>${esc(twTime(r.created_at))}</td>
      <td><form class="in" method="post" action="/admin/move${q}"><input type="hidden" name="id" value="${r.id}"><select name="item">${opts}</select> <button class="mv">移過去</button></form></td>
      <td><form class="in" method="post" action="/admin/delete${q}" onsubmit="return confirm('確定刪除 ${esc(r.name)} 的報名？')"><input type="hidden" name="id" value="${r.id}"><button>刪除</button></form></td></tr>`).join('');
    return `<h2>${it.emoji} ${esc(it.name)} <span class="${list.length >= CAP ? 'full' : ''}">${list.length} / ${CAP}</span></h2>
      <table><tr><th>#</th><th>姓名</th><th>修改碼</th><th>報名時間（台北）</th><th>改課程</th><th></th></tr>${trs || '<tr><td colspan="6" class="empty">尚無報名</td></tr>'}</table>`;
  }).join('');
  const logout = ADMIN_PASSWORD ? '<form class="in" method="post" action="/admin/logout"><button>登出</button></form>' : '';
  res.send(page('報名後台', `<h1>🎄 聖誕手作課程・報名後台</h1>${flash}<p>總報名人數：<b>${rows.length}</b> / ${CAP * ITEMS.length}　<span class="muted" id="ar">每 30 秒自動更新</span></p>
  <p><a class="btn" href="/admin/export.csv${q}">下載 CSV</a><a class="btn" href="/admin${q}">重新整理</a>${logout}</p>${sections}
  <script>let busy=false;document.addEventListener('focusin',e=>{if(e.target.tagName==='SELECT')busy=true});document.addEventListener('change',()=>busy=true);
  setInterval(()=>{if(!busy&&!document.hidden)location.href='/admin${q}'},30000);</script>`));
}));

app.post('/admin/login', (req, res) => {
  adminHeaders(res);
  if (!ADMIN_PASSWORD) return res.status(404).send('Not found');
  if (!safeEq(req.body.password || '', ADMIN_PASSWORD)) return setTimeout(() => res.redirect(303, '/admin?e=1'), 800);
  const exp = Date.now() + 14 * 24 * 3600e3;
  res.set('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=${14 * 24 * 3600}`);
  res.redirect(303, '/admin');
});
app.post('/admin/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.redirect(303, '/admin');
});

const back = (res, a, msg, ok) => res.redirect(303, '/admin' + (a.q ? a.q + '&' : '?') + 'msg=' + encodeURIComponent(msg) + (ok ? '&ok=1' : ''));

app.post('/admin/delete', wrap(async (req, res) => {
  const a = adminAuth(req); if (!a) return res.status(404).send('Not found');
  const r = await pool.query('DELETE FROM signups WHERE id=$1 RETURNING name', [parseInt(req.body.id, 10) || 0]);
  back(res, a, r.rowCount ? `已刪除 ${r.rows[0].name}` : '找不到這筆報名', !!r.rowCount);
}));

app.post('/admin/move', async (req, res) => {
  const a = adminAuth(req); if (!a) return res.status(404).send('Not found');
  try {
    const s = await tx(c => moveSignup(c, parseInt(req.body.id, 10) || 0, String(req.body.item || '')));
    back(res, a, `已把 ${s.name} 移到「${ITEM[s.item_id].name}」`, true);
  } catch (e) {
    if (e instanceof UserError) return back(res, a, e.message.replace('你的報名', '此人'));
    console.error(e); back(res, a, '系統忙碌，請稍後再試');
  }
});

app.get('/admin/export.csv', wrap(async (req, res) => {
  const a = adminAuth(req); if (!a) return res.status(404).send('Not found');
  adminHeaders(res);
  const rows = (await pool.query('SELECT * FROM signups ORDER BY created_at, id')).rows;
  const qq = v => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = [['項目', '序號', '姓名', '修改碼', '報名時間（台北）'].map(qq).join(',')];
  for (const it of ITEMS) rows.filter(r => r.item_id === it.id).forEach((r, i) =>
    lines.push([it.name, i + 1, r.name, '="' + r.code + '"', twTime(r.created_at)].map(qq).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="xmas-signups.csv"');
  res.send('\uFEFF' + lines.join('\r\n') + '\r\n');
}));

app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /admin\n'));
app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

const PORT = process.env.PORT || 3000;
init().then(() => app.listen(PORT, () => console.log('listening on', PORT))).catch(e => { console.error('init failed', e); process.exit(1); });
