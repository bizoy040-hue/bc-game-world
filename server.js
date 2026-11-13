require('dotenv').config();
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const { Pool } = require('pg'), path = require('path');

const fail = m => { console.error('CONFIG ERROR: ' + m); process.exit(1); };

// Read an environment variable tolerantly: exact name first, then a name that differs only by
// stray spaces / case / punctuation (e.g. "JWT_SECRET " or "jwt-secret"). Values are trimmed and unquoted.
const norm = k => k.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
const getEnv = name => {
  let v = process.env[name];
  if (v === undefined) { const k = Object.keys(process.env).find(x => norm(x) === norm(name)); if (k) v = process.env[k]; }
  return v === undefined ? '' : String(v).trim().replace(/^(['"])(.*)\1$/, '$2').trim();
};

const ADMIN_USERNAME = getEnv('ADMIN_USERNAME'), ADMIN_PASSWORD = getEnv('ADMIN_PASSWORD'), JWT_SECRET = getEnv('JWT_SECRET');
const PORT = process.env.PORT || 3000, PROD = getEnv('NODE_ENV') === 'production';

if (!ADMIN_USERNAME || !ADMIN_PASSWORD) fail('ADMIN_USERNAME and ADMIN_PASSWORD must be set.');
if (JWT_SECRET.length < 32) {
  const seen = Object.keys(process.env).filter(k => /JWT|SECRET|TOKEN/i.test(k)).map(k => `${JSON.stringify(k)} (length ${String(process.env[k]).length})`);
  console.error('Detected related variables:', seen.length ? seen.join(', ') : 'none');
  fail(`JWT_SECRET must be set (32+ characters). Found length: ${JWT_SECRET.length}.`);
}

// ---------- Database (Neon PostgreSQL) ----------
function databaseUrl() {
  let u = getEnv('DATABASE_URL')
    .replace(/^DATABASE_URL\s*=\s*/i, '').replace(/^psql\s+/i, '').replace(/^['"]+|['"]+$/g, '').trim();
  if (!u) fail('DATABASE_URL is not set. Paste the full Neon connection string into the Render environment variable DATABASE_URL.');
  let p;
  try { p = new URL(u); } catch { fail('DATABASE_URL is not a valid URL. It must look like postgresql://USER:PASSWORD@HOST.neon.tech/DBNAME?sslmode=require'); }
  if (!/^postgres(ql)?:$/.test(p.protocol)) fail('DATABASE_URL must start with postgresql://');
  if (!p.hostname.includes('.')) fail(`DATABASE_URL host "${p.hostname}" is not a real hostname. Use the full Neon host (e.g. ep-xxxx-pooler.region.aws.neon.tech). If your password contains special characters (@ / ? # :), URL-encode them or reset the password.`);
  console.log('Database host:', p.hostname);
  p.searchParams.delete('sslmode'); p.searchParams.delete('channel_binding');
  return p.toString();
}
const pool = new Pool({
  connectionString: databaseUrl(),
  ssl: { rejectUnauthorized: true },
  max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000
});
pool.on('error', e => console.error('Idle DB client error:', e.message));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      country TEXT NOT NULL,
      phone TEXT NOT NULL,
      telegram TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  await pool.query(
    `INSERT INTO admins (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [ADMIN_USERNAME, await bcrypt.hash(ADMIN_PASSWORD, 12)]);
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const limiter = (windowMin, max, message) => rateLimit({
  windowMs: windowMin * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: message }
});
const applyLimit = limiter(60, 10, 'Too many submissions. Please try again later.');
const loginLimit = limiter(15, 10, 'Too many login attempts. Please try again in 15 minutes.');
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

app.get('/healthz', (req, res) => res.send('ok'));

app.post('/api/apply', applyLimit, ah(async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 100), email = clean(b.email, 150).toLowerCase(), country = clean(b.country, 80);
  const phone = clean(b.phone, 30), telegram = clean(b.telegram, 40).replace(/^@/, ''), whatsapp = clean(b.whatsapp, 30);
  const digits = s => s.replace(/\D/g, '');
  const errors = {};
  if (name.length < 2) errors.name = 'Enter your full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Enter a valid email address.';
  if (!country) errors.country = 'Select your country.';
  if (!/^\+?[\d\s\-()]+$/.test(phone) || digits(phone).length < 7 || digits(phone).length > 15) errors.phone = 'Enter a valid phone number.';
  if (!/^[A-Za-z0-9_]{5,32}$/.test(telegram)) errors.telegram = 'Telegram username must be 5–32 letters, numbers or underscores.';
  if (!/^\+?[\d\s\-()]+$/.test(whatsapp) || digits(whatsapp).length < 7 || digits(whatsapp).length > 15) errors.whatsapp = 'Enter a valid WhatsApp number.';
  if (b.consent !== true) errors.consent = 'You must accept the Privacy Policy.';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Please fix the highlighted fields.', errors });
  try {
    await pool.query('INSERT INTO applications (name,email,country,phone,telegram,whatsapp) VALUES ($1,$2,$3,$4,$5,$6)',
      [name, email, country, phone, telegram, whatsapp]);
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An application with this email already exists.' });
    throw e;
  }
}));

// ---------- Admin ----------
const cookieOpts = { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 2 * 60 * 60 * 1000 };
const auth = (req, res, next) => {
  try { req.admin = jwt.verify(req.cookies.token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
};

app.post('/api/admin/login', loginLimit, ah(async (req, res) => {
  const u = clean(req.body?.username, 100), p = String(req.body?.password ?? '').slice(0, 200);
  const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [u]);
  const row = rows[0];
  if (!row || !(await bcrypt.compare(p, row.password_hash))) return res.status(401).json({ error: 'Invalid username or password.' });
  res.cookie('token', jwt.sign({ id: row.id, u: row.username }, JWT_SECRET, { expiresIn: '2h' }), cookieOpts);
  res.json({ ok: true });
}));
app.post('/api/admin/logout', (req, res) => { res.clearCookie('token', cookieOpts); res.json({ ok: true }); });
app.get('/api/admin/me', auth, (req, res) => res.json({ username: req.admin.u }));

const listApps = async req => {
  const q = clean(req.query.q, 100), country = clean(req.query.country, 80);
  const w = [], a = [];
  if (q) {
    a.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    w.push(`(name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR telegram ILIKE $1 OR whatsapp ILIKE $1)`);
  }
  if (country) { a.push(country); w.push(`country = $${a.length}`); }
  const { rows } = await pool.query(`SELECT * FROM applications ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC`, a);
  return rows;
};

app.get('/api/admin/applications', auth, ah(async (req, res) => {
  const [rows, total, today, countries] = await Promise.all([
    listApps(req),
    pool.query('SELECT COUNT(*)::int AS c FROM applications'),
    pool.query(`SELECT COUNT(*)::int AS c FROM applications WHERE (created_at AT TIME ZONE 'UTC')::date = (NOW() AT TIME ZONE 'UTC')::date`),
    pool.query('SELECT DISTINCT country FROM applications ORDER BY country')
  ]);
  res.json({ rows, total: total.rows[0].c, today: today.rows[0].c, countries: countries.rows.map(r => r.country) });
}));
app.delete('/api/admin/applications/:id', auth, ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const r = await pool.query('DELETE FROM applications WHERE id = $1', [id]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
}));
app.get('/api/admin/export', auth, ah(async (req, res) => {
  const esc = v => { let s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const head = ['ID', 'Name', 'Email', 'Country', 'Phone', 'Telegram', 'WhatsApp', 'Date'];
  const lines = (await listApps(req)).map(r =>
    [r.id, r.name, r.email, r.country, r.phone, r.telegram, r.whatsapp, new Date(r.created_at).toISOString()].map(esc).join(','));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="applications.csv"' });
  res.send('\ufeff' + [head.map(esc).join(','), ...lines].join('\r\n'));
}));

app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

(async () => {
  for (let i = 1; ; i++) {
    try { await initDb(); break; }
    catch (e) {
      console.error(`Database init failed (attempt ${i}/4): ${e.code || ''} ${e.message}`);
      if (i === 4) process.exit(1);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  app.listen(PORT, '0.0.0.0', () => console.log(`BC GAME WORLD running on port ${PORT}`));
})();
