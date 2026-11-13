require('dotenv').config();
const express = require('express'), helmet = require('helmet'), rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');
const Database = require('better-sqlite3'), path = require('path'), fs = require('fs');

const { ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET } = process.env;
const PORT = process.env.PORT || 3000, PROD = process.env.NODE_ENV === 'production';
if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Missing config: set ADMIN_USERNAME, ADMIN_PASSWORD and JWT_SECRET (32+ chars) in .env');
  process.exit(1);
}

// ---------- Database ----------
const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, 'app.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  phone TEXT NOT NULL,
  telegram TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);
db.prepare(`INSERT INTO admins (username, password_hash) VALUES (?, ?)
  ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`)
  .run(ADMIN_USERNAME, bcrypt.hashSync(ADMIN_PASSWORD, 12));

// ---------- App ----------
const app = express();
if (PROD) app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const limiter = (windowMin, max, message) => rateLimit({
  windowMs: windowMin * 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: message }
});
const applyLimit = limiter(60, 10, 'Too many submissions. Please try again later.');
const loginLimit = limiter(15, 10, 'Too many login attempts. Please try again in 15 minutes.');

const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

app.post('/api/apply', applyLimit, (req, res) => {
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
    db.prepare('INSERT INTO applications (name,email,country,phone,telegram,whatsapp) VALUES (?,?,?,?,?,?)')
      .run(name, email, country, phone, telegram, whatsapp);
    res.status(201).json({ ok: true });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'An application with this email already exists.' });
    console.error(e); res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// ---------- Admin ----------
const cookieOpts = { httpOnly: true, sameSite: 'strict', secure: PROD, maxAge: 2 * 60 * 60 * 1000 };
const auth = (req, res, next) => {
  try { req.admin = jwt.verify(req.cookies.token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
};

app.post('/api/admin/login', loginLimit, (req, res) => {
  const u = clean(req.body?.username, 100), p = String(req.body?.password ?? '').slice(0, 200);
  const row = db.prepare('SELECT * FROM admins WHERE username = ?').get(u);
  if (!row || !bcrypt.compareSync(p, row.password_hash)) return res.status(401).json({ error: 'Invalid username or password.' });
  res.cookie('token', jwt.sign({ id: row.id, u: row.username }, JWT_SECRET, { expiresIn: '2h' }), cookieOpts);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie('token', cookieOpts); res.json({ ok: true }); });
app.get('/api/admin/me', auth, (req, res) => res.json({ username: req.admin.u }));

const query = req => {
  const q = clean(req.query.q, 100), country = clean(req.query.country, 80);
  const w = [], a = [];
  if (q) { w.push(`(name LIKE ? OR email LIKE ? OR phone LIKE ? OR telegram LIKE ? OR whatsapp LIKE ?)`); a.push(...Array(5).fill(`%${q}%`)); }
  if (country) { w.push('country = ?'); a.push(country); }
  return db.prepare(`SELECT * FROM applications ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC`).all(...a);
};

app.get('/api/admin/applications', auth, (req, res) => {
  res.json({
    rows: query(req),
    total: db.prepare('SELECT COUNT(*) c FROM applications').get().c,
    today: db.prepare("SELECT COUNT(*) c FROM applications WHERE date(created_at) = date('now')").get().c,
    countries: db.prepare('SELECT DISTINCT country FROM applications ORDER BY country').all().map(r => r.country)
  });
});
app.delete('/api/admin/applications/:id', auth, (req, res) => {
  const r = db.prepare('DELETE FROM applications WHERE id = ?').run(Number(req.params.id));
  r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
});
app.get('/api/admin/export', auth, (req, res) => {
  const esc = v => { let s = String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
  const head = ['ID', 'Name', 'Email', 'Country', 'Phone', 'Telegram', 'WhatsApp', 'Date'];
  const lines = query(req).map(r => [r.id, r.name, r.email, r.country, r.phone, r.telegram, r.whatsapp, r.created_at].map(esc).join(','));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="applications.csv"' });
  res.send('\ufeff' + [head.map(esc).join(','), ...lines].join('\r\n'));
});

app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.listen(PORT, () => console.log(`BC GAME WORLD running on port ${PORT}`));
