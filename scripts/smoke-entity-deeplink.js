#!/usr/bin/env node
// PHA-2658 — entity deep links are an explicit SPA route.
//
// Proves the complete refresh/cold-start path: Express serves index.html for
// /entity/:id, the authenticated SPA restores that location on boot, and an
// unrelated missing .html route remains a genuine 404.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium, request } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-entity-deeplink-'));
const port = 3197;
const baseUrl = `http://127.0.0.1:${port}`;
const outDir = path.join(__dirname, '..', 'verify-out');
fs.mkdirSync(outDir, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'entity-deeplink-admin-pw';
process.env.BRANDON_PASSWORD = 'entity-deeplink-brandon-pw';
process.env.SESSION_SECRET = 'entity-deeplink-secret';
process.env.NODE_ENV = 'production';

const headers = {
  'x-authentik-username': 'brandon',
  'x-authentik-groups': 'household',
};

async function main() {
  // The documented Dune walkthrough is the product's canonical fresh-DB
  // entity fixture. Seed before server boot so the route renders real data.
  execFileSync(process.execPath, [path.join(__dirname, 'seed-dune.js')], {
    env: process.env,
    stdio: 'inherit',
  });
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  let browser;
  try {
    const shell = await fetch(`${baseUrl}/entity/anything`);
    const shellText = await shell.text();
    if (shell.status !== 200 || !shellText.includes('<div id="entityPage"')) {
      throw new Error(`/entity/anything must return the SPA shell (got ${shell.status})`);
    }
    const missingHtml = await fetch(`${baseUrl}/lists.html`);
    if (missingHtml.status !== 404) {
      throw new Error(`/lists.html must remain 404 (got ${missingHtml.status})`);
    }

    const reqCtx = await request.newContext({ baseURL: baseUrl, extraHTTPHeaders: headers });
    await reqCtx.get('/api/me');
    const storageState = await reqCtx.storageState();
    await reqCtx.dispose();

    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
      isMobile: true, hasTouch: true, storageState,
    });
    const page = await context.newPage();
    const response = await page.goto(`${baseUrl}/entity/ent_concept_dune`, { waitUntil: 'load' });
    if (!response || response.status() !== 200) throw new Error('entity deep link did not return 200');
    await page.waitForFunction(() => {
      const heading = document.querySelector('#entBody h1');
      return heading && heading.textContent.includes('Dune franchise');
    }, { timeout: 5000 });
    await page.screenshot({ path: path.join(outDir, 'entity-deeplink-refresh-390.png'), fullPage: false });
    console.log('✓ entity deep link shell, route restore, and 404 guard verified');
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
