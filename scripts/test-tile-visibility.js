#!/usr/bin/env node
// PHA-1863 acceptance tests for the v0.1.2 tile-visibility wiring.
//
// Drives `lib/user-model.js` directly against a temp SQLite file. No
// HTTP server, no subprocess. Each test runs migrate() on a fresh DB
// so they're independent and idempotent.
//
// Covers the four acceptance bullets from the issue body:
//   1. Tile with no tile_visibility_* rows is visible to every authenticated user.
//   2. Tile restricted to a group is invisible to a user not in that group.
//   3. Tile restricted to a group is visible to a user in that group.
//   4. Per-user override (tile_visibility_users) makes the tile visible
//      regardless of group membership.
//   5. ?visibility=mine returns only tiles where services.owner = username.
//   6. ?visibility=shared returns only tiles the user has an explicit
//      visibility row on (group OR user override).
//   7. ?visibility=all returns every tile the user can see under the
//      base visibility rule (open OR group OR user override).
//   8. setTileVisibility writes through with clear-then-write semantics
//      and admin-only POST/PUT enforcement is enforced at the route
//      layer (the route is covered by an HTTP smoke test in the
//      companion test; here we exercise the helper).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-tile-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  // The seed migration inserts an "Example" service so a fresh DB
  // isn't visually empty. Tests below are easier to write if the row
  // isn't there — clear it on every fresh DB.
  db.prepare('DELETE FROM services').run();
  return { db, tmpDir, dbPath };
}

function addService(db, owner, name = 'svc') {
  const max = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM services').get().m;
  const r = db.prepare('INSERT INTO services (name,url,icon,descr,sort,owner,open_mode) VALUES (?,?,?,?,?,?,?)')
    .run(name, `https://${name}.example`, '🔗', '', max + 1, owner, 'frame');
  return r.lastInsertRowid;
}

function provision(db, username, groups) {
  return userModel.provisionOrClaim(db, username, 'header_trust', username, groups);
}

console.log('PHA-1863 tile-visibility tests\n');

