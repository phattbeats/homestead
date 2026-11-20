// Homestead — The Forum: thread polls.
//
// A poll hangs off one thread (wall post): a question, 2–10 options, one
// vote per member, optional closing time. It is a forum store on purpose.
// Popcorn Vote, the other "poll" in the house, is a third-party app that
// keeps its votes in its own service and only posts announcements to the
// media-club wall (see the popcorn_vote stub in lib/modules.js), so there
// is no Homestead-side vote table to reuse.
//
// Visibility rides the thread: a poll exists for a caller exactly when its
// thread does (wall membership + author opt-out), so every miss is a 404.
// Deleting the thread cascades the poll, its options and its votes.

'use strict';

const crypto = require('crypto');
const walls = require('./walls');

const QUESTION_MAX_LEN = 140;
const OPTION_MAX_LEN = 80;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 10;

let _db = null;

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function migrate(db) {
  _db = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_polls (
      id          TEXT PRIMARY KEY,
      post_id     TEXT NOT NULL UNIQUE REFERENCES wall_posts(id) ON DELETE CASCADE,
      question    TEXT NOT NULL,
      closes_at   TEXT,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS forum_poll_options (
      id       INTEGER PRIMARY KEY,
      poll_id  TEXT NOT NULL REFERENCES forum_polls(id) ON DELETE CASCADE,
      label    TEXT NOT NULL,
      sort     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_forum_poll_options_poll ON forum_poll_options(poll_id, sort);
    CREATE TABLE IF NOT EXISTS forum_poll_votes (
      poll_id     TEXT NOT NULL REFERENCES forum_polls(id) ON DELETE CASCADE,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      option_id   INTEGER NOT NULL REFERENCES forum_poll_options(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (poll_id, user_id)
    );
  `);
}

// ---- access ----

// The thread a poll lives on, gated exactly like threadView: 404 when the
// caller can't see the thread.
function visibleThread(postId, userId) {
  const post = _db.prepare('SELECT id, wall_id, author_user_id FROM wall_posts WHERE id = ?').get(postId);
  if (!post) throw httpError(404, 'not_found');
  const wall = _db.prepare('SELECT id, slug FROM walls WHERE id = ?').get(post.wall_id);
  if (!wall) throw httpError(404, 'not_found');
  walls.assertMember(wall.slug, userId);
  if (walls.hiddenByWallOptOut(wall.id, post.author_user_id)) throw httpError(404, 'not_found');
  return { post, wall };
}

function pollRow(pollId) {
  const poll = _db.prepare('SELECT * FROM forum_polls WHERE id = ?').get(pollId);
  if (!poll) throw httpError(404, 'not_found');
  return poll;
}

function visiblePoll(pollId, userId) {
  const poll = pollRow(pollId);
  const { post, wall } = visibleThread(poll.post_id, userId);
  return { poll, post, wall };
}

// Thread author, wall admin, or a household admin.
function canManage(post, wall, userId) {
  if (post.author_user_id === userId) return true;
  const u = _db.prepare('SELECT is_admin FROM users WHERE id = ?').get(userId);
  if (u && u.is_admin) return true;
  const m = _db.prepare('SELECT role FROM wall_memberships WHERE wall_id = ? AND user_id = ?').get(wall.id, userId);
  return !!(m && m.role === 'admin');
}

function isClosed(poll) {
  if (!poll.closes_at) return false;
  return _db.prepare("SELECT ? <= datetime('now') AS c").get(poll.closes_at).c === 1;
}

// ---- validation ----

// Accepts an ISO-8601 instant (what <input type=datetime-local> + toISOString
// sends) and stores SQLite's 'YYYY-MM-DD HH:MM:SS' UTC so it compares with
// datetime('now') as text.
function parseClosesAt(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw httpError(400, 'invalid_closes_at');
  const d = new Date(v);
  if (isNaN(d)) throw httpError(400, 'invalid_closes_at');
  if (d.getTime() <= Date.now()) throw httpError(400, 'closes_at_in_past');
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function validate(body) {
  const b = body || {};
  if (typeof b.question !== 'string' || !b.question.trim()) throw httpError(400, 'question_required');
  const question = b.question.trim();
  if (question.length > QUESTION_MAX_LEN) throw httpError(400, 'question_too_long');
  if (!Array.isArray(b.options)) throw httpError(400, 'options_required');
  const options = b.options.map((o) => (typeof o === 'string' ? o.trim() : null));
  if (options.some((o) => o === null)) throw httpError(400, 'invalid_option');
  const labels = options.filter(Boolean);
  if (labels.length < OPTIONS_MIN) throw httpError(400, 'too_few_options');
  if (labels.length > OPTIONS_MAX) throw httpError(400, 'too_many_options');
  if (labels.some((o) => o.length > OPTION_MAX_LEN)) throw httpError(400, 'option_too_long');
  if (new Set(labels.map((o) => o.toLowerCase())).size !== labels.length) throw httpError(400, 'duplicate_option');
  return { question, labels, closesAt: parseClosesAt(b.closesAt) };
}

// ---- read model ----

function pollView(poll, userId, { post, wall } = {}) {
  const options = _db.prepare(`
    SELECT o.id, o.label, (SELECT COUNT(*) FROM forum_poll_votes v WHERE v.option_id = o.id) AS votes
    FROM forum_poll_options o WHERE o.poll_id = ? ORDER BY o.sort ASC, o.id ASC
  `).all(poll.id);
  const total = options.reduce((n, o) => n + o.votes, 0);
  const mine = _db.prepare('SELECT option_id FROM forum_poll_votes WHERE poll_id = ? AND user_id = ?').get(poll.id, userId);
  if (!post || !wall) ({ post, wall } = visibleThread(poll.post_id, userId));
  return {
    id: poll.id,
    threadId: poll.post_id,
    question: poll.question,
    closesAt: poll.closes_at,
    closed: isClosed(poll),
    createdAt: poll.created_at,
    totalVotes: total,
    myVote: mine ? mine.option_id : null,
    canManage: canManage(post, wall, userId),
    options: options.map((o) => ({
      id: o.id, label: o.label, votes: o.votes,
      percent: total ? Math.round((o.votes / total) * 100) : 0,
    })),
  };
}

// The poll on a thread the caller can already see (threadView calls this
// after its own gate), or null.
function forThread(postId, userId) {
  const poll = _db.prepare('SELECT * FROM forum_polls WHERE post_id = ?').get(postId);
  return poll ? pollView(poll, userId) : null;
}

function threadIdsWithPolls(postIds) {
  if (!postIds.length) return new Set();
  const rows = _db.prepare(`SELECT post_id FROM forum_polls WHERE post_id IN (${postIds.map(() => '?').join(',')})`).all(...postIds);
  return new Set(rows.map((r) => r.post_id));
}

// Sidebar poll: the newest open poll on a board the caller can see, else
// the newest closed one, so the box shows results after voting ends.
function current(userId) {
  const visible = new Set(walls.listForUser(userId).map((w) => w.slug));
  const rows = _db.prepare(`
    SELECT p.*, w.slug, wp.author_user_id, wp.wall_id,
      CASE WHEN p.closes_at IS NOT NULL AND p.closes_at <= datetime('now') THEN 1 ELSE 0 END AS is_closed
    FROM forum_polls p JOIN wall_posts wp ON wp.id = p.post_id JOIN walls w ON w.id = wp.wall_id
    ORDER BY is_closed ASC, p.created_at DESC, p.rowid DESC
  `).all();
  for (const r of rows) {
    if (!visible.has(r.slug) || walls.hiddenByWallOptOut(r.wall_id, r.author_user_id)) continue;
    const thread = _db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(r.post_id);
    const view = pollView(r, userId);
    const forum = require('./forum'); // lazy: forum.js requires this module
    return { ...view, threadTitle: forum.threadTitle(thread), board: { slug: r.slug } };
  }
  return null;
}

// ---- writes ----

function create(postId, userId, body) {
  const { post, wall } = visibleThread(postId, userId);
  if (!canManage(post, wall, userId)) throw httpError(403, 'forbidden');
  const { question, labels, closesAt } = validate(body);
  if (_db.prepare('SELECT 1 FROM forum_polls WHERE post_id = ?').get(postId)) throw httpError(409, 'poll_exists');
  const id = crypto.randomUUID();
  _db.transaction(() => {
    _db.prepare('INSERT INTO forum_polls (id, post_id, question, closes_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(id, postId, question, closesAt, userId);
    const ins = _db.prepare('INSERT INTO forum_poll_options (poll_id, label, sort) VALUES (?, ?, ?)');
    labels.forEach((label, i) => ins.run(id, label, i));
  })();
  return pollView(pollRow(id), userId, { post, wall });
}

// One vote per member; voting again moves the vote.
function vote(pollId, userId, optionId) {
  const ctx = visiblePoll(pollId, userId);
  if (isClosed(ctx.poll)) throw httpError(409, 'poll_closed');
  const opt = Number.isInteger(optionId)
    ? _db.prepare('SELECT id FROM forum_poll_options WHERE id = ? AND poll_id = ?').get(optionId, pollId)
    : null;
  if (!opt) throw httpError(400, 'invalid_option');
  _db.prepare(`INSERT INTO forum_poll_votes (poll_id, user_id, option_id) VALUES (?, ?, ?)
               ON CONFLICT(poll_id, user_id) DO UPDATE SET option_id = excluded.option_id, created_at = datetime('now')`)
    .run(pollId, userId, opt.id);
  return pollView(ctx.poll, userId, ctx);
}

function retract(pollId, userId) {
  const ctx = visiblePoll(pollId, userId);
  if (isClosed(ctx.poll)) throw httpError(409, 'poll_closed');
  _db.prepare('DELETE FROM forum_poll_votes WHERE poll_id = ? AND user_id = ?').run(pollId, userId);
  return pollView(ctx.poll, userId, ctx);
}

// Close now (closed: true) or reopen (closed: false, clears closes_at).
function setClosed(pollId, userId, closed) {
  const ctx = visiblePoll(pollId, userId);
  if (!canManage(ctx.post, ctx.wall, userId)) throw httpError(403, 'forbidden');
  _db.prepare(`UPDATE forum_polls SET closes_at = ${closed ? "datetime('now')" : 'NULL'} WHERE id = ?`).run(pollId);
  return pollView(pollRow(pollId), userId, ctx);
}

module.exports = {
  QUESTION_MAX_LEN,
  OPTION_MAX_LEN,
  OPTIONS_MIN,
  OPTIONS_MAX,
  migrate,
  forThread,
  threadIdsWithPolls,
  current,
  create,
  vote,
  retract,
  setClosed,
};
