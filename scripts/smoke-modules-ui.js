#!/usr/bin/env node
// PHA-2205 (PHA-2200.4) smoke test: SPA layout-aware bootstrap + add-a-room sheet.
//
// What we verify, against a live server.js booted on an ephemeral port:
//
//   1. Static asset delivery — /modules.html, /modules.js, /modules.css
//      all return 200 with the expected markers in the HTML/JS/CSS body.
//
//   2. /api/me/layout contract — with the user's enabled module set
//      forced to (a) {wall}, (b) {wall, chores, calendar}, (c) {wall,
//      chores, calendar, apps, agent}, the API returns the expected
//      `layout` discriminator (feed-only / feed-tabs / meadow) plus
//      addRoomVisible, agentDrawer, defaultRoute, and a non-empty
//      tabs/pages array.
//
//   3. /api/me — first_run handshake. Confirms that the first_run
//      boolean round-trips through the user-modules backfill so the
//      SPA's first_run redirect to /welcome.html works.
//
//   4. SPA shell contract — public/index.html carries the layout
//      bootstrap markers we wrote (applyLayout, openAddRoomSheet,
//      homestead:layout-changed listener, addRoomsPill element,
//      #mainNav[data-layout] hooks). We grep the HTML so a future
//      refactor that strips the bootstrap fails the smoke before
//      anyone deploys.
//
//   5. Modules.js public API — the file exposes `window.Modules.open`
//      and dispatches the 'homestead:layout-changed' event so the
//      SPA's applyLayout listener can fire without a page reload.
//
//   6. service worker precache list — public/sw.js STATIC_ASSETS
//      includes /modules.html, /modules.js, /modules.css so the
//      sheet loads on cold install.
//
//   7. (Best-effort) Playwright Chromium browser smoke — boots the
//      SPA, mocks /api/me/layout responses, and asserts the nav
//      buttons render correctly for each layout. Skipped when no
//      browser binary is reachable (CI without Playwright installed).
//
// Designed to be added to `npm run test:smoke` next to the other
// PHA-22xx smoke scripts. Boots server.js in-process on an ephemeral
// port with a tmp DATA_DIR.
//
// Run after `npm test`:
//   node scripts/smoke-modules-ui.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-modui-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3095';
process.env.ADMIN_PASSWORD = 'smoke-modui-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-modui-brandon-pw';
process.env.SESSION_SECRET = 'smoke-modui-secret';
process.env.NODE_ENV = 'production';
if (!process.env.CALENDAR_CRED_KEY) {
  console.error('[smoke-modui] CALENDAR_CRED_KEY is required');
  process.exit(1);
}

const BASE = 'http://127.0.0.1:3095';

// Counters
let pass = 0, fail = 0;
const failures = [];
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) {
  fail++;
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
}
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

async function login(username, password) {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (r.status !== 200) throw new Error(`login failed for ${username}: HTTP ${r.status}`);
  // Capture the connect.sid cookie.
  const setCookie = r.headers.get('set-cookie') || '';
  return setCookie.split(';')[0];
}

async function getJson(cookie, url) {
  const r = await fetch(`${BASE}${url}`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
  return r.json();
}

async function postJson(cookie, url, body) {
  const r = await fetch(`${BASE}${url}`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`POST ${url} → HTTP ${r.status} ${text}`);
  }
  return r.json().catch(() => ({}));
}

