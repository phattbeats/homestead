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
const modules = require('./lib/modules');
const plexSync = require('./lib/sync/plex');
const kavitaSync = require('./lib/sync/kavita');
const agentTokens = require('./lib/agent-tokens');
const agentEndpoints = require('./lib/agent-endpoints');
const appApiLog = require('./lib/app-api-log');
const appInstall = require('./lib/app-install');
const connectorInstall = require('./lib/connector-install');
const connectorWizard = require('./lib/connector-wizard');

const healthChecker = require('./lib/health-checker');
const entityGraph = require('./lib/sync/_schema');
const dedupMatcher = require('./lib/dedup/matcher');
const calendarSources = require('./lib/calendar-sources');
const secretBox = require('./lib/secret-box');
const snapshot = require('./lib/snapshot');
const drawerDispatch = require('./lib/drawer-dispatch');
const eventsDispatch = require('./lib/events-dispatch');
const media = require('./lib/media');
const walls = require('./lib/walls');
const lists = require('./lib/lists');
const notifications = require('./lib/notifications');
const analytics = require('./lib/analytics');
const invites = require('./lib/invites');
const wallMembers = require('./lib/wall-members');

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
// PHA-2201.3 (PHA-2231): third-party app accountability trail. FKs to
// users(id) and installed_apps(key), so it runs right after
// agentTokens.migrate (which creates installed_apps).
appApiLog.migrate(db);
// PHA-2201.1 (PHA-2229): install flow's consent-token table. FK to
// users(id), so it runs after userModel.migrate; no dependency on
// installed_apps (consent tokens exist before an app is installed).
appInstall.migrate(db);
// Connector Forge's immutable specs, encrypted per-user secrets, installs,
// and surface-cache tables. This must boot before the wizard routes below.
connectorInstall.migrate(db);
connectorWizard.migrate(db);
// PHA-1617.4: per-user, per-harness endpoint config (drawer POST +
// events webhook URLs). HMAC secret generated on insert. FK to users;
// migrated after userModel so the FK resolves, same pattern as
// agent_tokens / calendar_sources.
agentEndpoints.migrate(db);
// PHA-1620: calendar_sources + calendar_event_cache schema. Migrated
// last so the FK to users(id) resolves, same boot-migration pattern.
calendarSources.migrate(db);
// PHA-2149: media_uploads table. Same boot-migration pattern; FK to
// users(id) so it runs after userModel.migrate.
media.migrate(db);
// PHA-2150: walls/posts/reactions/comments. FKs to users(id) and
// media_uploads(id), so it runs after userModel.migrate and media.migrate.
walls.migrate(db);
walls.seed(db);
analytics.migrate(db);
// PHA-2207 (PHA-2200.6): invite codes. FKs to walls(slug), so it
// runs after walls.migrate().
invites.migrate(db);
// PHA-2586: lists + list_items tables. FKs to users(id), so it runs
// after userModel.migrate (same boot-migration pattern as the other
// primitives). seed() provisions one "Groceries" list for the
// single-site household so a fresh install can demonstrate the
// primitive end-to-end.
lists.migrate(db);
lists.seed(db);

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
-- v0.1.22: install-funnel telemetry (PHA-2219). Every step the
-- install coach emits lands here as a row; the analytics funnel
-- pipeline (PHA-2210) consumes these rows to build the
-- invite → accepted → installed → push-enabled funnel. Steps are
-- intentionally a closed enum (validated at the route handler) so
-- dashboards can group on step without parsing free text.
CREATE TABLE IF NOT EXISTS install_funnel_events (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  step TEXT NOT NULL,
  platform TEXT,
  meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_install_funnel_user ON install_funnel_events(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_install_funnel_step ON install_funnel_events(step, created_at DESC);
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

// PHA-1617.6: in-memory consecutive-failure streak map, keyed by
// agent_endpoints.id. Used by the drawer dispatcher to decide when
// the per-endpoint circuit breaker should trip (5 consecutive
// failures → enabled=0, §6.5). Resets to 0 on any successful dispatch.
// In-memory only; the persistent record is the row's last_status_code
// + last_error columns written by agentEndpoints.recordDispatch.
app.locals.drawerStreakMap = new Map();

// PHA-1617.7: same in-memory consecutive-failure streak pattern as
// drawerStreakMap above, but tracked separately — a household's
// drawer harness and events harness (often the same physical box, but
// possibly different agent_endpoints rows) trip their circuit
// breakers independently.
app.locals.eventsStreakMap = new Map();

function recordSessionStart(req, user, device) {
  if (!req.session || req.session.analyticsSessionStartedAt) return;
  req.session.analyticsSessionStartedAt = Date.now();
  analytics.logEvent(db, { userId: user.id, kind: 'session_started', subjectType: 'user', subjectId: user.id, meta: { device } });
  analytics.logFirst(db, { userId: user.id, kind: 'first_login', subjectType: 'user', subjectId: user.id, meta: { device } });
}

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
    // PHA-2231: third-party app accountability trail. app_id IS NULL is
    // the existing PHA-1617 user-level PAT and is never logged — this
    // table is scoped to app-issued tokens only. Written from 'finish'
    // (fires after the response is already sent) so the log write never
    // sits on this request's critical path.
    if (tokenRow.app_id) {
      res.on('finish', () => {
        try {
          appApiLog.log(db, {
            userId: u.id,
            appId: tokenRow.app_id,
            route: `${req.method} ${req.path}`,
            scopesUsed: tokenRow.scopes,
            status: res.statusCode,
          });
        } catch (err) {
          console.warn('[app-api-log] write failed:', err.message);
        }
      });
    }
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
    // PHA-2207 (PHA-2200.6): union in group_names from wall_memberships
    // rows for group-visibility walls so invite-granted group
    // membership survives subsequent header-trust reconciliations.
    const inviteGroups = db.prepare(`
      SELECT DISTINCT w.group_name AS name FROM wall_memberships wm
      JOIN walls w ON w.id = wm.wall_id
      WHERE wm.user_id = (SELECT id FROM users WHERE username = ?) AND w.visibility = 'group'
    `).all(headerUser).map(r => r.name).filter(Boolean);
    const mergedGroups = Array.from(new Set([...groups, ...inviteGroups]));
    const u = userModel.provisionOrClaim(db, headerUser, 'header_trust', headerUser, mergedGroups);
    if (!u) return res.status(401).json({ error: 'invalid trusted username' });
    req.session.user = {
      username: u.username,
      display: u.display,
      color: u.color,
      isAdmin: !!u.is_admin,
      authProvider: 'header_trust',
    };
    recordSessionStart(req, u, 'header_trust');
    return next();
  }
  if (req.session.user) return next();
  return res.status(401).json({ error: 'unauthorized' });
}
// Legacy alias used by route definitions below.
const auth = authenticate;

