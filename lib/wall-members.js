// Homestead — wall membership helpers (PHA-2207 / PHA-2200.6).
//
// Thin layer over the existing `wall_memberships` table (defined in
// lib/walls.js) that exposes just the operations the invite-to-wall
// flow needs:
//
//   * addMember(db, wallSlug, userId, role)  — INSERT-OR-IGNORE; idempotent.
//   * getMembers(db, wallSlug)              — list members with profile data.
//   * ensureMember(db, wallSlug, userId)    — atomic pair: load wall + add.
//
// The DB schema is named `wall_memberships` (not `wall_members` as in
// the issue spec); this helper exists under the spec name because the
// PHA-2207 body calls the file `lib/wall-members.js`. Callers must use
// the schema name when writing SQL directly; this file is the only
// place that needs to remember the rename.
//
// `addMember` is intentionally INSERT-OR-IGNORE: the invite-redeem
// path is called twice for an existing user (once via the redemption
// handshake, once if they re-open the welcome sheet), and a duplicate
// wall_memberships row would violate the (wall_id, user_id) PK and
// abort the whole invite-redeem transaction.

'use strict';

const _membershipRole = new Set(['member', 'admin']);

function _setDb(db) { this._db = db; }
function _db() { return this._db; }

// `addMember` grants `userId` read+post access to the wall identified
// by `wallSlug`. Idempotent — re-running with the same pair is a no-op.
// Throws if the wall does not exist (caller should treat as 404).
function addMember(db, wallSlug, userId, role = 'member') {
  if (!_membershipRole.has(role)) {
    const e = new Error(`invalid_role: ${role}`);
    e.status = 400;
    e.code = 'invalid_role';
    throw e;
  }
  const wall = db.prepare('SELECT id FROM walls WHERE slug = ?').get(wallSlug);
  if (!wall) {
    const e = new Error('wall_not_found');
    e.status = 404;
    e.code = 'wall_not_found';
    throw e;
  }
  // INSERT OR IGNORE: a second call with the same (wall_id, user_id)
  // is silently dropped (the PK is (wall_id, user_id)).
  db.prepare(`
    INSERT OR IGNORE INTO wall_memberships (wall_id, user_id, role)
    VALUES (?, ?, ?)
  `).run(wall.id, userId, role);
  return { ok: true, wall_id: wall.id, user_id: userId, role };
}

// `getMembers` returns the list of profile rows for everyone in the
// wall. Includes display/color/avatar so the welcome sheet (PHA-2207)
// can render the "who else is here" avatars without a second round-trip.
// Ordered by joined_at so the original members surface first.
function getMembers(db, wallSlug) {
  const wall = db.prepare('SELECT id, slug, name, visibility FROM walls WHERE slug = ?').get(wallSlug);
  if (!wall) return null;
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display, u.color, u.avatar_url,
           wm.role, wm.joined_at
    FROM wall_memberships wm
    JOIN users u ON u.id = wm.user_id
    WHERE wm.wall_id = ?
    ORDER BY wm.joined_at ASC, u.username COLLATE NOCASE ASC
  `).all(wall.id);
  return { wall, members: rows };
}

// `ensureMember` is a convenience wrapper used by the invite-redeem
// path: it returns `{ok:true, wall}` if `userId` is already a member
// OR has just been added, and throws a 404 if the wall doesn't exist.
// Group walls also accept the caller via group membership (so
// provisionOrClaim → media-club group auto-grants access without an
// explicit addMember call). For direct walls, addMember is required.
function ensureMember(db, wallSlug, userId, role = 'member') {
  const wall = db.prepare('SELECT * FROM walls WHERE slug = ?').get(wallSlug);
  if (!wall) {
    const e = new Error('wall_not_found');
    e.status = 404;
    e.code = 'wall_not_found';
    throw e;
  }
  if (wall.visibility === 'group') {
    // Group walls derive membership from user_groups via groups.name.
    // The seed populates the 'media-club' group row, and any user
    // whose X-authentik-groups includes 'media-club' is auto-joined
    // via reconcileGroups(). Here we go a step further: even if the
    // user came in via header-trust WITHOUT the group (or via a
    // future direct-invite flow that bypasses authentik), we add
    // them to the group so assertMember + listForUser both see them.
    const userModel = require('./user-model');
    // Read current groups from user_groups, then merge in wall.group_name.
    const existing = db.prepare(`
      SELECT g.name FROM user_groups ug
      JOIN groups g ON g.id = ug.group_id WHERE ug.user_id = ?
    `).all(userId).map(r => r.name);
    const merged = Array.from(new Set([...existing, wall.group_name]));
    userModel.reconcileGroups(db, userId, merged);
    addMember(db, wallSlug, userId, role);
  } else {
    addMember(db, wallSlug, userId, role);
  }
  return { ok: true, wall };
}

module.exports = {
  addMember,
  getMembers,
  ensureMember,
};