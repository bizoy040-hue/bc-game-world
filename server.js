require('dotenv').config();
const crypto = require('crypto');
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const { Pool } = require('pg'), path = require('path');
require('pg').types.setTypeParser(1082, v => v); // keep DATE columns as plain YYYY-MM-DD strings

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
    );
    CREATE TABLE IF NOT EXISTS applicant_users (
      id SERIAL PRIMARY KEY,
      user_id TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      last_login TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS onboarding_forms (
      id SERIAL PRIMARY KEY,
      user_ref INTEGER UNIQUE NOT NULL REFERENCES applicant_users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL, dob DATE NOT NULL, country TEXT NOT NULL, city TEXT NOT NULL, address TEXT NOT NULL,
      mobile TEXT NOT NULL, whatsapp TEXT NOT NULL, telegram TEXT NOT NULL, email TEXT NOT NULL,
      payment_method TEXT NOT NULL, reference_info TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ
    );
    ALTER TABLE onboarding_forms ADD COLUMN IF NOT EXISTS reference_name TEXT NOT NULL DEFAULT '';
    ALTER TABLE onboarding_forms ADD COLUMN IF NOT EXISTS payment_numbers JSONB NOT NULL DEFAULT '[]'::jsonb;`);
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
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
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
  try { req.admin = jwt.verify(req.cookies.token, JWT_SECRET); if (req.admin.role !== 'admin') throw new Error('role'); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }
  next();
};

app.post('/api/admin/login', loginLimit, ah(async (req, res) => {
  const u = clean(req.body?.username, 100), p = String(req.body?.password ?? '').slice(0, 200);
  const { rows } = await pool.query('SELECT * FROM admins WHERE username = $1', [u]);
  const row = rows[0];
  if (!row || !(await bcrypt.compare(p, row.password_hash))) return res.status(401).json({ error: 'Invalid username or password.' });
  res.cookie('token', jwt.sign({ id: row.id, u: row.username, role: 'admin' }, JWT_SECRET, { expiresIn: '2h' }), cookieOpts);
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

// ---------- Applicant onboarding ----------
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', IDCH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rnd = (n, a = ALPHA) => Array.from({ length: n }, () => a[crypto.randomInt(a.length)]).join('');
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const CRYPTO = ['USDT TRC20', 'USDT ERC20', 'USDT BEP20', 'Other Cryptocurrency'];
const PAYMENTS = {
  Bangladesh: ['bKash', 'Nagad', 'Rocket', 'Upay', 'Bank Transfer', ...CRYPTO],
  India: ['UPI', 'Paytm', 'Bank Transfer', ...CRYPTO],
  Pakistan: ['JazzCash', 'Easypaisa', 'Bank Transfer', ...CRYPTO],
  default: ['Bank Transfer', ...CRYPTO]
};
const WALLETS = ['bKash', 'Nagad', 'Rocket', 'Upay', 'UPI', 'Paytm', 'JazzCash', 'Easypaisa']; // methods that take contact numbers
const userLoginLimit = limiter(15, 10, 'Too many login attempts. Please try again in 15 minutes.');
const idParam = req => parseInt(req.params.id, 10);

const userAuth = ah(async (req, res, next) => {
  let t;
  try { t = jwt.verify(req.cookies.utoken, JWT_SECRET); } catch { return res.status(401).json({ error: 'Unauthorized' }); }
  if (t.role !== 'user') return res.status(401).json({ error: 'Unauthorized' });
  const { rows } = await pool.query('SELECT id, user_id, name FROM applicant_users WHERE id = $1 AND active', [t.id]);
  if (!rows[0]) return res.status(401).json({ error: 'Unauthorized' });
  req.user = rows[0];
  next();
});

// --- Applicant (user) side ---
app.post('/api/user/login', userLoginLimit, ah(async (req, res) => {
  const uid = clean(req.body?.userId, 30).toUpperCase(), pw = String(req.body?.password ?? '').slice(0, 100);
  const { rows } = await pool.query('SELECT * FROM applicant_users WHERE user_id = $1', [uid]);
  const u = rows[0];
  const ok = await bcrypt.compare(pw, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok || !u.active) return res.status(401).json({ error: 'Invalid User ID or password.' });
  await pool.query('UPDATE applicant_users SET last_login = NOW() WHERE id = $1', [u.id]);
  res.cookie('utoken', jwt.sign({ id: u.id, role: 'user' }, JWT_SECRET, { expiresIn: '2h' }), cookieOpts);
  res.json({ ok: true });
}));
app.post('/api/user/logout', (req, res) => { res.clearCookie('utoken', cookieOpts); res.json({ ok: true }); });

const FORM_SQL = `SELECT full_name AS "fullName", dob, country, city, address, mobile, whatsapp, telegram, email,
  payment_method AS payment, reference_info AS reference, reference_name AS "referenceName", payment_numbers AS "paymentNumbers", status FROM onboarding_forms WHERE user_ref = $1`;
app.get('/api/user/me', userAuth, ah(async (req, res) => {
  const f = await pool.query(FORM_SQL, [req.user.id]);
  res.json({ userId: req.user.user_id, name: req.user.name, form: f.rows[0] || null, payments: PAYMENTS, walletMethods: WALLETS });
}));

app.put('/api/user/form', userAuth, ah(async (req, res) => {
  const b = req.body || {}, digits = s => s.replace(/\D/g, '');
  const f = {
    fullName: clean(b.fullName, 100), dob: clean(b.dob, 10), country: clean(b.country, 80), city: clean(b.city, 80),
    address: clean(b.address, 250), mobile: clean(b.mobile, 30), whatsapp: clean(b.whatsapp, 30),
    telegram: clean(b.telegram, 40).replace(/^@/, ''), email: clean(b.email, 150).toLowerCase(), payment: clean(b.payment, 40),
    reference: String(b.reference ?? '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, 500)
  };
  f.referenceName = clean(b.referenceName, 100);
  const errors = {};
  if (f.fullName.length < 2) errors.fullName = 'Enter your full name.';
  const okDob = /^\d{4}-\d{2}-\d{2}$/.test(f.dob) && !isNaN(new Date(f.dob)) && new Date(f.dob).toISOString().slice(0, 10) === f.dob && f.dob >= '1900-01-01';
  const t = new Date(), min = new Date(Date.UTC(t.getUTCFullYear() - 18, t.getUTCMonth(), t.getUTCDate())).toISOString().slice(0, 10);
  if (!okDob) errors.dob = 'Enter a valid date of birth.'; else if (f.dob > min) errors.dob = 'You must be at least 18 years old.';
  if (!f.country) errors.country = 'Select your country.';
  if (f.city.length < 2) errors.city = 'Enter your city.';
  if (f.address.length < 5) errors.address = 'Enter your full address.';
  for (const k of ['mobile', 'whatsapp']) if (!/^\+?[\d\s\-()]+$/.test(f[k]) || digits(f[k]).length < 7 || digits(f[k]).length > 15) errors[k] = 'Enter a valid number with country code.';
  if (!/^[A-Za-z0-9_]{5,32}$/.test(f.telegram)) errors.telegram = 'Telegram username must be 5–32 letters, numbers or underscores.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email)) errors.email = 'Enter a valid email address.';
  if (!(Object.hasOwn(PAYMENTS, f.country) ? PAYMENTS[f.country] : PAYMENTS.default).includes(f.payment)) errors.payment = 'Select a payment method from the list.';
  let nums = [];
  if (WALLETS.includes(f.payment)) {
    const seen = new Set(), raw = Array.isArray(b.paymentNumbers) ? b.paymentNumbers.slice(0, 10) : [];
    nums = raw.map(n => clean(n, 30)).filter(n => n && !seen.has(digits(n)) && seen.add(digits(n)));
    if (!nums.length) errors.paymentNumbers = `Add at least one ${f.payment} number.`;
    else if (nums.length > 5) errors.paymentNumbers = 'You can add up to 5 numbers.';
    else if (nums.some(n => !/^\+?[\d\s\-()]+$/.test(n) || digits(n).length < 7 || digits(n).length > 15)) errors.paymentNumbers = 'Enter valid numbers with country code.';
  }
  if (b.consent !== true) errors.consent = 'You must confirm the information and accept the Privacy Policy.';
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Please fix the highlighted fields.', errors });
  const cur = await pool.query('SELECT status FROM onboarding_forms WHERE user_ref = $1', [req.user.id]);
  if (cur.rows[0]?.status === 'approved') return res.status(403).json({ error: 'Your application is approved and can no longer be edited.' });
  await pool.query(
    `INSERT INTO onboarding_forms (user_ref, full_name, dob, country, city, address, mobile, whatsapp, telegram, email, payment_method, reference_info, reference_name, payment_numbers)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
     ON CONFLICT (user_ref) DO UPDATE SET full_name=EXCLUDED.full_name, dob=EXCLUDED.dob, country=EXCLUDED.country, city=EXCLUDED.city,
       address=EXCLUDED.address, mobile=EXCLUDED.mobile, whatsapp=EXCLUDED.whatsapp, telegram=EXCLUDED.telegram, email=EXCLUDED.email,
       payment_method=EXCLUDED.payment_method, reference_info=EXCLUDED.reference_info, reference_name=EXCLUDED.reference_name, payment_numbers=EXCLUDED.payment_numbers, status='pending', reviewed_at=NULL, submitted_at=NOW()`,
    [req.user.id, f.fullName, f.dob, f.country, f.city, f.address, f.mobile, f.whatsapp, f.telegram, f.email, f.payment, f.reference, f.referenceName, JSON.stringify(nums.map(number => ({ method: f.payment, number })))]);
  res.json({ ok: true, status: 'pending' });
}));

// --- Admin side: credentials ---
app.post('/api/admin/users', auth, ah(async (req, res) => {
  const appId = parseInt(req.body?.application_id, 10) || null;
  let name = clean(req.body?.name, 100), telegram = null;
  if (appId) {
    const a = await pool.query('SELECT name, telegram FROM applications WHERE id = $1', [appId]);
    if (!a.rows[0]) return res.status(400).json({ error: 'Application not found.' });
    name = name || a.rows[0].name; telegram = a.rows[0].telegram;
  }
  if (!name) return res.status(400).json({ error: 'Enter a name or choose an application.' });
  const password = rnd(12), hash = await bcrypt.hash(password, 10);
  for (let i = 0; i < 5; i++) {
    const userId = 'BCW-' + rnd(6, IDCH);
    try {
      const r = await pool.query('INSERT INTO applicant_users (user_id, password_hash, name, application_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [userId, hash, name, appId]);
      return res.status(201).json({ id: r.rows[0].id, userId, password, name, telegram });
    } catch (e) { if (e.code !== '23505') throw e; }
  }
  throw new Error('Could not generate a unique User ID');
}));
app.get('/api/admin/users', auth, ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.user_id, u.name, u.active, u.last_login, u.created_at, a.email, a.telegram, f.status
     FROM applicant_users u LEFT JOIN applications a ON a.id = u.application_id
     LEFT JOIN onboarding_forms f ON f.user_ref = u.id ORDER BY u.id DESC`);
  res.json({ rows });
}));
app.post('/api/admin/users/:id/reset', auth, ah(async (req, res) => {
  const password = rnd(12);
  const r = await pool.query(
    `UPDATE applicant_users SET password_hash = $1 WHERE id = $2
     RETURNING user_id AS "userId", name, (SELECT telegram FROM applications WHERE id = application_id) AS telegram`,
    [await bcrypt.hash(password, 10), idParam(req)]);
  r.rows[0] ? res.json({ ...r.rows[0], password }) : res.status(404).json({ error: 'Not found' });
}));
app.patch('/api/admin/users/:id', auth, ah(async (req, res) => {
  if (typeof req.body?.active !== 'boolean') return res.status(400).json({ error: 'Invalid request' });
  const r = await pool.query('UPDATE applicant_users SET active = $1 WHERE id = $2', [req.body.active, idParam(req)]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
}));
app.delete('/api/admin/users/:id', auth, ah(async (req, res) => {
  const r = await pool.query('DELETE FROM applicant_users WHERE id = $1', [idParam(req)]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
}));

// --- Admin side: submitted forms ---
app.get('/api/admin/forms', auth, ah(async (req, res) => {
  const q = clean(req.query.q, 100), st = clean(req.query.status, 20), w = [], a = [];
  if (q) {
    a.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
    w.push(`(f.full_name ILIKE $1 OR f.email ILIKE $1 OR f.mobile ILIKE $1 OR f.whatsapp ILIKE $1 OR f.telegram ILIKE $1 OR f.country ILIKE $1 OR f.city ILIKE $1 OR u.user_id ILIKE $1)`);
  }
  if (['pending', 'approved', 'rejected'].includes(st)) { a.push(st); w.push(`f.status = $${a.length}`); }
  const { rows } = await pool.query(
    `SELECT f.*, u.user_id FROM onboarding_forms f JOIN applicant_users u ON u.id = f.user_ref
     ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY f.id DESC`, a);
  res.json({ rows });
}));
app.patch('/api/admin/forms/:id', auth, ah(async (req, res) => {
  const st = req.body?.status;
  if (!['approved', 'rejected', 'pending'].includes(st)) return res.status(400).json({ error: 'Invalid status' });
  const r = await pool.query('UPDATE onboarding_forms SET status = $1, reviewed_at = NOW() WHERE id = $2', [st, idParam(req)]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
}));

app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, 'public', 'portal.html')));

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
