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
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '📝',
  owner_user_id INTEGER,
  visibility TEXT NOT NULL DEFAULT 'household', -- 'private' | 'household'
  sort INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS list_items (
  id INTEGER PRIMARY KEY,
  list_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  added_by_user_id INTEGER,
  checked_by_user_id INTEGER,
  checked_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (list_id) REFERENCES lists(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id, position);
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

// Seed lists on first run — Groceries, Costco, Household. These are the
// three lists the household actually uses day-to-day (PHA-1621). Seeded
// only when the lists table is empty so we never clobber a household's
// own list setup on subsequent boots.
if (db.prepare('SELECT COUNT(*) c FROM lists').get().c === 0) {
  const ins = db.prepare('INSERT INTO lists (name, icon, visibility, sort) VALUES (?,?,?,?)');
  ins.run('Groceries', '🥕', 'household', 1);
  ins.run('Costco', '🛒', 'household', 2);
  ins.run('Household', '🏠', 'household', 3);
  console.log('[seed] Created Groceries, Costco, Household lists.');
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

// Process start time — used for the uptime field on /api/health. Reading
// process.uptime() would also work but is reset on every restart and is
// noisier than a single monotonic start timestamp. Kept in module scope
// so the value is stable for the lifetime of the process.
const PROCESS_STARTED_AT_MS = Date.now();
const PKG_VERSION = require('./package.json').version;
// COMMIT_SHA is injected at build time by the release workflow
// (`docker build --build-arg COMMIT_SHA=$(git rev-parse --short HEAD)`).
// Falls back to `null` in dev runs where no SHA has been baked in.
const COMMIT_SHA = process.env.COMMIT_SHA || null;

// ---- public probes (no auth) ----
//
// /api/health and /api/version are intentionally registered BEFORE every
// authenticated route and BEFORE the /api/* 404 catch-all below. They
// return JSON, are unauthenticated by design (container orchestrators,
// SWAG upstream health checks, and Uptime Kuma must not need a session),
// and exist so monitoring can distinguish a live Homestead from the SPA
// HTML shell that an SPA fallback would otherwise serve (PHA-1706).
app.get('/api/health', (req, res) => {
  let dbStatus = 'ok';
  try {
    db.prepare('SELECT 1 AS one').get();
  } catch (err) {
    dbStatus = 'error';
  }
  res.json({
    ok: dbStatus === 'ok',
    service: 'homestead',
    version: PKG_VERSION,
    commit: COMMIT_SHA,
    uptime: Math.round((Date.now() - PROCESS_STARTED_AT_MS) / 1000),
    db: dbStatus,
  });
});

app.get('/api/version', (req, res) => {
  res.json({ version: PKG_VERSION, commit: COMMIT_SHA });
});

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
// GET /api/logout is intentionally rejected with 405 Method Not Allowed.
// Logout mutates server state (destroys the session) so it must not be
// reachable via a safe method — RFC 9110 §9.2.1. Without this guard, the
// request would otherwise fall through to the /api/* catch-all and (in
// the v0.0.1 deployment that lacked PHA-1704's catch-all) serve the SPA
// HTML shell as a 200 OK. That "safe by accident" path becomes a CSRF
// vector the moment anyone adds a fallback handler that respects the
// GET verb. Explicit 405 keeps the contract honest regardless of how
// the surrounding routing layer evolves (PHA-1705).
app.get('/api/logout', (req, res) => res.status(405).json({ error: 'method_not_allowed', allow: 'POST' }));
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

// ---- lists ----
// Shared lists primitive (PHA-1621). Different from tasks: no assignee
// ceremony, no due dates, check-and-clear semantics, manual ordering,
// recurring restock. The "add milk to the grocery list" flow is the
// highest-frequency touch surface the app has — Signal / agent / curl
// all hit POST /api/lists/:id/items {text} as the dead-simple add path.
// Items are returned ordered: unchecked first (by position, oldest at
// top), then checked (most recently checked at bottom). The UI relies
// on this ordering so tap-to-check can immediately re-sort with the
// checked item sliding to the bottom of its bucket.
function getMyUserId() {
  return db.prepare('SELECT id FROM users WHERE username = ?').get(req_session_user_username()).id;
}
function req_session_user_username() {
  // Tiny helper to keep call-sites readable; the auth middleware guarantees
  // req.session.user is set for everything past the middleware.
  return req.session.user.username;
}
// The above indirection exists because the inline () => req.session.user.username
// pattern would close over the wrong `req` under async reorder. JavaScript.
function _myId() {
  return db.prepare('SELECT id FROM users WHERE username = ?').get(req.session.user.username).id;
}
function _listCanSee(list, meId, meIsAdmin) {
  if (!list) return false;
  if (list.visibility === 'household') return true;
  if (meIsAdmin) return true;
  return list.owner_user_id === meId;
}
function _listCanEdit(list, meId, meIsAdmin) {
  // Anyone with read access can add items / toggle checks — lists are
  // collaborative, not single-owner. Only admin or the original creator
  // can rename, change visibility, or delete the list itself.
  if (!list) return false;
  if (meIsAdmin) return true;
  return list.created_by_user_id === meId;
}

app.get('/api/lists', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const meId = me.id;
  const meIsAdmin = !!me.is_admin;
  // Return lists the user can see, with their items embedded. Visibility
  // is enforced here, not in a JOIN, so a private list with no items
  // doesn't leak via an empty row.
  const lists = db.prepare('SELECT * FROM lists ORDER BY sort, id').all()
    .filter(l => _listCanSee(l, meId, meIsAdmin));
  const itemsStmt = db.prepare('SELECT * FROM list_items WHERE list_id = ? ORDER BY checked, position, id');
  const out = lists.map(l => ({ ...l, items: itemsStmt.all(l.id) }));
  res.json(out);
});

app.get('/api/lists/:id', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!_listCanSee(list, me.id, !!me.is_admin)) return res.status(404).json({ error: 'not_found' });
  const items = db.prepare('SELECT * FROM list_items WHERE list_id = ? ORDER BY checked, position, id').all(list.id);
  res.json({ ...list, items });
});

