// Homestead — per-wall notification preferences + @mentions (PHA-2218).
//
// Preference model + mention system for the wall-notification granularity
// feature. Delivery mechanism (VAPID push, subscriptions, quiet hours) is
// PHA-1619 and lives in server.js — this module decides IF a notification
// fires (per-wall level, mention scope, thread mute) and composes with
// server.js's quiet-hours window to decide WHEN. It never calls webpush
// directly; it only decides notification_log row shape, same as the
// PHA-2153 activity-feed path it replaces (lib/walls.js's old emitActivity).
//
// Design doc: PHA-2218 issue comment (schema + resolution + bundling),
// approved by Brandon 2026-08-21.

'use strict';

const BUNDLE_WINDOW_MS = parseInt(process.env.BUNDLE_WINDOW_MS, 10) || 900000; // 15 min, §4

let _db = null;

function migrate(db) {
  _db = db;
  db.exec(`
    -- Mirrors server.js's notification_prefs DDL exactly (PHA-1619).
    -- Declared here too (IF NOT EXISTS) so isInQuietHours() has a table
    -- to read from even when walls.migrate() runs before server.js's
    -- inline schema block — same reasoning as lib/walls.js's own
    -- notification_log mirror.
    CREATE TABLE IF NOT EXISTS notification_prefs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      quiet_start_hour INTEGER NOT NULL DEFAULT 21,
      quiet_end_hour INTEGER NOT NULL DEFAULT 8,
      chore_due INTEGER NOT NULL DEFAULT 1,
      take_turns INTEGER NOT NULL DEFAULT 1,
      system INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS wall_notification_prefs (
      wall_id    TEXT NOT NULL REFERENCES walls(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      level      TEXT NOT NULL DEFAULT 'mentions'
                     CHECK(level IN ('all','mentions','none')),
      via        TEXT NOT NULL DEFAULT 'unknown'
                     CHECK(via IN ('wall_memberships','user_groups','unknown')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (wall_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_wall_notif_prefs_user
      ON wall_notification_prefs(user_id);

    CREATE TABLE IF NOT EXISTS mentions (
      id                INTEGER PRIMARY KEY,
      post_id           TEXT REFERENCES wall_posts(id) ON DELETE CASCADE,
      comment_id        INTEGER REFERENCES post_comments(id) ON DELETE CASCADE,
      mentioned_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mentioned_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK ((post_id IS NOT NULL) <> (comment_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_mentions_mentioned_user
      ON mentions(mentioned_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_mentions_post
      ON mentions(post_id) WHERE post_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mentions_comment
      ON mentions(comment_id) WHERE comment_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS thread_mutes (
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id    TEXT NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_thread_mutes_user
      ON thread_mutes(user_id);
  `);

  // notification_log.seen_at (PHA-1617 badge-clearing promise). Additive;
  // ALTER TABLE ADD COLUMN has no IF NOT EXISTS in sqlite, so guard via
  // PRAGMA table_info (same idempotent pattern as lib/user-model.js).
  const cols = db.prepare('PRAGMA table_info(notification_log)').all().map((c) => c.name);
  if (!cols.includes('seen_at')) {
    db.exec('ALTER TABLE notification_log ADD COLUMN seen_at TEXT');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_notification_log_unseen
      ON notification_log(user_id) WHERE seen_at IS NULL;
  `);

  backfillPrefs(db);
}

// backfillPrefs: preserve today's implicit behavior for existing members so
// nobody is silently demoted to the new 'mentions' default the moment this
// migration runs. Only ever INSERT OR IGNORE — a row a user already set
// through the new UI is never touched. Runs on every boot; cheap no-op
// once every existing member has a row.
function backfillPrefs(db) {
  // Direct walls: wall_memberships.notifications boolean maps 1:1 onto
  // level all/none.
  db.prepare(`
    INSERT OR IGNORE INTO wall_notification_prefs (wall_id, user_id, level, via)
    SELECT wall_id, user_id, CASE WHEN notifications = 1 THEN 'all' ELSE 'none' END, 'wall_memberships'
    FROM wall_memberships
  `).run();

  // Group walls never had an opt-out; every member implicitly got 'all'.
  // Backfill to 'all' to match, not the new 'mentions' default — the
  // 'mentions' default only applies going forward, to genuinely new joins.
  db.prepare(`
    INSERT OR IGNORE INTO wall_notification_prefs (wall_id, user_id, level, via)
    SELECT w.id, ug.user_id, 'all', 'user_groups'
    FROM walls w
    JOIN groups g ON g.name = w.group_name
    JOIN user_groups ug ON ug.group_id = g.id
    WHERE w.visibility = 'group'
  `).run();
}

function getLevel(wallId, userId) {
  const row = _db.prepare('SELECT level FROM wall_notification_prefs WHERE wall_id = ? AND user_id = ?').get(wallId, userId);
  return row ? row.level : 'mentions';
}

// setLevel(wallId, userId, level, via): idempotent UPSERT backing the
// PUT /api/walls/:slug/notifications route.
function setLevel(wallId, userId, level, via) {
  if (!['all', 'mentions', 'none'].includes(level)) {
    const err = new Error('invalid_level');
    err.status = 400;
    err.code = 'invalid_level';
    throw err;
  }
  _db.prepare(`
    INSERT INTO wall_notification_prefs (wall_id, user_id, level, via, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(wall_id, user_id) DO UPDATE SET
      level = excluded.level,
      via = excluded.via,
      updated_at = datetime('now')
  `).run(wallId, userId, level, via || 'unknown');
  return { level };
}

function isThreadMuted(userId, postId) {
  if (!postId) return false;
  return !!_db.prepare('SELECT 1 FROM thread_mutes WHERE user_id = ? AND post_id = ?').get(userId, postId);
}

function muteThread(userId, postId) {
  _db.prepare('INSERT OR IGNORE INTO thread_mutes (user_id, post_id) VALUES (?, ?)').run(userId, postId);
  return { ok: true, muted: true };
}

function unmuteThread(userId, postId) {
  _db.prepare('DELETE FROM thread_mutes WHERE user_id = ? AND post_id = ?').run(userId, postId);
  return { ok: true, muted: false };
}

// isInQuietHours: mirrors server.js's isInQuietHours exactly (same
// notification_prefs table, same wraparound-midnight math). Read-only
// here — the lazy row-creation on first touch stays owned by server.js's
// getPrefs(); a user with no row yet gets the table's own DEFAULT window
// (21–8) without this module writing a row.
function isInQuietHours(userId, now) {
  const prefs = _db.prepare('SELECT quiet_start_hour, quiet_end_hour FROM notification_prefs WHERE user_id = ?').get(userId)
    || { quiet_start_hour: 21, quiet_end_hour: 8 };
  const h = now.getHours();
  const s = prefs.quiet_start_hour, e = prefs.quiet_end_hour;
  if (s === e) return false;
  if (s < e) return h >= s && h < e;
  return h >= s || h < e;
}

// resolve({userId, wallId, kind, postId, force}): the IF decision.
// kind ∈ 'wall_post' | 'mention' | 'direct_share'. Composition order
// mirrors the design doc §2: level gates first, then thread mute, then
// quiet hours. Returns {deliver, skippedReason}; never writes a row —
// callers (emitForPost/emitForComment) own row-shape + bundling.
function resolve({ userId, wallId, kind, postId, force }) {
  const level = getLevel(wallId, userId);

  if (kind === 'mention') {
    if (level === 'none') return { deliver: false, skippedReason: 'level_none' };
  } else if (kind === 'wall_post') {
    if (level === 'none') return { deliver: false, skippedReason: 'level_none' };
    if (level === 'mentions') return { deliver: false, skippedReason: 'level_mentions_no_match' };
  } else if (kind === 'direct_share') {
    if (level === 'none') return { deliver: false, skippedReason: 'level_none' };
  } else {
    throw new Error(`notifications.resolve: unknown kind "${kind}"`);
  }

  if (isThreadMuted(userId, postId)) return { deliver: false, skippedReason: 'thread_muted' };

  if (!force && isInQuietHours(userId, new Date())) return { deliver: false, skippedReason: 'quiet_hours' };

  return { deliver: true, skippedReason: null };
}

function logRow({ userId, category, title, body, url, tag, delivered, skippedReason }) {
  _db.prepare(`
    INSERT INTO notification_log (user_id, category, title, body, url, tag, delivered, skipped_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, category, title || '', body || '', url || '', tag || '', delivered ? 1 : 0, skippedReason || null);
}

function postSnippet(post) {
  return post.kind === 'text' ? (post.text_body || '').slice(0, 200) : `[${post.kind}]`;
}

function postUrl(wall, post) {
  return `/porch.html?wall=${encodeURIComponent(wall.slug)}&post=${encodeURIComponent(post.id)}`;
}

// bundleWallPost: §4. N posts in BUNDLE_WINDOW_MS collapse into one row
// per wall, title bumping ("3 new posts on Memes") rather than a fresh
// row per post. Tag is fixed for the whole window so the service
// worker's tag-based renotify collapses the OS toast too.
function bundleWallPost({ userId, wall, post, displayName }) {
  const tag = `wall_post:${wall.slug}:bundle`;
  const cutoff = new Date(Date.now() - BUNDLE_WINDOW_MS).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const existing = _db.prepare(`
    SELECT * FROM notification_log
    WHERE user_id = ? AND tag = ? AND category = 'wall_post' AND skipped_reason IS NULL
      AND created_at > ?
    ORDER BY created_at DESC LIMIT 1
  `).get(userId, tag, cutoff);

  if (existing) {
    const bumpMatch = existing.title.match(/^(\d+) new posts on /);
    const count = bumpMatch ? parseInt(bumpMatch[1], 10) + 1 : 2;
    _db.prepare(`
      UPDATE notification_log
      SET title = ?, body = ?, url = ?, created_at = datetime('now'), delivered = 1
      WHERE id = ?
    `).run(`${count} new posts on ${wall.name}`, postSnippet(post), postUrl(wall, post), existing.id);
    return;
  }
  logRow({
    userId,
    category: 'wall_post',
    title: `${displayName} posted on ${wall.name}`,
    body: postSnippet(post),
    url: postUrl(wall, post),
    tag,
    delivered: 1,
  });
}

// emitMentionRow: own row, never bundled — the act of @-addressing is
// the trigger (same philosophy as direct shares, §4/§2).
function emitMentionRow({ userId, wall, post, displayName }) {
  logRow({
    userId,
    category: 'mention',
    title: `${displayName} posted on ${wall.name} — mentioning you`,
    body: postSnippet(post),
    url: postUrl(wall, post),
    tag: `wall_post:mention:${post.id}`,
    delivered: 1,
  });
}

function emitCommentMentionRow({ userId, wall, post, displayName }) {
  logRow({
    userId,
    category: 'mention',
    title: `${displayName} mentioned you in a comment on ${wall.name}`,
    body: postSnippet(post),
    url: postUrl(wall, post),
    tag: `wall_post:mention:${post.id}`,
    delivered: 1,
  });
}

// emitDirectShareRow: own row, never bundled (§4 — "the act of
// addressing is the trigger", same as direct-share override in §2).
function emitDirectShareRow({ userId, wall, post, displayName }) {
  logRow({
    userId,
    category: 'direct_share',
    title: `${displayName} posted on ${wall.name}`,
    body: postSnippet(post),
    url: postUrl(wall, post),
    tag: `wall_post:direct:${post.id}`,
    delivered: 1,
  });
}

// emitForPost(wall, post, authorId, recipients, mentionedUserIds):
// replaces lib/walls.js's old emitActivity per-recipient INSERT
// fan-out with a resolver-driven fan-out (§6 PHA-2218.2). Called once
// per createPost. `recipients` excludes the author (recipientsFor()).
// `mentionedUserIds` is a Set<number> already scoped to wall members
// (parseMentions only ever resolves members).
function emitForPost(wall, post, authorId, recipients, mentionedUserIds) {
  const author = _db.prepare('SELECT display FROM users WHERE id = ?').get(authorId);
  const displayName = (author && author.display) || 'Someone';
  const kind = wall.visibility === 'direct' ? 'direct_share' : 'wall_post';

  const targets = new Set(recipients);
  for (const uid of mentionedUserIds) if (uid !== authorId) targets.add(uid);

  for (const userId of targets) {
    const isMentioned = mentionedUserIds.has(userId);
    const wallResult = resolve({ userId, wallId: wall.id, kind, postId: post.id });
    const mentionResult = isMentioned ? resolve({ userId, wallId: wall.id, kind: 'mention', postId: post.id }) : null;

    const deliver = wallResult.deliver || (mentionResult && mentionResult.deliver);
    if (!deliver) {
      const reason = mentionResult ? mentionResult.skippedReason : wallResult.skippedReason;
      logRow({
        userId,
        category: kind,
        title: `${displayName} posted on ${wall.name}`,
        body: postSnippet(post),
        url: postUrl(wall, post),
        tag: `wall_post:${wall.slug}:${post.id}`,
        delivered: 0,
        skippedReason: reason,
      });
      continue;
    }

    if (isMentioned && mentionResult.deliver) {
      emitMentionRow({ userId, wall, post, displayName });
    } else if (kind === 'direct_share') {
      emitDirectShareRow({ userId, wall, post, displayName });
    } else {
      bundleWallPost({ userId, wall, post, displayName });
    }
  }
}

// emitForComment: comments don't broadcast to the whole wall (no
// wall_post-kind emit here — that would invent an engagement mechanic
// nobody asked for). Only @mentions inside the comment notify, and only
// the mentioned users.
function emitForComment(wall, post, authorId, mentionedUserIds) {
  const author = _db.prepare('SELECT display FROM users WHERE id = ?').get(authorId);
  const displayName = (author && author.display) || 'Someone';

  for (const userId of mentionedUserIds) {
    if (userId === authorId) continue;
    const result = resolve({ userId, wallId: wall.id, kind: 'mention', postId: post.id });
    if (!result.deliver) {
      logRow({
        userId,
        category: 'mention',
        title: `${displayName} mentioned you in a comment on ${wall.name}`,
        body: postSnippet(post),
        url: postUrl(wall, post),
        tag: `wall_post:mention:${post.id}`,
        delivered: 0,
        skippedReason: result.skippedReason,
      });
      continue;
    }
    emitCommentMentionRow({ userId, wall, post, displayName });
  }
}

// membersForWall(wall): membership source mirrors lib/walls.js's
// assertMember/recipientsFor exactly (group -> user_groups, direct ->
// wall_memberships). Includes the author (unlike recipientsFor) since
// this backs both composer autocomplete and mention resolution, where
// "can I @-mention myself" is decided by the parser, not this query.
function membersForWall(wall) {
  if (wall.visibility === 'group') {
    return _db.prepare(`
      SELECT u.id, u.username, u.display, u.color
      FROM user_groups ug
      JOIN groups g ON g.id = ug.group_id
      JOIN users u ON u.id = ug.user_id
      WHERE g.name = ?
      ORDER BY u.username ASC
    `).all(wall.group_name);
  }
  return _db.prepare(`
    SELECT u.id, u.username, u.display, u.color, wm.joined_at
    FROM wall_memberships wm
    JOIN users u ON u.id = wm.user_id
    WHERE wm.wall_id = ?
    ORDER BY u.username ASC
  `).all(wall.id);
}

const MENTION_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]{1,32})/g;

