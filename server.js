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

const { ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET } = process.env;
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';

if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Missing config: set ADMIN_USERNAME, ADMIN_PASSWORD and JWT_SECRET (32+ characters).');
  process.exit(1);
}

async function startServer() {
  const SQL = await initSqlJs();

  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'app.db');

  const db = fs.existsSync(dbPath)
    ? new SQL.Database(fs.readFileSync(dbPath))
    : new SQL.Database();

  function saveDatabase() {
    const exported = db.export();
    fs.writeFileSync(dbPath, Buffer.from(exported));
  }

  function all(sql, params = []) {
    const statement = db.prepare(sql);
    try {
      statement.bind(params);
      const results = [];
      while (statement.step()) results.push(statement.getAsObject());
      return results;
    } finally {
      statement.free();
    }
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
  saveDatabase();

  const app = express();
  if (PROD) app.set('trust proxy', 1);

  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, 'public')));

  const makeLimiter = (minutes, max, message) => rateLimit({
    windowMs: minutes * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: message }
  });

  const applyLimit = makeLimiter(60, 10, 'Too many submissions. Please try again later.');
  const loginLimit = makeLimiter(15, 10, 'Too many login attempts. Please try again in 15 minutes.');

  const clean = (value, max) =>
    String(value ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

  app.post('/api/apply', applyLimit, (req, res) => {
    const body = req.body || {};
    const name = clean(body.name, 100);
    const email = clean(body.email, 150).toLowerCase();
    const country = clean(body.country, 80);
    const phone = clean(body.phone, 30);
    const telegram = clean(body.telegram, 40).replace(/^@/, '');
    const whatsapp = clean(body.whatsapp, 30);
    const digits = value => value.replace(/\D/g, '');
    const errors = {};

    if (name.length < 2) errors.name = 'Enter your full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Enter a valid email address.';
    if (!country) errors.country = 'Select your country.';
    if (!/^\+?[\d\s\-()]+$/.test(phone) || digits(phone).length < 7 || digits(phone).length > 15) {
      errors.phone = 'Enter a valid phone number.';
    }
    if (!/^[A-Za-z0-9_]{5,32}$/.test(telegram)) {
      errors.telegram = 'Telegram username must be 5–32 letters, numbers or underscores.';
    }
    if (!/^\+?[\d\s\-()]+$/.test(whatsapp) || digits(whatsapp).length < 7 || digits(whatsapp).length > 15) {
      errors.whatsapp = 'Enter a valid WhatsApp number.';
    }
    if (body.consent !== true) errors.consent = 'You must accept the Privacy Policy.';

    if (Object.keys(errors).length) {
      return res.status(400).json({ error: 'Please fix the highlighted fields.', errors });
    }

    try {
      run(
        `INSERT INTO applications (name, email, country, phone, telegram, whatsapp)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [name, email, country, phone, telegram, whatsapp]
      );
      saveDatabase();
      return res.status(201).json({ ok: true });
    } catch (error) {
      if (String(error.message).includes('UNIQUE constraint failed')) {
        return res.status(409).json({ error: 'An application with this email already exists.' });
      }
      console.error('Application save failed:', error);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }
  });

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'strict',
    secure: PROD,
    maxAge: 2 * 60 * 60 * 1000
  };

  const auth = (req, res, next) => {
    try {
      req.admin = jwt.verify(req.cookies.token, JWT_SECRET);
      return next();
    } catch {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };

  app.post('/api/admin/login', loginLimit, (req, res) => {
    const username = clean(req.body?.username, 100);
    const password = String(req.body?.password ?? '').slice(0, 200);
    const admin = all('SELECT * FROM admins WHERE username = ?', [username])[0];

    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = jwt.sign(
      { id: admin.id, u: admin.username },
      JWT_SECRET,
      { expiresIn: '2h' }
    );
    res.cookie('token', token, cookieOptions);
    return res.json({ ok: true });
  });

  app.post('/api/admin/logout', (req, res) => {
    res.clearCookie('token', cookieOptions);
    res.json({ ok: true });
  });

  app.get('/api/admin/me', auth, (req, res) => {
    res.json({ username: req.admin.u });
  });

  function getApplications(req) {
    const search = clean(req.query.q, 100);
    const country = clean(req.query.country, 80);
    let sql = 'SELECT * FROM applications WHERE 1=1';
    const params = [];

    if (search) {
      sql += ' AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR telegram LIKE ? OR whatsapp LIKE ?)';
      params.push(...Array(5).fill(`%${search}%`));
    }
    if (country) {
      sql += ' AND country = ?';
      params.push(country);
    }
    sql += ' ORDER BY id DESC';
    return all(sql, params);
  }

  app.get('/api/admin/applications', auth, (req, res) => {
    const total = all('SELECT COUNT(*) AS c FROM applications')[0].c;
    const today = all(
      "SELECT COUNT(*) AS c FROM applications WHERE date(created_at) = date('now')"
    )[0].c;
    const countries = all(
      'SELECT DISTINCT country FROM applications ORDER BY country'
    ).map(row => row.country);

    res.json({ rows: getApplications(req), total, today, countries });
  });

  app.delete('/api/admin/applications/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid ID' });

    const changes = run('DELETE FROM applications WHERE id = ?', [id]);
    if (!changes) return res.status(404).json({ error: 'Not found' });

    saveDatabase();
    return res.json({ ok: true });
  });

  app.get('/api/admin/export', auth, (req, res) => {
    const escapeCsv = value => {
      let text = String(value ?? '');
      if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
      return `"${text.replace(/"/g, '""')}"`;
    };

    const header = ['ID', 'Name', 'Email', 'Country', 'Phone', 'Telegram', 'WhatsApp', 'Date'];
    const lines = getApplications(req).map(row =>
      [row.id, row.name, row.email, row.country, row.phone, row.telegram, row.whatsapp, row.created_at]
        .map(escapeCsv).join(',')
    );

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="applications.csv"'
    });
    res.send('\ufeff' + [header.map(escapeCsv).join(','), ...lines].join('\r\n'));
  });

  app.get('/privacy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.listen(PORT, () => {
    console.log(`BC GAME WORLD running on port ${PORT}`);
  });
}

startServer().catch(error => {
  console.error('Server startup failed:', error);
  process.exit(1);
});
