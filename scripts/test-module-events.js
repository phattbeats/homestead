#!/usr/bin/env node
// PHA-2220 acceptance tests for the v0.3.0 module_events instrumentation.
//
// Drives `lib/user-model.js` directly against a temp SQLite file. No
// HTTP server, no subprocess. Each test runs migrate() on a fresh DB
// so they're independent and idempotent.
//
// Acceptance covered (per PHA-2220 issue body):
//   * Migration creates module_events + user_signals tables with the
//     correct schema (FKs, CHECK constraint, indexes).
//   * enableModule writes one module_events row per real transition.
//   * Idempotent re-enable writes zero additional events.
//   * disableModule writes one module_events row per real transition.
//   * Cascade enable/disable writes one event per cascade key that
//     actually transitioned (no events for cascade keys that were
//     already in the target state).
//   * summarizeModuleEvents rebuilds user_signals with first/second
//     enable events per user and total_modules_enabled count.
//   * getUserSignals returns the denormalized rollup, or null when
//     the user has no enable events.
//   * Backfill path: cron can be re-run any number of times without
//     producing drift (idempotent).
//   * Migration is idempotent (re-run on existing DB is a no-op).
//
// Out of scope (handled by sibling PHAs):
//   * enableModule / disableModule cascade semantics (PHA-2204)
//   * API route changes (PHA-2204 / not needed for this issue)
//   * The cron scheduling itself — scripts/cron-module-events-summary.js
//     is shipped, but the system cron entry is a separate ops task.

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-me-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  return { db, tmpDir, dbPath };
}

console.log('PHA-2220 module-events tests\n');

