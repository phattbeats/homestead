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
const webpush = require('web-push');

const userModel = require('./lib/user-model');
const calendarSources = require('./lib/calendar-sources');
const secretBox = require('./lib/secret-box');
const plexSync = require('./lib/sync/plex');


const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'life.db'));
userModel.migrate(db);
calendarSources.migrate(db);
// v0.1.5: entity-graph schema (PHA-1624, Phase A; self-installed here so
// the Plex worker boots even if Phase A's standalone migration hasn't
// landed. Idempotent — no-op once Phase A ships its own migrate()).
plexSync.migrate(db);


// v0.1.0: web push subscriptions (PHA-1619)
db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_success_at TEXT,
  last_failure_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
-- v0.1.0: per-user notification preferences (PHA-1619)
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  quiet_start_hour INTEGER NOT NULL DEFAULT 21,
  quiet_end_hour INTEGER NOT NULL DEFAULT 8,
  chore_due INTEGER NOT NULL DEFAULT 1,
  take_turns INTEGER NOT NULL DEFAULT 1,
  system INTEGER NOT NULL DEFAULT 1
);
-- v0.1.0: notification delivery log (PHA-1619)
CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,
  tag TEXT,
  delivered INTEGER NOT NULL DEFAULT 0,
  skipped_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notification_log_user ON notification_log(user_id, created_at DESC);
