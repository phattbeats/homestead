#!/usr/bin/env node
// PHA-2150 acceptance tests for lib/walls.js: schema migrate, the
// group/direct membership gate, post create/list/delete, reaction
// toggle idempotence, comment create/list/1k cap, the new
// admin wall-CRUD + member-management routes (PHA-2556), and an
// activity-feed wiring check. Also a defensive grep guard: no ORDER BY
// in lib/walls.js may sort by anything but created_at, so a future
// "sort by reactions" PR fails CI outright.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
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
function assertThrowsStatus(fn, status, label) {
  try {
    fn();
    ng(label, 'did not throw');
  } catch (e) {
    assertEq(e.status, status, label);
  }
}

console.log('PHA-2150 walls tests\n');

// ---- Guard: every ORDER BY in lib/walls.js must sort by created_at ----
console.log('Guard: ORDER BY defensive grep');
const wallsSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'walls.js'), 'utf8');
const orderByRe = /ORDER BY\s+([^\n]+?)(?:LIMIT|`|\n)/gi;
let m;
let badOrderBy = null;
while ((m = orderByRe.exec(wallsSrc))) {
  const clause = m[1].trim();
  if (!/created_at/i.test(clause)) { badOrderBy = clause; break; }
}
assert(!badOrderBy, 'no ORDER BY sorts by anything other than created_at', badOrderBy);

// ---- Guard (PHA-2153): the activity-feed query (recentActivity, backing
// activity_recent in lib/snapshot.js) is held to the same chronological-
// only contract as the wall itself. Scoped to that one function — the rest
// of snapshot.js legitimately sorts tasks/events by due_date/date.
console.log('Guard: activity-feed ORDER BY defensive grep');
const snapshotSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'snapshot.js'), 'utf8');
const activityFnMatch = snapshotSrc.match(/function recentActivity\([^)]*\)\s*{[\s\S]*?\n}/);
assert(!!activityFnMatch, 'recentActivity() found in lib/snapshot.js');
const activityFnSrc = activityFnMatch ? activityFnMatch[0] : '';
const snapshotOrderByRe = /ORDER BY\s+([^\n]+?)(?:LIMIT|`|\n)/gi;
let sm;
let badSnapshotOrderBy = null;
while ((sm = snapshotOrderByRe.exec(activityFnSrc))) {
  const clause = sm[1].trim();
  if (!/created_at/i.test(clause)) { badSnapshotOrderBy = clause; break; }
}
assert(!badSnapshotOrderBy, 'recentActivity() ORDER BY sorts by created_at only', badSnapshotOrderBy);