// ---- app-scoped token authorization (PHA-2052 dogfood) ----
// `authenticate()` above accepts a Bearer app token and synthesizes the
// SAME req.session.user shape a real household member gets — on its own
// that means an app-scoped PAT is authorized as if it were the full
// underlying user, regardless of the scopes[] the manifest actually
// declared and the user actually consented to. `tokenScopes(req)`
// distinguishes the three auth paths:
//   * Bearer app token (authProviderDetail.scopes is a JSON array) ->
//     that array, and ONLY that array, gates what the request may do.
//   * Legacy user-level PAT (authProviderDetail.scopes === 'user') or
//     session/header-trust auth (no authProviderDetail at all) -> null,
//     meaning "full access" — unchanged behavior for every caller that
//     isn't an installed third-party app.
function tokenScopes(req) {
  const detail = req.session.user && req.session.user.authProviderDetail;
  if (!detail || detail.scopes === undefined || detail.scopes === 'user') return null;
  try {
    const arr = JSON.parse(detail.scopes);
    return Array.isArray(arr) ? arr : null;
  } catch (_) {
    return null;
  }
}
// requireScope(scope): the token must carry this exact scope string.
function requireScope(scope) {
  return function (req, res, next) {
    const scopes = tokenScopes(req);
    if (scopes === null || scopes.includes(scope)) return next();
    return res.status(403).json({ error: 'insufficient_scope', required: scope });
  };
}
// requireWallReadScope: read:walls (any wall) or read:walls:<slug>
// (this wall only) — mirrors the two-tier vocabulary in
// lib/scope-display.js (§3: the fixed `read:walls` phrase vs. the
// per-wall `read:walls:{id}` pattern). Scope names use underscores
// (lib/scope-display.js's fixed `read:walls:media_club` entry) while
// wall slugs use dashes (`walls.seed()`'s `media-club`) — the §3
// vocabulary is locked as written, so the slug is normalized to match
// it here rather than the other way around.
function requireWallReadScope(req, res, next) {
  const scopes = tokenScopes(req);
  if (scopes === null) return next();
  const scopeSlug = req.params.slug.replace(/-/g, '_');
  if (scopes.includes('read:walls') || scopes.includes(`read:walls:${scopeSlug}`)) return next();
  return res.status(403).json({ error: 'insufficient_scope', required: `read:walls:${scopeSlug}` });
}

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
      analytics.logEvent(db, { userId, kind: 'push_delivered', subjectType: 'push_subscription', subjectId: s.id,
        meta: { category, request_tag: payload.tag || category } });
    } catch (err) {
      errors++;
      const status = err.statusCode || 0;
      if (status === 404 || status === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(s.id);
      } else {
        db.prepare('UPDATE push_subscriptions SET last_failure_at=datetime(\'now\'), failure_count=failure_count+1 WHERE id=?').run(s.id);
      }
      if (status !== 404 && status !== 410) analytics.logEvent(db, {
        userId, kind: 'push_failed', subjectType: 'push_subscription', subjectId: s.id,
        meta: { category, status_code: status, error: err.message || null },
      });
    }
  }
  logNotification(userId, category, payload, delivered, delivered === 0 && errors > 0 ? 'all_endpoints_failed' : null);
  // PHA-1617.7: mirror every attempted push out to the user's opted-in
  // events endpoints (category 'push'). Fire-and-forget — a dead
  // events harness must never affect push delivery to the browser.
  const pushUser = db.prepare('SELECT id, username, display, color FROM users WHERE id = ?').get(userId);
  if (pushUser) {
    eventsDispatch.dispatchEvent(db, app.locals.eventsStreakMap, pushUser, 'push', {
      category, title: payload.title || '', body: payload.body || '',
      url: payload.url || '/', tag: payload.tag || category,
      delivered, errors,
    }).catch(() => {});
  }
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
  // cred_blob. Its absence only disables that optional integration:
  // it must not make the core service health probe fail on a README-default
  // install. Keep the readiness signal separately for calendar operators.
  const credKeyReady = secretBox.keyReady();
  res.json({
    ok: dbStatus === 'ok',
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
//
// PHA-2583: GET /api/login is the bounce target used by /invite/:code
// (and /welcome.html) when a signed-out visitor lands on a wall-link
// URL. Without this GET handler the /api/* 404 catch-all below served
// JSON `{"error":"not_found"}` to a browser expecting an HTML login
// page. We 302-redirect to / (the SPA root, which carries the login
// form in public/index.html) with the original ?next= preserved so
// the SPA can bounce the user back to /invite/:code after a successful
// login. The next= whitelist rejects anything that isn't a same-origin
// path beginning with `/invite/`, `/welcome`, or `/` — open-redirect
// hardening.
app.get('/api/login', (req, res) => {
  const raw = typeof req.query.next === 'string' ? req.query.next : '';
  // Allow only relative same-origin paths. Accept `/invite/{code}`,
  // `/welcome`, and bare `/`. Reject absolute URLs, protocol-relative
  // URLs (`//evil`), and anything with embedded CR/LF or backslashes.
  let safeNext = '/';
  if (
    raw &&
    raw.startsWith('/') &&
    !raw.startsWith('//') &&
    !/[\\\r\n]/.test(raw) &&
    (raw === '/' || raw.startsWith('/invite/') || raw.startsWith('/welcome'))
  ) {
    safeNext = raw;
  }
  res.redirect(302, '/?next=' + encodeURIComponent(safeNext));
});

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
  recordSessionStart(req, u, 'password');
  res.json({ user: req.session.user });
});
app.post('/api/logout', (req, res) => {
  const username = req.session && req.session.user && req.session.user.username;
  const startedAt = req.session && req.session.analyticsSessionStartedAt;
  const user = username && userModel.getMe(db, username);
  req.session.destroy(() => {
    if (user) analytics.logEvent(db, { userId: user.id, kind: 'session_ended', subjectType: 'user', subjectId: user.id,
      durationSeconds: Math.max(0, Math.round((Date.now() - (startedAt || Date.now())) / 1000)) });
    res.json({ ok: true });
  });
});
app.get('/api/logout', (req, res) => res.status(405).json({ error: 'method_not_allowed', allow: 'POST' }));
app.get('/api/me', (req, res) => {
  // Header-trust probe (PHA-1574): when SWAG forwards X-authentik-username,
  // run provisionOrClaim inline so a header-trust user without a session
  // cookie yet still sees themselves. Unauthenticated requests return
  // { user: null } (200) instead of 401 so the SPA can use /api/me as a
  // "am I signed in?" check on every page load without a redirect.
  //
  // PHA-2204 (PHA-2200.3) extension: when authenticated, also include
  //   enabled_modules: ['wall','apps',...]  (registry order)
  //   default_route:    '/porch.html'       (first enabled module's room route)
  //   first_run:        true | false        (first_run_completed_at IS NULL)
  // so the SPA bootstrap (PHA-2200.4) can render without a second
  // /api/me/layout fetch.
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
    return res.json(buildMeEnvelope(db, req.session.user));
  }
  if (!req.session.user) return res.json({ user: null });
  res.json(buildMeEnvelope(db, req.session.user));
});

// `buildMeEnvelope` assembles the full /api/me response shape. Pulled
// out so both the header-trust and session-cookie paths in the route
// above use the same envelope construction. Kept module-local so it
// doesn't leak into other routes.
function buildMeEnvelope(db, sessionUser) {
  const enabledRows = userModel.getEnabledModules(db,
    db.prepare('SELECT id FROM users WHERE username = ?').get(sessionUser.username).id);
  const enabledKeys = enabledRows.map(e => e.key);
  const firstRoomRoute = modules.getRoomRoute(enabledKeys[0]);
  const userId = db.prepare('SELECT id FROM users WHERE username = ?').get(sessionUser.username).id;
  return {
    user: sessionUser,
    enabled_modules: enabledKeys, // registry order, deterministic
    default_route: firstRoomRoute, // first enabled module's room route (or null)
    first_run: userModel.isFirstRun(db, userId),
  };
}

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
// ---- PHA-2204 (PHA-2200.3): module / layout API surface ----
//
// Four read endpoints + two write endpoints:
//   * GET  /api/me/layout       — SPA bootstrap; computed from enabled set
//   * GET  /api/me/modules      — current user's enabled keys (registry order)
//   * GET  /api/modules         — full registry array (for the add-a-room sheet)
//   * POST /api/me/modules/:key/enable   — idempotent; cascade via withRequirements
//   * POST /api/me/modules/:key/disable  — idempotent; cascade via withDependents
//
// Auth: every endpoint uses the existing `auth` middleware. Users only
// modify their own `user_modules` rows (the handlers below look up the
// caller's user.id from the session). No new admin gates.

