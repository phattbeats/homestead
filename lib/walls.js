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

const REACTION_EMOJI = new Set(['+1', 'joy', 'fire', 'eyes', 'heart']);
const POST_KINDS = new Set(['image', 'video', 'link', 'text']);
const COMMENT_MAX_LEN = 1000;
const POSTS_DEFAULT_LIMIT = 20;
const POSTS_MAX_LIMIT = 50;

let _db = null;

function migrate(db) {
  _db = db;
  db.exec(`
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
}

// seed(db): media-club is the one group wall Phase 1 ships with. Other
// group walls (household, family) are out of scope here — the table
// supports them, but no scheduler inserts them yet.
function seed(db) {
  const existing = db.prepare('SELECT id FROM walls WHERE slug = ?').get('media-club');
  if (existing) return;
  db.prepare(`
    INSERT INTO walls (id, slug, name, visibility, group_name)
    VALUES (?, 'media-club', 'Media Club', 'group', 'media-club')
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
  _db.prepare(`
    INSERT INTO wall_posts (id, wall_id, author_user_id, kind, media_id, text_body, link_url, link_title, link_description, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, wall.id, callerId, kind,
    body.media_id || null,
    body.text_body ? String(body.text_body).trim() : null,
    body.link_url || null,
    body.link_title || null,
    body.link_description || null,
    expiresAt
  );

  const row = _db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(id);
  return postView(row, callerId);
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

  const info = _db.prepare('INSERT INTO post_comments (post_id, author_user_id, body) VALUES (?, ?, ?)').run(post.id, callerId, trimmed);
  const row = _db.prepare('SELECT * FROM post_comments WHERE id = ?').get(info.lastInsertRowid);
  return {
    id: row.id,
    author: userView(row.author_user_id),
    body: row.body,
    createdAt: row.created_at,
  };
}

module.exports = {
  REACTION_EMOJI,
  COMMENT_MAX_LEN,
  POSTS_MAX_LIMIT,
  migrate,
  seed,
  assertMember,
  listForUser,
  postsForWall,
  createPost,
  deletePost,
  toggleReaction,
  removeReaction,
  listComments,
  createComment,
};
