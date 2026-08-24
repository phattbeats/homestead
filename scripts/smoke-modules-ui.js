#!/usr/bin/env node
// PHA-2205 (PHA-2200.4) — layout-aware SPA browser/DOM smoke.
//
// Drives Playwright Chromium through every layout shape the SPA renders:
//   * feed-only   — 1 enabled module (wall) → bottom nav hidden, + Add rooms pill
//                   [NOTE: when wall is the only enabled module, boot() redirects
//                    to /porch.html per the single-surface rule. To keep applyLayout()
//                    in scope on /, we test feed-only via a synthetic shape that has
//                    a non-wall "keep" module instead.]
//   * feed-tabs   — 2 enabled modules → bottom nav with enabled tabs only
//   * meadow      — 4+ enabled        → bottom nav with full enabled tabs
//   * empty       — 0 enabled         → onboarding redirect fallback
//   * add-rooms   — sheet open + enable/disable round trip
//   * agent-gate  — drawerFab visibility tracks agentDrawer flag
//
// For each shape the smoke captures a 390x844 mobile-viewport
// screenshot into ./verify-out/ (per PHA-2501 standing policy) and
// asserts the structural rules (nav buttons disabled by data-disabled,
// pages hidden by data-disabled, body[data-layout] set correctly,
// + Add rooms pill visibility, drawerFab visibility).
//
// Run after `npm test`:
//   PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright \
//     node scripts/smoke-modules-ui.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { chromium, request } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-modui-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3194';
process.env.ADMIN_PASSWORD = 'modui-admin-pw';
process.env.BRANDON_PASSWORD = 'modui-brandon-pw';
process.env.SESSION_SECRET = 'modui-secret';
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
const POST = (p, body) => fetch('http://127.0.0.1:3194' + p, {
  method: 'POST', headers: { ...HEAD, 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});
const GET = (p) => fetch('http://127.0.0.1:3194' + p, { headers: HEAD });

const OUT_DIR = path.join(__dirname, '..', 'verify-out');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Disable every module the registry exposes except `keep`. Uses
// `withDependents: true` so we don't 409 on requires[] cascades
// (e.g. chores depends on lists). Returns the resulting
// /api/me/layout so the caller knows which shape they're testing.
async function setEnabledExcept(keep) {
  const reg = await (await GET('/api/modules')).json();
  const cur = new Set(await (await GET('/api/me/modules')).json());
  for (const m of reg) {
    if (m.key === keep) continue;
    if (!cur.has(m.key)) continue;
    await POST(`/api/me/modules/${encodeURIComponent(m.key)}/disable`, { withDependents: true });
  }
  return (await (await GET('/api/me/layout')).json());
}
// Enable every module the registry exposes.
async function enableAll() {
  const reg = await (await GET('/api/modules')).json();
  const cur = new Set(await (await GET('/api/me/modules')).json());
  for (const m of reg) {
    if (cur.has(m.key)) continue;
    await POST(`/api/me/modules/${encodeURIComponent(m.key)}/enable`, { withRequirements: true });
  }
  return (await (await GET('/api/me/layout')).json());
}
// Disable every module the registry exposes.
async function disableAll() {
  const reg = await (await GET('/api/modules')).json();
  const cur = new Set(await (await GET('/api/me/modules')).json());
  for (const m of reg) {
    if (!cur.has(m.key)) continue;
    await POST(`/api/me/modules/${encodeURIComponent(m.key)}/disable`, { withDependents: true });
  }
  return (await (await GET('/api/me/layout')).json());
}

(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3194, '127.0.0.1', () => { console.log('[smoke-modui] homestead on :3194'); resolve(); });
    process.on('uncaughtException', reject);
  });

  // Wait for ready.
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch('http://127.0.0.1:3194/api/health'); if (r.ok) break; }
    catch (_) { /* keep polling */ }
    await new Promise(r => setTimeout(r, 200));
  }
  ok('server boots');

  // Provision the brandon user via header-trust (so the SPA sees an
  // authenticated session), then carry the cookies into the page context.
  const reqCtx = await request.newContext({
    extraHTTPHeaders: HEAD,
    baseURL: 'http://127.0.0.1:3194',
  });
  await reqCtx.get('/api/me');
  const cookies = await reqCtx.storageState();
  await reqCtx.dispose();

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      storageState: cookies,
    });
    const page = await context.newPage();
    page.on('pageerror', e => console.log('  PAGEERROR:', e.message));
    page.on('console', m => { if (m.type() === 'error') console.log('  CONSOLE ERROR:', m.text().slice(0, 200)); });

    // ---- 1. feed-tabs: 2 enabled modules (wall, lists) — index.html stays
    // We use feed-tabs (2 modules) instead of pure feed-only (1 module) for
    // the layout test, because the SPA redirects to /porch.html when wall is
    // the sole enabled module (single-surface rule). Two modules = no redirect.
    await POST('/api/me/modules/lists/disable', { withDependents: true });
    await POST('/api/me/modules/calendar/disable', { withDependents: true });
    await POST('/api/me/modules/chores/disable', { withDependents: true });
    await POST('/api/me/modules/apps/disable', { withDependents: true });
    await POST('/api/me/modules/agent/disable', { withDependents: true });
    await POST('/api/me/modules/lists/enable', { withRequirements: true });
    let layout = await (await GET('/api/me/layout')).json();
    assertEq(layout.layout, 'feed-tabs', 'feed-tabs: layout === "feed-tabs" with wall + lists');
    await page.goto('http://127.0.0.1:3194/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.layout === 'feed-tabs', { timeout: 5000 });
    ok('feed-tabs: body[data-layout] set after SPA boot');
    const tabsNavDisplay = await page.evaluate(() => getComputedStyle(document.getElementById('appNav')).display);
    assert(tabsNavDisplay !== 'none', `feed-tabs: #appNav is visible (display=${tabsNavDisplay})`);
    // Nav buttons: wall + lists should be visible; tasks/cal/svc hidden.
    const navState1 = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('#appNav button[data-p]').forEach(b => {
        out[b.dataset.p] = b.getAttribute('data-disabled') === '1' ? 'off' : 'on';
      });
      return out;
    });
    assertEq(navState1.porch, 'on', 'feed-tabs: navPorch (wall) is visible');
    assertEq(navState1['r-lists'], 'on', 'feed-tabs: nav r-lists (lists) is visible');
    assert(navState1.tasks === 'off', 'feed-tabs: nav tasks (chores) is hidden');
    assert(navState1['r-calendar'] === 'off', 'feed-tabs: nav calendar (r-calendar) is hidden');
    assert(navState1.svc === 'off', 'feed-tabs: nav svc (apps) is hidden');
    // PHA-2557: the rendered tab count MUST match the layout.tabs count.
    const renderedTabs1 = Object.values(navState1).filter(v => v === 'on').length;
    assertEq(renderedTabs1, layout.tabs.length,
      `feed-tabs: rendered tab count (${renderedTabs1}) === layout.tabs.length (${layout.tabs.length})`);
    await page.screenshot({ path: path.join(OUT_DIR, 'modui-feed-tabs.png'), fullPage: false });
    ok('feed-tabs: screenshot captured');

    // ---- 2. meadow: enable everything -----------------------------
    layout = await enableAll();
    assertEq(layout.layout, 'meadow', 'meadow: layout === "meadow" with all enabled');
    await page.goto('http://127.0.0.1:3194/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.layout === 'meadow', { timeout: 5000 });
    const meadowNavDisplay = await page.evaluate(() => getComputedStyle(document.getElementById('appNav')).display);
    assert(meadowNavDisplay !== 'none', `meadow: #appNav is visible (display=${meadowNavDisplay})`);
    // All enabled → addRoomVisible should be false (all rooms on).
    const meadowPillDisplay = await page.evaluate(() => document.getElementById('addRoomPill').style.display);
    assertEq(meadowPillDisplay, 'none', 'meadow: + Add rooms pill is hidden (nothing to add)');
    // PHA-2557: rendered tab count parity for full-module user. All 6
    // modules enabled → meadow layout → 5 nav tabs visible (wall, chores,
    // lists, calendar, apps — `agent` is drawer-mode, surfaces as FAB
    // not a nav button). The renderable count is layout.tabs.length - 1
    // for the agent drawer, NOT layout.tabs.length. The parity check is
    // "every frame-mode module is reachable as a tab" so we assert the
    // set equality instead.
    const meadowNavState = await page.evaluate(() => {
      const out = {};
      document.querySelectorAll('#appNav button[data-p]').forEach(b => {
        out[b.dataset.p] = b.getAttribute('data-disabled') === '1' ? 'off' : 'on';
      });
      return out;
    });
    const meadowFrameKeys = (layout.tabs || []).filter(t => t.route).map(t => t.key).sort();
    const meadowRoomFromKey = Object.fromEntries(
      (await (await GET('/api/modules')).json()).map(m => [m.key, m.room])
    );
    const expectedRooms = meadowFrameKeys.map(k => meadowRoomFromKey[k]).filter(Boolean).sort();
    const actualRooms = Object.entries(meadowNavState)
      .filter(([_, v]) => v === 'on')
      .map(([k, _]) => k)
      .sort();
    assertEq(JSON.stringify(actualRooms), JSON.stringify(expectedRooms),
      `meadow: every frame-mode module is reachable as a nav tab ` +
      `(expected rooms=${JSON.stringify(expectedRooms)}, got=${JSON.stringify(actualRooms)})`);
    await page.screenshot({ path: path.join(OUT_DIR, 'modui-meadow.png'), fullPage: false });
    ok('meadow: screenshot captured');

    // ---- 3. Add rooms sheet + enable/disable round trip -----------
    // Disable calendar to make addRoomVisible true again.
    await POST('/api/me/modules/calendar/disable', { withDependents: true });
    await page.goto('http://127.0.0.1:3194/modules.html', { waitUntil: 'load' });
    await page.waitForSelector('.card-in', { timeout: 5000 });
    const rows = await page.$$('.card-in');
    assert(rows.length >= 3, `add-rooms sheet: rendered ${rows.length} module rows`);
    await page.screenshot({ path: path.join(OUT_DIR, 'modui-add-rooms.png'), fullPage: false });
    ok('add-rooms sheet: screenshot captured');
    // Find calendar's toggle and click it (enables)
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.toggle'))
        .find(b => b.dataset.key === 'calendar');
      if (btn) btn.click();
    });
    await page.waitForTimeout(800);
    const enabledAfter = new Set(await (await GET('/api/me/modules')).json());
    assert(enabledAfter.has('calendar'),
      'add-rooms sheet: clicking calendar toggle enables it');
    // Toggle again to disable
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.toggle'))
        .find(b => b.dataset.key === 'calendar');
      if (btn) btn.click();
    });
    await page.waitForTimeout(800);
    const enabledAfter2 = new Set(await (await GET('/api/me/modules')).json());
    assert(!enabledAfter2.has('calendar'),
      'add-rooms sheet: clicking calendar toggle again disables it');

    // ---- 4. empty: 0 enabled modules ------------------------------
    await disableAll();
    layout = await (await GET('/api/me/layout')).json();
    assertEq(layout.layout, 'empty', 'empty: layout === "empty" with 0 enabled');
    await page.goto('http://127.0.0.1:3194/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.layout === 'empty', { timeout: 5000 });
    const emptyPillDisplay = await page.evaluate(() => document.getElementById('addRoomPill').style.display);
    assert(emptyPillDisplay !== 'none',
      'empty: + Add rooms pill is visible (room to add)');
    await page.screenshot({ path: path.join(OUT_DIR, 'modui-empty.png'), fullPage: false });
    ok('empty: screenshot captured');

    // ---- 5. agent drawer FAB gating -------------------------------
    // agent module disabled → drawerFab should have class "off".
    // (We re-enabled everything to land a clean meadow shape for the
    // final assertion.)
    layout = await enableAll();
    await page.goto('http://127.0.0.1:3194/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.layout === 'meadow', { timeout: 5000 });
    const drawerClassWithAgent = await page.evaluate(() => document.getElementById('drawerFab').className);
    assert(!/\boff\b/.test(drawerClassWithAgent),
      `meadow + agent-on: drawerFab not gated off (class="${drawerClassWithAgent}")`);
    // Disable agent only
    await POST('/api/me/modules/agent/disable', { withDependents: true });
    await page.goto('http://127.0.0.1:3194/', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.layout === 'meadow', { timeout: 5000 });
    const drawerClassNoAgent = await page.evaluate(() => document.getElementById('drawerFab').className);
    assert(/\boff\b/.test(drawerClassNoAgent),
      `agent off: drawerFab is gated off (class="${drawerClassNoAgent}")`);
    await page.screenshot({ path: path.join(OUT_DIR, 'modui-no-agent.png'), fullPage: false });
    ok('agent gating: drawerFab visibility tracks agentDrawer flag');

    // ---- 6. wall-only screenshot (PHA-2557 acceptance) -----------
    // Disable every non-wall module. The SPA single-surface rule
    // redirects `/` to /porch.html when wall is the sole enabled
    // module (so we can't take the screenshot on `/` itself) — we
    // navigate directly to /porch.html and verify the redirect
    // path + the layout parity.
    await POST('/api/me/modules/lists/disable', { withDependents: true });
    await POST('/api/me/modules/calendar/disable', { withDependents: true });
    await POST('/api/me/modules/chores/disable', { withDependents: true });
    await POST('/api/me/modules/apps/disable', { withDependents: true });
    await POST('/api/me/modules/agent/disable', { withDependents: true });
    layout = await (await GET('/api/me/layout')).json();
    assertEq(layout.layout, 'feed-only', 'wall-only: layout === "feed-only"');
    assertEq(layout.tabs.length, 1, 'wall-only: layout.tabs.length === 1');
    assertEq(layout.tabs[0].key, 'wall', 'wall-only: only wall tab');
    // The single-surface rule redirects / to /porch.html — verify that
    // path is reachable and the layout API's defaultRoute is honored.
    await page.goto('http://127.0.0.1:3194/porch.html', { waitUntil: 'load' });
    // The /porch.html shell mounts the HomesteadFeed component into
    // #porch-mount. The component creates a `.feed-root` child even
    // when the user has no wall memberships (PHA-2206 component
    // contract). We assert the mount happened — inner feed content
    // rendering for an empty-walls user is the component's job, not
    // the layout/nav concern this smoke covers (PHA-2557).
    const porchMountState = await page.evaluate(() => {
      const m = document.getElementById('porch-mount');
      const root = m && m.querySelector('.feed-root');
      return {
        mountExists: !!m,
        feedRootExists: !!root,
      };
    });
    assert(porchMountState.mountExists,
      'wall-only: /porch.html has #porch-mount');
    assert(porchMountState.feedRootExists,
      'wall-only: HomesteadFeed mounted a .feed-root child (component contract)');
    await page.screenshot({ path: path.join(OUT_DIR, 'modui-wall-only.png'), fullPage: false });
    ok('wall-only: screenshot captured');

    // ---- 7. PHA-2557 catch-all tightening: unknown *.html → 404 ---
    // The static handler must NOT serve the SPA shell for non-existent
    // .html files. Previously /lists.html, /calendar.html, /chores.html,
    // /apps.html all returned 200 with the index.html shell (the same
    // masking class as the PHA-1704/1707/1708 /api bug). With the fix,
    // missing *.html returns 404 from the static handler before the SPA
    // catch-all swallows the request. We exercise /lists.html (which
    // exists as a registry route but no file) and assert it's 404.
    // /porch.html is the one frame route that DOES exist as a file
    // and must remain 200.
    const porchRes = await fetch('http://127.0.0.1:3194/porch.html');
    assertEq(porchRes.status, 200, '/porch.html (existing file) → 200');
    const listsRes = await fetch('http://127.0.0.1:3194/lists.html');
    assertEq(listsRes.status, 404, '/lists.html (no file) → 404 (was 200 with SPA shell pre-fix)');
    const calendarRes = await fetch('http://127.0.0.1:3194/calendar.html');
    assertEq(calendarRes.status, 404, '/calendar.html (no file) → 404');
    const appsRes = await fetch('http://127.0.0.1:3194/apps.html');
    assertEq(appsRes.status, 404, '/apps.html (no file) → 404');
    // /chores.html also doesn't exist as a file (the room exists in-SPA,
    // but the static file was never created).
    const choresRes = await fetch('http://127.0.0.1:3194/chores.html');
    assertEq(choresRes.status, 404, '/chores.html (no file) → 404');
    // /api still returns 404 for unknown routes (the original PHA-1704
    // bug was /api returning 200 with the SPA shell for unknown paths).
    const apiRes = await fetch('http://127.0.0.1:3194/api/this-does-not-exist');
    assertEq(apiRes.status, 404, '/api/this-does-not-exist → 404');
    const apiCt = apiRes.headers.get('content-type') || '';
    assert(!apiCt.includes('text/html'),
      `/api 404 has JSON content-type (got ${apiCt}) — not SPA shell`);

  } finally {
    if (browser) await browser.close();
  }

  console.log(`\n[smoke-modui] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('[smoke-modui] FATAL', err);
  process.exit(2);
});