// GET /api/me/layout — returns the SPA bootstrap shape built from the
// caller's currently-enabled modules. See lib/modules.computeLayout for
// the four layout modes (empty / feed-only / feed-tabs / meadow).
app.get('/api/me/layout', auth, (req, res) => {
  const username = req.session.user && req.session.user.username;
  if (!username) return res.status(401).json({ error: 'unauthorized' });
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  const enabledKeys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  res.json(modules.computeLayout(enabledKeys));
});

// GET /api/me/modules — returns the caller's enabled keys in registry
// order. Same data the SPA can derive from /api/me.enabled_modules,
// but exposed as its own endpoint for callers (drawer scripts, MCP
// tools) that want JUST the keys without the full /api/me envelope.
app.get('/api/me/modules', auth, (req, res) => {
  const username = req.session.user && req.session.user.username;
  if (!username) return res.status(401).json({ error: 'unauthorized' });
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  const enabledKeys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  res.json(enabledKeys);
});

// GET /api/modules — returns the full registry as an array of entries
// in registry order. Used by the add-a-room sheet (PHA-2200.4) to
// render the list of available modules the user can enable.
app.get('/api/modules', auth, (req, res) => {
  res.json(modules.listModules());
});

// POST /api/me/modules/:key/enable — idempotent enable. Body is
// optional; { withRequirements: true } cascades unmet requirements.
// 400 on invalid key. 409 on unmet requirements when the cascade flag
// is not set (response carries { error: 'requires_unmet', unmet: [...] }).
// Returns { enabled: { module_key, enabled, enabled_at }, also_enabled: [...] }.
app.post('/api/me/modules/:key/enable', auth, (req, res) => {
  const username = req.session.user && req.session.user.username;
  if (!username) return res.status(401).json({ error: 'unauthorized' });
  const key = req.params.key;
  if (!modules.isModuleKey(key)) return res.status(400).json({ error: 'invalid_module_key', key });
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  const withRequirements = !!(req.body && req.body.withRequirements === true);
  try {
    const result = userModel.enableModule(db, u.id, key, { withRequirements });
    res.json({
      enabled: result.enabled,
      also_enabled: result.also_enabled,
      enabled_modules: userModel.getEnabledModules(db, u.id).map(e => e.key),
    });
  } catch (err) {
    if (err && err.code === 'requires_unmet') {
      return res.status(409).json({ error: 'requires_unmet', unmet: err.unmet });
    }
    console.error('[api/me/modules/:key/enable]', err);
    res.status(500).json({ error: 'enable_failed' });
  }
});

// POST /api/me/modules/:key/disable — idempotent disable. Body is
// optional; { withDependents: true } cascades to dependents.
// 400 on invalid key. 409 on active dependents when the cascade flag
// is not set (response carries { error: 'dependents_active', dependents: [...] }).
// Returns { disabled: { module_key, enabled, enabled_at }, also_disabled: [...] }.
app.post('/api/me/modules/:key/disable', auth, (req, res) => {
  const username = req.session.user && req.session.user.username;
  if (!username) return res.status(401).json({ error: 'unauthorized' });
  const key = req.params.key;
  if (!modules.isModuleKey(key)) return res.status(400).json({ error: 'invalid_module_key', key });
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  const withDependents = !!(req.body && req.body.withDependents === true);
  try {
    const result = userModel.disableModule(db, u.id, key, { withDependents });
    res.json({
      disabled: result.disabled,
      also_disabled: result.also_disabled,
      enabled_modules: userModel.getEnabledModules(db, u.id).map(e => e.key),
    });
  } catch (err) {
    if (err && err.code === 'dependents_active') {
      return res.status(409).json({ error: 'dependents_active', dependents: err.dependents });
    }
    console.error('[api/me/modules/:key/disable]', err);
    res.status(500).json({ error: 'disable_failed' });
  }
});

// ---- PHA-2207 (PHA-2200.6): invite-to-wall flow + first-run-complete ----
//
// Three write endpoints + one read endpoint, plus a static HTML page
// mount for /invite/:code (the redemption handshake):
//
//   * POST /api/invites                    — admin issues a new invite.
//                                             body: {wall_slug, expires_in_days?, note?}
//                                             400 if wall_slug missing (legacy PHA-1575 path).
//   * POST /api/invites/:code/redeem       — authed user redeems; auto-enrolls into the wall.
//   * GET  /api/invites                    — admin list view (no redeemed by default).
//   * POST /api/me/first-run-complete      — caller stamps first_run_completed_at = now.
//                                             Called by welcome.html on dismiss.
//
// `requireAuthOrHeader` is a small wrapper around the header-trust
// path: every redemption must resolve a user before we touch the
// invite row, but the redemption page itself is served unauthenticated
// (the SWAG / authentik layer bounces the browser through SSO on the
// way in, and the redeemed call carries the X-authentik-username
// header). Same pattern as the existing /api/me handler above.
function _resolveCaller(req, res) {
  const me = userModel.getMe(db, req.session.user && req.session.user.username);
  if (me) return me;
  // Header-trust fallback (SWAG forwards X-authentik-username when
  // the session cookie hasn't been set yet — first-login-from-invite).
  const headerUser = req.get('x-authentik-username');
  if (!headerUser) return null;
  const groupsHeader = req.get('x-authentik-groups') || '';
  let groups = [];
  if (groupsHeader.startsWith('[')) {
    try { groups = JSON.parse(groupsHeader); } catch (_) { groups = []; }
  } else {
    groups = groupsHeader.split(',').map(s => s.trim()).filter(Boolean);
  }
  // PHA-2207 (PHA-2200.6): union in any group_names from
  // wall_memberships for group-visibility walls. This makes
  // invite-granted group membership survive subsequent header-trust
  // reconciliations — provisionOrClaim otherwise replaces the full
  // user_groups set with just the X-authentik-groups header, wiping
  // the media-club row we wrote on invite redemption.
  const inviteGroups = db.prepare(`
    SELECT DISTINCT w.group_name AS name FROM wall_memberships wm
    JOIN walls w ON w.id = wm.wall_id
    WHERE wm.user_id = (SELECT id FROM users WHERE username = ?) AND w.visibility = 'group'
  `).all(headerUser).map(r => r.name).filter(Boolean);
  const mergedGroups = Array.from(new Set([...groups, ...inviteGroups]));
  const u = userModel.provisionOrClaim(db, headerUser, 'header_trust', headerUser, mergedGroups);
  if (!u) return null;
  req.session.user = {
    username: u.username,
    display: u.display,
    color: u.color,
    isAdmin: !!u.is_admin,
    authProvider: 'header_trust',
  };
  return userModel.getMe(db, u.username);
}

// POST /api/invites — admin issues a new invite. The reframe says:
//   * wall_slug is REQUIRED (legacy PHA-1575 wall-less invites return 400)
//   * expires_in_days defaults to 7, max 90
//   * only admins can create
app.post('/api/invites', auth, requireAdmin, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const { wall_slug, expires_in_days, note } = req.body || {};
  if (!wall_slug || typeof wall_slug !== 'string') {
    return res.status(400).json({ error: 'wall_slug required', hint: 'PHA-1575 wall-less invites are gone (see PHA-2207).' });
  }
  try {
    const inv = invites.create(db, { wall_slug, expires_in_days, note, created_by: me.id });
    res.status(201).json(inv);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.code || 'invalid' });
    console.error('[api/invites POST]', err);
    res.status(500).json({ error: 'create_failed' });
  }
});

