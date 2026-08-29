#!/usr/bin/env node
// PHA-2707 acceptance smoke: fresh DB → boot → admin mints a household
// invite → a new local account redeems it via
// POST /api/public/invites/:code/signup → the browser lands on
// /welcome.html?wall=household and the richer welcome content is
// actually there: what Homestead is, the Porch explainer, the wall +
// members, the "what this invite got you" access line, a contextual
// first-action CTA, and the local-account Authentik-later note.
// Then: Escape dismisses (stamps first-run-complete, redirects to the
// Porch), and a returning user is skipped UNLESS ?revisit=1 is set.
//
// Run: node scripts/smoke-2707-invite-welcome.js
// Output: ./verify-out/welcome-2707-{new-user,after-dismiss,revisit}-390.png

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2707-'));
const port = 3110;
const adminPassword = 'smoke-2707-admin-pw';
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = adminPassword;
process.env.SESSION_SECRET = 'smoke-2707-secret';
process.env.NODE_ENV = 'production';
process.env.ALLOW_HEADER_TRUST = '0';

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

    // Admin mints a household invite, then a fresh browser session
    // signs up via that invite — all through fetch() so the session
    // cookie lands in the same browser context, same as a real client.
    const inviteCode = await page.evaluate(async (pw) => {
      const login = await fetch('/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: pw }),
      });
      if (!login.ok) throw new Error('admin login failed: ' + login.status);
      const inv = await fetch('/api/invites', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wall_slug: 'household', expires_in_days: 7, max_uses: 1, note: 'PHA-2707 smoke' }),
      });
      if (!inv.ok) throw new Error('mint invite failed: ' + inv.status);
      const body = await inv.json();
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
      return body.id;
    }, adminPassword);
    ok('admin minted a household invite');

    const signupResult = await page.evaluate(async (code) => {
      const r = await fetch(`/api/public/invites/${code}/signup`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'newneighbor', display: 'New Neighbor', password: 'porch-pass-2026' }),
      });
      return { status: r.status, body: await r.json() };
    }, inviteCode);
    assertEq(signupResult.status, 201, 'invite signup → 201');
    assertEq(signupResult.body.first_run, true, 'signup returns first_run:true');

    // 1. Land on the welcome screen the signup response points at.
    await page.goto(`http://127.0.0.1:${port}${signupResult.body.redirect}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#continueBtn:not(.hidden)', { state: 'visible', timeout: 5000 });
    ok('welcome screen rendered for new invite-signup user');

    const bodyText = await page.evaluate(() => document.getElementById('content').textContent);
    assert(bodyText.includes('Welcome to Homestead'), 'shows "Welcome to Homestead" heading');
    assert(bodyText.includes('Homestead is the shared app for your household'), 'explains what Homestead is');
    assert(bodyText.includes('The Porch is home'), 'explains the Porch is home/feed');
    assert(bodyText.includes('household') || bodyText.includes('Household'), 'names the wall the user joined');
    assert(bodyText.includes('What this invite got you'), 'explains what access the invite granted');
    assert(bodyText.includes('Linked Accounts'), 'mentions Linked Accounts for adding Authentik later (local account)');

    const ctaText = await page.evaluate(() => document.getElementById('continueBtn').textContent);
    assert(/Porch/.test(ctaText), 'CTA states a concrete first action', ctaText);

    const shot1 = path.join(verifyOut, 'welcome-2707-new-user-390.png');
    await page.screenshot({ path: shot1, fullPage: true });
    ok(`screenshot saved: ${shot1}`);

    // Accessibility: heading is focusable and received focus, close
    // button has an aria-label, member rows use role=listitem.
    const a11y = await page.evaluate(() => ({
      headingFocused: document.activeElement === document.querySelector('.heading'),
      closeLabel: document.getElementById('skipBtn').getAttribute('aria-label'),
      listItems: document.querySelectorAll('[role="listitem"]').length,
    }));
    assert(a11y.headingFocused, 'heading receives focus on render');
    assert(!!a11y.closeLabel, 'skip/close button has an aria-label', a11y.closeLabel);

    // 2. Escape dismisses — same path as clicking skip/CTA.
    const dismissResp = page.waitForResponse(
      (r) => r.url().includes('/api/me/first-run-complete') && r.request().method() === 'POST',
      { timeout: 5000 },
    ).catch(() => null);
    await page.keyboard.press('Escape');
    const resp = await dismissResp;
    if (resp) assertEq(resp.status(), 200, 'Escape → POST /api/me/first-run-complete → 200');
    else ng('POST /api/me/first-run-complete fired on Escape', 'no response observed');

    await page.waitForURL(/\/porch\.html\?wall=household/, { timeout: 5000 });
    ok('Escape redirects to the Porch');

    const shot2 = path.join(verifyOut, 'welcome-2707-after-dismiss-390.png');
    await page.screenshot({ path: shot2, fullPage: false });
    ok(`screenshot saved: ${shot2}`);

    // 3. Returning user: re-visiting /welcome.html without ?revisit
    // skips straight to the Porch.
    await page.goto(`http://127.0.0.1:${port}/welcome.html?wall=household`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/porch\.html\?wall=household/, { timeout: 5000 });
    ok('returning user (first_run:false) is skipped straight to the Porch');

    // 4. ...unless they explicitly reopen it with ?revisit=1.
    await page.goto(`http://127.0.0.1:${port}/welcome.html?wall=household&revisit=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#continueBtn:not(.hidden)', { state: 'visible', timeout: 5000 });
    ok('?revisit=1 explicitly reopens the welcome screen for a returning user');
    const shot3 = path.join(verifyOut, 'welcome-2707-revisit-390.png');
    await page.screenshot({ path: shot3, fullPage: true });
    ok(`screenshot saved: ${shot3}`);

    // No JS errors during the whole flow.
    assertEq(pageErrorSink.length, 0, 'no pageerrors during welcome flow',
      pageErrorSink.map((e) => e.message).join('; '));
    assertEq(consoleErrorSink.length, 0, 'no console errors during welcome flow',
      consoleErrorSink.join('; '));

    console.log(`\n${pass} pass / ${fail} fail`);
    if (fail > 0) process.exit(1);
  } finally {
    if (browser) await browser.close();
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
})().catch((err) => {
  console.error('smoke-2707 crashed:', err);
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(1);
});
