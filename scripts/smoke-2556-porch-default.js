#!/usr/bin/env node
// PHA-2556 acceptance smoke: fresh DB → boot → log in as brandon →
// tap Porch → wall opens with composer → post lands. Screenshot
// required, no DB edits anywhere in the test.
//
// PHA-2493 closed green with a smoke test that open-coded an
// `INSERT INTO user_groups` to grant brandon media-club membership,
// then asserted the wall was visible. That bypassed exactly the
// defect PHA-2556 is fixing. This smoke uses NO direct DB writes —
// the only mutations are POSTs to /api/* endpoints the product ships
// with. If the seeded wall isn't visible after a fresh boot, this
// smoke fails the same way a real user would experience it.
//
// Run: node scripts/smoke-2556-porch-default.js
// Output: ./verify-out/porch-default-390.png
//         ./verify-out/porch-default-after-post-390.png

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2556-'));
const port = 3107;
const brandonPassword = 'smoke-2556-brandon-pw';
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-2556-admin-pw';
process.env.BRANDON_PASSWORD = brandonPassword;
process.env.SESSION_SECRET = 'smoke-2556-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
  else ng(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

(async () => {
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  // Wait for /api/health.
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
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const root = await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    if (!root || !root.ok()) {
      throw new Error(`SPA root returned ${root ? root.status() : 'no response'}`);
    }

    // Login as brandon.
    await page.waitForSelector('#username', { state: 'visible', timeout: 5000 });
    await page.fill('#username', 'brandon');
    await page.fill('#pw', brandonPassword);
    const loginResp = page.waitForResponse(
      (r) => r.url().includes('/api/login') && r.request().method() === 'POST',
      { timeout: 5000 },
    ).catch(() => null);
    await page.click('#loginBtn');
    await loginResp;

    await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });
    ok('login as brandon → #app visible');

    // Dismiss the first-run welcome sheet if it appears (the API
    // call to GET /api/walls still works behind the overlay; the sheet
    // just blocks clicks on the nav). This is part of the user flow:
    // every brand-new user sees it once.
    try {
      await page.waitForSelector('#welcomeDismiss', { state: 'visible', timeout: 5000 });
      await page.click('#welcomeDismiss');
      ok('dismissed first-run welcome sheet');
    } catch (_) {
      // The first-run sheet was rendered into #sheet but #modal is
      // hidden (display:none). Dismiss via the public POST endpoint
      // (no DB write — this is the API the UI itself calls when the
      // user taps the dismiss button).
      try {
        await page.evaluate(async () => {
          await fetch('/api/me/first-run-complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        });
        ok('POST /api/me/first-run-complete (sheet was modal-hidden)');
      } catch (_) {
        ok('first-run sheet not shown — proceeding');
      }
    }

    // Sanity: GET /api/walls must include the seeded household wall.
    const wallsRes = await page.evaluate(async () => {
      const r = await fetch('/api/walls');
      return { status: r.status, body: await r.json() };
    });
    assertEq(wallsRes.status, 200, 'GET /api/walls returns 200');
    assert(wallsRes.body.walls.some((w) => w.slug === 'household'),
      'fresh-install GET /api/walls lists household (no DB writes)');
    assertEq(wallsRes.body.walls.length, 1, 'no extra walls leak through on a fresh install');

    // Open the Porch tab.
    // After the fresh-install boot, the wall module is on (lib/modules.js
    // sets default_enabled=true for `wall`). The in-place #navWall
    // button (#page-porch mount) is shown, OR the SPA redirects to
    // /porch.html if wall is the user's only enabled module. Try the
    // in-place nav first; fall back to /porch.html.
    let navMode = 'unknown';
    try {
      await page.waitForSelector('#navWall', { state: 'visible', timeout: 5000 });
      await page.click('#navWall');
      navMode = 'in-place';
    } catch (_) {
      await page.goto(`http://127.0.0.1:${port}/porch.html`, { waitUntil: 'domcontentloaded' });
      navMode = 'standalone';
    }
    console.log(`  nav mode: ${navMode}`);

    // Wait for the feed component to render the composer.
    try {
      await page.waitForSelector(
        '#textBody',
        { state: 'visible', timeout: 10000 },
      );
      ok('Porch tab opens with composer visible');
    } catch (_) {
      const post = await page.evaluate(() => ({
        pagePorchClass: document.getElementById('page-porch') ? document.getElementById('page-porch').className : 'missing',
        pagePorchOn: document.getElementById('page-porch') ? document.getElementById('page-porch').classList.contains('on') : false,
        textBodyExists: !!document.getElementById('textBody'),
        feedMounted: !!(document.getElementById('page-porch') && document.getElementById('page-porch').dataset.mounted),
        mountHtml: (document.getElementById('page-porch') || {}).innerHTML ? document.getElementById('page-porch').innerHTML.slice(0, 300) : '',
      }));
      console.log('  post-click debug:', JSON.stringify(post));
      throw new Error('Porch composer did not appear after clicking #navWall');
    }

    // Screenshot #1: Porch open, empty composer.
    const screenshot1 = path.join(verifyOut, 'porch-default-390.png');
    await page.screenshot({ path: screenshot1, fullPage: false });
    ok(`screenshot saved: ${path.relative(process.cwd(), screenshot1)}`);

    // Type a post and submit it. The composer DOM is owned by
    // public/components/feed.js — #textBody textarea, #postText
    // button (id only present when canPost=true).
    await page.fill('#textBody', 'hello porch');
    const submitted = await page.evaluate(() => {
      const btn = document.querySelector('#postText');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!submitted) {
      throw new Error('composer submit button (#postText) not found');
    }
    // Wait for the post to land in the feed (the new post body text
    // shows up somewhere under the feed).
    await page.waitForFunction(
      () => {
        const mount = document.querySelector('#porch-mount, #page-porch') || document.body;
        return mount && /hello porch/.test(mount.textContent || '');
      },
      { timeout: 5000 },
    );
    ok('post lands in the feed');

    // Screenshot #2: Porch with the post visible.
    const screenshot2 = path.join(verifyOut, 'porch-default-after-post-390.png');
    await page.screenshot({ path: screenshot2, fullPage: false });
    ok(`screenshot saved: ${path.relative(process.cwd(), screenshot2)}`);

    if (pageErrors.length > 0) {
      ng(`unexpected pageerrors during the run: ${pageErrors.map((e) => e.message).join('; ')}`);
    } else {
      ok('no pageerrors during the run');
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});