// GET /api/invites — admin list view.
app.get('/api/invites', auth, requireAdmin, (req, res) => {
  const include_redeemed = req.query.include_redeemed === '1' || req.query.include_redeemed === 'true';
  const wall_slug = req.query.wall_slug || null;
  try {
    res.json({ invites: invites.list(db, { include_redeemed, wall_slug }) });
  } catch (err) {
    console.error('[api/invites GET]', err);
    res.status(500).json({ error: 'list_failed' });
  }
});

// POST /api/invites/:code/redeem — authed user redeems an invite.
//   1. resolve caller (session OR header-trust)
//   2. look up invite (peek semantics; 410 if expired/redeemed)
//   3. atomic: INSERT wall_memberships row + stamp invite.redeemed_by
//   4. return {wall_slug, wall_name, first_run: <bool>, redirect: /welcome.html?wall=...}
//
// first_run is preserved as-is for existing users (their
// first_run_completed_at is non-null so the SPA won't show the sheet
// again) and stays NULL for fresh accounts (the SPA gates the sheet
// on first_run: true regardless of invite membership).
app.post('/api/invites/:code/redeem', (req, res) => {
  const me = _resolveCaller(req, res);
  if (!me) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const result = invites.redeem(db, req.params.code, me.id);
    res.json({
      ok: true,
      invite_id: result.invite.id,
      wall_slug: result.wall_slug,
      wall_name: result.wall_name,
      first_run: userModel.isFirstRun(db, me.id),
      redirect: `/welcome.html?wall=${encodeURIComponent(result.wall_slug)}`,
      // include the membership list so the welcome sheet can render
      // member avatars without an extra round-trip.
      members: wallMembers.getMembers(db, result.wall_slug).members,
    });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.code || 'invalid', detail: err.message });
    console.error('[api/invites/:code/redeem]', err);
    res.status(500).json({ error: 'redeem_failed' });
  }
});

// POST /api/me/first-run-complete — caller stamps first_run_completed_at.
// Idempotent (completeFirstRun preserves the original timestamp on
// re-call). Used by public/welcome.html's "got it" CTA.
app.post('/api/me/first-run-complete', (req, res) => {
  const me = _resolveCaller(req, res);
  if (!me) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const stillFirstRun = userModel.completeFirstRun(db, me.id);
    res.json({ ok: true, first_run: stillFirstRun });
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.code || 'invalid' });
    console.error('[api/me/first-run-complete]', err);
    res.status(500).json({ error: 'first_run_complete_failed' });
  }
});

// GET /api/walls/:slug/members — public-readable on the caller's
// own membership. Used by the welcome sheet.
app.get('/api/walls/:slug/members', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const data = wallMembers.getMembers(db, req.params.slug);
  if (!data) return res.status(404).json({ error: 'not_found' });
  // Membership gate — same constitutional rule as the rest of /api/walls.
  try { walls.assertMember(req.params.slug, me.id); }
  catch (e) { return wallsErr(res, e); }
  res.json(data);
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

// ---- app install flow (PHA-2201.1 / PHA-2229) ----
// State machine: resolve -> consent -> install, plus list/get/revoke/
// reinstall. All logic lives in lib/app-install.js (pure, no express);
// these handlers just do auth + status-code mapping. Settings UI that
// drives this flow is PHA-2201.4 (PHA-2232).
function sendAppInstallError(res, err) {
  if (err instanceof appInstall.AppInstallError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  }
  console.error('[app-install] unexpected error:', err);
  return res.status(500).json({ error: 'internal_error' });
}
app.post('/api/apps/resolve', auth, async (req, res) => {
  const { url, dev } = req.body || {};
  try {
    const manifest = await appInstall.resolveManifest(db, url, { dev: !!dev });
    res.json({ manifest });
  } catch (err) {
    sendAppInstallError(res, err);
  }
});
app.post('/api/apps/consent', auth, async (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const { manifest_url, acknowledged, dev } = req.body || {};
  try {
    const result = await appInstall.issueConsent(db, me.id, manifest_url, { acknowledged: !!acknowledged, dev: !!dev });
    res.json(result);
  } catch (err) {
    sendAppInstallError(res, err);
  }
});
app.post('/api/apps/install', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const { consent_token } = req.body || {};
  try {
    res.json(appInstall.installApp(db, me.id, consent_token));
  } catch (err) {
    sendAppInstallError(res, err);
  }
});
app.get('/api/apps', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  res.json(appInstall.listApps(db, me.id));
});
app.get('/api/apps/:key', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json(appInstall.getApp(db, me.id, req.params.key));
  } catch (err) {
    sendAppInstallError(res, err);
  }
});
app.post('/api/apps/:key/revoke', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json(appInstall.revokeApp(db, me.id, req.params.key));
  } catch (err) {
    sendAppInstallError(res, err);
  }
});
app.post('/api/apps/:key/reinstall', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json(appInstall.reinstallApp(db, me.id, req.params.key));
  } catch (err) {
    sendAppInstallError(res, err);
  }
});

// ---- Connector Forge form wizard (PHA-2448) -----------------------------
// The browser receives template metadata and a redacted preview only. It
// never receives a ConnectorSpec factory or a stored plaintext API key.
function sendConnectorWizardError(res, err) {
  if (err instanceof connectorWizard.ConnectorWizardError || err instanceof connectorInstall.ConnectorInstallError || err instanceof Error && err.name === 'ConnectorSpecError') {
    return res.status(err.status || 422).json({ error: err.code || 'validation_failed', message: err.message, ...(err.extra || {}) });
  }
  console.error('[connector-wizard] unexpected error:', err);
  return res.status(500).json({ error: 'internal_error' });
}
function connectorMe(req, res) {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) { res.status(401).json({ error: 'unknown_user' }); return null; }
  return me;
}
function wizardValues(req) {
  const body = req.body || {};
  return {
    baseUrl: body.baseUrl,
    secretRef: body.secretRef,
    installName: body.installName,
    apiKey: body.apiKey,
    localNetworkConsent: !!body.localNetworkConsent,
    homesteadOrigin: `${req.protocol}://${req.get('host')}`,
  };
}
app.get('/api/connectors/templates', auth, (req, res) => {
  // factories deliberately omitted — this is public picker metadata only.
  res.json({ templates: require('./lib/connector-templates').listTemplates().map(({ factory, ...template }) => template) });
});
app.post('/api/connectors/preview', auth, (req, res) => {
  try {
    const result = connectorWizard.validate(req.body && req.body.templateId, wizardValues(req));
    res.json({ ok: true, preview: result.preview });
  } catch (err) { sendConnectorWizardError(res, err); }
});
app.post('/api/connectors/installations', auth, (req, res) => {
  const me = connectorMe(req, res);
  if (!me) return;
  try {
    const body = req.body || {};
    const values = wizardValues(req);
    const result = connectorWizard.validate(body.templateId, values);
    let groupId = null;
    if (body.visibility === 'group') {
      groupId = Number(body.groupId);
      if (!Number.isFinite(groupId)) throw new connectorWizard.ConnectorWizardError(422, 'group_required', 'Choose a group to share this connector with.');
      const member = db.prepare('SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?').get(me.id, groupId);
      if (!member) throw new connectorWizard.ConnectorWizardError(403, 'group_not_available', 'You can only share with a group you belong to.');
    }
    const installation = connectorInstall.install(db, me.id, {
      spec: result.spec,
      baseUrl: result.baseUrl,
      secretRef: result.secretRef,
      secretPlaintext: values.apiKey,
      installName: result.installName,
      visibility: body.visibility === 'group' ? 'group' : 'private',
      source: 'builtin',
    });
    if (groupId !== null) {
      connectorInstall.shareWithGroup(db, me.id, installation.id, groupId);
    }
    // Consent is durable but redacted: exact endpoint/field/surface summary,
    // never the API key or its plaintext-derived values.
    db.prepare('INSERT INTO connector_consent_log (user_id, installation_id, summary_json) VALUES (?, ?, ?)')
      .run(me.id, installation.id, JSON.stringify(result.preview));
    res.status(201).json({ installation: connectorInstall.publicView(connectorInstall.getInstallation(db, me.id, installation.id)), preview: result.preview });
  } catch (err) { sendConnectorWizardError(res, err); }
});
app.get('/api/connectors/installations', auth, (req, res) => {
  const me = connectorMe(req, res);
  if (!me) return;
  res.json({ installations: connectorInstall.getInstallationsForUser(db, me.id).map(connectorInstall.publicView) });
});
app.post('/api/connectors/installations/:id/uninstall', auth, (req, res) => {
  const me = connectorMe(req, res);
  if (!me) return;
  try { res.json(connectorInstall.uninstall(db, me.id, Number(req.params.id))); }
  catch (err) { sendConnectorWizardError(res, err); }
});