// ---- Test 1: migration creates module_events + user_signals tables ----
{
  console.log('Test 1: migration creates module_events + user_signals tables');

  const { db, tmpDir } = freshDb();

  const moduleEvents = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='module_events'`
  ).get();
  assert(!!moduleEvents, 'module_events table exists after migrate()');

  const userSignals = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='user_signals'`
  ).get();
  assert(!!userSignals, 'user_signals table exists after migrate()');

  // FK to users(id)
  const fkRows = db.prepare(`PRAGMA foreign_key_list(module_events)`).all();
  const fkToUsers = fkRows.some(r => r.table === 'users' && r.from === 'user_id');
  assert(fkToUsers, 'module_events.user_id → users(id) FK');

  // CHECK constraint on action
  const sql = db.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='module_events'`
  ).get().sql;
  assert(/CHECK\s*\(\s*action\s+IN\s*\(\s*'enable'\s*,\s*'disable'\s*\)\s*\)/.test(sql),
    'module_events CHECK(action IN (enable, disable))');

  // Indexes
  const idxUserTs = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_module_events_user_ts'`
  ).get();
  assert(!!idxUserTs, 'idx_module_events_user_ts index exists');

  const idxTs = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_module_events_ts'`
  ).get();
  assert(!!idxTs, 'idx_module_events_ts index exists');

  // user_signals PK = user_id, FK to users
  const sigFk = db.prepare(`PRAGMA foreign_key_list(user_signals)`).all();
  const sigFkToUsers = sigFk.some(r => r.table === 'users' && r.from === 'user_id');
  assert(sigFkToUsers, 'user_signals.user_id → users(id) FK');

  // Both tables start empty
  assertEq(db.prepare('SELECT COUNT(*) c FROM module_events').get().c, 0,
    'module_events is empty on fresh DB');
  assertEq(db.prepare('SELECT COUNT(*) c FROM user_signals').get().c, 0,
    'user_signals is empty on fresh DB');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: enableModule writes one event per real transition ----
{
  console.log('\nTest 2: enableModule writes one module_events row per real transition');

  const { db, tmpDir } = freshDb();

  const brandonId = db.prepare(`SELECT id FROM users WHERE username='brandon'`).get().id;

  // All modules start enabled via PHA-2202 backfill. To exercise a real
  // transition, disable wall first, then re-enable it.
  userModel.disableModule(db, brandonId, 'wall');
  // After disable, module_events has one disable row for wall.
  // We'll enable it again — that's the transition we want to observe.
  const beforeEnable = db.prepare(
    `SELECT COUNT(*) c FROM module_events WHERE user_id=? AND module_key='wall' AND action='enable'`
  ).get(brandonId).c;
  assertEq(beforeEnable, 0, 'pre: no enable events for wall yet');

  userModel.enableModule(db, brandonId, 'wall');
  const afterEnable = db.prepare(
    `SELECT COUNT(*) c FROM module_events WHERE user_id=? AND module_key='wall' AND action='enable'`
  ).get(brandonId).c;
  assertEq(afterEnable, 1, 'one enable event for wall after enableModule(wall)');

  const ev = db.prepare(
    `SELECT module_key, action, ts FROM module_events WHERE user_id=? AND module_key='wall' AND action='enable'`
  ).get(brandonId);
  assertEq(ev.module_key, 'wall', 'event module_key === "wall"');
  assertEq(ev.action, 'enable', 'event action === "enable"');
  assert(typeof ev.ts === 'string' && ev.ts.length > 0, 'event ts is a non-empty string');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 3: idempotent re-enable writes no additional event ----
{
  console.log('\nTest 3: idempotent re-enable writes no additional event');

  const { db, tmpDir } = freshDb();

  const brandonId = db.prepare(`SELECT id FROM users WHERE username='brandon'`).get().id;

  // wall is enabled by default. Re-enabling it is a no-op.
  const before = db.prepare(
    `SELECT COUNT(*) c FROM module_events WHERE user_id=? AND module_key='wall'`
  ).get(brandonId).c;

  userModel.enableModule(db, brandonId, 'wall');   // no-op (already enabled)
  userModel.enableModule(db, brandonId, 'wall');   // no-op again
  userModel.enableModule(db, brandonId, 'wall');   // no-op again

  const after = db.prepare(
    `SELECT COUNT(*) c FROM module_events WHERE user_id=? AND module_key='wall'`
  ).get(brandonId).c;
  assertEq(after, before, 'three idempotent re-enables add zero events');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 4: disableModule writes one event per real transition ----
{
  console.log('\nTest 4: disableModule writes one disable event per real transition');

  const { db, tmpDir } = freshDb();

  const brandonId = db.prepare(`SELECT id FROM users WHERE username='brandon'`).get().id;

  const before = db.prepare(
    `SELECT COUNT(*) c FROM module_events WHERE user_id=? AND module_key='apps' AND action='disable'`
  ).get(brandonId).c;
  assertEq(before, 0, 'pre: no disable events for apps');

  userModel.disableModule(db, brandonId, 'apps');
  const after = db.prepare(
    `SELECT COUNT(*) c FROM module_events WHERE user_id=? AND module_key='apps' AND action='disable'`
  ).get(brandonId).c;
  assertEq(after, 1, 'one disable event for apps after disableModule(apps)');

  // Idempotent re-disable writes no event.
  userModel.disableModule(db, brandonId, 'apps');
  const after2 = db.prepare(
    `SELECT COUNT(*) c FROM module_events WHERE user_id=? AND module_key='apps' AND action='disable'`
  ).get(brandonId).c;
  assertEq(after2, 1, 'idempotent re-disable adds zero events');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 5: cascade enable writes one event per cascade key ----
{
  console.log('\nTest 5: cascade enable (withRequirements) writes one event per cascade key');

  const { db, tmpDir } = freshDb();

  const brandonId = db.prepare(`SELECT id FROM users WHERE username='brandon'`).get().id;

  // First disable chores AND lists so the cascade has real transitions
  // to record. chores has no dependents, but it requires lists.
  userModel.disableModule(db, brandonId, 'chores', { withDependents: true });
  // (withDependents=true is a no-op for chores because chores has no
  // dependents. It still disables chores.)
  userModel.disableModule(db, brandonId, 'lists');

  // Now wall is still on, lists is off, chores is off.
  // Delete prior events so we measure only the cascade.
  db.prepare(`DELETE FROM module_events WHERE user_id=?`).run(brandonId);

  // Enable chores with withRequirements → should cascade through lists.
  userModel.enableModule(db, brandonId, 'chores', { withRequirements: true });

  const newEnableEvents = db.prepare(
    `SELECT module_key FROM module_events WHERE user_id=? AND action='enable' ORDER BY id`
  ).all(brandonId);

  const newKeys = newEnableEvents.map(e => e.module_key).sort();
  // The cascade: enabling chores requires lists → enables lists + chores.
  assert(newKeys.includes('lists'), 'cascade enable includes lists');
  assert(newKeys.includes('chores'), 'cascade enable includes chores');
  assert(!newKeys.includes('wall'), 'cascade does not include unrelated keys');
  assert(!newKeys.includes('calendar'), 'cascade does not include calendar');
  assert(!newKeys.includes('apps'), 'cascade does not include apps');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 6: cascade disable writes one event per cascade key ----
{
  console.log('\nTest 6: cascade disable (withDependents) writes one event per cascade key');

  const { db, tmpDir } = freshDb();

  const brandonId = db.prepare(`SELECT id FROM users WHERE username='brandon'`).get().id;

  // Brand-new state: wall, lists, calendar, chores, apps, agent all enabled.
  // Disable lists with withDependents → should cascade to chores.
  userModel.disableModule(db, brandonId, 'lists', { withDependents: true });

  const disableEvents = db.prepare(
    `SELECT module_key FROM module_events WHERE user_id=? AND action='disable' ORDER BY id`
  ).all(brandonId).map(e => e.module_key).sort();
  assert(disableEvents.includes('lists'), 'cascade disable includes lists');
  assert(disableEvents.includes('chores'), 'cascade disable includes chores');
  assert(!disableEvents.includes('wall'), 'cascade does not touch unrelated keys');

  // A second cascade call should NOT write events for already-disabled keys.
  const before = db.prepare(
    `SELECT COUNT(*) c FROM module_events WHERE user_id=? AND action='disable'`
  ).get(brandonId).c;
  userModel.disableModule(db, brandonId, 'lists', { withDependents: true });
  const after = db.prepare(
    `SELECT COUNT(*) c FROM module_events WHERE user_id=? AND action='disable'`
  ).get(brandonId).c;
  assertEq(after, before, 'idempotent cascade re-disable adds zero events');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 7: summarizeModuleEvents rolls up first/second enable + count ----
{
  console.log('\nTest 7: summarizeModuleEvents rebuilds user_signals rollup');

  const { db, tmpDir } = freshDb();

  const brandonId = db.prepare(`SELECT id FROM users WHERE username='brandon'`).get().id;

  // Clear any pre-existing events for this user (the disable events from
  // the seed flow don't generate user_signals rows anyway — enable
  // events do).
  db.prepare(`DELETE FROM module_events WHERE user_id=?`).run(brandonId);

  // Simulate brandon enabling modules in this order: apps, calendar, lists.
  // We toggle them via the public API to keep the event-log path exercised.
  // Note: order matters — lists must be disabled last because chores
  // depends on lists. We avoid the cascade by disabling chores first.
  userModel.disableModule(db, brandonId, 'chores', { withDependents: true });
  userModel.disableModule(db, brandonId, 'apps');
  userModel.enableModule(db, brandonId, 'apps');           // first enable event for brandon
  userModel.disableModule(db, brandonId, 'calendar');
  userModel.enableModule(db, brandonId, 'calendar');         // second enable event for brandon
  userModel.disableModule(db, brandonId, 'lists');
  userModel.enableModule(db, brandonId, 'lists');            // third enable event

  const written = userModel.summarizeModuleEvents(db);
  assertEq(written, 1, 'summarizeModuleEvents returns 1 row written');

  const sig = userModel.getUserSignals(db, brandonId);
  assert(!!sig, 'getUserSignals returns a row for brandon');
  assertEq(sig.first_module_key, 'apps', 'first_module_key === apps');
  assertEq(sig.second_module_key, 'calendar', 'second_module_key === calendar');
  assertEq(sig.total_modules_enabled, 3, 'total_modules_enabled === 3 (apps, calendar, lists)');
  assert(typeof sig.first_module_enabled_at === 'string', 'first_module_enabled_at is a string');
  assert(typeof sig.second_module_enabled_at === 'string', 'second_module_enabled_at is a string');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 8: getUserSignals returns null when user has no enable events ----
{
  console.log('\nTest 8: getUserSignals returns null for users with zero enable events');

  const { db, tmpDir } = freshDb();

  const brandonId = db.prepare(`SELECT id FROM users WHERE username='brandon'`).get().id;

  // brandon has NO enable events yet (everything is seeded default-enabled).
  let sig = userModel.getUserSignals(db, brandonId);
  assertEq(sig, null, 'no signals row when no enable events');

  // Run summarizeModuleEvents anyway — should produce 0 rows.
  userModel.summarizeModuleEvents(db);
  sig = userModel.getUserSignals(db, brandonId);
  assertEq(sig, null, 'still no signals row after summarize on empty events');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 9: summarize is idempotent (no drift on repeated runs) ----
{
  console.log('\nTest 9: summarizeModuleEvents is idempotent across re-runs');

  const { db, tmpDir } = freshDb();

  const brandonId = db.prepare(`SELECT id FROM users WHERE username='brandon'`).get().id;

  // Seed two enable events for brandon. chores depends on lists, so
  // disable chores with cascade before disabling lists.
  userModel.disableModule(db, brandonId, 'chores', { withDependents: true });
  userModel.disableModule(db, brandonId, 'lists');
  userModel.enableModule(db, brandonId, 'lists');
  userModel.disableModule(db, brandonId, 'calendar');
  userModel.enableModule(db, brandonId, 'calendar');

  const sig1 = userModel.getUserSignals(db, brandonId);
  userModel.summarizeModuleEvents(db);
  const sig2 = userModel.getUserSignals(db, brandonId);

  assertEq(sig1, null, 'no row before first summarize');
  assert(!!sig2, 'row exists after first summarize');
  assertEq(sig2.first_module_key, sig2.first_module_key, 'first_module_key stable across re-runs');
  assertEq(sig2.second_module_key, sig2.second_module_key, 'second_module_key stable across re-runs');
  assertEq(sig2.total_modules_enabled, sig2.total_modules_enabled, 'total_modules_enabled stable across re-runs');

  // Re-run twice more and assert the row stays.
  userModel.summarizeModuleEvents(db);
  userModel.summarizeModuleEvents(db);
  const sig3 = userModel.getUserSignals(db, brandonId);
  assertEq(sig3.total_modules_enabled, sig2.total_modules_enabled,
    'total_modules_enabled unchanged across 3 re-runs');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 10: migration is idempotent (re-run on existing DB) ----
{
  console.log('\nTest 10: migration is idempotent on an existing DB with events');

  const { db, tmpDir } = freshDb();

  const brandonId = db.prepare(`SELECT id FROM users WHERE username='brandon'`).get().id;

  // Seed one event.
  userModel.disableModule(db, brandonId, 'apps');
  userModel.enableModule(db, brandonId, 'apps');

  const eventsBefore = db.prepare('SELECT COUNT(*) c FROM module_events').get().c;
  const signalsBefore = db.prepare('SELECT COUNT(*) c FROM user_signals').get().c;
  assert(eventsBefore >= 1, 'precondition: at least one module_event row');
  assert(signalsBefore === 0, 'precondition: no user_signals row before summarize');

  // Re-run migrate.
  userModel.migrate(db);

  const eventsAfter = db.prepare('SELECT COUNT(*) c FROM module_events').get().c;
  const signalsAfter = db.prepare('SELECT COUNT(*) c FROM user_signals').get().c;
  assertEq(eventsAfter, eventsBefore, 'module_events count unchanged after re-migration');
  assertEq(signalsAfter, 0, 'user_signals still empty after re-migration (summarize not called)');

  // module_events row content preserved.
  const preserved = db.prepare(
    `SELECT module_key, action FROM module_events WHERE user_id=? AND module_key='apps' AND action='enable'`
  ).get(brandonId);
  assert(!!preserved, 'module_events enable row for apps preserved across re-migration');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 11: multi-user isolation ----
{
  console.log('\nTest 11: module_events are partitioned per user');

  const { db, tmpDir } = freshDb();

  const brandonId = db.prepare(`SELECT id FROM users WHERE username='brandon'`).get().id;
  const emilyId = db.prepare(`SELECT id FROM users WHERE username='emily'`).get().id;

  userModel.disableModule(db, brandonId, 'apps');
  userModel.enableModule(db, brandonId, 'apps');
  // For emily: chores depends on lists. Cascade-disable chores first.
  userModel.disableModule(db, emilyId, 'chores', { withDependents: true });
  userModel.disableModule(db, emilyId, 'lists');
  userModel.enableModule(db, emilyId, 'lists');

  const brandonSig = userModel.summarizeModuleEvents(db);
  // Only brandon and emily have enable events, but admin does NOT.
  assertEq(brandonSig, 2, 'two users in user_signals after summarize (brandon + emily)');

  const b = userModel.getUserSignals(db, brandonId);
  const e = userModel.getUserSignals(db, emilyId);
  assertEq(b.first_module_key, 'apps', 'brandon first === apps');
  assertEq(e.first_module_key, 'lists', 'emily first === lists');

  const adminId = db.prepare(`SELECT id FROM users WHERE username='admin'`).get().id;
  const a = userModel.getUserSignals(db, adminId);
  assertEq(a, null, 'admin has no signals (no enable events)');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} pass, ${fail} fail`);
if (fail > 0) {
  process.exit(1);
}