`);

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

// ---- VAPID keypair (PHA-1619) ----
// Generated once on first startup, persisted to DATA_DIR/vapid.json.
// The public key is exposed via /api/push/vapid-public-key so the service
// worker can subscribe. The private key stays on the server and is loaded
// into web-push once at boot. If the file is missing or unreadable, a fresh
// keypair is generated. Rotating keys invalidates every existing push
// subscription (browsers will get 410 Gone on next push), so rotation
// requires either a forced re-subscribe from every client or a graceful
// migration window.
const VAPID_PATH = path.join(DATA_DIR, 'vapid.json');
function loadOrCreateVapid() {
  try {
    if (fs.existsSync(VAPID_PATH)) {
      const j = JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8'));
      if (j && j.publicKey && j.privateKey) return j;
    }
  } catch (err) {
    console.warn('[vapid] existing key unreadable, regenerating:', err.message);
  }
  const keys = webpush.generateVAPIDKeys();
  const payload = { ...keys, subject: 'mailto:admin@homestead.local', createdAt: new Date().toISOString() };
  fs.writeFileSync(VAPID_PATH, JSON.stringify(payload, null, 2), { mode: 0o600 });
  console.log('[vapid] generated new keypair at', VAPID_PATH);
  return payload;
}
const VAPID = loadOrCreateVapid();
webpush.setVapidDetails(VAPID.subject, VAPID.publicKey, VAPID.privateKey);

// ---- notification helpers (PHA-1619) ----
// notify(userId, {title, body, url, tag, category}) is the single delivery
// primitive. category drives per-user preferences (chore_due, take_turns,
// system) and quiet-hours enforcement. Returns { delivered, skipped, errors }.
function getPrefs(userId) {
  const row = db.prepare('SELECT * FROM notification_prefs WHERE user_id = ?').get(userId);
  if (row) return row;
  db.prepare('INSERT INTO notification_prefs (user_id) VALUES (?)').run(userId);
  return db.prepare('SELECT * FROM notification_prefs WHERE user_id = ?').get(userId);
}
function setPrefs(userId, patch) {
  const cur = getPrefs(userId);
  const next = {
    quiet_start_hour: Number.isInteger(patch.quiet_start_hour) ? patch.quiet_start_hour : cur.quiet_start_hour,
    quiet_end_hour: Number.isInteger(patch.quiet_end_hour) ? patch.quiet_end_hour : cur.quiet_end_hour,
    chore_due: patch.chore_due === undefined ? cur.chore_due : (patch.chore_due ? 1 : 0),
    take_turns: patch.take_turns === undefined ? cur.take_turns : (patch.take_turns ? 1 : 0),
    system: patch.system === undefined ? cur.system : (patch.system ? 1 : 0),
  };
  db.prepare(`UPDATE notification_prefs
              SET quiet_start_hour=?, quiet_end_hour=?, chore_due=?, take_turns=?, system=?
              WHERE user_id=?`)
    .run(next.quiet_start_hour, next.quiet_end_hour, next.chore_due, next.take_turns, next.system, userId);
  return next;
}
function isInQuietHours(prefs, now) {
  const h = now.getHours();
  const s = prefs.quiet_start_hour, e = prefs.quiet_end_hour;
  if (s === e) return false;
  if (s < e) return h >= s && h < e;
  return h >= s || h < e;
}
function logNotification(userId, category, payload, delivered, skippedReason) {
  db.prepare(`INSERT INTO notification_log (user_id,category,title,body,url,tag,delivered,skipped_reason)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(userId || null, category || 'system', payload.title || '', payload.body || '',
         payload.url || '', payload.tag || '', delivered ? 1 : 0, skippedReason || null);
}
async function notify(userId, payload, opts = {}) {
  const category = payload.category || opts.category || 'system';
  const prefs = getPrefs(userId);
  if (prefs[category] === 0) {
    logNotification(userId, category, payload, 0, 'category_disabled');
    return { delivered: 0, skipped: 1, errors: 0, reason: 'category_disabled' };
  }
  const now = new Date();
  const force = opts.force === true;
  if (!force && isInQuietHours(prefs, now)) {
    logNotification(userId, category, payload, 0, 'quiet_hours');
    return { delivered: 0, skipped: 1, errors: 0, reason: 'quiet_hours' };
  }
  const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
  if (!subs.length) {
    logNotification(userId, category, payload, 0, 'no_subscription');
    return { delivered: 0, skipped: 0, errors: 0, reason: 'no_subscription' };
  }
  const json = JSON.stringify({
    title: payload.title || '',
    body: payload.body || '',
    url: payload.url || '/',
    tag: payload.tag || category,
    icon: '/icon.svg',
    badge: '/icon.svg',
    category,
  });
  let delivered = 0, errors = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, json, { TTL: 60 * 60 * 24 });
      db.prepare('UPDATE push_subscriptions SET last_success_at=datetime(\'now\'), failure_count=0 WHERE id=?').run(s.id);
      delivered++;
    } catch (err) {
      errors++;
      const status = err.statusCode || 0;
      if (status === 404 || status === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id);
      } else {
        db.prepare('UPDATE push_subscriptions SET last_failure_at=datetime(\'now\'), failure_count=failure_count+1 WHERE id=?').run(s.id);
      }
    }
  }
  logNotification(userId, category, payload, delivered, delivered === 0 && errors > 0 ? 'all_endpoints_failed' : null);
  return { delivered, skipped: 0, errors };
}

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

// ---- calendar sources (PHA-1620) ----
// All routes never return cred_blob. The DTO is built by
// calendarSources.publicView(). Adding a source requires CALENDAR_CRED_KEY.
app.get('/api/calendar-sources', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  // Household-shared sources (user_id IS NULL) are visible to
  // everyone. Per-user sources are visible to the owner + admins.
  const rows = db.prepare('SELECT * FROM calendar_sources ORDER BY id').all();
  const visible = rows.filter(r => r.user_id == null || r.user_id === me.id || me.is_admin);
  res.json(visible.map(calendarSources.publicView));
});

function parseColor(c) {
  if (!c) return null;
  return /^#[0-9a-fA-F]{6}$/.test(String(c)) ? String(c) : null;
}

