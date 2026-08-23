#!/usr/bin/env node
// Regression guard for PHA-2494: public/index.html loads plain scripts, so
// duplicate top-level lexical declarations can stop the SPA before login
// renders. A real browser is required to catch parser/runtime page errors.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-spa-'));
const port = 3102;
process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-spa-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-spa-brandon-pw';
process.env.SESSION_SECRET = 'smoke-spa-secret';
process.env.NODE_ENV = 'production';

async function main() {
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  let browser;
  try {
    // The override makes the smoke test runnable in constrained local
    // environments with a pre-provisioned browser. CI uses Playwright's
    // managed Chromium installed by the workflow below.
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error));

    const response = await page.goto(`http://127.0.0.1:${port}/`, {
      waitUntil: 'domcontentloaded',
    });
    if (!response || !response.ok()) {
      throw new Error(`SPA root returned ${response ? response.status() : 'no response'}`);
    }

    // Let deferred fetches and event handlers report errors after parsing.
    await page.waitForTimeout(250);
    if (pageErrors.length) {
      throw new Error(`browser pageerror(s): ${pageErrors.map((error) => error.stack || error.message).join('\n')}`);
    }

    console.log('✓ SPA loads in Chromium without page errors');
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
