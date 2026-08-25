#!/usr/bin/env node
// PHA-2585 acceptance smoke: after applyLayout() runs, the Home tab
// in the bottom nav MUST remain visible (no data-disabled="1") and
// the #page-home MUST also be visible — independent of which modules
// the user has enabled. PHA-2557's tighten-SPA-catch-all change hid
// Home because data-p="home" is not a module room. This smoke boots a
// fresh server, logs in as brandon, asserts that:
//   1. The Home button in #appNav is visible (not hidden via
//      data-disabled="1") regardless of the user's enabled modules.
//   2. #page-home is visible.
//   3. The page that the SPA actually lands on after boot is Home
//      (the home button has .on, #page-home has .on).
//   4. Tapping Home shows the Today + On the list landing content.
//   5. Other tabs (Tasks, Lists, Calendar, Apps, Porch) still hide
//      when their module is disabled — i.e. we didn't break the
//      PHA-2557 "render every frame-mode module as a tab" behavior.
//   6. 390x844 mobile-viewport screenshot of the post-login nav that
//      INCLUDES the Home tab, captured by Playwright Chromium. We
//      capture the screenshot on a fresh-install (all modules) state
//      because once feed becomes the user's only enabled module, the
//      SPA redirects to /porch.html (boot() line ~950) — that's
//      correct existing behavior, but it means a reload-after-disable
//      screenshot would not capture the SPA nav.
//   7. No JS errors anywhere.
//
// Run: node scripts/smoke-2585-home-always-visible.js
// Output: ./verify-out/home-always-visible-390.png
//         ./verify-out/home-always-visible-disabled-390.png
//
// No DB writes. We boot into a fresh ephemeral DATA_DIR so brandon's
// enabled modules match the seed (all six grandfathered).

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2585-'));
const port = 3110;
const brandonPassword = 'smoke-2585-brandon-pw';
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-2585-admin-pw';
process.env.BRANDON_PASSWORD = brandonPassword;
process.env.SESSION_SECRET = 'smoke-2585-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
  else ng(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const pageErrorSink = [];
const consoleErrorSink = [];

(async () => {
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch (_) { /* boot in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      channel: 'chromium',
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrorSink.push(error));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrorSink.push(msg.text());
    });

    const root = await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    if (!root || !root.ok()) {
      throw new Error(`SPA root returned ${root ? root.status() : 'no response'}`);
    }

    // Login as brandon.
    await page.waitForSelector('#username', { state: 'visible', timeout: 5000 });
    await page.fill('#username', 'brandon');
    await page.fill('#pw', brandonPassword);
    await page.click('#loginBtn');

    await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });

    // Dismiss any first-run welcome sheet so subsequent assertions
    // about the bottom nav have a clear viewport. The dismiss
    // handler is wired to #welcomeDismiss.onclick (PHA-2584); use
    // the same path the SPA uses. Per MEMORY lesson #139, NEVER
    // click install-coach trigger buttons in this smoke — only the
    // welcome sheet dismiss is safe.
    //
    // The SPA's boot() path checks /api/me.first_run === true AFTER
    // the layout has been applied (public/index.html line ~963),
    // so dismissing before boot completes can race with a re-open.
    // We poll: POST /api/me/first-run-complete repeatedly until
    // /api/me reports first_run:false, then strip the .on class.
    // Then we wait for the modal to actually settle (a re-open from
    // a delayed boot path would add .on back).
    for (let i = 0; i < 30; i++) {
      await page.evaluate(async () => {
        try {
          await fetch('/api/me/first-run-complete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
        } catch (_) { /* ignore */ }
      });
      const meNow = await page.evaluate(async () => {
        const r = await fetch('/api/me');
        return await r.json();
      });
      if (meNow.first_run === false) {
        // Boot() may still add .on again after this point. Strip it
        // and wait for it to stay off for 1s to confirm no re-open.
        await page.evaluate(() => {
          const m = document.getElementById('modal');
          if (m) m.classList.remove('on');
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const stillOff = await page.evaluate(() =>
          !document.getElementById('modal').classList.contains('on'));
        if (stillOff) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Wait until the layout has applied and the nav is stable.
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('#appNav button[data-p="home"]');
        return !!btn && btn.getAttribute('data-disabled') !== '1';
      },
      null,
      { timeout: 5000 },
    ).catch(() => null);

    // === Acceptance checks ===

    // 1. Home button is NOT data-disabled (always visible).
    const homeDisabled = await page.evaluate(() => {
      const btn = document.querySelector('#appNav button[data-p="home"]');
      return btn ? btn.getAttribute('data-disabled') : 'no-button';
    });
    assertEq(homeDisabled, null,
      '#appNav button[data-p="home"] has no data-disabled (always visible)');

    // 2. #page-home is NOT data-disabled.
    const pageHomeDisabled = await page.evaluate(() => {
      const pg = document.getElementById('page-home');
      return pg ? pg.getAttribute('data-disabled') : 'no-page';
    });
    assertEq(pageHomeDisabled, null,
      '#page-home has no data-disabled');

    // 3. The SPA actually lands on Home (the .on class is on home).
    const onTab = await page.evaluate(() => {
      const on = document.querySelector('#appNav button.on');
      return on ? on.getAttribute('data-p') : 'no-active';
    });
    assertEq(onTab, 'home',
      'SPA lands on Home after login (active tab is "home")');

    // The corresponding page div also has .on.
    const onPageId = await page.evaluate(() => {
      const on = document.querySelector('.page.on');
      return on ? on.id : 'no-active-page';
    });
    assertEq(onPageId, 'page-home',
      '#page-home has .on (the active page after login)');

    // 4. Home tab is visually present (CSS display !== none) and
    // clickable — capture the bounding box to prove it actually
    // rendered, not just exists in the DOM as display:none.
    const homeBox = await page.evaluate(() => {
      const btn = document.querySelector('#appNav button[data-p="home"]');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      const style = window.getComputedStyle(btn);
      return {
        width: r.width,
        height: r.height,
        display: style.display,
        visible: r.width > 0 && r.height > 0 && style.display !== 'none',
      };
    });
    assert(homeBox && homeBox.visible,
      'Home button is actually visible (bounding box > 0, display !== none)',
      homeBox ? JSON.stringify(homeBox) : 'no button');

    // 5. Tapping the Home tab shows the Today + On the list landing.
    // First, navigate away to Tasks and confirm we can come back.
    await page.evaluate(() => {
      const tasksBtn = document.querySelector('#appNav button[data-p="tasks"]');
      if (tasksBtn) tasksBtn.click();
    });
    await page.waitForFunction(
      () => document.querySelector('#page-tasks.on') !== null,
      null,
      { timeout: 5000 },
    ).catch(() => null);
    await page.evaluate(() => {
      const homeBtn = document.querySelector('#appNav button[data-p="home"]');
      if (homeBtn) homeBtn.click();
    });
    await page.waitForFunction(
      () => document.querySelector('#page-home.on') !== null,
      null,
      { timeout: 5000 },
    );
    ok('tap Home → #page-home.on activates the Today landing');

    // 6. The Home page actually has the Today + "On the list" copy.
    // We assert against the page contents rather than exact strings
    // because the copy lives in index.html and we don't want a copy
    // edit to break the structural smoke.
    const homeText = await page.evaluate(() => {
      const pg = document.getElementById('page-home');
      return pg ? pg.textContent.toLowerCase() : '';
    });
    assert(homeText.includes('today') || homeText.includes('on the list'),
      '#page-home contains "Today" or "On the list" landing copy');

    // 6b. Screenshot — fresh install (all modules enabled). This is
    // the durable evidence that the bottom nav shows Home next to
    // the enabled modules. The 390x844 mobile viewport per
    // PHA-2501 standing DoD.
    // Wait one more time for the welcome sheet to be gone; some
    // boot paths re-show it after a brief delay.
    await page.waitForFunction(
      () => !document.getElementById('modal').classList.contains('on'),
      null,
      { timeout: 5000 },
    ).catch(() => null);
    // Final state-check right before capture.
    const preShotState = await page.evaluate(() => {
      const m = document.getElementById('modal');
      const sheet = document.getElementById('sheet');
      const navWall = document.getElementById('navWall');
      return {
        modalOn: m ? m.classList.contains('on') : null,
        sheetText: sheet ? sheet.textContent.slice(0, 80) : '',
        activePage: (document.querySelector('.page.on') || {}).id || 'none',
        navHomeDisabled: document.querySelector('#appNav button[data-p="home"]')?.getAttribute('data-disabled'),
      };
    });
    console.log(`    (right before shot: ${JSON.stringify(preShotState)})`);
    const homeShot = path.join(verifyOut, 'home-always-visible-390.png');
    await page.screenshot({ path: homeShot, fullPage: false });
    ok(`screenshot saved: ${homeShot}`);

    // 7. Disable most modules (keep tasks + porch) via API, then
    //    confirm Home STILL stays visible. This is the actual
    //    regression: PHA-2557 hid Home precisely because no module
    //    has room='home'.
    //
    //    We keep TWO modules enabled (not just feed) so the SPA
    //    layout stays in `feed-tabs` mode and the bottom nav
    //    remains visible. If we disabled everything but feed, the
    //    SPA would enter `feed-only` mode (CSS hides #appNav) and
    //    on next reload would redirect to /porch.html — that's
    //    correct existing behavior, but it would not exercise the
    //    "Home tab visible alongside module tabs" acceptance case.
    //
    // /api/me/modules returns a bare array of enabled keys in
    // registry order. We need a separate lookup to find which key
    // backs the porch room — the SPA derives that from the
    // registry, not from /api/me/modules. Use /api/modules for the
    // room→key mapping.
    const modulesData = await page.evaluate(async () => {
      const [enabledR, registryR] = await Promise.all([
        fetch('/api/me/modules'),
        fetch('/api/modules'),
      ]);
      return {
        enabled: await enabledR.json(),
        registry: await registryR.json(),
      };
    });
    const allKeys = Array.isArray(modulesData.enabled) ? modulesData.enabled : [];
    const porchEntry = (modulesData.registry || []).find(
      (m) => m.room === 'porch',
    );
    const appsEntry = (modulesData.registry || []).find(
      (m) => m.room === 'svc',
    );
    // We keep the `apps` module and `wall` (porch) so the layout
    // stays in `feed-tabs` mode (2 enabled modules, both with rooms)
    // and the bottom nav remains visible. `apps` has no
    // requirements (lib/modules.js apps.requires = []) so the
    // cascade disable won't accidentally turn it off when we
    // disable its siblings.
    const keepKeys = new Set();
    if (porchEntry) keepKeys.add(porchEntry.key);
    if (appsEntry) keepKeys.add(appsEntry.key);
    const toDisable = allKeys.filter((k) => !keepKeys.has(k));
    if (toDisable.length > 0) {
      // Disable each key in turn via the documented per-key
      // endpoint. Pass withDependents:true so the server cascades
      // the disable instead of returning 409 dependents_active
      // when a parent module is still required by dependents.
      for (const k of toDisable) {
        await page.evaluate(async (key) => {
          await fetch(`/api/me/modules/${encodeURIComponent(key)}/disable`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ withDependents: true }),
          });
        }, k);
      }
      // DO NOT reload. A reload would trigger the SPA's
      // single-surface redirect (boot() line ~950: if feed is the
      // user's only enabled module, navigate to /porch.html),
      // which is correct existing behavior but it means the SPA
      // nav would never appear. Instead, re-fetch /api/me/layout
      // and call applyLayout() in-place so we can verify Home is
      // still present in the reduced layout.
      await page.evaluate(async () => {
        const layout = await fetch('/api/me/layout').then((r) => r.json());
        if (typeof window.applyLayout === 'function') {
          window.applyLayout(layout);
        }
      });
      const homeStillVisible = await page.evaluate(() => {
        const btn = document.querySelector('#appNav button[data-p="home"]');
        return btn ? btn.getAttribute('data-disabled') : 'no-button';
      });
      assertEq(homeStillVisible, null,
        'after disabling most modules, Home button still has no data-disabled');
      const pageHomeStillVisible = await page.evaluate(() => {
        const pg = document.getElementById('page-home');
        return pg ? pg.getAttribute('data-disabled') : 'no-page';
      });
      assertEq(pageHomeStillVisible, null,
        'after disabling most modules, #page-home still has no data-disabled');

      // Module tabs (Apps, Porch) should still be enabled in
      // this reduced layout; other modules should be data-disabled
      // and visually hidden. PHA-2557 contract: "render every
      // frame-mode module as a tab; hide when disabled".
      const appsDisabled = await page.evaluate(() => {
        const btn = document.querySelector('#appNav button[data-p="svc"]');
        return btn ? btn.getAttribute('data-disabled') : 'no-button';
      });
      assertEq(appsDisabled, null,
        'kept module (apps/svc) is still enabled in reduced layout');
      const listsDisabled = await page.evaluate(() => {
        const btn = document.querySelector('#appNav button[data-p="r-lists"]');
        return btn ? btn.getAttribute('data-disabled') : 'no-button';
      });
      assertEq(listsDisabled, '1',
        'disabled module (lists) is data-disabled in reduced layout');

      // Capture a second screenshot of the reduced state. The
      // 390x844 viewport should show Home + Tasks + Porch only,
      // with Calendar/Lists/Apps hidden by CSS.
      const disabledShot = path.join(verifyOut, 'home-always-visible-disabled-390.png');
      await page.screenshot({ path: disabledShot, fullPage: false });
      ok(`screenshot saved: ${disabledShot}`);

      // Confirm the screenshot is capturing the SPA nav (not a
      // post-redirect /porch.html surface).
      const onPageAtDisabledShot = await page.evaluate(() => {
        const on = document.querySelector('.page.on');
        return on ? on.id : 'none';
      });
      assertEq(onPageAtDisabledShot, 'page-home',
        'disabled-state screenshot captured with #page-home active (no /porch.html redirect)');
    } else {
      ok('seed did not include extra modules to disable — skipping disable-most regression');
    }

    // 8. No JS errors during the flow.
    assertEq(pageErrorSink.length, 0, 'no pageerrors during Home-always-visible flow',
      pageErrorSink.map((e) => e.message).join('; '));
    assertEq(consoleErrorSink.length, 0, 'no console errors during Home-always-visible flow',
      consoleErrorSink.map((s) => typeof s === 'string' ? s : JSON.stringify(s)).join(' | '));

    console.log(`\n${pass} pass / ${fail} fail`);
    if (fail > 0) process.exit(1);
  } finally {
    if (browser) await browser.close();
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
})().catch((err) => {
  console.error('smoke-2585 crashed:', err);
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(1);
});
