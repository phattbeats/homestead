#!/usr/bin/env node
// PHA-2498 (UX batch #2) smoke: FAB pileup must be resolved.
//
// Previously two competing circular buttons lived in the bottom-right
// corner (#fab and #drawerFab). On a 390px screen they stacked on top
// of each other and obscured content cards. The fix docked the
// drawerFab INTO THE HEADER next to the avatar; the bottom-right corner
// now belongs to #fab alone.
//
// The smoke logs in, navigates to Home, captures the layout, and
// asserts:
//   1. #drawerFab is positioned in the header (y < 200px), not the
//      bottom-right.
//   2. #fab is visible AND in the bottom-right quadrant (only one).
//   3. On the Tasks tab, the same structure holds.
//   4. No console errors / no page errors.
//
// Output: verify-out/pha-2498-fab-pileup-390.png

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-fab-'));
const port = 3105;
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-fab-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-fab-brandon-pw';
process.env.SESSION_SECRET = 'smoke-fab-secret';
process.env.NODE_ENV = 'production';

const ADMIN_PASSWORD = 'smoke-fab-admin-pw';

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
    await page.waitForTimeout(400);

    // Assertion 1: #drawerFab y < 200 (header zone).
    const drawerFabBox = await page.locator('#drawerFab').boundingBox();
    if (!drawerFabBox) {
      throw new Error('#drawerFab has no bounding box — element missing from post-login DOM');
    }
    if (drawerFabBox.y >= 200) {
      throw new Error(`drawerFab is NOT in the header (y=${drawerFabBox.y}) — still in the FAB stack`);
    }
    console.log(`✓ drawerFab docked into header at y=${drawerFabBox.y} h=${drawerFabBox.height}`);

    // Assertion 2: #fab is visible in bottom-right quadrant (only one).
    const fabVisible = await page.locator('#fab').isVisible();
    if (!fabVisible) throw new Error('#fab is not visible on Home after login');
    const fabBox = await page.locator('#fab').boundingBox();
    if (!(fabBox.x > 200 && fabBox.y > 500)) {
      throw new Error(`#fab is not in the bottom-right quadrant (x=${fabBox.x}, y=${fabBox.y})`);
    }
    console.log(`✓ #fab alone in bottom-right at x=${fabBox.x} y=${fabBox.y}`);

    // Assertion 3: Tasks tab — same structure.
    await page.click('button[data-p="tasks"]');
    await page.waitForTimeout(300);
    const tasksDrawerFabBox = await page.locator('#drawerFab').boundingBox();
    if (!tasksDrawerFabBox || tasksDrawerFabBox.y >= 200) {
      throw new Error(`on Tasks tab, drawerFab is NOT in header (y=${tasksDrawerFabBox && tasksDrawerFabBox.y})`);
    }
    console.log('✓ Tasks tab also has drawerFab docked in the header');

    fs.mkdirSync(verifyOut, { recursive: true });
    const outPath = path.join(verifyOut, 'pha-2498-fab-pileup-390.png');
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`✓ screenshot saved → ${outPath}`);

    if (pageErrors.length) {
      throw new Error(`pageerror(s): ${pageErrors.map(e => e.message).join(' | ')}`);
    }
    if (consoleErrors.length) {
      const blocking = consoleErrors.filter(e => !/cdn/i.test(e));
      if (blocking.length) throw new Error(`console error(s): ${blocking.join(' | ')}`);
    }
    console.log('✓ no page errors, no blocking console errors');
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
