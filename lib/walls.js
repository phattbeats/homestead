// Homestead — walls, posts, reactions, comments (PHA-2150 / PHA-2147.2).
//
// Group-scoped and direct-share "walls" of chronological posts, built on
// top of the media primitive (PHA-2149 / lib/media.js). Constitutional
// compliance is baked into every query here: membership is checked
// before any read or write, and every public-facing listing carries a
// hard-coded `ORDER BY created_at` + `LIMIT` — see scripts/test-walls.js
// for the grep guard against future "sort by reactions" PRs.
//
// Membership gate (the constitutional heart): `assertMember(slug, userId)`
// returns `{ok:true, wall}` or throws an error with `.status = 404` —
// wall existence is private to its members, so a visibility miss and a
// slug that doesn't exist look identical to the caller.

'use strict';

const crypto = require('crypto');
const notifications = require('./notifications');
const analytics = require('./analytics');

const REACTION_EMOJI = new Set(['+1', 'joy', 'fire', 'eyes', 'heart']);
const POST_KINDS = new Set(['image', 'video', 'link', 'text']);
const COMMENT_MAX_LEN = 1000;
const POSTS_DEFAULT_LIMIT = 20;
const POSTS_MAX_LIMIT = 50;

let _db = null;

function migrate(db) {
  _db = db;
  db.exec(`
    -- Mirrors server.js's notification_log DDL exactly (PHA-1619). Declared
    -- here too (IF NOT EXISTS) so createPost's activity-row insert
    -- (PHA-2153 / PHA-2147.5) has a table to write to even when walls.migrate()
    -- runs before server.js's inline schema block, e.g. in scripts/test-walls.js.
    CREATE TABLE IF NOT EXISTS notification_log (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      url TEXT,
      tag TEXT,
      delivered INTEGER NOT NULL DEFAULT 0,
      skipped_reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notification_log_user ON notification_log(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS walls (
      id              TEXT PRIMARY KEY,
      slug            TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      visibility      TEXT NOT NULL CHECK(visibility IN ('group','direct')),
      group_name      TEXT,
      retention_days  INTEGER,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS wall_memberships (
      wall_id         TEXT NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role            TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
      notifications   INTEGER NOT NULL DEFAULT 1,
      joined_at       TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (wall_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS wall_posts (
      id                TEXT PRIMARY KEY,
      wall_id           TEXT NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
      author_user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind              TEXT NOT NULL CHECK(kind IN ('image','video','link','text')),
      media_id          TEXT REFERENCES media_uploads(id) ON DELETE SET NULL,
      text_body         TEXT,
      link_url          TEXT,
      link_title        TEXT,
      link_description  TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_wall_posts_wall_created ON wall_posts(wall_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS post_reactions (
      id              INTEGER PRIMARY KEY,
      post_id         TEXT NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji           TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(post_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS post_comments (
      id              INTEGER PRIMARY KEY,
      post_id         TEXT NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
      author_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body            TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id, created_at ASC);
  `);

  // PHA-2218: per-wall notification prefs, @mentions, thread mutes.
  // Runs after the tables above so its FKs (walls, wall_posts,
  // post_comments) and the users(id)/user_groups/groups FKs from
  // userModel.migrate (already run before walls.migrate — see server.js
  // require order) all exist.
  notifications.migrate(db);
}

// seed(db): the one wall Phase 1 ships with is the Household Porch —
// household-scoped, so every seeded user (admin / brandon / emily,
// all already in `household` per lib/user-model.js's seed) can see it
// immediately on first boot, with no manual group grants.
//
// PHA-2556 closed PHA-2493 with `media-club` / group-scoped semantics
// for the same wall, which made it invisible: the seed only puts
// seeded users in `household`, never `media-club`, so a fresh boot
// yielded `GET /api/walls → {"walls":[]}` and the Porch tab rendered
// the "No walls yet" empty state. The previous smoke test masked
// this by writing the membership itself, which is exactly the bug.
// `visibility='group', group_name='household'` lines up the wall's
// visibility rule with the seeded users' group membership.
function seed(db) {
  const existing = db.prepare('SELECT id FROM walls WHERE slug = ?').get('household');
  if (existing) return;
  db.prepare(`
    INSERT INTO walls (id, slug, name, visibility, group_name)
    VALUES (?, 'household', 'Household Porch', 'group', 'household')
  `).run(crypto.randomUUID());
}

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

