#!/usr/bin/env node
// PHA-1622 acceptance tests for the activity feed (lib/activity.js).
//
// Drives the module directly against a temp SQLite file, layered on
// top of user-model's migrate() since activity.actor_user_id
// references users(id).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const activity = require('../lib/activity');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-test-'));
  const db = new Database(path.join(tmpDir, 'life.db'));
  userModel.migrate(db);
  activity.migrate(db);
  return db;
}

console.log('PHA-1622 activity feed tests\n');

// ---- Test 1: logActivity writes a joinable row ----
{
  const db = freshDb();
  const u = userModel.provisionOrClaim(db, 'emily', 'header_trust', 'emily', []);
  activity.logActivity(db, {
    actorUserId: u.id, verb: 'completed', objectType: 'task', objectId: 7,
    summaryText: 'Emily checked off milk', meta: { rotated_to: 'brandon' },
  });
  const items = activity.listActivity(db, {});
  assert(items.length === 1, 'one row written');
  assertEq(items[0].actor.username, 'emily', 'actor joined by username');
  assertEq(items[0].meta, { rotated_to: 'brandon' }, 'meta round-trips as JSON');
  assertEq(items[0].object_id, '7', 'object_id stored as string');
}

// ---- Test 2: listActivity newest-first ----
{
  const db = freshDb();
  const u = userModel.provisionOrClaim(db, 'brandon', 'header_trust', 'brandon', []);
  for (let i = 0; i < 3; i++) {
    activity.logActivity(db, { actorUserId: u.id, verb: 'created', objectType: 'task', objectId: i, summaryText: `row ${i}` });
  }
  const items = activity.listActivity(db, {});
  assertEq(items.map(r => r.summary_text), ['row 2', 'row 1', 'row 0'], 'reverse-chron order');
}

// ---- Test 3: filters — user, since, before (pagination cursor) ----
{
  const db = freshDb();
  const brandon = userModel.provisionOrClaim(db, 'brandon', 'header_trust', 'brandon', []);
  const emily = userModel.provisionOrClaim(db, 'emily', 'header_trust', 'emily', []);
  activity.logActivity(db, { actorUserId: brandon.id, verb: 'created', objectType: 'task', objectId: 1, summaryText: 'a' });
  activity.logActivity(db, { actorUserId: emily.id, verb: 'created', objectType: 'task', objectId: 2, summaryText: 'b' });
  activity.logActivity(db, { actorUserId: brandon.id, verb: 'created', objectType: 'task', objectId: 3, summaryText: 'c' });

  const mineOnly = activity.listActivity(db, { user: 'emily' });
  assert(mineOnly.length === 1 && mineOnly[0].summary_text === 'b', 'user filter scopes to one actor');

  const all = activity.listActivity(db, {});
  const cursor = all[0].id; // newest row
  const paged = activity.listActivity(db, { before: cursor });
  assert(paged.every(r => r.id < cursor), 'before-cursor pagination excludes newer rows');
  assert(paged.length === 2, 'before-cursor pagination returns the remaining rows');
}

// ---- Test 4: limit is clamped ----
{
  const db = freshDb();
  const u = userModel.provisionOrClaim(db, 'brandon', 'header_trust', 'brandon', []);
  for (let i = 0; i < 5; i++) activity.logActivity(db, { actorUserId: u.id, verb: 'created', objectType: 'task', objectId: i, summaryText: `row ${i}` });
  assertEq(activity.listActivity(db, { limit: 2 }).length, 2, 'limit is respected');
  assertEq(activity.listActivity(db, { limit: 99999 }).length <= 200, true, 'limit is clamped to a max');
}

// ---- Test 5: logActivity is best-effort — missing required fields is a silent no-op ----
{
  const db = freshDb();
  activity.logActivity(db, { actorUserId: null, verb: '', objectType: 'task', summaryText: 'x' });
  assertEq(activity.listActivity(db, {}).length, 0, 'row without a verb is silently skipped');
}

// ---- Test 6: system-initiated rows (actorUserId null) still list, with actor: null ----
{
  const db = freshDb();
  activity.logActivity(db, { actorUserId: null, verb: 'synced', objectType: 'entity', objectId: 1, summaryText: 'Plex sync added 4 items' });
  const items = activity.listActivity(db, {});
  assertEq(items.length, 1, 'system row written');
  assertEq(items[0].actor, null, 'actor is null for system-initiated rows');
}

// ---- Test 7: prune enforces both the row cap and the age cap ----
{
  const db = freshDb();
  const u = userModel.provisionOrClaim(db, 'brandon', 'header_trust', 'brandon', []);
  for (let i = 0; i < 20; i++) activity.logActivity(db, { actorUserId: u.id, verb: 'created', objectType: 'task', objectId: i, summaryText: `row ${i}` });
  // Force one row to look 91 days old so the age-based prune has something to bite.
  db.prepare(`UPDATE activity SET ts = datetime('now', '-91 days') WHERE id = (SELECT MIN(id) FROM activity)`).run();
  activity.prune(db);
  const remaining = activity.listActivity(db, { limit: 200 });
  assert(remaining.length === 19, 'prune drops rows past the retention window', `got ${remaining.length}`);
}

console.log(`\nResults: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
