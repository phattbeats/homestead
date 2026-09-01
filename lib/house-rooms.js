// Homestead — house rooms (PHA-2852).
//
// Rooms-as-LOCATIONS-OF-THE-HOUSE. This is deliberately NOT the same
// concept as the `room` discriminator in `lib/modules.js`, which is an
// in-SPA nav/view key (`porch`, `r-lists`, `r-calendar`, `tasks`,
// `svc`). That one answers "which screen am I on"; this one answers
// "where in the house did this happen" — HALL, DEN, KITCHEN. The
// Gazette (PHA-2849's sibling child) prints listings like
// "6:00 — Blake call — HALL" and until now was inventing those names
// out of nothing.
//
// Ownership model (issue §1, and the explicit v2 note in it):
//   * Each user owns their rooms independently. There is NO global
//     room registry — `house_rooms` is keyed by `owner_user_id`, and
//     two households on one install never see each other's HALL.
//   * `house_room_members` grants read to other users. The whole ACL
//     is "owner manages, members read" — anything richer (per-room
//     write grants, sharing a room across owners) is the v2
//     conversation the issue defers.
//
// Slug uniqueness is scoped per-owner AND per-active — the unique
// index is partial on `archived_at IS NULL`, so archiving KITCHEN and
// later making a new KITCHEN works instead of colliding forever.
// `resolveRoom()` prefers the active row and falls back to the most
// recent archived one, which is what makes un-archiving by slug work.
//
// Auth posture: these are `/api/me/*` routes gated by `auth` only —
// the same posture as /api/me/modules and /api/me/layout. No new
// scope strings are minted here, so nothing needs to be added to the
// locked PHA-2201 §3 vocabulary in lib/scope-display.js.

'use strict';

const crypto = require('crypto');

const LABEL_MAX = 60;
const SLUG_MAX = 32;
const ICON_MAX = 8;
const ROOMS_MAX_LIMIT = 200;

const ROOM_ROLES = Object.freeze(['owner', 'resident']);
const DEFAULT_ROOM_ROLE = 'resident';
const DEFAULT_ROOM_ICON = '🚪';

// Slugs the API can never address because a sibling literal route
// already owns that path segment (GET /api/me/rooms/proposals is
// declared before /api/me/rooms/:slug). Creating one would make an
// unreachable room, so reject it at the source instead.
const RESERVED_SLUGS = Object.freeze(['proposals']);

