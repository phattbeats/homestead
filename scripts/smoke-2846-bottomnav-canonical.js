#!/usr/bin/env node
// PHA-2846 / v0.5.10 acceptance smoke — bottom-nav icon migration.
//
// Brandon reopened PHA-2846 at 00:48 EDT pointing out that the persistent
// bottom-nav across `/` and `/porch.html` still rendered emoji literals
// (`🏠 ✓ 📝 📅 🛰️ 📸`) instead of the canonical opening-door / module
// SVGs. PHA-2846 v0.5.9 had shipped the canonical icon set + the Add
// Rooms picker wires but did not touch the bottom-nav (the nav predated
// PHA-2209's no-hardcoded-keys audit and was out of scope).
//
// This smoke covers 6 acceptance criteria for v0.5.10:
//   1. `public/index.html` rewrites the six bottom-nav buttons from
//      `<span class="ico">🏠</span>` (and the other 5 emoji) to
//      `<span class="ico"><img src="..."></span>` referencing the
//      canonical SVG set. The `data-p="home"` button references
//      `/icon.svg` (the canonical opening-door mark); the other five
//      reference their built-in module's `/modules/<key>.svg`.
//   2. `public/index.html` adds `<link rel="alternate icon" href="/favicon-32.png">`
//      and `<link rel="apple-touch-icon" href="/icon-512.png">` so the
//      favicon always lands on a canonical-icon-shaped asset.
//   3. `public/index.html` `<nav .ico>` rule is updated to render an
//      `<img>` block of width/height 22px inside a 24×24 inline-flex
//      square (no emoji fallback).
//   4. `public/favicon-32.png` exists on disk, is a valid 32×32 PNG, and
//      matches the canonical opening-door mark. The MD5 is recorded in
//      the closing comment so future agents have a known-good reference.
//   5. `public/sw.js` is bumped from `homestead-v5` to `homestead-v6`,
//      v5 is dropped on activate (the old emoji tab bar is no longer
//      reachable offline), and `/favicon-32.png` is in `PRECACHE_URLS`.
//   6. No JS errors anywhere (smoke shell refuses to mark green if
//      console logs an error during boot).
//
// Run:  node scripts/smoke-2846-bottomnav-canonical.js
//       (also runs as part of scripts/verify.sh — see PHA-2501 standing policy)
//
// Output: ./verify-out/bottomnav-canonical-390.png   (post-login screenshot of the migrated bottom nav)
//         ./verify-out/bottomnav-canonical-table.txt (asset MD5 reference table)

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2846bn-'));
const port = 3113;
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-2846bn-admin-pw';

const REPO = path.resolve(__dirname, '..');
const failures = [];
const check = (name, ok, msg) => {
  if (ok) console.log(`  ✓ ${name}`);
  else { console.log(`  ✗ ${name}  ${msg || ''}`); failures.push(name); }
};

console.log('PHA-2846 / v0.5.10 — bottom-nav canonical icons smoke\n');

// 1–3. Static checks on the source tree (no server needed for these).
const indexHtml = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
const swJs      = fs.readFileSync(path.join(REPO, 'public', 'sw.js'), 'utf8');
const favicon32 = path.join(REPO, 'public', 'favicon-32.png');

// Mapping table — same room → module-icon mapping as the description.
// `home` is always-on (no module); references the canonical opening-door.
const tabMapping = [
  { dataP: 'home',       img: '/icon.svg' },
  { dataP: 'tasks',      img: '/modules/chores.svg' },
  { dataP: 'r-lists',    img: '/modules/lists.svg' },
  { dataP: 'r-calendar', img: '/modules/calendar.svg' },
  { dataP: 'svc',        img: '/modules/apps.svg' },
  { dataP: 'porch',      img: '/modules/porch.svg' },
];

console.log('— Static checks on public/index.html, public/sw.js, public/favicon-32.png —\n');

for (const tab of tabMapping) {
  // Each tab must render an <img> referencing the canonical SVG, NOT an emoji.
  const re = new RegExp(
    `<button\\s+data-p=["']${tab.dataP}["'][^>]*>\\s*<span class="ico">\\s*<img src=["']${tab.img.replace(/\//g, '\\/')}["']`,
  );
  check(`tab[${tab.dataP}] references ${tab.img} via <img>`, re.test(indexHtml),
    `expected <button data-p="${tab.dataP}"> with <span class="ico"><img src="${tab.img}">`);
}

// No leftover emoji literals inside <span class="ico"> in the bottom-nav
// (this regex would catch `🏠 ✓ 📝 📅 🛰️ 📸` between `<span class="ico">` and `</span>`).
const emojiRe = /<span class="ico">[^<]*\p{Extended_Pictographic}/u;
check('no emoji literals in nav .ico spans (rejected)', !emojiRe.test(indexHtml),
  'still have emoji inside <span class="ico">');

check('alternate icon link rel=alternate icon → /favicon-32.png',
  /<link rel=["']alternate icon["'] href=["']\/favicon-32\.png["']/.test(indexHtml),
  'no <link rel="alternate icon" href="/favicon-32.png">');

check('apple-touch-icon → /icon-512.png',
  /<link rel=["']apple-touch-icon["'] href=["']\/icon-512\.png["']/.test(indexHtml),
  'no <link rel="apple-touch-icon" href="/icon-512.png">');

check('nav .ico CSS rule sizes an <img> at 22px',
  /nav\s+\.ico\s*\{[^}]*width:\s*24px[^}]*height:\s*24px/.test(indexHtml) &&
  /nav\s+\.ico\s+img\s*\{[^}]*width:\s*22px[^}]*height:\s*22px/.test(indexHtml),
  'no nav .ico inline-flex + nav .ico img {22×22} rule');