// parseMentions(text, wall, callerId): wall-scoped only (constitutional —
// you cannot @-mention someone who isn't a member). Silently drops
// non-member handles and self-mentions; no error toast, matching §3.
function parseMentions(text, wall, callerId) {
  if (!text) return [];
  const members = membersForWall(wall);
  const byHandle = new Map();
  for (const m of members) {
    byHandle.set(m.username.toLowerCase(), m);
    if (m.display) byHandle.set(m.display.toLowerCase(), m);
  }
  const resolved = new Map();
  let match;
  MENTION_RE.lastIndex = 0;
  while ((match = MENTION_RE.exec(text))) {
    const handle = match[1].toLowerCase();
    const user = byHandle.get(handle);
    if (!user) continue;
    if (user.id === callerId) continue;
    resolved.set(user.id, user);
  }
  return [...resolved.values()];
}

// insertMentions(postId|null, commentId|null, mentionerId, users): the
// CHECK constraint enforces exactly one of postId/commentId. Caller
// wraps this in the same db.transaction() as the post/comment insert
// so a failed post insert never leaves an orphan mention row.
function insertMentions({ postId, commentId, mentionerId, users }) {
  if (!users.length) return;
  const insert = _db.prepare(`
    INSERT INTO mentions (post_id, comment_id, mentioned_user_id, mentioned_by)
    VALUES (?, ?, ?, ?)
  `);
  for (const u of users) insert.run(postId || null, commentId || null, u.id, mentionerId);
}