// ---- Test 1: open-to-all ----
{
  console.log('Test 1: tile with no visibility rows is visible to all users');
  const { db, tmpDir } = freshDb();
  const id = addService(db, 'all', 'OpenTile');
  const visible = userModel.isTileVisible(db, 1, 'service', id);
  assert(visible, 'open tile is visible to user id 1 (admin)');
  const me = userModel.getTileVisibility(db, 'service', id);
  assertEq(me, { groups: [], users: [] }, 'visibility object is empty for open tile');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: group-restricted hides non-members ----
{
  console.log('\nTest 2: group-restricted tile hides non-members');
  const { db, tmpDir } = freshDb();
  const id = addService(db, 'all', 'HouseholdOnly');
  userModel.setTileVisibility(db, 'service', id, ['household'], []);

  // admin (id=1) is in 'admins' + 'household' from the seed.
  assert(userModel.isTileVisible(db, 1, 'service', id), 'admin (in household) sees household tile');
  // brandon (id=2) is in 'household' from the seed.
  assert(userModel.isTileVisible(db, 2, 'service', id), 'brandon (in household) sees household tile');
  // emily (id=3) is in 'household' from the seed.
  assert(userModel.isTileVisible(db, 3, 'service', id), 'emily (in household) sees household tile');

  // Create a user in 'family' only.
  const sam = userModel.provisionOrClaim(db, 'sam', 'header_trust', 'sam-id', ['family']);
  assert(!userModel.isTileVisible(db, sam.id, 'service', id), 'sam (family only) does NOT see household tile');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 3: per-user override ----
{
  console.log('\nTest 3: per-user override makes tile visible regardless of group');
  const { db, tmpDir } = freshDb();
  const sam = provision(db, 'sam', ['family']);
  const id = addService(db, 'all', 'PrivateToSam');
  userModel.setTileVisibility(db, 'service', id, [], ['sam']);

  assert(userModel.isTileVisible(db, sam.id, 'service', id), 'sam sees tile via per-user override');

  // emily (id=3, household only) does NOT see it.
  assert(!userModel.isTileVisible(db, 3, 'service', id), 'emily does NOT see sam-only tile');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 4: visibility resolution reads back group + user names ----
{
  console.log('\nTest 4: getTileVisibility returns sorted group + user names');
  const { db, tmpDir } = freshDb();
  const id = addService(db, 'all', 'Mixed');
  userModel.setTileVisibility(db, 'service', id, ['family', 'household'], ['brandon', 'emily']);
  // brandon and emily are seeded users.
  const out = userModel.getTileVisibility(db, 'service', id);
  assertEq(out, { groups: ['family', 'household'], users: ['brandon', 'emily'] }, 'groups + users sorted alphabetically');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 5: setTileVisibility clear-then-write semantics ----
{
  console.log('\nTest 5: setTileVisibility replaces (not merges)');
  const { db, tmpDir } = freshDb();
  const id = addService(db, 'all', 'Churn');
  userModel.setTileVisibility(db, 'service', id, ['household', 'family'], ['brandon']);
  userModel.setTileVisibility(db, 'service', id, ['admins'], []);
  const out = userModel.getTileVisibility(db, 'service', id);
  assertEq(out, { groups: ['admins'], users: [] }, 'second setTileVisibility replaced prior restrictions');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 6: setTileVisibility auto-creates group rows ----
{
  console.log('\nTest 6: setTileVisibility auto-creates unknown group rows');
  const { db, tmpDir } = freshDb();
  const id = addService(db, 'all', 'AutoGroup');
  userModel.setTileVisibility(db, 'service', id, ['photography-club'], []);
  const grp = db.prepare("SELECT name FROM groups WHERE name = 'photography-club'").get();
  assert(!!grp, 'photography-club group row auto-created');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 7: ?visibility=mine ----
{
  console.log('\nTest 7: getServicesForUser visibility=mine returns only owned');
  const { db, tmpDir } = freshDb();
  addService(db, 'brandon', 'BrandonPrivate');
  addService(db, 'emily', 'EmilyPrivate');
  addService(db, 'all', 'OpenShared');

  const me = userModel.getMe(db, 'brandon');
  const rows = userModel.getServicesForUser(db, me.id, me.username, 'mine');
  const names = rows.map(r => r.name).sort();
  assertEq(names, ['BrandonPrivate'], 'mine returns only brandon-owned');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 8: ?visibility=shared ----
{
  console.log('\nTest 8: getServicesForUser visibility=shared returns user-with-row tiles');
  const { db, tmpDir } = freshDb();
  const sam = provision(db, 'sam', ['family']);
  const householdId = addService(db, 'all', 'HouseholdShared');
  const privateId = addService(db, 'all', 'SamOnly');
  const openId = addService(db, 'all', 'OpenShared');
  userModel.setTileVisibility(db, 'service', householdId, ['household'], []);
  userModel.setTileVisibility(db, 'service', privateId, [], ['sam']);

  const rows = userModel.getServicesForUser(db, sam.id, sam.username, 'shared');
  const names = rows.map(r => r.name).sort();
  // sam is in 'family' (not household); sam does NOT see HouseholdShared via group.
  // sam DOES see SamOnly via per-user override.
  assertEq(names, ['SamOnly'], 'shared returns only tiles sam has a row on (no group match)');

  // Now check brandon (in household).
  const brandon = userModel.getMe(db, 'brandon');
  const brandonRows = userModel.getServicesForUser(db, brandon.id, brandon.username, 'shared');
  assertEq(brandonRows.map(r => r.name).sort(), ['HouseholdShared'], 'brandon sees HouseholdShared via group row');

  // Open tile has no visibility rows, so it does NOT appear in `shared`.
  const openRows = userModel.getServicesForUser(db, sam.id, sam.username, 'shared');
  assert(!openRows.some(r => r.name === 'OpenShared'), 'open tile NOT in shared (no explicit row)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 9: ?visibility=all ----
{
  console.log('\nTest 9: getServicesForUser visibility=all applies base visibility rule');
  const { db, tmpDir } = freshDb();
  const sam = provision(db, 'sam', ['family']);
  const openId = addService(db, 'all', 'OpenShared');
  const householdId = addService(db, 'all', 'HouseholdOnly');
  const privateId = addService(db, 'all', 'SamOnly');
  userModel.setTileVisibility(db, 'service', householdId, ['household'], []);
  userModel.setTileVisibility(db, 'service', privateId, [], ['sam']);

  const rows = userModel.getServicesForUser(db, sam.id, sam.username, 'all');
  const names = rows.map(r => r.name).sort();
  // sam is in 'family' (not household); sam sees OpenShared (open) + SamOnly (per-user override).
  assertEq(names, ['OpenShared', 'SamOnly'], 'all = open OR direct row, base visibility filter');

  const brandon = userModel.getMe(db, 'brandon');
  const brandonRows = userModel.getServicesForUser(db, brandon.id, brandon.username, 'all');
  assertEq(brandonRows.map(r => r.name).sort(), ['HouseholdOnly', 'OpenShared'], 'brandon sees household + open via group + open');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 10: default visibility is mine ----
{
  console.log('\nTest 10: default visibility (no mode) is "mine"');
  const { db, tmpDir } = freshDb();
  addService(db, 'brandon', 'BrandonPrivate');
  addService(db, 'emily', 'EmilyPrivate');
  const me = userModel.getMe(db, 'brandon');
  const rows = userModel.getServicesForUser(db, me.id, me.username, undefined);
  assertEq(rows.map(r => r.name), ['BrandonPrivate'], 'undefined mode defaults to mine');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 11: delete clears visibility rows ----
{
  console.log('\nTest 11: DEL service row cascades visibility rows via DELETE handler contract');
  // The route handler in server.js runs DELETE FROM tile_visibility_*
  // in the same transaction as DELETE FROM services. This test pins
  // the contract: the helper setTileVisibility writes rows that the
  // delete query can subsequently clean up.
  const { db, tmpDir } = freshDb();
  const id = addService(db, 'all', 'Doomed');
  userModel.setTileVisibility(db, 'service', id, ['household'], ['brandon']);
  const beforeGroups = db.prepare("SELECT COUNT(*) c FROM tile_visibility_groups WHERE tile_id = ?").get(id).c;
  const beforeUsers = db.prepare("SELECT COUNT(*) c FROM tile_visibility_users WHERE tile_id = ?").get(id).c;
  assertEq(beforeGroups, 1, 'one group row before delete');
  assertEq(beforeUsers, 1, 'one user row before delete');

  // Simulate the route's transactional delete.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM tile_visibility_groups WHERE tile_kind = ? AND tile_id = ?').run('service', id);
    db.prepare('DELETE FROM tile_visibility_users WHERE tile_kind = ? AND tile_id = ?').run('service', id);
    db.prepare('DELETE FROM services WHERE id = ?').run(id);
  });
  tx();
  const afterGroups = db.prepare("SELECT COUNT(*) c FROM tile_visibility_groups WHERE tile_id = ?").get(id).c;
  const afterUsers = db.prepare("SELECT COUNT(*) c FROM tile_visibility_users WHERE tile_id = ?").get(id).c;
  const afterSvc = db.prepare("SELECT COUNT(*) c FROM services WHERE id = ?").get(id).c;
  assertEq(afterGroups, 0, 'group rows cleared');
  assertEq(afterUsers, 0, 'user rows cleared');
  assertEq(afterSvc, 0, 'service row cleared');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 12: TILE_KIND_SERVICE constant exported ----
{
  console.log('\nTest 12: TILE_KIND_SERVICE constant exported');
  assertEq(userModel.TILE_KIND_SERVICE, 'service', 'constant matches schema default');
}

// ---- Test 13: server.js grep gate (no hardcoded group names in route) ----
{
  console.log('\nTest 13: server.js grep gate — no hardcoded group names in route code');
  const serverSrc = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  // Strip comments to defeat false positives in doc blocks.
  const stripped = serverSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');
  const re = /['"](household|family|media-club|admins)['"]/gi;
  const hits = stripped.match(re);
  assert(!hits || hits.length === 0, 'no hardcoded group literals in server.js', hits ? hits.join(', ') : '');
}

console.log(`\nResults: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
