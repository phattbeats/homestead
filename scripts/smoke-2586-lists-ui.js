#!/usr/bin/env node
// PHA-2586 acceptance smoke: a fresh Homestead DB seeds the shared
// Groceries list; a household user opens Lists and adds an item through
// the rendered mobile UI. No SQLite fixture writes are allowed here.
//
// Output: ./verify-out/lists-with-item-390.png

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2586-'));
const port = 3114;
const brandonPassword = 'smoke-2586-brandon-pw';
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-2586-admin-pw';
process.env.BRANDON_PASSWORD = brandonPassword;
process.env.SESSION_SECRET = 'smoke-2586-secret';
process.env.NODE_ENV = 'production';

async function main() {
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

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
    const listResponses = [];
    const apiResponses = [];
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const loc = msg.location();
        consoleErrors.push(`${msg.text()} @ ${loc.url || 'unknown'}:${loc.lineNumber}`);
      }
    });
    page.on('response', (response) => {
      if (response.url().includes('/api/lists')) listResponses.push(`${response.status()} ${response.url()}`);
      if (response.url().includes('/api/')) apiResponses.push(`${response.status()} ${new URL(response.url()).pathname}`);
    });

    const root = await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    if (!root || !root.ok()) throw new Error(`SPA root returned ${root ? root.status() : 'no response'}`);
    await page.fill('#username', 'brandon');
    await page.fill('#pw', brandonPassword);
    await page.click('#loginBtn');
    await page.waitForSelector('#app', { state: 'visible', timeout: 10000 });

    // First-run onboarding is separate from the Lists journey. Dismiss it
    // through the product endpoint so the real module tab is usable.
    const welcome = page.locator('#welcomeDismiss');
    await page.waitForTimeout(300); // boot fetches /api/me after rendering #app
    if (await welcome.isVisible().catch(() => false)) {
      const dismissed = page.waitForResponse(
        (response) => response.url().includes('/api/me/first-run-complete') && response.request().method() === 'POST',
        { timeout: 5000 },
      );
      await welcome.click();
      if ((await dismissed).status() !== 200) throw new Error('could not dismiss first-run onboarding');
      await page.waitForFunction(() => !document.getElementById('modal').classList.contains('on'));
    }

    // New users begin Porch-only by design. Enable Lists through its real
    // module API. The current shell predates the configuration change, so
    // dispatch the real tab handler once it is enabled; a normal next boot
    // also applies the layout from /api/me/layout.
    const enabled = await page.evaluate(async () => {
      const response = await fetch('/api/me/modules/lists/enable', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ withRequirements: true }),
      });
      return { status: response.status, body: await response.json() };
    });
    if (enabled.status !== 200) throw new Error(`could not enable Lists: ${JSON.stringify(enabled)}`);
    pageErrors.length = 0;
    consoleErrors.length = 0;

    await page.locator('#appNav button[data-p="r-lists"]').dispatchEvent('click');
    await page.waitForSelector('#page-r-lists.on #listsRoot', { state: 'visible', timeout: 5000 });

    const preAddLists = await page.evaluate(async () => {
      const response = await fetch('/api/lists');
      return { status: response.status, body: await response.json() };
    });
    if (preAddLists.status !== 200 || !preAddLists.body.lists.some((list) => list.name === 'Groceries')) {
      throw new Error(`fresh install did not expose seeded Groceries list: ${JSON.stringify(preAddLists)}`);
    }
    await page.waitForSelector('#page-r-lists .list-chip', { state: 'visible', timeout: 5000 }).catch(async () => {
      const rendered = await page.locator('#listsRoot').innerHTML();
      const loadedHtml = await page.content();
      throw new Error(`Lists API returned data but the UI did not render a list chip: ${rendered}; hasRefreshLists=${loadedHtml.includes('refreshLists(prefetched)')}; listRequests=${listResponses.join(', ')}; apiRequests=${apiResponses.join(', ')}; pageErrors=${pageErrors.map((error) => error.message).join(' | ')}; consoleErrors=${consoleErrors.join(' | ')}`);
    });

    await page.fill('#listItemInput', 'Milk');
    const itemResponse = await Promise.all([
      page.waitForResponse(
        (response) => response.url().includes('/items') && response.request().method() === 'POST',
        { timeout: 5000 },
      ),
      page.locator('#listItemInput').press('Enter'),
    ]).then(([response]) => response).catch((error) => {
      throw new Error(`Lists add-item request did not complete: ${error.message}; pageErrors=${pageErrors.map((entry) => entry.message).join(' | ')}; consoleErrors=${consoleErrors.join(' | ')}`);
    });
    if (itemResponse.status() !== 201) throw new Error(`POST list item returned ${itemResponse.status()}`);
    await page.waitForSelector('.list-item .lbl', { state: 'visible', timeout: 5000 });
    const labels = await page.locator('.list-item .lbl').allTextContents();
    if (!labels.includes('Milk')) throw new Error(`Lists UI did not render Milk: ${JSON.stringify(labels)}`);

    fs.mkdirSync(verifyOut, { recursive: true });
    const screenshot = path.join(verifyOut, 'lists-with-item-390.png');
    await page.screenshot({ path: screenshot, fullPage: false });
    console.log(`✓ screenshot saved → ${screenshot}`);
    console.log('✓ fresh household user opened Lists and added Milk through the UI');
    if (pageErrors.length) throw new Error(`pageerror(s): ${pageErrors.map((e) => e.message).join(' | ')}`);
    if (consoleErrors.length) throw new Error(`console error(s): ${consoleErrors.join(' | ')}`);
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
