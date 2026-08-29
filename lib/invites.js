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
//   redeemed_by  INTEGER REFERENCES users(id) — MOST RECENT redeemer (NULL until first redemption)
//   redeemed_at  TEXT                — MOST RECENT redemption time
//   note         TEXT                — admin's free-form note ("for the Tailor kid")
//   max_uses     INTEGER NOT NULL DEFAULT 1  — PHA-2664: how many times this code
//                                               can be redeemed before it 410s.
//   uses_count   INTEGER NOT NULL DEFAULT 0  — PHA-2664: running redemption count.
//
// PHA-2664 ("porch code"): invites used to be strictly single-use —
// `redeemed_by`/`redeemed_at` held the ONE redeemer and `peek()`
// 410'd on any second hit. That's too narrow for a members-only Ghost
// blog post that wants ONE shareable URL redeemable by up to 25
// different people over 14 days. `max_uses`/`uses_count` generalize
// the cap; `redeemed_by`/`redeemed_at` are kept as "most recent
// redeemer" purely for backward-compat display (admin list view,
// existing single-use callers). The full per-redemption history now
// lives in `invite_redemptions` — one row per successful redeem call,
// which doubles as the "redemption canary": query it to see exactly
// who redeemed a given porch code and when, to confirm it's being
// used as intended rather than passed around beyond its 25-use budget.
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
const DEFAULT_MAX_USES = 1;
const MAX_MAX_USES = 25;

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

  // PHA-2664: additive columns for multi-use ("porch code") invites.
  // ALTER TABLE ADD COLUMN has no IF NOT EXISTS in sqlite, so guard via
  // PRAGMA table_info (same pattern as lib/user-model.js).
  const inviteCols = db.prepare('PRAGMA table_info(invites)').all().map(c => c.name);
  if (!inviteCols.includes('max_uses')) {
    db.exec(`ALTER TABLE invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_USES}`);
  }
  if (!inviteCols.includes('uses_count')) {
    db.exec('ALTER TABLE invites ADD COLUMN uses_count INTEGER NOT NULL DEFAULT 0');
    // Backfill: any row that already has a redeemed_by counts as 1 use
    // under the old single-use contract.
    db.exec('UPDATE invites SET uses_count = 1 WHERE redeemed_by IS NOT NULL');
  }
  // PHA-2674: admin-initiated revocation. NULL means "not revoked".
  if (!inviteCols.includes('revoked_at')) {
    db.exec('ALTER TABLE invites ADD COLUMN revoked_at TEXT');
  }

  // PHA-2664: per-redemption history — the "redemption canary". One
  // row per successful redeem() call, independent of the
  // most-recent-redeemer columns on `invites`.
  db.exec(`
    CREATE TABLE IF NOT EXISTS invite_redemptions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      invite_id     TEXT NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
      user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
      redeemed_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_invite_redemptions_invite ON invite_redemptions(invite_id);
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

function _validateMaxUses(value) {
  if (value === undefined || value === null) return DEFAULT_MAX_USES;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    const e = new Error('max_uses must be an integer');
    e.status = 400; e.code = 'invalid_max_uses';
    throw e;
  }
  if (n < 1 || n > MAX_MAX_USES) {
    const e = new Error(`max_uses must be between 1 and ${MAX_MAX_USES}`);
    e.status = 400; e.code = 'invalid_max_uses';
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
function create(db, { wall_slug, expires_in_days, note, created_by, max_uses }) {
  const days = _validateExpiresInDays(expires_in_days);
  const uses = _validateMaxUses(max_uses);
  const wall = _validateWallSlug(db, wall_slug);
  const id = _newId();
  const now = _nowUtcIso();
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  db.prepare(`
    INSERT INTO invites (id, wall_slug, created_by, created_at, expires_at, note, max_uses)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, wall.slug, created_by || null, now, expires, note || null, uses);
  return {
    id,
    wall_slug: wall.slug,
    wall_name: wall.name,
    created_by: created_by || null,
    created_at: now,
    expires_at: expires,
    note: note || null,
    max_uses: uses,
    uses_count: 0,
    url: `https://life.phatt.vip/invite/${id}`,
  };
}

