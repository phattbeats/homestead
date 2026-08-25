#!/usr/bin/env node
// PHA-2584 acceptance smoke: fresh DB → boot → log in as brandon →
// the first-run welcome sheet is actually visible (modal gets the
// .on class) → screenshot → dismiss → POST first-run-complete →
// /api/me returns first_run:false → screenshot.
//
// The defect was: showWelcomeSheet() set $('#modal').style.display = ''
// which cleared the inline override but the CSS rule #modal{display:none}
// still won because the visible state only fires from #modal.on. Every
// other sheet goes through openSheet() → classList.add('on'). This
// smoke asserts the fix uses the same pattern.
//
// Run: node scripts/smoke-2584-first-run-welcome.js
// Output: ./verify-out/first-run-welcome-390.png
//         ./verify-out/first-run-welcome-after-dismiss-390.png
//
// No DB writes anywhere. The dismiss path goes through the same
// POST /api/me/first-run-complete endpoint the SPA calls.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2584-'));
const port = 3109;
const brandonPassword = 'smoke-2584-brandon-pw';
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-2584-admin-pw';
process.env.BRANDON_PASSWORD = brandonPassword;
process.env.SESSION_SECRET = 'smoke-2584-secret';
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

    // 1. The first-run welcome sheet must actually be visible.
    // The defect is the modal never gets the .on class, so the user
    // is dropped straight into Tasks. Assert visible here.
    await page.waitForSelector('#welcomeDismiss', { state: 'visible', timeout: 5000 });
    ok('first-run welcome sheet visible on fresh login (modal has .on)');

    // The #modal element must have the .on class — this is the actual
    // structural fix. CSS-only visibility could pass via other routes
    // (display:'' override); we want the same classList.add('on')
    // pattern every other sheet uses.
    const modalClass = await page.evaluate(() => document.getElementById('modal').className);
    assert(modalClass.includes('on'),
      '#modal.classList contains "on"', `actual class="${modalClass}"`);

    // The sheet must show the welcome copy. The screenshot below
    // captures the overlay for the durable evidence attachment.
    const sheetText = await page.evaluate(() => document.getElementById('sheet').textContent);
    assert(sheetText.includes('Welcome to Homestead'),
      'sheet contains "Welcome to Homestead" heading');

    const welcomeShot = path.join(verifyOut, 'first-run-welcome-390.png');
    await page.screenshot({ path: welcomeShot, fullPage: false });
    ok(`screenshot saved: ${welcomeShot}`);

    // 2. Click dismiss → POST /api/me/first-run-complete → sheet closes.
    const dismissResp = page.waitForResponse(
      (r) => r.url().includes('/api/me/first-run-complete') && r.request().method() === 'POST',
      { timeout: 5000 },
    ).catch(() => null);
    await page.click('#welcomeDismiss');
    const resp = await dismissResp;
    if (resp) {
      assertEq(resp.status(), 200, 'POST /api/me/first-run-complete → 200');
    } else {
      ng('POST /api/me/first-run-complete fired', 'no response observed');
    }

    // Sheet must be hidden (modal no longer has .on class).
    await page.waitForFunction(
      () => !document.getElementById('modal').classList.contains('on'),
      null,
      { timeout: 5000 },
    );
    ok('sheet closed (modal no longer has .on)');

    // /api/me must now report first_run:false.
    const me = await page.evaluate(async () => {
      const r = await fetch('/api/me');
      return await r.json();
    });
    assertEq(me.first_run, false, 'GET /api/me → first_run:false after dismiss');

    const afterShot = path.join(verifyOut, 'first-run-welcome-after-dismiss-390.png');
    await page.screenshot({ path: afterShot, fullPage: false });
    ok(`screenshot saved: ${afterShot}`);

    // 3. Re-login should NOT show the welcome sheet again (the
    // stamped first_run_completed_at means first_run stays false).
    // We can't fully re-login without logging out, but a GET /api/me
    // confirms the persisted state — the next /api/me on a fresh
    // session boot will still report first_run:false. The smoke
    // verifies the server-side stamp survives this same connection
    // (no DB churn in the smoke).
    const meAfter = await page.evaluate(async () => {
      const r = await fetch('/api/me');
      return await r.json();
    });
    assertEq(meAfter.first_run, false,
      'GET /api/me is idempotent — first_run stays false');

    // No JS errors during the flow.
    assertEq(pageErrorSink.length, 0, 'no pageerrors during first-run flow',
      pageErrorSink.map((e) => e.message).join('; '));
    assertEq(consoleErrorSink.length, 0, 'no console errors during first-run flow',
      consoleErrorSink.join('; '));

    console.log(`\n${pass} pass / ${fail} fail`);
    if (fail > 0) process.exit(1);
  } finally {
    if (browser) await browser.close();
    server.close();
    // Best-effort tmp cleanup; ignore failures (the dir is in os.tmpdir).
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
})().catch((err) => {
  console.error('smoke-2584 crashed:', err);
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(1);
});
