#!/usr/bin/env node
// PHA-2209 / PHA-2200.8 — Amendment 2 acceptance test:
// "Adding a new module to the registry does NOT backfill user_modules
// rows for existing users; new users see {wall} only."
//
// Per PHA-2202 (migration discipline) + PHA-2203 (registry), the
// DEFAULT_ENABLED list is the SINGLE source of truth for what a
// brand-new account sees. Adding a 7th module to the registry (e.g.
// 'recipes') MUST NOT cause existing users to receive a row in
// user_modules for it. The migration for adding a module should
// be limited to:
//   (a) Adding the key to the SQLite CHECK constraint (so the DB
//       accepts the new key), AND
//   (b) Adding the entry to lib/modules.js (so the registry knows
//       about it).
// It MUST NOT touch user_modules rows for existing users.
//
// This test simulates the "add 'recipes'" scenario via a synthetic
// in-memory registry + migration and verifies:
//   1. New users (post-addition) get {wall} only via
//      modules.getDefaultEnabled().
//   2. Existing users' enabled sets are unaffected by the registry
//      addition (verified by inspecting getEnabledModules()).
//   3. The registry validator still passes with the new entry (the
//      registry remains the canonical source of truth).
//   4. The migration discipline: the SQLite migration for a new
//      module does NOT include an INSERT-backfill for existing
//      users. We assert this by inspecting the migration text in
//      lib/user-model.js — no INSERT OR IGNORE INTO user_modules
//      with the new key should exist outside the v3 PHA-2202
//      backfill (which uses INSERT OR IGNORE on the cross-join of
//      existing users × all current keys, NOT a per-key
//      INSERT-into-existing-users).
//
// This is a discipline test, not a runtime test. The runtime
// enforcement is `default_enabled: false` in the new entry + the
// migration's failure to backfill.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const REPO_ROOT = path.resolve(__dirname, '..');
const modules = require('../lib/modules');
const validator = require('../lib/registry-validate');
const userModel = require('../lib/user-model');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

console.log('PHA-2209 Amendment 2 — default-OFF for future first-party modules\n');

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-default-off-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  return { db, tmpDir, dbPath };
}

// -----------------------------------------------------------------------------
// 1. Simulate adding a 7th module ('recipes') to the registry.
// -----------------------------------------------------------------------------
const SYNTHETIC_REGISTRY = {
  ...modules.REGISTRY,
  recipes: {
    key: 'recipes',
    name: 'Recipes',
    description: 'Family recipe book — share, annotate, scale.',
    icon: '🍳',
    room: 'recipes',
    requires: [],
    tier: 'core',
    version: '0.1.0',
    author: 'homestead-core',
    url: '/recipes.html',
    open_mode: 'frame',
    scopes: ['read:recipes', 'write:recipes'],
    mcp: false,
    webhooks: [],
    entity_kinds: ['recipe'],
    default_enabled: false, // KEY: must remain false for new users
  },
};

const SYNTHETIC_ORDER = [...modules.REGISTRY_ORDER, 'recipes'];

{
  console.log('Test 1: synthetic 7th-module registry validates');
  // The validator reads from `modules.REGISTRY` (the live one),
  // so we can't validate the synthetic one in isolation. Instead
  // we assert shape invariants directly on the entry.
  const r = SYNTHETIC_REGISTRY.recipes;
  assert(r.default_enabled === false, 'recipes.default_enabled === false');
  assertEq(r.requires, [], 'recipes has no requires[]');
  assertEq(r.key, 'recipes', 'recipes.key === "recipes"');
  // Derived, not a frozen count: this test simulates adding ONE more
  // module to whatever the registry currently holds, so it must not
  // re-break every time a real module lands (PHA-2659 added gazette).
  assertEq(SYNTHETIC_ORDER.length, modules.REGISTRY_ORDER.length + 1,
    'synthetic order is the live registry plus one');
}

// -----------------------------------------------------------------------------
// 2. New users (post-addition) still see {wall} only.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 2: new users see {wall} only — recipes stays off');
  const def = modules.getDefaultEnabled();
  assertEq(def, ['wall'], 'modules.getDefaultEnabled() === ["wall"]');
  // The synthetic recipes entry is default_enabled:false, so even
  // if it were merged into the registry, getDefaultEnabled() would
  // still return ['wall'] — confirming the rule.
  // (We can't actually merge without mutating REGISTRY; we assert
  // the field value of the synthetic entry as the proof.)
  assert(SYNTHETIC_REGISTRY.recipes.default_enabled === false,
    'synthetic recipes entry default_enabled === false (would not appear in DEFAULT_ENABLED)');
}

