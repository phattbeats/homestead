#!/usr/bin/env node
// PHA-2218.4 acceptance tests for per-thread mute (lib/notifications.js
// muteThread/unmuteThread + the resolver composition already covered in
// test-notifications-resolver.js): DB-backed persistence, CASCADE on
// post delete, and that a mute never suppresses the author's own
// activity (no self-suppression — the mute table is keyed by (user_id,
// post_id), so an author who happens to mute their own post's thread
// only affects notifications directed at them, not their own posting).

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

console.log('PHA-2218.4 thread-mute tests\n');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-thread-mutes-test-'));
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
db.prepare('INSERT OR REPLACE INTO notification_prefs (user_id, quiet_start_hour, quiet_end_hour) VALUES (?, 0, 0)').run(brandon.id);
db.prepare('INSERT OR REPLACE INTO notification_prefs (user_id, quiet_start_hour, quiet_end_hour) VALUES (?, 0, 0)').run(emily.id);

const wallId = crypto.randomUUID();
db.prepare(`INSERT INTO walls (id, slug, name, visibility, group_name) VALUES (?, 'dm:mutes', 'DM', 'direct', NULL)`).run(wallId);
db.prepare('INSERT INTO wall_memberships (wall_id, user_id) VALUES (?, ?)').run(wallId, brandon.id);
db.prepare('INSERT INTO wall_memberships (wall_id, user_id) VALUES (?, ?)').run(wallId, emily.id);
notifications.setLevel(wallId, emily.id, 'all', 'wall_memberships');
const postId = crypto.randomUUID();
db.prepare(`INSERT INTO wall_posts (id, wall_id, author_user_id, kind, text_body) VALUES (?, ?, ?, 'text', 'hi')`).run(postId, wallId, brandon.id);

// ---- Test 1: mute is DB-backed and survives a fresh handle (session restart) ----
console.log('Test 1: mute persists (DB-backed)');
assertEq(notifications.isThreadMuted(emily.id, postId), false, 'not muted initially');
notifications.muteThread(emily.id, postId);
assertEq(notifications.isThreadMuted(emily.id, postId), true, 'muted after muteThread()');
const reopened = new Database(path.join(tmpDataDir, 'life.db'));
const persisted = reopened.prepare('SELECT 1 FROM thread_mutes WHERE user_id = ? AND post_id = ?').get(emily.id, postId);
assert(!!persisted, 'mute row is present on a freshly-opened DB handle (survives session restart)');
reopened.close();

// ---- Test 2: muteThread is idempotent ----
console.log('\nTest 2: idempotent mute/unmute');
notifications.muteThread(emily.id, postId); // second call, same row
assertEq(db.prepare('SELECT COUNT(*) c FROM thread_mutes WHERE user_id = ? AND post_id = ?').get(emily.id, postId).c, 1, 'muting twice does not duplicate the row');
notifications.unmuteThread(emily.id, postId);
notifications.unmuteThread(emily.id, postId); // second call, already absent
assertEq(notifications.isThreadMuted(emily.id, postId), false, 'unmute is idempotent (no-op on already-absent)');

// ---- Test 3: mute CASCADEs when the post is deleted ----
console.log('\nTest 3: mute CASCADEs on post delete');
notifications.muteThread(emily.id, postId);
assertEq(notifications.isThreadMuted(emily.id, postId), true, 'muted before delete');
walls.deletePost('dm:mutes', postId, brandon.id);
const afterDelete = db.prepare('SELECT 1 FROM thread_mutes WHERE post_id = ?').get(postId);
assert(!afterDelete, 'mute row is gone after the post is deleted (ON DELETE CASCADE)');

// ---- Test 4: mute does not block the author's own activity ----
// The mute table is keyed by (user_id, post_id) — a recipient muting a
// thread only ever suppresses notifications directed AT that recipient.
// It can never suppress the author's own createPost() call succeeding,
// nor affect what other, non-muting recipients receive.
console.log('\nTest 4: mute does not self-suppress the author or other recipients');
const post2Id = crypto.randomUUID();
db.prepare(`INSERT INTO wall_posts (id, wall_id, author_user_id, kind, text_body) VALUES (?, ?, ?, 'text', 'second post')`).run(post2Id, wallId, brandon.id);
notifications.muteThread(emily.id, post2Id); // emily mutes before any activity is emitted
notifications.emitForPost(
  db.prepare('SELECT * FROM walls WHERE id = ?').get(wallId),
  db.prepare('SELECT * FROM wall_posts WHERE id = ?').get(post2Id),
  brandon.id,
  [emily.id],
  new Set()
);
const emilyRow = db.prepare(`SELECT * FROM notification_log WHERE user_id = ? AND url LIKE '%' || ? || '%' ORDER BY id DESC LIMIT 1`).get(emily.id, post2Id);
assert(!!emilyRow, 'a row is still written for the muted recipient (for audit)');
assertEq(emilyRow.delivered, 0, 'muted recipient does not get delivered=1');
assertEq(emilyRow.skipped_reason, 'thread_muted', 'muted recipient row carries skipped_reason=thread_muted');

const brandonSelfRow = db.prepare(`SELECT 1 FROM notification_log WHERE user_id = ? AND url LIKE '%' || ? || '%'`).get(brandon.id, post2Id);
assert(!brandonSelfRow, 'the author (who did not mute anything) gets no row for their own post, same as before PHA-2218');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