// assertMember(slug, userId): membership gate. Group walls check
// user_groups via a single prepared statement (mirrors the header-trust
// reconciliation in lib/user-model.js); direct walls check
// wall_memberships. Any miss is a 404 — wall existence is private to
// its members, not just wall contents.
function assertMember(slug, userId) {
  const wall = _db.prepare('SELECT * FROM walls WHERE slug = ?').get(slug);
  if (!wall) throw httpError(404, 'not_found');

  if (wall.visibility === 'group') {
    const row = _db.prepare(`
      SELECT 1 FROM user_groups ug
      JOIN groups g ON g.id = ug.group_id
      WHERE ug.user_id = ? AND g.name = ?
    `).get(userId, wall.group_name);
    if (!row) throw httpError(404, 'not_found');
  } else {
    const row = _db.prepare('SELECT 1 FROM wall_memberships WHERE wall_id = ? AND user_id = ?').get(wall.id, userId);
    if (!row) throw httpError(404, 'not_found');
  }
  return { ok: true, wall };
}

// listForUser(userId): walls visible via group membership OR direct
// wall_memberships row, deduped by wall id.
function listForUser(userId) {
  const rows = _db.prepare(`
    SELECT DISTINCT w.* FROM walls w
    LEFT JOIN user_groups ug ON w.visibility = 'group' AND ug.user_id = ?
    LEFT JOIN groups g ON g.id = ug.group_id AND g.name = w.group_name
    LEFT JOIN wall_memberships wm ON w.visibility = 'direct' AND wm.wall_id = w.id AND wm.user_id = ?
    WHERE (w.visibility = 'group' AND g.id IS NOT NULL)
       OR (w.visibility = 'direct' AND wm.wall_id IS NOT NULL)
    ORDER BY w.created_at ASC
  `).all(userId, userId);
  return rows.map((w) => ({ slug: w.slug, name: w.name, visibility: w.visibility }));
}

function userView(userId) {
  const u = _db.prepare('SELECT id, username, display FROM users WHERE id = ?').get(userId);
  return u ? { username: u.username, display: u.display } : null;
}

function reactionSummary(postId) {
  const rows = _db.prepare('SELECT emoji, COUNT(*) c FROM post_reactions WHERE post_id = ? GROUP BY emoji').all(postId);
  const summary = {};
  for (const r of rows) summary[r.emoji] = r.c;
  return summary;
}

function myReactions(postId, userId) {
  const rows = _db.prepare('SELECT emoji FROM post_reactions WHERE post_id = ? AND user_id = ?').all(postId, userId);
  return rows.map((r) => r.emoji);
}

function commentCount(postId) {
  return _db.prepare('SELECT COUNT(*) c FROM post_comments WHERE post_id = ?').get(postId).c;
}

function postView(row, userId) {
  return {
    id: row.id,
    author: userView(row.author_user_id),
    kind: row.kind,
    mediaId: row.media_id || null,
    text: row.text_body || null,
    link: row.kind === 'link' ? { url: row.link_url, title: row.link_title, description: row.link_description } : null,
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    reactionSummary: reactionSummary(row.id),
    myReactions: myReactions(row.id, userId),
    commentCount: commentCount(row.id),
  };
}