// First-run tutorial stubs (issue §4). These are PROPOSALS, not a
// seed: nothing is written until the user accepts them, either
// wholesale ("accept all") or after editing the labels. A brand-new
// account with no rooms is a valid state — the Gazette just has
// nothing to print a location for.
const DEFAULT_ROOM_PROPOSALS = Object.freeze([
  Object.freeze({ slug: 'hall', label: 'Hall', icon: '🚪' }),
  Object.freeze({ slug: 'den', label: 'Den', icon: '🛋️' }),
  Object.freeze({ slug: 'kitchen', label: 'Kitchen', icon: '🍳' }),
]);

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS house_rooms (
      id             TEXT PRIMARY KEY,
      owner_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug           TEXT NOT NULL,
      label          TEXT NOT NULL,
      icon           TEXT NOT NULL DEFAULT '${DEFAULT_ROOM_ICON}',
      ordering       INTEGER NOT NULL DEFAULT 0,
      archived_at    TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Partial unique: one ACTIVE room per (owner, slug). Archived rows
    -- are exempt so a slug can be reused after archiving.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_house_rooms_owner_slug_active
      ON house_rooms(owner_user_id, slug) WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_house_rooms_owner_order
      ON house_rooms(owner_user_id, archived_at, ordering, created_at);

    CREATE TABLE IF NOT EXISTS house_room_members (
      room_id         TEXT NOT NULL REFERENCES house_rooms(id) ON DELETE CASCADE,
      member_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      room_role       TEXT NOT NULL DEFAULT '${DEFAULT_ROOM_ROLE}'
                             CHECK(room_role IN ('owner','resident')),
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (room_id, member_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_house_room_members_user
      ON house_room_members(member_user_id, room_id);
  `);

  // Additive column migration for the acceptance criterion "calendar
  // events can be tagged room_id and filtered". `events` is owned by
  // lib/user-model.js, but the FK target only exists once the CREATE
  // TABLE above has run, so the ALTER lives here and this module must
  // migrate after userModel. ON DELETE SET NULL: hard-deleting a room
  // must not take the event with it.
  const eventCols = db.prepare('PRAGMA table_info(events)').all().map(c => c.name);
  if (eventCols.length && !eventCols.includes('room_id')) {
    db.exec('ALTER TABLE events ADD COLUMN room_id TEXT REFERENCES house_rooms(id) ON DELETE SET NULL');
  }
  if (eventCols.length) {
    db.exec('CREATE INDEX IF NOT EXISTS idx_events_room_date ON events(room_id, date, time)');
  }
}

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function trimOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/^\s+|\s+$/g, '');
  return s.length ? s : null;
}

// slugify(label) — "Back Porch" -> "back-porch". Used when a caller
// POSTs a label without a slug. Returns null when nothing survives
// (e.g. a label of only emoji), which the caller turns into a 400.
function slugify(label) {
  const s = String(label == null ? '' : label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return s.length ? s : null;
}

function assertValidSlug(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) {
    throw httpError(400, 'invalid_slug');
  }
  if (RESERVED_SLUGS.includes(slug)) throw httpError(400, 'reserved_slug');
}

function normalizeLabel(v) {
  const label = trimOrNull(v);
  if (!label) throw httpError(400, 'label_required');
  if (label.length > LABEL_MAX) throw httpError(400, 'label_too_long');
  return label;
}

function normalizeIcon(v) {
  const icon = trimOrNull(v);
  if (icon === null) return DEFAULT_ROOM_ICON;
  if ([...icon].length > ICON_MAX) throw httpError(400, 'icon_too_long');
  return icon;
}

function roomView(row, role) {
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    slug: row.slug,
    label: row.label,
    icon: row.icon,
    ordering: row.ordering,
    archived: row.archived_at !== null && row.archived_at !== undefined,
    archived_at: row.archived_at || null,
    created_at: row.created_at,
    role: role || null,
  };
}

// ---- resolution + access ------------------------------------------------

// resolveRoom(db, userId, ref) — `ref` is a slug or a room id. Only
// rooms the user can SEE (owns, or is a member of) resolve; everything
// else is indistinguishable from "does not exist", so a probing caller
// can't enumerate another user's room slugs.
//
// Preference order matters for un-archiving by slug: the active room
// wins, otherwise the most recently created archived one.
function resolveRoom(db, userId, ref) {
  if (typeof ref !== 'string' || !ref.length) return null;
  return db.prepare(`
    SELECT r.* FROM house_rooms r
     WHERE (r.id = ? OR r.slug = ?)
       AND (r.owner_user_id = ?
            OR EXISTS (SELECT 1 FROM house_room_members m
                        WHERE m.room_id = r.id AND m.member_user_id = ?))
     ORDER BY (r.archived_at IS NULL) DESC, r.created_at DESC
     LIMIT 1
  `).get(ref, ref, userId, userId) || null;
}

// roleFor(db, userId, row) — 'owner' | 'resident' | null.
function roleFor(db, userId, row) {
  if (row.owner_user_id === userId) return 'owner';
  const m = db.prepare(
    'SELECT room_role FROM house_room_members WHERE room_id = ? AND member_user_id = ?'
  ).get(row.id, userId);
  return m ? m.room_role : null;
}

// requireRoom / requireOwnedRoom — the two gates every write goes
// through. "Owner manages, members read" is enforced in exactly these
// two functions, nowhere else.
function requireRoom(db, userId, ref) {
  const row = resolveRoom(db, userId, ref);
  if (!row) throw httpError(404, 'room_not_found');
  return row;
}

function requireOwnedRoom(db, userId, ref) {
  const row = requireRoom(db, userId, ref);
  if (row.owner_user_id !== userId) throw httpError(403, 'not_room_owner');
  return row;
}

// ---- rooms -------------------------------------------------------------

// listRooms(db, userId, opts) — rooms the user owns plus rooms they've
// been added to, in (ordering, created_at) order. Archived rooms are
// excluded unless asked for.
function listRooms(db, userId, opts) {
  opts = opts || {};
  const limit = Math.min(Math.max(1, opts.limit || ROOMS_MAX_LIMIT), ROOMS_MAX_LIMIT);
  const archivedClause = opts.includeArchived ? '' : 'AND r.archived_at IS NULL';
  const rows = db.prepare(`
    SELECT r.*,
           CASE WHEN r.owner_user_id = ? THEN 'owner' ELSE m.room_role END AS role
      FROM house_rooms r
      LEFT JOIN house_room_members m
             ON m.room_id = r.id AND m.member_user_id = ?
     WHERE (r.owner_user_id = ? OR m.member_user_id IS NOT NULL)
       ${archivedClause}
     ORDER BY r.ordering ASC, r.created_at ASC
     LIMIT ?
  `).all(userId, userId, userId, limit);
  return rows.map(r => roomView(r, r.role));
}

function getRoom(db, userId, ref) {
  const row = requireRoom(db, userId, ref);
  return roomView(row, roleFor(db, userId, row));
}

// createRoom(db, userId, body) — `slug` is optional and derived from
// `label` when absent. The owner also gets an explicit member row with
// room_role 'owner' so GET .../members returns the full cast; the
// authoritative permission check is still `owner_user_id`.
function createRoom(db, userId, body) {
  body = body || {};
  const label = normalizeLabel(body.label);
  const slug = trimOrNull(body.slug) || slugify(label);
  if (!slug) throw httpError(400, 'invalid_slug');
  assertValidSlug(slug);
  const icon = normalizeIcon(body.icon);

  const clash = db.prepare(
    'SELECT id FROM house_rooms WHERE owner_user_id = ? AND slug = ? AND archived_at IS NULL'
  ).get(userId, slug);
  if (clash) throw httpError(409, 'slug_taken');

  let ordering = body.ordering;
  if (ordering === undefined || ordering === null || !Number.isFinite(Number(ordering))) {
    ordering = db.prepare(
      'SELECT COALESCE(MAX(ordering), -1) AS o FROM house_rooms WHERE owner_user_id = ?'
    ).get(userId).o + 1;
  }

  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO house_rooms (id, owner_user_id, slug, label, icon, ordering)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, slug, label, icon, Math.trunc(Number(ordering)));
    db.prepare(`
      INSERT INTO house_room_members (room_id, member_user_id, room_role)
      VALUES (?, ?, 'owner')
    `).run(id, userId);
  });
  tx();
  return getRoom(db, userId, id);
}

// updateRoom — owner-only. Accepts label / icon / ordering / slug and
// `archived` (false un-archives, which is why resolveRoom falls back
// to archived rows).
function updateRoom(db, userId, ref, body) {
  body = body || {};
  const cur = requireOwnedRoom(db, userId, ref);

  const label = body.label === undefined ? cur.label : normalizeLabel(body.label);
  const icon = body.icon === undefined ? cur.icon : normalizeIcon(body.icon);

  let slug = cur.slug;
  if (body.slug !== undefined) {
    slug = trimOrNull(body.slug);
    if (!slug) throw httpError(400, 'invalid_slug');
    assertValidSlug(slug);
  }

  let ordering = cur.ordering;
  if (body.ordering !== undefined && body.ordering !== null) {
    if (!Number.isFinite(Number(body.ordering))) throw httpError(400, 'invalid_ordering');
    ordering = Math.trunc(Number(body.ordering));
  }

  let archivedAt = cur.archived_at;
  if (body.archived !== undefined) {
    archivedAt = body.archived ? (cur.archived_at || nowStamp(db)) : null;
  }

  // Un-archiving or renaming can collide with a live room on the same
  // slug — check before writing so the caller gets 409, not a raw
  // SQLite constraint 500.
  if (archivedAt === null) {
    const clash = db.prepare(`
      SELECT id FROM house_rooms
       WHERE owner_user_id = ? AND slug = ? AND archived_at IS NULL AND id != ?
    `).get(userId, slug, cur.id);
    if (clash) throw httpError(409, 'slug_taken');
  }

  db.prepare(`
    UPDATE house_rooms SET slug = ?, label = ?, icon = ?, ordering = ?, archived_at = ?
     WHERE id = ?
  `).run(slug, label, icon, ordering, archivedAt, cur.id);
  return getRoom(db, userId, cur.id);
}

// archiveRoom — the DELETE verb. Soft only: `archived_at` is stamped
// and the row (plus any events tagged to it) survives. Idempotent.
function archiveRoom(db, userId, ref) {
  const cur = requireOwnedRoom(db, userId, ref);
  if (!cur.archived_at) {
    db.prepare('UPDATE house_rooms SET archived_at = ? WHERE id = ?').run(nowStamp(db), cur.id);
  }
  return getRoom(db, userId, cur.id);
}

// nowStamp — same `datetime('now')` format the DEFAULTs write, so
// archived_at is comparable to created_at as a plain string.
function nowStamp(db) {
  return db.prepare("SELECT datetime('now') AS t").get().t;
}

// ---- members -----------------------------------------------------------

function listMembers(db, userId, ref) {
  const room = requireRoom(db, userId, ref);
  const rows = db.prepare(`
    SELECT m.member_user_id, m.room_role, m.created_at,
           u.username, u.display
      FROM house_room_members m
      JOIN users u ON u.id = m.member_user_id
     WHERE m.room_id = ?
     ORDER BY (m.room_role = 'owner') DESC, m.created_at ASC
  `).all(room.id);
  return rows.map(r => ({
    user_id: r.member_user_id,
    username: r.username,
    display: r.display,
    room_role: r.room_role,
    created_at: r.created_at,
  }));
}

// addMember — owner-only. Takes `user_id` or `username`. `room_role`
// defaults to 'resident'; 'owner' is not assignable here because
// ownership transfer is a different (unscoped) operation.
function addMember(db, userId, ref, body) {
  body = body || {};
  const room = requireOwnedRoom(db, userId, ref);
  let target = null;
  if (body.user_id !== undefined && body.user_id !== null) {
    target = db.prepare('SELECT id FROM users WHERE id = ?').get(Number(body.user_id));
  } else if (trimOrNull(body.username)) {
    target = db.prepare('SELECT id FROM users WHERE username = ?').get(trimOrNull(body.username));
  } else {
    throw httpError(400, 'user_required');
  }
  if (!target) throw httpError(404, 'user_not_found');

  const role = body.room_role === undefined ? DEFAULT_ROOM_ROLE : body.room_role;
  if (!ROOM_ROLES.includes(role)) throw httpError(400, 'invalid_room_role');
  if (role === 'owner' && target.id !== room.owner_user_id) {
    throw httpError(400, 'owner_role_not_assignable');
  }

  db.prepare(`
    INSERT INTO house_room_members (room_id, member_user_id, room_role)
    VALUES (?, ?, ?)
    ON CONFLICT(room_id, member_user_id) DO UPDATE SET room_role = excluded.room_role
  `).run(room.id, target.id, role);
  return listMembers(db, userId, room.id);
}

// removeMember — owner-only, and the owner's own row is not removable
// (it would strip the room from its owner's members listing while
// leaving them owner, which is just an inconsistent view).
function removeMember(db, userId, ref, memberUserId) {
  const room = requireOwnedRoom(db, userId, ref);
  const id = Number(memberUserId);
  if (!Number.isFinite(id)) throw httpError(400, 'invalid_user_id');
  if (id === room.owner_user_id) throw httpError(400, 'cannot_remove_owner');
  db.prepare('DELETE FROM house_room_members WHERE room_id = ? AND member_user_id = ?')
    .run(room.id, id);
  return listMembers(db, userId, room.id);
}

// ---- first-run proposals (issue §4) ------------------------------------

// listProposals(db, userId) — the three stubs, each flagged with
// whether the user already has that slug live. `pending` is what an
// "accept all" would actually create.
function listProposals(db, userId) {
  const proposals = DEFAULT_ROOM_PROPOSALS.map((p) => {
    const existing = db.prepare(
      'SELECT id FROM house_rooms WHERE owner_user_id = ? AND slug = ? AND archived_at IS NULL'
    ).get(userId, p.slug);
    return { slug: p.slug, label: p.label, icon: p.icon, exists: !!existing };
  });
  const roomCount = db.prepare(
    'SELECT COUNT(*) AS c FROM house_rooms WHERE owner_user_id = ? AND archived_at IS NULL'
  ).get(userId).c;
  return {
    proposals,
    pending: proposals.filter(p => !p.exists),
    room_count: roomCount,
  };
}

// acceptProposals(db, userId, rooms) — accept-all (rooms omitted) or
// edit-and-accept (rooms supplied, each `{slug?, label, icon?}`). An
// edited entry may rename the label and keep the stub slug, or change
// both. Already-live slugs are skipped rather than 409'd: the tutorial
// is re-runnable and half-accepting it once shouldn't wedge it.
function acceptProposals(db, userId, rooms) {
  let wanted;
  if (rooms === undefined || rooms === null) {
    wanted = DEFAULT_ROOM_PROPOSALS.map(p => ({ ...p }));
  } else {
    if (!Array.isArray(rooms)) throw httpError(400, 'rooms_must_be_array');
    if (rooms.length > DEFAULT_ROOM_PROPOSALS.length) throw httpError(400, 'too_many_rooms');
    wanted = rooms.map(r => ({
      slug: (r && trimOrNull(r.slug)) || null,
      label: r && r.label,
      icon: r && r.icon,
    }));
  }

  const created = [];
  const skipped = [];
  for (const w of wanted) {
    const label = normalizeLabel(w.label);
    const slug = w.slug || slugify(label);
    if (!slug) throw httpError(400, 'invalid_slug');
    assertValidSlug(slug);
    const existing = db.prepare(
      'SELECT id FROM house_rooms WHERE owner_user_id = ? AND slug = ? AND archived_at IS NULL'
    ).get(userId, slug);
    if (existing) { skipped.push(slug); continue; }
    created.push(createRoom(db, userId, { slug, label, icon: w.icon }));
  }
  return { created, skipped, rooms: listRooms(db, userId, {}) };
}

// ---- event tagging (acceptance: "events happening in HALL today") ------

// resolveRoomIdForWrite(db, userId, ref) — validates a room reference
// supplied on an event write. Returns null for an explicit clear
// (null / ''), throws 404 for a room the caller can't see. Archived
// rooms are still taggable — an event in a since-archived room is
// history, not an error.
function resolveRoomIdForWrite(db, userId, ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  return requireRoom(db, userId, ref).id;
}

// listEventsInRoom(db, userId, ref, opts) — the acceptance query.
// `{ from, to }` bound it to a day ("events happening in HALL today")
// or any range. Rows come back with the room joined on as columns, so
// the Gazette can print "6:00 — Blake call — HALL" from one query.
function listEventsInRoom(db, userId, ref, opts) {
  opts = opts || {};
  const room = requireRoom(db, userId, ref);
  const where = ['e.room_id = ?'];
  const params = [room.id];
  if (opts.from) { where.push('e.date >= ?'); params.push(opts.from); }
  if (opts.to) { where.push('e.date <= ?'); params.push(opts.to); }
  return db.prepare(`
    SELECT e.*, r.slug AS room_slug, r.label AS room_label, r.icon AS room_icon
      FROM events e
      JOIN house_rooms r ON r.id = e.room_id
     WHERE ${where.join(' AND ')}
     ORDER BY e.date ASC, e.time ASC
     LIMIT ?
  `).all(...params, Math.min(Math.max(1, opts.limit || 200), 500));
}

// joinRoomColumns(db, rows) — decorate an already-fetched event list
// with its room columns. Used by GET /api/events so every event
// response carries `room_slug`/`room_label` whether or not the caller
// filtered by room. Rooms the caller can't see are left undecorated
// rather than leaking another user's labels.
function joinRoomColumns(db, userId, rows) {
  if (!Array.isArray(rows) || !rows.length) return rows || [];
  const ids = Array.from(new Set(rows.map(r => r.room_id).filter(Boolean)));
  if (!ids.length) return rows;
  const visible = new Map();
  for (const id of ids) {
    const row = resolveRoom(db, userId, id);
    if (row) visible.set(id, row);
  }
  return rows.map((r) => {
    const room = r.room_id ? visible.get(r.room_id) : null;
    return {
      ...r,
      room_slug: room ? room.slug : null,
      room_label: room ? room.label : null,
      room_icon: room ? room.icon : null,
    };
  });
}

module.exports = {
  migrate,
  DEFAULT_ROOM_PROPOSALS,
  ROOM_ROLES,
  DEFAULT_ROOM_ROLE,
  RESERVED_SLUGS,
  slugify,
  listRooms,
  getRoom,
  createRoom,
  updateRoom,
  archiveRoom,
  listMembers,
  addMember,
  removeMember,
  listProposals,
  acceptProposals,
  resolveRoom,
  resolveRoomIdForWrite,
  listEventsInRoom,
  joinRoomColumns,
  // exposed for unit tests
  roomView,
  roleFor,
};