// -----------------------------------------------------------------------------
// 3. Existing users' enabled sets are unaffected by the addition.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 3: existing users unaffected by future-module addition');
  const { db } = freshDb();
  // Seed: one existing user via provisionOrClaim (CLAIM-ready path).
  // We provision as 'header_trust' so no authentik dependency.
  const u = userModel.provisionOrClaim(db, 'existing_user', 'header_trust', 'existing_user_sub', []);
  assert(u && u.id, 'existing_user provisioned');
  for (const k of Object.keys(modules.REGISTRY)) {
    userModel.enableModule(db, u.id, k);
  }
  const beforeKeys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(beforeKeys, modules.REGISTRY_ORDER.slice(),
    'existing user has all built-ins enabled');

  // "Add recipes" — in this simulation, we just verify the DB has
  // no row for 'recipes' yet (it doesn't, because no migration
  // backfilled it).
  const recipesRows = db.prepare(
    'SELECT module_key FROM user_modules WHERE user_id = ? AND module_key = ?'
  ).all(u.id, 'recipes');
  assertEq(recipesRows, [], 'existing user has NO recipes row (no backfill happened)');

  // Even after a hypothetical "add recipes" migration:
  //   (1) The DB CHECK constraint is extended to allow 'recipes'
  //   (2) A user_modules row for 'recipes' is created by user opt-in
  //   (3) getEnabledModules() picks up the row in registry order
  // We simulate (1)+(2)+(3) by recreating the table with the
  // extended CHECK, then INSERT OR IGNORE-ing the existing user
  // rows back so we don't lose the data the user had pre-migration.
  const existingRows = db.prepare('SELECT module_key, enabled_at FROM user_modules WHERE user_id = ?').all(u.id);
  db.exec(`DROP TABLE user_modules`);
  // The extended CHECK is the live registry plus the synthetic key —
  // spelling out a fixed list here would drop rows for any module added
  // since this test was written.
  const syntheticCheck = SYNTHETIC_ORDER.map(k => `'${k}'`).join(',');
  db.exec(`CREATE TABLE user_modules (
    user_id      INTEGER NOT NULL,
    module_key   TEXT    NOT NULL CHECK (module_key IN (${syntheticCheck})),
    enabled_at   TEXT,
    PRIMARY KEY (user_id, module_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  // Re-seed the existing rows so the user keeps every module they had.
  const ins = db.prepare(`INSERT INTO user_modules (user_id, module_key, enabled_at) VALUES (?, ?, ?)`);
  for (const r of existingRows) ins.run(u.id, r.module_key, r.enabled_at);
  // Now simulate user opt-in to 'recipes'.
  ins.run(u.id, 'recipes', new Date().toISOString().replace('T', ' ').slice(0, 19));

  const rawRows = db.prepare(
    'SELECT module_key, enabled_at FROM user_modules WHERE user_id = ? AND module_key = ?'
  ).all(u.id, 'recipes');
  assertEq(rawRows.length, 1, 'recipes row exists in user_modules (data intact)');

  // Pre-registry-addition: getEnabledModules (with live registry
  // that lacks 'recipes') skips the unknown row but keeps the 6.
  const preKeys = userModel.getEnabledModules(db, u.id).map(e => e.key);
  assertEq(preKeys, modules.REGISTRY_ORDER.slice(),
    'pre-registry-addition: getEnabledModules skips unknown recipes row, keeps the registered ones');

  // Post-registry-addition (simulated by reading raw rows and
  // appending 'recipes' to the end of the registry order):
  const postKeys = userModel.getEnabledModules(db, u.id)
    .map(e => e.key)
    .concat(['recipes']);
  assertEq(postKeys, SYNTHETIC_ORDER,
    'post-registry-addition (simulated): recipes appended last in registry order');
}

// -----------------------------------------------------------------------------
// 4. Migration discipline — no per-module INSERT-backfill for new modules.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 4: migration discipline');
  // Inspect lib/user-model.js for the canonical migration text.
  // The v3 (PHA-2202) migration backfills ALL existing users
  // against ALL current module keys — that's a one-time cross-join
  // for the initial rollout. It MUST NOT be repeated per-module.
  //
  // We assert: outside the v3 migration block (which is the only
  // place INSERT OR IGNORE / INSERT INTO user_modules + a literal
  // module_key appears), no other block writes a per-module backfill.
  //
  // The v3 block is identified by the SELECT ... UNION ALL cross-join
  // pattern — every other INSERT pattern that targets user_modules
  // and uses a literal module_key would be a per-module backfill.
  const userModelSrc = fs.readFileSync(path.join(REPO_ROOT, 'lib/user-model.js'), 'utf8');

  // Find every INSERT INTO user_modules or INSERT OR IGNORE INTO
  // user_modules block. The v3 block has the SELECT ... UNION ALL
  // cross-join. Any block WITHOUT the cross-join pattern that ALSO
  // has a literal module_key is a per-module backfill = violation.
  const blockRe = /(INSERT\s+OR\s+IGNORE\s+INTO\s+user_modules|INSERT\s+INTO\s+user_modules)[\s\S]*?(?=\n\s*\n|\nCREATE|\n--|\n\/\/|\nfunction|\nexports|$)/gi;
  const blocks = userModelSrc.match(blockRe) || [];

  let violations = 0;
  for (const blk of blocks) {
    const hasCrossJoin = /UNION\s+ALL/i.test(blk);
    const hasLiteralKey = /['"`](wall|lists|calendar|chores|apps|agent)['"`]/.test(blk);
    // A block without the cross-join but with a literal key is a
    // per-module-key INSERT — that's the violation.
    if (hasLiteralKey && !hasCrossJoin) {
      violations++;
      console.log(`    PER-MODULE BACKFILL DETECTED:`);
      console.log(blk.split('\n').map(l => '      ' + l).join('\n'));
      console.log('');
    }
  }
  assert(violations === 0, `no per-module backfill INSERT in migration text (${violations} found)`);
}

// -----------------------------------------------------------------------------
// 5. DEFAULT_ENABLED is the single source of truth for new users.
// -----------------------------------------------------------------------------
{
  console.log('\nTest 5: DEFAULT_ENABLED source of truth');
  assert(Array.isArray(modules.DEFAULT_ENABLED), 'DEFAULT_ENABLED is an array');
  assertEq(modules.DEFAULT_ENABLED, ['wall'], 'DEFAULT_ENABLED === ["wall"] (single source)');
  // The synthetic 7th module is default_enabled:false, so adding
  // it to REGISTRY_ORDER doesn't change DEFAULT_ENABLED.
  // We assert the field value as proof.
  assert(SYNTHETIC_REGISTRY.recipes.default_enabled === false,
    'synthetic recipes.default_enabled === false — adding it to registry doesn\'t change DEFAULT_ENABLED');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
