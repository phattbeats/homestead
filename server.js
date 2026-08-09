// Homestead — shared life app (tasks, calendar, services, full-screen app shell).
//
// Identity model (PHA-1618, v0.0.5):
//   * `users` is a PROFILE CACHE, not a directory of record.
//   * Authentik is the directory of record (see PHA-1574 for header-trust
//     wiring + PHA-1577 for the household/family/media-club/admins groups).
//   * Homestead never creates or deletes user rows on its own. The
//     `X-authentik-username` header (carried by SWAG in front of
//     life.phatt.vip) is the canonical CREATE path: a request with that
//     header but no matching local row triggers `provisionOrClaim`, which
//     seeds a new profile row keyed on `username` (case-insensitive) and
//     attaches the provider identity.
//   * Seeded profiles (admin, brandon, emily — added on a fresh database)
//     are CLAIMED by the first authenticated request that matches the
//     case-insensitive username, NOT duplicated. All chore / activity /
//     list history stays on the seeded row.
//   * `groups` is a string cache of group names (household, family,
//     media-club, admins). Authentik is authoritative; Homestead
//     reconciles `user_groups` membership on every authenticated request
//     from the `X-authentik-groups` header. No group CRUD endpoints.
//   * Built-in `/api/login` (LAN fallback, PHA-1574) remains; it just
//     consults `users.pass_hash` instead of the v0.0.1 "brandon/emily"
//     hardcoded pair.

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const userModel = require('./lib/user-model');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'life.db'));
userModel.migrate(db);

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'life-app-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 90 }
}));

// ---- auth middleware ----
// Three-layer auth:
//   1. Header-trust (PHA-1574) — when SWAG forwards X-authentik-username
//      AND X-authentik-groups, provisionOrClaim establishes / refreshes
//      the session row and treats the request as authenticated.
//   2. Session-cookie — established by /api/login (LAN fallback) or by
//      the header-trust layer above; survives across requests.
//   3. Unauthenticated → 401.
function authenticate(req, res, next) {
  const headerUser = req.get('x-authentik-username');
  if (headerUser) {
    const groupsHeader = req.get('x-authentik-groups') || '';
    let groups = [];
    if (groupsHeader.startsWith('[')) {
      try { groups = JSON.parse(groupsHeader); } catch (_) { groups = []; }
    } else {
      groups = groupsHeader.split(',').map(s => s.trim()).filter(Boolean);
    }
    const u = userModel.provisionOrClaim(db, headerUser, 'header_trust', headerUser, groups);
    if (!u) return res.status(401).json({ error: 'invalid trusted username' });
    req.session.user = {
      username: u.username,
      display: u.display,
      color: u.color,
      isAdmin: !!u.is_admin,
      authProvider: 'header_trust',
    };
    return next();
  }
  if (req.session.user) return next();
  return res.status(401).json({ error: 'unauthorized' });
}
// Legacy alias used by route definitions below.
const auth = authenticate;

const PROCESS_STARTED_AT_MS = Date.now();
const PKG_VERSION = require('./package.json').version;
const COMMIT_SHA = process.env.COMMIT_SHA || null;

// ---- public probes (no auth) ----
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
// LAN fallback login (PHA-1574 keeps built-in login working behind
// SWAG for the local network). Header-trust users never hit this path.
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const cleanUser = userModel.validateUsername(username);
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUser || '');
  if (!u || !u.pass_hash || !bcrypt.compareSync(password || '', u.pass_hash)) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  userModel.touchLastSeen(db, u.id);
  req.session.user = {
    username: u.username,
    display: u.display,
    color: u.color,
    isAdmin: !!u.is_admin,
    authProvider: 'password',
  };
  res.json({ user: req.session.user });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/logout', (req, res) => res.status(405).json({ error: 'method_not_allowed', allow: 'POST' }));
