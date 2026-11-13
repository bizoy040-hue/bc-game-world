require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');

const { ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET, DATABASE_URL } = process.env;
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !JWT_SECRET || JWT_SECRET.length < 32 || !DATABASE_URL) {
  console.error('Missing config: set DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD and JWT_SECRET (32+ chars).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id BIGSERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS applications (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      country TEXT NOT NULL,
      phone TEXT NOT NULL,
      telegram TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  await pool.query(
    `INSERT INTO admins (username, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [ADMIN_USERNAME, hash]
  );
}

const app = express();
if (PROD) app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const limiter = (windowMin, max, message) => rateLimit({
  windowMs: windowMin * 60 * 1000,
  max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: message }
});
const applyLimit = limiter(60, 10, 'Too many submissions. Please try again later.');
const loginLimit = limiter(15, 10, 'Too many login attempts. Please try again in 15 minutes.');

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
const cookieOpts = {
  httpOnly: true,
  sameSite: 'strict',
  secure: PROD,
  maxAge: 2 * 60 * 60 * 1000,
  path: '/'
};

function auth(req, res, next) {
  try {
    req.admin = jwt.verify(req.cookies.token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

function buildFilters(req) {
  const q = clean(req.query.q, 100);
  const country = clean(req.query.country, 80);
  const where = [];
  const values = [];
  if (q) {
    values.push(`%${q}%`);
    const n = values.length;
    where.push(`(name ILIKE $${n} OR email ILIKE $${n} OR phone ILIKE $${n} OR telegram ILIKE $${n} OR whatsapp ILIKE $${n})`);
  }
  if (country) {
    values.push(country);
    where.push(`country = $${values.length}`);
  }
  return {
    clause: where.length ? `WHERE ${where.join(' AND ')}` : '',
    values
  };
}

app.post('/api/apply', applyLimit, async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 100);
  const email = clean(b.email, 150).toLowerCase();
  const country = clean(b.country, 80);
  const phone = clean(b.phone, 30);
  const telegram = clean(b.telegram, 40).replace(/^@/, '');
  const whatsapp = clean(b.whatsapp, 30);
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
    await pool.query(
      `INSERT INTO applications (name, email, country, phone, telegram, whatsapp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [name, email, country, phone, telegram, whatsapp]
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'An application with this email already exists.' });
    console.error(e);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

app.post('/api/admin/login', loginLimit, async (req, res) => {
  try {
    const username = clean(req.body?.username, 100);
    const password = String(req.body?.password ?? '').slice(0, 200);
    const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
    const row = result.rows[0];
    if (!row || !bcrypt.compareSync(password, row.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    const token = jwt.sign({ id: row.id, u: row.username }, JWT_SECRET, { expiresIn: '2h' });
    res.cookie('token', token, cookieOpts);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('token', { ...cookieOpts, maxAge: undefined });
  res.json({ ok: true });
});

app.get('/api/admin/me', auth, (req, res) => res.json({ username: req.admin.u }));

app.get('/api/admin/applications', auth, async (req, res) => {
  try {
    const { clause, values } = buildFilters(req);
    const [rows, total, today, countries] = await Promise.all([
      pool.query(`SELECT * FROM applications ${clause} ORDER BY id DESC`, values),
      pool.query('SELECT COUNT(*)::int AS c FROM applications'),
      pool.query('SELECT COUNT(*)::int AS c FROM applications WHERE created_at::date = CURRENT_DATE'),
      pool.query('SELECT DISTINCT country FROM applications ORDER BY country')
    ]);
    res.json({
      rows: rows.rows,
      total: total.rows[0].c,
      today: today.rows[0].c,
      countries: countries.rows.map(r => r.country)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load applications.' });
  }
});

app.delete('/api/admin/applications/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid application ID.' });
  try {
    const result = await pool.query('DELETE FROM applications WHERE id = $1', [id]);
    result.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not delete application.' });
  }
});

app.get('/api/admin/export', auth, async (req, res) => {
  try {
    const { clause, values } = buildFilters(req);
    const result = await pool.query(`SELECT * FROM applications ${clause} ORDER BY id DESC`, values);
    const esc = v => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const head = ['ID', 'Name', 'Email', 'Country', 'Phone', 'Telegram', 'WhatsApp', 'Date'];
    const lines = result.rows.map(r =>
      [r.id, r.name, r.email, r.country, r.phone, r.telegram, r.whatsapp, r.created_at].map(esc).join(',')
    );
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="applications.csv"'
    });
    res.send('\ufeff' + [head.map(esc).join(','), ...lines].join('\r\n'));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not export applications.' });
  }
});

app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

async function start() {
  try {
    await initDatabase();
    app.listen(PORT, () => console.log(`BC GAME WORLD running on port ${PORT}`));
  } catch (e) {
    console.error('Database connection or setup failed:', e);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  await pool.end();
  process.exit(0);
});

start();
