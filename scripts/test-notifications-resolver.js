#!/usr/bin/env node
// PHA-2218.4 acceptance tests for lib/notifications.js's resolve(): the
// per-wall level gate, thread-mute override, and quiet-hours composition
// (level decides IF, quiet hours decide WHEN — see the PHA-2218 design
// comment §2). Unit-level: calls resolve() directly against a bare DB,
// not through walls.createPost(), so these don't depend on wall/post
// plumbing at all.

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
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

console.log('PHA-2218.4 notifications resolver tests\n');

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-notif-resolver-test-'));
process.env.DATA_DIR = tmpDataDir;

const userModel = require('../lib/user-model');
const media = require('../lib/media');
const walls = require('../lib/walls');
const notifications = require('../lib/notifications');

const db = new Database(path.join(tmpDataDir, 'life.db'));
userModel.migrate(db);
media.migrate(db);
walls.migrate(db); // pulls in notifications.migrate() too
walls.seed(db);

const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
db.prepare('INSERT OR REPLACE INTO notification_prefs (user_id, quiet_start_hour, quiet_end_hour) VALUES (?, 0, 0)').run(brandon.id);

const wallId = crypto.randomUUID();
db.prepare(`INSERT INTO walls (id, slug, name, visibility, group_name) VALUES (?, 'notif-test', 'Notif Test', 'group', 'notif-test-group')`).run(wallId);
const postId = crypto.randomUUID();
db.prepare(`INSERT INTO wall_posts (id, wall_id, author_user_id, kind, text_body) VALUES (?, ?, ?, 'text', 'hi')`).run(postId, wallId, brandon.id);

// ---- Test 1: default level (no row) is 'mentions' ----
console.log('Test 1: default level');
assertEq(notifications.getLevel(wallId, brandon.id), 'mentions', 'no prefs row -> default level is mentions');

// ---- Test 2: level=none suppresses everything except nothing (none really means none) ----
console.log('\nTest 2: level=none suppresses wall_post and mention');
notifications.setLevel(wallId, brandon.id, 'none', 'user_groups');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'wall_post', postId }).deliver, false, 'level=none suppresses wall_post');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'wall_post', postId }).skippedReason, 'level_none', 'skippedReason is level_none');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'mention', postId }).deliver, false, 'level=none suppresses mention too');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'direct_share', postId }).deliver, false, 'level=none suppresses direct_share too');

// ---- Test 3: level=mentions suppresses wall_post, passes mention ----
console.log('\nTest 3: level=mentions');
notifications.setLevel(wallId, brandon.id, 'mentions', 'user_groups');
const wpResult = notifications.resolve({ userId: brandon.id, wallId, kind: 'wall_post', postId });
assertEq(wpResult.deliver, false, 'level=mentions suppresses plain wall_post');
assertEq(wpResult.skippedReason, 'level_mentions_no_match', 'skippedReason is level_mentions_no_match');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'mention', postId }).deliver, true, 'level=mentions passes an actual mention');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'direct_share', postId }).deliver, true, 'level=mentions passes direct_share (override)');

// ---- Test 4: level=all passes everything ----
console.log('\nTest 4: level=all');
notifications.setLevel(wallId, brandon.id, 'all', 'user_groups');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'wall_post', postId }).deliver, true, 'level=all passes wall_post');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'mention', postId }).deliver, true, 'level=all passes mention');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'direct_share', postId }).deliver, true, 'level=all passes direct_share');

// ---- Test 5: thread mute always wins, regardless of level ----
console.log('\nTest 5: thread mute overrides level=all');
notifications.muteThread(brandon.id, postId);
const mutedResult = notifications.resolve({ userId: brandon.id, wallId, kind: 'wall_post', postId });
assertEq(mutedResult.deliver, false, 'muted thread suppresses wall_post even at level=all');
assertEq(mutedResult.skippedReason, 'thread_muted', 'skippedReason is thread_muted');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'mention', postId }).deliver, false, 'muted thread suppresses a mention too — mute always wins');
notifications.unmuteThread(brandon.id, postId);
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'wall_post', postId }).deliver, true, 'unmute restores delivery');
assertEq(notifications.isThreadMuted(brandon.id, postId), false, 'isThreadMuted reflects the unmute');

// ---- Test 6: quiet hours suppress everything, including a mention ----
// (constitutional: quiet hours is WHEN, not IF — a mention does not
// bypass a user's own opt-out window; see design §2/§7.)
console.log('\nTest 6: quiet hours gate everything, mentions included');
// A [s, e) window can only ever span up to 23 hours (s === e means "off",
// not "always on" — see isInQuietHours). Pin the window to the current
// hour so this assertion is deterministic regardless of wall-clock time
// the suite happens to run at.
const nowHour = new Date().getHours();
db.prepare('UPDATE notification_prefs SET quiet_start_hour = ?, quiet_end_hour = ? WHERE user_id = ?')
  .run(nowHour, (nowHour + 1) % 24, brandon.id);
const quietWallPost = notifications.resolve({ userId: brandon.id, wallId, kind: 'wall_post', postId });
assertEq(quietWallPost.deliver, false, 'quiet hours suppress wall_post at level=all');
assertEq(quietWallPost.skippedReason, 'quiet_hours', 'skippedReason is quiet_hours');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'mention', postId }).deliver, false, 'quiet hours suppress a mention too');
assertEq(notifications.resolve({ userId: brandon.id, wallId, kind: 'wall_post', postId, force: true }).deliver, true, 'force:true bypasses quiet hours');
db.prepare('UPDATE notification_prefs SET quiet_start_hour = 0, quiet_end_hour = 0 WHERE user_id = ?').run(brandon.id);

// ---- Test 7: a user with no notification_prefs row at all still gets the table DEFAULT quiet window (21-8), not an unconditional pass ----
console.log('\nTest 7: no notification_prefs row falls back to the 21-8 default window');
db.prepare("INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES ('freshuser','Fresh','#123',?,0)").run('x');
const fresh = db.prepare('SELECT id FROM users WHERE username = ?').get('freshuser');
const noPrefsRow = db.prepare('SELECT * FROM notification_prefs WHERE user_id = ?').get(fresh.id);
assertEq(noPrefsRow, undefined, 'freshuser genuinely has no notification_prefs row yet');
assertEq(notifications.isInQuietHours(fresh.id, new Date('2026-01-01T22:00:00')), true, 'hour 22 (local) falls inside the default 21-8 window with no row');
assertEq(notifications.isInQuietHours(fresh.id, new Date('2026-01-01T12:00:00')), false, 'hour 12 (local) falls outside the default 21-8 window with no row');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
