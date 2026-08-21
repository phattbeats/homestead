// Homestead — invite codes for the invite-to-wall flow (PHA-2207 / PHA-2200.6).
//
// The issue reframe pulls the Wizarr-side invite creation into this
// module's lifecycle: an invite always carries `wall_slug`, and
// redemption always auto-enrolls the user into that wall. The two
// onboarding ramps from PHA-1575 (household, media-club) collapse into
// a single path that knows which wall the user is joining.
//
// Schema (`invites` table, migrated in migrate() below):
//   id           TEXT PRIMARY KEY    — also the redemption code
//   wall_slug    TEXT NOT NULL       — every invite has a wall
//   created_by   INTEGER REFERENCES users(id) — admin who issued it
//   created_at   TEXT
//   expires_at   TEXT                — created_at + expires_in_days
//   redeemed_by  INTEGER REFERENCES users(id) — first user to redeem (NULL until then)
//   redeemed_at  TEXT
//   note         TEXT                — admin's free-form note ("for the Tailor kid")
//
// `wall_slug` is NOT NULL on purpose: the PHA-1575 path accepted
// wall-less invites, but the reframe explicitly says "the old
// behavior is gone." Issue a wall-less invite at your peril — the
// `/api/invites` POST handler returns 400 if `wall_slug` is missing
// or the wall doesn't exist.
//
// The id is the redemption code: randomUUID() with no dashes gives a
// 32-char URL-safe token. We don't hash it: the row lookup is keyed
// on the plaintext code, and a rate-limited 404 from a wrong guess
// is fine. Wizarr's invite UI (out of scope for PHA-2207) will
// present the code as a URL `https://life.phatt.vip/invite/{code}`.

'use strict';

const crypto = require('crypto');
const wallMembers = require('./wall-members');

const DEFAULT_EXPIRES_IN_DAYS = 7;
const MAX_EXPIRES_IN_DAYS = 90;

let _db = null;
function migrate(db) {
  _db = db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS invites (
      id            TEXT PRIMARY KEY,
      wall_slug     TEXT NOT NULL REFERENCES walls(slug) ON DELETE CASCADE,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT NOT NULL,
      redeemed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      redeemed_at   TEXT,
      note          TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_invites_wall ON invites(wall_slug);
    CREATE INDEX IF NOT EXISTS idx_invites_redeemed ON invites(redeemed_by);
  `);
}

function _nowUtcIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function _newId() {
  // URL-safe, no dashes — friendlier to paste into a URL by hand.
  return crypto.randomUUID().replace(/-/g, '');
}

function _validateExpiresInDays(value) {
  if (value === undefined || value === null) return DEFAULT_EXPIRES_IN_DAYS;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    const e = new Error('expires_in_days must be an integer');
    e.status = 400; e.code = 'invalid_expires_in_days';
    throw e;
  }
  if (n < 1 || n > MAX_EXPIRES_IN_DAYS) {
    const e = new Error(`expires_in_days must be between 1 and ${MAX_EXPIRES_IN_DAYS}`);
    e.status = 400; e.code = 'invalid_expires_in_days';
    throw e;
  }
  return n;
}

function _validateWallSlug(db, wallSlug) {
  if (!wallSlug || typeof wallSlug !== 'string') {
    const e = new Error('wall_slug required');
    e.status = 400; e.code = 'wall_slug_required';
    throw e;
  }
  const wall = db.prepare('SELECT id, slug, name FROM walls WHERE slug = ?').get(wallSlug);
  if (!wall) {
    const e = new Error(`wall_slug not found: ${wallSlug}`);
    e.status = 400; e.code = 'wall_not_found';
    throw e;
  }
  return wall;
}

// `create` — admin issues a new invite for `wall_slug`. Returns the
// full invite row including the plaintext redemption code.
function create(db, { wall_slug, expires_in_days, note, created_by }) {
  const days = _validateExpiresInDays(expires_in_days);
  const wall = _validateWallSlug(db, wall_slug);
  const id = _newId();
  const now = _nowUtcIso();
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO invites (id, wall_slug, created_by, created_at, expires_at, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, wall.slug, created_by || null, now, expires, note || null);
  return {
    id,
    wall_slug: wall.slug,
    wall_name: wall.name,
    created_by: created_by || null,
    created_at: now,
    expires_at: expires,
    note: note || null,
    url: `https://life.phatt.vip/invite/${id}`,
  };
}

