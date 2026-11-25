const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');

const CAP = parseInt(process.env.CAP || '12', 10);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ITEMS = [
  { id: 'candle', name: '聖誕燭台', emoji: '🕯️' },
  { id: 'poinsettia', name: '聖誕紅組盆', emoji: '🌺' },
  { id: 'lipbalm', name: '手作護唇膏3支', emoji: '💄' },
];
const ITEM_IDS = new Set(ITEMS.map(i => i.id));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'off' ? false : (process.env.DATABASE_URL || '').includes('render.com') ? { rejectUnauthorized: false } : false,
  max: 5,
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS signups (
      id SERIAL PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES items(id),
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS signups_dedupe ON signups (item_id, lower(name), phone);
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

const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

app.get('/api/status', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ cap: CAP, items: await counts(), hasCover: fs.existsSync(path.join(__dirname, 'public', 'cover.jpg')) });
  } catch (e) { console.error(e); res.status(500).json({ error: '系統忙碌，請稍後再試' }); }
});

app.post('/api/signup', async (req, res) => {
  const itemId = String(req.body.item || '');
  const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
  const phone = String(req.body.phone || '').replace(/[^0-9+]/g, '');
  if (!ITEM_IDS.has(itemId)) return res.status(400).json({ error: '請選擇一個項目' });
  if (name.length < 2 || name.length > 30) return res.status(400).json({ error: '請填寫真實姓名（2–30 字）' });
  if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: '請填寫正確的手機號碼' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the item row so concurrent signups for the same item are serialized.
    await client.query('SELECT id FROM items WHERE id=$1 FOR UPDATE', [itemId]);
    const dup = await client.query('SELECT 1 FROM signups WHERE item_id=$1 AND lower(name)=lower($2) AND phone=$3', [itemId, name, phone]);
    if (dup.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: '你已經報名過這個項目了' }); }
    const c = await client.query('SELECT count(*)::int AS n FROM signups WHERE item_id=$1', [itemId]);
    if (c.rows[0].n >= CAP) { await client.query('ROLLBACK'); return res.status(409).json({ error: '這個項目已額滿，請選擇其他項目', full: true }); }
    await client.query('INSERT INTO signups (item_id, name, phone) VALUES ($1,$2,$3)', [itemId, name, phone]);
    await client.query('COMMIT');
    const it = ITEMS.find(i => i.id === itemId);
    res.json({ ok: true, item: it.name, name, number: c.rows[0].n + 1 });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') return res.status(409).json({ error: '你已經報名過這個項目了' });
    console.error(e); res.status(500).json({ error: '系統忙碌，請稍後再試' });
  } finally { client.release(); }
});

// ---- Admin ----
function checkKey(k) {
  if (!ADMIN_KEY || typeof k !== 'string') return false;
  const a = Buffer.from(k), b = Buffer.from(ADMIN_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const twTime = d => new Date(d).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

app.get('/admin', async (req, res) => {
  if (!checkKey(req.query.key)) return res.status(404).send('Not found');
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  const rows = (await pool.query('SELECT * FROM signups ORDER BY created_at, id')).rows;
  const k = encodeURIComponent(req.query.key);
  const sections = ITEMS.map(it => {
    const list = rows.filter(r => r.item_id === it.id);
    const trs = list.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${esc(r.phone)}</td><td>${esc(twTime(r.created_at))}</td>
      <td><form method="post" action="/admin/delete?key=${k}" onsubmit="return confirm('確定刪除 ${esc(r.name)}？')"><input type="hidden" name="id" value="${r.id}"><button>刪除</button></form></td></tr>`).join('');
    return `<h2>${it.emoji} ${esc(it.name)} <span class="${list.length >= CAP ? 'full' : ''}">${list.length} / ${CAP}</span></h2>
      <table><tr><th>#</th><th>姓名</th><th>電話</th><th>報名時間（台北）</th><th></th></tr>${trs || '<tr><td colspan="5" class="empty">尚無報名</td></tr>'}</table>`;
  }).join('');
  res.send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>報名後台</title>
  <style>body{font-family:system-ui,"Noto Sans TC",sans-serif;max-width:800px;margin:0 auto;padding:16px;background:#fbf7f0;color:#222}h1{color:#b3122e}h2{margin-top:28px;color:#14532d}h2 span{font-size:.8em;color:#555}h2 span.full{color:#b3122e}
  table{width:100%;border-collapse:collapse;background:#fff;font-size:15px}td,th{border:1px solid #ddd;padding:6px 8px;text-align:left}th{background:#f3e9d2}.empty{color:#999;text-align:center}
  button{background:#b3122e;color:#fff;border:0;border-radius:6px;padding:4px 10px}a.btn{display:inline-block;background:#14532d;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;margin-right:8px}</style></head>
  <body><h1>🎄 聖誕手作課程・報名後台</h1><p>總報名人數：${rows.length}</p>
  <p><a class="btn" href="/admin/export.csv?key=${k}">下載 CSV</a><a class="btn" href="/admin?key=${k}">重新整理</a></p>${sections}</body></html>`);
});

app.post('/admin/delete', async (req, res) => {
  if (!checkKey(req.query.key)) return res.status(404).send('Not found');
  const id = parseInt(req.body.id, 10);
  if (Number.isInteger(id)) await pool.query('DELETE FROM signups WHERE id=$1', [id]);
  if ((req.get('accept') || '').includes('application/json')) return res.json({ ok: true });
  res.redirect(303, '/admin?key=' + encodeURIComponent(req.query.key));
});

app.get('/admin/export.csv', async (req, res) => {
  if (!checkKey(req.query.key)) return res.status(404).send('Not found');
  const rows = (await pool.query('SELECT * FROM signups ORDER BY item_id, created_at, id')).rows;
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  const order = Object.fromEntries(ITEMS.map((it, i) => [it.id, i]));
  rows.sort((a, b) => order[a.item_id] - order[b.item_id] || a.created_at - b.created_at || a.id - b.id);
  const lines = [['項目', '序號', '姓名', '電話', '報名時間（台北）'].map(q).join(',')];
  const seq = {};
  for (const r of rows) {
    seq[r.item_id] = (seq[r.item_id] || 0) + 1;
    lines.push([ITEMS.find(i => i.id === r.item_id).name, seq[r.item_id], r.name, '="' + r.phone + '"', twTime(r.created_at)].map(q).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="xmas-signups.csv"');
  res.send('\uFEFF' + lines.join('\r\n'));
});

app.get('/healthz', (req, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

const PORT = process.env.PORT || 3000;
init().then(() => app.listen(PORT, () => console.log('listening on', PORT))).catch(e => { console.error('init failed', e); process.exit(1); });