// postsForWall(slug, callerId, cursor, limit): strictly chronological
// (created_at DESC), hard-capped at POSTS_MAX_LIMIT regardless of the
// caller-supplied limit.
function postsForWall(slug, callerId, cursor, limit) {
  const { wall } = assertMember(slug, callerId);
  const cap = Math.min(Math.max(parseInt(limit, 10) || POSTS_DEFAULT_LIMIT, 1), POSTS_MAX_LIMIT);

  let rows;
  if (cursor) {
    rows = _db.prepare(`
      SELECT * FROM wall_posts WHERE wall_id = ? AND created_at < ?
      ORDER BY created_at DESC LIMIT ?
    `).all(wall.id, cursor, cap);
  } else {
    rows = _db.prepare(`
      SELECT * FROM wall_posts WHERE wall_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(wall.id, cap);
  }
  return rows.map((r) => postView(r, callerId));
}

// createPost(slug, callerId, body): body = {kind, media_id?, text_body?,
// link_url?, link_title?, link_description?}.
function createPost(slug, callerId, body) {
  const { wall } = assertMember(slug, callerId);
  const kind = body && body.kind;
  if (!POST_KINDS.has(kind)) throw httpError(400, 'invalid_kind');

  if (kind === 'image' || kind === 'video') {
    if (!body.media_id) throw httpError(400, 'media_id_required');
  } else if (kind === 'text') {
    const text = (body.text_body || '').trim();
    if (!text) throw httpError(400, 'text_body_required');
  } else if (kind === 'link') {
    if (!body.link_url) throw httpError(400, 'link_url_required');
  }

  let expiresAt = null;
  if (wall.retention_days) {
    expiresAt = _db.prepare(`SELECT datetime('now', '+' || ? || ' days') AS e`).get(wall.retention_days).e;
  }

  const id = crypto.randomUUID();
  const textBody = body.text_body ? String(body.text_body).trim() : null;
  // PHA-2218: mentions resolved against wall membership BEFORE the
  // transaction (read-only), then inserted atomically with the post
  // itself — no orphan mention rows if the post insert fails.
  const mentionedUsers = kind === 'text' ? notifications.parseMentions(textBody, wall, callerId) : [];

  const insertPost = _db.transaction(() => {
    _db.prepare(`
      INSERT INTO wall_posts (id, wall_id, author_user_id, kind, media_id, text_body, link_url, link_title, link_description, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, wall.id, callerId, kind,
      body.media_id || null,
      textBody,
      body.link_url || null,
      body.link_title || null,
      body.link_description || null,
      expiresAt
    );
    notifications.insertMentions({ postId: id, commentId: null, mentionerId: callerId, users: mentionedUsers });
  });
  insertPost();

  const row = _db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(id);
  const recipients = recipientsFor(wall, callerId);
  const mentionedUserIds = new Set(mentionedUsers.map((u) => u.id));
  notifications.emitForPost(wall, row, callerId, recipients, mentionedUserIds);
  analytics.logEvent(_db, { userId: callerId, kind: 'wall_post_created', subjectType: 'wall_post', subjectId: id,
    meta: { wall_slug: wall.slug, post_kind: kind, has_media: !!body.media_id } });
  analytics.logFirst(_db, { userId: callerId, kind: 'first_post', subjectType: 'user', subjectId: callerId,
    meta: { wall_slug: wall.slug, post_kind: kind } });
  return postView(row, callerId);
}

// recipientsFor(wall, authorId): distinct user ids to notify, excluding the
// author. Direct walls resolve via wall_memberships; group walls via
// user_groups joined to groups — the same membership sources assertMember()
// already checks. Phase 1: resolved inline at post time (fine for the
// tens-of-members scale here); a worker-queue fanout is future scope for
// once membership sizes grow.
function recipientsFor(wall, authorId) {
  let rows;
  if (wall.visibility === 'group') {
    rows = _db.prepare(`
      SELECT ug.user_id FROM user_groups ug
      JOIN groups g ON g.id = ug.group_id
      WHERE g.name = ?
    `).all(wall.group_name);
  } else {
    rows = _db.prepare('SELECT user_id FROM wall_memberships WHERE wall_id = ?').all(wall.id);
  }
  return rows.map((r) => r.user_id).filter((id) => id !== authorId);
}

function getPostInWall(slug, postId, callerId) {
  const { wall } = assertMember(slug, callerId);
  const post = _db.prepare('SELECT * FROM wall_posts WHERE id = ? AND wall_id = ?').get(postId, wall.id);
  if (!post) throw httpError(404, 'not_found');
  return { wall, post };
}

