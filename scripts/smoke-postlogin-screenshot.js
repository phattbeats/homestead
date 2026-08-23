#!/usr/bin/env node
// PHA-2501 standing policy enforcement smoke — Definition of Done guard.
//
// Per Brandon's 2026-08-23 directive, every UI-touching issue must ship with
// a 390px-class mobile-viewport screenshot of the actual rendered result
// captured from a REAL running instance. This smoke test is the
// mechanical witness: it boots server.js on an ephemeral port, logs in as
// the seeded admin user, captures a 390x844 screenshot of the post-login
// home surface, and fails the build on ANY pageerror or console error.
//
// Output:
//   ./verify-out/postlogin-390.png         (Playwright mobile-viewport screenshot)
//
// Run: node scripts/smoke-postlogin-screenshot.js

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-postlogin-'));
const port = 3103;
const adminPassword = 'smoke-postlogin-admin-pw';
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = adminPassword;
process.env.BRANDON_PASSWORD = 'smoke-postlogin-brandon-pw';
process.env.SESSION_SECRET = 'smoke-postlogin-secret';
process.env.NODE_ENV = 'production';

async function main() {
  // Use the in-repo playwright dependency's bundled chromium when the
  // operator has installed it via `npx playwright install`. CI runs
  // `npx playwright install --with-deps chromium` as part of .github/workflows/test.yml.
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

  // Boot the real Homestead server. Same import path the production Dockerfile uses.
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  // Wait for /api/health to confirm full boot.
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
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const root = await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: 'domcontentloaded',
    });
    if (!root || !root.ok()) {
      throw new Error(`SPA root returned ${root ? root.status() : 'no response'}`);
    }

    // Log in as admin. The LAN fallback /api/login (PHA-1574) seeds admin
    // on first boot from ADMIN_PASSWORD.
    await page.waitForSelector('#username', { state: 'visible', timeout: 5000 });
    await page.fill('#username', 'admin');
    await page.fill('#pw', adminPassword);
    const loginResponse = page.waitForResponse(
      (r) => r.url().includes('/api/login') && r.request().method() === 'POST',
      { timeout: 5000 },
    ).catch(() => null);
    await page.click('#loginBtn');
    await loginResponse;

    // Wait for the app shell to render (#app becomes visible).
    await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(400); // settle post-login fetches

    fs.mkdirSync(verifyOut, { recursive: true });
    const outPath = path.join(verifyOut, 'postlogin-390.png');
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`✓ screenshot saved → ${outPath}`);

    if (pageErrors.length) {
      throw new Error(`browser pageerror(s) on post-login render: ${pageErrors.map((e) => e.stack || e.message).join('\n')}`);
    }
    if (consoleErrors.length) {
      throw new Error(`browser console error(s) on post-login render: ${consoleErrors.join(' | ')}`);
    }
    console.log('✓ post-login render at 390x844: no pageerrors, no console errors');
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