app.post('/api/calendar-sources', auth, (req, res) => {
  if (!secretBox.keyReady()) {
    return res.status(503).json({ error: 'CALENDAR_CRED_KEY not configured' });
  }
  const me = userModel.getMe(db, req.session.user.username);
  const body = req.body || {};
  const { provider, account_id, calendar_id, base_url, display_name, color, shared } = body;
  if (!provider || !account_id || !calendar_id) {
    return res.status(400).json({ error: 'provider, account_id, calendar_id required' });
  }
  if (!['caldav_nextcloud', 'caldav_icloud', 'ms365', 'google'].includes(provider)) {
    return res.status(400).json({ error: 'unsupported provider' });
  }
  // Per-provider credential validation. CalDAV wants an app-password;
  // Graph wants an OAuth2 access+refresh token pair; Google wants an
  // OAuth2 access+refresh token pair plus a client_id (needed for the
  // refresh-token grant). The encrypted payload is provider-specific —
  // we keep the JSON shape narrow so lib/caldav-source.js /
  // lib/google-source.js (and lib/graph-source.js from PR #7) can
  // require fields directly without defensive parsing.
  let credPayload;
  if (provider === 'caldav_nextcloud' || provider === 'caldav_icloud') {
    if (!body.app_password) return res.status(400).json({ error: 'app_password required for CalDAV providers' });
    credPayload = { app_password: body.app_password };
  } else if (provider === 'google') {
    // PHA-1865: Google Calendar adapter. client_id is mandatory (the
    // refresh-token grant needs it); client_secret is optional —
    // confidential web apps send it, public installed apps omit it.
    if (!body.access_token) return res.status(400).json({ error: 'access_token required for google' });
    if (!body.client_id) return res.status(400).json({ error: 'client_id required for google (set during source creation; needed for the refresh path)' });
    credPayload = {
      access_token: body.access_token,
      refresh_token: body.refresh_token || null,
      expires_at: body.expires_at || null,
      client_id: body.client_id,
      client_secret: body.client_secret || null,
      scope: body.scope || null,
    };
  } else {
    // ms365 (PHA-1864) lives in the parallel PR #7; the case is
    // included here so the PR's diff stays cohesive — both PRs
    // resolve cleanly against the shared base regardless of merge
    // order.
    if (!body.access_token) return res.status(400).json({ error: 'access_token required for ms365' });
    credPayload = {
      access_token: body.access_token,
      refresh_token: body.refresh_token || null,
      expires_at: body.expires_at || null,
      client_id: body.client_id || null,
      tenant_id: body.tenant_id || null,
      scope: body.scope || null,
    };
  }
  let userId = me.id;
  if (shared) {
    if (!me.is_admin) return res.status(403).json({ error: 'admin only for shared sources' });
    userId = null;
  }
  const credBlob = secretBox.encryptString(JSON.stringify(credPayload));
  const row = db.prepare(`INSERT INTO calendar_sources
    (user_id, provider, account_id, calendar_id, base_url, display_name, color, cred_blob, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    userId, provider, account_id, calendar_id, base_url || null,
    display_name || null, parseColor(color) || '#7c9eb8', credBlob, me.username
  );
  const created = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(row.lastInsertRowid);
  res.json(calendarSources.publicView(created));
});

app.delete('/api/calendar-sources/:id', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  const src = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'not found' });
  if (src.user_id != null && src.user_id !== me.id && !me.is_admin) {
    return res.status(403).json({ error: 'not yours' });
  }
  db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(src.id);
  res.json({ ok: true });
});

app.post('/api/calendar-sources/:id/refresh', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  const src = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'not found' });
  if (src.user_id != null && src.user_id !== me.id && !me.is_admin) {
    return res.status(403).json({ error: 'not yours' });
  }
  // Sync is async; the per-source errors are captured on the row.
  Promise.resolve()
    .then(() => calendarSources.syncSource(db, src))
    .catch((e) => {
      db.prepare(`UPDATE calendar_sources SET last_error = ?, last_error_at = datetime('now') WHERE id = ?`)
        .run(String(e && e.message || e).slice(0, 1024), src.id);
    });
  res.json({ ok: true, status: 'syncing' });
});

// ---- Entity-graph sync admin endpoints (PHA-1624 Phase B-1, PHA-1873) ----
//
// POST /api/admin/sync/plex           admin-only manual trigger
// GET  /api/admin/sync/plex/status    admin-only last-run summary
//
// The worker is also cron-driven every 6h from the boot scheduler.
// Manual triggers run async so the HTTP request returns immediately;
// poll /api/admin/sync/plex/status to see the result.

// Single-process serialization: a sync is in-flight if this flag is set.
// (We don't try to be cute with promise chains — Plex syncs are slow
// enough that a debounce is more useful than a queue.)
let plexSyncRunning = false;
let plexSyncLastResult = null;
let plexSyncLastRunAt = null;

async function runPlexSync() {
  if (plexSyncRunning) return { ok: false, reason: 'already_running' };
  if (!process.env.PLEX_TOKEN) {
    const r = { ok: false, reason: 'PLEX_TOKEN not set', errors: [] };
    plexSyncLastResult = r;
    plexSyncLastRunAt = new Date().toISOString();
    return r;
  }
  plexSyncRunning = true;
  try {
    const result = await plexSync.syncPlex({
      db,
      baseUrl: process.env.PLEX_URL || 'https://plex.phatt.vip',
      token: process.env.PLEX_TOKEN,
    });
    plexSyncLastResult = result;
    plexSyncLastRunAt = new Date().toISOString();
    return { ok: true, ...result };
  } catch (e) {
    const err = { ok: false, error: String(e && e.message || e) };
    plexSyncLastResult = err;
    plexSyncLastRunAt = new Date().toISOString();
    return err;
  } finally {
    plexSyncRunning = false;
  }
}

app.post('/api/admin/sync/plex', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me.is_admin) return res.status(403).json({ error: 'admin only' });
  if (plexSyncRunning) return res.status(409).json({ ok: false, reason: 'already_running' });
  // Fire-and-forget; caller polls /status.
  runPlexSync();
  res.json({ ok: true, status: 'syncing' });
});

app.get('/api/admin/sync/plex/status', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me.is_admin) return res.status(403).json({ error: 'admin only' });
  res.json({
    running: plexSyncRunning,
    lastRunAt: plexSyncLastRunAt,
    lastResult: plexSyncLastResult,
  });
});

// GET /api/events/merged?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns a unified list of native Homestead events + cached
// provider events, tagged with `origin: 'native' | 'provider:<id>'`
// so the month grid can paint per-provider pips.
app.get('/api/events/merged', auth, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
  const native = db.prepare(
    'SELECT id, title, date, time, notes, owner FROM events WHERE date >= ? AND date <= ? ORDER BY date, time'
  ).all(from, to).map(e => ({
    id: `native-${e.id}`,
    title: e.title,
    notes: e.notes,
    start: e.date + (e.time ? 'T' + e.time + ':00' : 'T00:00:00'),
    end: null,
    allDay: !e.time,
    owner: e.owner,
    origin: 'native',
    source_id: null,
    color: null,
    stale: false,
    last_error: null,
  }));
  const cached = db.prepare(`
    SELECT cec.id, cec.title, cec.description, cec.start_at, cec.end_at, cec.all_day, cec.location,
           cec.source_id, cs.provider, cs.account_id, cs.color, cs.display_name, cs.last_synced_at, cs.last_error
    FROM calendar_event_cache cec
    JOIN calendar_sources cs ON cs.id = cec.source_id
    WHERE cec.start_at >= ? AND cec.start_at <= ?
  `).all(from + 'T00:00:00Z', to + 'T23:59:59Z').map(e => ({
    id: `provider-${e.id}`,
    title: e.title,
    notes: e.description,
    start: e.start_at,
    end: e.end_at,
    allDay: !!e.all_day,
    location: e.location,
    owner: null,
    origin: `provider:${e.provider}`,
    source_id: e.source_id,
    color: e.color,
    stale: !e.last_synced_at || (Date.now() - new Date(e.last_synced_at + 'Z').getTime()) > calendarSources.FRESHNESS_MS,
    last_error: e.last_error,
  }));
  res.json({ events: [...native, ...cached] });
});


// ---- push notifications (PHA-1619) ----
// Public VAPID public key — fetched by the service worker at startup so
// it can build a PushSubscription. No auth required: the public key is
// not sensitive (it's the corresponding private key that authenticates
// the server against the push service).
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID.publicKey, subject: VAPID.subject });
});

// Subscribe the current user's device/browser. The body is the raw
// PushSubscription JSON from the browser's PushManager — endpoint +
// keys.p256dh + keys.auth. We dedupe by endpoint so a re-subscribe
// (e.g. after a key rotation) doesn't create a second row.
app.post('/api/push/subscribe', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'invalid_subscription' });
  }
  db.prepare(`INSERT INTO push_subscriptions (user_id,endpoint,p256dh,auth)
              VALUES (?,?,?,?)
              ON CONFLICT(endpoint) DO UPDATE SET
                user_id=excluded.user_id,
                p256dh=excluded.p256dh,
                auth=excluded.auth,
                failure_count=0`)
    .run(me.id, sub.endpoint, sub.keys.p256dh, sub.keys.auth);
  const row = db.prepare('SELECT id,endpoint,created_at,last_success_at FROM push_subscriptions WHERE endpoint=?').get(sub.endpoint);
  res.json({ ok: true, subscription: row });
});

// Unsubscribe by endpoint. Only the owning user (or an admin) can remove.
app.post('/api/push/unsubscribe', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const endpoint = (req.body || {}).endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  const target = db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint=?').get(endpoint);
  if (!target) return res.json({ ok: true, removed: 0 });
  if (target.user_id !== me.id && !me.is_admin) return res.status(403).json({ error: 'forbidden' });
  const r = db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
  res.json({ ok: true, removed: r.changes });
});

// Per-user notification prefs — GET returns, PUT replaces the boolean
// toggles + quiet hours window. Defaults are applied lazily by getPrefs()
// so a user who has never opened the page still gets sensible behaviour.
app.get('/api/push/prefs', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  res.json({ prefs: getPrefs(me.id) });
});
app.put('/api/push/prefs', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const b = req.body || {};
  if (b.quiet_start_hour != null && (b.quiet_start_hour < 0 || b.quiet_start_hour > 23))
    return res.status(400).json({ error: 'quiet_start_hour out of range' });
  if (b.quiet_end_hour != null && (b.quiet_end_hour < 0 || b.quiet_end_hour > 23))
    return res.status(400).json({ error: 'quiet_end_hour out of range' });
  res.json({ prefs: setPrefs(me.id, b) });
});

// Manual notify endpoint (auth required). Body:
//   { userId?: <users.id>, username?: <users.username>, payload: {title, body, url, tag, category}, force?: bool }
// userId wins over username; both default to the caller. force=true bypasses
// quiet hours (useful for take-turns handoff that lands at 3am). Agents /
// automation call this through the same primitive (PHA-1617 will too).
app.post('/api/notify', auth, async (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const body = req.body || {};
  const payload = body.payload || {};
  if (!payload.title) return res.status(400).json({ error: 'payload.title required' });
  let targetUserId = body.userId;
  if (targetUserId == null && body.username) {
    const u = db.prepare('SELECT id FROM users WHERE username = ?').get(body.username);
    if (!u) return res.status(404).json({ error: 'unknown_username' });
    targetUserId = u.id;
  }
  if (targetUserId == null) targetUserId = me.id;
  const target = db.prepare('SELECT id, username FROM users WHERE id=?').get(targetUserId);
  if (!target) return res.status(404).json({ error: 'unknown_user' });
  const result = await notify(target.id, payload, { force: !!body.force });
  res.json({ userId: target.id, username: target.username, ...result });
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
  // ---- daily digest scheduler (PHA-1619) ----
  // Runs once on boot and again every 30 minutes. The scheduler is
  // cheap: it only fires the actual digest at most once per day per
  // user, keyed by date + category in notification_log. Take-turns
  // handoff is checked on the same tick — when a rotating chore's due
  // date arrives, the current assignee gets a one-shot notification.
  const SCHED_TICK_MS = 30 * 60 * 1000;
  function todayKey() { return new Date().toISOString().slice(0, 10); }
  function alreadySentToday(userId, category) {
    const row = db.prepare(`SELECT 1 FROM notification_log
                            WHERE user_id=? AND category=? AND created_at LIKE ? AND delivered=1 LIMIT 1`)
      .get(userId, category, todayKey() + '%');
    return !!row;
  }
  async function runChoreDigest() {
    const today = todayKey();
    const chores = db.prepare(`SELECT * FROM tasks
                               WHERE done=0 AND assignee NOT IN ('all','rotate')
                                 AND due_date IS NOT NULL AND due_date <= ?
                               ORDER BY due_date, id`).all(today);
    for (const t of chores) {
      const u = db.prepare('SELECT id, username FROM users WHERE username = ?').get(t.assignee);
      if (!u) continue;
      if (alreadySentToday(u.id, 'chore_due')) continue;
      const overdue = t.due_date < today;
      const payload = {
        title: overdue ? `Overdue: ${t.title}` : `Due today: ${t.title}`,
        body: overdue ? `${t.title} was due ${t.due_date}. Tap to mark done.`
                      : `${t.title} is on your list today. Tap to mark done.`,
        url: '/',
        tag: `chore-due-${t.id}`,
        category: 'chore_due',
      };
      await notify(u.id, payload);
    }
  }
  async function runTakeTurnsDigest() {
    const today = todayKey();
    const chores = db.prepare(`SELECT * FROM tasks
                               WHERE done=0 AND rotate=1 AND assignee NOT IN ('all','rotate')
                                 AND due_date=?`).all(today);
    for (const t of chores) {
      const u = db.prepare('SELECT id, username FROM users WHERE username = ?').get(t.assignee);
      if (!u) continue;
      if (alreadySentToday(u.id, 'take_turns')) continue;
      await notify(u.id, {
        title: `Your turn: ${t.title}`,
        body: `${t.title} is up today. Tap to mark done and pass it on.`,
        url: '/',
        tag: `take-turns-${t.id}`,
        category: 'take_turns',
      });
    }
  }
  // Plex entity-graph sync (PHA-1873): every 6h. Skipped silently when
  // PLEX_TOKEN is unset (the household might not have Plex yet). The
  // tick is independent of the chore-digest tick; we use the same
  // setInterval handle but guard with an "if it's been 6h" check so we
  // don't run two unrelated intervals.
  const PLEX_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;     // 6h
  let plexSyncLastTickAt = 0;
  async function runPlexSyncTick() {
    if (!process.env.PLEX_TOKEN) return;       // optional dependency
    if (plexSyncRunning) return;                // manual trigger in flight
    const now = Date.now();
    if (plexSyncLastTickAt && (now - plexSyncLastTickAt) < PLEX_SYNC_INTERVAL_MS) return;
    plexSyncLastTickAt = now;
    try {
      const r = await runPlexSync();
      if (r && r.ok) {
        console.log(`[scheduler] plex sync: +${r.added}/~${r.updated} entities, ${r.edges} edges, ${r.stale} stale, ${r.libraries} libs, ${r.items} items (${r.durationMs}ms)`);
      } else {
        console.log(`[scheduler] plex sync skipped: ${r && (r.reason || r.error) || 'unknown'}`);
      }
    } catch (e) {
      console.error('[scheduler] plex sync:', e.message);
    }
  }

  let schedulerHandle = null;
  function startScheduler() {
    if (schedulerHandle) return;
    const tick = async () => {
      try { await runChoreDigest(); } catch (e) { console.error('[scheduler] chore digest:', e.message); }
      try { await runTakeTurnsDigest(); } catch (e) { console.error('[scheduler] take-turns digest:', e.message); }
      try { await runPlexSyncTick(); } catch (e) { console.error('[scheduler] plex sync tick:', e.message); }
    };
    setTimeout(tick, 10 * 1000);
    schedulerHandle = setInterval(tick, SCHED_TICK_MS);
    console.log('[scheduler] daily digest started; tick=30min; plex entity-sync every 6h');
  }
  startScheduler();
  app.listen(PORT, () => console.log(`Homestead on :${PORT}`));
}
module.exports = app;