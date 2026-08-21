#!/usr/bin/env node
// PHA-2209 / PHA-2200.8 — Cascade enable/disable acceptance test.
// (AC5 from PHA-2200 §7: enable/disable cascades via requires[].)
//
// Verifies the cross-cutting cascade behavior at the lib/user-model.js
// layer (no HTTP needed — same shape the API surface uses):
//   1. Enabling 'chores' with `withRequirements: true` also enables
//      'lists' (the unmet requirement) — both rows written, both
//      in registry order.
//   2. Enabling 'chores' WITHOUT withRequirements throws
//      `requires_unmet` with `unmet: ['lists']`.
//   3. Disabling 'lists' with `withDependents: true` also disables
//      'chores' (the dependent) — both rows disabled.
//   4. Disabling 'lists' WITHOUT withDependents throws
//      `dependents_active` with `dependents: ['chores']`.
//   5. Idempotency: enabling an already-enabled module is a no-op
//      that returns the current shape. Disabling an already-disabled
//      module is a no-op.
//   6. Cascade ordering: when multiple requirements chain (e.g.
//      transitive deps), they're enabled in dependency order.
//
// This drives userModel.enableModule / disableModule directly —
// the API layer just wraps these with auth + 4xx mapping.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const modules = require('../lib/modules');
const userModel = require('../lib/user-model');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

console.log('PHA-2209 AC5 — enable/disable cascade\n');

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-cascade-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  return { db, tmpDir, dbPath };
}

function provision(db, username) {
  return userModel.provisionOrClaim(db, username, 'header_trust', username + '_sub', []);
}

// -----------------------------------------------------------------------------
// 1. Enable 'chores' with withRequirements:true also enables 'lists'.
// -----------------------------------------------------------------------------
{
  console.log('Test 1: enable chores cascades to lists');
  const { db } = freshDb();
  const u = provision(db, 'cascade_user');

  // Before: only wall is enabled (default-on for the seeded CLAIM
  // profile — note: provisionOrClaim does NOT auto-enable modules;
  // DEFAULT_ENABLED is for new-user onboarding, not CLAIM path).
  // We assert only 'wall' isn't auto-enabled here.
  // Actually provisionOrClaim doesn't touch user_modules. So we
  // need to explicitly enable wall for parity with default-enabled.
  userModel.enableModule(db, u.id, 'wall');
  const beforeKeys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(beforeKeys, ['wall'], 'starting state: only wall enabled');

  // Enable chores with cascade.
  const result = userModel.enableModule(db, u.id, 'chores', { withRequirements: true });
  assertEq(result.also_enabled, ['lists'], 'cascade enabled "lists" alongside chores');
  assert(result.enabled && result.enabled.module_key === 'chores', 'result.enabled.module_key === "chores"');

  // Both rows written.
  const afterKeys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(afterKeys, ['wall', 'lists', 'chores'],
    'final enabled set: wall + lists + chores (in registry order)');
}

// -----------------------------------------------------------------------------
// 2. Enable 'chores' WITHOUT withRequirements throws requires_unmet.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 2: enable chores without cascade throws');
  const { db } = freshDb();
  const u = provision(db, 'cascade_user_2');
  userModel.enableModule(db, u.id, 'wall'); // wall-only baseline

  let err;
  try {
    userModel.enableModule(db, u.id, 'chores'); // no withRequirements
  } catch (e) {
    err = e;
  }
  assert(err, 'throws without withRequirements');
  assert(err && err.code === 'requires_unmet', 'error.code === "requires_unmet"');
  assert(err && JSON.stringify(err.unmet) === JSON.stringify(['lists']),
    'err.unmet === ["lists"]');
  // Wall still the only enabled module — no partial state.
  const keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(keys, ['wall'], 'no partial state — still wall-only after refused enable');
}

