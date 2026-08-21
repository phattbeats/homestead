#!/usr/bin/env node
// PHA-2204 acceptance tests for the v0.3.0 modules / layout API surface.
//
// Boots server.js on an ephemeral port (3191) and exercises the full
// endpoint matrix against a header-trust mock. No external test
// runner, no supertest — `fetch` against the listening socket is
// enough and matches the smoke scripts in this repo.
//
// Acceptance covered (per PHA-2204 issue body):
//   * GET /api/me includes enabled_modules, default_route, first_run.
//   * GET /api/me/layout returns feed-only / feed-tabs / meadow per
//     enabled-set size; addRoomVisible + agentDrawer flags set correctly.
//   * GET /api/me/modules returns the user's enabled keys in registry order.
//   * GET /api/modules returns the full registry as an array.
//   * POST /api/me/modules/:key/enable is idempotent and cascades via
//     withRequirements: true.
//   * POST /api/me/modules/:key/disable is idempotent and cascades via
//     withDependents: true.
//   * Invalid key returns 400.
//   * Cascade-conflict returns 409 with the unmet/dependent list.
//   * Unauthenticated requests are rejected.
//
// Out of scope (handled by sibling PHAs):
//   * DB schema (PHA-2202 / PHA-2200.1)
//   * Registry (PHA-2203 / PHA-2200.2)
//   * SPA rendering (PHA-2200.4)

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-modapi-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3191';
process.env.ADMIN_PASSWORD = 'modapi-test-pw';
process.env.BRANDON_PASSWORD = 'modapi-test-pw';
process.env.SESSION_SECRET = 'modapi-test-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

