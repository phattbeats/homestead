#!/usr/bin/env node
// PHA-1618 acceptance tests for the v0.0.5 user model.
//
// Drives `lib/user-model.js` directly against a temp SQLite file. No
// HTTP server, no subprocess. Each test runs migrate() on a fresh DB
// so they're independent and idempotent.

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  return { db, tmpDir, dbPath };
}

console.log('PHA-1618 user-model tests\n');

// ---- Test 1: fresh install seeds ----
{
  console.log('Test 1: fresh install seeds admin + brandon + emily + groups');
  const { db, tmpDir } = freshDb();
  const users = db.prepare('SELECT username, is_admin FROM users ORDER BY username').all();
  assertEq(users.map(u => u.username), ['admin', 'brandon', 'emily'], 'seeds three users');
  assertEq(users.find(u => u.username === 'admin').is_admin, 1, 'admin is_admin=1');
  assertEq(users.find(u => u.username === 'brandon').is_admin, 0, 'brandon is_admin=0 (household only, not admins)');
  assertEq(users.find(u => u.username === 'emily').is_admin, 0, 'emily is_admin=0');

  const groups = db.prepare('SELECT name FROM groups ORDER BY name').all().map(g => g.name);
  assertEq(groups, ['admins', 'family', 'household', 'media-club'], 'four canonical groups seeded');

  const adminGroups = db.prepare(`SELECT g.name FROM user_groups ug
    JOIN users u ON u.id = ug.user_id JOIN groups g ON g.id = ug.group_id
    WHERE u.username = 'admin' ORDER BY g.name`).all().map(g => g.name);
  assertEq(adminGroups, ['admins', 'household'], 'admin in admins + household');

  const brandonGroups = db.prepare(`SELECT g.name FROM user_groups ug
    JOIN users u ON u.id = ug.user_id JOIN groups g ON g.id = ug.group_id
    WHERE u.username = 'brandon' ORDER BY g.name`).all().map(g => g.name);
  assertEq(brandonGroups, ['household'], 'brandon in household');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: CLAIM-first on existing seeded row ----
{
  console.log('\nTest 2: CLAIM attaches to seeded row, preserves history');
  const { db, tmpDir } = freshDb();
  // Seed a task owned by brandon BEFORE CLAIM.
  db.prepare(`INSERT INTO tasks (title, assignee, created_by) VALUES (?, ?, ?)`)
    .run('Take out trash', 'brandon', 'brandon');
  const taskOwnerBefore = db.prepare(`SELECT assignee FROM tasks WHERE title = 'Take out trash'`).get().assignee;
  assertEq(taskOwnerBefore, 'brandon', 'pre-CLAIM task assignee=brandon');

  // CLAIM with header-trust groups.
  const claimed = userModel.provisionOrClaim(db, 'brandon', 'header_trust', 'brandon-from-authentik', ['household', 'family']);
  assertEq(claimed.username, 'brandon', 'CLAIM returns seeded brandon row');

  // No duplicate row.
  const rows = db.prepare(`SELECT username FROM users ORDER BY username`).all().map(r => r.username);
  assertEq(rows, ['admin', 'brandon', 'emily'], 'CLAIM did not duplicate');

  // History preserved.
  const taskOwnerAfter = db.prepare(`SELECT assignee FROM tasks WHERE title = 'Take out trash'`).get().assignee;
  assertEq(taskOwnerAfter, 'brandon', 'task history still attached to seeded row');

  // auth_provider + provider_subject + claimed_at populated.
  const meta = db.prepare(`SELECT auth_provider, provider_subject, claimed_at, last_seen_at FROM users WHERE username = 'brandon'`).get();
  assertEq(meta.auth_provider, 'header_trust', 'CLAIM sets auth_provider');
  assertEq(meta.provider_subject, 'brandon-from-authentik', 'CLAIM sets provider_subject');
  assert(!!meta.claimed_at, 'CLAIM sets claimed_at');
  assert(!!meta.last_seen_at, 'CLAIM sets last_seen_at');

  // Group reconciliation: user_groups now reflects the header groups.
  const newGroups = db.prepare(`SELECT g.name FROM user_groups ug
    JOIN users u ON u.id = ug.user_id JOIN groups g ON g.id = ug.group_id
    WHERE u.username = 'brandon' ORDER BY g.name`).all().map(g => g.name);
  assertEq(newGroups, ['family', 'household'], 'group reconciliation updates user_groups');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 3: CREATE for new authentik-only user ----
{
  console.log('\nTest 3: CREATE path for new authentik-only user');
  const { db, tmpDir } = freshDb();
  const created = userModel.provisionOrClaim(db, 'alex', 'header_trust', 'alex-uid-42', ['family', 'media-club']);
  assertEq(created.username, 'alex', 'CREATE returns alex row');
  assertEq(created.display, 'alex', 'CREATE defaults display=username');

  const rows = db.prepare(`SELECT username FROM users ORDER BY username`).all().map(r => r.username);
  assertEq(rows, ['admin', 'alex', 'brandon', 'emily'], 'alex row added');

  const alexGroups = db.prepare(`SELECT g.name FROM user_groups ug
    JOIN users u ON u.id = ug.user_id JOIN groups g ON g.id = ug.group_id
    WHERE u.username = 'alex' ORDER BY g.name`).all().map(g => g.name);
  assertEq(alexGroups, ['family', 'media-club'], 'alex in family + media-club');

  // pass_hash is empty (LAN fallback disabled for header-trust-only users).
  const pass_hash = db.prepare(`SELECT pass_hash FROM users WHERE username = 'alex'`).get().pass_hash;
  assertEq(pass_hash, '', 'CREATE leaves pass_hash empty (no LAN login)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 4: case-insensitive username match ----
{
  console.log('\nTest 4: case-insensitive username match (Brandon vs brandon)');
  const { db, tmpDir } = freshDb();
  // The fresh seed inserts 'brandon' (lowercase). A subsequent lookup
  // with 'BRANDON' must resolve to that same row thanks to COLLATE NOCASE.
  const matched = userModel.provisionOrClaim(db, 'BRANDON', 'header_trust', 'BRANDON', ['household']);
  assertEq(matched.username, 'brandon', 'BRANDON (uppercase) hits the existing brandon row');

  const rows = db.prepare(`SELECT username FROM users ORDER BY username`).all().map(r => r.username);
  assertEq(rows.filter(u => u.toLowerCase() === 'brandon').length, 1, 'no duplicate brandon row from case-insensitive lookup');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 5: reconcileGroups replaces (not merges) ----
{
  console.log('\nTest 5: reconcileGroups replaces user_groups wholesale');
  const { db, tmpDir } = freshDb();
  const u = userModel.provisionOrClaim(db, 'alex', 'header_trust', 'alex', ['household', 'family']);
  let alexGroups = db.prepare(`SELECT g.name FROM user_groups ug
    JOIN users u ON u.id = ug.user_id JOIN groups g ON g.id = ug.group_id
    WHERE u.username = 'alex' ORDER BY g.name`).all().map(g => g.name);
  assertEq(alexGroups, ['family', 'household'], 'alex initially in family + household');

  // Reconcile with a different set (drop family, add media-club).
  userModel.provisionOrClaim(db, 'alex', 'header_trust', 'alex', ['household', 'media-club']);
  alexGroups = db.prepare(`SELECT g.name FROM user_groups ug
    JOIN users u ON u.id = ug.user_id JOIN groups g ON g.id = ug.group_id
    WHERE u.username = 'alex' ORDER BY g.name`).all().map(g => g.name);
  assertEq(alexGroups, ['household', 'media-club'], 'reconcile replaced family with media-club');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 6: is_admin follows admins group ----
{
  console.log('\nTest 6: is_admin denormalized flag tracks admins group');
  const { db, tmpDir } = freshDb();
  const u = userModel.provisionOrClaim(db, 'sam', 'header_trust', 'sam', ['admins', 'household']);
  const isAdminAfter = db.prepare(`SELECT is_admin FROM users WHERE username = 'sam'`).get().is_admin;
  assertEq(isAdminAfter, 1, 'sam is_admin=1 after joining admins group');

  userModel.provisionOrClaim(db, 'sam', 'header_trust', 'sam', ['household']); // drop admins
  const isAdminDropped = db.prepare(`SELECT is_admin FROM users WHERE username = 'sam'`).get().is_admin;
  assertEq(isAdminDropped, 0, 'sam is_admin=0 after leaving admins group');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 7: case-collision preflight ----
{
  console.log('\nTest 7: case-collision preflight refuses to boot');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-collision-'));
  const dbPath = path.join(tmpDir, 'life.db');
  // Bootstrap a v0.0.x-style DB with case collision.
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display TEXT NOT NULL
    );
    INSERT INTO users (username, display) VALUES ('Brandon', 'Brandon');
    INSERT INTO users (username, display) VALUES ('brandon', 'brandon');
  `);
  db.close();
  // Re-open and run migrate — should throw.
  const db2 = new Database(dbPath);
  let threw = false;
  let errMsg = '';
  try {
    userModel.migrate(db2);
  } catch (e) {
    threw = true;
    errMsg = e.message;
  }
  assert(threw, 'migrate() throws on case collisions');
  assert(errMsg.includes('case collisions'), 'error message names the failure mode', errMsg);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 8: validateAssignee accepts seeded users + 'all' ----
{
  console.log('\nTest 8: validateAssignee accepts username + "all", rejects unknown');
  const { db, tmpDir } = freshDb();
  assert(userModel.validateAssignee(db, 'all'), '"all" is valid');
  assert(userModel.validateAssignee(db, 'brandon'), 'brandon is valid');
  assert(userModel.validateAssignee(db, null), 'null is valid');
  assert(!userModel.validateAssignee(db, 'ghost'), 'unknown user is invalid');
  assert(!userModel.validateAssignee(db, ''), 'empty string is invalid');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 9: validateUsername normalization ----
{
  console.log('\nTest 9: validateUsername normalizes case + trims');
  assertEq(userModel.validateUsername('Brandon'), 'brandon', 'Brandon → brandon');
  assertEq(userModel.validateUsername('  brandon  '), 'brandon', 'whitespace trimmed');
  assertEq(userModel.validateUsername('a'), null, 'too short');
  assertEq(userModel.validateUsername('admin@home'), null, 'invalid char rejected');
  assertEq(userModel.validateUsername(''), null, 'empty rejected');
}

// ---- Test 10: grep gate (no hardcoded brandon/emily comparisons in code) ----
{
  console.log('\nTest 10: grep gate (acceptance: no hardcoded brandon/emily comparisons)');
  const serverSrc = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8');
  const libSrc = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'user-model.js'), 'utf8');
  for (const [name, src] of [['server.js', serverSrc], ['lib/user-model.js', libSrc]]) {
    // Strip comments.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // Tightened pattern: runtime comparison or CASE WHEN literal.
    const re = /(===?|!==?)\s*['"]?(brandon|emily)['"]?|['"]?(brandon|emily)['"]?\s*(===?|!==?)|CASE\s+[^]*?WHEN\s+['"](brandon|emily)['"]/gi;
    const hits = stripped.match(re);
    assert(!hits, `${name}: no brandon/emily comparison in non-comment code`, hits ? hits.join('; ') : '');
    // Legacy "both" enum must be gone from runtime code. Migration
    // UPDATE statements that *replace* 'both' with 'all' are still
    // legitimate (one-time cleanup of legacy v0.0.1 data) — exempt them
    // by checking that every remaining 'both' literal sits inside an
    // UPDATE ... SET ... 'all' WHERE ... = 'both' migration line. Also
    // strip comments first so a 'both' reference in a comment doesn't
    // false-positive.
    const strippedSrc = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map(l => l.replace(/\/\/.*$/, ''))
      .join('\n');
    const lines = strippedSrc.split(/\r?\n/);
    const bothLines = lines
      .map((l, i) => ({ l: l.trim(), i: i + 1 }))
      .filter(({ l }) => /['"]both['"]/.test(l));
    const runtimeBothLines = bothLines.filter(({ l }) => !/UPDATE\s+\w+\s+SET\s+\w+\s*=\s*'all'\s+WHERE\s+\w+\s*=\s*'both'/i.test(l));
    assert(runtimeBothLines.length === 0,
      `${name}: no runtime "both" enum string (only migration cleanup lines allowed)`,
      runtimeBothLines.length ? runtimeBothLines.map(({ l, i }) => `L${i}: ${l}`).join(' | ') : '');
  }
}

console.log(`\nResults: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);