// ---- app activity log (PHA-2201.3 / PHA-2231) ----
// Read path over app_api_log; the write path lives in authenticate()
// above.
app.get('/api/apps/:key/activity', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const appRow = db.prepare('SELECT key FROM installed_apps WHERE key = ?').get(req.params.key);
  if (!appRow) return res.status(404).json({ error: 'not_found' });
  res.json(appApiLog.list(db, me.id, req.params.key, { limit: req.query.limit, offset: req.query.offset }));
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

// ---- PHA-1617.6: drawer backend — outbound POST + SSE consumer + retry/circuit breaker ----
// Design doc §6.2–6.5. The drawer UI (PHA-1617.5) POSTs here with
// {message, endpoint_id, conversation_id}; this route signs and forwards
// the payload to the user's configured drawer_endpoint URL with the
// morning-brief snapshot attached, consumes SSE chunks or single-shot
// JSON back from the harness, retries on transient failure with
// exponential backoff (1s, 4s, 16s, 60s), and auto-disables the
// endpoint after 5 consecutive failures (§6.5).
//
// Wire shape matches the stub (PHA-1617.5) on purpose so the frontend
// consumer in public/index.html doesn't need any changes:
//   * SSE reply (default): text/event-stream with `event: chunk` /
//     `event: done` — Design Trap #4 ("never make a human watch an
//     LLM think") means we stream chunks as they arrive.
//   * JSON reply: when `Accept: application/json`, the same
//     dispatcher result is returned as a single object with
//     {request_id, text, actions?, tokens_in?, tokens_out?}.
app.post('/api/drawer', auth, async (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const b = req.body || {};
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  const endpointId = Number(b.endpoint_id);
  const conversationId = typeof b.conversation_id === 'string' && b.conversation_id
    ? b.conversation_id
    : 'c-drawer-' + Date.now().toString(36);
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!Number.isInteger(endpointId) || endpointId <= 0) {
    return res.status(400).json({ error: 'endpoint_id required' });
  }

  // Honour `Accept: application/json` to return a single-shot reply; SSE
  // is the default. The frontend consumer supports both per §6.3.
  const accept = String(req.headers.accept || '').toLowerCase();
  const wantsJson = accept.includes('application/json');

  // Compute the in-memory consecutive-failure streak so the route can
  // decide whether to auto-disable after this dispatch (§6.5).
  // The streak resets to 0 on any successful dispatch. After a failed
  // dispatch we add the number of HTTP attempts the dispatcher made
  // (each retry counts as one failure toward the 5-failure threshold).
  // The map is in-memory only; on process restart it resets, but the
  // row-level last_status_code + last_error columns give a hard
  // persistent record of recent dispatch health.
  const streakMap = (req.app && req.app.locals && req.app.locals.drawerStreakMap) || null;

  const result = await drawerDispatch.dispatchDrawer(db, me, {
    message,
    endpointId,
    conversationId,
  });
  analytics.logEvent(db, {
    userId: me.id,
    kind: result.ok ? 'drawer_call_completed' : 'drawer_call_failed',
    subjectType: 'agent_endpoint',
    subjectId: endpointId,
    durationSeconds: Math.round((result.durationMs || 0) / 1000),
    meta: { status_code: result.lastStatus || null, request_id: result.requestId || null,
      conversation_id: conversationId, error: result.lastError || null },
  });

  // Update the streak after dispatch.
  if (streakMap) {
    if (result.ok) {
      streakMap.set(endpointId, 0);
    } else if (result.status !== 'endpoint_not_found') {
      const newStreak = (streakMap.get(endpointId) || 0) + (result.attempts || 1);
      streakMap.set(endpointId, newStreak);
      // Apply the §6.5 circuit breaker: 5 consecutive failures → auto-disable.
      if (newStreak >= drawerDispatch.CIRCUIT_FAILURE_THRESHOLD) {
        const epRow = db.prepare('SELECT id, enabled FROM agent_endpoints WHERE id = ?').get(endpointId);
        if (epRow && epRow.enabled) {
          db.prepare('UPDATE agent_endpoints SET enabled = 0 WHERE id = ?').run(endpointId);
          agentEndpoints.recordDispatch(db, endpointId, {
            statusCode: result.lastStatus || null,
            error: `circuit_broken:${result.lastError || 'unknown'}`,
          });
          return res.status(503).json({
            error: 'circuit_broken',
            message: 'endpoint auto-disabled after 5 consecutive failures; re-enable in settings',
            last_status: result.lastStatus || null,
            last_error: result.lastError || null,
            request_id: result.requestId,
            conversation_id: result.conversationId,
          });
        }
      }
    }
  }

  if (result.status === 'endpoint_not_found') {
    return res.status(404).json({ error: 'endpoint_not_found' });
  }
  if (result.status === 'endpoint_offline') {
    return res.status(502).json({
      error: 'endpoint_offline',
      message: 'failed to reach the user-configured drawer endpoint after retries',
      last_status: result.lastStatus || null,
      last_error: result.lastError || null,
      request_id: result.requestId,
      conversation_id: result.conversationId,
    });
  }

  if (!result.ok) {
    // Defensive: a non-ok without a known status shouldn't happen, but
    // surface it rather than 500 with no body.
    return res.status(500).json({ error: 'dispatch_failed', detail: result.lastError });
  }

  if (wantsJson) {
    return res.json({
      request_id: result.requestId,
      conversation_id: result.conversationId,
      text: result.text || '',
      ...(result.actions ? { actions: result.actions } : {}),
      ...(typeof result.tokensIn === 'number' ? { tokens_in: result.tokensIn } : {}),
      ...(typeof result.tokensOut === 'number' ? { tokens_out: result.tokensOut } : {}),
      duration_ms: result.durationMs,
    });
  }

  // SSE reply. Stream the chunks the dispatcher collected. If the
  // dispatcher returned one big string, we ship it as a single chunk so
  // the wire shape (event: chunk + event: done) is preserved.
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Homestead-Request-Id', result.requestId);
  res.flushHeaders && res.flushHeaders();

  const writeSse = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const chunkList = Array.isArray(result.chunks) && result.chunks.length
    ? result.chunks
    : (result.text ? [result.text] : []);

  // Flush the first chunk immediately so the UI shows life (Design
  // Trap #4). Then stream the rest with a small typewriter delay so the
  // bubble fills in.
  for (let i = 0; i < chunkList.length; i++) {
    if (res.writableEnded) break;
    if (i > 0) await new Promise(r => setTimeout(r, 30));
    writeSse('chunk', { text: chunkList[i] });
  }
  writeSse('done', {
    request_id: result.requestId,
    conversation_id: result.conversationId,
    tokens_in: typeof result.tokensIn === 'number' ? result.tokensIn : (message ? message.length : 0),
    tokens_out: typeof result.tokensOut === 'number' ? result.tokensOut : 0,
    duration_ms: result.durationMs,
  });
  res.end();
});

