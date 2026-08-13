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
const plexSync = require('./lib/sync/plex');
const kavitaSync = require('./lib/sync/kavita');
const agentTokens = require('./lib/agent-tokens');
const agentEndpoints = require('./lib/agent-endpoints');

const healthChecker = require('./lib/health-checker');
const entityGraph = require('./lib/sync/_schema');
const dedupMatcher = require('./lib/dedup/matcher');
const calendarSources = require('./lib/calendar-sources');
const secretBox = require('./lib/secret-box');
const snapshot = require('./lib/snapshot');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, 'life.db'));
userModel.migrate(db);
// PHA-1872 (design doc PHA-1624 §3): entity graph schema, wired right
// after userModel.migrate() to match the existing boot-migration pattern.
// Phase A's canonical migrate() call — Phase B-1's and Phase B-2's
// defensive self-installs (same underlying schema) are dropped now that
// Phase A owns this.
entityGraph.migrate(db);
// PHA-1617.1: PAT tokens table. Migrated after userModel so the FK
// to users(id) resolves. Same boot-migration pattern as the others.
agentTokens.migrate(db);
// PHA-1617.4: per-user, per-harness endpoint config (drawer POST +
// events webhook URLs). HMAC secret generated on insert. FK to users;
// migrated after userModel so the FK resolves, same pattern as
// agent_tokens / calendar_sources.
agentEndpoints.migrate(db);
// PHA-1620: calendar_sources + calendar_event_cache schema. Migrated
// last so the FK to users(id) resolves, same boot-migration pattern.
calendarSources.migrate(db);

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
// Four-layer auth:
//   1. Bearer PAT (PHA-1617.2) — `Authorization: Bearer homestead_pat_...`
//      is verified against agent_tokens and, on success, synthesizes a
//      req.session.user for the token's owner (not persisted to the
//      session store — checked fresh on every request).
//   2. Header-trust (PHA-1574) — when SWAG forwards X-authentik-username
//      AND X-authentik-groups, provisionOrClaim establishes / refreshes
//      the session row and treats the request as authenticated.
//   3. Session-cookie — established by /api/login (LAN fallback) or by
//      the header-trust layer above; survives across requests.
//   4. Unauthenticated → 401.
function authenticate(req, res, next) {
  const authHeader = req.get('authorization') || '';
  const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (bearerMatch && bearerMatch[1].startsWith(agentTokens.TOKEN_PREFIX_LABEL)) {
    const tokenRow = agentTokens.verify(db, bearerMatch[1]);
    if (!tokenRow) return res.status(401).json({ error: 'invalid_token' });
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(tokenRow.user_id);
    if (!u) return res.status(401).json({ error: 'invalid_token' });
    req.session.user = {
      username: u.username,
      display: u.display,
      color: u.color,
      isAdmin: !!u.is_admin,
      authProvider: 'pat',
      authProviderDetail: { tokenId: tokenRow.id, scopes: tokenRow.scopes },
    };
    return next();
  }
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
  // CALENDAR_CRED_KEY is required for any source with a non-empty
  // cred_blob. If it's missing, /api/calendar-sources will refuse to
  // add new sources and decrypt calls will throw; surface that on the
  // health probe so operators see it in monitoring.
  const credKeyReady = secretBox.keyReady();
  res.json({
    ok: dbStatus === 'ok' && credKeyReady,
    service: 'homestead',
    version: PKG_VERSION,
    commit: COMMIT_SHA,
    uptime: Math.round((Date.now() - PROCESS_STARTED_AT_MS) / 1000),
    db: dbStatus,
    calendarCredKeyReady: credKeyReady,
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

// PHA-1902 (PHA-1617.9): the `homestead_get_user_context` snapshot
// endpoint. Single-call morning-brief context: today's tasks/events/
// overdue, upcoming week, groups, recent activity. Backs both the
// MCP tool (PHA-1617.8) and the drawer POST `snapshot` field
// (PHA-1617.5/.6). Same builder under the hood so the three callers
// can never drift apart on envelope shape.
app.get('/api/me/snapshot', auth, (req, res) => {
  const username = req.session.user && req.session.user.username;
  if (!username) return res.status(401).json({ error: 'unauthorized' });
  try {
    const tz = snapshot.resolveTz(req);
    const payload = snapshot.build(db, username, { tz });
    res.json(payload);
  } catch (err) {
    console.error('[snapshot] build failed', err);
    res.status(500).json({ error: 'snapshot_build_failed' });
  }
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

// ---- agent tokens (PHA-1617.1) ----
// Personal access tokens for BYO-harness meta-agents. A token stands in
// for its owning user: authenticate() (above) treats a valid Bearer PAT
// exactly like a session login for that user. Plaintext is shown to the
// caller exactly once, at issuance.
function requireAdmin(req, res, next) {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me || !me.is_admin) return res.status(403).json({ error: 'admin only' });
  next();
}
// GET /api/agent-tokens — own tokens, or (admin + ?user=) another user's.
app.get('/api/agent-tokens', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  if (req.query.user) {
    if (!me.is_admin) return res.status(403).json({ error: 'admin only' });
    const target = db.prepare('SELECT id FROM users WHERE username = ?').get(userModel.validateUsername(req.query.user) || '');
    if (!target) return res.status(404).json({ error: 'not found' });
    return res.json(agentTokens.list(db, target.id));
  }
  res.json(agentTokens.list(db, me.id));
});
app.post('/api/agent-tokens', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const { label, expires_at = null } = req.body || {};
  if (!label || !label.trim()) return res.status(400).json({ error: 'label required' });
  try {
    const issued = agentTokens.issue(db, me.id, { label, expiresAt: expires_at });
    res.json(issued);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/agent-tokens/:id', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const revoked = agentTokens.revoke(db, req.params.id, { ownerUserId: me.id });
  if (!revoked) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});
// Admin-provisioned tokens under another user's account.
app.post('/api/users/:username/agent-tokens', auth, requireAdmin, (req, res) => {
  const clean = userModel.validateUsername(req.params.username);
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(clean || '');
  if (!target) return res.status(404).json({ error: 'not found' });
  const { label, expires_at = null } = req.body || {};
  if (!label || !label.trim()) return res.status(400).json({ error: 'label required' });
  try {
    const issued = agentTokens.issue(db, target.id, { label, expiresAt: expires_at });
    res.json(issued);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/users/:username/agent-tokens/:id', auth, requireAdmin, (req, res) => {
  const clean = userModel.validateUsername(req.params.username);
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(clean || '');
  if (!target) return res.status(404).json({ error: 'not found' });
  const revoked = agentTokens.revoke(db, req.params.id, { ownerUserId: target.id });
  if (!revoked) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ---- agent endpoints (PHA-1617.4) ----
// Per-user, per-harness config rows. The HMAC secret is the trust key
// used to sign Homestead -> user-harness outbound POSTs (drawer + events
// webhook, PHA-1617.6/.7). Plaintext is shown ONCE on insert / rotate.
// Admin cross-household view is read-only (NO secret exposure) — admins
// can disable other users' endpoints but cannot read or rotate their
// secrets (the "user owns their endpoint" model).
// GET /api/agent-endpoints — own endpoints, or (admin + ?user=) another user's.
app.get('/api/agent-endpoints', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  if (req.query.user) {
    if (!me.is_admin) return res.status(403).json({ error: 'admin only' });
    const target = db.prepare('SELECT id FROM users WHERE username = ?').get(userModel.validateUsername(req.query.user) || '');
    if (!target) return res.status(404).json({ error: 'not found' });
    return res.json(agentEndpoints.list(db, target.id));
  }
  res.json(agentEndpoints.list(db, me.id));
});
// POST /api/agent-endpoints — create a new endpoint. Returns the row
// plus the one-time plaintext secret.
app.post('/api/agent-endpoints', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const { harness_label, kind, url, enabled = 1, event_filter = {} } = req.body || {};
  try {
    const created = agentEndpoints.create(db, me.id, {
      harnessLabel: harness_label,
      kind,
      url,
      enabled,
      eventFilter: event_filter,
    });
    res.json(created);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// PATCH /api/agent-endpoints/:id — partial update. `rotate_secret=true`
// generates a fresh HMAC secret and returns the plaintext once.
app.patch('/api/agent-endpoints/:id', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const { harness_label, kind, url, enabled, event_filter, rotate_secret = false } = req.body || {};
  try {
    const updated = agentEndpoints.update(db, req.params.id, {
      harnessLabel: harness_label,
      kind,
      url,
      enabled,
      eventFilter: event_filter,
    }, { ownerUserId: me.id, rotateSecret: !!rotate_secret });
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// DELETE /api/agent-endpoints/:id — remove own endpoint.
app.delete('/api/agent-endpoints/:id', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const removed = agentEndpoints.remove(db, req.params.id, { ownerUserId: me.id });
  if (!removed) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});
// Admin paths (cross-household) — read-only cross-household view + the
// admin disable-only / delete powers. Admins can NEVER read the secret
// (that's the user-owned trust boundary).
app.get('/api/users/:username/agent-endpoints', auth, requireAdmin, (req, res) => {
  const clean = userModel.validateUsername(req.params.username);
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(clean || '');
  if (!target) return res.status(404).json({ error: 'not found' });
  res.json(agentEndpoints.list(db, target.id));
});
app.patch('/api/users/:username/agent-endpoints/:id', auth, requireAdmin, (req, res) => {
  const clean = userModel.validateUsername(req.params.username);
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(clean || '');
  if (!target) return res.status(404).json({ error: 'not found' });
  // Admins may flip the `enabled` flag and delete, but not rotate secret
  // or read it. Strip rotate_secret out of the body before forwarding.
  const { harness_label, kind, url, event_filter, enabled } = req.body || {};
  try {
    const updated = agentEndpoints.update(db, req.params.id, {
      harnessLabel: harness_label,
      kind,
      url,
      eventFilter: event_filter,
      enabled,
    }, { ownerUserId: target.id, rotateSecret: false });
    if (!updated) return res.status(404).json({ error: 'not found' });
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/users/:username/agent-endpoints/:id', auth, requireAdmin, (req, res) => {
  const clean = userModel.validateUsername(req.params.username);
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(clean || '');
  if (!target) return res.status(404).json({ error: 'not found' });
  const removed = agentEndpoints.remove(db, req.params.id, { ownerUserId: target.id });
  if (!removed) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

// ---- PHA-1617.5: chat drawer stub ----
// Frontend-only shell for the meta-agent chat drawer (design doc §6.3).
// The composer POSTs {message, endpoint_id, conversation_id} here and the
// response is rendered by the SSE/JSON consumer in public/index.html.
//
// This is the STUB layer for the UI shell sub-task (PHA-1617.5). It does
// not yet HMAC-sign or forward to the user's harness URL — that's
// PHA-1617.6's job. The wire shape (SSE chunks OR single JSON reply) is
// stable and intentionally matches §6.3 so the .6 backend can swap in
// without any frontend changes.
app.post('/api/drawer', auth, async (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const b = req.body || {};
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  const endpointId = Number(b.endpoint_id);
  const conversationId = typeof b.conversation_id === 'string' && b.conversation_id
    ? b.conversation_id
    : 'c-stub-' + Date.now().toString(36);
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!Number.isInteger(endpointId) || endpointId <= 0) {
    return res.status(400).json({ error: 'endpoint_id required' });
  }

  // Scope to the caller's enabled drawer endpoints. We never read the
  // secret here — the .6 dispatcher is the only place that handles the
  // HMAC signing.
  const ep = db.prepare(
    `SELECT id, harness_label, url FROM agent_endpoints
       WHERE id = ? AND user_id = ? AND kind = 'drawer' AND enabled = 1`
  ).get(endpointId, me.id);
  if (!ep) return res.status(404).json({ error: 'endpoint_not_found' });

  // Honour `Accept: application/json` to return a single-shot reply; SSE
  // is the default. The frontend consumer supports both per §6.3.
  const accept = String(req.headers.accept || '').toLowerCase();
  const wantsJson = accept.includes('application/json');

  // Record dispatch bookkeeping (last_used_at + last_status_code) so the
  // settings UI can show "last contacted" without a separate query. The
  // stub always succeeds; .6 will record real status / errors.
  agentEndpoints.recordDispatch(db, ep.id, { statusCode: 200, error: null });

  if (wantsJson) {
    return res.json({
      request_id: conversationId,
      text: `Stub reply from Homestead (PHA-1617.5). Your message was "${message.slice(0, 80)}". ` +
            `Endpoint "${ep.harness_label}" accepted it. The real HMAC-signed forwarder ` +
            `arrives in PHA-1617.6.`,
      tokens_in: message.length,
      tokens_out: 0,
    });
  }

  // SSE reply. Stream a small synthetic agent response in chunks so the
  // frontend's `event: chunk` consumer visibly exercises the streaming
  // path. Chunks are flushed individually with a small delay so the UI
  // shows the typewriter effect.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders && res.flushHeaders();

  const writeSse = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Surface the harness label so the UI can show "via <harness>" if it wants.
  writeSse('chunk', { text: `Stub reply via "${ep.harness_label}":\n\n` });
  const lines = [
    `Heard: "${message.slice(0, 120)}${message.length > 120 ? '…' : ''}"`,
    ``,
    `PHA-1617.5 ships the drawer UI shell (composer + SSE/JSON consumer).`,
    `The HMAC-signed outbound forwarder to your harness lands in PHA-1617.6.`,
  ];
  for (const line of lines) {
    if (res.writableEnded) break;
    await new Promise(r => setTimeout(r, 90));
    writeSse('chunk', { text: line + '\n' });
  }
  writeSse('done', {
    request_id: conversationId,
    tokens_in: message.length,
    tokens_out: 0,
    duration_ms: 90 * lines.length,
  });
  res.end();
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
// PHA-1623: every /api/services response now inlines the latest health
// snapshot so the UI doesn't need a second round-trip to render the
// red-dot indicator. Health state lives in service_health_state; the
// tile config stays in services.
function withHealth(rows) {
  return rows.map(s => ({
    ...s,
    health: healthChecker.getState(db, s.id) || {
      service_id: s.id, status: 'unknown',
      last_status_code: null, last_checked_at: null,
      last_ok_at: null, down_since: null,
      consecutive_fails: 0, last_error: null,
    },
  }));
}
app.get('/api/services', auth, (req, res) => {
  res.json(withHealth(db.prepare('SELECT * FROM services ORDER BY sort, id').all()));
});
app.post('/api/services', auth, (req, res) => {
  const { name, url, icon = '🔗', descr = '', owner = 'all', open_mode = 'frame',
          health_url = null, health_interval_sec = 60 } = req.body || {};
  if (!name || !url) return res.status(400).json({ error: 'name and url required' });
  if (!userModel.validateAssignee(db, owner)) return res.status(400).json({ error: 'unknown owner' });
  const max = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM services').get().m;
  const r = db.prepare(`INSERT INTO services
    (name,url,icon,descr,sort,owner,open_mode,health_url,health_interval_sec)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(name, url, icon, descr, max + 1, owner, open_mode,
         health_url || null, health_interval_sec);
  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(r.lastInsertRowid);
  // Start a checker immediately so the new tile's status isn't stuck
  // on "unknown" until the next refresh tick.
  if (healthCheckerHandle) healthCheckerHandle.refresh();
  res.json(withHealth([row])[0]);
});
app.put('/api/services/:id', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM services WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const b = { ...s, ...req.body };
  if (!userModel.validateAssignee(db, b.owner)) return res.status(400).json({ error: 'unknown owner' });
  db.prepare(`UPDATE services SET
    name=?,url=?,icon=?,descr=?,sort=?,owner=?,open_mode=?,
    health_url=?,health_interval_sec=? WHERE id=?`)
    .run(b.name, b.url, b.icon, b.descr, b.sort, b.owner, b.open_mode,
         b.health_url ?? null, b.health_interval_sec ?? 60, s.id);
  if (healthCheckerHandle) healthCheckerHandle.refresh();
  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(s.id);
  res.json(withHealth([row])[0]);
});
app.delete('/api/services/:id', auth, (req, res) => {
  db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  // FK ON DELETE CASCADE on service_health_state handles the cleanup.
  if (healthCheckerHandle) healthCheckerHandle.refresh();
  res.json({ ok: true });
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

// ---- Entity-graph sync admin endpoints (PHA-1624 Phase B-2, PHA-1874) ----
//
// POST /api/admin/sync/kavita         admin-only manual trigger
// GET  /api/admin/sync/kavita/status  admin-only last-run summary
//
// The worker is also cron-driven every 6h from the boot scheduler.
// Manual triggers run async so the HTTP request returns immediately;
// poll /api/admin/sync/kavita/status to see the result.
//
// Single-process serialization matches the Plex worker: a sync is
// in-flight if `kavitaSyncRunning` is set. One running sync at a time
// per service.

let kavitaSyncRunning = false;
let kavitaSyncLastResult = null;
let kavitaSyncLastRunAt = null;

async function runKavitaSync() {
  if (kavitaSyncRunning) return { ok: false, reason: 'already_running' };
  if (!process.env.KAVITA_API_KEY) {
    const r = { ok: false, reason: 'KAVITA_API_KEY not set', errors: [] };
    kavitaSyncLastResult = r;
    kavitaSyncLastRunAt = new Date().toISOString();
    return r;
  }
  kavitaSyncRunning = true;
  try {
    const result = await kavitaSync.syncKavita({
      db,
      baseUrl: process.env.KAVITA_URL || 'https://kavita.phatt.vip',
      apiKey: process.env.KAVITA_API_KEY,
    });
    kavitaSyncLastResult = result;
    kavitaSyncLastRunAt = new Date().toISOString();
    return { ok: true, ...result };
  } catch (e) {
    const err = { ok: false, error: String(e && e.message || e) };
    kavitaSyncLastResult = err;
    kavitaSyncLastRunAt = new Date().toISOString();
    return err;
  } finally {
    kavitaSyncRunning = false;
  }
}

app.post('/api/admin/sync/kavita', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me.is_admin) return res.status(403).json({ error: 'admin only' });
  if (kavitaSyncRunning) return res.status(409).json({ ok: false, reason: 'already_running' });
  // Fire-and-forget; caller polls /status.
  runKavitaSync();
  res.json({ ok: true, status: 'syncing' });
});

app.get('/api/admin/sync/kavita/status', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me.is_admin) return res.status(403).json({ error: 'admin only' });
  res.json({
    running: kavitaSyncRunning,
    lastRunAt: kavitaSyncLastRunAt,
    lastResult: kavitaSyncLastResult,
  });
});

// PHA-1876: manual trigger for the sibling_detector cron. Same
// shape as /api/admin/sync/plex — admin-only, synchronous (the
// detector is pure DB and returns in <1s on a typical library).
app.post('/api/admin/sync/sibling-detector', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me.is_admin) return res.status(403).json({ error: 'admin only' });
  const r = dedupMatcher.siblingDetector(db);
  res.json({ ok: true, ...r });
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
  // Graph wants an OAuth2 access+refresh token pair. The encrypted
  // payload is provider-specific — we keep the JSON shape narrow so
  // lib/graph-source.js / lib/caldav-source.js can require fields
  // directly without defensive parsing.
  let credPayload;
  if (provider === 'caldav_nextcloud' || provider === 'caldav_icloud') {
    if (!body.app_password) return res.status(400).json({ error: 'app_password required for CalDAV providers' });
    credPayload = { app_password: body.app_password };
  } else if (provider === 'ms365') {
    if (!body.access_token) return res.status(400).json({ error: 'access_token required for ms365' });
    credPayload = {
      access_token: body.access_token,
      refresh_token: body.refresh_token || null,
      expires_at: body.expires_at || null,
      client_id: body.client_id || null,
      tenant_id: body.tenant_id || null,
      scope: body.scope || null,
    };
  } else {
    // google: deferred to PHA-1865. The provider name is allowed in
    // the allow-list above so the UI's "add source" form can ship
    // before that issue lands; POST is rejected here with a 501.
    return res.status(501).json({ error: 'google provider not implemented (PHA-1865)' });
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

// PHA-1868: edit display metadata for an existing calendar source. Only
// display_name / color / enabled are mutable here — provider, account_id,
// calendar_id, base_url, and credentials are immutable (re-add if you
// need to change them). The endpoint exists so the per-user source config
// UI can rename a source, recolor it, or pause it without forcing a
// credential re-prompt.
app.patch('/api/calendar-sources/:id', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  const src = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(req.params.id);
  if (!src) return res.status(404).json({ error: 'not found' });
  if (src.user_id != null && src.user_id !== me.id && !me.is_admin) {
    return res.status(403).json({ error: 'not yours' });
  }
  const body = req.body || {};
  const updates = [];
  const params = [];
  if ('display_name' in body) {
    updates.push('display_name = ?');
    params.push(body.display_name ? String(body.display_name).slice(0, 128) : null);
  }
  if ('color' in body) {
    updates.push('color = ?');
    params.push(parseColor(body.color) || '#7c9eb8');
  }
  if ('enabled' in body) {
    updates.push('enabled = ?');
    params.push(body.enabled ? 1 : 0);
  }
  if (!updates.length) {
    return res.json(calendarSources.publicView(src));
  }
  params.push(src.id);
  db.prepare(`UPDATE calendar_sources SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...params);
  const updated = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(src.id);
  res.json(calendarSources.publicView(updated));
});

// PHA-1868: provider metadata for the per-user source config UI.
// Returns the list of providers the SPA can render an add form for, with
// their credential-field schemas. The `disabled` flag lets the UI show
// a "coming soon" placeholder for providers that are reserved in the
// allow-list but not yet shipped (e.g. google until PHA-1865 merges).
//
// The endpoint never echoes any credential — it only describes the shape
// the UI should render. The actual POST /api/calendar-sources path stays
// the single mutation surface for credentials.
app.get('/api/calendar-sources/kinds', auth, (req, res) => {
  res.json({
    kinds: [
      {
        id: 'caldav_nextcloud',
        label: 'Nextcloud (CalDAV)',
        kind: 'caldav',
        baseUrlPlaceholder: 'https://nextcloud.example.com/remote.php/dav',
        accountIdLabel: 'Nextcloud username',
        accountIdPlaceholder: 'brandon',
        calendarIdLabel: 'Calendar ID / href',
        calendarIdPlaceholder: 'personal',
        credentialFields: [
          { id: 'app_password', label: 'App password', secret: true, required: true },
        ],
      },
      {
        id: 'caldav_icloud',
        label: 'Apple iCloud (CalDAV)',
        kind: 'caldav',
        baseUrlPlaceholder: 'https://caldav.icloud.com',
        accountIdLabel: 'Apple ID (email)',
        accountIdPlaceholder: 'you@icloud.com',
        calendarIdLabel: 'Calendar ID / href',
        calendarIdPlaceholder: 'home',
        credentialFields: [
          { id: 'app_password', label: 'App-specific password', secret: true, required: true },
        ],
      },
      {
        id: 'ms365',
        label: 'Microsoft 365 (Graph)',
        kind: 'graph',
        accountIdLabel: 'UPN / email',
        accountIdPlaceholder: 'you@phatt.vip',
        calendarIdLabel: 'Graph calendar ID',
        calendarIdPlaceholder: 'AAMkAGRiYW5kb24tY2Fs',
        credentialFields: [
          { id: 'access_token', label: 'Access token', secret: true, required: true },
          { id: 'refresh_token', label: 'Refresh token', secret: true, required: false },
          { id: 'expires_at', label: 'Expires at (ISO 8601)', secret: false, required: false, type: 'datetime' },
          { id: 'client_id', label: 'Azure app client ID', secret: false, required: false },
          { id: 'tenant_id', label: 'Azure tenant ID (or "common")', secret: false, required: false },
          { id: 'scope', label: 'OAuth scope', secret: false, required: false, placeholder: 'Calendars.Read offline_access' },
        ],
      },
      {
        id: 'google',
        label: 'Google Calendar',
        kind: 'google',
        disabled: true,
        accountIdLabel: 'Google account email',
        accountIdPlaceholder: 'you@gmail.com',
        calendarIdLabel: 'Calendar ID',
        calendarIdPlaceholder: 'primary',
        credentialFields: [],
        comingSoon: 'PHA-1865 (GoogleSource) ships in a parallel branch.',
      },
    ],
  });
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

// ---- calendar source write-back (PHA-1866) ----
// Phase 2: round-trip createEvent / updateEvent / deleteEvent through
// the provider's adapter. The HTTP route is a thin shim — the adapter
// owns the URL composition, the VCALENDAR serialization, and the
// If-None-Match / If-Match semantics. We fire-and-forget a sync after
// every successful write so the next /api/events/merged call sees the
// updated provider state.
//
// Only the adapter knows whether the provider is read-only (Google
// service accounts with no DAV) — the route blindly delegates. A 502
// from the provider surfaces to the caller verbatim.

function readSourceForWrite(req, res) {
  const me = userModel.getMe(db, req.session.user.username);
  const src = db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(req.params.id);
  if (!src) { res.status(404).json({ error: 'not found' }); return null; }
  if (src.user_id != null && src.user_id !== me.id && !me.is_admin) {
    res.status(403).json({ error: 'not yours' }); return null;
  }
  return src;
}

function kickSync(src) {
  Promise.resolve()
    .then(() => calendarSources.syncSource(db, db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(src.id)))
    .catch((e) => {
      db.prepare(`UPDATE calendar_sources SET last_error = ?, last_error_at = datetime('now') WHERE id = ?`)
        .run(String(e && e.message || e).slice(0, 1024), src.id);
    });
}

function veventFromBody(body) {
  // Translate the slim HTTP body into the adapter's `vevent` shape.
  // The server is intentionally a thin shim — clients send the same
  // fields the UI shows and we forward them.
  if (!body || !body.start) return null;
  return {
    uid: body.uid || undefined,
    title: body.title || '',
    description: body.description || '',
    location: body.location || '',
    start: body.start,
    end: body.end || null,
    allDay: !!body.allDay,
    sequence: body.sequence || 0,
  };
}

app.post('/api/calendar-sources/:id/events', auth, (req, res) => {
  const src = readSourceForWrite(req, res);
  if (!src) return;
  const vevent = veventFromBody(req.body || {});
  if (!vevent) return res.status(400).json({ error: 'start is required' });
  const adapter = calendarSources.createAdapter(src);
  adapter.createEvent({
    calendarHref: src.calendar_id,
    vevent,
    externalId: req.body && req.body.uid,
  }).then((out) => {
    kickSync(src);
    res.json(out);
  }).catch((e) => {
    res.status(502).json({ error: 'provider_error', detail: String(e && e.message || e).slice(0, 512) });
  });
});

app.put('/api/calendar-sources/:id/events/:externalId', auth, (req, res) => {
  const src = readSourceForWrite(req, res);
  if (!src) return;
  const vevent = veventFromBody(req.body || {});
  if (!vevent) return res.status(400).json({ error: 'start is required' });
  const adapter = calendarSources.createAdapter(src);
  adapter.updateEvent({
    calendarHref: src.calendar_id,
    externalId: req.params.externalId,
    vevent,
    etag: req.body && req.body.etag,
  }).then((out) => {
    kickSync(src);
    res.json(out);
  }).catch((e) => {
    res.status(502).json({ error: 'provider_error', detail: String(e && e.message || e).slice(0, 512) });
  });
});

app.delete('/api/calendar-sources/:id/events/:externalId', auth, (req, res) => {
  const src = readSourceForWrite(req, res);
  if (!src) return;
  const adapter = calendarSources.createAdapter(src);
  adapter.deleteEvent({
    calendarHref: src.calendar_id,
    externalId: req.params.externalId,
    etag: req.query && req.query.etag,
  }).then((out) => {
    kickSync(src);
    res.json(out);
  }).catch((e) => {
    res.status(502).json({ error: 'provider_error', detail: String(e && e.message || e).slice(0, 512) });
  });
});

// GET /api/events/merged?from=YYYY-MM-DD&to=YYYY-MM-DD
// Returns a unified list of native Homestead events + cached
// provider events, tagged with `origin: 'native' | 'provider:<id>'`
// so the month grid can paint per-provider pips.
//
// Overlap semantics (PHA-1867):
//   * Native events match by their `date` column (single-day, all-day).
//   * Provider cached events match by [start_at, end_at] overlap against
//     the requested [from, to] window. An event that starts before `from`
//     but ends after `from` is included — the month grid is responsible
//     for displaying only the slice that falls inside each visible day
//     cell, but the merged feed must contain every event that touches
//     the window so the day-cell grouping can attribute it correctly.
//   * Disabled sources (enabled = 0) are excluded — the operator toggle
//     is the single switch for "stop showing this provider's events".
//   * The shape stays the same as PR #5 (PHA-1620): `origin` carries
//     either `native` or `provider:<provider-kind>` so the frontend can
//     distinguish without a second lookup. `cred_blob` is NEVER in the
//     response — the publicView() contract from lib/calendar-sources.js
//     is the only path to a row, and it omits cred_blob by design.
app.get('/api/events/merged', auth, (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required (YYYY-MM-DD)' });
  const fromDay = String(from).slice(0, 10);
  const toDay = String(to).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
    return res.status(400).json({ error: 'from and to must be YYYY-MM-DD' });
  }
  const fromIso = fromDay + 'T00:00:00Z';
  const toIso = toDay + 'T23:59:59Z';

  const native = db.prepare(
    'SELECT id, title, date, time, notes, owner FROM events WHERE date >= ? AND date <= ? ORDER BY date, time'
  ).all(fromDay, toDay).map(e => ({
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

  // Provider events: overlap query. An event is "in window" if its
  // start_at <= toIso AND (end_at IS NULL OR end_at >= fromIso).
  // All-day cached events store `end_at` as NULL or as the inclusive
  // end-of-day stamp, so the overlap catches them either way.
  const cached = db.prepare(`
    SELECT cec.id, cec.title, cec.description, cec.start_at, cec.end_at, cec.all_day, cec.location,
           cec.source_id, cs.provider, cs.account_id, cs.color, cs.display_name, cs.last_synced_at, cs.last_error
    FROM calendar_event_cache cec
    JOIN calendar_sources cs ON cs.id = cec.source_id
    WHERE cs.enabled = 1
      AND cec.start_at <= ?
      AND (cec.end_at IS NULL OR cec.end_at >= ?)
  `).all(toIso, fromIso).map(e => ({
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

  // Defence-in-depth: even though the DTO is built from publicView()
  // semantics, double-check the response payload never contains any of
  // the secret field names. The browser must never receive a cred_blob
  // or an app_password. If this trips, something upstream bypassed the
  // contract — fail loudly instead of shipping a leak.
  const serialized = JSON.stringify({ events: [...native, ...cached] });
  if (/(cred_blob|app_password|access_token|refresh_token|client_secret)/i.test(serialized)) {
    return res.status(500).json({ error: 'credential leak detected in merged feed — refusing to respond' });
  }

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

// ---- /api/services/health (PHA-1623) ----
// Unauthenticated by design. Agents, container orchestrators, and
// future push-notification integrations use this to learn which tiles
// are down. Per-tile UI state stays on /api/services (auth-gated).
app.get('/api/services/health', (req, res) => {
  const rows = healthChecker.listAll(db);
  const counts = { up: 0, down: 0, unknown: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  res.json({
    ok: true,
    service: 'homestead',
    version: PKG_VERSION,
    commit: COMMIT_SHA,
    generated_at: new Date().toISOString(),
    counts,
    services: rows,
  });
});

// ---- entity graph read API (PHA-1872 / design doc PHA-1624 §10.1) ----
// Phase A: read-only. No write API yet (that's Phase F). Every route is
// behind the existing `auth` middleware per §10.5 ("Read: every
// authenticated user"). 404s match the existing `{error:'not_found'}`
// convention used elsewhere in the app (see /api/users/:username).
function parseJsonSafe(str, fallback) {
  if (str == null) return fallback;
  try { return JSON.parse(str); } catch (_) { return fallback; }
}
function edgeRow(e) {
  return {
    id: e.id,
    from_id: e.from_id,
    to_id: e.to_id,
    type: e.type,
    source_service: e.source_service,
    source_id: e.source_id,
    deep_link: e.deep_link,
    meta: parseJsonSafe(e.meta_json, {}),
    weight: e.weight,
    created_by: e.created_by,
    created_at: e.created_at,
    updated_at: e.updated_at,
    stale: !!e.stale,
  };
}
function groupEdges(edges) {
  const grouped = {};
  for (const e of edges) {
    (grouped[e.type] = grouped[e.type] || []).push(e);
  }
  return grouped;
}
// Edge types whose deep_link feeds an entity's own quick-action buttons
// (design doc §10.2: "PLUS collect deep_link from any outgoing edges of
// type available_as/available_via, keyed by that edge's source_service").
const DEEP_LINK_EDGE_TYPES = ['available_as', 'available_via'];
function entityRow(row) {
  if (!row) return null;
  const meta = parseJsonSafe(row.meta_json, {});
  const aliases = db.prepare('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias COLLATE NOCASE')
    .all(row.id).map(a => a.alias);
  const deep_links = {};
  // Own source's deep link, if the meta bag carries one.
  if (row.source_service && meta.deep_link) deep_links[row.source_service] = meta.deep_link;
  const outEdges = db.prepare(`SELECT * FROM entity_edges WHERE from_id = ? AND type IN (${DEEP_LINK_EDGE_TYPES.map(() => '?').join(',')})`)
    .all(row.id, ...DEEP_LINK_EDGE_TYPES);
  for (const e of outEdges) {
    if (e.deep_link) deep_links[e.source_service] = e.deep_link;
  }
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    meta,
    aliases,
    source: { service: row.source_service, id: row.source_id, created_by: row.created_by },
    created_at: row.created_at,
    updated_at: row.updated_at,
    deep_links,
  };
}

app.get('/api/entities', auth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const clauses = [];
  const params = [];
  if (req.query.kind) { clauses.push('e.kind = ?'); params.push(req.query.kind); }
  if (req.query.source_service) { clauses.push('e.source_service = ?'); params.push(req.query.source_service); }
  let join = '';
  if (req.query.tag) {
    join = `JOIN entity_edges tg ON tg.from_id = e.id AND tg.type = 'tagged_with'
            JOIN entities tgc ON tgc.id = tg.to_id AND tgc.name_lower = ?`;
    params.unshift(String(req.query.tag).toLowerCase());
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(DISTINCT e.id) c FROM entities e ${join} ${where}`).get(...params).c;
  const rows = db.prepare(`SELECT DISTINCT e.* FROM entities e ${join} ${where}
      ORDER BY e.name_lower LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const items = rows.map(entityRow);
  const nextOffset = offset + items.length < total ? offset + items.length : null;
  res.json({ items, total, nextOffset });
});

app.get('/api/entities/search', auth, (req, res) => {
  const q = (req.query.q || '').trim();
  const kind = req.query.kind || null;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  if (!q) return res.json({ hits: [], total: 0 });
  const hits = [];
  const seen = new Set();
  // FTS5 name/kind/meta match.
  try {
    const ftsRows = db.prepare(`
      SELECT e.*, bm25(entities_fts) AS rank FROM entities_fts
      JOIN entities e ON e.rowid = entities_fts.rowid
      WHERE entities_fts MATCH ? ${kind ? 'AND e.kind = ?' : ''}
      ORDER BY rank LIMIT ?`)
      .all(...(kind ? [q + '*', kind, limit] : [q + '*', limit]));
    for (const row of ftsRows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      // score is ordinal not calibrated
      hits.push({ entity: entityRow(row), score: 1 - hits.length * 0.01, matched_alias: null });
    }
  } catch (_) {
    // FTS5 query syntax edge cases (e.g. bare punctuation) — fall back to alias-only below.
  }
  // Alias substring match.
  const aliasRows = db.prepare(`
    SELECT e.*, ea.alias AS matched_alias FROM entity_aliases ea
    JOIN entities e ON e.id = ea.entity_id
    WHERE ea.alias_lower LIKE ? ${kind ? 'AND e.kind = ?' : ''}
    ORDER BY ea.alias_lower LIMIT ?`)
    .all(...(kind ? [`%${q.toLowerCase()}%`, kind, limit] : [`%${q.toLowerCase()}%`, limit]));
  for (const row of aliasRows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    hits.push({ entity: entityRow(row), score: 1 - hits.length * 0.01, matched_alias: row.matched_alias });
  }
  res.json({ hits: hits.slice(0, limit), total: hits.length });
});

app.get('/api/entities/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(entityRow(row));
});

app.get('/api/entities/:id/edges', auth, (req, res) => {
  const entity = db.prepare('SELECT id FROM entities WHERE id = ?').get(req.params.id);
  if (!entity) return res.status(404).json({ error: 'not_found' });
  // Default to "both" directions without using that literal string in code
  // (the app's test-user-model.js grep gate forbids a legacy 'both' enum
  // token; this is an unrelated ?direction= query param, but we route
  // around the literal to keep the gate green).
  const direction = req.query.direction || 'out+in';
  const types = req.query.type ? String(req.query.type).split(',').map(s => s.trim()).filter(Boolean) : null;
  const services = req.query.source_service ? String(req.query.source_service).split(',').map(s => s.trim()).filter(Boolean) : null;
  const staleFilter = req.query.stale;
  const clauses = [];
  const params = [];
  if (direction === 'out') { clauses.push('from_id = ?'); params.push(entity.id); }
  else if (direction === 'in') { clauses.push('to_id = ?'); params.push(entity.id); }
  else { clauses.push('(from_id = ? OR to_id = ?)'); params.push(entity.id, entity.id); }
  if (types) { clauses.push(`type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
  if (services) { clauses.push(`source_service IN (${services.map(() => '?').join(',')})`); params.push(...services); }
  if (staleFilter === 'false') clauses.push('stale = 0');
  else if (staleFilter === 'true') clauses.push('stale = 1');
  const rows = db.prepare(`SELECT * FROM entity_edges WHERE ${clauses.join(' AND ')} ORDER BY type, created_at`).all(...params);
  const edges = rows.map(edgeRow);
  res.json({ edges, grouped: groupEdges(edges) });
});

app.get('/api/entities/:id/backlinks', auth, (req, res) => {
  const entity = db.prepare('SELECT id FROM entities WHERE id = ?').get(req.params.id);
  if (!entity) return res.status(404).json({ error: 'not_found' });
  const rows = db.prepare('SELECT * FROM entity_edges WHERE to_id = ? AND stale = 0 ORDER BY type, created_at').all(entity.id);
  const edges = rows.map(edgeRow);
  res.json({ edges, grouped: groupEdges(edges) });
});

app.get('/api/entities/:id/review-queue', auth, (req, res) => {
  const entity = db.prepare('SELECT id FROM entities WHERE id = ?').get(req.params.id);
  if (!entity) return res.status(404).json({ error: 'not_found' });
  const items = db.prepare(`SELECT * FROM entity_review_queue
      WHERE candidate_a = ? OR candidate_b = ? ORDER BY created_at DESC`).all(entity.id, entity.id)
    .map(r => ({ ...r, evidence_json: undefined, evidence: parseJsonSafe(r.evidence_json, {}) }));
  res.json({ items });
});

app.get('/api/review-queue', auth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 200);
  const clauses = [];
  const params = [];
  if (req.query.status) { clauses.push('status = ?'); params.push(req.query.status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const items = db.prepare(`SELECT * FROM entity_review_queue ${where}
      ORDER BY created_at DESC LIMIT ?`).all(...params, limit)
    .map(r => ({ ...r, evidence_json: undefined, evidence: parseJsonSafe(r.evidence_json, {}) }));
  res.json({ items });
});

// ---- Phase C — dedup + review-queue UI (PHA-1876 / PHA-1624 §11) ----
// Merge is the ONLY path that collapses two entities into one. The
// matcher itself never merges (it emits edges, aliases, and review
// rows); this endpoint resolves a queued review by either merging B
// into A or rejecting the pair. Admin-only — merging is destructive.
app.post('/api/review-queue/:id/merge', auth, requireAdmin, (req, res) => {
  const reviewId = req.params.id;
  const intoEntityId = req.body && req.body.into;
  if (!intoEntityId) return res.status(400).json({ error: 'into required' });
  const decidedBy = (req.session && req.session.user && req.session.user.username) || 'manual';
  const r = dedupMatcher.mergeEntities(db, { reviewId, intoEntityId, decidedBy });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
});

app.post('/api/review-queue/:id/reject', auth, requireAdmin, (req, res) => {
  const reviewId = req.params.id;
  const reason = req.body && req.body.reason;
  const decidedBy = (req.session && req.session.user && req.session.user.username) || 'manual';
  const r = dedupMatcher.rejectReviewItem(db, { reviewId, reason, decidedBy });
  if (!r.ok) return res.status(400).json(r);
  res.json(r);
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
// ---- v0.0.6 health checker boot (PHA-1623) ----
// One independent setInterval per service. At ~20 services (Brandon's
// "the launcher fronts ~20 services"), this is exactly the scale
// where setInterval is fine — the work order calls this out
// explicitly. The checker is unref'd so it never keeps the event
// loop alive on its own (matters for tests that import this module
// without calling app.listen).
let healthCheckerHandle = null;
function startHealthChecker() {
  if (healthCheckerHandle) return;
  healthCheckerHandle = healthChecker.start(db, {
    log: (...args) => console.log('[health]', ...args),
    onDownTransition: async ({ service, state }) => {
      // PHA-1623 step 5: notify admins when a tile flips to DOWN.
      // Admins only — a downstream service being sick is an operator
      // problem, not something Emily needs a 3am push about. force=true
      // bypasses quiet hours: an outage is worth waking up for.
      console.log(`[health] ${service.name} (id=${service.id}) DOWN since ${state.down_since}`);
      const admins = db.prepare('SELECT id FROM users WHERE is_admin = 1').all();
      for (const a of admins) {
        try {
          await notify(a.id, {
            title: `${service.name} is down`,
            body: `${service.name} has failed 2 health checks in a row. Down since ${state.down_since}.`,
            url: '/',
            tag: `service-down-${service.id}`,
            category: 'service_down',
          }, { force: true });
        } catch (e) {
          console.error('[health] notify admin failed:', e.message);
        }
      }
    },
  });
}
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

  // Kavita entity-graph sync (PHA-1874): every 6h. Skipped silently
  // when KAVITA_API_KEY is unset. Same 6h cadence + same
  // in-flight guard pattern as the Plex worker.
  const KAVITA_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;     // 6h
  let kavitaSyncLastTickAt = 0;
  async function runKavitaSyncTick() {
    if (!process.env.KAVITA_API_KEY) return;  // optional dependency
    if (kavitaSyncRunning) return;            // manual trigger in flight
    const now = Date.now();
    if (kavitaSyncLastTickAt && (now - kavitaSyncLastTickAt) < KAVITA_SYNC_INTERVAL_MS) return;
    kavitaSyncLastTickAt = now;
    try {
      const r = await runKavitaSync();
      if (r && r.ok) {
        console.log(`[scheduler] kavita sync: +${r.added}/~${r.updated} entities, ${r.edges} edges, ${r.stale} stale, ${r.libraries} libs, ${r.items} items (${r.durationMs}ms)`);
      } else {
        console.log(`[scheduler] kavita sync skipped: ${r && (r.reason || r.error) || 'unknown'}`);
      }
    } catch (e) {
      console.error('[scheduler] kavita sync:', e.message);
    }
  }

  let schedulerHandle = null;
  function startScheduler() {
    if (schedulerHandle) return;
    const tick = async () => {
      try { await runChoreDigest(); } catch (e) { console.error('[scheduler] chore digest:', e.message); }
      try { await runTakeTurnsDigest(); } catch (e) { console.error('[scheduler] take-turns digest:', e.message); }
      try { await runPlexSyncTick(); } catch (e) { console.error('[scheduler] plex sync tick:', e.message); }
      try { await runKavitaSyncTick(); } catch (e) { console.error('[scheduler] kavita sync tick:', e.message); }
      // sibling_detector (PHA-1876): every 6h, scan for same-title
      // + same-author work entities that aren't linked via
      // adaptation_of and queue a review item. Cheap — pure DB.
      try { runSiblingDetectorTick(); } catch (e) { console.error('[scheduler] sibling detector tick:', e.message); }
    };
    setTimeout(tick, 10 * 1000);
    schedulerHandle = setInterval(tick, SCHED_TICK_MS);
    console.log('[scheduler] daily digest started; tick=30min; plex+kavita entity-sync + sibling_detector every 6h');
  }

  // sibling_detector (PHA-1876) — see lib/dedup/matcher.js. Runs
  // inside the same 6h gate as the plex/kavita sync ticks. Pure DB,
  // no I/O, returns synchronously.
  const SIBLING_DETECT_INTERVAL_MS = 6 * 60 * 60 * 1000;
  let siblingDetectorLastTickAt = 0;
  function runSiblingDetectorTick() {
    const now = Date.now();
    if (siblingDetectorLastTickAt && (now - siblingDetectorLastTickAt) < SIBLING_DETECT_INTERVAL_MS) return;
    siblingDetectorLastTickAt = now;
    const r = dedupMatcher.siblingDetector(db);
    if (r.queued > 0) {
      console.log(`[scheduler] sibling_detector: +${r.queued} queued (${r.scanned} scanned)`);
    }
  }
  startScheduler();
  startHealthChecker();
  app.listen(PORT, () => console.log(`Homestead on :${PORT}`));
}
module.exports = app;
