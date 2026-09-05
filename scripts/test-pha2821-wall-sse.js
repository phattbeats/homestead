#!/usr/bin/env node
// PHA-2821 smoke: two sessions, one wall, SSE live-update. Verifies the
// GET /api/walls/:slug/events stream actually delivers a `post` event
// when a different member posts, without either side polling.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-wall-sse-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3194';
process.env.ADMIN_PASSWORD = 'sse-test-admin-pw';
process.env.BRANDON_PASSWORD = 'sse-test-brandon-pw';
process.env.SESSION_SECRET = 'sse-test-secret';
process.env.NODE_ENV = 'production';

async function login(username, password) {
  const r = await fetch('http://127.0.0.1:3194/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (r.status !== 200) throw new Error(`login failed for ${username}: HTTP ${r.status}`);
  return r.headers.get('set-cookie').split(';')[0];
}

(async () => {
  const app = require(path.join(ROOT, 'server.js'));
  await new Promise((resolve, reject) => {
    app.listen(3194, '127.0.0.1', () => { console.log('[wall-sse] homestead on :3194'); resolve(); });
    process.on('uncaughtException', reject);
  });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch('http://127.0.0.1:3194/api/health'); if (r.ok) { ready = true; break; } } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots');

  const adminCookie = await login('admin', 'sse-test-admin-pw');
  const brandonCookie = await login('brandon', 'sse-test-brandon-pw');

  // Brandon opens the wall — this is his open session's SSE connection.
  const received = [];
  const sseReq = http.get({
    host: '127.0.0.1', port: 3194, path: '/api/walls/household/events',
    headers: { Cookie: brandonCookie, Accept: 'text/event-stream' },
  }, (res) => {
    assert(res.statusCode === 200, 'SSE connection returns 200');
    assert(res.headers['content-type'].includes('text/event-stream'), 'SSE content-type is text/event-stream');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evMatch = raw.match(/^event: (.+)$/m);
        const dataMatch = raw.match(/^data: (.+)$/m);
        if (evMatch && dataMatch) {
          received.push({ event: evMatch[1], data: JSON.parse(dataMatch[1]) });
        }
      }
    });
  });
  sseReq.on('error', () => {});

  // Give the connection a moment to establish before admin posts, so this
  // proves push delivery rather than a race with connection setup.
  await new Promise((r) => setTimeout(r, 300));

  const postRes = await fetch('http://127.0.0.1:3194/api/walls/household/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ kind: 'text', text_body: 'Tyler posted to the Porch' }),
  });
  assert(postRes.status === 200, 'admin post returns 200');
  const created = await postRes.json();

  // Wait for the push to land — no polling on our side, just a bounded
  // wait for the async SSE write to arrive.
  let waited = 0;
  while (received.length === 0 && waited < 3000) {
    await new Promise((r) => setTimeout(r, 50));
    waited += 50;
  }

  assert(received.length >= 1, `brandon's open SSE session received at least one event (got ${received.length})`);
  const postEvent = received.find((e) => e.event === 'post');
  assert(!!postEvent, 'a "post" event was delivered');
  assert(postEvent && postEvent.data && postEvent.data.id === created.id, 'delivered post id matches the created post id');
  assert(postEvent && postEvent.data && postEvent.data.text === 'Tyler posted to the Porch', 'delivered post carries the posted text');

  sseReq.destroy();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
  process.exit(process.exitCode);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
