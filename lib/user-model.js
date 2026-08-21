// Homestead user-model data layer (PHA-1618, v0.0.5; PHA-2202, v0.3.0).
//
// Pure DB logic — no HTTP, no express. Imported by:
//   * server.js (runs `migrate(db)` at boot, then `provisionOrClaim` /
//     `reconcileGroups` from the auth middleware)
//   * scripts/test-user-model.js (acceptance tests)
//
// Contract:
//   * `users` is a PROFILE CACHE keyed on `username` (UNIQUE COLLATE
//     NOCASE so 'Brandon' and 'brandon' resolve to the same row at the
//     SQLite layer).
//   * `groups` is a string cache of group names. Authentik owns the
//     lifecycle; Homestead reconciles `user_groups` from the
//     `X-authentik-groups` header on every authenticated request.
//   * CLAIM-first provisioning: a seeded profile (admin / brandon /
//     emily) is the canonical row for its username. The first request
//     carrying `X-authentik-username: brandon` attaches the auth
//     provider identity to that row instead of creating a duplicate.

'use strict';

const bcrypt = require('bcryptjs');

const USER_COLORS = ['#8a9ec4', '#c48a9e', '#9eb48a', '#d4a85c', '#a87cc4', '#7c9eb8', '#c47c7c', '#7cc4a8'];

function validateUsername(u) {
  const clean = (u || '').toLowerCase().trim();
  if (!/^[a-z0-9_-]{2,32}$/.test(clean)) return null;
  return clean;
}

function nextColor(db) {
  const idx = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  return USER_COLORS[idx % USER_COLORS.length];
}

// `migrate` is idempotent: it runs the CREATE TABLE statements (guarded
// by IF NOT EXISTS) and the additive ALTER TABLE migrations (guarded by
// PRAGMA table_info checks). Safe to call on every boot, including over
// live data from v0.0.x.
function migrate(db) {
  db.pragma('journal_mode = WAL');

  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE COLLATE NOCASE NOT NULL,
  display TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#7c9a72',
  pass_hash TEXT NOT NULL DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0,
  avatar_url TEXT,
  preferences TEXT NOT NULL DEFAULT '{}',
  auth_provider TEXT,
  provider_subject TEXT,
  claimed_at TEXT,
  last_seen_at TEXT,
  first_run_completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
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
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE COLLATE NOCASE NOT NULL,
  display_name TEXT,
  source_provider TEXT,
  synced_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS user_groups (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  granted_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, group_id)
);
CREATE TABLE IF NOT EXISTS tile_visibility_groups (
  tile_kind TEXT NOT NULL,
  tile_id INTEGER NOT NULL,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  PRIMARY KEY (tile_kind, tile_id, group_id)
);
CREATE TABLE IF NOT EXISTS tile_visibility_users (
  tile_kind TEXT NOT NULL,
  tile_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (tile_kind, tile_id, user_id)
);
`);

  // v2 migrations: per-person ownership + open mode
  const svcCols = db.prepare("PRAGMA table_info(services)").all().map(c => c.name);
  if (!svcCols.includes('owner')) db.exec("ALTER TABLE services ADD COLUMN owner TEXT DEFAULT 'all'");
  if (!svcCols.includes('open_mode')) db.exec("ALTER TABLE services ADD COLUMN open_mode TEXT DEFAULT 'frame'");

  // PHA-1623: per-service health checks. health_url NULL = use the tile
  // URL. health_interval_sec 0 = opt out of checking. Runtime state lives
  // in service_health_state so the checker can UPDATE without touching
  // tile config, and so state can be wiped independently.
  if (!svcCols.includes('health_url')) db.exec("ALTER TABLE services ADD COLUMN health_url TEXT DEFAULT NULL");
  if (!svcCols.includes('health_interval_sec')) db.exec("ALTER TABLE services ADD COLUMN health_interval_sec INTEGER NOT NULL DEFAULT 60");
  db.exec(`
