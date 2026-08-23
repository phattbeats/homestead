#!/usr/bin/env node
// PHA-2202 acceptance tests for the v0.3.0 user_modules table.
//
// Drives `lib/user-model.js` directly against a temp SQLite file. No
// HTTP server, no subprocess. Each test runs migrate() on a fresh DB
// so they're independent and idempotent.
//
// Acceptance covered (per PHA-2202 issue body):
//   * Migration runs without error on a DB with existing users (brandon, emily).
//   * After migration, count(user_modules) == count(users) * 6.
//   * Toggling a module to enabled_at = NULL and back preserves the
//     data table rows for that user's module (e.g., tasks for chores,
//     events for calendar).
//   * Re-running the migration is a no-op (no duplicate rows, no errors).
//   * Test suite passes including the new user-modules cases.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const modules = require('../lib/modules');

// Fresh-database migration tests need an explicit secure bootstrap password.
process.env.ADMIN_PASSWORD = 'user-modules-test-admin-password';

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-um-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  return { db, tmpDir, dbPath };
}

const MODULES = ['wall', 'lists', 'calendar', 'chores', 'apps', 'agent'];

console.log('PHA-2202 user-modules tests\n');

// ---- Test 1: migration creates user_modules + backfills canonical users ----
{
  console.log('Test 1: migration creates user_modules table + backfills admin/brandon/emily');
  const { db, tmpDir } = freshDb();

  const hasTable = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_modules'`).get();
  assert(!!hasTable, 'user_modules table exists after migrate()');

  const hasIndex = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_user_modules_user'`).get();
  assert(!!hasIndex, 'idx_user_modules_user index exists');

  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const moduleCount = db.prepare('SELECT COUNT(*) c FROM user_modules').get().c;
  assertEq(moduleCount, userCount * MODULES.length, 'user_modules count = users * 6');

  // All enabled_at NOT NULL after backfill (everything enabled by default).
  const enabledCount = db.prepare('SELECT COUNT(*) c FROM user_modules WHERE enabled_at IS NOT NULL').get().c;
  assertEq(enabledCount, moduleCount, 'all backfilled rows are enabled (enabled_at NOT NULL)');

  // brandon has all six modules.
  const brandonMods = db.prepare(`SELECT um.module_key FROM user_modules um
    JOIN users u ON u.id = um.user_id
    WHERE u.username = 'brandon' ORDER BY um.module_key`).all().map(r => r.module_key);
  assertEq(brandonMods.slice().sort(), MODULES.slice().sort(), 'brandon has all 6 modules');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: re-running migration is a no-op ----
{
  console.log('\nTest 2: re-running migration is a no-op (idempotent backfill)');
  const { db, tmpDir } = freshDb();

  // Tweak one row to mark "user-touched" — the re-migration must NOT
  // overwrite it.
  const brandonId = db.prepare(`SELECT id FROM users WHERE username = 'brandon'`).get().id;
  db.prepare(`UPDATE user_modules SET enabled_at = NULL WHERE user_id = ? AND module_key = 'chores'`).run(brandonId);

  const beforeCount = db.prepare('SELECT COUNT(*) c FROM user_modules').get().c;
  const beforeDisabled = db.prepare(`SELECT COUNT(*) c FROM user_modules WHERE user_id = ? AND module_key = 'chores' AND enabled_at IS NULL`).get(brandonId).c;
  assertEq(beforeDisabled, 1, 'pre-migration: brandon chores is disabled');

  // Re-run migrate on the same DB.
  userModel.migrate(db);

  const afterCount = db.prepare('SELECT COUNT(*) c FROM user_modules').get().c;
  assertEq(afterCount, beforeCount, 'no duplicate rows after re-migration');

  // User-toggled state preserved.
  const stillDisabled = db.prepare(`SELECT COUNT(*) c FROM user_modules WHERE user_id = ? AND module_key = 'chores' AND enabled_at IS NULL`).get(brandonId).c;
  assertEq(stillDisabled, 1, 're-migration did not re-enable user-toggled-disabled module');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 3: disable + re-enable preserves data table rows ----
{
  console.log('\nTest 3: disable + re-enable preserves data table rows (chores tasks, calendar events)');
  const { db, tmpDir } = freshDb();

  const brandonId = db.prepare(`SELECT id FROM users WHERE username = 'brandon'`).get().id;

  // Seed a task owned by brandon (chores data) and an event owned by brandon (calendar data).
  db.prepare(`INSERT INTO tasks (title, assignee, created_by) VALUES (?, ?, ?)`).run('Take out trash', 'brandon', 'brandon');
  db.prepare(`INSERT INTO events (title, date, owner, created_by) VALUES (?, ?, ?, ?)`).run('Dentist', '2026-09-01', 'brandon', 'brandon');

  // Pre-toggle: chores + calendar enabled.
  let mods = userModel.getUserModules(db, brandonId);
  assertEq(mods.chores.enabled, true, 'pre: chores enabled');
  assertEq(mods.calendar.enabled, true, 'pre: calendar enabled');

  // Toggle off chores.
  let toggled = userModel.setUserModule(db, brandonId, 'chores', false);
  assertEq(toggled.enabled, false, 'setUserModule chores=false returns enabled=false');
  const choresRow = db.prepare(`SELECT enabled_at FROM user_modules WHERE user_id = ? AND module_key = 'chores'`).get(brandonId);
  assertEq(choresRow.enabled_at, null, 'chores row.enabled_at = NULL after disable');

  // Data table rows still there.
  const taskCount = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE assignee = 'brandon'`).get().c;
  const eventCount = db.prepare(`SELECT COUNT(*) c FROM events WHERE owner = 'brandon'`).get().c;
  assertEq(taskCount, 1, 'tasks table preserved through chores disable');
  assertEq(eventCount, 1, 'events table preserved through calendar untouched');

  // Toggle chores back on.
  toggled = userModel.setUserModule(db, brandonId, 'chores', true);
  assertEq(toggled.enabled, true, 'setUserModule chores=true returns enabled=true');
  const choresReEnabled = db.prepare(`SELECT enabled_at FROM user_modules WHERE user_id = ? AND module_key = 'chores'`).get(brandonId);
  assert(!!choresReEnabled.enabled_at, 'chores row.enabled_at re-stamped after re-enable');

  // Tasks table still has the row.
  const taskCountAfter = db.prepare(`SELECT COUNT(*) c FROM tasks WHERE assignee = 'brandon'`).get().c;
  assertEq(taskCountAfter, 1, 'tasks table preserved through chores disable→re-enable cycle');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 4: toggle unknown module_key throws ----
{
  console.log('\nTest 4: setUserModule rejects unknown module_key');
  const { db, tmpDir } = freshDb();
  const brandonId = db.prepare(`SELECT id FROM users WHERE username = 'brandon'`).get().id;
  let threw = false;
  try { userModel.setUserModule(db, brandonId, 'not-a-module', true); }
  catch (e) { threw = true; }
  assert(threw, 'setUserModule("not-a-module", true) throws');
  assert(!userModel.isUserModuleKey('not-a-module'), 'isUserModuleKey("not-a-module") = false');
  assert(userModel.isUserModuleKey('chores'), 'isUserModuleKey("chores") = true');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 5: CHECK constraint blocks out-of-whitelist key at DB layer ----
{
  console.log('\nTest 5: SQLite CHECK constraint blocks out-of-whitelist module_key at DB layer');
  const { db, tmpDir } = freshDb();
  const brandonId = db.prepare(`SELECT id FROM users WHERE username = 'brandon'`).get().id;
  let threw = false;
  try {
    db.prepare(`INSERT INTO user_modules (user_id, module_key, enabled_at) VALUES (?, ?, datetime('now'))`).run(brandonId, 'rogue');
  } catch (e) {
    threw = true;
  }
  assert(threw, 'direct INSERT with rogue module_key violates CHECK constraint');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 6: new user inserted post-migration gets DEFAULT_ENABLED only ----
{
  console.log('\nTest 6: new user added post-migration gets DEFAULT_ENABLED-only backfill (not all 6)');
  const { db, tmpDir } = freshDb();

  // Add a 4th user directly (no module rows yet).
  db.prepare(`INSERT INTO users (username, display, pass_hash) VALUES (?, ?, '')`).run('alex', 'Alex');
  const beforeCount = db.prepare('SELECT COUNT(*) c FROM user_modules').get().c;
  // 3 users * 6 = 18 rows after Test 1's seed (grandfathered); alex has 0.
  assertEq(beforeCount, 3 * MODULES.length, 'pre: alex has no module rows');

  userModel.migrate(db); // re-run — table already exists, so the one-time
                         // grandfather pass must NOT re-fire for alex.

  const alexId = db.prepare(`SELECT id FROM users WHERE username = 'alex'`).get().id;
  const alexModKeys = db.prepare(`SELECT module_key FROM user_modules WHERE user_id = ? ORDER BY module_key`).all(alexId).map(r => r.module_key);
  assertEq(alexModKeys, modules.DEFAULT_ENABLED.slice().sort(), 'alex only gets the registry DEFAULT_ENABLED set, not all 6');

  const afterTotal = db.prepare('SELECT COUNT(*) c FROM user_modules').get().c;
  assertEq(afterTotal, 3 * MODULES.length + modules.DEFAULT_ENABLED.length, 'total = grandfathered 3 users * 6 + alex DEFAULT_ENABLED');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 7: getUserModules returns predictable shape for all 6 keys ----
{
  console.log('\nTest 7: getUserModules returns full { module_key, enabled_at, enabled } map');
  const { db, tmpDir } = freshDb();
  const brandonId = db.prepare(`SELECT id FROM users WHERE username = 'brandon'`).get().id;
  const mods = userModel.getUserModules(db, brandonId);
  assertEq(Object.keys(mods).sort(), MODULES.slice().sort(), 'all 6 module keys present');
  for (const k of MODULES) {
    assertEq(mods[k].module_key, k, `${k}: module_key echoed`);
    assertEq(mods[k].enabled, true, `${k}: enabled by default`);
    assert(!!mods[k].enabled_at, `${k}: enabled_at set`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 8: deleting a user cascades to user_modules ----
{
  console.log('\nTest 8: ON DELETE CASCADE purges user_modules when user is deleted');
  const { db, tmpDir } = freshDb();
  const brandonId = db.prepare(`SELECT id FROM users WHERE username = 'brandon'`).get().id;
  const beforeCount = db.prepare('SELECT COUNT(*) c FROM user_modules').get().c;

  // Enable foreign keys (better-sqlite3 default is OFF in some driver builds).
  db.pragma('foreign_keys = ON');
  db.prepare(`DELETE FROM users WHERE id = ?`).run(brandonId);

  const afterCount = db.prepare('SELECT COUNT(*) c FROM user_modules').get().c;
  assertEq(afterCount, beforeCount - MODULES.length, 'user_modules count drops by 6');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
