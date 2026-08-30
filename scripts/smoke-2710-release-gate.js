#!/usr/bin/env node
// PHA-2710 release-gate acceptance: fresh-browser smoke over the
// invite → welcome UI path, driven through Browserless (real Chrome,
// CDP) so it proves the actual rendered page rather than jsdom or
// server-side assertions alone.
//
// Boots server.js on 0.0.0.0 so the Browserless container (a peer on
// the phattvip Docker network) can reach it by this container's
// routable IP, then drives:
//   1. GET /invite/:code renders the Homestead/inviter/wall/access
//      explainer (criterion 1).
//   5. First-run /welcome.html teaches Porch/wall/next action, and a
//      returning user is skipped unless ?revisit=1 (criterion 5).
//
// Criteria 2/3/4/6/7/8/9/10 are proved server-side by the existing
// scripts/smoke-2704/2706/2708/2711 scripts (no UI surface involved)
// — this script only covers the two criteria that require an actual
// rendered browser.
//
// Run: node scripts/smoke-2710-release-gate.js
// Output: ./verify-out/gate-2710-{invite-page,welcome-new-user,welcome-revisit}.png

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2710-'));
const port = 3111;
const adminPassword = 'smoke-2710-admin-pw';
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = adminPassword;
process.env.SESSION_SECRET = 'smoke-2710-secret';
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

function localRoutableIp() {
  if (process.env.SMOKE_HOST_IP) return process.env.SMOKE_HOST_IP;
  const nets = require('os').networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) candidates.push(n.address);
    }
  }
  // Prefer the phattvip network (172.18.0.0/16), where browserless lives.
  return candidates.find((a) => a.startsWith('172.18.')) || candidates[0] || '127.0.0.1';
}

(async () => {
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '0.0.0.0', () => resolve(listener));
    listener.once('error', reject);
  });

  const host = localRoutableIp();
  const base = `http://${host}:${port}`;

  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) break;
    } catch (_) { /* boot in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  let browser;
  try {
    browser = await chromium.connectOverCDP('http://browserless:3000');
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    // Mint an invite as admin via a plain HTTP call (no browser needed
    // for setup — the browser only drives the recipient-facing pages).
    const loginRes = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: adminPassword }),
    });
    assertEq(loginRes.status, 200, 'admin login → 200');
    const adminCookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];

    const inviteRes = await fetch(`${base}/api/invites`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ wall_slug: 'household', expires_in_days: 7, max_uses: 1, note: 'PHA-2710 release-gate smoke' }),
    });
    assertEq(inviteRes.status, 201, 'mint invite → 201');
    const invite = await inviteRes.json();

    // 1. Invite page explains Homestead, inviter, wall, and access.
    await page.goto(`${base}/invite/${invite.id}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.wall-card', { state: 'visible', timeout: 5000 });
    const inviteText = await page.evaluate(() => document.getElementById('content').textContent);
    assert(/Homestead/.test(inviteText), 'invite page explains what Homestead is');
    assert(/admin/i.test(inviteText), 'invite page names the inviter');
    assert(/household/i.test(inviteText), 'invite page names the wall');
    assert(/access|join|member/i.test(inviteText), 'invite page describes the access granted');
    const shotInvite = path.join(verifyOut, 'gate-2710-invite-page.png');
    await page.screenshot({ path: shotInvite, fullPage: true });
    ok(`screenshot saved: ${shotInvite}`);

    // Create the account through the real form (not fetch()) so the
    // rendered choice UI is exercised too.
    await page.locator('text=Show form →').first().click();
    await page.fill('input[placeholder="alice42"]', 'gateuser');
    await page.fill('input[placeholder="Alice"]', 'Gate User');
    await page.fill('input[placeholder="••••••••"]', 'gate-pass-2026');
    await Promise.all([
      page.waitForURL(/\/welcome\.html/, { timeout: 5000 }),
      page.click('button:has-text("Create account & join")'),
    ]);
    ok('signup form submits and redirects to /welcome.html');

    // 5. First-run welcome teaches Porch/wall/next action.
    await page.waitForSelector('#continueBtn:not(.hidden)', { state: 'visible', timeout: 5000 });
    const welcomeText = await page.evaluate(() => document.getElementById('content').textContent);
    assert(/Welcome to Homestead/.test(welcomeText), 'welcome shows heading');
    assert(/Porch/.test(welcomeText), 'welcome explains the Porch');
    assert(/household/i.test(welcomeText), 'welcome names the wall the user joined');
    const ctaText = await page.evaluate(() => document.getElementById('continueBtn').textContent);
    assert(/Porch/.test(ctaText), 'welcome CTA states a concrete next action', ctaText);
    const shotWelcome = path.join(verifyOut, 'gate-2710-welcome-new-user.png');
    await page.screenshot({ path: shotWelcome, fullPage: true });
    ok(`screenshot saved: ${shotWelcome}`);

    await page.keyboard.press('Escape');
    await page.waitForURL(/\/porch\.html/, { timeout: 5000 });
    ok('dismissing welcome lands on the Porch');

    // Returning user: skipped unless ?revisit=1.
    await page.goto(`${base}/welcome.html?wall=household`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/porch\.html/, { timeout: 5000 });
    ok('returning user is skipped straight to the Porch');

    await page.goto(`${base}/welcome.html?wall=household&revisit=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#continueBtn:not(.hidden)', { state: 'visible', timeout: 5000 });
    const shotRevisit = path.join(verifyOut, 'gate-2710-welcome-revisit.png');
    await page.screenshot({ path: shotRevisit, fullPage: true });
    ok(`?revisit=1 reopens welcome for a returning user; screenshot saved: ${shotRevisit}`);

    console.log(`\n${pass} pass / ${fail} fail`);
    if (fail > 0) process.exit(1);
  } finally {
    if (browser) await browser.close();
    server.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
})().catch((err) => {
  console.error('smoke-2710 crashed:', err);
  console.log(`\n${pass} pass / ${fail} fail`);
  process.exit(1);
});
