const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'life.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#7c9a72',
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  notes TEXT DEFAULT '',
  assignee TEXT DEFAULT 'all',
  alt_assignee TEXT DEFAULT NULL,
  due_date TEXT,
  recur TEXT DEFAULT '',
  rotate INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  done_by TEXT,
  done_at TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  owner TEXT DEFAULT 'all',
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT DEFAULT '🔗',
  descr TEXT DEFAULT '',
  sort INTEGER DEFAULT 0
);
`);
// v2 migrations: per-person ownership + open mode
const svcCols = db.prepare("PRAGMA table_info(services)").all().map(c => c.name);
if (!svcCols.includes('owner')) db.exec("ALTER TABLE services ADD COLUMN owner TEXT DEFAULT 'all'");
if (!svcCols.includes('open_mode')) db.exec("ALTER TABLE services ADD COLUMN open_mode TEXT DEFAULT 'frame'");

// v0.0.2 migration: users.is_admin
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('is_admin')) db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");

// v0.0.2 migration: tasks.alt_assignee + shift legacy "both" → "all"
const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
if (!taskCols.includes('alt_assignee')) db.exec("ALTER TABLE tasks ADD COLUMN alt_assignee TEXT DEFAULT NULL");
// Migrate legacy 'both' values on tasks/events/services → 'all' (generic)
db.exec("UPDATE tasks SET assignee = 'all' WHERE assignee = 'both'");
db.exec("UPDATE events SET owner = 'all' WHERE owner = 'both'");
db.exec("UPDATE services SET owner = 'all' WHERE owner = 'both'");
// Backfill alt_assignee for existing rotating tasks that were hardcoded to the brandon/emily pair
db.exec("UPDATE tasks SET alt_assignee = CASE assignee WHEN 'brandon' THEN 'emily' WHEN 'emily' THEN 'brandon' ELSE alt_assignee END WHERE rotate = 1 AND alt_assignee IS NULL");

// Seed: only the admin user, only if no users exist yet
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const ins = db.prepare('INSERT INTO users (username, display, pass_hash, color, is_admin) VALUES (?,?,?,?,?)');
  ins.run('admin', 'Admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'changeme', 10), '#7c9a72', 1);
  console.log('[seed] Created admin user. Log in, then create your household users via Settings.');
}
// Backfill admin flag for existing installations where admin was already a user with username='admin'
else {
  db.exec("UPDATE users SET is_admin = 1 WHERE username = 'admin' AND is_admin = 0");
}

// Seed services (replace these with your own URLs in the app)
if (db.prepare('SELECT COUNT(*) c FROM services').get().c === 0) {
  const ins = db.prepare('INSERT INTO services (name,url,icon,descr,sort) VALUES (?,?,?,?,?)');
  ins.run('Example', 'https://example.com', '🔗', 'Replace with your own services', 1);
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'life-app-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 90 }
}));

function auth(req, res, next) {
  if (req.session.user) return next();
  res.status(401).json({ error: 'unauthorized' });
}

function getMe(username) {
  return db.prepare('SELECT id, username, display, color, is_admin FROM users WHERE username = ?').get(username);
}

const USER_COLORS = ['#8a9ec4', '#c48a9e', '#9eb48a', '#d4a85c', '#a87cc4', '#7c9eb8', '#c47c7c', '#7cc4a8'];
function nextColor() {
  const idx = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  return USER_COLORS[idx % USER_COLORS.length];
}

function validateUsername(u) {
  const clean = (u || '').toLowerCase().trim();
  if (!/^[a-z0-9_-]{2,32}$/.test(clean)) return null;
  return clean;
}

// ---- auth ----
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const cleanUser = validateUsername(username);
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUser || '');
  if (!u || !bcrypt.compareSync(password || '', u.pass_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  req.session.user = { username: u.username, display: u.display, color: u.color, isAdmin: !!u.is_admin };
  res.json({ user: req.session.user });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));
app.post('/api/password', auth, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.session.user.username);
  if (!bcrypt.compareSync(current || '', u.pass_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!next || next.length < 4) return res.status(400).json({ error: 'New password too short' });
  db.prepare('UPDATE users SET pass_hash = ? WHERE username = ?').run(bcrypt.hashSync(next, 10), u.username);
  res.json({ ok: true });
});

// ---- users (admin manages the household) ----
app.get('/api/users', auth, (req, res) => {
  // Authenticated users can see the list (pickers need it). Pass hash never leaves the server.
  res.json(db.prepare('SELECT id, username, display, color, is_admin FROM users ORDER BY username').all());
});
app.post('/api/users', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const { username, display, password, color } = req.body || {};
  const cleanUser = validateUsername(username);
  if (!cleanUser) return res.status(400).json({ error: 'username must be 2-32 chars: a-z, 0-9, _ or -' });
  if (!display || !display.trim()) return res.status(400).json({ error: 'display name required' });
  if (!password || password.length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUser)) return res.status(409).json({ error: 'username already taken' });
  const finalColor = color || nextColor();
  db.prepare('INSERT INTO users (username, display, pass_hash, color, is_admin) VALUES (?,?,?,?,0)')
    .run(cleanUser, display.trim(), bcrypt.hashSync(password, 10), finalColor);
  res.json({ username: cleanUser, display: display.trim(), color: finalColor });
});
app.put('/api/users/:username', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  if (!me.is_admin) return res.status(403).json({ error: 'admin only' });
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: 'not found' });
  const { display, color } = req.body || {};
  db.prepare('UPDATE users SET display = COALESCE(?, display), color = COALESCE(?, color) WHERE username = ?')
    .run(display?.trim() || null, color || null, req.params.username);
  res.json({ ok: true });
});
app.post('/api/users/:username/password', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: 'not found' });
  // Self-service: user can change own password with current. Admin can reset without current.
  const { current, next } = req.body || {};
  if (!next || next.length < 4) return res.status(400).json({ error: 'New password too short' });
  if (me.username === target.username) {
    if (!bcrypt.compareSync(current || '', target.pass_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  } else if (!me.is_admin) {
    return res.status(403).json({ error: 'admin only' });
  }
  db.prepare('UPDATE users SET pass_hash = ? WHERE username = ?').run(bcrypt.hashSync(next, 10), target.username);
  res.json({ ok: true });
});
app.delete('/api/users/:username', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  if (!me.is_admin) return res.status(403).json({ error: 'admin only' });
  if (req.params.username === me.username) return res.status(400).json({ error: 'cannot delete yourself' });
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: 'not found' });
  // Reassign or null out references
  db.prepare("UPDATE tasks SET assignee = 'all' WHERE assignee = ?").run(req.params.username);
  db.prepare("UPDATE tasks SET alt_assignee = NULL WHERE alt_assignee = ?").run(req.params.username);
  db.prepare("UPDATE events SET owner = 'all' WHERE owner = ?").run(req.params.username);
  db.prepare("UPDATE services SET owner = 'all' WHERE owner = ?").run(req.params.username);
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  res.json({ ok: true });
});

// ---- tasks ----
function validateAssignee(value, allowAlt) {
  // 'all' is always valid; otherwise must be an existing username
  if (value === 'all' || value === null || value === undefined) return true;
  if (allowAlt && value === null) return true;
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(value);
  return !!u;
}
app.get('/api/tasks', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM tasks ORDER BY done, due_date IS NULL, due_date, id DESC').all());
});
app.post('/api/tasks', auth, (req, res) => {
  const { title, notes = '', assignee = 'all', alt_assignee = null, due_date = null, recur = '', rotate = 0 } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!validateAssignee(assignee)) return res.status(400).json({ error: 'unknown assignee' });
  if (rotate && alt_assignee && !validateAssignee(alt_assignee)) return res.status(400).json({ error: 'unknown alt_assignee' });
  const alt = rotate && alt_assignee ? alt_assignee : null;
  const r = db.prepare('INSERT INTO tasks (title,notes,assignee,alt_assignee,due_date,recur,rotate,created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(title, notes, assignee, alt, due_date, recur, rotate ? 1 : 0, req.session.user.username);
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.lastInsertRowid));
});
app.put('/api/tasks/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const b = { ...t, ...req.body };
  if (!validateAssignee(b.assignee)) return res.status(400).json({ error: 'unknown assignee' });
  if (b.rotate && b.alt_assignee && !validateAssignee(b.alt_assignee)) return res.status(400).json({ error: 'unknown alt_assignee' });
  const alt = b.rotate && b.alt_assignee ? b.alt_assignee : null;
  db.prepare('UPDATE tasks SET title=?,notes=?,assignee=?,alt_assignee=?,due_date=?,recur=?,rotate=? WHERE id=?')
    .run(b.title, b.notes, b.assignee, alt, b.due_date, b.recur, b.rotate ? 1 : 0, t.id);
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id));
});
function bumpDate(dateStr, recur) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  if (recur === 'daily') d.setDate(d.getDate() + 1);
  else if (recur === 'weekly') d.setDate(d.getDate() + 7);
  else if (recur === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}
app.post('/api/tasks/:id/toggle', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  if (!t.done && t.recur) {
    let assignee = t.assignee;
    let alt = t.alt_assignee;
    if (t.rotate && alt) {
      const tmp = assignee;
      assignee = alt;
      alt = tmp;
    }
    db.prepare('UPDATE tasks SET due_date=?, assignee=?, alt_assignee=?, done=0, done_by=?, done_at=datetime(\'now\') WHERE id=?')
      .run(bumpDate(t.due_date, t.recur), assignee, alt, req.session.user.username, t.id);
  } else {
    db.prepare('UPDATE tasks SET done=?, done_by=?, done_at=datetime(\'now\') WHERE id=?')
      .run(t.done ? 0 : 1, req.session.user.username, t.id);
  }
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id));
});
app.delete('/api/tasks/:id', auth, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- events ----
app.get('/api/events', auth, (req, res) => {
  const { from, to } = req.query;
  if (from && to) {
    return res.json(db.prepare('SELECT * FROM events WHERE date >= ? AND date <= ? ORDER BY date, time').all(from, to));
  }
  res.json(db.prepare('SELECT * FROM events ORDER BY date, time').all());
});
app.post('/api/events', auth, (req, res) => {
  const { title, date, time = '', notes = '', owner = 'all' } = req.body || {};
  if (!title || !date) return res.status(400).json({ error: 'title and date required' });
  if (!validateAssignee(owner)) return res.status(400).json({ error: 'unknown owner' });
  const r = db.prepare('INSERT INTO events (title,date,time,notes,owner,created_by) VALUES (?,?,?,?,?,?)')
    .run(title, date, time, notes, owner, req.session.user.username);
  res.json(db.prepare('SELECT * FROM events WHERE id = ?').get(r.lastInsertRowid));
});
app.put('/api/events/:id', auth, (req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not found' });
  const b = { ...e, ...req.body };
  if (!validateAssignee(b.owner)) return res.status(400).json({ error: 'unknown owner' });
  db.prepare('UPDATE events SET title=?,date=?,time=?,notes=?,owner=? WHERE id=?')
    .run(b.title, b.date, b.time, b.notes, b.owner, e.id);
  res.json(db.prepare('SELECT * FROM events WHERE id = ?').get(e.id));
});
app.delete('/api/events/:id', auth, (req, res) => {
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- services ----
app.get('/api/services', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM services ORDER BY sort, id').all());
});
app.post('/api/services', auth, (req, res) => {
  const { name, url, icon = '🔗', descr = '', owner = 'all', open_mode = 'frame' } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  if (!validateAssignee(owner)) return res.status(400).json({ error: 'unknown owner' });
  const max = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM services').get().m;
  const r = db.prepare('INSERT INTO services (name,url,icon,descr,sort,owner,open_mode) VALUES (?,?,?,?,?,?,?)')
    .run(name, url, icon, descr, max + 1, owner, open_mode);
  res.json(db.prepare('SELECT * FROM services WHERE id = ?').get(r.lastInsertRowid));
});
app.put('/api/services/:id', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const b = { ...s, ...req.body };
  if (!validateAssignee(b.owner)) return res.status(400).json({ error: 'unknown owner' });
  db.prepare('UPDATE services SET name=?,url=?,icon=?,descr=?,sort=?,owner=?,open_mode=? WHERE id=?')
    .run(b.name, b.url, b.icon, b.descr, b.sort, b.owner, b.open_mode, s.id);
  res.json(db.prepare('SELECT * FROM services WHERE id = ?').get(s.id));
});
app.delete('/api/services/:id', auth, (req, res) => {
  db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3080;
app.listen(PORT, () => console.log(`Homestead on :${PORT}`));
