'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const SQLiteStoreFactory = require('connect-sqlite3');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-only-change-this-secret';
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

let db;

function normalizeEmail(value = '') {
  return String(value).trim().toLowerCase();
}

function randomCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function passwordMatches(password, salt, expectedHash) {
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function futureDate(days = 30) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    company: user.company,
    email: user.email,
    planName: user.plan_name,
    planExpiresAt: user.plan_expires_at,
    verified: Boolean(user.verified)
  };
}

async function initDb() {
  db = await open({
    filename: path.join(DATA_DIR, 'aquaflow.sqlite'),
    driver: sqlite3.Database
  });
  await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      company TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      password_salt TEXT,
      google_sub TEXT UNIQUE,
      verified INTEGER NOT NULL DEFAULT 0,
      plan_name TEXT NOT NULL DEFAULT 'Business',
      plan_expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      email TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_verification_email_purpose
      ON verification_codes(email, purpose, used_at, expires_at);
  `);
}


async function ensureDefaultAdmin() {
  // Conta local de demonstração solicitada para acesso rápido ao painel.
  // Usuário: admin | Senha: admin
  const login = 'admin';
  const { salt, hash } = hashPassword('admin');
  const existing = await db.get('SELECT * FROM users WHERE email = ?', login);

  if (existing) {
    await db.run(
      `UPDATE users
       SET name=?, company=?, password_hash=?, password_salt=?, verified=1,
           plan_name='Business', plan_expires_at=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      'Administrador',
      'AquaFlow',
      hash,
      salt,
      futureDate(365),
      existing.id
    );
    return;
  }

  await db.run(
    `INSERT INTO users(name,company,email,password_hash,password_salt,verified,plan_name,plan_expires_at)
     VALUES(?,?,?,?,?,1,'Business',?)`,
    'Administrador',
    'AquaFlow',
    login,
    hash,
    salt,
    futureDate(365)
  );
}

function createMailer() {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
    auth: { user, pass }
  });
}

async function sendVerificationEmail({ email, code, purpose }) {
  const mailer = createMailer();
  const isReset = purpose === 'reset';
  const subject = isReset ? 'Código para redefinir sua senha — AquaFlow' : 'Confirme seu e-mail — AquaFlow';
  const title = isReset ? 'Redefinição de senha' : 'Verificação de e-mail';
  const message = isReset
    ? 'Use este código para redefinir sua senha.'
    : 'Use este código para concluir a criação da sua conta.';

  if (!mailer) {
    console.log(`[AquaFlow DEV] ${title} para ${email}: ${code}`);
    return { delivered: false, developmentCode: IS_PROD ? undefined : code };
  }

  await mailer.sendMail({
    from: process.env.SMTP_FROM || 'AquaFlow <no-reply@aquaflow.local>',
    to: email,
    subject,
    text: `${title}\n\n${message}\n\nCódigo: ${code}\n\nO código expira em 10 minutos.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#163b68">
        <h2 style="margin-bottom:6px">Aqua<span style="color:#85b51f">Flow</span></h2>
        <h3>${title}</h3>
        <p>${message}</p>
        <div style="font-size:30px;font-weight:800;letter-spacing:8px;padding:16px 20px;border-radius:12px;background:#f3f8fc;text-align:center">${code}</div>
        <p style="color:#7690aa;font-size:13px">O código expira em 10 minutos.</p>
      </div>`
  });
  return { delivered: true };
}

async function createVerificationCode(user, purpose) {
  const code = randomCode();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await db.run(
    'UPDATE verification_codes SET used_at = CURRENT_TIMESTAMP WHERE email = ? AND purpose = ? AND used_at IS NULL',
    user.email,
    purpose
  );
  await db.run(
    'INSERT INTO verification_codes(user_id,email,purpose,code_hash,expires_at) VALUES(?,?,?,?,?)',
    user.id,
    user.email,
    purpose,
    hashCode(code),
    expiresAt
  );
  return { code, expiresAt };
}

async function consumeVerificationCode(email, purpose, code) {
  const row = await db.get(
    `SELECT * FROM verification_codes
     WHERE email = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
     ORDER BY id DESC LIMIT 1`,
    email,
    purpose,
    new Date().toISOString()
  );
  if (!row || row.code_hash !== hashCode(code)) return null;
  await db.run('UPDATE verification_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ?', row.id);
  return row;
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login.html');
  next();
}

