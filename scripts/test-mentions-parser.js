#!/usr/bin/env node
// PHA-2218.4 acceptance tests for lib/notifications.js's @mention system:
// wall-scoped parsing (parseMentions) and the mentions table's atomic
// insert (insertMentions), including the CHECK constraint that exactly
// one of post_id/comment_id is set.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

console.log('PHA-2218.4 mentions parser tests\n');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-mentions-test-'));
process.env.DATA_DIR = tmpDataDir;

const userModel = require('../lib/user-model');
const media = require('../lib/media');
const walls = require('../lib/walls');
const notifications = require('../lib/notifications');

const db = new Database(path.join(tmpDataDir, 'life.db'));
userModel.migrate(db);
media.migrate(db);
walls.migrate(db);
walls.seed(db);

const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
db.prepare("INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES ('kevin','Kevin','#111',?,0)").run('x');
const kevin = db.prepare('SELECT id FROM users WHERE username = ?').get('kevin');
// stranger exists but is never added to the wall — not a member.
db.prepare("INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES ('stranger','Stranger','#000',?,0)").run('x');

// Direct wall: brandon + emily only (kevin and stranger are not members).
const wallId = crypto.randomUUID();
db.prepare(`INSERT INTO walls (id, slug, name, visibility, group_name) VALUES (?, 'dm:mentions', 'DM', 'direct', NULL)`).run(wallId);
db.prepare('INSERT INTO wall_memberships (wall_id, user_id) VALUES (?, ?)').run(wallId, brandon.id);
db.prepare('INSERT INTO wall_memberships (wall_id, user_id) VALUES (?, ?)').run(wallId, emily.id);
const wall = db.prepare('SELECT * FROM walls WHERE id = ?').get(wallId);

// ---- Test 1: wall-scoped resolution ----
console.log('Test 1: wall-scoped @mention resolution');
const resolved = notifications.parseMentions('hey @emily check this out', wall, brandon.id);
assertEq(resolved.length, 1, 'one mention resolved');
assertEq(resolved[0] && resolved[0].id, emily.id, 'resolved to emily');

// ---- Test 2: non-member @-mentions are silently dropped ----
console.log('\nTest 2: non-member mentions dropped');
const withStranger = notifications.parseMentions('cc @kevin and @stranger, hi @emily', wall, brandon.id);
assertEq(withStranger.length, 1, 'kevin (non-member) and stranger (non-member) both dropped, only emily resolves');
assertEq(withStranger[0] && withStranger[0].id, emily.id, 'the one survivor is emily');

// ---- Test 3: self-mention is dropped ----
console.log('\nTest 3: self-mention dropped');
const selfMention = notifications.parseMentions('note to self @brandon', wall, brandon.id);
assertEq(selfMention.length, 0, 'a caller cannot @-mention themselves');

// ---- Test 4: duplicate @-mention collapses to one entry ----
console.log('\nTest 4: duplicate mention dedup');
const dup = notifications.parseMentions('@emily @emily @emily are you there', wall, brandon.id);
assertEq(dup.length, 1, 'triple @emily collapses to one resolved mention');

// ---- Test 5: insertMentions — post mention inserts post_id, comment mention inserts comment_id ----
console.log('\nTest 5: insertMentions row shape');
const postId = crypto.randomUUID();
db.prepare(`INSERT INTO wall_posts (id, wall_id, author_user_id, kind, text_body) VALUES (?, ?, ?, 'text', 'hi @emily')`).run(postId, wallId, brandon.id);
notifications.insertMentions({ postId, commentId: null, mentionerId: brandon.id, users: [emily] });
const postMentionRow = db.prepare('SELECT * FROM mentions WHERE post_id = ?').get(postId);
assert(!!postMentionRow, 'post mention row inserted');
assertEq(postMentionRow.post_id, postId, 'post_id set');
assertEq(postMentionRow.comment_id, null, 'comment_id left null');
assertEq(postMentionRow.mentioned_user_id, emily.id, 'mentioned_user_id is emily');
assertEq(postMentionRow.mentioned_by, brandon.id, 'mentioned_by is brandon');

const commentInfo = db.prepare('INSERT INTO post_comments (post_id, author_user_id, body) VALUES (?, ?, ?)').run(postId, brandon.id, 'cc @emily');
notifications.insertMentions({ postId: null, commentId: commentInfo.lastInsertRowid, mentionerId: brandon.id, users: [emily] });
const commentMentionRow = db.prepare('SELECT * FROM mentions WHERE comment_id = ?').get(commentInfo.lastInsertRowid);
assert(!!commentMentionRow, 'comment mention row inserted');
assertEq(commentMentionRow.post_id, null, 'post_id left null for a comment mention');
assertEq(commentMentionRow.comment_id, commentInfo.lastInsertRowid, 'comment_id set');

// ---- Test 6: CHECK constraint rejects both-null / both-set inserts ----
console.log('\nTest 6: mentions CHECK constraint');
let bothNullThrew = false;
try {
  db.prepare('INSERT INTO mentions (post_id, comment_id, mentioned_user_id, mentioned_by) VALUES (NULL, NULL, ?, ?)').run(emily.id, brandon.id);
} catch (e) { bothNullThrew = e.code === 'SQLITE_CONSTRAINT_CHECK'; }
assert(bothNullThrew, 'both post_id and comment_id NULL is rejected');

let bothSetThrew = false;
try {
  db.prepare('INSERT INTO mentions (post_id, comment_id, mentioned_user_id, mentioned_by) VALUES (?, ?, ?, ?)')
    .run(postId, commentInfo.lastInsertRowid, emily.id, brandon.id);
} catch (e) { bothSetThrew = e.code === 'SQLITE_CONSTRAINT_CHECK'; }
assert(bothSetThrew, 'both post_id and comment_id set is rejected');

// ---- Test 7: end-to-end via walls.createPost/createComment (transactional insert + emit) ----
console.log('\nTest 7: end-to-end through walls.createPost/createComment');
db.prepare('INSERT OR REPLACE INTO notification_prefs (user_id, quiet_start_hour, quiet_end_hour) VALUES (?, 0, 0)').run(emily.id);
const e2ePost = walls.createPost('dm:mentions', brandon.id, { kind: 'text', text_body: 'yo @emily look at this' });
const e2eMentionRow = db.prepare('SELECT * FROM mentions WHERE post_id = ?').get(e2ePost.id);
assert(!!e2eMentionRow, 'createPost() inserts a mentions row for an @-mentioned member');
assertEq(e2eMentionRow.mentioned_user_id, emily.id, 'mentions row targets emily');

const e2eComment = walls.createComment(e2ePost.id, brandon.id, 'ping @emily again');
const e2eCommentMentionRow = db.prepare('SELECT * FROM mentions WHERE comment_id = ?').get(e2eComment.id);
assert(!!e2eCommentMentionRow, 'createComment() inserts a mentions row for an @-mentioned member');

const notifRows = db.prepare(`SELECT * FROM notification_log WHERE user_id = ? AND category = 'mention' ORDER BY id ASC`).all(emily.id);
assertEq(notifRows.length, 2, 'two mention notification_log rows: one for the post, one for the comment');
assertEq(notifRows.every((r) => !!r.delivered), true, 'both mention rows are delivered (default level=mentions still lets mentions through)');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
