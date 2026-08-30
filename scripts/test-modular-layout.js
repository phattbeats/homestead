#!/usr/bin/env node
// PHA-2209 / PHA-2200.8 — Modular layout acceptance test.
//
// Exercises the three layout shapes (feed-only, feed-tabs, meadow)
// plus the empty state via HTTP against a live server.js. Uses the
// header-trust mock (x-authentik-username + x-authentik-groups)
// — the same auth the SPA ships in dev/prod. Validates:
//
//   * GET /api/me/layout returns the expected {layout, tabs, pages,
//     defaultRoute, addRoomVisible, agentDrawer} shape per enabled
//     count.
//   * The welcome-sheet flow: first_run === true on a fresh user,
//     POST /api/me/first-run-complete stamps it, subsequent reads
//     return first_run === false (PHA-2200.6).
//   * The agent-drawer flag: when the agent module is enabled,
//     /api/me.layout.agentDrawer === true; when disabled, false
//     (PHA-2200.7 — even though PHA-2221 wires the actual drawer
//     UI, the flag MUST be present and correct).
//   * The `+ Add rooms` pill affordance: addRoomVisible === true
//     when at least one module is un-enabled, false when all 6 are
//     enabled. The user can still disable-then-re-enable to verify
//     addRoomVisible flips back to true (data preserved).
//   * Tab set correctness: tabs[] always mirrors enabled keys in
//     REGISTRY_ORDER; pages[] is the same data so the SPA can
//     switch between tabs and meadow views without a re-fetch.
//
// We boot a fresh server on port 3192 (test-modules-api uses 3191
// — different port avoids collision if both run in sequence).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-modlayout-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3192';
process.env.ADMIN_PASSWORD = 'modlayout-test-pw';
process.env.BRANDON_PASSWORD = 'modlayout-test-pw';
process.env.SESSION_SECRET = 'modlayout-test-secret';
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
const POST = (urlPath, body) => fetch('http://127.0.0.1:3192' + urlPath, {
  method: 'POST',
  headers: { ...HEAD, 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});
const GET = (urlPath) => fetch('http://127.0.0.1:3192' + urlPath, { headers: HEAD });

(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3192, '127.0.0.1', () => { console.log('[test-modular-layout] homestead on :3192'); resolve(); });
    process.on('uncaughtException', reject);
  });

  // Wait for ready.
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3192/api/health');
      if (r.ok) break;
    } catch (_) { /* keep polling */ }
    await new Promise(r => setTimeout(r, 100));
  }
  ok('server boots');

  // Reset state for brandon: enable every built-in so we can
  // selectively disable to shape each layout. The seed creates
  // brandon without any module rows — provisionOrClaim is called
  // on first auth but doesn't auto-enable. We'll enable one by one.
  async function enable(k, body = {}) {
    const r = await POST(`/api/me/modules/${k}/enable`, body);
    if (!r.ok) {
      console.log(`  ! enable ${k} returned ${r.status}: ${await r.text()}`);
    }
    return r.json();
  }
  async function disable(k, body = {}) {
    const r = await POST(`/api/me/modules/${k}/disable`, body);
    if (!r.ok) {
      console.log(`  ! disable ${k} returned ${r.status}: ${await r.text()}`);
    }
    return r.json();
  }

  // Enable all 6 so we have a clean "everything on" meadow baseline.
  await enable('wall');
  await enable('lists');
  await enable('calendar');
  await enable('chores', { withRequirements: true }); // cascades lists too — already enabled, no-op
  await enable('apps');
  await enable('agent');

  // -----------------------------------------------------------------------------
  // 1. Layout transitions across enabled-set sizes.
  // -----------------------------------------------------------------------------
  console.log('\nTest 1: layout transitions');

  // Start from all-6 → meadow.
  let layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.layout, 'meadow', 'all 6 enabled → meadow');
  assertEq(layout.addRoomVisible, false, 'all enabled → !addRoomVisible');
  assertEq(layout.agentDrawer, true, 'agent enabled → agentDrawer');
  assertEq(layout.defaultRoute, '/porch.html', 'defaultRoute is porch');
  assertEq(layout.tabs.length, 6, '6 tabs');
  assertEq(layout.pages.length, 6, '6 pages (same as tabs)');

  // Disable agent → 5 enabled, still meadow, agentDrawer off.
  await disable('agent');
  layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.layout, 'meadow', '5 enabled → meadow');
  assertEq(layout.agentDrawer, false, 'agent disabled → !agentDrawer');
  assertEq(layout.addRoomVisible, true, '5 enabled → addRoomVisible (agent available)');

  // Disable apps → 4 enabled, meadow (threshold is 4+).
  await disable('apps');
  layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.layout, 'meadow', '4 enabled → meadow');

  // Disable chores (cascades from lists — but lists is still enabled, so no cascade) → 3 enabled.
  await disable('chores');
  layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.layout, 'feed-tabs', '3 enabled → feed-tabs');
  assertEq(layout.tabs.length, 3, '3 tabs');

  // Disable calendar → 2 enabled.
  await disable('calendar');
  layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.layout, 'feed-tabs', '2 enabled → feed-tabs');
  assertEq(layout.tabs.length, 2, '2 tabs');

  // Disable lists → 1 enabled (wall).
  await disable('lists');
  layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.layout, 'feed-only', '1 enabled (wall) → feed-only');
  assertEq(layout.tabs.length, 1, '1 tab');
  assertEq(layout.tabs[0].key, 'wall', 'tab key is wall');
  assertEq(layout.tabs[0].route, '/porch.html', 'wall tab route');
  assertEq(layout.defaultRoute, '/porch.html', 'defaultRoute is porch');

  // Disable wall → 0 enabled.
  await disable('wall');
  layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.layout, 'empty', '0 enabled → empty');
  assertEq(layout.tabs.length, 0, '0 tabs');
  assertEq(layout.defaultRoute, null, 'empty → defaultRoute is null');
  assertEq(layout.addRoomVisible, true, 'empty → addRoomVisible (everything available)');

  // -----------------------------------------------------------------------------
  // 2. Tab set / page set always mirror enabled keys in REGISTRY_ORDER.
  // -----------------------------------------------------------------------------
  console.log('\nTest 2: tabs and pages mirror enabled keys');
  // Re-enable 3 modules in NON-registry order and verify the layout
  // returns them in registry order. Enable 'lists' first (registry
  // position 1), then 'chores' (registry position 3, requires lists
  // — already enabled), then 'wall' (registry position 0).
  await enable('lists');
  await enable('chores'); // no withRequirements — lists already on, so no unmet
  await enable('wall');
  layout = (await (await GET('/api/me/layout')).json());
  // Registry order: wall, lists, calendar, chores, apps, agent.
  // Enabled: wall, lists, chores. In registry order: [wall, lists, chores].
  const tabKeys = layout.tabs.map(t => t.key);
  assertEq(tabKeys, ['wall', 'lists', 'chores'],
    'tabs are in REGISTRY_ORDER regardless of enable order');
  assertEq(layout.tabs.map(t => t.key), layout.pages.map(p => p.key),
    'pages mirror tabs');

  // -----------------------------------------------------------------------------
  // 3. FAB behavior — tabs[].route is null for drawer-mode modules.
  // -----------------------------------------------------------------------------
  console.log('\nTest 3: FAB / drawer-mode handling');
  // agent has open_mode: 'drawer' per registry → tabs[].route === null.
  // Enable agent and inspect the agent tab tile.
  await enable('agent');
  layout = (await (await GET('/api/me/layout')).json());
  const agentTile = layout.tabs.find(t => t.key === 'agent');
  assert(agentTile, 'agent tile present');
  assertEq(agentTile.route, null, 'agent (drawer mode) has route null — opens FAB, not route');
  // PHA-2846: built-in icons are SVG paths under /modules/ (see
  // public/modules.html + public/index.html for the dispatch rule).
  assertEq(agentTile.icon, '/modules/agent.svg', 'agent tile icon');
  assertEq(agentTile.label, 'Agent', 'agent tile label');
  assertEq(layout.agentDrawer, true, 'agentDrawer flag is true');
  // Disable agent → tile disappears, agentDrawer false.
  await disable('agent');
  layout = (await (await GET('/api/me/layout')).json());
  assert(!layout.tabs.find(t => t.key === 'agent'), 'agent tile removed when disabled');
  assertEq(layout.agentDrawer, false, 'agentDrawer flag flips to false');

  // -----------------------------------------------------------------------------
  // 4. Welcome-sheet flow (first_run lifecycle, PHA-2200.6).
  // -----------------------------------------------------------------------------
  console.log('\nTest 4: welcome-sheet flow');
  // /api/me.first_run is true for the fresh brandon user.
  let me = (await (await GET('/api/me')).json());
  assertEq(me.first_run, true, 'fresh user first_run === true');

  // POST /api/me/first-run-complete stamps it.
  const fr = await POST('/api/me/first-run-complete');
  assert(fr.ok, 'POST /api/me/first-run-complete succeeds');

  // Subsequent /api/me.first_run is false.
  me = (await (await GET('/api/me')).json());
  assertEq(me.first_run, false, 'after completeFirstRun: first_run === false');

  // Idempotency: re-calling first-run-complete is a no-op success.
  const fr2 = await POST('/api/me/first-run-complete');
  assert(fr2.ok, 'second call to /api/me/first-run-complete also succeeds (idempotent)');

  // -----------------------------------------------------------------------------
  // 5. Add-rooms pill — addRoomVisible flips correctly.
  // -----------------------------------------------------------------------------
  console.log('\nTest 5: add-rooms pill affordance');
  // Reset: enable everything.
  await enable('wall');
  await enable('lists');
  await enable('calendar');
  await enable('chores');
  await enable('apps');
  await enable('agent');
  layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.addRoomVisible, false, 'all 6 enabled → !addRoomVisible');

  // Disable agent → addRoomVisible true (1 module available).
  await disable('agent');
  layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.addRoomVisible, true, '5 enabled → addRoomVisible (agent available)');

  // Disable another → still addRoomVisible.
  await disable('apps');
  layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.addRoomVisible, true, '4 enabled → addRoomVisible (2 modules available)');

  // Re-enable apps → still addRoomVisible (agent missing).
  await enable('apps');
  layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.addRoomVisible, true, '5 enabled (apps back) → addRoomVisible (agent available)');

  // Re-enable agent → false again.
  await enable('agent');
  layout = (await (await GET('/api/me/layout')).json());
  assertEq(layout.addRoomVisible, false, 'all 6 re-enabled → !addRoomVisible');

  // -----------------------------------------------------------------------------
  // 6. GET /api/me extended envelope — sanity check the parent endpoint.
  // -----------------------------------------------------------------------------
  console.log('\nTest 6: /api/me extended envelope');
  me = (await (await GET('/api/me')).json());
  assertEq(me.enabled_modules, ['wall', 'lists', 'calendar', 'chores', 'apps', 'agent'],
    '/api/me.enabled_modules === all 6 (registry order)');
  assertEq(me.default_route, '/porch.html', '/api/me.default_route === "/porch.html"');
  assert(!me.user || !('password' in me.user), '/api/me.user does NOT include pass_hash');
  assert(!('pass_hash' in me), '/api/me does NOT include top-level pass_hash');

  // -----------------------------------------------------------------------------
  // 7. GET /api/me/modules — separate endpoint for the keys list.
  // -----------------------------------------------------------------------------
  console.log('\nTest 7: GET /api/me/modules');
  const keys = (await (await GET('/api/me/modules')).json());
  assertEq(keys, ['wall', 'lists', 'calendar', 'chores', 'apps', 'agent'],
    '/api/me/modules returns all 6 keys in registry order');

  // -----------------------------------------------------------------------------
  // 8. GET /api/modules — full registry for the add-a-room sheet.
  // -----------------------------------------------------------------------------
  console.log('\nTest 8: GET /api/modules');
  const reg = (await (await GET('/api/modules')).json());
  assert(Array.isArray(reg), '/api/modules is an array');
  assertEq(reg.length, 6, '/api/modules has 6 entries');
  assertEq(reg[0].key, 'wall', '/api/modules[0] is wall');
  assertEq(reg[5].key, 'agent', '/api/modules[5] is agent');
  // Every entry has the 16 manifest fields.
  for (const entry of reg) {
    assert(entry.key && entry.name && entry.icon && entry.room !== undefined,
      `registry entry "${entry.key}" has key+name+icon+room`);
    assert(typeof entry.default_enabled === 'boolean',
      `registry entry "${entry.key}" has boolean default_enabled`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('test-modular-layout crashed:', e);
  process.exit(1);
});
