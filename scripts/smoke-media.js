#!/usr/bin/env node
// PHA-2149 smoke test: boot server.js on an ephemeral port, log in,
// upload a small PNG fixture via /api/media, fetch + thumb it back,
// and confirm the 1h private Cache-Control header. Same boot pattern
// as scripts/smoke-merge-layer.js.
//
// Run after `npm test`: node scripts/smoke-media.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-media-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3094';
process.env.ADMIN_PASSWORD = 'smoke-media-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-media-brandon-pw';
process.env.SESSION_SECRET = 'smoke-media-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
  else ng(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);

(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3094, '127.0.0.1', () => { console.log('[smoke-media] homestead on :3094'); resolve(); });
    process.on('uncaughtException', reject);
  });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3094/api/health');
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots');

  const loginRes = await fetch('http://127.0.0.1:3094/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'brandon', password: 'smoke-media-brandon-pw' }),
  });
  assertEq(loginRes.status, 200, 'login returns 200');
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  const boundary = '----homestead-smoke-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="smoke.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG_1X1,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const uploadRes = await fetch('http://127.0.0.1:3094/api/media', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Cookie: cookie },
    body,
  });
  assertEq(uploadRes.status, 200, 'POST /api/media returns 200');
  const uploaded = await uploadRes.json();
  assert(!!uploaded.id, 'upload returns an id');

  const fetchRes = await fetch(`http://127.0.0.1:3094/api/media/${uploaded.id}`, { headers: { Cookie: cookie } });
  assertEq(fetchRes.status, 200, 'GET /api/media/:id returns 200');
  assertEq(fetchRes.headers.get('cache-control'), 'private, max-age=3600', 'Cache-Control is private, max-age=3600');

  const thumbRes = await fetch(`http://127.0.0.1:3094/api/media/${uploaded.id}/thumb`, { headers: { Cookie: cookie } });
  assertEq(thumbRes.status, 200, 'GET /api/media/:id/thumb returns 200');
  assertEq(thumbRes.headers.get('cache-control'), 'private, max-age=3600', 'thumb Cache-Control is private, max-age=3600');

  const unauthRes = await fetch(`http://127.0.0.1:3094/api/media/${uploaded.id}`);
  assertEq(unauthRes.status, 401, 'unauthenticated fetch returns 401');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