app.post('/api/lists', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const { name, icon = '📝', visibility = 'household' } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  if (!['private', 'household'].includes(visibility)) return res.status(400).json({ error: 'invalid visibility' });
  const max = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM lists').get().m;
  const r = db.prepare('INSERT INTO lists (name, icon, owner_user_id, visibility, sort, created_by_user_id) VALUES (?,?,?,?,?,?)')
    .run(name.trim().slice(0, 80), icon, visibility === 'private' ? me.id : null, visibility, max + 1, me.id);
  res.json(db.prepare('SELECT * FROM lists WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/api/lists/:id', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'not found' });
  if (!_listCanEdit(list, me.id, !!me.is_admin)) return res.status(403).json({ error: 'forbidden' });
  const b = { ...list, ...req.body };
  if (b.name !== undefined) {
    if (!b.name || !b.name.trim()) return res.status(400).json({ error: 'name required' });
    b.name = b.name.trim().slice(0, 80);
  }
  if (b.visibility !== undefined && !['private', 'household'].includes(b.visibility)) {
    return res.status(400).json({ error: 'invalid visibility' });
  }
  if (b.visibility === 'private' && !list.owner_user_id) b.owner_user_id = me.id;
  db.prepare('UPDATE lists SET name=?, icon=?, visibility=?, owner_user_id=? WHERE id=?')
    .run(b.name, b.icon ?? list.icon, b.visibility ?? list.visibility, b.owner_user_id ?? list.owner_user_id, list.id);
  res.json(db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id));
});

app.delete('/api/lists/:id', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!list) return res.status(404).json({ error: 'not found' });
  if (!_listCanEdit(list, me.id, !!me.is_admin)) return res.status(403).json({ error: 'forbidden' });
  // ON DELETE CASCADE on list_items.list_id handles item cleanup.
  db.prepare('DELETE FROM lists WHERE id = ?').run(list.id);
  res.json({ ok: true });
});

// Items ------------------------------------------------------------------

function _bumpPosition(listId) {
  // New items get MAX(position)+1 in their list so insertion order is
  // preserved within the (unchecked, position) sort tuple. Checked items
  // don't get a new position — they keep their original position so the
  // 'checked bucket' stays in check-order at the bottom.
  const r = db.prepare('SELECT COALESCE(MAX(position),0) m FROM list_items WHERE list_id = ?').get(listId);
  return r.m + 1;
}

app.post('/api/lists/:id/items', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!_listCanSee(list, me.id, !!me.is_admin)) return res.status(404).json({ error: 'not_found' });
  const text = (req.body && req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'text required' });
  const r = db.prepare('INSERT INTO list_items (list_id, text, position, added_by_user_id) VALUES (?,?,?,?)')
    .run(list.id, text.slice(0, 500), _bumpPosition(list.id), me.id);
  res.json(db.prepare('SELECT * FROM list_items WHERE id = ?').get(r.lastInsertRowid));
});

app.put('/api/lists/:id/items/:itemId', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!_listCanSee(list, me.id, !!me.is_admin)) return res.status(404).json({ error: 'not_found' });
  const item = db.prepare('SELECT * FROM list_items WHERE id = ? AND list_id = ?').get(req.params.itemId, list.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const b = { ...item, ...req.body };
  if (b.text !== undefined) {
    if (!b.text || !b.text.trim()) return res.status(400).json({ error: 'text required' });
    b.text = b.text.trim().slice(0, 500);
  }
  db.prepare('UPDATE list_items SET text=? WHERE id=?').run(b.text, item.id);
  res.json(db.prepare('SELECT * FROM list_items WHERE id = ?').get(item.id));
});

app.delete('/api/lists/:id/items/:itemId', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!_listCanSee(list, me.id, !!me.is_admin)) return res.status(404).json({ error: 'not_found' });
  const item = db.prepare('SELECT * FROM list_items WHERE id = ? AND list_id = ?').get(req.params.itemId, list.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM list_items WHERE id = ?').run(item.id);
  res.json({ ok: true });
});

