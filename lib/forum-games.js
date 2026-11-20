// Homestead — The Forum: the Fun Zone → Forum Games board (PHA-4423).
//
// A board is still just a wall and a game is still just a thread. The
// one thing a plain thread can't do is say no, so this module adds:
//
//   * wall_posts.forum_game: NULL for normal threads, 'count' for a
//     count-to-1000 thread. Only count threads have rules. Word
//     association is a plain thread on purpose.
//   * a reply guard on count threads, registered with
//     walls.addCommentGuard. It runs inside the comment insert
//     transaction, so check and insert are one step.
//       - the reply must start with the previous number plus one (the
//         first reply is 1). Text after the number is fine: "42! halfway-ish"
//       - nobody posts two numbers in a row
//       - once the count reaches COUNT_GOAL the thread is finished
//     Rejections are a 409 with `message`, a friendly sentence the UI
//     shows as is, and `expected`, the number that would have worked.
//   * a one-time seed of the board and its two sticky threads, recorded
//     in forum_seeds so it reaches installs that were seeded before this
//     board existed, and so an admin who deletes it doesn't see it
//     come back.
//
// The count is taken from the thread's latest reply, never stored, so
// deleting a reply (or a whole user) rewinds the count rather than
// leaving it out of step.

'use strict';

const crypto = require('crypto');
const walls = require('./walls');

const COUNT_GOAL = 1000;

const FUN_ZONE_SEED_KEY = 'fun-zone';
const FUN_ZONE_BOARD = Object.freeze({
  slug: 'forum-games', name: 'Forum Games', category: 'Fun Zone', sort: 40,
  description: 'Count to 1000, word association, and whatever else we come up with.',
});
const SEED_THREADS = Object.freeze([
  {
    game: 'count',
    title: `Count to ${COUNT_GOAL}`,
    text: [
      `Let's count to ${COUNT_GOAL}, one reply at a time.`,
      '',
      'Rules:',
      '• Each reply is the previous number plus one. The first reply is 1.',
      '• Start your reply with the number. You can say something after it.',
      '• No going twice in a row. Wait for someone else to post the next one.',
      '',
      'Go!',
    ].join('\n'),
  },
  {
    game: null,
    title: 'Word Association',
    text: [
      'Reply with the first word that comes to mind from the reply above yours.',
      'No rules and no wrong answers.',
      '',
      "I'll start: porch",
    ].join('\n'),
  },
]);

let _db = null;
let _guardRegistered = false;

function httpError(status, code, payload) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  if (payload) err.payload = payload;
  return err;
}

function migrate(db) {
  _db = db;
  const cols = db.prepare('PRAGMA table_info(wall_posts)').all().map((c) => c.name);
  if (!cols.includes('forum_game')) db.exec('ALTER TABLE wall_posts ADD COLUMN forum_game TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS forum_seeds (
      key        TEXT PRIMARY KEY,
      seeded_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  if (!_guardRegistered) {
    walls.addCommentGuard(guardReply);
    _guardRegistered = true;
  }
}

// ---- counting ----

// leadingNumber("42! halfway-ish") → 42. Accepts "#42" and "1,000".
// Returns null when the reply doesn't start with a whole number, which
// includes "4.5" and "12abc".
function leadingNumber(text) {
  const m = /^\s*#?(\d{1,3}(?:,\d{3})+|\d+)(?![\d.,]*\d)(?![a-z])/i.exec(String(text || ''));
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}

function lastReply(postId) {
  return _db.prepare('SELECT author_user_id, body FROM post_comments WHERE post_id = ? ORDER BY id DESC LIMIT 1').get(postId) || null;
}

// countState(postId): { last, next, lastByUserId, complete }. Every reply
// in a count thread got past guardReply, so the latest one is the count.
function countState(postId) {
  const r = lastReply(postId);
  const last = r ? (leadingNumber(r.body) || 0) : 0;
  return { last, next: last + 1, lastByUserId: r ? r.author_user_id : null, complete: last >= COUNT_GOAL };
}

function guardReply(post, callerId, body) {
  if (post.forum_game !== 'count') return;
  const s = countState(post.id);
  if (s.complete) {
    throw httpError(409, 'count_complete', {
      message: `We already made it to ${COUNT_GOAL}! 🎉 This one's finished. Try Word Association next.`,
      expected: null,
    });
  }
  if (s.lastByUserId === callerId) {
    throw httpError(409, 'count_twice_in_a_row', {
      message: `No going twice in a row! Let someone else post ${s.next}, then you can jump back in.`,
      expected: s.next,
    });
  }
  const n = leadingNumber(body);
  if (n === null) {
    throw httpError(409, 'count_not_a_number', {
      message: `This is the counting thread, so start your reply with the next number: ${s.next}.`,
      expected: s.next,
    });
  }
  if (n !== s.next) {
    throw httpError(409, 'count_wrong_number', {
      message: `So close! The next number is ${s.next}, not ${n}.`,
      expected: s.next,
    });
  }
}

// forThread(post): the game block for the thread view, or null for a
// plain thread.
function forThread(post) {
  if (!post || post.forum_game !== 'count') return null;
  const s = countState(post.id);
  const by = s.lastByUserId ? walls.userView(s.lastByUserId) : null;
  return {
    kind: 'count',
    goal: COUNT_GOAL,
    last: s.last,
    next: s.complete ? null : s.next,
    complete: s.complete,
    lastBy: by && { username: by.username, display: by.display },
  };
}

// ---- seed ----

// seedFunZone(db, authorUserId): once per install. Creates the board
// (or files an existing `forum-games` wall under Fun Zone) and, when the
// board is new, its two sticky threads by authorUserId (the built-in
// Hearth). Threads are inserted directly, not via walls.createPost, so
// a boot doesn't send everyone a notification.
function seedFunZone(db, authorUserId) {
  if (db.prepare('SELECT 1 FROM forum_seeds WHERE key = ?').get(FUN_ZONE_SEED_KEY)) return { seeded: false };
  const b = FUN_ZONE_BOARD;
  const tx = db.transaction(() => {
    let wall = db.prepare('SELECT id, category FROM walls WHERE slug = ?').get(b.slug);
    let created = false;
    if (!wall) {
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO walls (id, slug, name, visibility, group_name, category, sort)
                  VALUES (?, ?, ?, 'group', 'household', ?, ?)`).run(id, b.slug, b.name, b.category, b.sort);
      wall = { id };
      created = true;
    } else if (!wall.category) {
      db.prepare('UPDATE walls SET category = ?, sort = ? WHERE id = ?').run(b.category, b.sort, wall.id);
    }
    if (created && authorUserId) {
      // Distinct timestamps keep the counting thread on top among stickies.
      SEED_THREADS.forEach((t, i) => {
        db.prepare(`INSERT INTO wall_posts (id, wall_id, author_user_id, kind, text_body, title, sticky, forum_game, created_at)
                    VALUES (?, ?, ?, 'text', ?, ?, 1, ?, datetime('now', ?))`)
          .run(crypto.randomUUID(), wall.id, authorUserId, t.text, t.title, t.game, `-${i} seconds`);
      });
    }
    db.prepare('INSERT INTO forum_seeds (key) VALUES (?)').run(FUN_ZONE_SEED_KEY);
    return { seeded: true, created };
  });
  return tx();
}

module.exports = {
  COUNT_GOAL,
  FUN_ZONE_BOARD,
  FUN_ZONE_SEED_KEY,
  migrate,
  leadingNumber,
  countState,
  forThread,
  seedFunZone,
};
