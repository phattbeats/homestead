#!/usr/bin/env node
// PHA-2821 Definition of Done: two real browser sessions, two different
// accounts, same wall, side by side — one posts, the other updates without
// touching anything. Driven through Browserless (real Chrome, CDP) against
// an ephemeral homestead instance so it proves the actual rendered
// EventSource path in public/components/feed.js, not just the raw SSE
// wire format (already covered by scripts/test-pha2821-wall-sse.js).
//
// Run: node scripts/gate-2821-two-browser-dod.js
// Output: ./verify-out/gate-2821-{admin,brandon}-{before,after}.png

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-gate-2821-'));
const port = 3195;
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'gate-2821-admin-pw';
process.env.BRANDON_PASSWORD = 'gate-2821-brandon-pw';
process.env.SESSION_SECRET = 'gate-2821-secret';
process.env.NODE_ENV = 'production';
process.env.ALLOW_HEADER_TRUST = '0';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }

function localRoutableIp() {
  if (process.env.SMOKE_HOST_IP) return process.env.SMOKE_HOST_IP;
  const nets = require('os').networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name]) {
      if (n.family === 'IPv4' && !n.internal) candidates.push(n.address);
    }
  }
  return candidates.find((a) => a.startsWith('172.18.')) || candidates[0] || '127.0.0.1';
}

(async () => {
  const app = require(path.join(ROOT, 'server.js'));
  await new Promise((resolve, reject) => {
    app.listen(port, '0.0.0.0', () => resolve());
    process.on('uncaughtException', reject);
  });

  const host = localRoutableIp();
  const base = `http://${host}:${port}`;

  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots');

  let browser;
  try {
    browser = await chromium.connectOverCDP('http://browserless:3000');

    async function loginCookie(username, password) {
      const r = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      assert(r.status === 200, `${username} login → 200`);
      const raw = (r.headers.get('set-cookie') || '');
      const [nv] = raw.split(';');
      const [name, value] = nv.split('=');
      return { name, value, url: base };
    }

    const adminCookie = await loginCookie('admin', 'gate-2821-admin-pw');
    const brandonCookie = await loginCookie('brandon', 'gate-2821-brandon-pw');

    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const brandonCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await adminCtx.addCookies([adminCookie]);
    await brandonCtx.addCookies([brandonCookie]);
    const adminPage = await adminCtx.newPage();
    const brandonPage = await brandonCtx.newPage();

    // Not 'networkidle': the SSE EventSource this fix adds is a
    // deliberately long-lived open connection, so the network never
    // goes idle while it's connected.
    await adminPage.goto(`${base}/porch.html`, { waitUntil: 'domcontentloaded' });
    await brandonPage.goto(`${base}/porch.html`, { waitUntil: 'domcontentloaded' });
    // The composer starts collapsed behind a "+" FAB on the primary-FAB
    // layout — open it before the textarea is interactable.
    async function openComposer(page) {
      const fab = page.locator('#composeFab');
      if (await fab.count()) await fab.click();
    }
    await openComposer(adminPage);
    await adminPage.waitForSelector('#textBody', { state: 'visible', timeout: 10000 });

    // Give the SSE connections a beat to establish.
    await new Promise((r) => setTimeout(r, 800));

    await brandonPage.screenshot({ path: path.join(verifyOut, 'gate-2821-brandon-before.png'), fullPage: true });

    const postText = `PHA-2821 live-update proof ${Date.now()}`;
    await adminPage.fill('#textBody', postText);
    await adminPage.click('#postText');

    // Brandon's tab must show the new post WITHOUT any reload/navigation.
    let seen = false;
    for (let i = 0; i < 30; i++) {
      const found = await brandonPage.locator(`text=${postText}`).count();
      if (found > 0) { seen = true; break; }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(seen, "brandon's open session shows admin's new post without reload");

    await brandonPage.screenshot({ path: path.join(verifyOut, 'gate-2821-brandon-after.png'), fullPage: true });
    await adminPage.screenshot({ path: path.join(verifyOut, 'gate-2821-admin-after.png'), fullPage: true });

    await adminCtx.close();
    await brandonCtx.close();
  } finally {
    if (browser) await browser.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
  process.exit(process.exitCode);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