// deletePost(slug, postId, callerId): author or wall admin only.
function deletePost(slug, postId, callerId) {
  const { wall, post } = getPostInWall(slug, postId, callerId);
  if (post.author_user_id !== callerId) {
    const membership = _db.prepare('SELECT role FROM wall_memberships WHERE wall_id = ? AND user_id = ?').get(wall.id, callerId);
    if (!membership || membership.role !== 'admin') throw httpError(403, 'forbidden');
  }
  _db.prepare('DELETE FROM wall_posts WHERE id = ?').run(postId);
  return { ok: true };
}

// toggleReaction(slug, postId, callerId, emoji): fixed 5-token allowlist
// (Phase 1 — free-form deferred to Phase 3). Idempotent toggle: a second
// call with the same emoji removes it.
function toggleReaction(slug, postId, callerId, emoji) {
  if (!REACTION_EMOJI.has(emoji)) throw httpError(400, 'invalid_emoji');
  const { post } = getPostInWall(slug, postId, callerId);

  const existing = _db.prepare('SELECT id FROM post_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?').get(post.id, callerId, emoji);
  if (existing) {
    _db.prepare('DELETE FROM post_reactions WHERE id = ?').run(existing.id);
    return { ok: true, reacted: false };
  }
  _db.prepare('INSERT INTO post_reactions (post_id, user_id, emoji) VALUES (?, ?, ?)').run(post.id, callerId, emoji);
  analytics.logEvent(_db, { userId: callerId, kind: 'wall_reaction_added', subjectType: 'post_reaction', subjectId: post.id,
    meta: { post_id: post.id, emoji } });
  analytics.logFirst(_db, { userId: callerId, kind: 'first_reaction', subjectType: 'user', subjectId: callerId,
    meta: { post_id: post.id, emoji } });
  return { ok: true, reacted: true };
}

// removeReaction(slug, postId, callerId, emoji): explicit DELETE route
// (idempotent no-op if the reaction isn't present).
function removeReaction(slug, postId, callerId, emoji) {
  const { post } = getPostInWall(slug, postId, callerId);
  _db.prepare('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ? AND emoji = ?').run(post.id, callerId, emoji);
  return { ok: true };
}

// listComments(slug, postId, callerId): flat list, chronological ASC.
function listComments(slug, postId, callerId) {
  const { post } = getPostInWall(slug, postId, callerId);
  const rows = _db.prepare('SELECT * FROM post_comments WHERE post_id = ? ORDER BY created_at ASC').all(post.id);
  return rows.map((r) => ({
    id: r.id,
    author: userView(r.author_user_id),
    body: r.body,
    createdAt: r.created_at,
  }));
}

// createComment(postId, callerId, body): route is scoped by postId only
// (no slug in the URL — see PHA-2150 endpoint list), so membership is
// derived by walking wall_posts -> walls rather than trusting a slug.
function createComment(postId, callerId, body) {
  const post = _db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(postId);
  if (!post) throw httpError(404, 'not_found');
  const wall = _db.prepare('SELECT * FROM walls WHERE id = ?').get(post.wall_id);
  if (!wall) throw httpError(404, 'not_found');
  assertMember(wall.slug, callerId);

  const trimmed = (body || '').trim();
  if (!trimmed) throw httpError(400, 'empty_body');
  if (trimmed.length > COMMENT_MAX_LEN) throw httpError(400, 'body_too_long');

  const mentionedUsers = notifications.parseMentions(trimmed, wall, callerId);

  let commentId;
  const insertComment = _db.transaction(() => {
    const info = _db.prepare('INSERT INTO post_comments (post_id, author_user_id, body) VALUES (?, ?, ?)').run(post.id, callerId, trimmed);
    commentId = info.lastInsertRowid;
    notifications.insertMentions({ postId: null, commentId, mentionerId: callerId, users: mentionedUsers });
  });
  insertComment();

  const row = _db.prepare('SELECT * FROM post_comments WHERE id = ?').get(commentId);
  const mentionedUserIds = new Set(mentionedUsers.map((u) => u.id));
  notifications.emitForComment(wall, post, callerId, mentionedUserIds);
  analytics.logEvent(_db, { userId: callerId, kind: 'wall_comment_added', subjectType: 'post_comment', subjectId: row.id,
    meta: { post_id: post.id, wall_slug: wall.slug } });
  return {
    id: row.id,
    author: userView(row.author_user_id),
    body: row.body,
    createdAt: row.created_at,
  };
}