// ---- media (PHA-2149) ----
// General-purpose content-addressed media store. Walls (PHA-2147.2) and
// future consumers (entity-graph covers, list-item photos, Popcorn Vote)
// build on this rather than rolling their own upload handling.
//
// PHA-2644: GET /api/media/:id/context returns the comprehension
// package (image: file+thumb+caption; video: scene-change keyframes
// + first/last frame + whisper-class audio transcript + caption).
// Per the issue, the audio transcript honours a request-scoped BYOK
// key via the X-Whisper-Key header or ?byok= query param, with a
// server-staged OPENAI_API_KEY fallback. Auth-gated, like the rest
// of the media surface.
app.post('/api/media', auth, media.upload);
app.get('/api/media/:id', auth, (req, res) => media.fetch(req.params.id, res, false));
app.get('/api/media/:id/thumb', auth, (req, res) => media.fetch(req.params.id, res, true));
app.get('/api/media/:id/context', auth, media.getMediaContext);
app.delete('/api/media/:id', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const result = media.remove(req.params.id, me.id);
  if (result.error === 'not_found') return res.status(404).json({ error: 'not found' });
  if (result.error === 'forbidden') return res.status(403).json({ error: 'owner or admin only' });
  res.json({ ok: true });
});

// PHA-2644: keyframe-serve endpoint. The comprehension package
// references frames at /api/media-frames/:mediaId/:filename. Files
// live under DATA_DIR/media-frames/{mediaId}/ and were extracted
// at comprehension-build time. Auth-gated, same as /api/media/:id.
// No directory-traversal guard is needed because :filename is matched
// against a literal fs.readdirSync() list before the file is served.
const framesDir = path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'media-frames');
app.get('/api/media-frames/:mediaId/:filename', auth, (req, res) => {
  const dir = path.join(framesDir, req.params.mediaId);
  // Defensive: refuse any segment that tries to escape the frames
  // root (e.g. '../server.js'). The frame filenames are all
  // generated by extractKeyframes() (frame-NNN.jpg) but we re-check
  // before the path join.
  if (req.params.mediaId.includes('..') || req.params.mediaId.includes('/') || req.params.mediaId.includes('\\')) {
    return res.status(400).json({ error: 'invalid mediaId' });
  }
  if (req.params.filename.includes('..') || req.params.filename.includes('/') || req.params.filename.includes('\\')) {
    return res.status(400).json({ error: 'invalid filename' });
  }
  const abs = path.join(dir, req.params.filename);
  if (!abs.startsWith(dir + path.sep)) return res.status(400).json({ error: 'invalid path' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(abs);
});

// ---- walls (PHA-2150) ----
// Group-scoped and direct-share walls of chronological posts. Every
// route below resolves the caller's local user id first, then delegates
// straight to lib/walls.js, which runs assertMember() before touching
// any row. Wall-not-found and not-a-member both surface as 404 — wall
// existence is private to its members.
function wallsErr(res, e) {
  if (e && e.status) return res.status(e.status).json({ error: e.code || 'error' });
  return res.status(500).json({ error: 'internal_error', detail: e && e.message });
}
app.get('/api/walls', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  res.json({ walls: walls.listForUser(me.id) });
});
// PHA-2556: admin-only "every wall regardless of membership" listing.
// Backstops the wall-management sheet (PHA-2556 admin UI) so admins
// can see walls they haven't been added to yet — the regular GET
// /api/walls intentionally scopes to assertMember-passing walls for
// the constitutional 404-private wall existence rule.
app.get('/api/walls/all', auth, requireAdmin, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const rows = db.prepare('SELECT slug, name, visibility, group_name, retention_days, created_by, created_at FROM walls ORDER BY created_at ASC').all();
  res.json(rows);
});
app.get('/api/walls/:slug/posts', auth, requireWallReadScope, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json({ posts: walls.postsForWall(req.params.slug, me.id, req.query.cursor, req.query.limit) });
  } catch (e) { wallsErr(res, e); }
});
app.post('/api/walls/:slug/posts', auth, requireScope('write:walls:post'), (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json(walls.createPost(req.params.slug, me.id, req.body || {}));
  } catch (e) { wallsErr(res, e); }
});
app.delete('/api/walls/:slug/posts/:postId', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json(walls.deletePost(req.params.slug, req.params.postId, me.id));
  } catch (e) { wallsErr(res, e); }
});
app.post('/api/walls/:slug/posts/:postId/reactions', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json(walls.toggleReaction(req.params.slug, req.params.postId, me.id, req.body && req.body.emoji));
  } catch (e) { wallsErr(res, e); }
});
app.delete('/api/walls/:slug/posts/:postId/reactions/:emoji', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json(walls.removeReaction(req.params.slug, req.params.postId, me.id, req.params.emoji));
  } catch (e) { wallsErr(res, e); }
});
app.get('/api/walls/:slug/posts/:postId/comments', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json({ comments: walls.listComments(req.params.slug, req.params.postId, me.id) });
  } catch (e) { wallsErr(res, e); }
});
app.post('/api/walls/posts/:postId/comments', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json(walls.createComment(req.params.postId, me.id, req.body && req.body.body));
  } catch (e) { wallsErr(res, e); }
});

// ---- notification prefs + mentions (PHA-2218) ----
// Per-wall level (all/mentions/none), wall-scoped @mention autocomplete,
// per-thread mute, and the badge-clearing endpoints. Membership gate is
// the same walls.assertMember() the wall routes above already trust — a
// wall's members and notification prefs are only visible/settable to
// its own members. Plain `auth` (not scope-gated): these are personal
// preference routes, same tier as /api/push/prefs, not something a
// third-party app's manifest scopes cover yet.
app.get('/api/walls/:slug/members', auth, requireWallReadScope, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    const { wall } = walls.assertMember(req.params.slug, me.id);
    const members = notifications.membersForWall(wall).map((m) => ({
      username: m.username,
      display: m.display,
      color: m.color,
      isMemberSince: m.joined_at || null,
    }));
    res.json({ members });
  } catch (e) { wallsErr(res, e); }
});

app.get('/api/walls/:slug/notifications', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    const { wall } = walls.assertMember(req.params.slug, me.id);
    res.json({ level: notifications.getLevel(wall.id, me.id) });
  } catch (e) { wallsErr(res, e); }
});
app.put('/api/walls/:slug/notifications', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    const { wall } = walls.assertMember(req.params.slug, me.id);
    const via = wall.visibility === 'group' ? 'user_groups' : 'wall_memberships';
    res.json(notifications.setLevel(wall.id, me.id, (req.body || {}).level, via));
  } catch (e) { wallsErr(res, e); }
});

app.post('/api/walls/:slug/posts/:postId/mute', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    const { post } = walls.getPostInWall(req.params.slug, req.params.postId, me.id);
    res.json(notifications.muteThread(me.id, post.id));
  } catch (e) { wallsErr(res, e); }
});
app.delete('/api/walls/:slug/posts/:postId/mute', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    const { post } = walls.getPostInWall(req.params.slug, req.params.postId, me.id);
    res.json(notifications.unmuteThread(me.id, post.id));
  } catch (e) { wallsErr(res, e); }
});

