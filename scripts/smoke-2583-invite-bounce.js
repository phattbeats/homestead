#!/usr/bin/env node
// PHA-2583 acceptance smoke: unauthenticated visitor opens /invite/{code}
// and lands on the Homestead login form (not a JSON 404). After signing
// in they bounce back to /invite/{code} and the wall-card renders.
//
// Boots server.js on an ephemeral port with the seed admin / brandon
// profiles. Walks:
//   1. curl GET /invite/<not-yet-existent> -> 200 HTML (the page itself
//      loads even before the API has the code; the page will then call
//      GET /api/me and bounce to /?next=/invite/<code>).
//   2. Browser at 390x844: open /invite/DEADBEEF, watch the URL settle
//      at /?next=/invite/DEADBEEF, fill the login form as admin, click
//      "Come on in", watch the URL land on /invite/DEADBEEF again.
//   3. The redeem button + error card renders as expected for the
//      unknown-code case (we don't mint a real invite here — the goal
//      is the bounce, not the redeem).
//
// Output: ./verify-out/invite-bounce-390-before-login.png
//         ./verify-out/invite-bounce-390-after-login.png
//
// Run: node scripts/smoke-2583-invite-bounce.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2583-'));
const port = 3108;
const adminPassword = 'smoke-2583-admin-pw';
const brandonPassword = 'smoke-2583-brandon-pw';
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = adminPassword;
process.env.BRANDON_PASSWORD = brandonPassword;
process.env.SESSION_SECRET = 'smoke-2583-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