// PHA-2556: slug + name validation for admin wall CRUD. Slugs are
// the URL-space identity (assertMember reads them straight off the
// path), so they have to be URL-safe AND unique per the table's
// UNIQUE constraint. Names are display-only.
const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/;
const VISIBILITY = new Set(['group', 'direct']);

function validateWallInput(body) {
  const out = { errors: [] };
  if (!body || typeof body !== 'object') {
    out.errors.push('body must be an object');
    return out;
  }
  if (typeof body.slug !== 'string') {
    out.errors.push('slug required');
  } else if (!SLUG_RE.test(body.slug)) {
    out.errors.push('slug must match /^[a-z0-9](?:[a-z0-9_-]{0,30}[a-z0-9])?$/');
  }
  if (typeof body.name !== 'string' || !body.name.trim()) {
    out.errors.push('name required');
  }
  if (typeof body.visibility !== 'string' || !VISIBILITY.has(body.visibility)) {
    out.errors.push("visibility must be 'group' or 'direct'");
  }
  if (body.visibility === 'group') {
    if (typeof body.group_name !== 'string' || !body.group_name.trim()) {
      out.errors.push("group_name required when visibility='group'");
    } else if (!/^[a-z0-9][a-z0-9_-]{0,30}$/.test(body.group_name)) {
      out.errors.push('group_name must be a valid group identifier');
    }
  }
  if (body.retention_days != null) {
    const n = Number(body.retention_days);
    if (!Number.isInteger(n) || n < 0 || n > 3650) {
      out.errors.push('retention_days must be an integer 0..3650');
    } else {
      out.retention_days = n;
    }
  }
  return out;
}

