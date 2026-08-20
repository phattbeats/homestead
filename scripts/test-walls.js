#!/usr/bin/env node
// PHA-2150 acceptance tests for lib/walls.js: schema migrate, the
// group/direct membership gate, post create/list/delete, reaction
// toggle idempotence, and comment create/list/1k cap. Also a defensive
// grep guard: no ORDER BY in lib/walls.js may sort by anything but
// created_at, so a future "sort by reactions" PR fails CI outright.

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

(async () => {
  const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-walls-test-'));
  process.env.DATA_DIR = tmpDataDir;

  const userModel = require('../lib/user-model');
  const media = require('../lib/media');
  const walls = require('../lib/walls');

  const dbPath = path.join(tmpDataDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  media.migrate(db);
  walls.migrate(db);
  walls.seed(db);

  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');

  // A third user with no group memberships at all, for the no-access case.
  db.prepare("INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES ('stranger','Stranger','#000',?,0)").run('x');
  const stranger = db.prepare('SELECT id FROM users WHERE username = ?').get('stranger');

  // ---- Test 1: seed + group membership gate ----
  console.log('\nTest 1: seed + group membership gate');
  const seeded = db.prepare("SELECT * FROM walls WHERE slug = 'media-club'").get();
  assert(!!seeded, 'seed() creates media-club wall');
  assertEq(seeded.visibility, 'group', 'media-club is group-visibility');

  // brandon and emily are in 'household' by default seed, not 'media-club'.
  assertThrowsStatus(() => walls.assertMember('media-club', brandon.id), 404, 'household-only user gets 404 on media-club (not a member)');

  db.prepare('INSERT INTO groups (name, display_name, source_provider) VALUES (?,?,?) ON CONFLICT(name) DO NOTHING').run('media-club-dup', 'x', 'authentik');
  const mcGroup = db.prepare("SELECT id FROM groups WHERE name = 'media-club'").get();
  db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(brandon.id, mcGroup.id);
  const gate = walls.assertMember('media-club', brandon.id);
  assertEq(gate.ok, true, 'media-club member passes the gate');

  assertThrowsStatus(() => walls.assertMember('media-club', stranger.id), 404, 'non-member gets 404, not 403');
  assertThrowsStatus(() => walls.assertMember('nope-does-not-exist', brandon.id), 404, 'unknown slug gets 404');

  // ---- Test 2: direct wall membership gate ----
  console.log('\nTest 2: direct wall membership gate');
  const directId = 'test-direct-wall-id';
  db.prepare("INSERT INTO walls (id, slug, name, visibility, group_name) VALUES (?, 'dm:test', 'DM', 'direct', NULL)").run(directId);
  db.prepare('INSERT INTO wall_memberships (wall_id, user_id) VALUES (?, ?)').run(directId, brandon.id);
  db.prepare('INSERT INTO wall_memberships (wall_id, user_id) VALUES (?, ?)').run(directId, emily.id);
  assertEq(walls.assertMember('dm:test', brandon.id).ok, true, 'direct wall member (brandon) passes');
  assertEq(walls.assertMember('dm:test', emily.id).ok, true, 'direct wall member (emily) passes');
  assertThrowsStatus(() => walls.assertMember('dm:test', stranger.id), 404, 'non-member of direct wall gets 404');

  // ---- Test 3: listForUser ----
  console.log('\nTest 3: listForUser');
  const brandonWalls = walls.listForUser(brandon.id);
  assert(brandonWalls.some((w) => w.slug === 'media-club'), 'brandon sees media-club');
  assert(brandonWalls.some((w) => w.slug === 'dm:test'), 'brandon sees dm:test');
  const strangerWalls = walls.listForUser(stranger.id);
  assertEq(strangerWalls.length, 0, 'stranger sees no walls');

  // ---- Test 4: post create/list/delete ----
  console.log('\nTest 4: post create/list/delete');
  const p1 = walls.createPost('media-club', brandon.id, { kind: 'text', text_body: 'first post' });
  assertEq(p1.text, 'first post', 'text post created with trimmed body');
  assertEq(p1.kind, 'text', 'kind=text');

  assertThrowsStatus(() => walls.createPost('media-club', brandon.id, { kind: 'text', text_body: '   ' }), 400, 'empty text_body rejected');
  assertThrowsStatus(() => walls.createPost('media-club', brandon.id, { kind: 'image' }), 400, 'image post without media_id rejected');
  assertThrowsStatus(() => walls.createPost('media-club', stranger.id, { kind: 'text', text_body: 'nope' }), 404, 'non-member cannot post');

  const p2 = walls.createPost('media-club', brandon.id, { kind: 'link', link_url: 'https://example.com', link_title: 'Example' });
  assertEq(p2.link.url, 'https://example.com', 'link post created');

  const listed = walls.postsForWall('media-club', brandon.id, null, 20);
  assertEq(listed.length, 2, 'postsForWall returns both posts');
  assert(listed.some((p) => p.id === p1.id) && listed.some((p) => p.id === p2.id), 'both posts present in the listing');

  const delResult = walls.deletePost('media-club', p1.id, brandon.id);
  assertEq(delResult.ok, true, 'author can delete own post');
  assertEq(walls.postsForWall('media-club', brandon.id, null, 20).length, 1, 'deleted post no longer listed');

  assertThrowsStatus(() => walls.deletePost('media-club', p2.id, stranger.id), 404, 'non-member cannot delete (404, membership checked first)');

  // admin (not author, no membership row) cannot delete without wall-admin role
  assertThrowsStatus(() => walls.assertMember('media-club', admin.id), 404, 'global admin is not auto-member of media-club');

  // hard cap: limit above POSTS_MAX_LIMIT is clamped, not honored
  for (let i = 0; i < 5; i++) walls.createPost('media-club', brandon.id, { kind: 'text', text_body: `bulk ${i}` });
  const clamped = walls.postsForWall('media-club', brandon.id, null, 9999);
  assert(clamped.length <= walls.POSTS_MAX_LIMIT, 'limit is clamped to POSTS_MAX_LIMIT');

  // ---- Test 5: reaction toggle idempotence ----
  console.log('\nTest 5: reaction toggle idempotence');
  const r1 = walls.toggleReaction('media-club', p2.id, brandon.id, 'fire');
  assertEq(r1.reacted, true, 'first toggle adds reaction');
  let summary = walls.postsForWall('media-club', brandon.id, null, 20).find((p) => p.id === p2.id);
  assertEq(summary.reactionSummary.fire, 1, 'reaction summary reflects the add');
  assert(summary.myReactions.includes('fire'), 'myReactions includes fire');

  const r2 = walls.toggleReaction('media-club', p2.id, brandon.id, 'fire');
  assertEq(r2.reacted, false, 'second toggle removes reaction');
  summary = walls.postsForWall('media-club', brandon.id, null, 20).find((p) => p.id === p2.id);
  assertEq(summary.reactionSummary.fire, undefined, 'reaction summary reflects the removal');

  assertThrowsStatus(() => walls.toggleReaction('media-club', p2.id, brandon.id, 'not-a-real-emoji'), 400, 'non-allowlisted emoji rejected');

  walls.toggleReaction('media-club', p2.id, brandon.id, 'heart');
  const removed = walls.removeReaction('media-club', p2.id, brandon.id, 'heart');
  assertEq(removed.ok, true, 'explicit removeReaction succeeds');
  assertEq(walls.removeReaction('media-club', p2.id, brandon.id, 'heart').ok, true, 'removeReaction is idempotent (no-op on already-absent)');

  // ---- Test 6: comment create + list + 1k cap ----
  console.log('\nTest 6: comments');
  const c1 = walls.createComment(p2.id, brandon.id, '  hello there  ');
  assertEq(c1.body, 'hello there', 'comment body is trimmed');
  const comments = walls.listComments('media-club', p2.id, brandon.id);
  assertEq(comments.length, 1, 'listComments returns the new comment');

  assertThrowsStatus(() => walls.createComment(p2.id, brandon.id, '   '), 400, 'empty comment rejected');
  assertThrowsStatus(() => walls.createComment(p2.id, brandon.id, 'x'.repeat(1001)), 400, 'over-1k comment rejected');
  const exactly1k = walls.createComment(p2.id, brandon.id, 'y'.repeat(1000));
  assertEq(exactly1k.body.length, 1000, 'exactly-1k comment accepted');

  assertThrowsStatus(() => walls.createComment(p2.id, stranger.id, 'nope'), 404, 'non-member cannot comment');

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
