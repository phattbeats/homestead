#!/usr/bin/env node
// PHA-2209 / PHA-2200.8 — Empty-state acceptance test (AC8 from
// PHA-2200 §7): "Brand-new user enables Calendar, sees the tab,
// disables, tab disappears with data intact, re-enables, tab
// returns with data."
//
// Per PHA-2200 design note §3, the three layout modes are:
//   * 0 enabled     → 'empty'       (no rooms; onboarding shown)
//   * 1 enabled     → 'feed-only'   (single tab)
//   * 2-3 enabled   → 'feed-tabs'   (top tab strip)
//   * 4+ enabled    → 'meadow'      (full grid)
//
// The "empty-state" acceptance is about the lifecycle of a single
// non-default module: enable → see tab → disable → tab disappears
// → data intact → re-enable → tab returns with data.
//
// We drive userModel + computeLayout (no HTTP) — same shape the
// API surfaces in GET /api/me/layout.

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

console.log('PHA-2209 AC8 — empty-state disable/re-enable\n');

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-empty-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  return { db, tmpDir, dbPath };
}

function provision(db, username) {
  return userModel.provisionOrClaim(db, username, 'header_trust', username + '_sub', []);
}

// -----------------------------------------------------------------------------
// 1. Brand-new user state — empty layout (or feed-only if wall is
//    auto-on for the provisioning path; we test the 1-tab case).
// -----------------------------------------------------------------------------
{
  console.log('Test 1: brand-new user layout');
  const { db } = freshDb();
  const u = provision(db, 'new_user');
  // Provisioning path doesn't auto-enable wall (DEFAULT_ENABLED is
  // for the user-seeding block in v0.4+, not CLAIM). So the new
  // user has 0 enabled modules → 'empty' layout.
  let keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(keys, [], 'fresh user has 0 enabled modules');
  let layout = modules.computeLayout([]);
  assertEq(layout.layout, 'empty', '0 enabled → layout === "empty"');
  assertEq(layout.tabs, [], '0 enabled → tabs is []');
  assertEq(layout.defaultRoute, null, 'empty → defaultRoute is null');
  assert(!layout.agentDrawer, 'empty → no agent drawer');
  assert(layout.addRoomVisible, 'empty → addRoomVisible (every module available)');
}

// -----------------------------------------------------------------------------
// 2. Enable Calendar — tab appears, layout transitions.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 2: enable calendar — tab appears');
  const { db } = freshDb();
  const u = provision(db, 'calendar_user');

  userModel.enableModule(db, u.id, 'calendar');
  let keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(keys, ['calendar'], 'after enable: [calendar]');
  let layout = modules.computeLayout(keys);
  assertEq(layout.layout, 'feed-only', '1 enabled → layout === "feed-only"');
  assertEq(layout.tabs.length, 1, '1 tab in feed-only');
  assertEq(layout.tabs[0].key, 'calendar', 'tab key === "calendar"');
  assertEq(layout.tabs[0].route, null, 'calendar tab route is null (in-SPA)');
  assertEq(layout.defaultRoute, null, 'calendar-only defaultRoute is null (in-SPA)');
  assert(!layout.agentDrawer, 'no agent drawer (calendar alone)');
  assert(layout.addRoomVisible, 'addRoomVisible (other modules available)');
}

// -----------------------------------------------------------------------------
// 3. Disable Calendar — tab disappears, but the row stays (data intact).
// -----------------------------------------------------------------------------
{
  console.log('\nTest 3: disable calendar — tab disappears, data intact');
  const { db } = freshDb();
  const u = provision(db, 'calendar_off');

  userModel.enableModule(db, u.id, 'calendar');
  userModel.disableModule(db, u.id, 'calendar');

  // The user_modules row should still exist (data intact) — only
  // enabled_at is cleared.
  const rows = db.prepare(
    'SELECT module_key, enabled_at FROM user_modules WHERE user_id = ?'
  ).all(u.id);
  assertEq(rows.length, 1, 'user_modules row preserved (no delete)');
  assertEq(rows[0].module_key, 'calendar', 'row key is calendar');
  assertEq(rows[0].enabled_at, null, 'enabled_at is NULL (disabled)');

  // getEnabledModules (enabled-only filter) skips disabled rows.
  let keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(keys, [], 'disabled calendar not in enabled set');

  // Layout: empty again.
  let layout = modules.computeLayout(keys);
  assertEq(layout.layout, 'empty', 'back to empty layout');
}