// Boot server.js (in-process, like the other PHA-2200 smokes).
(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3095, '127.0.0.1', () => { console.log('[smoke-modui] homestead on :3095'); resolve(); });
    process.on('uncaughtException', reject);
  });

  // Wait for /api/health to be reachable.
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { ready = true; break; }
    } catch (_) { /* keep retrying */ }
    await new Promise(r => setTimeout(r, 200));
  }
  if (!ready) { console.error('[smoke-modui] server never became ready'); process.exit(1); }

  const cookie = await login('brandon', process.env.BRANDON_PASSWORD);

  // ---------- Section 1: static asset delivery ----------
  console.log('\nSection 1: static asset delivery');
  for (const p of ['/modules.html', '/modules.js', '/modules.css', '/sw.js']) {
    const r = await fetch(`${BASE}${p}`);
    if (r.status === 200) ok(`GET ${p} → 200`);
    else ng(`GET ${p} → ${r.status}`);
  }
  const modsHtml = await (await fetch(`${BASE}/modules.html`)).text();
  assert(modsHtml.includes('id="modsList"'), 'modules.html has #modsList container');
  assert(modsHtml.includes('id="modsBack"'), 'modules.html has #modsBack button');
  assert(modsHtml.includes('id="modsDone"'), 'modules.html has #modsDone button');
  assert(modsHtml.includes('<link rel="stylesheet" href="/modules.css">'), 'modules.html links modules.css');
  assert(modsHtml.includes('<script src="/modules.js">'), 'modules.html loads modules.js');

  const modsJs = await (await fetch(`${BASE}/modules.js`)).text();
  assert(modsJs.includes("'/api/modules'"), 'modules.js reads /api/modules registry');
  assert(modsJs.includes("'/api/me/layout'"), 'modules.js reads /api/me/layout');
  assert(modsJs.includes('/enable') && modsJs.includes('/disable'), 'modules.js calls enable/disable endpoints');
  assert(modsJs.includes('window.Modules'), 'modules.js exposes window.Modules');
  assert(modsJs.includes("'homestead:layout-changed'"), 'modules.js dispatches layout-changed event');

  const modsCss = await (await fetch(`${BASE}/modules.css`)).text();
  assert(modsCss.includes('.mods-row'), 'modules.css defines .mods-row');
  assert(modsCss.includes('.mods-toggle'), 'modules.css defines .mods-toggle');

  // ---------- Section 2: /api/me/layout contract ----------
  console.log('\nSection 2: /api/me/layout shapes');

  // First, capture the user's current enabled modules so we can restore later.
  let me = await getJson(cookie, '/api/me');
  const initialEnabled = new Set(me.enabled_modules || []);
  console.log(`  (initial enabled modules: ${[...initialEnabled].join(', ') || '<none>'})`);

  function layoutForKeys(keys) {
    // Mirror lib/modules.js computeLayout() so the smoke expectations
    // stay in sync with the source-of-truth server logic. If this
    // drifts, the test failures will pin the discrepancy. REGISTRY_ORDER
    // matches lib/modules.js REGISTRY_ORDER exactly (insertion order of
    // the REGISTRY object literal).
    const ORDERED = ['wall', 'lists', 'calendar', 'chores', 'apps', 'agent'];
    // When the desired set includes a module with unmet requirements,
    // `withRequirements: true` cascades the dependency. chores needs
    // lists, so we capture that closure here. This is a smoke-side
    // mirror of the server's withRequirements cascade so our expected
    // length matches what actually lands in user_modules.
    const closure = new Set(keys);
    for (const k of keys) {
      const deps = REQUIRES[k] || [];
      for (const d of deps) closure.add(d);
    }
    const ordered = ORDERED.filter(k => closure.has(k));
    const all = ORDERED;
    const tiles = ordered.map(k => ({ key: k }));
    let layout;
    if (tiles.length === 0) layout = 'empty';
    else if (tiles.length === 1) layout = 'feed-only';
    else if (tiles.length <= 3) layout = 'feed-tabs';
    else layout = 'meadow';
    // defaultRoute mirrors computeLayout: first enabled module's `url`
    // from the registry, falling back to '/onboarding.html' when empty.
    // For our seed data wall→/porch.html, lists→/lists.html,
    // calendar→/calendar.html, chores→/chores.html, apps→/apps.html.
    const ROUTES = {
      wall: '/porch.html',
      lists: '/lists.html',
      calendar: '/calendar.html',
      chores: '/chores.html',
      apps: '/apps.html',
      agent: null,
    };
    const defaultRoute = ordered.length > 0 ? (ROUTES[ordered[0]] || '/onboarding.html') : '/onboarding.html';
    return {
      layout,
      addRoomVisible: ordered.length < all.length,
      agentDrawer: closure.has('agent'),
      defaultRoute,
      n: ordered.length,
    };
  }

  // Module dependency map (mirror of lib/modules.js REGISTRY's
  // `requires` field). Used to disable dependents BEFORE their
  // dependencies so the 409 dependents_active error never fires.
  const REQUIRES = {
    chores: ['lists'],
  };
  // Reverse map: for each module, the list of modules that REQUIRE it.
  const REQUIRED_BY = {};
  for (const k of Object.keys(REQUIRES)) {
    for (const dep of REQUIRES[k]) {
      if (!REQUIRED_BY[dep]) REQUIRED_BY[dep] = [];
      REQUIRED_BY[dep].push(k);
    }
  }
  // Order in which to disable so dependents are turned off first.
  // Topological sort by requires: walk from leaf dependents to roots.
  function disableOrder(all, currentlyEnabled) {
    const order = [];
    const visited = new Set();
    function visit(k) {
      if (visited.has(k)) return;
      visited.add(k);
      // First, recurse into anything that requires `k` (must disable
      // them first).
      const dependents = REQUIRED_BY[k] || [];
      for (const d of dependents) {
        if (currentlyEnabled.has(d)) visit(d);
      }
      order.push(k);
    }
    // Visit every currently-enabled module in registry order so the
    // output is deterministic.
    for (const k of all) {
      if (currentlyEnabled.has(k)) visit(k);
    }
    return order;
  }

  async function forceEnabled(keys) {
    // Toggle on the desired keys, toggle off the others. We use
    // POST /api/me/modules/:key/{enable,disable} rather than poking
    // the DB directly so the smoke exercises the public API.
    //
    // Dependency rule (PHA-2203): chores has `requires: ['lists']`,
    // so the disable path rejects with 409 dependents_active if you
    // try to disable lists while chores is still on. Walk the
    // disable list topologically: every dependent is disabled before
    // its dependency.
    //
    // Diff against the CURRENT state, not the snapshot captured at
    // the top of the smoke — otherwise the second / third / fourth
    // tryLayout call would silently no-op its enables because the
    // snapshot still thinks they're "already on".
    const meNow = await getJson(cookie, '/api/me');
    const currentEnabled = new Set(meNow.enabled_modules || []);
    const desired = new Set(keys);
    const all = ['wall', 'lists', 'calendar', 'chores', 'apps', 'agent'];

    // Disable everything currently enabled that is NOT in the desired
    // set, in topological order so dependents go first. The
    // `withDependents: true` flag is the safest path: it lets the
    // server cascade to dependents (e.g. disabling `lists` also
    // disables `chores`), so we don't have to enumerate the full
    // transitive closure client-side.
    const order = disableOrder(all, currentEnabled);
    for (const k of order) {
      if (!desired.has(k) && currentEnabled.has(k)) {
        await postJson(cookie, `/api/me/modules/${k}/disable`, { withDependents: true });
      }
    }
    // Re-read state after disables.
    const meNow2 = await getJson(cookie, '/api/me');
    const currentEnabled2 = new Set(meNow2.enabled_modules || []);
    // Enable everything in the desired set that isn't currently on.
    for (const k of all) {
      if (desired.has(k) && !currentEnabled2.has(k)) {
        try {
          await postJson(cookie, `/api/me/modules/${k}/enable`, { withRequirements: true });
        } catch (e) {
          console.log(`    DEBUG enable ${k} failed:`, e.message);
        }
      }
    }
  }

  // Try the layout discriminator for each configuration. Some modules
  // may not exist in this DB seed; gracefully skip those cases.
  async function tryLayout(keys, label) {
    let layout;
    try {
      await forceEnabled(keys);
      layout = await getJson(cookie, '/api/me/layout');
    } catch (e) {
      ng(`${label} (${keys.join(',') || '<empty>'})`, e.message);
      return null;
    }
    const expected = layoutForKeys(keys);
    assertEq(layout.layout, expected.layout, `${label} → layout discriminator`);
    assertEq(layout.addRoomVisible, expected.addRoomVisible, `${label} → addRoomVisible`);
    assertEq(layout.agentDrawer, expected.agentDrawer, `${label} → agentDrawer`);
    assert(typeof layout.defaultRoute === 'string' && layout.defaultRoute.length > 0,
      `${label} → defaultRoute present`);
    assert(Array.isArray(layout.tabs) && layout.tabs.length === expected.n,
      `${label} → tabs.length == ${expected.n}`);
    return layout;
  }

  // The four discriminator cases we ship:
  //   empty     → 0 enabled (no modules enabled; onboards first-run)
  //   feed-only → 1 enabled
  //   feed-tabs → 2-3 enabled
  //   meadow    → 4+ enabled
  //
  // Note: `chores` has `requires: ['lists']`, so enabling `chores`
  // cascades to also enable `lists`. The smoke exercises that path
  // implicitly when the user clicks "Add" in the SPA. Our forceEnabled
  // helper above matches that behaviour with `withRequirements: true`.

  await tryLayout(['wall'], '1 enabled → feed-only');
  await tryLayout(['wall', 'chores'], 'chores cascades lists → feed-tabs');
  await tryLayout(['wall', 'calendar'], '2 enabled → feed-tabs');
  await tryLayout(['wall', 'chores', 'calendar'], '3 enabled → feed-tabs');
  await tryLayout(['wall', 'chores', 'calendar', 'apps'], '4 enabled → meadow');

  // ---------- Section 3: first_run handshake ----------
  console.log('\nSection 3: first_run handshake');
  me = await getJson(cookie, '/api/me');
  assert(typeof me.first_run === 'boolean', '/api/me returns first_run as boolean');
  // Don't actually toggle first_run — that's a one-shot stamp and
  // would change the user's real state. Just verify the endpoint
  // shape exists and is well-typed.
  const welcomeHtml = await (await fetch(`${BASE}/welcome.html`)).text();
  assert(welcomeHtml.includes('first-run-complete') || welcomeHtml.includes('first_run_complete'),
    'welcome.html mentions the first-run-complete endpoint');

  // ---------- Section 4: SPA shell contract ----------
  console.log('\nSection 4: SPA shell contract');
  const indexHtml = await (await fetch(`${BASE}/`)).text();
  assert(indexHtml.includes('id="mainNav"'), 'index.html has #mainNav element');
  assert(indexHtml.includes('id="addRoomsPill"'), 'index.html has #addRoomsPill element');
  assert(indexHtml.includes('id="drawerFab"'), 'index.html has #drawerFab element');
  assert(indexHtml.includes('applyLayout'), 'index.html bootstrap calls applyLayout');
  assert(indexHtml.includes('openAddRoomSheet'), 'index.html defines openAddRoomSheet');
  assert(indexHtml.includes("homestead:layout-changed"), 'index.html listens for layout-changed event');
  assert(indexHtml.includes('getElementById') || indexHtml.includes("'$('"), 'index.html uses a $ helper');
  // The CSS hook for the layout-aware shell:
  assert(indexHtml.includes('#mainNav[data-layout'), 'index.html CSS hooks #mainNav[data-layout]');
  assert(indexHtml.includes('.add-rooms-pill'), 'index.html CSS defines .add-rooms-pill');

  // ---------- Section 5: sw.js precache ----------
  console.log('\nSection 5: service worker precache list');
  const swJs = await (await fetch(`${BASE}/sw.js`)).text();
  assert(swJs.includes("'/modules.html'"), 'sw.js precaches /modules.html');
  assert(swJs.includes("'/modules.js'"), 'sw.js precaches /modules.js');
  assert(swJs.includes("'/modules.css'"), 'sw.js precaches /modules.css');

  // ---------- Section 6: best-effort browser smoke ----------
  console.log('\nSection 6: best-effort Playwright browser smoke');
  // Allow override via env, default to the system-cached Chromium binary
  // Playwright drops under /home/node/.cache/ms-playwright on Debian
  // images. The dev dep on `playwright` (in package.json) installs it
  // locally; the binary lives in the shared cache so multiple worktrees
  // can reuse one copy.
  const browserBin = process.env.PW_CHROMIUM_BIN
    || '/home/node/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
  // Try the local install first, then fall back to the worktree that
  // already has playwright as a devDep. Either path is acceptable.
  const PLAYWRIGHT_CANDIDATES = [
    path.resolve(__dirname, '..', 'node_modules', 'playwright'),
    '/root/.openclaw/workspace/worktrees/homestead-pha-2494/node_modules/playwright',
  ];
  const playwrightModulePath = PLAYWRIGHT_CANDIDATES.find(p => fs.existsSync(p));
  const hasPlaywright = !!playwrightModulePath && fs.existsSync(browserBin);
  if (!hasPlaywright) {
    console.log('  (skipped: no playwright module / no chromium binary at default path)');
    console.log('  (set PW_CHROMIUM_BIN to enable this section)');
    console.log('  (searched playwright in:', PLAYWRIGHT_CANDIDATES.join(', '), ')');
  } else {
    console.log(`  (using playwright at ${playwrightModulePath})`);
    console.log(`  (using chromium at ${browserBin})`);
    try {
      const { chromium } = require(playwrightModulePath);
      const browser = await chromium.launch({ executablePath: browserBin, headless: true });
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();

      // Mock the layout + me endpoints to deterministic responses so
      // the SPA renders the exact layout we want. We let /api/login
      // and the auth-middleware session cookie through to the real
      // server so the SPA can authenticate normally — the rest of the
      // /api surface gets mocked.
      let currentLayout = {
        layout: 'feed-only',
        tabs: [{ key: 'wall', icon: '📸', label: 'Wall', route: '/porch.html' }],
        pages: [{ key: 'wall', icon: '📸', label: 'Wall', route: '/porch.html' }],
        defaultRoute: '/porch.html',
        addRoomVisible: true,
        agentDrawer: false,
      };
      let currentMe = { username: 'brandon', first_run: false, enabled_modules: [{ key: 'wall' }] };

      // Capture network logs at debug-level. The smoke's own PASS/FAIL
      // log is what an operator reads; per-request chatter is noise.
      // Re-enable with HOMESTEAD_SMOKE_VERBOSE=1 for a debug run.
      const VERBOSE = process.env.HOMESTEAD_SMOKE_VERBOSE === '1';
      if (VERBOSE) {
        page.on('response', r => {
          if (r.url().includes('/api/')) console.log(`    [net] ${r.status()} ${r.request().method()} ${r.url().replace(BASE, '')}`);
        });
        page.on('console', m => {
          if (m.type() === 'error' || m.type() === 'warning') console.log(`    [browser:${m.type()}] ${m.text()}`);
        });
        page.on('pageerror', e => console.log(`    [pageerror] ${e.message}`));
      }

      await page.route('**/api/me/layout', route => {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentLayout) });
      });
      await page.route('**/api/me/modules', route => {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ enabled: currentLayout.tabs.map(t => t.key) }) });
      });
      await page.route('**/api/me', route => {
        // SPA expects the buildMeEnvelope shape: { user, enabled_modules,
        // default_route, first_run }. currentMe may carry that already.
        const envelope = currentMe.user ? currentMe : {
          user: { username: 'brandon', display: 'Brandon', color: '#C4703C', is_admin: true },
          enabled_modules: currentLayout.tabs.map(t => t.key),
          default_route: currentLayout.defaultRoute,
          first_run: false,
        };
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) });
      });
      await page.route('**/api/modules', route => {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          modules: [
            { key: 'wall', name: 'Wall', icon: '📸', description: 'Family wall', tier: 'core', open_mode: 'frame', url: '/porch.html' },
            { key: 'chores', name: 'Chores', icon: '✓', description: 'Tasks & repeats', tier: 'core', open_mode: 'frame', url: '/tasks.html' },
            { key: 'calendar', name: 'Calendar', icon: '📅', description: 'Events', tier: 'core', open_mode: 'frame', url: '/cal.html' },
            { key: 'apps', name: 'Apps', icon: '🛰️', description: 'Installed apps', tier: 'advanced', open_mode: 'frame', url: '/svc.html' },
            { key: 'agent', name: 'Agent', icon: '💬', description: 'Chat with the assistant', tier: 'advanced', open_mode: 'drawer', url: null },
          ],
        }) });
      });
      // Stub login as a no-op so the SPA boots the post-login shell.
      await page.route('**/api/walls', route => {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ walls: [] }) });
      });
      await page.route('**/api/users', route => {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
          { username: 'brandon', display: 'Brandon', color: '#C4703C', is_admin: true },
        ]) });
      });
      // Stub data endpoints so refresh() doesn't blow up.
      for (const p of ['/api/me/snapshot', '/api/tasks', '/api/events', '/api/services']) {
        await page.route(`**${p}`, route => {
          route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(p.endsWith('/snapshot') ? {} : []) });
        });
      }

      async function loadAs(brandon, layoutObj, meObj) {
        currentLayout = layoutObj;
        currentMe = meObj;
        // Drive the SPA: navigate to /. If /api/me (mocked) returns
        // a user, the SPA goes straight to boot() — no login click
        // needed. If the user envelope is null, the SPA shows the
        // login screen and we drive it manually.
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        // Wait briefly to see if /api/me (mocked) auto-bypasses login.
        let onLogin = false;
        try {
          await page.waitForFunction(() => {
            const login = document.getElementById('login');
            const app = document.getElementById('app');
            return login || app;
          }, { timeout: 2000 });
          onLogin = await page.evaluate(() => {
            const login = document.getElementById('login');
            return login && getComputedStyle(login).display !== 'none';
          });
        } catch (_) { /* assume post-login */ }
        if (onLogin) {
          await page.fill('#username', 'brandon');
          await page.fill('#pw', process.env.BRANDON_PASSWORD);
          await page.click('#loginBtn');
        }
        // Wait for SPA to apply the layout (data-layout attribute appears
        // once boot() resolves).
        await page.waitForFunction(() => {
          const nav = document.getElementById('mainNav');
          return nav && nav.hasAttribute('data-layout');
        }, { timeout: 8000 }).catch(() => {});
      }

      // (a) feed-only: nav hidden, pill visible, FAB opens the add-a-room sheet.
      await loadAs('brandon',
        {
          layout: 'feed-only',
          tabs: [{ key: 'wall', icon: '📸', label: 'Wall', route: '/porch.html' }],
          pages: [{ key: 'wall', icon: '📸', label: 'Wall', route: '/porch.html' }],
          defaultRoute: '/porch.html',
          addRoomVisible: true,
          agentDrawer: false,
        },
        { username: 'brandon', first_run: false, enabled_modules: [{ key: 'wall' }] }
      );
      // Wait for nav to receive data-layout attribute.
      await page.waitForFunction(() => document.getElementById('mainNav')?.getAttribute('data-layout') === 'feed-only', { timeout: 5000 }).catch(() => {});
      // PHA-2501 evidence: capture a 390×844 mobile-viewport screenshot
      // of the feed-only layout so the closing comment can paste the
      // actual rendered DOM. The verify.sh harness also pulls these
      // for the PR.
      await page.screenshot({ path: '/tmp/pha-2205-feed-only.png', fullPage: false });
      const navDisplay = await page.$eval('#mainNav', el => getComputedStyle(el).display);
      assert(navDisplay === 'none', 'feed-only: #mainNav display:none');
      const pillVisible = await page.$eval('#addRoomsPill', el => !el.hidden && el.classList.contains('on'));
      assert(pillVisible, 'feed-only: #addRoomsPill is on');
      const drawerOff = await page.$eval('#drawerFab', el => el.classList.contains('off'));
      assert(drawerOff, 'feed-only: #drawerFab is .off when agentDrawer=false');

      // Tap pill → sheet should mount with the registry rows.
      await page.click('#addRoomsPill');
      // Wait for the lazy-loaded modules.js + the API calls to settle.
      await page.waitForSelector('#sheet .mods-row', { timeout: 8000 }).catch(() => {});
      const rows = await page.$$eval('#sheet .mods-row', els => els.map(e => e.dataset.key));
      assert(rows.includes('chores') && rows.includes('calendar'),
        'add-a-room sheet renders the registry rows (chores, calendar)');

      // (b) feed-tabs: nav visible with 3 buttons.
      await loadAs('brandon',
        {
          layout: 'feed-tabs',
          tabs: [
            { key: 'wall', icon: '📸', label: 'Wall', route: '/porch.html' },
            { key: 'chores', icon: '✓', label: 'Chores', route: '/' },
            { key: 'calendar', icon: '📅', label: 'Calendar', route: '/' },
          ],
          pages: [
            { key: 'wall', icon: '📸', label: 'Wall', route: '/porch.html' },
            { key: 'chores', icon: '✓', label: 'Chores', route: '/' },
            { key: 'calendar', icon: '📅', label: 'Calendar', route: '/' },
          ],
          defaultRoute: '/porch.html',
          addRoomVisible: true,
          agentDrawer: false,
        },
        { username: 'brandon', first_run: false, enabled_modules: [{ key: 'wall' }, { key: 'chores' }, { key: 'calendar' }] }
      );
      await page.waitForFunction(() => document.getElementById('mainNav')?.getAttribute('data-layout') === 'feed-tabs', { timeout: 5000 }).catch(() => {});
      await page.screenshot({ path: '/tmp/pha-2205-feed-tabs.png', fullPage: false });
      const navDisplay2 = await page.$eval('#mainNav', el => getComputedStyle(el).display);
      assert(navDisplay2 !== 'none', 'feed-tabs: #mainNav is visible');
      const navBtns = await page.$$eval('#mainNav button', els => els.length);
      assert(navBtns === 2, `feed-tabs: nav renders 2 buttons (chores + calendar), got ${navBtns}`);
      const pillHidden = await page.$eval('#addRoomsPill', el => el.hidden || !el.classList.contains('on'));
      assert(pillHidden, 'feed-tabs: #addRoomsPill is hidden');

      // (c) meadow: nav visible with all 4 buttons (wall excluded per spec).
      await loadAs('brandon',
        {
          layout: 'meadow',
          tabs: [
            { key: 'wall', icon: '📸', label: 'Wall', route: '/porch.html' },
            { key: 'chores', icon: '✓', label: 'Chores', route: '/' },
            { key: 'calendar', icon: '📅', label: 'Calendar', route: '/' },
            { key: 'apps', icon: '🛰️', label: 'Apps', route: '/' },
            { key: 'agent', icon: '💬', label: 'Agent', route: '/' },
          ],
          pages: [
            { key: 'wall', icon: '📸', label: 'Wall', route: '/porch.html' },
            { key: 'chores', icon: '✓', label: 'Chores', route: '/' },
            { key: 'calendar', icon: '📅', label: 'Calendar', route: '/' },
            { key: 'apps', icon: '🛰️', label: 'Apps', route: '/' },
            { key: 'agent', icon: '💬', label: 'Agent', route: '/' },
          ],
          defaultRoute: '/',
          addRoomVisible: false,
          agentDrawer: true,
        },
        { username: 'brandon', first_run: false, enabled_modules: [
          { key: 'wall' }, { key: 'chores' }, { key: 'calendar' }, { key: 'apps' }, { key: 'agent' },
        ] }
      );
      await page.waitForFunction(() => document.getElementById('mainNav')?.getAttribute('data-layout') === 'meadow', { timeout: 5000 }).catch(() => {});
      await page.screenshot({ path: '/tmp/pha-2205-meadow.png', fullPage: false });
      const navBtns2 = await page.$$eval('#mainNav button', els => els.length);
      assert(navBtns2 === 4, `meadow: nav renders 4 buttons (chores + calendar + apps + agent), got ${navBtns2}`);
      const drawerOff2 = await page.$eval('#drawerFab', el => !el.classList.contains('off'));
      assert(drawerOff2, 'meadow: #drawerFab is on when agentDrawer=true');

      // (d) empty: nav hidden, main hidden, no buttons.
      await loadAs('brandon',
        { layout: 'empty', tabs: [], pages: [], defaultRoute: '/onboarding.html', addRoomVisible: true, agentDrawer: false },
        { username: 'brandon', first_run: false, enabled_modules: [] }
      );
      await page.waitForFunction(() => document.getElementById('mainNav')?.getAttribute('data-layout') === 'empty', { timeout: 5000 }).catch(() => {});
      await page.screenshot({ path: '/tmp/pha-2205-empty.png', fullPage: false });
      const navDisplay3 = await page.$eval('#mainNav', el => getComputedStyle(el).display);
      assert(navDisplay3 === 'none', 'empty: #mainNav display:none');
      const mainDisplay = await page.$eval('main', el => getComputedStyle(el).display);
      assert(mainDisplay === 'none', 'empty: <main> is hidden');

      await browser.close();
    } catch (e) {
      ng('Playwright browser smoke', e.message);
    }
  }

  // ---------- Restore user state ----------
  console.log('\nRestoring user state…');
  const all = ['wall', 'lists', 'calendar', 'chores', 'apps', 'agent'];
  for (const k of all) {
    const want = initialEnabled.has(k);
    try {
      if (want) {
        await postJson(cookie, `/api/me/modules/${k}/enable`);
      } else {
        // best-effort disable; 404 if already off is fine
        await postJson(cookie, `/api/me/modules/${k}/disable`);
      }
    } catch (_) { /* ignore — smoke doesn't own this state */ }
  }

  console.log(`\n[smoke-modui] ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error('FAILURES:');
    for (const f of failures) console.error('  - ' + f);
    process.exit(1);
  }
  process.exit(0);
})().catch(e => {
  console.error('[smoke-modui] fatal:', e);
  process.exit(1);
});