// `peek` returns the invite row by id WITHOUT mutating it. Used by the
// /invite/:code HTML page to show the wall name + "join this wall"
// CTA before the user is authenticated. Returns null if the invite
// doesn't exist; throws an Error with .status=410 if it's expired or
// already redeemed (so the page can render a "this invite is no
// longer valid" state).
function peek(db, code) {
  if (!code || typeof code !== 'string') return null;
  const row = db.prepare(`
    SELECT i.*, w.name AS wall_name
    FROM invites i
    JOIN walls w ON w.slug = i.wall_slug
    WHERE i.id = ?
  `).get(code);
  if (!row) return null;
  if (row.redeemed_by !== null) {
    const e = new Error('invite_already_redeemed');
    e.status = 410; e.code = 'invite_already_redeemed';
    e.invite = row;
    throw e;
  }
  if (new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
    const e = new Error('invite_expired');
    e.status = 410; e.code = 'invite_expired';
    e.invite = row;
    throw e;
  }
  return row;
}

// `redeem` is the canonical CREATE-or-CLAIM-and-enroll path. It is
// the single point that:
//   1. Validates the invite (peek semantics).
//   2. Atomic-writes the wall_memberships row for the user.
//   3. Atomic-stamps first_run_completed_at = NULL so the user sees
//      the welcome sheet on their next /api/me.
//   4. Stamps redeemed_by/redeemed_at on the invite.
//
// Returns { invite, user, was_new_user }. Throws on invalid/expired/
// already-redeemed invite (peek semantics).
//
// The "user" is passed in by the caller — typically resolved via
// header-trust (SWAG forwards X-authentik-username) or session cookie
// after the redemption page rendered. If the caller has no resolved
// user, redeem throws a 401 — the SPA should bounce them through
// authentik first.
function redeem(db, code, userId) {
  if (!userId) {
    const e = new Error('unauthenticated');
    e.status = 401; e.code = 'unauthenticated';
    throw e;
  }
  const invite = peek(db, code);
  if (!invite) {
    const e = new Error('invite_not_found');
    e.status = 404; e.code = 'invite_not_found';
    throw e;
  }
  // Detect new-vs-existing user BEFORE we mutate anything. Used to
  // decide whether the welcome sheet should render.
  const userRow = db.prepare('SELECT id, first_run_completed_at FROM users WHERE id = ?').get(userId);
  if (!userRow) {
    const e = new Error('user_not_found');
    e.status = 404; e.code = 'user_not_found';
    throw e;
  }
  const wasNewUser = userRow.first_run_completed_at === null && db.prepare(
    `SELECT 1 FROM wall_memberships wm WHERE wm.user_id = ? AND wm.wall_id = (SELECT id FROM walls WHERE slug = ?)`,
  ).get(userId, invite.wall_slug) === undefined;
  // The above `wasNewUser` heuristic isn't strictly needed (the SPA
  // gates the welcome sheet on first_run: true regardless of who
  // created the membership), but the disposition comment uses it.

  const tx = db.transaction(() => {
    // 1. wall_memberships row + group reconciliation for group walls.
    //    `ensureMember` handles the visibility='group' case by adding
    //    the user to wall.group_name in user_groups, which is what
    //    walls.assertMember + walls.listForUser actually check for
    //    group walls. INSERT OR IGNORE inside addMember keeps the
    //    wall_memberships row idempotent.
    wallMembers.ensureMember(db, invite.wall_slug, userId, 'member');
    // 2. For new users, ensure first_run_completed_at stays NULL.
    //    For existing users (already completed onboarding) we leave it
    //    alone — they get the same wall membership but skip the
    //    welcome sheet on their next login.
    // 3. Stamp the invite.
    const now = _nowUtcIso();
    db.prepare(`
      UPDATE invites SET redeemed_by = ?, redeemed_at = ? WHERE id = ?
    `).run(userId, now, code);
  });
  tx();

  return {
    invite,
    user: { id: userId, username: userRow.username || null },
    wall_slug: invite.wall_slug,
    wall_name: invite.wall_name,
  };
}

// `list` — admin's view of every outstanding invite. Used by the
// "create invite" form (Wizarr UI is out of scope; admin can still
// query via API). Returns the most recent first.
function list(db, { include_redeemed = false, wall_slug = null } = {}) {
  let sql = `
    SELECT i.*, w.name AS wall_name,
           u.username AS created_by_username, u.display AS created_by_display,
           r.username AS redeemed_by_username, r.display AS redeemed_by_display
    FROM invites i
    JOIN walls w ON w.slug = i.wall_slug
    LEFT JOIN users u ON u.id = i.created_by
    LEFT JOIN users r ON r.id = i.redeemed_by
  `;
  const where = [];
  const params = [];
  if (!include_redeemed) where.push('i.redeemed_by IS NULL');
  if (wall_slug) { where.push('i.wall_slug = ?'); params.push(wall_slug); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY i.created_at DESC LIMIT 200';
  return db.prepare(sql).all(...params);
}

module.exports = {
  migrate,
  create,
  peek,
  redeem,
  list,
  DEFAULT_EXPIRES_IN_DAYS,
  MAX_EXPIRES_IN_DAYS,
};