(async () => {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-walls-test-'));
  process.env.DATA_DIR = tmpDataDir;

  const userModel = require('../lib/user-model');
  const media = require('../lib/media');
  const walls = require('../lib/walls');
  const analytics = require('../lib/analytics');

  const dbPath = path.join(tmpDataDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  media.migrate(db);
  walls.migrate(db);
  walls.seed(db);
  // PHA-2210: dual-write helpers in lib/walls.js (wall_post_created,
  // wall_reaction_added, wall_comment_added) hit both notification_log
  // and analytics_events. Mirror the inline CREATE TABLE in server.js so
  // the test DB has both — the analytics layer is best-effort so a missing
  // table wouldn't fail the test, but the noise in stderr is ugly.
  db.exec(`
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
  `);
  analytics.migrate(db);

  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');

  // A third user with no group memberships at all, for the no-access case.
  db.prepare("INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES ('stranger','Stranger','#000',?,0)").run('x');
  const stranger = db.prepare('SELECT id FROM users WHERE username = ?').get('stranger');

  // ---- Test 1: seed + group membership gate ----
  console.log('\nTest 1: seed + group membership gate');
  // PHA-2556: the seeded wall is now 'household' (visibility=group,
  // group_name=household). brandon + emily + admin are all in
  // 'household' from lib/user-model.js's seed, so assertMember passes
  // immediately — that's the user-visible acceptance criterion.
  const seeded = db.prepare("SELECT * FROM walls WHERE slug = 'household'").get();
  assert(!!seeded, 'seed() creates household wall');
  assertEq(seeded.visibility, 'group', 'household wall is group-visibility');

  const seededMc = db.prepare("SELECT id FROM walls WHERE slug = 'media-club'").get();
  assertEq(seededMc, undefined, 'media-club wall is NOT seeded (only household ships)');

  // brandon + emily + admin are all in 'household' by default seed.
  assertEq(walls.assertMember('household', brandon.id).ok, true, 'household seed makes brandon a household-wall member');
  assertEq(walls.assertMember('household', emily.id).ok, true, 'household seed makes emily a household-wall member');
  assertEq(walls.assertMember('household', admin.id).ok, true, 'household seed makes admin a household-wall member');

  // ---- Test 2: admin createWall + adminAddMember machinery ----
  console.log('\nTest 2: admin createWall + member management');
  // PHA-2556: validateWallInput rejects bad input, createWall inserts
  // the row, adminAddMember is idempotent and group-aware.
  assertThrowsStatus(() => walls.createWall(db, admin.id, { slug: 'Bad Slug!', name: 'X', visibility: 'group', group_name: 'household' }), 400, 'createWall rejects bad slug');
  assertThrowsStatus(() => walls.createWall(db, admin.id, { slug: 'ok', name: '', visibility: 'group', group_name: 'household' }), 400, 'createWall rejects empty name');
  assertThrowsStatus(() => walls.createWall(db, admin.id, { slug: 'ok', name: 'X', visibility: 'private', group_name: 'household' }), 400, 'createWall rejects unknown visibility');
  // Direct walls do not require group_name — that's the point of
  // direct visibility (per-wall membership rows, no group derivation).

  // Create a fresh group wall to exercise the membership machinery on.
  const newWall = walls.createWall(db, admin.id, { slug: 'media-club', name: 'Media Club', visibility: 'group', group_name: 'media-club' });
  assertEq(newWall.slug, 'media-club', 'createWall returns the inserted row');

  // Slug collision is 409.
  assertThrowsStatus(() => walls.createWall(db, admin.id, { slug: 'media-club', name: 'Dup', visibility: 'group', group_name: 'media-club' }), 409, 'createWall rejects duplicate slug');

  // brandon is NOT in media-club initially (only in household).
  assertThrowsStatus(() => walls.assertMember('media-club', brandon.id), 404, 'household-only user gets 404 on media-club');

  // adminAddMember is idempotent — a second call is a no-op.
  walls.adminAddMember(db, 'media-club', admin.id, { username: 'brandon' });
  walls.adminAddMember(db, 'media-club', admin.id, { username: 'brandon' });
  assertEq(walls.assertMember('media-club', brandon.id).ok, true, 'adminAddMember grants media-club access');
  // And the grant flows into the GROUP layer too (reconcileGroups), so
  // assertMember's user_groups-joined-to-groups query finds brandon.
  const inMcGroup = db.prepare(`
    SELECT 1 FROM user_groups ug JOIN groups g ON g.id = ug.group_id
    WHERE ug.user_id = ? AND g.name = 'media-club'
  `).get(brandon.id);
  assert(!!inMcGroup, 'adminAddMember also writes user_groups for group walls');

  assertThrowsStatus(() => walls.assertMember('media-club', stranger.id), 404, 'non-member still gets 404');
  assertThrowsStatus(() => walls.assertMember('nope-does-not-exist', brandon.id), 404, 'unknown slug gets 404');

  // adminRemoveMember reverses both the wall_memberships and user_groups
  // rows for group walls (otherwise the user would still see the wall
  // via group membership).
  walls.adminRemoveMember(db, 'media-club', { username: 'brandon' });
  assertThrowsStatus(() => walls.assertMember('media-club', brandon.id), 404, 'adminRemoveMember revokes access');
  const stillInMc = db.prepare(`
    SELECT 1 FROM user_groups ug JOIN groups g ON g.id = ug.group_id
    WHERE ug.user_id = ? AND g.name = 'media-club'
  `).get(brandon.id);
  assert(!stillInMc, 'adminRemoveMember also drops the user_groups row for group walls');

  // Direct wall creation: admin is auto-added as admin role.
  const direct = walls.createWall(db, admin.id, { slug: 'private-bumpers', name: 'Bumpers', visibility: 'direct' });
  assertEq(direct.visibility, 'direct', 'direct wall stored with visibility=direct');
  const directMembers = db.prepare(`
    SELECT wm.role FROM wall_memberships wm JOIN walls w ON w.id = wm.wall_id
    WHERE w.slug = 'private-bumpers' AND wm.user_id = ?
  `).get(admin.id);
  assertEq(directMembers && directMembers.role, 'admin', 'creator gets wall-admin role on direct walls');

  // ---- Test 3: direct wall membership gate ----
  console.log('\nTest 3: direct wall membership gate');
  const directId = 'test-direct-wall-id';
  db.prepare("INSERT INTO walls (id, slug, name, visibility, group_name) VALUES (?, 'dm:test', 'DM', 'direct', NULL)").run(directId);
  db.prepare('INSERT INTO wall_memberships (wall_id, user_id) VALUES (?, ?)').run(directId, brandon.id);
  db.prepare('INSERT INTO wall_memberships (wall_id, user_id) VALUES (?, ?)').run(directId, emily.id);
  assertEq(walls.assertMember('dm:test', brandon.id).ok, true, 'direct wall member (brandon) passes');
  assertEq(walls.assertMember('dm:test', emily.id).ok, true, 'direct wall member (emily) passes');
  assertThrowsStatus(() => walls.assertMember('dm:test', stranger.id), 404, 'non-member of direct wall gets 404');

  // ---- Test 4: listForUser ----
  console.log('\nTest 4: listForUser');
  const brandonWalls = walls.listForUser(brandon.id);
  assert(brandonWalls.some((w) => w.slug === 'household'), 'brandon sees household (the seeded wall)');
  assert(brandonWalls.some((w) => w.slug === 'dm:test'), 'brandon sees dm:test');
  const strangerWalls = walls.listForUser(stranger.id);
  assertEq(strangerWalls.length, 0, 'stranger sees no walls');

  // ---- Test 5: post create/list/delete (on the seeded household wall) ----
  console.log('\nTest 5: post create/list/delete');
  const p1 = walls.createPost('household', brandon.id, { kind: 'text', text_body: 'first post' });
  assertEq(p1.text, 'first post', 'text post created with trimmed body');
  assertEq(p1.kind, 'text', 'kind=text');

  assertThrowsStatus(() => walls.createPost('household', brandon.id, { kind: 'text', text_body: '   ' }), 400, 'empty text_body rejected');
  assertThrowsStatus(() => walls.createPost('household', brandon.id, { kind: 'image' }), 400, 'image post without media_id rejected');
  assertThrowsStatus(() => walls.createPost('household', stranger.id, { kind: 'text', text_body: 'nope' }), 404, 'non-member cannot post');

  const p2 = walls.createPost('household', brandon.id, { kind: 'link', link_url: 'https://example.com', link_title: 'Example' });
  assertEq(p2.link.url, 'https://example.com', 'link post created');

  const listed = walls.postsForWall('household', brandon.id, null, 20);
  assertEq(listed.length, 2, 'postsForWall returns both posts');
  assert(listed.some((p) => p.id === p1.id) && listed.some((p) => p.id === p2.id), 'both posts present in the listing');

  const delResult = walls.deletePost('household', p1.id, brandon.id);
  assertEq(delResult.ok, true, 'author can delete own post');
  assertEq(walls.postsForWall('household', brandon.id, null, 20).length, 1, 'deleted post no longer listed');

  assertThrowsStatus(() => walls.deletePost('household', p2.id, stranger.id), 404, 'non-member cannot delete (404, membership checked first)');

  // admin IS auto-member of household (in 'household' group via seed).
  assertEq(walls.assertMember('household', admin.id).ok, true, 'global admin IS a household-wall member via seed');

  // hard cap: limit above POSTS_MAX_LIMIT is clamped, not honored
  for (let i = 0; i < 5; i++) walls.createPost('household', brandon.id, { kind: 'text', text_body: `bulk ${i}` });
  const clamped = walls.postsForWall('household', brandon.id, null, 9999);
  assert(clamped.length <= walls.POSTS_MAX_LIMIT, 'limit is clamped to POSTS_MAX_LIMIT');

  // ---- Test 6: reaction toggle idempotence ----
  console.log('\nTest 6: reaction toggle idempotence');
  const r1 = walls.toggleReaction('household', p2.id, brandon.id, 'fire');
  assertEq(r1.reacted, true, 'first toggle adds reaction');
  let summary = walls.postsForWall('household', brandon.id, null, 20).find((p) => p.id === p2.id);
  assertEq(summary.reactionSummary.fire, 1, 'reaction summary shows one fire');

  const r2 = walls.toggleReaction('household', p2.id, brandon.id, 'fire');
  assertEq(r2.reacted, false, 'second identical toggle removes reaction');
  summary = walls.postsForWall('household', brandon.id, null, 20).find((p) => p.id === p2.id);
  assertEq(summary.reactionSummary.fire, undefined, 'reaction summary is empty after toggle-off');

  assertThrowsStatus(() => walls.toggleReaction('household', p2.id, brandon.id, 'not-a-real-emoji'), 400, 'non-allowlisted emoji rejected');

  walls.toggleReaction('household', p2.id, brandon.id, 'heart');
  const removed = walls.removeReaction('household', p2.id, brandon.id, 'heart');
  assertEq(removed.ok, true, 'removeReaction returns ok');
  assertEq(walls.removeReaction('household', p2.id, brandon.id, 'heart').ok, true, 'removeReaction is idempotent (no-op on already-absent)');

  // ---- Test 7: comments ----
  console.log('\nTest 7: comments');
  const c1 = walls.createComment(p2.id, brandon.id, '  hello there  ');
  assertEq(c1.body, 'hello there', 'comment body is trimmed');
  const comments = walls.listComments('household', p2.id, brandon.id);
  assertEq(comments.length, 1, 'listComments returns the new comment');

  assertThrowsStatus(() => walls.createComment(p2.id, brandon.id, '   '), 400, 'empty comment rejected');
  assertThrowsStatus(() => walls.createComment(p2.id, brandon.id, 'x'.repeat(1001)), 400, 'over-1k comment rejected');
  const exactly1k = walls.createComment(p2.id, brandon.id, 'y'.repeat(1000));
  assertEq(exactly1k.body.length, 1000, 'exactly-1k comment accepted');

  assertThrowsStatus(() => walls.createComment(p2.id, stranger.id, 'nope'), 404, 'non-member cannot comment');

  // ---- Test 8: activity-feed wiring (PHA-2153) ----
  console.log('\nTest 8: activity-feed wiring');
  const snapshot = require('../lib/snapshot');
  const notifications = require('../lib/notifications');

  // emily is already a household member (seed) — give her level=all so
  // this test exercises the plain activity-feed wiring path independent
  // of level-gating (that gating is Test 9's job). Quiet hours off
  // (start===end means "no window") so pass/fail is wall-clock-free.
  notifications.setLevel(seeded.id, emily.id, 'all', 'user_groups');
  db.prepare('INSERT OR REPLACE INTO notification_prefs (user_id, quiet_start_hour, quiet_end_hour) VALUES (?, 0, 0)').run(emily.id);

  const activityPost = walls.createPost('household', brandon.id, { kind: 'text', text_body: 'activity feed check' });

  // recentActivity() is the exact function GET /api/me/snapshot's
  // activity_recent field is built from — same source, same shape.
  const emilyActivity = snapshot.recentActivity(db, emily.id, 25);
  const activityRow = emilyActivity.find((a) => a.tag === `wall_post:household:bundle`);
  assert(!!activityRow, 'wall post surfaces in a fellow member\'s activity_recent');
  assert(!!activityRow && activityRow.url.includes('wall=household'), 'activity row url carries the wall slug');
  assert(!!activityRow && activityRow.url.includes(activityPost.id), 'activity row url carries the post id');
  assertEq(activityRow && activityRow.category, 'wall_post', 'activity row category is wall_post');
  assertEq(activityRow && activityRow.delivered, true, 'activity row is marked delivered (level=all)');

  const brandonActivity = snapshot.recentActivity(db, brandon.id, 25);
  const selfRow = brandonActivity.find((a) => a.tag === `wall_post:household:bundle`);
  assert(!selfRow, 'author does not get an activity row for their own post');

  // ---- Test 9: PHA-2218 default level gates plain activity ----
  console.log('\nTest 9: PHA-2218 default level (mentions) suppresses a plain post');
  db.prepare("INSERT OR IGNORE INTO users (username, display, color, pass_hash, is_admin) VALUES ('kevin','Kevin','#111',?,0)").run('x');
  const kevin = db.prepare('SELECT id FROM users WHERE username = ?').get('kevin');
  // Put kevin in the household group so he's a wall member, then
  // disable quiet hours. Fresh members default to level=mentions.
  const hhGroup = db.prepare("SELECT id FROM groups WHERE name = 'household'").get();
  db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(kevin.id, hhGroup.id);
  db.prepare('INSERT OR REPLACE INTO notification_prefs (user_id, quiet_start_hour, quiet_end_hour) VALUES (?, 0, 0)').run(kevin.id);
  assertEq(notifications.getLevel(seeded.id, kevin.id), 'mentions', 'freshly-joined member defaults to level=mentions');

  const plainPost = walls.createPost('household', brandon.id, { kind: 'text', text_body: 'no mention here' });
  const kevinActivity = snapshot.recentActivity(db, kevin.id, 25);
  const kevinRow = kevinActivity.find((a) => a.url && a.url.includes(plainPost.id));
  assert(!!kevinRow, 'a skip row still lands in notification_log for audit (recentActivity does not filter delivered)');
  assertEq(kevinRow && kevinRow.delivered, false, 'level=mentions with no @mention is not delivered');

  const mentionPost = walls.createPost('household', brandon.id, { kind: 'text', text_body: 'hey @kevin check this out' });
  const kevinActivity2 = snapshot.recentActivity(db, kevin.id, 25);
  const mentionRow = kevinActivity2.find((a) => a.url && a.url.includes(mentionPost.id));
  assert(!!mentionRow, 'mention row lands for the level=mentions user');
  assertEq(mentionRow && mentionRow.delivered, true, '@mention is delivered even under level=mentions');
  assertEq(mentionRow && mentionRow.category, 'mention', 'mention row category is mention');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});