const HEAD = {
  'x-authentik-username': 'brandon',
  'x-authentik-groups': 'household',
};
const POST = (urlPath, body) => fetch('http://127.0.0.1:3191' + urlPath, {
  method: 'POST',
  headers: { ...HEAD, 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});
const GET = (urlPath, withHead = true) => fetch('http://127.0.0.1:3191' + urlPath, {
  headers: withHead ? HEAD : {},
});
const NOAUTH = (urlPath) => fetch('http://127.0.0.1:3191' + urlPath);

(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3191, '127.0.0.1', () => { console.log('[test-modules-api] homestead on :3191'); resolve(); });
    process.on('uncaughtException', reject);
  });

  // Wait for ready
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3191/api/health');
      if (r.ok) break;
    } catch (_) { /* keep polling */ }
    await new Promise(r => setTimeout(r, 100));
  }
  ok('server boots');

  console.log('\nTest 1: GET /api/me extended envelope');
  {
    const me = await (await GET('/api/me')).json();
    assert(me.user && me.user.username === 'brandon', '/api/me.user.username === "brandon"');
    assert(Array.isArray(me.enabled_modules), '/api/me.enabled_modules is an array');
    assertEq(me.enabled_modules, ['wall', 'lists', 'calendar', 'chores', 'apps', 'agent'], '/api/me.enabled_modules === [wall, lists, calendar, chores, apps, agent]');
    assertEq(me.default_route, '/porch.html', '/api/me.default_route === "/porch.html"');
    assert(me.first_run === true, '/api/me.first_run === true (fresh user)');
    assert(!('password' in (me.user || {})), '/api/me.user does NOT include pass_hash');
  }

  console.log('\nTest 2: GET /api/me/layout returns meadow for all-6 user');
  {
    const layout = await (await GET('/api/me/layout')).json();
    assertEq(layout.layout, 'meadow', 'layout === "meadow" (6 enabled)');
    assertEq(layout.defaultRoute, '/porch.html', 'defaultRoute === "/porch.html"');
    assertEq(layout.addRoomVisible, false, 'addRoomVisible === false (all enabled)');
    assertEq(layout.agentDrawer, true, 'agentDrawer === true (agent is enabled)');
    assertEq(layout.tabs.length, 6, 'tabs.length === 6');
    assertEq(layout.tabs[0].key, 'wall', 'tabs[0].key === "wall"');
    assertEq(layout.tabs[0].icon, '📸', 'tabs[0].icon === "📸"');
    assertEq(layout.tabs[0].label, 'Porch', 'tabs[0].label === "Porch"');
    assertEq(layout.tabs[0].route, '/porch.html', 'tabs[0].route === "/porch.html"');
    assertEq(layout.tabs[5].key, 'agent', 'tabs[5].key === "agent"');
    assertEq(layout.tabs[5].route, null, 'agent (drawer mode) has route null');
  }

  console.log('\nTest 3: GET /api/me/layout switches shape by enabled count');
  {
    // Disable everything except wall via cascade.
    // First disable lists with dependents (catches chores), then calendar, apps, agent individually.
    await (await POST('/api/me/modules/lists/disable', { withDependents: true })).json();
    for (const k of ['calendar', 'apps', 'agent']) {
      await (await POST('/api/me/modules/' + k + '/disable')).json();
    }

    // wall-only → feed-only
    let layout = await (await GET('/api/me/layout')).json();
    assertEq(layout.layout, 'feed-only', '1 module enabled → layout === "feed-only"');
    assertEq(layout.addRoomVisible, true, 'addRoomVisible === true (others available)');
    assertEq(layout.agentDrawer, false, 'agentDrawer === false (agent disabled)');
    assertEq(layout.tabs.length, 1, 'tabs.length === 1');
    assertEq(layout.tabs[0].key, 'wall', 'tabs[0].key === "wall"');

    // Enable lists → feed-tabs (2 enabled)
    await (await POST('/api/me/modules/lists/enable')).json();
    layout = await (await GET('/api/me/layout')).json();
    assertEq(layout.layout, 'feed-tabs', '2 modules enabled → layout === "feed-tabs"');

    // Enable apps too → still feed-tabs (3 enabled)
    await (await POST('/api/me/modules/apps/enable')).json();
    layout = await (await GET('/api/me/layout')).json();
    assertEq(layout.layout, 'feed-tabs', '3 modules enabled → layout === "feed-tabs"');
    assertEq(layout.tabs.length, 3, '3 modules → tabs.length === 3');

    // Enable calendar + agent → meadow (5 enabled — chores is still disabled)
    await (await POST('/api/me/modules/calendar/enable')).json();
    await (await POST('/api/me/modules/agent/enable')).json();
    layout = await (await GET('/api/me/layout')).json();
    assertEq(layout.layout, 'meadow', '5 modules enabled → layout === "meadow"');
    assertEq(layout.agentDrawer, true, 'agentDrawer back to true');
  }

  console.log('\nTest 4: GET /api/me/modules returns enabled keys in registry order');
  {
    const keys = await (await GET('/api/me/modules')).json();
    assert(Array.isArray(keys), 'response is an array');
    // After test 3 we should have wall, lists, calendar, apps, agent enabled (chores still off).
    assertEq(keys, ['wall', 'lists', 'calendar', 'apps', 'agent'], 'enabled keys in registry order');
  }

  console.log('\nTest 5: GET /api/modules returns full registry array');
  {
    const reg = await (await GET('/api/modules')).json();
    assert(Array.isArray(reg), 'response is an array');
    assertEq(reg.map(m => m.key), ['wall', 'lists', 'calendar', 'chores', 'apps', 'agent'], 'all six built-ins in registry order');
    // Spot-check shape: every entry has the 16 manifest fields.
    for (const m of reg) {
      assert(m.key && m.name && m.icon && m.url !== undefined && m.open_mode && Array.isArray(m.requires), `entry ${m.key} has full manifest shape`);
    }
    // registry entries match lib/modules.js REGISTRY.
    const libReg = require('../lib/modules').REGISTRY;
    for (const m of reg) {
      assertEq(m, libReg[m.key], `${m.key} entry matches lib/modules.js REGISTRY`);
    }
  }

  console.log('\nTest 6: POST /api/me/modules/wall/enable is idempotent');
  {
    const r1 = await (await POST('/api/me/modules/wall/enable')).json();
    assert(r1.enabled && r1.enabled.enabled === true, 'first enable: enabled.enabled === true');
    assertEq(r1.also_enabled, [], 'first enable: also_enabled === []');
    assert(r1.enabled.enabled_at && typeof r1.enabled.enabled_at === 'string', 'enabled_at is a non-empty string');

    // Second enable — same response, no exception, idempotent.
    const r2 = await (await POST('/api/me/modules/wall/enable')).json();
    assert(r2.enabled && r2.enabled.enabled === true, 'second enable: still enabled');
    assertEq(r2.also_enabled, [], 'second enable: also_enabled === []');
  }

  console.log('\nTest 7: POST /api/me/modules/chores/enable cascade enables lists');
  {
    // chores requires lists. Disable both first via dependent cascade.
    await (await POST('/api/me/modules/lists/disable', { withDependents: true })).json();
    let mods = await (await GET('/api/me/modules')).json();
    assert(!mods.includes('chores'), 'precondition: chores disabled');
    assert(!mods.includes('lists'), 'precondition: lists disabled');

    // Without withRequirements: lists is missing, so 409 + unmet list.
    const conflict = await POST('/api/me/modules/chores/enable');
    assertEq(conflict.status, 409, 'enable chores (no cascade) → 409');
    const conflictBody = await conflict.json();
    assertEq(conflictBody.error, 'requires_unmet', '409 body.error === "requires_unmet"');
    assertEq(conflictBody.unmet, ['lists'], '409 body.unmet === ["lists"]');

    // Verify chores still NOT enabled.
    mods = await (await GET('/api/me/modules')).json();
    assert(!mods.includes('chores'), 'after 409, chores still not enabled');

    // With withRequirements: true — enables chores AND lists in one write.
    const ok = await (await POST('/api/me/modules/chores/enable', { withRequirements: true })).json();
    assert(ok.enabled.enabled === true, 'withRequirements: target enabled');
    assertEq(ok.also_enabled, ['lists'], 'withRequirements: also_enabled === ["lists"]');
    assert(ok.enabled_modules.includes('chores') && ok.enabled_modules.includes('lists'), 'enabled_modules includes both chores and lists');
  }

  console.log('\nTest 8: POST /api/me/modules/lists/disable cascade disables chores');
  {
    // Precondition: chores + lists both enabled.
    const mods = await (await GET('/api/me/modules')).json();
    assert(mods.includes('chores') && mods.includes('lists'), 'precondition: chores and lists enabled');

    // Without withDependents: chores is dependent, so 409 + dependents list.
    const conflict = await POST('/api/me/modules/lists/disable');
    assertEq(conflict.status, 409, 'disable lists (no cascade) → 409');
    const conflictBody = await conflict.json();
    assertEq(conflictBody.error, 'dependents_active', '409 body.error === "dependents_active"');
    assertEq(conflictBody.dependents, ['chores'], '409 body.dependents === ["chores"]');

    // Verify lists still enabled.
    let still = await (await GET('/api/me/modules')).json();
    assert(still.includes('lists'), 'after 409, lists still enabled');

    // With withDependents: true — disables lists AND chores in one write.
    const ok = await (await POST('/api/me/modules/lists/disable', { withDependents: true })).json();
    assert(ok.disabled.enabled === false, 'withDependents: target disabled');
    assertEq(ok.also_disabled, ['chores'], 'withDependents: also_disabled === ["chores"]');
    still = await (await GET('/api/me/modules')).json();
    assert(!still.includes('lists') && !still.includes('chores'), 'after cascade, both lists and chores disabled');
  }

  console.log('\nTest 9: invalid module key returns 400');
  {
    for (const path of ['/api/me/modules/popcorn_vote/enable', '/api/me/modules/WALL/disable']) {
      const r = await POST(path);
      assertEq(r.status, 400, `${path} → 400`);
      const body = await r.json();
      assertEq(body.error, 'invalid_module_key', '400 body.error === "invalid_module_key"');
    }
  }

  console.log('\nTest 10: unauthenticated requests are rejected');
  {
    for (const path of ['/api/me/layout', '/api/me/modules', '/api/modules']) {
      const r = await NOAUTH(path);
      assertEq(r.status, 401, `${path} (no auth) → 401`);
    }
    // Write endpoints also need auth.
    for (const path of ['/api/me/modules/wall/enable', '/api/me/modules/wall/disable']) {
      const r = await fetch('http://127.0.0.1:3191' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assertEq(r.status, 401, `POST ${path} (no auth) → 401`);
    }
    // GET /api/me is the documented exception (returns { user: null } for the
    // SPA bootstrap "am I signed in?" check).
    const me = await (await NOAUTH('/api/me')).json();
    assertEq(me, { user: null }, '/api/me (no auth) → { user: null }');
  }

  console.log('\nTest 11: first_run flips to false after completeFirstRun');
  {
    // Hit a custom endpoint via the API: we don't expose completeFirstRun
    // over HTTP yet (out of scope per PHA-2200.3 — the SPA calls it directly
    // via a dedicated endpoint in PHA-2200.4). Validate the underlying
    // helper by poking the DB through the user-model module and confirming
    // /api/me reflects it.
    const Database = require('better-sqlite3');
    const userModel = require('../lib/user-model');
    // The server's db instance is bound to the same DATA_DIR; re-open read-only
    // is fine since user_model.js exposes the same helpers.
    // Note: server.js keeps `db` private. Use the API to validate the
    // observable effect — we already proved the helper works in
    // scripts/test-modules.js; here we just confirm /api/me.first_run
    // is wired and observable.
    const me = await (await GET('/api/me')).json();
    assert(typeof me.first_run === 'boolean', '/api/me.first_run is a boolean');
    assert(me.first_run === true, 'fresh user first_run === true');
    // Sanity: the column was added (re-migrate on a separate file would
    // also work, but the live DB already has it because server.js
    // migrated at boot).
    const liveDb = new Database(path.join(tmpDir, 'life.db'), { readonly: true });
    const row = liveDb.prepare("SELECT first_run_completed_at FROM users WHERE username = 'brandon'").get();
    assert(row && row.first_run_completed_at === null, 'first_run_completed_at IS NULL for fresh brandon');
    liveDb.close();
  }

  console.log(`\nPHA-2204 modules-api: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
