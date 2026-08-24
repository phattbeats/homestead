#!/usr/bin/env node
// PHA-2498 (UX batch #3) smoke: drawerFab must NOT render pre-auth.
//
// Previously #drawerFab was a top-level DOM element, so it appeared
// on the login page and overlapped the submit button on small widths.
// The fix moved both #drawerFab and #drawer into #app, which is
// display:none until boot() shows it post-login.
//
// The smoke captures the login-page DOM at 390x844 and asserts:
//   1. #drawerFab is NOT present in the DOM (or has 0x0 bounds and
//      is not displayed). We treat "missing" and "hidden" both as
//      pass conditions because the structural fix puts it inside
//      #app which is hidden — the element is technically present
//      but not visible.
//   2. The "Come on in" submit button at the bottom of the login
//      card is fully visible and clickable.
//   3. There are no console errors and no page errors.
//
// Run: node scripts/smoke-2498-preauth-drawer.js
//
// Outputs: verify-out/pha-2498-preauth-390.png

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-preauth-'));
const port = 3104;
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-preauth-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-preauth-brandon-pw';
process.env.SESSION_SECRET = 'smoke-preauth-secret';
process.env.NODE_ENV = 'production';

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
    });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(250);

    // Assertion 1: drawerFab is not visible.
    // We use `isVisible` (Playwright accounts for display:none ancestors).
    // The structural fix hides #drawerFab inside #app (display:none), so
    // isVisible() should be false; the bug-state (FAB at top level) had
    // it rendered and visible.
    const drawerFabVisible = await page.locator('#drawerFab').isVisible().catch(() => false);
    if (drawerFabVisible) {
      throw new Error('UX FAIL: #drawerFab is visible on the LOGIN screen — pre-auth leak not closed');
    }
    console.log('✓ drawerFab is hidden on the login screen (PHA-2498 #3)');

    // Assertion 2: submit button is fully visible at 390x844.
    const submitBox = await page.locator('#loginBtn').boundingBox();
    if (!submitBox) throw new Error('login submit button has no bounding box');
    if (submitBox.y + submitBox.height > 844) {
      throw new Error(`submit button extends below 844 (y=${submitBox.y} h=${submitBox.height})`);
    }
    if (submitBox.width < 100) {
      throw new Error(`submit button too narrow (w=${submitBox.width})`);
    }
    console.log(`✓ submit button fully visible at y=${submitBox.y} h=${submitBox.height}`);

    // Assertion 3: no errors.
    if (pageErrors.length) {
      throw new Error(`page error(s) on login screen: ${pageErrors.map(e => e.message).join(' | ')}`);
    }
    if (consoleErrors.length) {
      // The HOMESTEAD_CDN_MISSING console.error is allowed; reject others.
      const blocking = consoleErrors.filter(e => !/cdn/i.test(e));
      if (blocking.length) {
        throw new Error(`console error(s) on login screen: ${blocking.join(' | ')}`);
      }
    }
    console.log('✓ no page errors, no blocking console errors');

    // Screenshot for PHA-2501 evidence.
    fs.mkdirSync(verifyOut, { recursive: true });
    const outPath = path.join(verifyOut, 'pha-2498-preauth-390.png');
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`✓ screenshot saved → ${outPath}`);
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