async function waitForHealth(port) {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch (_) { /* boot in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`server on :${port} never became healthy`);
}

(async () => {
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  try {
    await waitForHealth(port);

    // ---- 1. curl transcripts --------------------------------------------------
    // GET /invite/<code> must serve HTML (the invite page), not JSON.
    const fakeCode = 'DEADBEEFCAFE0000';
    const inviteRes = await fetch(`http://127.0.0.1:${port}/invite/${fakeCode}`, {
      redirect: 'manual',
    });
    const inviteCT = inviteRes.headers.get('content-type') || '';
    const inviteBody = await inviteRes.text();
    assertEq(inviteRes.status, 200, 'GET /invite/<code> returns 200');
    assert(/text\/html/.test(inviteCT), `GET /invite/<code> serves HTML (got ${inviteCT})`);
    assert(/<title>.*invite/i.test(inviteBody) || /Join a wall/i.test(inviteBody),
      'GET /invite/<code> body contains the invite page chrome');
    // PHA-2583: BEFORE the fix this was JSON {error:not_found}. Now it
    // must be HTML.
    assert(!/^\s*\{/.test(inviteBody.trim()),
      'GET /invite/<code> body is NOT a JSON 404');

    // GET /api/login must 302 to / with the next param preserved.
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/login?next=/invite/${fakeCode}`, {
      redirect: 'manual',
    });
    const loginLoc = loginRes.headers.get('location') || '';
    assertEq(loginRes.status, 302, 'GET /api/login?next=... returns 302');
    assert(/\/\?next=/.test(loginLoc),
      `GET /api/login Location points at /?next= (got "${loginLoc}")`);
    assert(loginLoc.includes(encodeURIComponent(`/invite/${fakeCode}`)),
      `GET /api/login Location preserves next=/invite/<code> (got "${loginLoc}")`);

    // PHA-2583 open-redirect hardening: an off-origin next must be stripped.
    const evilRes = await fetch(`http://127.0.0.1:${port}/api/login?next=//evil.example.com/`, {
      redirect: 'manual',
    });
    const evilLoc = evilRes.headers.get('location') || '';
    assertEq(evilRes.status, 302, 'GET /api/login?next=//evil returns 302');
    assert(evilLoc === '/?next=%2F' || evilLoc === '/?next=%2F',
      `GET /api/login rejects //evil next, falls back to / (got "${evilLoc}")`);

    // ---- 2. Browser walk -----------------------------------------------------
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
      const consoleUrls = [];
      page.on('pageerror', (error) => pageErrors.push(error));
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          consoleErrors.push(msg.text());
          // Try to capture the URL too via the location() if available
          try {
            const loc = msg.location();
            if (loc && loc.url) consoleUrls.push(`${msg.text()} @ ${loc.url}`);
          } catch (_) {}
        }
      });
      page.on('requestfailed', (req) => consoleUrls.push(`requestfailed: ${req.url()} — ${req.failure()?.errorText}`));
      page.on('response', (res) => {
        if (res.status() === 404) consoleUrls.push(`404: ${res.url()}`);
      });

      // Open the invite URL while logged out. The page will fetch
      // /api/me (returns user:null), then location.replace to /?next=/invite/<code>.
      // Wait for the login form to render.
      await page.goto(`http://127.0.0.1:${port}/invite/${fakeCode}`, {
        waitUntil: 'networkidle',
      });
      // We should have been bounced to /?next=/invite/DEADBEEFCAFE0000.
      const urlAfterBounce = new URL(page.url());
      assert(urlAfterBounce.pathname === '/',
        `bounced from /invite/<code> to / (got "${urlAfterBounce.pathname}")`);
      assert(urlAfterBounce.searchParams.get('next') === `/invite/${fakeCode}`,
        `bounce preserved ?next=/invite/<code> (got next="${urlAfterBounce.searchParams.get('next')}")`);
      // Login form must be visible.
      await page.waitForSelector('#loginBtn', { state: 'visible', timeout: 5000 });
      ok('login form rendered after bounce');
      // Confirm we are NOT staring at raw JSON (the bug).
      const bodyText = (await page.textContent('body')) || '';
      assert(!bodyText.trim().startsWith('{'),
        'body content is NOT a JSON object (regression: was raw {error:...})');

      await page.screenshot({
        path: path.join(verifyOut, 'invite-bounce-390-before-login.png'),
        fullPage: true,
      });

      // Log in as admin (seeded).
      await page.fill('#username', 'admin');
      await page.fill('#pw', adminPassword);
      await page.click('#loginBtn');

      // After successful login the SPA reads ?next= and location.replaces
      // back to /invite/<code>. Wait for the URL to settle.
      await page.waitForURL((url) => {
        const u = new URL(url);
        return u.pathname === `/invite/${fakeCode}`;
      }, { timeout: 5000 });
      const urlAfterLogin = new URL(page.url());
      assert(urlAfterLogin.pathname === `/invite/${fakeCode}`,
        `after login URL bounced to /invite/<code> (got "${urlAfterLogin.pathname}")`);
      // The invite page must have rendered (loading, error, or redeem CTA).
      // The fake code is unknown to the DB so we expect the error card.
      await page.waitForSelector('#content', { state: 'visible', timeout: 5000 });
      const contentText = (await page.textContent('#content')) || '';
      assert(/loading|invalid|wall|invite/i.test(contentText),
        `invite page rendered content (got "${contentText.slice(0, 80).replace(/\s+/g,' ').trim()}")`);

      await page.screenshot({
        path: path.join(verifyOut, 'invite-bounce-390-after-login.png'),
        fullPage: true,
      });

      // No console / page errors during the journey.
      if (pageErrors.length) ng('browser pageerrors', pageErrors.map((e) => e.message).join('; '));
      else ok('no browser pageerrors');
      // Filter the 404s that are expected (the invite code is fake — we
      // know /api/invites/DEADBEEFCAFE0000 will 404 inside invite.html
      // when the JS tries to look up the code). The bounce-back is the
      // bug; everything else is noise.
      const unexpectedConsoleErrors = consoleErrors.filter((e) =>
        !/status of 404/i.test(e) && !/Failed to load resource/i.test(e));
      if (unexpectedConsoleErrors.length) ng('browser console errors', unexpectedConsoleErrors.join(' | '));
      else ok('no unexpected browser console errors');
      console.log('    (debug) console urls:', consoleUrls.join(' | ') || '(none)');
    } finally {
      if (browser) await browser.close();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