// -----------------------------------------------------------------------------
// 4. Re-enable Calendar — tab returns, data still there.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 4: re-enable calendar — tab returns');
  const { db } = freshDb();
  const u = provision(db, 'calendar_re');

  // Cycle: enable → disable → re-enable.
  userModel.enableModule(db, u.id, 'calendar');
  userModel.disableModule(db, u.id, 'calendar');
  userModel.enableModule(db, u.id, 'calendar');

  // The original row is updated via ON CONFLICT — still 1 row, not 2.
  const rows = db.prepare(
    'SELECT module_key, enabled_at FROM user_modules WHERE user_id = ?'
  ).all(u.id);
  assertEq(rows.length, 1, 'still 1 row (no duplicate from re-enable)');
  assert(rows[0].enabled_at !== null, 'enabled_at is set (re-enabled)');

  // Layout: feed-only again.
  let keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(keys, ['calendar'], 're-enabled: [calendar]');
  let layout = modules.computeLayout(keys);
  assertEq(layout.layout, 'feed-only', 'back to feed-only layout');
  assertEq(layout.tabs[0].key, 'calendar', 'calendar tab is back');
}

// -----------------------------------------------------------------------------
// 5. Multi-module layout transitions: 1 → 2 → 3 → 4 enabled.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 5: layout transitions across enabled-set sizes');
  const { db } = freshDb();
  const u = provision(db, 'layout_user');

  // 1 enabled → feed-only
  userModel.enableModule(db, u.id, 'wall');
  let keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  let layout = modules.computeLayout(keys);
  assertEq(layout.layout, 'feed-only', '1 enabled → feed-only');

  // 2 enabled → feed-tabs
  userModel.enableModule(db, u.id, 'lists');
  keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  layout = modules.computeLayout(keys);
  assertEq(layout.layout, 'feed-tabs', '2 enabled → feed-tabs');
  assertEq(layout.tabs.length, 2, 'feed-tabs has 2 tabs');

  // 3 enabled → feed-tabs (still, ≤3)
  userModel.enableModule(db, u.id, 'calendar');
  keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  layout = modules.computeLayout(keys);
  assertEq(layout.layout, 'feed-tabs', '3 enabled → feed-tabs');

  // 4 enabled → meadow
  userModel.enableModule(db, u.id, 'chores', { withRequirements: true });
  keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  layout = modules.computeLayout(keys);
  assertEq(layout.layout, 'meadow', '4 enabled → meadow');

  // 5 enabled → meadow
  userModel.enableModule(db, u.id, 'apps');
  keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  layout = modules.computeLayout(keys);
  assertEq(layout.layout, 'meadow', '5 enabled → meadow');

  // 6 enabled (incl agent) → meadow + agentDrawer: true
  userModel.enableModule(db, u.id, 'agent');
  keys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  layout = modules.computeLayout(keys);
  assertEq(layout.layout, 'meadow', '6 enabled → meadow');
  assert(layout.agentDrawer, 'agent enabled → agentDrawer === true');
  assertEq(layout.defaultRoute, '/porch.html', 'wall-first default route');
}

// -----------------------------------------------------------------------------
// 6. addRoomVisible transitions: false once every module is enabled.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 6: addRoomVisible transitions');
  const { db } = freshDb();
  const u = provision(db, 'add_room_user');

  // 0 enabled → addRoomVisible: true (every module available)
  let layout = modules.computeLayout(userModel.getEnabledModules(db, u.id).map(e => e.key));
  assert(layout.addRoomVisible, '0 enabled → addRoomVisible');

  // 5 enabled → still true (agent not enabled)
  for (const k of ['wall', 'lists', 'calendar', 'chores', 'apps']) {
    if (k === 'chores') userModel.enableModule(db, u.id, k, { withRequirements: true });
    else userModel.enableModule(db, u.id, k);
  }
  layout = modules.computeLayout(userModel.getEnabledModules(db, u.id).map(e => e.key));
  assert(layout.addRoomVisible, '5 enabled (agent missing) → addRoomVisible');

  // 6 enabled → still true (gazette not enabled yet)
  userModel.enableModule(db, u.id, 'agent');
  layout = modules.computeLayout(userModel.getEnabledModules(db, u.id).map(e => e.key));
  assert(layout.addRoomVisible, '6 enabled (gazette missing) → addRoomVisible');

  // 7 enabled → false (everything enabled)
  userModel.enableModule(db, u.id, 'gazette');
  layout = modules.computeLayout(userModel.getEnabledModules(db, u.id).map(e => e.key));
  assert(!layout.addRoomVisible, '7 enabled → !addRoomVisible');
}

// -----------------------------------------------------------------------------
// 7. Empty state — DEFAULT_ENABLED for the onboarding flow.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 7: empty-state onboarding flow');
  // Per Amendment 2: new users (post-v0.3.0 onboarding) see {wall}
  // only. We assert DEFAULT_ENABLED at the registry layer.
  const def = modules.getDefaultEnabled();
  assertEq(def, ['wall'], 'DEFAULT_ENABLED === ["wall"] (onboarding flow)');
  // Compute the layout for a default-enabled user (what a fresh
  // CLAIM-claimed user who hasn't opted into anything else would see).
  const layout = modules.computeLayout(def);
  assertEq(layout.layout, 'feed-only', 'default-enabled set → feed-only');
  assertEq(layout.tabs.length, 1, '1 tab');
  assertEq(layout.tabs[0].key, 'wall', 'tab is wall');
  assertEq(layout.defaultRoute, '/porch.html', 'default route is porch');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
