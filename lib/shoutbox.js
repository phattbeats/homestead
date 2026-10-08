// Homestead — The Shoutbox (#4098, parent #4076). The Woodgrain board's
// short-lived household chat strip.
//
// One household per install, so there is no house_id column: every member
// sees every shout. Rows are disposable by design — pruned to the newest
// MAX_ROWS and at most RETAIN_DAYS old — so this never becomes a second
// content store next to walls.
//
// Hearth chimes in rarely. `hearthChime` is the gate; the words come from
// an injected `draft(context)` (server.js wires the agent runtime) with a
// small in-voice fallback pool so a missing model key never silences the
// strip's one resident character entirely — it just stays quiet instead of
// spamming (see the gate: no human talking, no chime).

'use strict';

const walls = require('./walls');
const hearthCharacters = require('./hearth-characters');
const porchContract = require('./porch/participation-contract');

const MAX_BODY_LEN = 280;
const MAX_ROWS = 200;
const RETAIN_DAYS = 7;
const LIST_DEFAULT_LIMIT = 50;

// Per-user flood limit: at most RATE_MAX shouts in any RATE_WINDOW_SEC.
const RATE_WINDOW_SEC = 30;
const RATE_MAX = 5;

const HEARTH_DEFAULTS = Object.freeze({
  // Someone human must have shouted this recently, and Hearth must not be
  // the last voice in the box — it answers a room, it doesn't fill one.
  ACTIVE_WINDOW_MIN: 30,
  MIN_GAP_MIN: 120,
  MAX_PER_DAY: 4,
  CHANCE: 0.35,
});

const HEARTH_FALLBACK_LINES = Object.freeze([
  'kettle is on, in case anyone needs a reason',
  'quiet in here for a house this loud :)',
  'reminder: the fridge door is not a filing system',
  'someone water the plants and I will think very well of them',
  'good to see the lights on in here',
]);

// A few classic emoticons → emoji, applied at render time by the client;
// the server stores what was typed. Exported so the UI and tests agree.
const SMILIES = Object.freeze({
  ':)': '🙂', ':-)': '🙂', ':(': '🙁', ':D': '😄', ';)': '😉', ':P': '😛',
  ':o': '😮', '<3': '❤️', ':\'(': '😢', 'B)': '😎',
});

let _db = null;
let _publish = () => {};

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function migrate(db, opts = {}) {
  _db = db;
  if (opts.publish) _publish = opts.publish;
  db.exec(`
    CREATE TABLE IF NOT EXISTS shouts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL DEFAULT 'say' CHECK (kind IN ('say','me')),
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_shouts_created ON shouts(created_at, id);
  `);
}