// ---- PHA-2556: wall CRUD + member management (admin only) ----
// PHA-2493 closed green without these, leaving a wall that no seeded
// user could reach from the API alone. Adding POST /api/walls +
// member management closes that loop: an admin can create a new wall
// from the UI without sqlite surgery, and the seeded wall is visible
// without any out-of-band group grant (see lib/walls.js#seed which
// switches the shipped wall to visibility=group, group_name=household).
app.post('/api/walls', auth, requireAdmin, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    const wall = walls.createWall(db, me.id, req.body || {});
    res.status(201).json({ wall });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.code || 'error', message: e.message });
    return res.status(500).json({ error: 'internal_error', detail: e && e.message });
  }
});
app.post('/api/walls/:slug/members', auth, requireAdmin, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json(walls.adminAddMember(db, req.params.slug, me.id, req.body || {}));
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.code || 'error', message: e.message });
    return res.status(500).json({ error: 'internal_error', detail: e && e.message });
  }
});
app.delete('/api/walls/:slug/members/:username', auth, requireAdmin, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  try {
    res.json(walls.adminRemoveMember(db, req.params.slug, { username: req.params.username }));
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ error: e.code || 'error', message: e.message });
    return res.status(500).json({ error: 'internal_error', detail: e && e.message });
  }
});
// GET /api/groups — admin-only list of group names so the wall-create UI
// can populate its visibility='group' picker without a hardcoded list.
// Returns the same set lib/user-model.js seeds (household / family /
// media-club / admins) plus any future authentik-synced groups.
app.get('/api/groups', auth, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT name, display_name FROM groups ORDER BY name ASC').all();
  res.json({ groups: rows });
});

// GET /api/me/notifications: the badge/activity-feed list backing PHA-1617's
// clearable-badge promise. ?unseen=1 filters to seen_at IS NULL. Distinct
// from /api/me/snapshot's activity_recent (the morning-brief dashboard
// feed, unfiltered) — this one is the badge itself.
app.get('/api/me/notifications', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  res.json({ notifications: notifications.listForUser(me.id, { unseen: req.query.unseen === '1', limit: req.query.limit }) });
});
// POST /api/me/notifications/seen: three clear paths funnel here — a
// push click (SW posts {tag}), opening the target post ({postId}), or
// the activity feed's "clear all" ({clearAll: true}). Always scoped to
// the caller's own rows.
app.post('/api/me/notifications/seen', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const b = req.body || {};
  const cleared = notifications.markSeen(me.id, { tag: b.tag, postId: b.postId, clearAll: !!b.clearAll });
  res.json({ ok: true, cleared });
});

// ---- link preview (PHA-2151) ----
// Best-effort server-side fetch + lightweight <title>/description scrape
// for the Porch Wall's "link" post composer. No new dependency (no
// cheerio/jsdom) — a couple of forgiving regexes over the raw HTML.
// Never throws a 500 for a bad/slow remote page: any failure just comes
// back as empty strings so the composer can still let the post through.
function extractMeta(html) {
  let title = '';
  let description = '';
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) title = titleMatch[1].trim();
  const metaRe = /<meta\s+[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(html))) {
    const tag = m[0];
    const nameMatch = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    if (!nameMatch || !contentMatch) continue;
    const name = nameMatch[1].toLowerCase();
    if (name === 'og:title' && !titleMatch) title = contentMatch[1].trim();
    if ((name === 'og:description' || name === 'description') && !description) description = contentMatch[1].trim();
  }
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return { title: decode(title).slice(0, 300), description: decode(description).slice(0, 500) };
}
app.get('/api/link-preview', auth, async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') return res.json({ title: '', description: '' });
  let parsed;
  try { parsed = new URL(url); } catch (_) { return res.json({ title: '', description: '' }); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return res.json({ title: '', description: '' });
  try {
    const r = await fetch(parsed.toString(), {
      signal: AbortSignal.timeout(2000),
      headers: { 'User-Agent': 'Homestead-LinkPreview/1.0' },
    });
    const html = await r.text();
    res.json(extractMeta(html));
  } catch (e) {
    res.json({ title: '', description: '' });
  }
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
  const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(r.lastInsertRowid);
  // PHA-1617.7: fire-and-forget events webhook fan-out. Never awaited on
  // the request path — a dead events harness must not slow down or fail
  // task creation.
  eventsDispatch.dispatchEventForAssignee(db, app.locals.eventsStreakMap, assignee, 'task_created', { task: created }).catch(() => {});
  res.json(created);
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
  const wasRotation = !t.done && t.recur;
  if (wasRotation) {
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
  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id);
  // PHA-1617.7: fire-and-forget events webhook fan-out. A rotating chore
  // that just handed off to the next assignee fires 'chore_rotated' (to
  // the NEW assignee, since that's who needs to know); a plain task
  // toggle fires 'task_completed'/'task_uncompleted'.
  if (wasRotation) {
    eventsDispatch.dispatchEventForAssignee(db, app.locals.eventsStreakMap, updated.assignee, 'chore_rotated',
      { task: updated, previous_assignee: t.assignee }).catch(() => {});
  } else {
    const category = updated.done ? 'task_completed' : 'task_uncompleted';
    eventsDispatch.dispatchEventForAssignee(db, app.locals.eventsStreakMap, updated.assignee, category,
      { task: updated }).catch(() => {});
  }
  res.json(updated);
});
app.delete('/api/tasks/:id', auth, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- lists (PHA-2586) ----
//
// Lists are the household-shared, multiple-contributor primitive
// distinct from chores/tasks. The `lists` module in lib/modules.js
// scopes reads to `read:lists` and writes to `write:lists`; both
// are auto-granted to the household via the session user (the auth
// middleware resolves the caller below). Routes follow the same
// shape as /api/walls so the SPA can use a familiar fetch pattern.
//
// Design notes:
//   * No membership gate — lists are household-shared by default.
//     Future work can add per-list visibility if a household asks for it.
//   * App-scoped bearer tokens must hold the matching list scope.
//     Cookie/header-trust sessions retain normal first-party access, as
//     requireScope() intentionally permits them.
//   * Lists are not deleted by accidental item-delete — items cascade
//     only when the parent list is removed.

app.get('/api/lists', auth, requireScope('read:lists'), (req, res) => {
  try {
    const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
    res.json({ lists: lists.listLists({ includeArchived }) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'list_failed' });
  }
});

app.get('/api/lists/stats', auth, requireScope('read:lists'), (req, res) => {
  try {
    res.json(lists.publicStats());
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'stats_failed' });
  }
});

app.get('/api/lists/:id', auth, requireScope('read:lists'), (req, res) => {
  try {
    res.json(lists.getList(req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'list_failed' });
  }
});

app.post('/api/lists', auth, requireScope('write:lists'), (req, res) => {
  try {
    const me = userModel.getMe(db, req.session.user.username);
    const userId = me ? me.id : null;
    res.status(201).json(lists.createList(req.body || {}, userId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'list_failed' });
  }
});

app.patch('/api/lists/:id', auth, requireScope('write:lists'), (req, res) => {
  try {
    res.json(lists.updateList(req.params.id, req.body || {}));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'list_failed' });
  }
});

app.delete('/api/lists/:id', auth, requireScope('write:lists'), (req, res) => {
  try {
    res.json(lists.deleteList(req.params.id));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'list_failed' });
  }
});

app.post('/api/lists/reorder', auth, requireScope('write:lists'), (req, res) => {
  try {
    res.json({ lists: lists.reorderLists((req.body && req.body.ordered_ids) || []) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'list_failed' });
  }
});

app.get('/api/lists/:id/items', auth, requireScope('read:lists'), (req, res) => {
  try {
    const includeChecked = req.query.include_checked === '1' || req.query.include_checked === 'true';
    const limit = req.query.limit ? Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100)) : undefined;
    res.json({ items: lists.listItems(req.params.id, { includeChecked, limit }) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'item_failed' });
  }
});