app.get('/api/me', (req, res) => {
  // Header-trust probe (PHA-1574): when SWAG forwards X-authentik-username,
  // run provisionOrClaim inline so a header-trust user without a session
  // cookie yet still sees themselves. Unauthenticated requests return
  // { user: null } (200) instead of 401 so the SPA can use /api/me as a
  // "am I signed in?" check on every page load without a redirect.
  const headerUser = req.get('x-authentik-username');
  if (headerUser) {
    const groupsHeader = req.get('x-authentik-groups') || '';
    let groups = [];
    if (groupsHeader.startsWith('[')) {
      try { groups = JSON.parse(groupsHeader); } catch (_) { groups = []; }
    } else {
      groups = groupsHeader.split(',').map(s => s.trim()).filter(Boolean);
    }
    const u = userModel.provisionOrClaim(db, headerUser, 'header_trust', headerUser, groups);
    if (!u) return res.json({ user: null });
    req.session.user = {
      username: u.username,
      display: u.display,
      color: u.color,
      isAdmin: !!u.is_admin,
      authProvider: 'header_trust',
    };
    return res.json({ user: req.session.user });
  }
  res.json({ user: req.session.user || null });
});
app.post('/api/password', auth, (req, res) => {
  const { current, next } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.session.user.username);
  if (!bcrypt.compareSync(current || '', u.pass_hash)) return res.status(400).json({ error: 'Current password is wrong' });
  if (!next || next.length < 4) return res.status(400).json({ error: 'New password too short' });
  db.prepare('UPDATE users SET pass_hash = ? WHERE username = ?').run(bcrypt.hashSync(next, 10), u.username);
  res.json({ ok: true });
});