function ts(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function shoutView(row) {
  return {
    id: row.id,
    kind: row.kind,
    body: row.body,
    createdAt: row.created_at,
    author: { username: row.username, display: row.display, color: row.color, isAgent: walls.isAgentUserId(row.user_id) || hearthCharacters.isBuiltinAgentUserId(_db, row.user_id) },
  };
}

const SELECT_SHOUT = `SELECT s.id, s.user_id, s.kind, s.body, s.created_at, u.username, u.display, u.color
                      FROM shouts s JOIN users u ON u.id = s.user_id`;

// parse(raw): trim, cap, and recognise the classic `/me waves` action form.
function parse(raw) {
  if (typeof raw !== 'string') throw httpError(400, 'body_required');
  let text = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  let kind = 'say';
  const m = /^\/me(?:\s+([\s\S]*))?$/i.exec(text);
  if (m) { kind = 'me'; text = (m[1] || '').trim(); }
  if (!text) throw httpError(400, 'body_required');
  if (text.length > MAX_BODY_LEN) throw httpError(400, 'body_too_long');
  return { kind, body: text };
}

function assertClean(body) {
  if (porchContract.containsBannedPhrase(body, porchContract.getLexicon())) throw httpError(422, 'banned_phrase');
}

function checkRate(userId, now) {
  const since = ts(new Date(now.getTime() - RATE_WINDOW_SEC * 1000));
  const n = _db.prepare('SELECT COUNT(*) c FROM shouts WHERE user_id = ? AND created_at >= ?').get(userId, since).c;
  if (n >= RATE_MAX) throw httpError(429, 'rate_limited');
}

// prune(now): newest MAX_ROWS survive, and nothing older than RETAIN_DAYS.
function prune(now = new Date()) {
  const cutoff = ts(new Date(now.getTime() - RETAIN_DAYS * 86400000));
  let removed = _db.prepare('DELETE FROM shouts WHERE created_at < ?').run(cutoff).changes;
  removed += _db.prepare(`DELETE FROM shouts WHERE id NOT IN (SELECT id FROM shouts ORDER BY created_at DESC, id DESC LIMIT ?)`).run(MAX_ROWS).changes;
  return removed;
}

function insert(userId, kind, body, now) {
  const info = _db.prepare('INSERT INTO shouts (user_id, kind, body, created_at) VALUES (?, ?, ?, ?)').run(userId, kind, body, ts(now));
  prune(now);
  const view = shoutView(_db.prepare(`${SELECT_SHOUT} WHERE s.id = ?`).get(info.lastInsertRowid));
  _publish('shout', view);
  return view;
}

// post(userId, raw, {now}): the human path. Validates, filters, rate-limits.
function post(userId, raw, opts = {}) {
  const now = opts.now || new Date();
  const { kind, body } = parse(raw);
  assertClean(body);
  checkRate(userId, now);
  return insert(userId, kind, body, now);
}

// list({limit, afterId}): oldest→newest within the newest `limit`; afterId
// lets a polling client fetch only what it hasn't seen.
function list(opts = {}) {
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || LIST_DEFAULT_LIMIT, 1), MAX_ROWS);
  const after = parseInt(opts.afterId, 10);
  const rows = Number.isFinite(after)
    ? _db.prepare(`${SELECT_SHOUT} WHERE s.id > ? ORDER BY s.id ASC LIMIT ?`).all(after, limit)
    : _db.prepare(`${SELECT_SHOUT} ORDER BY s.created_at DESC, s.id DESC LIMIT ?`).all(limit).reverse();
  return { shouts: rows.map(shoutView), smilies: SMILIES };
}

// hearthChime({ now, rng, draft, config }): maybe post one Hearth shout.
// Returns the posted shout view, or { skipped: <reason> }.
async function hearthChime(opts = {}) {
  const now = opts.now || new Date();
  const config = { ...HEARTH_DEFAULTS, ...(opts.config || {}) };
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const hearthId = hearthCharacters.ensureBuiltinAgentUser(_db);

  const last = _db.prepare('SELECT user_id FROM shouts ORDER BY created_at DESC, id DESC LIMIT 1').get();
  if (!last) return { skipped: 'empty_room' };
  if (last.user_id === hearthId) return { skipped: 'already_last_voice' };

  const activeSince = ts(new Date(now.getTime() - config.ACTIVE_WINDOW_MIN * 60000));
  const recent = _db.prepare('SELECT COUNT(*) c FROM shouts WHERE user_id != ? AND created_at >= ?').get(hearthId, activeSince).c;
  if (!recent) return { skipped: 'nobody_talking' };

  const gapSince = ts(new Date(now.getTime() - config.MIN_GAP_MIN * 60000));
  if (_db.prepare('SELECT 1 FROM shouts WHERE user_id = ? AND created_at >= ?').get(hearthId, gapSince)) return { skipped: 'too_soon' };
  const daySince = ts(new Date(now.getTime() - 86400000));
  if (_db.prepare('SELECT COUNT(*) c FROM shouts WHERE user_id = ? AND created_at >= ?').get(hearthId, daySince).c >= config.MAX_PER_DAY) return { skipped: 'daily_cap' };

  if (rng() >= config.CHANCE) return { skipped: 'dice' };

  const context = list({ limit: 12 }).shouts.map((s) => ({ who: s.author.display || s.author.username, kind: s.kind, body: s.body }));
  let raw = null;
  if (typeof opts.draft === 'function') {
    try { raw = await opts.draft(context); } catch (_) { raw = null; }
  }
  if (!raw) raw = HEARTH_FALLBACK_LINES[Math.floor(rng() * HEARTH_FALLBACK_LINES.length) % HEARTH_FALLBACK_LINES.length];

  let parsed;
  try { parsed = parse(String(raw).split('\n')[0]); assertClean(parsed.body); } catch (_) { return { skipped: 'draft_rejected' }; }
  return insert(hearthId, parsed.kind, parsed.body, now);
}

module.exports = {
  MAX_BODY_LEN, MAX_ROWS, RETAIN_DAYS, RATE_MAX, RATE_WINDOW_SEC, HEARTH_DEFAULTS, SMILIES,
  migrate, post, list, prune, hearthChime,
};