// createWall(db, callerId, body): admin-only wall creation. Caller
// becomes a wall admin (so they can moderate immediately). Group walls
// require the group to already exist — we don't silently invent groups.
// Returns the inserted row in the same shape as listForUser().
function createWall(db, callerId, body) {
  const v = validateWallInput(body);
  if (v.errors.length) {
    const err = new Error(v.errors.join(' '));
    err.status = 400;
    err.code = 'invalid_wall';
    throw err;
  }
  const existing = db.prepare('SELECT id FROM walls WHERE slug = ?').get(body.slug);
  if (existing) {
    const err = new Error(`slug '${body.slug}' is already taken`);
    err.status = 409;
    err.code = 'slug_conflict';
    throw err;
  }
  if (body.visibility === 'group') {
    const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(body.group_name);
    if (!g) {
      const err = new Error(`group '${body.group_name}' does not exist`);
      err.status = 400;
      err.code = 'unknown_group';
      throw err;
    }
  }
  const id = crypto.randomUUID();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO walls (id, slug, name, visibility, group_name, retention_days, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      body.slug,
      body.name.trim(),
      body.visibility,
      body.visibility === 'group' ? body.group_name : null,
      v.retention_days != null ? v.retention_days : null,
      callerId
    );
    // Direct walls need an explicit membership row for the creator.
    // Group walls derive membership from user_groups, so the creator
    // automatically sees the wall if they're already in the group
    // (and they SHOULD be — the admin UI only shows existing groups).
    if (body.visibility === 'direct') {
      db.prepare(`
        INSERT OR IGNORE INTO wall_memberships (wall_id, user_id, role)
        VALUES (?, ?, 'admin')
      `).run(id, callerId);
    }
  });
  tx();
  const row = db.prepare('SELECT * FROM walls WHERE id = ?').get(id);
  return {
    slug: row.slug,
    name: row.name,
    visibility: row.visibility,
    group_name: row.group_name,
    retention_days: row.retention_days,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

// addMember(slug, callerId, body) — PHA-2556 admin route helper.
// Body: {username, role?}. Resolves username -> users.id, then inserts
// into wall_memberships (or, for group walls, reconciles into the
// group too — that's what makes the user visible to assertMember).
// Idempotent (INSERT OR IGNORE / reconcileGroups is).
function adminAddMember(db, slug, callerId, body) {
  if (!body || typeof body.username !== 'string' || !body.username.trim()) {
    const err = new Error('username required');
    err.status = 400;
    err.code = 'username_required';
    throw err;
  }
  const wall = db.prepare('SELECT * FROM walls WHERE slug = ?').get(slug);
  if (!wall) {
    const err = new Error('not_found');
    err.status = 404;
    err.code = 'not_found';
    throw err;
  }
  const userModel = require('./user-model');
  const target = db.prepare('SELECT id, username FROM users WHERE username = ?').get(userModel.validateUsername(body.username) || body.username);
  if (!target) {
    const err = new Error(`user '${body.username}' not found`);
    err.status = 404;
    err.code = 'user_not_found';
    throw err;
  }
  const role = body.role === 'admin' ? 'admin' : 'member';

  if (wall.visibility === 'group') {
    // Group walls: also put the user in the wall's group so the
    // group-derived assertMember + listForUser paths both see them.
    // reconcileGroups merges (no duplicates) and writes the
    // denormalized is_admin flag for the admins group.
    const existing = db.prepare(`
      SELECT g.name FROM user_groups ug
      JOIN groups g ON g.id = ug.group_id WHERE ug.user_id = ?
    `).all(target.id).map((r) => r.name);
    const merged = Array.from(new Set([...existing, wall.group_name]));
    userModel.reconcileGroups(db, target.id, merged);
    // Also stamp the wall_memberships row so getMembers() / wall admin
    // role lookups work uniformly.
    db.prepare(`
      INSERT OR IGNORE INTO wall_memberships (wall_id, user_id, role)
      VALUES (?, ?, ?)
    `).run(wall.id, target.id, role);
  } else {
    db.prepare(`
      INSERT OR IGNORE INTO wall_memberships (wall_id, user_id, role)
      VALUES (?, ?, ?)
    `).run(wall.id, target.id, role);
  }
  return { ok: true, slug, username: target.username, role };
}

// adminRemoveMember(slug, callerId, body) — body: {username}.
// For group walls, also removes the user from the underlying group
// (otherwise they'd still see the wall via group membership even
// after their wall_memberships row is gone).
function adminRemoveMember(db, slug, body) {
  if (!body || typeof body.username !== 'string' || !body.username.trim()) {
    const err = new Error('username required');
    err.status = 400;
    err.code = 'username_required';
    throw err;
  }
  const wall = db.prepare('SELECT * FROM walls WHERE slug = ?').get(slug);
  if (!wall) {
    const err = new Error('not_found');
    err.status = 404;
    err.code = 'not_found';
    throw err;
  }
  const userModel = require('./user-model');
  const target = db.prepare('SELECT id FROM users WHERE username = ?').get(userModel.validateUsername(body.username) || body.username);
  if (!target) {
    const err = new Error(`user '${body.username}' not found`);
    err.status = 404;
    err.code = 'user_not_found';
    throw err;
  }
  if (wall.visibility === 'group') {
    const g = db.prepare('SELECT id FROM groups WHERE name = ?').get(wall.group_name);
    if (g) {
      db.prepare('DELETE FROM user_groups WHERE user_id = ? AND group_id = ?').run(target.id, g.id);
    }
  }
  db.prepare('DELETE FROM wall_memberships WHERE wall_id = ? AND user_id = ?').run(wall.id, target.id);
  return { ok: true, slug, username: body.username };
}

module.exports = {
  REACTION_EMOJI,
  COMMENT_MAX_LEN,
  POSTS_MAX_LIMIT,
  SLUG_RE,
  migrate,
  seed,
  assertMember,
  listForUser,
  postsForWall,
  createPost,
  getPostInWall,
  deletePost,
  toggleReaction,
  removeReaction,
  listComments,
  createComment,
  createWall,
  adminAddMember,
  adminRemoveMember,
  validateWallInput,
};