// ---- users ----
// GET is open to any authenticated user (assignment pickers need it).
// The pass_hash never leaves the server.
app.get('/api/users', auth, (req, res) => {
  res.json(db.prepare(`SELECT id, username, display, color, is_admin, avatar_url, preferences,
      auth_provider, provider_subject, claimed_at, last_seen_at, created_at
      FROM users ORDER BY username COLLATE NOCASE`).all());
});
app.get('/api/users/:username', auth, (req, res) => {
  const clean = userModel.validateUsername(req.params.username);
  const u = db.prepare(`SELECT id, username, display, color, is_admin, avatar_url, preferences,
      auth_provider, provider_subject, claimed_at, last_seen_at, created_at
      FROM users WHERE username = ?`).get(clean || '');
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json(u);
});
// Profile-only edit (PHA-1618: no Homestead user CRUD beyond profile
// fields). Display, color, avatar_url, preferences are user-owned; the
// caller must be the user themselves or an admin. Identity, groups, and
// username live in authentik.
app.put('/api/users/:username', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  const clean = userModel.validateUsername(req.params.username);
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(clean || '');
  if (!target) return res.status(404).json({ error: 'not found' });
  if (me.username !== target.username && !me.is_admin) {
    return res.status(403).json({ error: 'admin or self only' });
  }
  const { display, color, avatar_url, preferences } = req.body || {};
  db.prepare(`UPDATE users SET
      display = COALESCE(?, display),
      color = COALESCE(?, color),
      avatar_url = COALESCE(?, avatar_url),
      preferences = COALESCE(?, preferences),
      updated_at = datetime('now')
    WHERE id = ?`).run(
    display?.trim() || null,
    color || null,
    avatar_url || null,
    preferences ? JSON.stringify(preferences) : null,
    target.id
  );
  res.json({ ok: true });
});
app.post('/api/users/:username/password', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  const target = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
  if (!target) return res.status(404).json({ error: 'not found' });
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

// ---- groups ----
// Read-only view (PHA-1618: authentik owns the group lifecycle). The
// `?mine=1` query param returns just the authenticated user's groups so
// the frontend can ask "what groups am I in?" without scanning /api/users.
app.get('/api/groups', auth, (req, res) => {
  const rows = db.prepare(`SELECT g.id, g.name, g.display_name, g.source_provider, g.synced_at,
      (SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id) AS member_count
      FROM groups g ORDER BY g.name COLLATE NOCASE`).all();
  if (req.query.mine === '1') {
    const myGroups = db.prepare(`SELECT g.id, g.name, g.display_name FROM user_groups ug
      JOIN groups g ON g.id = ug.group_id
      JOIN users u ON u.id = ug.user_id
      WHERE u.username = ?
      ORDER BY g.name COLLATE NOCASE`).all(req.session.user.username);
    return res.json({ groups: rows, mine: myGroups });
  }
  res.json({ groups: rows });
});

// ---- tasks ----
app.get('/api/tasks', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM tasks ORDER BY done, due_date IS NULL, due_date, id DESC').all());
});
app.post('/api/tasks', auth, (req, res) => {
  const { title, notes = '', assignee = 'all', alt_assignee = null, due_date = null, recur = '', rotate = 0 } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!userModel.validateAssignee(db, assignee)) return res.status(400).json({ error: 'unknown assignee' });
  if (rotate && alt_assignee && !userModel.validateAssignee(db, alt_assignee)) return res.status(400).json({ error: 'unknown alt_assignee' });
  const alt = rotate && alt_assignee ? alt_assignee : null;
  const r = db.prepare('INSERT INTO tasks (title,notes,assignee,alt_assignee,due_date,recur,rotate,created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(title, notes, assignee, alt, due_date, recur, rotate ? 1 : 0, req.session.user.username);
  res.json(db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.lastInsertRowid));
});
app.put('/api/tasks/:id', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!t) return res.status(404).json({ error: 'not found' });
  const b = { ...t, ...req.body };
  if (!userModel.validateAssignee(db, b.assignee)) return res.status(400).json({ error: 'unknown assignee' });
  if (b.rotate && b.alt_assignee && !userModel.validateAssignee(db, b.alt_assignee)) return res.status(400).json({ error: 'unknown alt_assignee' });
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
  if (!userModel.validateAssignee(db, owner)) return res.status(400).json({ error: 'unknown owner' });
  const r = db.prepare('INSERT INTO events (title,date,time,notes,owner,created_by) VALUES (?,?,?,?,?,?)')
    .run(title, date, time, notes, owner, req.session.user.username);
  res.json(db.prepare('SELECT * FROM events WHERE id = ?').get(r.lastInsertRowid));
});
app.put('/api/events/:id', auth, (req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!e) return res.status(404).json({ error: 'not found' });
  const b = { ...e, ...req.body };
  if (!userModel.validateAssignee(db, b.owner)) return res.status(400).json({ error: 'unknown owner' });
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
  if (!userModel.validateAssignee(db, owner)) return res.status(400).json({ error: 'unknown owner' });
  const max = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM services').get().m;
  const r = db.prepare('INSERT INTO services (name,url,icon,descr,sort,owner,open_mode) VALUES (?,?,?,?,?,?,?)')
    .run(name, url, icon, descr, max + 1, owner, open_mode);
  res.json(db.prepare('SELECT * FROM services WHERE id = ?').get(r.lastInsertRowid));
});
app.put('/api/services/:id', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const b = { ...s, ...req.body };
  if (!userModel.validateAssignee(db, b.owner)) return res.status(400).json({ error: 'unknown owner' });
  db.prepare('UPDATE services SET name=?,url=?,icon=?,descr=?,sort=?,owner=?,open_mode=? WHERE id=?')
    .run(b.name, b.url, b.icon, b.descr, b.sort, b.owner, b.open_mode, s.id);
  res.json(db.prepare('SELECT * FROM services WHERE id = ?').get(s.id));
});
app.delete('/api/services/:id', auth, (req, res) => {
  db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// 404 JSON for unknown /api/* paths.
app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

app.use(express.static(path.join(__dirname, 'public')));
app.get('/favicon.ico', (req, res) => {
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(path.join(__dirname, 'public', 'icon.svg'));
});
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3080;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Homestead on :${PORT}`));
}
module.exports = app;