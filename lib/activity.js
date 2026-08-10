// Homestead activity feed (PHA-1622).
//
// One row per mutation: (id, ts, actor_user_id, verb, object_type,
// object_id, summary_text, meta json). This is the seed of the
// "social layer" — an event log with faces on it — and the observable
// context the future agent (PHA-1617) will read from.
//
// Contract:
//   * logActivity() is fire-and-forget from the caller's perspective —
//     it never throws into the request path; a logging failure must not
//     fail the mutation it's describing.
//   * Retention is capped (default 90 days OR 10k rows, whichever prunes
//     more) so the table can't grow unbounded on a device with no ops
//     team watching disk usage.

'use strict';

const RETENTION_DAYS = 90;
const RETENTION_MAX_ROWS = 10000;

function migrate(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verb TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT,
  summary_text TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity(actor_user_id);
`);
}

// logActivity(db, { actorUserId, verb, objectType, objectId, summaryText, meta })
// actorUserId may be null (system-initiated events). Never throws.
function logActivity(db, entry) {
  try {
    const { actorUserId = null, verb, objectType, objectId = null, summaryText, meta = {} } = entry || {};
    if (!verb || !objectType || !summaryText) return;
    db.prepare(`INSERT INTO activity (actor_user_id, verb, object_type, object_id, summary_text, meta)
                VALUES (?,?,?,?,?,?)`)
      .run(actorUserId, verb, objectType, objectId === null || objectId === undefined ? null : String(objectId),
           summaryText, JSON.stringify(meta || {}));
  } catch (err) {
    // best-effort: a broken feed row must never break the mutation it describes.
    console.error('logActivity failed', err);
  }
}

// listActivity(db, { since, user, limit }) -> rows newest-first, joined
// with the actor's display/color so the UI needs no second round-trip.
function listActivity(db, opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 50, 1), 200);
  const clauses = [];
  const params = [];
  if (opts.since) {
    clauses.push('a.ts > ?');
    params.push(opts.since);
  }
  if (opts.user) {
    clauses.push('u.username = ?');
    params.push(opts.user);
  }
  if (opts.before) {
    clauses.push('a.id < ?');
    params.push(opts.before);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT a.id, a.ts, a.verb, a.object_type, a.object_id, a.summary_text, a.meta,
           u.id AS actor_id, u.username AS actor_username, u.display AS actor_display, u.color AS actor_color
    FROM activity a
    LEFT JOIN users u ON u.id = a.actor_user_id
    ${where}
    ORDER BY a.id DESC
    LIMIT ?
  `).all(...params, limit);
  return rows.map(r => ({
    id: r.id,
    ts: r.ts,
    verb: r.verb,
    object_type: r.object_type,
    object_id: r.object_id,
    summary_text: r.summary_text,
    meta: JSON.parse(r.meta || '{}'),
    actor: r.actor_id ? { id: r.actor_id, username: r.actor_username, display: r.actor_display, color: r.actor_color } : null,
  }));
}

// prune(db) — retention: drop rows older than RETENTION_DAYS, then if
// still over RETENTION_MAX_ROWS, drop the oldest excess by id. Safe to
// call on every boot and periodically; both branches are no-ops when
// there's nothing to prune.
function prune(db) {
  db.prepare(`DELETE FROM activity WHERE ts < datetime('now', '-${RETENTION_DAYS} days')`).run();
  const count = db.prepare('SELECT COUNT(*) c FROM activity').get().c;
  if (count > RETENTION_MAX_ROWS) {
    const excess = count - RETENTION_MAX_ROWS;
    db.prepare(`DELETE FROM activity WHERE id IN (SELECT id FROM activity ORDER BY id ASC LIMIT ?)`).run(excess);
  }
}

module.exports = {
  migrate,
  logActivity,
  listActivity,
  prune,
  RETENTION_DAYS,
  RETENTION_MAX_ROWS,
};
