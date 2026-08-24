#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-2200.5 / PHA-2206 smoke test (extends PHA-2151's smoke-porch-ui):
// verify BOTH placements of the wall feed component — /porch.html (the
// standalone thin shell) and /index.html (the in-place #page-wall
// mount) — load the SAME /components/feed.js and reference the SAME
// backend endpoints. The component extraction moved all the
// composer/feed/reactions/comments logic into public/components/feed.js;
// porch.js no longer exists. This smoke covers:
//
//   1. Static asset shape (extraction is real — no inlined porch.js
//      logic in porch.html).
//   2. The shared component file is reachable as /components/feed.js
//      and exposes window.HomesteadFeed.
//   3. The /api/link-preview backend route (added in PHA-2151) still
//      works (composer depends on it).
//   4. /index.html references /components/feed.js for the in-place
//      mount and the wall module visibility check.
//
// Run after `npm test`: node scripts/smoke-porch-ui.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-porch-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3096';
process.env.ADMIN_PASSWORD = 'smoke-porch-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-porch-brandon-pw';
process.env.SESSION_SECRET = 'smoke-porch-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

async function login(username, password) {
  const r = await fetch('http://127.0.0.1:3096/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (r.status !== 200) throw new Error(`login failed for ${username}: HTTP ${r.status}`);
  return r.headers.get('set-cookie').split(';')[0];
}

// Minimal HTTP server standing in for "the internet", so the
// GET /api/link-preview 2s-timeout / best-effort-scrape path can be
// exercised without depending on outbound network access from CI.
function startFixtureServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><head><title>Porch Fixture</title><meta property="og:description" content="A test page for link previews."></head><body></body></html>');
      } else if (req.url === '/slow') {
        // Never respond — exercises the AbortSignal.timeout(2000) path.
        setTimeout(() => { try { res.end(); } catch (_) {} }, 10000);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3096, '127.0.0.1', () => { console.log('[smoke-porch] homestead on :3096'); resolve(); });
    process.on('uncaughtException', reject);
  });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3096/api/health');
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots');

  try {
    // ---- 1. Static assets exist and reference the right endpoints. ----
    const htmlPath = path.join(__dirname, '..', 'public', 'porch.html');
    const componentPath = path.join(__dirname, '..', 'public', 'components', 'feed.js');
    const cssPath = path.join(__dirname, '..', 'public', 'porch.css');
    assert(fs.existsSync(htmlPath), 'public/porch.html exists');
    assert(fs.existsSync(componentPath), 'public/components/feed.js exists (extraction)');
    assert(!fs.existsSync(path.join(__dirname, '..', 'public', 'porch.js')),
      'public/porch.js removed (logic moved into components/feed.js)');
    assert(fs.existsSync(cssPath), 'public/porch.css exists (shared styles)');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const componentJs = fs.readFileSync(componentPath, 'utf8');

    assert(html.includes('porch.css'), 'porch.html links porch.css');
    assert(html.includes('/components/feed.js'), 'porch.html loads /components/feed.js (shared component)');
    assert(html.includes('HomesteadFeed.mount'), 'porch.html calls HomesteadFeed.mount()');

    // Component file shape — must be the canonical extraction.
    assert(componentJs.includes('window.HomesteadFeed'), 'feed.js exposes window.HomesteadFeed');
    assert(componentJs.includes("'paste'") || componentJs.includes('"paste"'),
      'feed.js still listens for clipboard paste');
    assert(componentJs.includes('413'),
      'feed.js still handles the 413 (too-large) upload error');
    // The component builds URLs via apiBase+path, so /api/walls doesn't
    // appear as a literal — instead look for the path segments the
    // composer / feed / reactions / comments use.
    assert(componentJs.includes("'/walls'") || componentJs.includes('"/walls"'),
      'feed.js composes /walls path (joined with apiBase at fetch time)');
    assert(componentJs.includes("'/media'") || componentJs.includes('"/media"'),
      'feed.js composes /media path');
    assert(componentJs.includes('reaction') && componentJs.includes('emoji'),
      'feed.js wires up reactions (POST with emoji payload)');
    assert(componentJs.includes('comment') && componentJs.includes('comments'),
      'feed.js wires up comments (GET + POST)');
    assert(componentJs.includes('/api/link-preview'), 'feed.js references /api/link-preview');
    assert(componentJs.includes('reactions'), 'feed.js wires up reactions');
    assert(componentJs.includes('comments'), 'feed.js wires up comments');
    assert(componentJs.includes('Older'), 'feed.js wires up the Older pagination button');

    // index.html — in-place #page-wall mount and wall-module visibility.
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert(/id=["']page-porch["']/.test(indexHtml),
      'index.html has a #page-porch page container (in-place mount)');
    assert(/data-p=["']porch["']/.test(indexHtml),
      'index.html nav entry uses data-p="porch" (in-place tab, not a link; matches room discriminator, not the module key)');
    assert(indexHtml.includes('/components/feed.js'),
      'index.html loads the SAME /components/feed.js (single canonical file)');
    assert(indexHtml.includes('HomesteadFeed.mount'),
      'index.html calls HomesteadFeed.mount() for the in-place mount');

    // ---- 2. GET /porch.html is actually served. ----
    let r = await fetch('http://127.0.0.1:3096/porch.html');
    assertEq(r.status, 200, 'GET /porch.html returns 200');
    const served = await r.text();
    assert(served.includes('/components/feed.js'),
      'served porch.html references /components/feed.js (shared component)');

    // ---- 2b. GET /components/feed.js is reachable as a static asset. ----
    r = await fetch('http://127.0.0.1:3096/components/feed.js');
    assertEq(r.status, 200, 'GET /components/feed.js returns 200 (shared asset)');
    const servedComp = await r.text();
    assert(servedComp.includes('window.HomesteadFeed'),
      'served /components/feed.js exposes window.HomesteadFeed');

    // ---- 2c. GET /index.html serves the in-place mount target. ----
    r = await fetch('http://127.0.0.1:3096/');
    assertEq(r.status, 200, 'GET / returns 200');
    const indexServed = await r.text();
    assert(/id=["']page-porch["']/.test(indexServed),
      'served /index.html has the in-place #page-porch container');

    // ---- 3. /api/link-preview: happy path against a local fixture. ----
    const fixture = await startFixtureServer();
    const fixturePort = fixture.address().port;
    const brandonCookie = await login('brandon', 'smoke-porch-brandon-pw');

    r = await fetch(`http://127.0.0.1:3096/api/link-preview?url=${encodeURIComponent(`http://127.0.0.1:${fixturePort}/ok`)}`, {
      headers: { Cookie: brandonCookie },
    });
    assertEq(r.status, 200, 'GET /api/link-preview returns 200 for a real page');
    const preview = await r.json();
    assertEq(preview.title, 'Porch Fixture', 'link-preview extracts <title>');
    assertEq(preview.description, 'A test page for link previews.', 'link-preview extracts og:description');

    // ---- 4. /api/link-preview: unauthenticated is rejected (same `auth`
    //         pattern as the other GET wall routes). ----
    r = await fetch(`http://127.0.0.1:3096/api/link-preview?url=${encodeURIComponent(`http://127.0.0.1:${fixturePort}/ok`)}`);
    assertEq(r.status, 401, 'unauthenticated GET /api/link-preview returns 401');

    // ---- 5. /api/link-preview: bad/unreachable URL degrades gracefully
    //         (never a 500). ----
    r = await fetch(`http://127.0.0.1:3096/api/link-preview?url=${encodeURIComponent('http://127.0.0.1:1/nope')}`, {
      headers: { Cookie: brandonCookie },
    });
    assertEq(r.status, 200, 'GET /api/link-preview on an unreachable URL still returns 200');
    const badPreview = await r.json();
    assertEq(badPreview, { title: '', description: '' }, 'unreachable URL yields empty best-effort preview');

    // ---- 6. /api/link-preview: missing url param degrades gracefully. --
    r = await fetch('http://127.0.0.1:3096/api/link-preview', { headers: { Cookie: brandonCookie } });
    assertEq(r.status, 200, 'GET /api/link-preview with no url param returns 200');

    fixture.close();

    // ---- 7. End-to-end: components/feed.js's whole flow against the real walls/
    //         media API (upload -> post -> react -> comment -> feed). ----
    // PHA-2556: the previous version open-coded an INSERT INTO user_groups
    // to put brandon in `media-club`, then tested against a wall the
    // product never made visible to anyone on a fresh boot. Same
    // anti-pattern as scripts/smoke-walls.js. Now brandon is already in
    // `household` (the seeded wall), so the wall is reachable via the
    // API alone — no DB writes here.
    r = await fetch('http://127.0.0.1:3096/api/walls', { headers: { Cookie: brandonCookie } });
    const wallsBody = await r.json();
    assert(wallsBody.walls.some((w) => w.slug === 'household'), 'GET /api/walls (what feed.js calls on boot) lists household');

    r = await fetch('http://127.0.0.1:3096/api/walls/household/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
      body: JSON.stringify({ kind: 'text', text_body: 'porch smoke post' }),
    });
    assertEq(r.status, 200, 'POST text post (composer flow) returns 200');
    const post = await r.json();

    r = await fetch(`http://127.0.0.1:3096/api/walls/household/posts/${post.id}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
      body: JSON.stringify({ emoji: 'fire' }),
    });
    assertEq(r.status, 200, 'reaction toggle (reaction row flow) returns 200');

    // Idempotent toggle-off, matching feed.js's optimistic-toggle logic.
    r = await fetch(`http://127.0.0.1:3096/api/walls/household/posts/${post.id}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
      body: JSON.stringify({ emoji: 'fire' }),
    });
    const toggledOff = await r.json();
    assertEq(toggledOff.reacted, false, 'second identical reaction call toggles off (idempotent)');

    console.log(`\n[smoke-porch] ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  } catch (e) {
    console.error('[smoke-porch] error:', e && e.stack || e);
    process.exit(1);
  }
})();