async function currentUser(req) {
  if (!req.session.userId) return null;
  return db.get('SELECT * FROM users WHERE id = ?', req.session.userId);
}

async function main() {
  await initDb();
  await ensureDefaultAdmin();
  const app = express();

  app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  }));
  app.use(express.json({ limit: '50kb' }));
  app.use(express.urlencoded({ extended: false }));

  const SQLiteStore = SQLiteStoreFactory(session);
  app.use(session({
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: DATA_DIR }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PROD,
      maxAge: 1000 * 60 * 60 * 12
    }
  }));

  const authLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false
  });
  app.use('/api/auth', authLimiter);

  app.get('/api/config', (req, res) => {
    res.json({ googleClientId: GOOGLE_CLIENT_ID || null, development: !IS_PROD });
  });

  app.post('/api/auth/register', async (req, res) => {
    try {
      const name = String(req.body.name || '').trim();
      const company = String(req.body.company || '').trim();
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || '');

      if (name.length < 2 || company.length < 2) return res.status(400).json({ error: 'Preencha nome e empresa.' });
      if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
      if (password.length < 8) return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });

      const existing = await db.get('SELECT * FROM users WHERE email = ?', email);
      const { salt, hash } = hashPassword(password);
      let user;

      if (existing?.verified) return res.status(409).json({ error: 'Já existe uma conta com esse e-mail.' });
      if (existing) {
        await db.run(
          `UPDATE users SET name=?, company=?, password_hash=?, password_salt=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
          name, company, hash, salt, existing.id
        );
        user = await db.get('SELECT * FROM users WHERE id = ?', existing.id);
      } else {
        const result = await db.run(
          `INSERT INTO users(name,company,email,password_hash,password_salt,verified,plan_name,plan_expires_at)
           VALUES(?,?,?,?,?,0,'Business',?)`,
          name, company, email, hash, salt, futureDate(30)
        );
        user = await db.get('SELECT * FROM users WHERE id = ?', result.lastID);
      }

      const verification = await createVerificationCode(user, 'register');
      const delivery = await sendVerificationEmail({ email, code: verification.code, purpose: 'register' });
      res.status(201).json({ ok: true, email, expiresAt: verification.expiresAt, developmentCode: delivery.developmentCode });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Não foi possível criar a conta.' });
    }
  });

  app.post('/api/auth/verify', async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    const row = await consumeVerificationCode(email, 'register', code);
    if (!row) return res.status(400).json({ error: 'Código inválido ou expirado.' });
    await db.run('UPDATE users SET verified=1, updated_at=CURRENT_TIMESTAMP WHERE id=?', row.user_id);
    req.session.userId = row.user_id;
    const user = await db.get('SELECT * FROM users WHERE id=?', row.user_id);
    res.json({ ok: true, user: publicUser(user) });
  });

  app.post('/api/auth/resend-code', async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const purpose = req.body.purpose === 'reset' ? 'reset' : 'register';
    const user = await db.get('SELECT * FROM users WHERE email=?', email);
    if (!user) return res.status(404).json({ error: 'Conta não encontrada.' });
    const verification = await createVerificationCode(user, purpose);
    const delivery = await sendVerificationEmail({ email, code: verification.code, purpose });
    res.json({ ok: true, expiresAt: verification.expiresAt, developmentCode: delivery.developmentCode });
  });

  app.post('/api/auth/login', async (req, res) => {
    const identifier = normalizeEmail(req.body.email);
    const password = String(req.body.password || '');
    const user = await db.get('SELECT * FROM users WHERE email=?', identifier);
    if (!user || !user.password_hash || !user.password_salt || !passwordMatches(password, user.password_salt, user.password_hash)) {
      return res.status(401).json({ error: 'Usuário/e-mail ou senha incorretos.' });
    }
    if (!user.verified) return res.status(403).json({ error: 'E-mail ainda não verificado.', requiresVerification: true, email: identifier });
    req.session.userId = user.id;
    res.json({ ok: true, user: publicUser(user) });
  });

  app.post('/api/auth/forgot-password', async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const user = await db.get('SELECT * FROM users WHERE email=?', email);
    if (!user) return res.json({ ok: true });
    const verification = await createVerificationCode(user, 'reset');
    const delivery = await sendVerificationEmail({ email, code: verification.code, purpose: 'reset' });
    res.json({ ok: true, email, expiresAt: verification.expiresAt, developmentCode: delivery.developmentCode });
  });

  app.post('/api/auth/reset-password', async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const code = String(req.body.code || '').trim();
    const newPassword = String(req.body.newPassword || '');
    if (newPassword.length < 8) return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 8 caracteres.' });
    const row = await consumeVerificationCode(email, 'reset', code);
    if (!row) return res.status(400).json({ error: 'Código inválido ou expirado.' });
    const { salt, hash } = hashPassword(newPassword);
    await db.run('UPDATE users SET password_hash=?, password_salt=?, updated_at=CURRENT_TIMESTAMP WHERE id=?', hash, salt, row.user_id);
    res.json({ ok: true });
  });

  app.post('/api/auth/google', async (req, res) => {
    try {
      if (!googleClient || !GOOGLE_CLIENT_ID) return res.status(503).json({ error: 'Login com Google ainda não foi configurado.' });
      const credential = String(req.body.credential || '');
      const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
      const payload = ticket.getPayload();
      if (!payload?.email || !payload?.sub || !payload.email_verified) return res.status(401).json({ error: 'Conta Google não pôde ser validada.' });
      const email = normalizeEmail(payload.email);
      let user = await db.get('SELECT * FROM users WHERE email=?', email);
      if (!user) {
        const result = await db.run(
          `INSERT INTO users(name,company,email,google_sub,verified,plan_name,plan_expires_at)
           VALUES(?,?,?, ?,1,'Business',?)`,
          payload.name || email.split('@')[0],
          'Minha empresa',
          email,
          payload.sub,
          futureDate(30)
        );
        user = await db.get('SELECT * FROM users WHERE id=?', result.lastID);
      } else {
        await db.run('UPDATE users SET google_sub=?, verified=1, updated_at=CURRENT_TIMESTAMP WHERE id=?', payload.sub, user.id);
        user = await db.get('SELECT * FROM users WHERE id=?', user.id);
      }
      req.session.userId = user.id;
      res.json({ ok: true, user: publicUser(user) });
    } catch (error) {
      console.error(error);
      res.status(401).json({ error: 'Não foi possível autenticar com o Google.' });
    }
  });

  app.get('/api/auth/session', async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ authenticated: false });
    res.json({ authenticated: true, user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
  });

  app.get('/', async (req, res) => {
    if (req.session.userId) return res.redirect('/index.html');
    res.redirect('/login.html');
  });

  app.get('/login.html', (req, res) => res.sendFile(path.join(ROOT, 'login.html')));
  app.get('/login.css', (req, res) => res.sendFile(path.join(ROOT, 'login.css')));
  app.get('/login.js', (req, res) => res.sendFile(path.join(ROOT, 'login.js')));

  for (const page of ['index.html', 'monitoramento.html', 'controle.html', 'historico.html', 'alertas.html']) {
    app.get(`/${page}`, requireAuth, (req, res) => res.sendFile(path.join(ROOT, page)));
  }

  app.use('/assets', express.static(path.join(ROOT, 'assets'), { maxAge: IS_PROD ? '7d' : 0 }));
  for (const file of ['styles.css', 'script.js', 'auth-client.js']) {
    app.get(`/${file}`, (req, res) => res.sendFile(path.join(ROOT, file)));
  }

  app.use((req, res) => res.status(404).send('Página não encontrada.'));

  app.listen(PORT, () => {
    console.log(`AquaFlow disponível em http://localhost:${PORT}`);
    if (!process.env.SMTP_HOST) console.log('SMTP não configurado: códigos de verificação serão exibidos no terminal em desenvolvimento.');
    if (!GOOGLE_CLIENT_ID) console.log('GOOGLE_CLIENT_ID não configurado: o botão Google aparecerá como indisponível.');
  });
}

main().catch(error => {
  console.error('Falha ao iniciar AquaFlow:', error);
  process.exit(1);
});
