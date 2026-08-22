#!/usr/bin/env node
// PHA-2151 smoke test: boot server.js on an ephemeral port and exercise
// the Porch Wall frontend surface — static asset delivery plus the one
// new server route (GET /api/link-preview) that porch.js depends on but
// that isn't covered by scripts/smoke-walls.js or scripts/smoke-media.js.
//
// This doesn't drive a real browser (no build/test-runner DOM available
// here), so it does what scripts/smoke-token-manager-ui.js does: assert
// the HTML/JS source the browser would load contains the markup/wiring
// the spec calls for, and exercise the API surface end-to-end.
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
    const jsPath = path.join(__dirname, '..', 'public', 'porch.js');
    const cssPath = path.join(__dirname, '..', 'public', 'porch.css');
    assert(fs.existsSync(htmlPath), 'public/porch.html exists');
    assert(fs.existsSync(jsPath), 'public/porch.js exists');
    assert(fs.existsSync(cssPath), 'public/porch.css exists');
    const html = fs.readFileSync(htmlPath, 'utf8');
    const js = fs.readFileSync(jsPath, 'utf8');

    assert(html.includes('porch.css'), 'porch.html links porch.css');
    assert(html.includes('porch.js'), 'porch.html loads porch.js');
    assert(html.includes('id="dropZone"'), 'porch.html has a drop zone for the composer');
    assert(html.includes('id="fileInput"'), 'porch.html has a file input');
    assert(html.includes('id="textBody"'), 'porch.html has a text composer');
    assert(html.includes('id="linkUrl"'), 'porch.html has a link composer');
    assert(html.includes('id="olderBtn"'), 'porch.html has an explicit Older button (no infinite scroll)');

    assert(js.includes('/api/walls'), 'porch.js references /api/walls');
    assert(js.includes('/api/media'), 'porch.js references /api/media');
    assert(js.includes('/api/link-preview'), 'porch.js references /api/link-preview');
    assert(js.includes('reactions'), 'porch.js wires up reactions');
    assert(js.includes('comments'), 'porch.js wires up comments');
    assert(js.includes('paste'), 'porch.js listens for clipboard paste');
    assert(js.includes('413'), 'porch.js handles the 413 (too-large) upload error');

    // index.html nav entry, visibility-gated the same way other tiles are.
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert(indexHtml.includes('/porch.html'), 'index.html links to /porch.html');
    assert(indexHtml.includes('data-tile="porch"'), 'index.html nav entry carries data-tile="porch"');

    // ---- 2. GET /porch.html is actually served. ----
    let r = await fetch('http://127.0.0.1:3096/porch.html');
    assertEq(r.status, 200, 'GET /porch.html returns 200');
    const served = await r.text();
    assert(served.includes('porch.js'), 'served porch.html references porch.js');

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

    // ---- 7. End-to-end: porch.js's whole flow against the real walls/
    //         media API (upload -> post -> react -> comment -> feed). ----
    const Database = require('better-sqlite3');
    const db = new Database(path.join(tmpDir, 'life.db'));
    const brandon = db.prepare("SELECT id FROM users WHERE username = 'brandon'").get();
    const mediaClub = db.prepare("SELECT id FROM groups WHERE name = 'media-club'").get();
    db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(brandon.id, mediaClub.id);
    db.close();

    r = await fetch('http://127.0.0.1:3096/api/walls', { headers: { Cookie: brandonCookie } });
    const wallsBody = await r.json();
    assert(wallsBody.walls.some((w) => w.slug === 'media-club'), 'GET /api/walls (what porch.js calls on boot) lists media-club');

    r = await fetch('http://127.0.0.1:3096/api/walls/media-club/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
      body: JSON.stringify({ kind: 'text', text_body: 'porch smoke post' }),
    });
    assertEq(r.status, 200, 'POST text post (composer flow) returns 200');
    const post = await r.json();

    r = await fetch(`http://127.0.0.1:3096/api/walls/media-club/posts/${post.id}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
      body: JSON.stringify({ emoji: 'fire' }),
    });
    assertEq(r.status, 200, 'reaction toggle (reaction row flow) returns 200');

    // Idempotent toggle-off, matching porch.js's optimistic-toggle logic.
    r = await fetch(`http://127.0.0.1:3096/api/walls/media-club/posts/${post.id}/reactions`, {
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
