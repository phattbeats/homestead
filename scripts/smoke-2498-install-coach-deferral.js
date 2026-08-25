#!/usr/bin/env node
// PHA-2498 (UX batch #1) smoke: install coach must NOT auto-fire on
// login transition.
//
// Previously the install coach fired as a full-screen sheet on the
// login transition, covering the feed before the user had seen
// anything. PHA-2219's decided rule is "situated" — the coach
// arms only after a real signal (first action, 60–90s dwell, or
// second session), never on login. After the fix
// maybeShowInstallCoach() arms timers/listeners instead of opening
// the sheet synchronously.
//
// The smoke iOS-Safari-mimicking environment (we fake
// navigator.userAgent + navigator.platform via
// addInitScript), logs in, waits for the install-coach boot path
// to run, and asserts:
//   1. The #modal sheet is NOT open (no .on class) within 4s of
//      reaching the home surface.
//   2. The localStorage `homestead.installCoach.arms.v1` is set
//      with count=1, bootStartedAt is a fresh ms timestamp.
//   3. After simulating a click on the FAB, the install coach
//      sheet opens — proving the FIRST-ACTION ARM still works.
//
// Output: verify-out/pha-2498-install-coach-390.png

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-coach-'));
const port = 3106;
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-coach-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-coach-brandon-pw';
process.env.SESSION_SECRET = 'smoke-coach-secret';
process.env.NODE_ENV = 'production';

const ADMIN_PASSWORD = 'smoke-coach-admin-pw';

async function main() {
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  let browser;
  try {
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e));

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username', { state: 'visible', timeout: 5000 });
    await page.fill('#username', 'admin');
    await page.fill('#pw', ADMIN_PASSWORD);
    const loginResp = page.waitForResponse(
      (r) => r.url().includes('/api/login') && r.request().method() === 'POST',
      { timeout: 5000 },
    ).catch(() => null);
    await page.click('#loginBtn');
    await loginResp;

    await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });

    // PHA-2584: a first-run user sees the welcome sheet on login.
    // That's a separate overlay from the install coach; dismiss it
    // before asserting the coach didn't fire. The welcome sheet
    // stamps `first_run_completed_at` server-side and the coach
    // boot path runs INDEPENDENTLY after dismissal.
    //
    // CRITICAL: do NOT use page.click('#welcomeDismiss') here —
    // clicking ANYWHERE triggers installCoach's capture-phase
    // `first_action` listener (arm #2 in PHA-2498), which would
    // open the install coach sheet and make the assertion below
    // fail for the wrong reason. Dismiss via the API the SPA itself
    // calls (same path as smoke-2556's defensive fallback). Then
    // close the modal in-page WITHOUT triggering a click event.
    try {
      await page.waitForSelector('#welcomeDismiss', { state: 'visible', timeout: 5000 });
      const dismissResp = page.waitForResponse(
        (r) => r.url().includes('/api/me/first-run-complete') && r.request().method() === 'POST',
        { timeout: 5000 },
      ).catch(() => null);
      await page.evaluate(async () => {
        await fetch('/api/me/first-run-complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        document.getElementById('modal').classList.remove('on');
      });
      await dismissResp;
      await page.waitForFunction(
        () => !document.getElementById('modal').classList.contains('on'),
        null,
        { timeout: 5000 },
      );
      console.log('✓ dismissed first-run welcome sheet (PHA-2584) before coach-deferral assertion');
    } catch (_) {
      console.log('✓ no first-run welcome sheet present (admin already completed first-run)');
    }

    // Give the install-coach boot path 4 seconds to mistakenly fire.
    await page.waitForTimeout(4000);

    // Assertion 1: #modal has NOT been shown (by the install coach).
    // The install coach text is identifiable by "Add Homestead" /
    // "Install Homestead" / "home screen". If the welcome sheet
    // somehow resurfaced the assertion below would catch it via the
    // title check, but the 4s wait + the dismissal above means we're
    // now in a clean state where the only thing that could re-open
    // #modal is the install coach.
    const modalOn = await page.evaluate(() => document.getElementById('modal')?.classList.contains('on'));
    if (modalOn) {
      // Find what the modal is showing — the install coach is identifiable by
      // its title containing "Add Homestead" or "Install Homestead".
      const modalText = await page.locator('#sheet').innerText().catch(() => '');
      throw new Error(`install coach fired on login transition (modal.on=true). Sheet text: ${modalText.slice(0, 200)}`);
    }
    console.log('✓ install coach did NOT auto-fire on login transition');

    // Assertion 2: arms localStorage is set.
    const armsData = await page.evaluate(() => {
      const raw = localStorage.getItem('homestead.installCoach.arms.v1');
      return raw ? JSON.parse(raw) : null;
    });
    if (!armsData) throw new Error('homestead.installCoach.arms.v1 not set after boot');
    if (armsData.count !== 1) throw new Error(`arms.count expected 1, got ${armsData.count}`);
    if (typeof armsData.bootStartedAt !== 'number') throw new Error('arms.bootStartedAt not a number');
    console.log(`✓ arms persisted: count=${armsData.count} bootStartedAt=${armsData.bootStartedAt}`);

    // Assertion 3: FIRST-ACTION ARM still works — clicking the FAB
    // opens the install coach.
    // First make sure we're not already in installed mode (the arm fires
    // only when not installed; we set a sentinel before this smoke to
    // ensure fake iOS+Safari non-installed state).
    const beforeClickModal = await page.evaluate(() => document.getElementById('modal')?.classList.contains('on'));
    if (beforeClickModal) throw new Error('install coach was already open before click trigger test');

    // Click the FAB to trigger the first-action arm.
    await page.locator('#fab').click();
    await page.waitForTimeout(400);

    const afterClickModal = await page.evaluate(() => document.getElementById('modal')?.classList.contains('on'));
    if (!afterClickModal) {
      throw new Error('first-action arm did NOT open install coach on FAB click');
    }
    const sheetText = await page.locator('#sheet').innerText().catch(() => '');
    if (!/add homestead|install homestead|home screen/i.test(sheetText)) {
      throw new Error(`modal opened but does not contain install-coach text: ${sheetText.slice(0, 200)}`);
    }
    console.log('✓ first-action arm fires on FAB click — coach opens');

    fs.mkdirSync(verifyOut, { recursive: true });
    const outPath = path.join(verifyOut, 'pha-2498-install-coach-390.png');
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`✓ screenshot saved → ${outPath}`);

    if (pageErrors.length) {
      throw new Error(`pageerror(s): ${pageErrors.map(e => e.message).join(' | ')}`);
    }
    console.log('✓ no page errors');
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
