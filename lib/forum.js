// Homestead — The Forum (#4097, parent #4076). Porch's old-school forum
// skin: boards (walls), threads (wall_posts), replies (post_comments).
//
// There is deliberately no second content store. A "board" is a wall, a
// "thread" is a wall post, a "reply" is a post comment — so membership,
// opt-out, notifications and live events keep working unchanged. This
// module adds only what the Woodgrain UI needs on top:
//
//   * additive columns: wall_posts.sticky/views, users.signature /
//     birthday / last_active_at / last_visit_at
//   * read models: board index, thread list, thread view, who's online,
//     stats + birthdays
//   * derived data (never stored): post counts and ranks
//
// Every read goes through walls.assertMember / walls.listForUser, so a
// board a caller can't see doesn't exist for them (404, not 403).

'use strict';

const walls = require('./walls');
const hearthCharacters = require('./hearth-characters');

const ONLINE_WINDOW_MIN = 15;
// A "visit" ends after this much inactivity; the next request starts a new
// one and the previous visit's end becomes the "new since last visit" cut.
const VISIT_GAP_MIN = 30;
const ACTIVITY_THROTTLE_SEC = 60;
const THREADS_DEFAULT_LIMIT = 25;
const THREADS_MAX_LIMIT = 50;
const SIGNATURE_MAX_LEN = 200;
const TITLE_FALLBACK_LEN = 80;

// Post-count ladder (threads + replies authored). vBulletin-flavoured on
// purpose — the nostalgia is the feature.
const RANKS = Object.freeze([
  { min: 0, name: 'Newcomer' },
  { min: 5, name: 'Junior Member' },
  { min: 25, name: 'Member' },
  { min: 100, name: 'Senior Member' },
  { min: 300, name: 'Elite Member' },
]);

// Starter boards, seeded once per install. Deliberately few (Brandon,
// #4076: board shape is still unknown). `household` is the pre-existing
// Porch wall: it keeps its slug and every post, just gains a category.
const SEED_BOARDS = Object.freeze([
  { slug: 'announcements', name: 'Announcements', category: 'Homestead', sort: 10,
    description: 'News from the house — Gazette editions land here.' },
  { slug: 'household', name: 'General Chit-Chat', category: 'Community', sort: 20,
    description: 'Anything and everything.' },
  { slug: 'introductions', name: 'Introduce Yourself', category: 'Community', sort: 30,
    description: 'New here? Say hello.' },
]);

let _db = null;

function httpError(status, code) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  return err;
}