// Idempotent check / uncheck — Signal / curl can retry without toggling
// back. The check endpoint records checked_by + checked_at once and
// leaves them alone on subsequent calls (no overwrite). This matters
// because the activity feed (PHA-1622) will read checked_by as "who
// grabbed this off the list", and we don't want a duplicate webhook
// from a retried POST to record a fresh "check" event.
app.post('/api/lists/:id/items/:itemId/check', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!_listCanSee(list, me.id, !!me.is_admin)) return res.status(404).json({ error: 'not_found' });
  const item = db.prepare('SELECT * FROM list_items WHERE id = ? AND list_id = ?').get(req.params.itemId, list.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (!item.checked) {
    db.prepare('UPDATE list_items SET checked=1, checked_by_user_id=?, checked_at=datetime(\'now\') WHERE id=?')
      .run(me.id, item.id);
  }
  res.json(db.prepare('SELECT * FROM list_items WHERE id = ?').get(item.id));
});

app.post('/api/lists/:id/items/:itemId/uncheck', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!_listCanSee(list, me.id, !!me.is_admin)) return res.status(404).json({ error: 'not_found' });
  const item = db.prepare('SELECT * FROM list_items WHERE id = ? AND list_id = ?').get(req.params.itemId, list.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  if (item.checked) {
    // Restoring an item goes back into the unchecked bucket. Give it a
    // fresh position so it appears at the bottom of the unchecked
    // bucket (i.e., the most-recently-restored item is the last thing
    // you see at the bottom of the unchecked section before the
    // checked-items divider).
    db.prepare('UPDATE list_items SET checked=0, checked_by_user_id=NULL, checked_at=NULL, position=? WHERE id=?')
      .run(_bumpPosition(list.id), item.id);
  }
  res.json(db.prepare('SELECT * FROM list_items WHERE id = ?').get(item.id));
});

// Drag reorder. The client sends the full ordered id list for the list.
// Items not mentioned keep their current position; this is forgiving if
// the client races a delete (so we never resurrect a deleted item).
app.post('/api/lists/:id/items/reorder', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!_listCanSee(list, me.id, !!me.is_admin)) return res.status(404).json({ error: 'not_found' });
  const order = Array.isArray(req.body && req.body.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'order array required' });
  const upd = db.prepare('UPDATE list_items SET position=? WHERE id=? AND list_id=?');
  const tx = db.transaction((ids) => {
    ids.forEach((id, i) => upd.run(i + 1, id, list.id));
  });
  tx(order.filter(n => Number.isInteger(n)));
  res.json({ ok: true, count: order.length });
});

app.post('/api/lists/:id/clear-checked', auth, (req, res) => {
  const me = getMe(req.session.user.username);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!_listCanSee(list, me.id, !!me.is_admin)) return res.status(404).json({ error: 'not_found' });
  const r = db.prepare('DELETE FROM list_items WHERE list_id = ? AND checked = 1').run(list.id);
  res.json({ ok: true, removed: r.changes });
});

// 404 JSON for unknown /api/* paths.
// Without this, the SPA catch-all below returns the 39KB index.html shell
// for every unmatched /api/* request — breaking health checks, masking
// "feature missing" from JS clients, and wasting bandwidth (PHA-1704).
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use(express.static(path.join(__dirname, 'public')));
// /robots.txt must be served as a real robots.txt from public/, not fall
// through to the SPA shell. Without a physical file at public/robots.txt,
// express.static passes the request to the SPA catch-all below, which
// returns the 39KB index.html — Cloudflare then wraps that HTML in its
// content-signal boilerplate and serves it as a 39KB "text/plain"
// response. Real crawlers (Googlebot, Bingbot, AhrefsBot, ...) parse
// robots.txt for User-Agent / Disallow / Allow directives; they either
// ignore the CF boilerplate or treat the file as "no rules = allow
// everything". For a login-gated household dashboard there is no public
// content worth indexing, so the file declares a blanket disallow. If
// you ever want a different policy, just edit public/robots.txt — no
// code change required (PHA-1708).
// /favicon.ico serves the same SVG that /icon.svg serves. Browsers
// auto-request /favicon.ico for every tab; without this handler the SPA
// catch-all below serves the 39KB index.html as the favicon response —
// pure waste on every tab load (PHA-1707). The manifest already points
// at /icon.svg as the icon source of truth, so we reuse the same file
// with the correct image/svg+xml content-type. Modern browsers accept
// SVG favicons; legacy browsers fall through to the manifest. Same
// bytes, same ETag, no redirect overhead.
app.get('/favicon.ico', (req, res) => {
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'public', 'icon.svg'));
});
// SPA fallback: only non-/api paths reach here now. Anything under /api
// without a matching route handler returns 404 JSON above.
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3080;
app.listen(PORT, () => console.log(`Homestead on :${PORT}`));
