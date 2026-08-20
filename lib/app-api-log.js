// Third-party app accountability trail (PHA-2201.3 / PHA-2231).
//
// Pure DB logic — no HTTP, no express. Imported by:
//   * server.js (runs `migrate(db)` at boot, calls `log()` from the
//     Bearer-PAT branch of `authenticate()` when the token is
//     app-scoped, mounts `GET /api/apps/:key/activity` over `list()`)
//   * scripts/test-app-api-log.js (acceptance tests)
//
// Contract (PHA-2201 design note §5): one row per API call made using
// an app-scoped token (`agent_tokens.app_id IS NOT NULL`). Built-in
// module calls (`app_id IS NULL`, the PHA-1617 user-level PAT and
// header-trust/session paths) are NEVER logged here — this table is a
// third-party accountability surface, not general request logging.
// v0.3.0 scope is just this table + the read path; the settings UI
// that renders it is PHA-2201.4 and the operator-analytics consumer is
// PHA-2210 — neither is built here.

'use strict';

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS app_api_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES installed_apps(key) ON DELETE CASCADE,
  route TEXT NOT NULL,
  scopes_used TEXT,
  status INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_app_api_log_user_app ON app_api_log(user_id, app_id, created_at DESC);
`);
}

// Logs one app-scoped API call. Callers own not blocking the request on
// this — server.js writes from a `res.on('finish', ...)` handler so the
// insert happens after the response is already on the wire.
function log(db, { userId, appId, route, scopesUsed, status }) {
  if (!userId || !appId || !route || status == null) {
    throw new Error('log() requires userId, appId, route, status');
  }
  db.prepare(`INSERT INTO app_api_log (user_id, app_id, route, scopes_used, status)
              VALUES (?, ?, ?, ?, ?)`)
    .run(userId, appId, route, scopesUsed || null, status);
}

// Paginated rows for one (userId, appId) pair — never another user's
// activity for the same app, since userId is always part of the WHERE.
function list(db, userId, appId, { limit = 50, offset = 0 } = {}) {
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  const total = db.prepare('SELECT COUNT(*) c FROM app_api_log WHERE user_id = ? AND app_id = ?')
    .get(userId, appId).c;
  const items = db.prepare(`SELECT * FROM app_api_log WHERE user_id = ? AND app_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(userId, appId, cap, off);
  const nextOffset = off + items.length < total ? off + items.length : null;
  return { items, total, nextOffset };
}

module.exports = { migrate, log, list };