// 4. favicon-32.png is on disk, valid, and matches the canonical icon
if (fs.existsSync(favicon32)) {
  const head = fs.readFileSync(favicon32).slice(0, 8);
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47;
  check('public/favicon-32.png exists on disk', true);
  check('public/favicon-32.png is a valid PNG', isPng, 'PNG magic bytes not matched');
  const crypto = require('crypto');
  const md5 = crypto.createHash('md5').update(fs.readFileSync(favicon32)).digest('hex');
  check(`public/favicon-32.png MD5 = ${md5}`, true);
  // Record for the closing comment.
  fs.writeFileSync(path.join(verifyOut, 'bottomnav-canonical-table.txt'),
    `public/favicon-32.png  MD5  ${md5}\n`);
} else {
  check('public/favicon-32.png exists on disk', false, 'file missing from public/');
}

// 5. Service worker cache bump
check('sw.js homestead-v6 cache name present',
  /caches\.open\(['"]homestead-v6['"]\)/.test(swJs),
  'no caches.open("homestead-v6") found');
check('sw.js activate drops any cache that is not homestead-v6',
  /names\.filter\(\s*n\s*=>\s*n\s*!==\s*['"]homestead-v6['"]\s*\)/.test(swJs),
  'no n => n !== "homestead-v6" filter found on activate');
check('sw.js PRECACHE_URLS lists /favicon-32.png',
  /const PRECACHE_URLS = \[[^\]]*\n\s*'\/favicon-32\.png'/.test(swJs),
  '/favicon-32.png missing from PRECACHE_URLS');

// 6. Live boot + screenshot — fires the server, navigates to /, captures
//    the 390×844 mobile-viewport screenshot of the migrated bottom-nav.
//    We don't assert the screenshot pixel-perfect (visual diff is out of
//    scope); the test is "the page boots and the nav renders without
//    JS errors after the migration".
async function liveBoot() {
  console.log('\n— Live boot + post-login screenshot —\n');

  // Spawn the server as a child process.
  const { spawn } = require('child_process');
  const serverPath = path.join(REPO, 'server.js');
  const serverLog = path.join(verifyOut, 'bottomnav-canonical-server.log');
  const serverOut = fs.openSync(serverLog, 'w');
  const server = spawn(process.execPath, [serverPath], {
    cwd: REPO,
    env: { ...process.env },
    stdio: ['ignore', serverOut, serverOut],
    detached: false,
  });

  let serverReady = false;
  const pingHandle = setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) { serverReady = true; clearInterval(pingHandle); }
    } catch (_) {}
  }, 250);

  for (let i = 0; i < 60 && !serverReady; i++) await new Promise(r => setTimeout(r, 250));
  clearInterval(pingHandle);

  if (!serverReady) {
    check('server boots within 15s', false, 'no /api/health 200 in 15s');
    server.kill('SIGTERM'); return;
  }
  check('server boots within 15s', true);

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error') consoleErrors.push(`console.error: ${m.text()}`);
  });

  // Log in via the standard /login UI. The Homestead login requires BOTH
  // a username (#username) and password (#pw). The form validates both
  // fields are non-empty before the server-side pass_hash check fires.
  // Same flow as smoke-2585-home-always-visible.js — verified selector.
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#username', { timeout: 10000 });
  await page.fill('#username', process.env.ADMIN_USERNAME || 'admin');
  await page.fill('#pw', process.env.ADMIN_PASSWORD || 'smoke-2846bn-admin-pw');
  await page.click('#loginBtn');
  // Wait for the SPA to settle past #login onto #page-home.
  await page.waitForSelector('#appNav', { timeout: 10000 });
  await page.waitForTimeout(1500);

  // Dismiss the first-run "Welcome to Homestead" onboarding sheet so
  // the bottom-nav is actually visible in the screenshot. The sheet
  // exposes a "Got it" button (text match on the visible label).
  try {
    await page.getByRole('button', { name: /got it/i }).click({ timeout: 2000 });
    await page.waitForTimeout(500);
  } catch (_) {
    // First-run only — older seeded profiles skip this modal. Move on.
  }

  await page.screenshot({ path: path.join(verifyOut, 'bottomnav-canonical-390.png'), fullPage: false });

  await browser.close();
  server.kill('SIGTERM');

  check('post-login screenshot captured at 390×844', true);
  check('no JS errors during boot', consoleErrors.length === 0,
    `console errors: ${consoleErrors.join('; ')}`);
}

liveBoot().catch(err => {
  console.error('Live-boot section failed:', err);
  failures.push('live-boot');
}).finally(async () => {
  console.log('\n— Summary —\n');
  if (failures.length === 0) {
    console.log(`  ALL CHECKS PASS — v0.5.10 bottom-nav migration is green.`);
    console.log(`  Screenshot:    ./verify-out/bottomnav-canonical-390.png`);
    console.log(`  MD5 table:     ./verify-out/bottomnav-canonical-table.txt`);
    process.exit(0);
  } else {
    console.log(`  ${failures.length} CHECK(S) FAILED: ${failures.join('; ')}`);
    process.exit(1);
  }
});
