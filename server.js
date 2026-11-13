require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const {
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  JWT_SECRET
} = process.env;

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Missing admin configuration or JWT_SECRET.');
  process.exit(1);
}

async function startServer() {
  const SQL = await initSqlJs();

  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });

  const dbFile = path.join(dir, 'app.db');

  const db = fs.existsSync(dbFile)
    ? new SQL.Database(fs.readFileSync(dbFile))
    : new SQL.Database();

  function saveDB() {
    fs.writeFileSync(dbFile, Buffer.from(db.export()));
  }

  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];

    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }

    stmt.free();
    return rows;
  }

  function run(sql, params = []) {
    db.run(sql, params);
    return db.getRowsModified();
  }

  db.run(`
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
    );
  `);

  run(
    `INSERT INTO admins (username, password_hash)
     VALUES (?, ?)
     ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`,
    [ADMIN_USERNAME, bcrypt.hashSync(ADMIN_PASSWORD, 12)]
  );

  saveDB();

  const app = express();

  if (PROD) app.set('trust proxy', 1);

  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));

  const limiter = (minutes, max, message) =>
    rateLimit({
      windowMs: minutes * 60 * 1000,
      max,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: message }
    });

  const applyLimit = limiter(60, 10, 'Too many submissions.');
  const loginLimit = limiter(15, 10, 'Too many login attempts.');

  const clean = (v, max) =>
    String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

  app.post('/api/apply', applyLimit, (req, res) => {
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
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email))
      errors.email = 'Enter a valid email.';
    if (!country) errors.country = 'Select your country.';
    if (!/^\+?[\d\s\-()]+$/.test(phone) || digits(phone).length < 7 || digits(phone).length > 15)
      errors.phone = 'Enter a valid phone number.';
    if (!/^[A-Za-z0-9_]{5,32}$/.test(telegram))
      errors.telegram = 'Enter a valid Telegram username.';
    if (!/^\+?[\d\s\-()]+$/.test(whatsapp) || digits(whatsapp).length < 7 || digits(whatsapp).length > 15)
      errors.whatsapp = 'Enter a valid WhatsApp number.';
    if (b.consent !== true)
      errors.consent = 'Accept the Privacy Policy.';

    if (Object.keys(errors).length)
      return res.status(400).json({ error: 'Please fix the errors.', errors });

    try {
      run(
        `INSERT INTO applications
         (name,email,country,phone,telegram,whatsapp)
         VALUES (?,?,?,?,?,?)`,
        [name, email, country, phone, telegram, whatsapp]
      );

      saveDB();
      res.status(201).json({ ok: true });

    } catch (e) {
      if (String(e.message).includes('UNIQUE'))
        return res.status(409).json({ error: 'Email already registered.' });

      console.error(e);
      res.status(500).json({ error: 'Server error.' });
    }
  });

  const cookieOpts = {
    httpOnly: true,
    sameSite: 'strict',
    secure: PROD,
    maxAge: 2 * 60 * 60 * 1000
  };

  const auth = (req, res, next) => {
    try {
      req.admin = jwt.verify(req.cookies.token, JWT_SECRET);
      next();
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
    }
  };

  app.post('/api/admin/login', loginLimit, (req, res) => {
    const u = clean(req.body?.username, 100);
    const p = String(req.body?.password ?? '').slice(0, 200);

    const row = all('SELECT * FROM admins WHERE username = ?', [u])[0];

    if (!row || !bcrypt.compareSync(p, row.password_hash))
      return res.status(401).json({ error: 'Invalid username or password.' });

    res.cookie(
      'token',
      jwt.sign({ id: row.id, u: row.username }, JWT_SECRET, { expiresIn: '2h' }),
      cookieOpts
    );

    res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    res.clearCookie('token', cookieOpts);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', auth, (req, res) => {
    res.json({ username: req.admin.u });
  });

  function getApplications(req) {
    const q = clean(req.query.q, 100);
    const country = clean(req.query.country, 80);

    let sql = 'SELECT * FROM applications WHERE 1=1';
    const params = [];

    if (q) {
      sql += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR telegram LIKE ? OR whatsapp LIKE ?)';
      params.push(...Array(5).fill(`%${q}%`));
    }

    if (country) {
      sql += ' AND country = ?';
      params.push(country);
    }

    sql += ' ORDER BY id DESC';

    return all(sql, params);
  }

  app.get('/api/admin/applications', auth, (req, res) => {
    res.json({
      rows: getApplications(req),
      total: all('SELECT COUNT(*) AS c FROM applications')[0].c,
      today: all("SELECT COUNT(*) AS c FROM applications WHERE date(created_at) = date('now')")[0].c,
      countries: all('SELECT DISTINCT country FROM applications ORDER BY country').map(r => r.country)
    });
  });

  app.delete('/api/admin/applications/:id', auth, (req, res) => {
    const changes = run(
      'DELETE FROM applications WHERE id = ?',
      [Number(req.params.id)]
    );

    if (changes) {
      saveDB();
      res.json({ ok: true });
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  });

  app.get('/api/admin/export', auth, (req, res) => {
    const esc = v => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""')}"`;
    };

    const head = ['ID', 'Name', 'Email', 'Country', 'Phone', 'Telegram', 'WhatsApp', 'Date'];

    const lines = getApplications(req).map(r =>
      [r.id, r.name, r.email, r.country, r.phone, r.telegram, r.whatsapp, r.created_at]
        .map(esc).join(',')
    );