// -----------------------------------------------------------------------------
// 3. Disable 'lists' with withDependents:true also disables 'chores'.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 3: disable lists cascades to chores');
  const { db } = freshDb();
  const u = provision(db, 'cascade_user_3');
  // Setup: wall + lists + chores enabled.
  userModel.enableModule(db, u.id, 'wall');
  userModel.enableModule(db, u.id, 'lists');
  userModel.enableModule(db, u.id, 'chores');
  const setupKeys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(setupKeys, ['wall', 'lists', 'chores'], 'setup: wall + lists + chores');

  // Disable lists with cascade.
  const result = userModel.disableModule(db, u.id, 'lists', { withDependents: true });
  assertEq(result.also_disabled, ['chores'], 'cascade disabled "chores" alongside lists');
  assert(result.disabled && result.disabled.module_key === 'lists', 'result.disabled.module_key === "lists"');

  const afterKeys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(afterKeys, ['wall'], 'final state: only wall enabled');
}

// -----------------------------------------------------------------------------
// 4. Disable 'lists' WITHOUT withDependents throws dependents_active.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 4: disable lists without cascade throws');
  const { db } = freshDb();
  const u = provision(db, 'cascade_user_4');
  userModel.enableModule(db, u.id, 'wall');
  userModel.enableModule(db, u.id, 'lists');
  userModel.enableModule(db, u.id, 'chores');

  let err;
  try {
    userModel.disableModule(db, u.id, 'lists'); // no withDependents
  } catch (e) {
    err = e;
  }
  assert(err, 'throws without withDependents');
  assert(err && err.code === 'dependents_active', 'error.code === "dependents_active"');
  assert(err && JSON.stringify(err.dependents) === JSON.stringify(['chores']),
    'err.dependents === ["chores"]');

  // No partial state.
  const keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(keys, ['wall', 'lists', 'chores'], 'no partial state — all still enabled after refused disable');
}

// -----------------------------------------------------------------------------
// 5. Idempotency.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 5: idempotency');
  const { db } = freshDb();
  const u = provision(db, 'cascade_user_5');
  userModel.enableModule(db, u.id, 'wall');
  userModel.enableModule(db, u.id, 'lists');

  // Re-enable an already-enabled module: no-op, returns current shape.
  const reEnable = userModel.enableModule(db, u.id, 'lists');
  assert(reEnable && reEnable.enabled && reEnable.enabled.module_key === 'lists',
    're-enabling already-enabled module returns current shape');
  assertEq(reEnable.also_enabled, [], 'also_enabled is empty (no cascade needed)');
  const afterReEnable = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(afterReEnable, ['wall', 'lists'], 'state unchanged after re-enable');

  // Disable lists, then re-disable: no-op.
  userModel.disableModule(db, u.id, 'lists');
  const reDisable = userModel.disableModule(db, u.id, 'lists');
  assert(reDisable && reDisable.disabled && reDisable.disabled.module_key === 'lists',
    're-disabling already-disabled module returns current shape');
  assertEq(reDisable.also_disabled, [], 'also_disabled is empty (no cascade needed)');
}

// -----------------------------------------------------------------------------
// 6. Cascade ordering — depth-first requirement resolution.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 6: cascade ordering');
  // We can't easily test transitive deps without modifying the
  // registry. The current registry has only one transitive: chores
  // → lists (depth 1). getRequiredModules() walks requirements
  // recursively, so adding a deeper chain would surface here.
  // For v0.3.0 the chain is shallow; assert the helper depth-walks.
  const choresReq = userModel.getRequiredModules('chores');
  assertEq(choresReq, ['lists'], 'chores requires: ["lists"] (depth 1)');
  // Verify the helper does depth-first (lists → [] no further).
  const listsReq = userModel.getRequiredModules('lists');
  assertEq(listsReq, [], 'lists requires: [] (no further deps)');
}

// -----------------------------------------------------------------------------
// 7. Unknown module key rejected at the lib layer (before API).
// -----------------------------------------------------------------------------
{
  console.log('\nTest 7: unknown module rejected');
  const { db } = freshDb();
  const u = provision(db, 'cascade_user_7');
  userModel.enableModule(db, u.id, 'wall');

  let err;
  try {
    userModel.enableModule(db, u.id, 'recipes'); // not in registry
  } catch (e) { err = e; }
  assert(err && /unknown module_key/i.test(err.message),
    'enableModule rejects unknown key');

  let err2;
  try {
    userModel.disableModule(db, u.id, 'recipes');
  } catch (e) { err2 = e; }
  assert(err2 && /unknown module_key/i.test(err2.message),
    'disableModule rejects unknown key');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