// `peek` returns the invite row by id WITHOUT mutating it. Used by the
// /invite/:code HTML page to show the wall name + "join this wall"
// CTA before the user is authenticated. Returns null if the invite
// doesn't exist; throws an Error with .status=410 if it's expired or
// already redeemed (so the page can render a "this invite is no
// longer valid" state).
//
// PHA-2711: also JOINs the creator's display name + username so the
// public redemption page can answer "who invited you?" without an
// extra round-trip. LEFT JOIN because the created_by FK is ON DELETE
// SET NULL — historical invites from a since-deleted admin still need
// to render.
function peek(db, code) {
  if (!code || typeof code !== 'string') return null;
  const row = db.prepare(`
    SELECT i.*, w.name AS wall_name,
           u.username AS created_by_username, u.display AS created_by_display
    FROM invites i
    JOIN walls w ON w.slug = i.wall_slug
    LEFT JOIN users u ON u.id = i.created_by
    WHERE i.id = ?
  `).get(code);
  if (!row) return null;
  if (row.revoked_at) {
    const e = new Error('invite_revoked');
    e.status = 410; e.code = 'invite_revoked';
    e.invite = row;
    throw e;
  }
  if (row.uses_count >= row.max_uses) {
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
    // 3. Record this redemption (the "canary") and stamp the invite's
    //    most-recent-redeemer columns + running uses_count. PHA-2664:
    //    a user re-redeeming their own already-used code (e.g. they
    //    lost their wall membership somehow and re-click the link)
    //    still counts as one redemption against the max_uses budget —
    //    wallMembers.ensureMember is already idempotent for the
    //    membership side, so there's no double-join risk, and treating
    //    every successful POST as one use keeps the accounting simple
    //    and matches what the redemption canary is meant to show: every
    //    time this code was actually used.
    const now = _nowUtcIso();
    db.prepare(`
      INSERT INTO invite_redemptions (invite_id, user_id, redeemed_at) VALUES (?, ?, ?)
    `).run(code, userId, now);
    db.prepare(`
      UPDATE invites SET redeemed_by = ?, redeemed_at = ?, uses_count = uses_count + 1 WHERE id = ?
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
  // PHA-2664: "redeemed" now means "exhausted" for multi-use invites
  // (uses_count >= max_uses), not merely "has ever been redeemed."
  if (!include_redeemed) where.push('i.uses_count < i.max_uses');
  if (wall_slug) { where.push('i.wall_slug = ?'); params.push(wall_slug); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY i.created_at DESC LIMIT 200';
  const nowMs = Date.now();
  return db.prepare(sql).all(...params).map(row => {
    let status = 'active';
    if (row.revoked_at) status = 'revoked';
    else if (row.uses_count >= row.max_uses) status = 'exhausted';
    else if (new Date(row.expires_at.replace(' ', 'T') + 'Z').getTime() < nowMs) status = 'expired';
    return { ...row, status };
  });
}

// `revoke` — admin kills an invite early (unredeemed or
// partially-consumed "porch codes" that are being passed around beyond
// their intended audience). Idempotent: revoking an already-revoked
// (or already-exhausted) code just returns the current row rather than
// throwing — only a genuinely unknown code is a 404. peek()/redeem()
// 410 with code `invite_revoked` once revoked_at is set.
function revoke(db, code) {
  if (!code || typeof code !== 'string') {
    const e = new Error('code required');
    e.status = 400; e.code = 'code_required';
    throw e;
  }
  const row = db.prepare('SELECT * FROM invites WHERE id = ?').get(code);
  if (!row) {
    const e = new Error('invite_not_found');
    e.status = 404; e.code = 'invite_not_found';
    throw e;
  }
  if (!row.revoked_at) {
    const now = _nowUtcIso();
    db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ?').run(now, code);
    row.revoked_at = now;
  }
  return row;
}

// PHA-2711: same-day closed-beta vertical path.
//
// `signupViaInvite(code, {username, display, password})`
//   Public, no-auth signup path. The full transaction:
//     1. peek() the invite (peek semantics: 410 on expired/exhausted/revoked).
//     2. identity.createUser() — creates users row + local_credentials row.
//     3. wallMembers.ensureMember() — adds the user to the invited wall.
//     4. Record the redemption in invite_redemptions + bump uses_count.
//   Anything in 1..4 failing rolls the whole thing back (db.transaction).
//   Returns { user, wall_slug, wall_name, first_run, redirect } on success.
//   On failure, throws an Error with .status + .code (404/409/410/400).
//
// `signinViaInvite(code, {username, password})`
//   Public, no-auth sign-in path for existing local users who want to
//   claim an invite on their existing account. Validates the local
//   credential via identity.verifyLocalPassword, then calls
//   wallMembers.ensureMember + stamps the redemption. Same 410
//   semantics as redeem() if the invite is no longer valid.
//
// Both paths NEVER auto-link by email, username, or display name (the
// PHA-2711 implementation boundary). The username is the directory key
// the new user chose for themselves; identity_links is untouched and
// remains PHA-2704/2706's job.

function signupViaInvite(db, code, { username, display, password }) {
  if (!code || typeof code !== 'string') {
    const e = new Error('invite code required');
    e.status = 400; e.code = 'invite_required';
    throw e;
  }
  // peek() throws 410 on expired/exhausted/revoked BEFORE we touch
  // anything else — so a poisoned invite can't burn a users row.
  const invite = peek(db, code);
  if (!invite) {
    const e = new Error('invite_not_found');
    e.status = 404; e.code = 'invite_not_found';
    throw e;
  }
  // Validate inputs client-side too, but never trust the client.
  const cleanUser = (typeof username === 'string' ? username : '').toLowerCase().trim();
  if (!/^[a-z0-9_-]{2,32}$/.test(cleanUser)) {
    const e = new Error('username must be 2-32 chars [a-z0-9_-]');
    e.status = 400; e.code = 'invalid_username';
    throw e;
  }
  const cleanDisplay = (typeof display === 'string' ? display.trim() : '') || cleanUser;
  if (cleanDisplay.length < 1 || cleanDisplay.length > 64) {
    const e = new Error('display name must be 1-64 chars');
    e.status = 400; e.code = 'invalid_display';
    throw e;
  }
  if (typeof password !== 'string' || password.length < 8) {
    const e = new Error('password must be at least 8 characters');
    e.status = 400; e.code = 'weak_password';
    throw e;
  }
  if (password.length > 256) {
    const e = new Error('password too long');
    e.status = 400; e.code = 'weak_password';
    throw e;
  }
  const identity = require('./identity');
  // Pre-check username collision OUTSIDE the tx so we can return the
  // right error code (409 collision vs the generic "couldn't create").
  // createUser also checks inside the tx for race safety; this pre-check
  // is just for clearer messaging.
  const dupe = db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUser);
  if (dupe) {
    const e = new Error(`username already taken: ${cleanUser}`);
    e.status = 409; e.code = 'username_taken';
    e.field = 'username';
    throw e;
  }
  // Pre-check invite capacity. peek() already returned ok, but in a
  // concurrent race a second request could bump uses_count past
  // max_uses between our peek and our INSERT. The tx guards that
  // re-check atomically.
  let result;
  try {
    result = db.transaction(() => {
      // Capacity re-check under the write lock.
      const recheck = db.prepare(`
        SELECT uses_count, max_uses FROM invites WHERE id = ?
      `).get(code);
      if (!recheck) {
        const e = new Error('invite_not_found');
        e.status = 404; e.code = 'invite_not_found';
        throw e;
      }
      if (recheck.uses_count >= recheck.max_uses) {
        const e = new Error('invite_already_redeemed');
        e.status = 410; e.code = 'invite_already_redeemed';
        throw e;
      }
      // 1. Create the user (users + local_credentials in one tx).
      const userId = identity.createUser(db, {
        username: cleanUser,
        display: cleanDisplay,
        plaintext: password,
        isAdmin: 0,
      });
      // 2. Add the user to the invited wall.
      wallMembers.ensureMember(db, invite.wall_slug, userId, 'member');
      // 3. Record the redemption + bump uses_count.
      const now = _nowUtcIso();
      db.prepare(`
        INSERT INTO invite_redemptions (invite_id, user_id, redeemed_at) VALUES (?, ?, ?)
      `).run(code, userId, now);
      db.prepare(`
        UPDATE invites SET redeemed_by = ?, redeemed_at = ?, uses_count = uses_count + 1 WHERE id = ?
      `).run(userId, now, code);
      return { userId, username: cleanUser, display: cleanDisplay };
    })();
  } catch (err) {
    // db.transaction rolls back automatically on throw; re-throw for
    // the route handler to map to HTTP.
    throw err;
  }
  return {
    user: { id: result.userId, username: result.username, display: result.display },
    invite,
    wall_slug: invite.wall_slug,
    wall_name: invite.wall_name,
    first_run: true, // fresh user — first_run_completed_at stays NULL
    redirect: `/welcome.html?wall=${encodeURIComponent(invite.wall_slug)}`,
  };
}

function signinViaInvite(db, code, { username, password }) {
  if (!code || typeof code !== 'string') {
    const e = new Error('invite code required');
    e.status = 400; e.code = 'invite_required';
    throw e;
  }
  // peek() throws 410 on expired/exhausted/revoked BEFORE we touch
  // the user table — so a poisoned invite can't even probe for valid
  // usernames.
  const invite = peek(db, code);
  if (!invite) {
    const e = new Error('invite_not_found');
    e.status = 404; e.code = 'invite_not_found';
    throw e;
  }
  const cleanUser = (typeof username === 'string' ? username : '').toLowerCase().trim();
  if (!cleanUser) {
    const e = new Error('username required');
    e.status = 400; e.code = 'invalid_username';
    throw e;
  }
  const userRow = db.prepare('SELECT id, username, display FROM users WHERE username = ?').get(cleanUser);
  // Use the same ambiguous-401 the /api/login endpoint uses — never
  // leak whether the username exists or just has the wrong password.
  const identity = require('./identity');
  if (!userRow || !identity.hasLocalCredential(db, userRow.id) || !identity.verifyLocalPassword(db, userRow.id, password || '')) {
    const e = new Error('Wrong username or password');
    e.status = 401; e.code = 'invalid_credentials';
    throw e;
  }
  // Atomic: capacity re-check + add membership + stamp redemption.
  let result;
  try {
    result = db.transaction(() => {
      const recheck = db.prepare('SELECT uses_count, max_uses FROM invites WHERE id = ?').get(code);
      if (!recheck) {
        const e = new Error('invite_not_found');
        e.status = 404; e.code = 'invite_not_found';
        throw e;
      }
      if (recheck.uses_count >= recheck.max_uses) {
        const e = new Error('invite_already_redeemed');
        e.status = 410; e.code = 'invite_already_redeemed';
        throw e;
      }
      wallMembers.ensureMember(db, invite.wall_slug, userRow.id, 'member');
      const now = _nowUtcIso();
      db.prepare(`
        INSERT INTO invite_redemptions (invite_id, user_id, redeemed_at) VALUES (?, ?, ?)
      `).run(code, userRow.id, now);
      db.prepare(`
        UPDATE invites SET redeemed_by = ?, redeemed_at = ?, uses_count = uses_count + 1 WHERE id = ?
      `).run(userRow.id, now, code);
      return { userId: userRow.id };
    })();
  } catch (err) {
    throw err;
  }
  // Existing user — check first_run state for the welcome redirect.
  const isFirstRun = db.prepare('SELECT first_run_completed_at FROM users WHERE id = ?').get(result.userId)?.first_run_completed_at === null;
  return {
    user: { id: result.userId, username: userRow.username, display: userRow.display },
    invite,
    wall_slug: invite.wall_slug,
    wall_name: invite.wall_name,
    first_run: isFirstRun,
    redirect: `/welcome.html?wall=${encodeURIComponent(invite.wall_slug)}`,
  };
}

// `createResetToken` — PHA-2711 break-glass owner recovery. Mints a
// single-use recovery token for a user_id that has a local credential.
// Returns { token, expiresAt }. The token is hashed (sha256) before
// storage so a stolen DB doesn't yield a usable token.
function createResetToken(db, userId, ttlMs = 60 * 60 * 1000) {
  const token = crypto.randomBytes(24).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expires = new Date(Date.now() + ttlMs).toISOString().replace('T', ' ').slice(0, 19);
  // Clear any prior unexpired tokens first — only one active per user.
  db.prepare(`UPDATE local_credentials SET recovery_token_hash = NULL, recovery_token_expires_at = NULL WHERE user_id = ?`).run(userId);
  db.prepare(`UPDATE local_credentials SET recovery_token_hash = ?, recovery_token_expires_at = ? WHERE user_id = ?`).run(tokenHash, expires, userId);
  return { token, expiresAt: expires };
}

// `consumeResetToken` — verifies a plaintext token against the stored
// hash, checks expiry, and atomically replaces the password. Returns
// the user_id on success; throws on bad/expired/missing token.
function consumeResetToken(db, token, newPassword) {
  if (!token || typeof token !== 'string') {
    const e = new Error('reset_token required');
    e.status = 400; e.code = 'reset_token_required';
    throw e;
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    const e = new Error('new password must be at least 8 characters');
    e.status = 400; e.code = 'weak_password';
    throw e;
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = db.prepare(`
    SELECT lc.user_id, lc.recovery_token_expires_at
    FROM local_credentials lc
    WHERE lc.recovery_token_hash = ?
  `).get(tokenHash);
  if (!row) {
    const e = new Error('invalid or used reset token');
    e.status = 401; e.code = 'invalid_reset_token';
    throw e;
  }
  if (!row.recovery_token_expires_at || new Date(row.recovery_token_expires_at.replace(' ', 'T') + 'Z').getTime() < Date.now()) {
    const e = new Error('reset token expired');
    e.status = 401; e.code = 'reset_token_expired';
    throw e;
  }
  const identity = require('./identity');
  let userId;
  try {
    db.transaction(() => {
      identity.setLocalPassword(db, row.user_id, newPassword);
      // Clear the used token so it can't be replayed.
      db.prepare(`UPDATE local_credentials SET recovery_token_hash = NULL, recovery_token_expires_at = NULL WHERE user_id = ?`).run(row.user_id);
      // Keep users.pass_hash shadow column in sync.
      db.prepare(`UPDATE users SET pass_hash = (SELECT password_hash FROM local_credentials WHERE user_id = ?) WHERE id = ?`).run(row.user_id, row.user_id);
      userId = row.user_id;
    })();
  } catch (err) {
    throw err;
  }
  return userId;
}

module.exports = {
  migrate,
  create,
  peek,
  redeem,
  list,
  revoke,
  signupViaInvite,
  signinViaInvite,
  createResetToken,
  consumeResetToken,
  DEFAULT_EXPIRES_IN_DAYS,
  MAX_EXPIRES_IN_DAYS,
  DEFAULT_MAX_USES,
  MAX_MAX_USES,
};