// entitySlugForUser(displayName): best-effort join into the entity
// graph (PHA-1624) for rendering the mention as an entity-style link.
// Matches plex/kavita's kind='person' name-lower convention. Returns
// null when the person isn't synced yet — the caller falls back to a
// plain wall-scoped link (§3).
function entitySlugForUser(displayName) {
  if (!displayName) return null;
  const row = _db.prepare(`
    SELECT slug FROM entities WHERE kind = 'person' AND name_lower = ?
  `).get(displayName.toLowerCase());
  return row ? row.slug : null;
}

// listForUser(userId, opts): backs GET /api/me/notifications. opts.unseen
// filters to seen_at IS NULL (the badge view); default is the full
// recent log (bounded, chronological, PHA-1617-style hard cap).
const NOTIFICATIONS_MAX_LIMIT = 100;
function listForUser(userId, opts = {}) {
  const cap = Math.min(Math.max(parseInt(opts.limit, 10) || 25, 1), NOTIFICATIONS_MAX_LIMIT);
  const rows = opts.unseen
    ? _db.prepare(`
        SELECT * FROM notification_log WHERE user_id = ? AND seen_at IS NULL
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, cap)
    : _db.prepare(`
        SELECT * FROM notification_log WHERE user_id = ?
        ORDER BY created_at DESC LIMIT ?
      `).all(userId, cap);
  return rows.map((r) => ({
    id: r.id,
    category: r.category,
    title: r.title,
    body: r.body,
    url: r.url,
    tag: r.tag,
    delivered: !!r.delivered,
    skippedReason: r.skipped_reason,
    createdAt: r.created_at,
    seenAt: r.seen_at,
  }));
}

// markSeen(userId, {tag?, postId?, clearAll?}): the badge-clearing
// promise from PHA-1617 — three paths all funnel here (SW click, feed
// open, bulk clear). Always scoped to the caller's own rows.
function markSeen(userId, { tag, postId, clearAll } = {}) {
  if (clearAll) {
    return _db.prepare(`
      UPDATE notification_log SET seen_at = datetime('now')
      WHERE user_id = ? AND seen_at IS NULL
    `).run(userId).changes;
  }
  if (tag) {
    return _db.prepare(`
      UPDATE notification_log SET seen_at = datetime('now')
      WHERE user_id = ? AND tag = ? AND seen_at IS NULL
    `).run(userId, tag).changes;
  }
  if (postId) {
    return _db.prepare(`
      UPDATE notification_log SET seen_at = datetime('now')
      WHERE user_id = ? AND seen_at IS NULL AND url LIKE '%post=' || ? || '%'
    `).run(userId, postId).changes;
  }
  return 0;
}

module.exports = {
  BUNDLE_WINDOW_MS,
  migrate,
  getLevel,
  setLevel,
  isThreadMuted,
  muteThread,
  unmuteThread,
  isInQuietHours,
  resolve,
  emitForPost,
  emitForComment,
  membersForWall,
  parseMentions,
  insertMentions,
  entitySlugForUser,
  listForUser,
  markSeen,
};
