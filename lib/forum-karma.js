// Homestead — The Forum: member karma (+/-).
//
// Karma is a score on a person, not on a post. Thread reactions
// (post_reactions, lib/walls.js) are emoji on one post and say nothing
// about the author across threads, so they can't back "karma: +88 / -3".
// This is the one extra store for it.
//
// Rules:
//   * one vote per giver per target (+1 or -1); voting again flips it,
//     DELETE takes it back
//   * no karma on yourself
//   * you can only rate someone you share at least one board with; anyone
//     else is a 404, the same as an unknown username
//   * rate limit: KARMA_DAILY_LIMIT karma actions (give, flip, take back)
//     per giver in any rolling 24 hours, so the score can't be churned
//
// Deleting a user cascades their given and received karma.

'use strict';

const walls = require('./walls');

const KARMA_DAILY_LIMIT = 10;
const WINDOW_SQL = "datetime('now', '-1 day')";

let _db = null;

function httpError(status, code, extra) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function migrate(db) {
  _db = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_karma (
      giver_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      value       INTEGER NOT NULL CHECK (value IN (1, -1)),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (giver_id, target_id),
      CHECK (giver_id <> target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_forum_karma_target ON forum_karma(target_id);
    CREATE TABLE IF NOT EXISTS forum_karma_log (
      id         INTEGER PRIMARY KEY,
      giver_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_forum_karma_log_giver ON forum_karma_log(giver_id, at);
  `);
}

// ---- read model ----

function totals(targetId) {
  const r = _db.prepare(`
    SELECT COALESCE(SUM(value = 1), 0) AS plus, COALESCE(SUM(value = -1), 0) AS minus
    FROM forum_karma WHERE target_id = ?
  `).get(targetId);
  return { plus: r.plus, minus: r.minus };
}

// Totals for a postbit; with a viewer, also their own vote and whether
// they may vote (not on themselves).
function forMember(targetId, viewerId) {
  const view = totals(targetId);
  if (viewerId != null) {
    const mine = _db.prepare('SELECT value FROM forum_karma WHERE giver_id = ? AND target_id = ?').get(viewerId, targetId);
    view.mine = mine ? mine.value : 0;
    view.canVote = viewerId !== targetId;
  }
  return view;
}

// ---- access ----

function sharesBoard(giverId, targetId) {
  for (const w of walls.listForUser(giverId)) {
    try { walls.assertMember(w.slug, targetId); return true; } catch (_) { /* not on this board */ }
  }
  return false;
}

function resolveTarget(username, giverId) {
  const u = typeof username === 'string' && _db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
  if (!u) throw httpError(404, 'not_found');
  if (u.id === giverId) return u; // self: let the caller reject with a clear code
  if (!sharesBoard(giverId, u.id)) throw httpError(404, 'not_found');
  return u;
}

function get(username, viewerId) {
  const u = resolveTarget(username, viewerId);
  return { username: u.username, ...forMember(u.id, viewerId) };
}

// ---- writes ----

function usedToday(giverId) {
  return _db.prepare(`SELECT COUNT(*) c FROM forum_karma_log WHERE giver_id = ? AND at > ${WINDOW_SQL}`).get(giverId).c;
}

function spend(giverId) {
  if (usedToday(giverId) >= KARMA_DAILY_LIMIT) {
    const oldest = _db.prepare(`SELECT CAST(strftime('%s', at, '+1 day') - strftime('%s', 'now') AS INTEGER) AS s
                                FROM forum_karma_log WHERE giver_id = ? AND at > ${WINDOW_SQL} ORDER BY at ASC LIMIT 1`).get(giverId);
    throw httpError(429, 'karma_rate_limited', { retryAfter: Math.max(1, (oldest && oldest.s) || 1) });
  }
  _db.prepare(`DELETE FROM forum_karma_log WHERE giver_id = ? AND at <= ${WINDOW_SQL}`).run(giverId);
  _db.prepare('INSERT INTO forum_karma_log (giver_id) VALUES (?)').run(giverId);
}

function give(username, giverId, value) {
  if (value !== 1 && value !== -1) throw httpError(400, 'invalid_karma_value');
  const u = resolveTarget(username, giverId);
  if (u.id === giverId) throw httpError(400, 'karma_self');
  const cur = _db.prepare('SELECT value FROM forum_karma WHERE giver_id = ? AND target_id = ?').get(giverId, u.id);
  if (!cur || cur.value !== value) { // re-sending the same vote is a no-op, not a spend
    _db.transaction(() => {
      spend(giverId);
      _db.prepare(`INSERT INTO forum_karma (giver_id, target_id, value) VALUES (?, ?, ?)
                   ON CONFLICT(giver_id, target_id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
        .run(giverId, u.id, value);
    })();
  }
  return { username: u.username, ...forMember(u.id, giverId) };
}

function retract(username, giverId) {
  const u = resolveTarget(username, giverId);
  if (u.id === giverId) throw httpError(400, 'karma_self');
  const cur = _db.prepare('SELECT 1 FROM forum_karma WHERE giver_id = ? AND target_id = ?').get(giverId, u.id);
  if (cur) {
    _db.transaction(() => {
      spend(giverId);
      _db.prepare('DELETE FROM forum_karma WHERE giver_id = ? AND target_id = ?').run(giverId, u.id);
    })();
  }
  return { username: u.username, ...forMember(u.id, giverId) };
}

module.exports = {
  KARMA_DAILY_LIMIT,
  migrate,
  totals,
  forMember,
  get,
  give,
  retract,
};