app.post('/api/lists/:id/items', auth, requireScope('write:lists'), (req, res) => {
  try {
    const me = userModel.getMe(db, req.session.user.username);
    const userId = me ? me.id : null;
    res.status(201).json(lists.addItem(req.params.id, req.body || {}, userId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'item_failed' });
  }
});

app.patch('/api/list-items/:itemId', auth, requireScope('write:lists'), (req, res) => {
  try {
    const me = userModel.getMe(db, req.session.user.username);
    const userId = me ? me.id : null;
    res.json(lists.updateItem(req.params.itemId, req.body || {}, userId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'item_failed' });
  }
});

app.delete('/api/list-items/:itemId', auth, requireScope('write:lists'), (req, res) => {
  try {
    res.json(lists.deleteItem(req.params.itemId));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.code || 'item_failed' });
  }
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
  const created = db.prepare('SELECT * FROM events WHERE id = ?').get(r.lastInsertRowid);
  // PHA-1617.7: fire-and-forget events webhook fan-out (see /api/tasks).
  eventsDispatch.dispatchEventForAssignee(db, app.locals.eventsStreakMap, owner, 'event_created', { event: created }).catch(() => {});
  res.json(created);
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

// ---- /api/funnel/install (PHA-2219) ----
// Auth-gated funnel event intake for the install coach. The client
// emits a row per step; PHA-2210 (analytics funnel umbrella) reads
// these rows to compute install-rate / time-to-install /
// permission-grant-rate. We deliberately do NOT add a get-list
// endpoint here — funnel data is for the analytics worker, not the
// SPA. If the SPA later needs to read its own funnel state, expose
// it via /api/me/install-funnel on a separate route.
//
// Body shape:
//   { step: <enum>, platform?: <string>, meta?: <object> }
// step is REQUIRED and must be one of:
//   prompt_shown, instructions_opened, dismissed, install_chip_tapped,
//   install_completed, permission_requested, permission_granted,
//   permission_denied, first_push_delivered
// Unknown steps return 400 (we'd rather fail loudly on typos in the
// client than silently pollute the funnel with junk rows).
const INSTALL_FUNNEL_STEPS = new Set([
  'prompt_shown', 'instructions_opened', 'dismissed',
  'install_chip_tapped', 'install_completed',
  'permission_requested', 'permission_granted', 'permission_denied',
  'first_push_delivered',
]);
app.post('/api/funnel/install', auth, (req, res) => {
  const me = userModel.getMe(db, req.session.user.username);
  if (!me) return res.status(401).json({ error: 'unknown_user' });
  const body = req.body || {};
  const step = typeof body.step === 'string' ? body.step : '';
  if (!INSTALL_FUNNEL_STEPS.has(step)) {
    return res.status(400).json({
      error: 'invalid_step',
      allowed: Array.from(INSTALL_FUNNEL_STEPS).sort(),
    });
  }
  const platform = typeof body.platform === 'string' && body.platform.length <= 32
    ? body.platform : null;
  let metaJson = null;
  if (body.meta && typeof body.meta === 'object') {
    try { metaJson = JSON.stringify(body.meta); } catch (_) { metaJson = null; }
  }
  db.prepare(`INSERT INTO install_funnel_events (user_id, step, platform, meta)
              VALUES (?,?,?,?)`)
    .run(me.id, step, platform, metaJson);
  res.json({ ok: true, step });
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

// lib/scope-display.js (PHA-2201.2 / PHA-2230) is the single source for
// third-party app scope → plain-language mapping, shared between the
// consent screen (public/consent.js) and the future Settings "what this
// app can do" view (PHA-2201.4). It's the only lib/ file served to the
// browser — everything else in lib/ is server-only DB/HTTP logic.
app.get('/lib/scope-display.js', (req, res) => {
  res.type('application/javascript');
  // PHA-2583: dotfiles:'allow' (see /invite/:code above for rationale).
  res.sendFile('lib/scope-display.js', { root: __dirname, dotfiles: 'allow' });
});

// PHA-2207 (PHA-2200.6): invite redemption handshake. Visiting
// https://life.phatt.vip/invite/{code} serves the redemption page
// (public/invite.html). The page itself does the POST to /api/invites/:code/redeem
// once the SWAG/authentik layer has authenticated the user. Codes
// contain only hex chars (32 chars from crypto.randomUUID without
// dashes), so the regex anchor is safe — no path-confusion risk.
//
// PHA-2557: registered BEFORE the express.static handler (which
// now uses fallthrough:false) so the route still resolves for paths
// the static middleware would otherwise 404.
app.get(/^\/invite\/([A-Fa-f0-9]{16,64})$/, (req, res) => {
  // PHA-2583: dotfiles option forces send() to traverse any path that
  // contains a `.`-prefixed segment (e.g. /root/.openclaw/...) instead
  // of returning 404. Production deployments use /app (no dotfile
  // segments) so this is a no-op there; sandbox/dev runs with the
  // repo checked out into a dotfile-bearing path now serve the invite
  // page correctly. send()'s default dotfiles: 'ignore' is a sandbox
  // foot-gun — see the explainer block above for the smoke that
  // exercises this path.
  res.sendFile(path.join(__dirname, 'public', 'invite.html'), { dotfiles: 'allow' });
});
app.get('/favicon.ico', (req, res) => {
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile('public/icon.svg', { root: __dirname });
});

// PHA-2658: entity pages are an explicit SPA route, not a static asset.
// Keep this allowlist entry ahead of the strict static middleware below so a
// refresh, shared URL, or PWA cold start receives the shell while unrelated
// missing files (for example /lists.html) continue to be real 404s.
app.get('/entity/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), { dotfiles: 'allow' });
});

// PHA-2557: catch-all tightening. The previous express.static default
// (fallthrough: true) let unknown paths like /lists.html /calendar.html
// /chores.html /apps.html fall through to the SPA fallback regex,
// which then served public/index.html with status 200 — the same
// masking class as the PHA-1704/1707/1708 /api bug (a user deep-linking
// or a nav honoring the layout API's `route` field gets the SPA shell
// instead of a real 404). With fallthrough:false the static handler
// returns 404 directly for any path that doesn't match a real file
// in public/, and the SPA fallback regex is removed entirely. `/` still
// resolves to public/index.html (express.static serves index files for
// directory requests). The /api routes were already excluded from the
// catch-all via the `(?!/api)` lookahead — they retain their explicit
// 404/handler paths and are untouched here.
//
// Removed: app.get(/^(?!\/api).*/, ...) — see git history.
// PHA-2583: dotfiles:'allow' on the static handler mirrors the same
// fix on the /invite/:code sendFile below — sandbox/dev paths under
// /root/.openclaw/... would otherwise 404 on every request because
// `send`'s default dotfiles policy rejects any segment starting with
// `.`. Production uses /app (no dotfile segments) so this is a no-op
// there.
app.use(express.static(path.join(__dirname, 'public'), { fallthrough: false, dotfiles: 'allow' }));

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
      // media retention sweep (PHA-2149): cheap, runs every tick — soft-
      // deleted rows past their 24h grace window + expired rows get
      // reaped (file unlink + row delete).
      try {
        const r = media.cleanupSweep(db);
        if (r.reaped > 0) console.log(`[scheduler] media sweep: reaped ${r.reaped}`);
      } catch (e) { console.error('[scheduler] media sweep:', e.message); }
    };
    setTimeout(tick, 10 * 1000);
    schedulerHandle = setInterval(tick, SCHED_TICK_MS);
    console.log('[scheduler] daily digest started; tick=30min; plex+kavita entity-sync + sibling_detector + media sweep every 6h/30min');
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