function migrate(db) {
  _db = db;
  // walls.migrate owns wall_posts.title and walls.category/sort (createPost
  // needs them even when forum.js isn't loaded). Run it defensively so this
  // module can be migrated standalone in narrow tests.
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const addCol = (table, name, ddl) => {
    if (!cols(table).includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addCol('wall_posts', 'sticky', 'sticky INTEGER NOT NULL DEFAULT 0');
  addCol('wall_posts', 'views', 'views INTEGER NOT NULL DEFAULT 0');
  addCol('users', 'signature', 'signature TEXT');
  addCol('users', 'birthday', 'birthday TEXT'); // 'MM-DD', year deliberately not stored
  addCol('users', 'last_active_at', 'last_active_at TEXT');
  addCol('users', 'last_visit_at', 'last_visit_at TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at)');
}

// seed(db): first forum boot only. Gated on "no wall has a category yet"
// rather than per-slug so an admin who later deletes or renames a starter
// board doesn't see it resurrected on the next restart.
function seed(db) {
  const already = db.prepare('SELECT 1 FROM walls WHERE category IS NOT NULL LIMIT 1').get();
  if (already) return;
  const crypto = require('crypto');
  const tx = db.transaction(() => {
    for (const b of SEED_BOARDS) {
      const existing = db.prepare('SELECT id, name FROM walls WHERE slug = ?').get(b.slug);
      if (existing) {
        // Only the legacy seed name is rewritten; anything custom is kept.
        const name = existing.name === 'Household Porch' ? b.name : existing.name;
        db.prepare('UPDATE walls SET category = ?, sort = ?, name = ? WHERE id = ?').run(b.category, b.sort, name, existing.id);
      } else {
        db.prepare(`INSERT INTO walls (id, slug, name, visibility, group_name, category, sort)
                    VALUES (?, ?, ?, 'group', 'household', ?, ?)`).run(crypto.randomUUID(), b.slug, b.name, b.category, b.sort);
      }
    }
  });
  tx();
}

// ---- activity / visits ----

// touchActivity(userId): stamp "this user is here now" and roll the visit
// window. Throttled in SQL so a chatty page doesn't write on every request.
// SQLite evaluates every SET expression against the pre-update row, so
// last_visit_at sees the OLD last_active_at — that is the point.
function touchActivity(userId) {
  _db.prepare(`
    UPDATE users SET
      last_visit_at = CASE
        WHEN last_active_at IS NULL THEN last_visit_at
        WHEN last_active_at < datetime('now', '-${VISIT_GAP_MIN} minutes') THEN last_active_at
        ELSE last_visit_at END,
      last_active_at = datetime('now')
    WHERE id = ? AND (last_active_at IS NULL OR last_active_at < datetime('now', '-${ACTIVITY_THROTTLE_SEC} seconds'))
  `).run(userId);
}

function lastVisitFor(userId) {
  const r = _db.prepare('SELECT last_visit_at FROM users WHERE id = ?').get(userId);
  return (r && r.last_visit_at) || null;
}

// ---- derived identity: post counts, ranks ----

function postCountFor(userId) {
  const t = _db.prepare('SELECT COUNT(*) c FROM wall_posts WHERE author_user_id = ?').get(userId).c;
  const r = _db.prepare('SELECT COUNT(*) c FROM post_comments WHERE author_user_id = ?').get(userId).c;
  return t + r;
}

function rankFor(userRow, postCount) {
  if (hearthCharacters.isBuiltinAgentUserId(_db, userRow.id)) return 'Moderator · House Agent';
  if (walls.isAgentUserId(userRow.id)) return 'House Agent';
  if (userRow.is_admin) return 'Administrator';
  let name = RANKS[0].name;
  for (const r of RANKS) if (postCount >= r.min) name = r.name;
  return name;
}

function memberView(userId) {
  const u = _db.prepare(`SELECT id, username, display, color, is_admin, signature, created_at
                         FROM users WHERE id = ?`).get(userId);
  if (!u) return null;
  const postCount = postCountFor(u.id);
  return {
    username: u.username,
    display: u.display,
    color: u.color,
    isAgent: walls.isAgentUserId(u.id),
    rank: rankFor(u, postCount),
    postCount,
    signature: u.signature || null,
    joinedAt: u.created_at || null,
  };
}

// ---- titles ----

function threadTitle(row) {
  if (row.title) return row.title;
  const firstLine = String(row.text_body || '').split('\n').map((l) => l.trim()).find(Boolean);
  if (firstLine) return firstLine.length > TITLE_FALLBACK_LEN ? firstLine.slice(0, TITLE_FALLBACK_LEN - 1) + '…' : firstLine;
  if (row.link_title) return row.link_title;
  if (row.link_url) return row.link_url;
  return `[${row.kind}]`;
}

// ---- board index ----

function visibleWallRows(userId) {
  const slugs = new Set(walls.listForUser(userId).map((w) => w.slug));
  return _db.prepare('SELECT * FROM walls ORDER BY sort ASC, name ASC').all().filter((w) => slugs.has(w.slug));
}

function lastPostFor(wallId) {
  const t = _db.prepare(`SELECT id, title, text_body, link_title, link_url, kind, author_user_id, created_at
                         FROM wall_posts WHERE wall_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(wallId);
  const c = _db.prepare(`SELECT c.created_at, c.author_user_id, p.id AS post_id, p.title, p.text_body, p.link_title, p.link_url, p.kind
                         FROM post_comments c JOIN wall_posts p ON p.id = c.post_id
                         WHERE p.wall_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1`).get(wallId);
  if (!t && !c) return null;
  // >= : timestamps are second-resolution, and a reply can't precede its thread.
  const useReply = c && (!t || c.created_at >= t.created_at);
  const src = useReply ? c : t;
  const author = walls.userView(src.author_user_id);
  return {
    threadId: useReply ? c.post_id : t.id,
    title: threadTitle(src),
    author: author && { username: author.username, display: author.display },
    at: src.created_at,
    isReply: !!useReply,
  };
}

function boardCounts(wallId, since) {
  const threads = _db.prepare('SELECT COUNT(*) c FROM wall_posts WHERE wall_id = ?').get(wallId).c;
  const replies = _db.prepare(`SELECT COUNT(*) c FROM post_comments c JOIN wall_posts p ON p.id = c.post_id
                               WHERE p.wall_id = ?`).get(wallId).c;
  let fresh = 0;
  if (since) {
    fresh = _db.prepare('SELECT COUNT(*) c FROM wall_posts WHERE wall_id = ? AND created_at > ?').get(wallId, since).c
      + _db.prepare(`SELECT COUNT(*) c FROM post_comments c JOIN wall_posts p ON p.id = c.post_id
                     WHERE p.wall_id = ? AND c.created_at > ?`).get(wallId, since).c;
  }
  return { threads, posts: threads + replies, newSinceVisit: fresh };
}

function boardIndex(userId) {
  const since = lastVisitFor(userId);
  const categories = [];
  const byName = new Map();
  for (const w of visibleWallRows(userId)) {
    const cat = w.category || 'Boards';
    if (!byName.has(cat)) { const c = { name: cat, boards: [] }; byName.set(cat, c); categories.push(c); }
    const counts = boardCounts(w.id, since);
    byName.get(cat).boards.push({
      slug: w.slug,
      name: w.name,
      threadCount: counts.threads,
      postCount: counts.posts,
      newSinceVisit: counts.newSinceVisit,
      lastPost: lastPostFor(w.id),
    });
  }
  return { lastVisitAt: since, categories };
}

// ---- thread list ----

function threadList(slug, userId, { page, limit } = {}) {
  const { wall } = walls.assertMember(slug, userId);
  const cap = Math.min(Math.max(parseInt(limit, 10) || THREADS_DEFAULT_LIMIT, 1), THREADS_MAX_LIMIT);
  const pageNo = Math.max(parseInt(page, 10) || 1, 1);
  const since = lastVisitFor(userId);

  const rows = _db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS reply_count,
      COALESCE((SELECT MAX(c.created_at) FROM post_comments c WHERE c.post_id = p.id), p.created_at) AS last_activity_at
    FROM wall_posts p
    WHERE p.wall_id = ?
    ORDER BY p.sticky DESC, last_activity_at DESC, p.rowid DESC
    LIMIT ? OFFSET ?
  `).all(wall.id, cap, (pageNo - 1) * cap);

  const threads = rows
    .filter((r) => !walls.hiddenByWallOptOut(wall.id, r.author_user_id))
    .map((r) => {
      const lastReply = r.reply_count
        ? _db.prepare('SELECT author_user_id, created_at FROM post_comments WHERE post_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(r.id)
        : null;
      const lastBy = walls.userView(lastReply ? lastReply.author_user_id : r.author_user_id);
      const author = walls.userView(r.author_user_id);
      return {
        id: r.id,
        title: threadTitle(r),
        sticky: !!r.sticky,
        author: author && { username: author.username, display: author.display, isAgent: author.isAgent },
        createdAt: r.created_at,
        replies: r.reply_count,
        views: r.views,
        lastPost: { at: r.last_activity_at, by: lastBy && { username: lastBy.username, display: lastBy.display } },
        isNew: !!since && r.last_activity_at > since,
      };
    });
  const total = _db.prepare('SELECT COUNT(*) c FROM wall_posts WHERE wall_id = ?').get(wall.id).c;
  return {
    board: { slug: wall.slug, name: wall.name, category: wall.category || null },
    page: pageNo, limit: cap, total, threads,
  };
}

// ---- thread view ----

function threadView(postId, userId) {
  const post = _db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(postId);
  if (!post) throw httpError(404, 'not_found');
  const wall = _db.prepare('SELECT * FROM walls WHERE id = ?').get(post.wall_id);
  if (!wall) throw httpError(404, 'not_found');
  walls.assertMember(wall.slug, userId); // 404 for non-members, same as a missing thread
  if (walls.hiddenByWallOptOut(wall.id, post.author_user_id)) throw httpError(404, 'not_found');

  // Views count other people reading; an author refreshing their own
  // thread shouldn't inflate it.
  if (post.author_user_id !== userId) {
    _db.prepare('UPDATE wall_posts SET views = views + 1 WHERE id = ?').run(post.id);
    post.views += 1;
  }

  const view = walls.postView(post, userId);
  const replies = walls.listComments(wall.slug, post.id, userId).map((c) => ({
    ...c,
    member: c.author ? memberViewByUsername(c.author.username) : null,
  }));
  return {
    board: { slug: wall.slug, name: wall.name, category: wall.category || null },
    thread: {
      ...view,
      title: threadTitle(post),
      sticky: !!post.sticky,
      views: post.views,
      member: memberView(post.author_user_id),
    },
    replies,
  };
}

function memberViewByUsername(username) {
  const u = _db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  return u ? memberView(u.id) : null;
}

function setSticky(postId, sticky) {
  const info = _db.prepare('UPDATE wall_posts SET sticky = ? WHERE id = ?').run(sticky ? 1 : 0, postId);
  if (!info.changes) throw httpError(404, 'not_found');
  return { ok: true, sticky: !!sticky };
}

// ---- who's online / stats / birthdays ----

function whosOnline() {
  const rows = _db.prepare(`
    SELECT id, username, display, color, is_admin, last_active_at FROM users
    WHERE last_active_at >= datetime('now', '-${ONLINE_WINDOW_MIN} minutes')
    ORDER BY display COLLATE NOCASE ASC
  `).all();
  // Built-in Hearth has no session; never report him as "online".
  const members = rows
    .filter((u) => !hearthCharacters.isBuiltinAgentUserId(_db, u.id))
    .map((u) => ({
      username: u.username, display: u.display, color: u.color,
      rank: rankFor(u, postCountFor(u.id)), lastActiveAt: u.last_active_at,
    }));
  return { windowMinutes: ONLINE_WINDOW_MIN, count: members.length, members };
}

function birthdaysToday(now = new Date()) {
  const md = `${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
  return _db.prepare('SELECT username, display FROM users WHERE birthday = ? ORDER BY display COLLATE NOCASE').all(md);
}

function stats(userId) {
  const visible = visibleWallRows(userId);
  let threads = 0; let posts = 0;
  for (const w of visible) { const c = boardCounts(w.id, null); threads += c.threads; posts += c.posts; }
  const newest = _db.prepare('SELECT username, display FROM users ORDER BY id DESC LIMIT 1').get() || null;
  return {
    threads, posts,
    members: _db.prepare('SELECT COUNT(*) c FROM users').get().c,
    newestMember: newest,
    online: whosOnline().count,
    birthdaysToday: birthdaysToday(),
  };
}

// ---- profile fields ----

function updateProfile(userId, body) {
  const b = body || {};
  const sets = []; const args = [];
  if ('signature' in b) {
    if (b.signature !== null && typeof b.signature !== 'string') throw httpError(400, 'invalid_signature');
    const sig = b.signature === null ? null : b.signature.trim();
    if (sig && sig.length > SIGNATURE_MAX_LEN) throw httpError(400, 'signature_too_long');
    sets.push('signature = ?'); args.push(sig || null);
  }
  if ('birthday' in b) {
    if (b.birthday !== null && !(typeof b.birthday === 'string' && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(b.birthday))) {
      throw httpError(400, 'invalid_birthday');
    }
    sets.push('birthday = ?'); args.push(b.birthday);
  }
  if (!sets.length) throw httpError(400, 'nothing_to_update');
  _db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, userId);
  return memberView(userId);
}

module.exports = {
  RANKS,
  SEED_BOARDS,
  ONLINE_WINDOW_MIN,
  SIGNATURE_MAX_LEN,
  migrate,
  seed,
  touchActivity,
  boardIndex,
  threadList,
  threadView,
  setSticky,
  whosOnline,
  stats,
  birthdaysToday,
  updateProfile,
  memberView,
  threadTitle,
};