CREATE TABLE IF NOT EXISTS service_health_state (
  service_id INTEGER PRIMARY KEY REFERENCES services(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_status_code INTEGER,
  last_checked_at TEXT,
  last_ok_at TEXT,
  down_since TEXT,
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);`);

  // v0.0.2: users.is_admin
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('is_admin')) db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");

  // v0.0.5: extend users with profile-cache fields.
  const addUserCol = (name, ddl) => {
    if (!userCols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${ddl}`);
  };
  addUserCol('avatar_url', "avatar_url TEXT");
  addUserCol('preferences', "preferences TEXT NOT NULL DEFAULT '{}'");
  addUserCol('auth_provider', "auth_provider TEXT");
  addUserCol('provider_subject', "provider_subject TEXT");
  addUserCol('claimed_at', "claimed_at TEXT");
  addUserCol('last_seen_at', "last_seen_at TEXT");
  // updated_at needs a constant default at ALTER time (SQLite refuses
  // expression defaults on ADD COLUMN against tables that have rows).
  // The schema-side default is set on fresh CREATE TABLE installs.
  addUserCol('updated_at', "updated_at TEXT");

  // v0.3.0 (PHA-2204 / PHA-2200.3): first-run-completion marker. NULL
  // means "first run not yet completed" — the SPA bootstrap (PHA-2200.4)
  // uses this to show the welcome screen. Set to a UTC timestamp once
  // the user finishes the first-run flow; the API surface (GET /api/me)
  // exposes the boolean `first_run = first_run_completed_at IS NULL`.
  addUserCol('first_run_completed_at', "first_run_completed_at TEXT");

  // v0.0.2: tasks.alt_assignee + shift legacy 'both' → 'all'
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (!taskCols.includes('alt_assignee')) db.exec("ALTER TABLE tasks ADD COLUMN alt_assignee TEXT DEFAULT NULL");
  db.exec("UPDATE tasks SET assignee = 'all' WHERE assignee = 'both'");
  db.exec("UPDATE events SET owner = 'all' WHERE owner = 'both'");
  db.exec("UPDATE services SET owner = 'all' WHERE owner = 'both'");

  // v0.3.0 (PHA-2202): per-user module enablement.
  // `user_modules` is the toggle table for the Modular Homestead work
  // (PHA-2200). Each (user, module) row carries `enabled_at`:
  //   * NULL    → module disabled (kept so data tables survive a toggle)
  //   * <iso>   → module enabled at that timestamp
  // The CHECK constraint enforces the module whitelist at the SQLite
  // layer so any registry drift (PHA-2200.2) fails loudly instead of
  // silently storing junk keys. ON DELETE CASCADE mirrors the existing
  // `user_groups`/PK → FK pattern; if a user is purged, their module
  // rows go with them.
  //
  // CREATE TABLE happens here (early) so the table exists before any
  // code path that might insert users on a first boot. The backfill
  // SELECT runs LATER, after the user-seed block, so it picks up
  // freshly inserted users on the same boot.
  db.exec(`
CREATE TABLE IF NOT EXISTS user_modules (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_key  TEXT    NOT NULL CHECK (module_key IN ('wall','lists','calendar','chores','apps','agent')),
  enabled_at  TEXT,
  PRIMARY KEY (user_id, module_key)
);
CREATE INDEX IF NOT EXISTS idx_user_modules_user ON user_modules(user_id);
`);

  // v0.0.5 preflight: refuse to boot if the existing user table has
  // case-collisions. SQLite's UNIQUE constraint treats 'Brandon' and
  // 'brandon' as distinct unless the column carries COLLATE NOCASE,
  // which CREATE TABLE IF NOT EXISTS only applies on first install.
  // Existing v0.0.x deployments may have both casings — surface them.
  const dupLower = db.prepare(`
    SELECT LOWER(username) AS u, COUNT(*) AS c, GROUP_CONCAT(username, ', ') AS variants
    FROM users
    GROUP BY LOWER(username)
    HAVING c > 1
  `).all();
  if (dupLower.length > 0) {
    const detail = dupLower.map(d => `${d.u} (${d.variants})`).join('; ');
    throw new Error(
      `users.username has case collisions: ${detail}. Rename the duplicates in the database ` +
      `before restarting Homestead. PHA-1618 cannot tighten the unique constraint until the ` +
      `collisions are resolved.`
    );
  }

  // Seed: admin + brandon + emily (CLAIM-ready profiles). On first
  // X-authentik-username request, the matching seeded row is claimed —
  // id / display / color / preferences stay put; only auth_provider /
  // provider_subject / claimed_at are populated. LAN passwords default
  // to env seeds so /api/login keeps working as the PHA-1574 fallback.
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    const ins = db.prepare('INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES (?,?,?,?,0)');
    ins.run('admin', 'Admin', '#7c9a72', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'changeme', 10));
    ins.run('brandon', 'Brandon', '#8a9ec4', bcrypt.hashSync(process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme', 10));
    ins.run('emily', 'Emily', '#c48a9e', bcrypt.hashSync(process.env.EMILY_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme', 10));
    console.log('[seed] Created CLAIM-ready profiles: admin, brandon, emily. First authentik login will attach identity to the matching row.');

    // Seed the four canonical groups (PHA-1577 mirror). household is the
    // shared default; family / media-club / admins slot in as the auth
    // provider's group claim starts arriving.
    const insGroup = db.prepare('INSERT INTO groups (name, display_name, source_provider) VALUES (?,?,?)');
    insGroup.run('household', 'Household', 'authentik');
    insGroup.run('family', 'Family', 'authentik');
    insGroup.run('media-club', 'Media Club', 'authentik');
    insGroup.run('admins', 'Admins', 'authentik');

    // reconcileGroups seeds both the user_groups M2M and the
    // denormalized `is_admin` flag (admin → admins → is_admin=1).
    reconcileGroups(db, db.prepare('SELECT id FROM users WHERE username = ?').get('admin').id, ['admins', 'household']);
    reconcileGroups(db, db.prepare('SELECT id FROM users WHERE username = ?').get('brandon').id, ['household']);
    reconcileGroups(db, db.prepare('SELECT id FROM users WHERE username = ?').get('emily').id, ['household']);
  } else {
    // Backfill admin flag for existing installations.
    db.exec("UPDATE users SET is_admin = 1 WHERE username = 'admin' AND is_admin = 0");
  }

  // Seed services (replace these with your own URLs in the app).
  if (db.prepare('SELECT COUNT(*) c FROM services').get().c === 0) {
    const ins = db.prepare('INSERT INTO services (name,url,icon,descr,sort) VALUES (?,?,?,?,?)');
    ins.run('Example', 'https://example.com', '🔗', 'Replace with your own services', 1);
  }

  // v0.3.0 (PHA-2202) backfill, phase 2: runs every startup after the
  // user-seed block so freshly created users pick up all six rows on
  // the same boot. INSERT OR IGNORE skips existing (user_id, module_key)
  // pairs — including partially-enabled users who have manually toggled
  // a module before this migration ran — so a re-run never clobbers a
  // user-driven choice. The cross-join expands the canonical module
  // whitelist into one row per user; new users inserted via the CLAIM
  // path will be picked up on the next boot.
  //
  // The portable UNION ALL subquery is used in place of the newer
  // `VALUES (...) AS alias(col)` syntax: better-sqlite3 ships a
  // SQLite build that doesn't accept the VALUES table-alias form via
  // `db.exec` (the SELECT-from-VALUES form does not parse in this
  // build). Semantically identical and supported on every SQLite since
  // 3.7. The same SQL is recorded in PHA-2202 with the newer syntax as
  // the docs spec; the runtime uses the equivalent portable form.
  db.exec(`
INSERT OR IGNORE INTO user_modules (user_id, module_key, enabled_at)
SELECT u.id, m.module_key, datetime('now')
  FROM users u
  CROSS JOIN (
    SELECT 'wall'    AS module_key UNION ALL
    SELECT 'lists'   UNION ALL
    SELECT 'calendar' UNION ALL
    SELECT 'chores'  UNION ALL
    SELECT 'apps'    UNION ALL
    SELECT 'agent'
  ) AS m;
`);
}

function getMe(db, username) {
  return db.prepare('SELECT id, username, display, color, is_admin FROM users WHERE username = ?').get(username);
}

function getOrCreateGroupId(db, name) {
  const clean = (name || '').toLowerCase().trim();
  if (!/^[a-z0-9_-]{2,32}$/.test(clean)) return null;
  const existing = db.prepare('SELECT id FROM groups WHERE name = ?').get(clean);
  if (existing) return existing.id;
  const r = db.prepare('INSERT INTO groups (name, display_name, source_provider) VALUES (?, ?, ?)').run(clean, clean, 'authentik');
  return r.lastInsertRowid;
}

// `reconcileGroups` replaces the user's full M2M membership with the
// groups asserted by the auth provider on this request. It also keeps
// the legacy `is_admin` denormalized flag in sync so admin-only HTTP
// endpoints don't need to walk the M2M on every check.
function reconcileGroups(db, userId, groupsFromProvider) {
  const validNames = (Array.isArray(groupsFromProvider) ? groupsFromProvider : [])
    .map(n => (n || '').toLowerCase().trim())
    .filter(n => /^[a-z0-9_-]{2,32}$/.test(n));
  const groupIds = validNames.map(n => getOrCreateGroupId(db, n)).filter(Boolean);
  const tx = db.transaction((uid, gids) => {
    db.prepare('DELETE FROM user_groups WHERE user_id = ?').run(uid);
    const ins = db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)');
    for (const gid of gids) ins.run(uid, gid);
    db.prepare(`UPDATE users SET updated_at = datetime('now') WHERE id = ?`).run(uid);
  });
  tx(userId, groupIds);
  const inAdmins = validNames.includes('admins');
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(inAdmins ? 1 : 0, userId);
}

// `provisionOrClaim` is the canonical CREATE-or-CLAIM path.
//   * match by username COLLATE NOCASE (case-insensitive)
//   * row exists → CLAIM (attach auth_provider / provider_subject /
//     claimed_at, refresh last_seen_at, reconcile groups; history stays)
//   * no row → CREATE with display=username, color from palette,
//     auth_provider='header_trust', claimed_at=now
// Returns the public-safe user row (no pass_hash).
function provisionOrClaim(db, username, provider, providerSubject, groups) {
  const clean = validateUsername(username);
  if (!clean) return null;
  const providerName = (provider || 'header_trust').toLowerCase();
  const subject = providerSubject || clean;

  let user = db.prepare('SELECT * FROM users WHERE username = ?').get(clean);
  if (user) {
    db.prepare(`UPDATE users SET
        auth_provider = COALESCE(auth_provider, ?),
        provider_subject = COALESCE(provider_subject, ?),
        claimed_at = COALESCE(claimed_at, datetime('now')),
        last_seen_at = datetime('now'),
        updated_at = datetime('now')
      WHERE id = ?`).run(providerName, subject, user.id);
  } else {
    const color = nextColor(db);
    const r = db.prepare(`INSERT INTO users
        (username, display, color, pass_hash, is_admin, auth_provider, provider_subject, claimed_at, last_seen_at)
        VALUES (?, ?, ?, '', 0, ?, ?, datetime('now'), datetime('now'))`)
      .run(clean, clean, color, providerName, subject);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
  }
  if (Array.isArray(groups) && groups.length) reconcileGroups(db, user.id, groups);
  return db.prepare('SELECT id, username, display, color, is_admin FROM users WHERE id = ?').get(user.id);
}

function touchLastSeen(db, userId) {
  db.prepare(`UPDATE users SET last_seen_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(userId);
}

function validateAssignee(db, value) {
  if (value === 'all' || value === null || value === undefined) return true;
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(value);
  return !!u;
}

// Canonical module whitelist. Mirrors the CHECK constraint on
// `user_modules.module_key`. Centralised here so the API surface
// (PHA-2200.3) and the SPA rendering (PHA-2200.4) read from the same
// source-of-truth without re-typing the six strings.
//
// PHA-2203 (PHA-2200.2): the authoritative source is now
// `lib/modules.js` — USER_MODULE_KEYS is derived from
// modules.MODULE_KEYS at load time so the CHECK constraint, the
// registry, and any helpers reading the whitelist cannot drift.
const modules = require('./modules');
const USER_MODULE_KEYS = modules.MODULE_KEYS;

function isUserModuleKey(key) {
  return modules.isModuleKey(key);
}

// `getUserModules` returns the full { module_key, enabled } map for a
// user. Modules without a row (e.g. user inserted before the backfill
// ran) are returned as { enabled: false } so the SPA can render a
// predictable shape regardless of migration state.
function getUserModules(db, userId) {
  const rows = db.prepare('SELECT module_key, enabled_at FROM user_modules WHERE user_id = ?').all(userId);
  const byKey = Object.fromEntries(USER_MODULE_KEYS.map(k => [k, { module_key: k, enabled: false, enabled_at: null }]));
  for (const r of rows) {
    if (!Object.prototype.hasOwnProperty.call(byKey, r.module_key)) continue; // ignore legacy/unknown keys
    byKey[r.module_key] = {
      module_key: r.module_key,
      enabled: r.enabled_at !== null,
      enabled_at: r.enabled_at,
    };
  }
  return byKey;
}

// `setUserModule` toggles a single module for a user. enabled=true
// stamps `enabled_at` (UTC now); enabled=false clears it. Never deletes
// the row — that's the whole point of the table: disabling the
// `chores` module must NOT wipe the tasks table that chores writes to.
function setUserModule(db, userId, moduleKey, enabled) {
  if (!isUserModuleKey(moduleKey)) throw new Error(`unknown module_key: ${moduleKey}`);
  // Upsert via INSERT … ON CONFLICT to keep the row across toggles.
  if (enabled) {
    db.prepare(`INSERT INTO user_modules (user_id, module_key, enabled_at)
                VALUES (?, ?, datetime('now'))
                ON CONFLICT(user_id, module_key) DO UPDATE SET enabled_at = excluded.enabled_at`)
      .run(userId, moduleKey);
  } else {
    db.prepare(`INSERT INTO user_modules (user_id, module_key, enabled_at)
                VALUES (?, ?, NULL)
                ON CONFLICT(user_id, module_key) DO UPDATE SET enabled_at = NULL`)
      .run(userId, moduleKey);
  }
  return getUserModules(db, userId)[moduleKey];
}

// `getEnabledModules` (PHA-2203 / PHA-2200.2) returns the user's
// ENABLED modules as an ordered array of registered entries. Order
// follows `lib/modules.js` REGISTRY_ORDER so the SPA renders the home
// grid in a deterministic order regardless of which row order the
// DB returned them in. Unknown / legacy module_key rows in
// `user_modules` (e.g. from a future registry removal) are silently
// skipped — the API surface only ever sees registered modules.
//
// Returned shape: Array<{ key, name, description, icon, room, requires,
// tier, version, author, url, open_mode, scopes, mcp, webhooks,
// entity_kinds, default_enabled, enabled_at }>
// — i.e. the registry entry with `enabled_at` appended so the API
// (PHA-2200.3) and the SPA can show "enabled since …" without a
// second lookup.
function getEnabledModules(db, userId) {
  // Single query: pull every enabled row for the user, join in
  // registry order by sorting in JS (REGISTRY_ORDER is the canonical
  // order; SQLite has no stable ordering guarantee here).
  const rows = db.prepare(
    'SELECT module_key, enabled_at FROM user_modules WHERE user_id = ? AND enabled_at IS NOT NULL'
  ).all(userId);
  const enabledByKey = new Map();
  for (const r of rows) {
    if (!modules.isModuleKey(r.module_key)) continue; // skip legacy/unknown
    enabledByKey.set(r.module_key, r.enabled_at);
  }
  const result = [];
  for (const key of modules.REGISTRY_ORDER) {
    if (!enabledByKey.has(key)) continue;
    const entry = modules.getModule(key);
    result.push({ ...entry, enabled_at: enabledByKey.get(key) });
  }
  return result;
}

// `getDefaultEnabledModules` is the new-user provisioning helper:
// returns the default-enabled set in registry order, fully resolved
// (registry entries, no DB lookup needed). Used by the user-seeding
// path in v0.4+ when CLAIM-first provisioning auto-enables modules
// per the registry's DEFAULT_ENABLED list.
function getDefaultEnabledModules() {
  const defs = modules.getDefaultEnabled();
  const out = [];
  for (const key of defs) {
    const entry = modules.getModule(key);
    if (entry) out.push(entry);
  }
  return out;
}

// `getRequiredModules` returns the closure of `requires[]` for a
// given module key — i.e. the set of registered keys that MUST be
// enabled for `key` to be usable. Recursive: if a requirement
// itself has requirements, those are folded in too. Returns the
// keys in registry order, with `key` itself excluded from the
// result. Returns [] if `key` is unknown or has no requirements.
//
// Used by `enableModule`/`disableModule` to compute the cascade set
// — e.g. enabling `chores` needs `lists` (and only `lists`, since
// `lists` has no `requires[]` of its own).
function getRequiredModules(key) {
  if (!modules.isModuleKey(key)) return [];
  const seen = new Set();
  const stack = [key];
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue; // cycle guard (none today, defensive)
    seen.add(cur);
    const entry = modules.getModule(cur);
    if (!entry || !Array.isArray(entry.requires)) continue;
    for (const req of entry.requires) {
      if (!modules.isModuleKey(req)) continue; // silently skip unknown refs
      if (!seen.has(req)) stack.push(req);
    }
  }
  seen.delete(key); // caller wants only the dependencies, not the target
  const result = [];
  for (const k of modules.REGISTRY_ORDER) {
    if (seen.has(k)) result.push(k);
  }
  return result;
}

// `getDependentModules` returns the CLOSURE of `requires[]` reverse
// references — i.e. registered keys that depend on `key`, transitively.
// Returns keys in registry order, with `key` itself excluded.
//
// Used by `disableModule` so that disabling `lists` also disables
// `chores` (since `chores.requires = ['lists']`). The reverse lookup
// walks the full registry once.
function getDependentModules(key) {
  if (!modules.isModuleKey(key)) return [];
  const dependents = new Set();
  const stack = [key];
  while (stack.length) {
    const cur = stack.pop();
    for (const k of modules.REGISTRY_ORDER) {
      const entry = modules.getModule(k);
      if (!entry || !Array.isArray(entry.requires)) continue;
      if (!entry.requires.includes(cur)) continue;
      if (k === key) continue; // never include the target itself
      if (dependents.has(k)) continue;
      dependents.add(k);
      stack.push(k);
    }
  }
  const result = [];
  for (const k of modules.REGISTRY_ORDER) {
    if (dependents.has(k)) result.push(k);
  }
  return result;
}

// `enableModule` (PHA-2204 / PHA-2200.3) — enable a single module for
// a user. Idempotent: enabling an already-enabled module is a no-op
// (still returns the current shape so the caller doesn't have to
// branch on prior state).
//
// `withRequirements` controls the cascade behavior:
//   * false (default) — if the target has unmet requirements, throw
//     `Error('requires: ["lists"]')` so the API layer can surface a
//     409 with the dependency list. Caller can retry with
//     `withRequirements: true`.
//   * true            — enable the target AND all unmet requirements
//     in one transaction. Order is resolved depth-first via
//     `getRequiredModules` so a transitive chain like
//     `a → b → c` enables c, b, then a.
//
// Returns `{ enabled: <module>, also_enabled: [<modules>] }` where
// `also_enabled` lists the cascade that was applied (empty when
// no cascade was needed or requested).
function enableModule(db, userId, moduleKey, { withRequirements = false } = {}) {
  if (!modules.isModuleKey(moduleKey)) {
    throw new Error(`unknown module_key: ${moduleKey}`);
  }
  const needed = getRequiredModules(moduleKey); // dependencies
  const tx = db.transaction(() => {
    if (withRequirements) {
      for (const req of needed) {
        db.prepare(`INSERT INTO user_modules (user_id, module_key, enabled_at)
                    VALUES (?, ?, datetime('now'))
                    ON CONFLICT(user_id, module_key) DO UPDATE SET enabled_at = excluded.enabled_at`)
          .run(userId, req);
      }
    } else if (needed.length > 0) {
      // Check whether ALL dependencies are already enabled. If any is
      // missing, refuse the enable and surface the unmet list. We
      // walk `needed` against the current user_modules rows.
      const rows = db.prepare(
        'SELECT module_key, enabled_at FROM user_modules WHERE user_id = ?'
      ).all(userId);
      const enabledNow = new Set(
        rows.filter(r => r.enabled_at !== null).map(r => r.module_key)
      );
      const unmet = needed.filter(k => !enabledNow.has(k));
      if (unmet.length > 0) {
        const err = new Error(`requires: ${JSON.stringify(unmet)}`);
        err.code = 'requires_unmet';
        err.unmet = unmet;
        throw err;
      }
    }
    db.prepare(`INSERT INTO user_modules (user_id, module_key, enabled_at)
                VALUES (?, ?, datetime('now'))
                ON CONFLICT(user_id, module_key) DO UPDATE SET enabled_at = excluded.enabled_at`)
      .run(userId, moduleKey);
  });
  tx();
  return {
    enabled: getUserModules(db, userId)[moduleKey],
    also_enabled: withRequirements ? needed : [],
  };
}

// `disableModule` (PHA-2204 / PHA-2200.3) — disable a single module
// for a user. Idempotent: disabling an already-disabled module is
// a no-op. The data tables that the module writes to (tasks, events,
// posts, etc.) are NOT touched — disabling `chores` must not wipe
// the tasks table.
//
// `withDependents` controls the cascade behavior:
//   * false (default) — if any other enabled module depends on this
//     one (transitively, via `requires[]`), throw
//     `Error('dependents: ["chores"]')` so the API layer can surface
//     a 409 with the dependent list. Caller can retry with
//     `withDependents: true`.
//   * true            — disable the target AND all enabled dependents
//     in one transaction (cascade order is reverse-dependency).
//
// Returns `{ disabled: <module>, also_disabled: [<modules>] }`.
function disableModule(db, userId, moduleKey, { withDependents = false } = {}) {
  if (!modules.isModuleKey(moduleKey)) {
    throw new Error(`unknown module_key: ${moduleKey}`);
  }
  const dependents = getDependentModules(moduleKey); // things that need this key
  const tx = db.transaction(() => {
    if (!withDependents && dependents.length > 0) {
      // Refuse if any dependent is currently enabled.
      const rows = db.prepare(
        'SELECT module_key, enabled_at FROM user_modules WHERE user_id = ?'
      ).all(userId);
      const enabledNow = new Set(
        rows.filter(r => r.enabled_at !== null).map(r => r.module_key)
      );
      const blocking = dependents.filter(k => enabledNow.has(k));
      if (blocking.length > 0) {
        const err = new Error(`dependents: ${JSON.stringify(blocking)}`);
        err.code = 'dependents_active';
        err.dependents = blocking;
        throw err;
      }
    }
    // If cascading, disable dependents first (in registry order, which
    // is reverse-dependency-safe because dependents appear AFTER their
    // requirements in REGISTRY_ORDER — e.g. `chores` is after `lists`).
    if (withDependents) {
      for (const dep of dependents) {
        db.prepare(`INSERT INTO user_modules (user_id, module_key, enabled_at)
                    VALUES (?, ?, NULL)
                    ON CONFLICT(user_id, module_key) DO UPDATE SET enabled_at = NULL`)
          .run(userId, dep);
      }
    }
    db.prepare(`INSERT INTO user_modules (user_id, module_key, enabled_at)
                VALUES (?, ?, NULL)
                ON CONFLICT(user_id, module_key) DO UPDATE SET enabled_at = NULL`)
      .run(userId, moduleKey);
  });
  tx();
  return {
    disabled: getUserModules(db, userId)[moduleKey],
    also_disabled: withDependents ? dependents : [],
  };
}

// `completeFirstRun` (PHA-2204 / PHA-2200.3) — stamp the
// `first_run_completed_at` column with the current UTC timestamp.
// Idempotent: re-calling on an already-completed user is a no-op
// (the original timestamp is preserved). Used by the SPA's
// "I'm done setting up" path (PHA-2200.4). Returns the new
// boolean `first_run` state.
function completeFirstRun(db, userId) {
  const row = db.prepare('SELECT first_run_completed_at FROM users WHERE id = ?').get(userId);
  if (!row) throw new Error(`user not found: ${userId}`);
  if (row.first_run_completed_at === null) {
    db.prepare(`UPDATE users SET first_run_completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(userId);
  }
  return isFirstRun(db, userId);
}

// `isFirstRun` returns true when the user has not yet completed the
// first-run flow. The /api/me response uses this directly.
function isFirstRun(db, userId) {
  const row = db.prepare('SELECT first_run_completed_at FROM users WHERE id = ?').get(userId);
  if (!row) return true;
  return row.first_run_completed_at === null;
}

module.exports = {
  USER_COLORS,
  USER_MODULE_KEYS,
  validateUsername,
  nextColor,
  migrate,
  getMe,
  getOrCreateGroupId,
  reconcileGroups,
  provisionOrClaim,
  touchLastSeen,
  validateAssignee,
  isUserModuleKey,
  getUserModules,
  setUserModule,
  getEnabledModules,
  getDefaultEnabledModules,
  getRequiredModules,
  getDependentModules,
  enableModule,
  disableModule,
  completeFirstRun,
  isFirstRun,
};