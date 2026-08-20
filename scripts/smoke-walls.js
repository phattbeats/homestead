#!/usr/bin/env node
// PHA-2150 smoke test: boot server.js on an ephemeral port, log in as a
// seeded user, upload a small PNG fixture via /api/media (PHA-2149),
// post it to the seeded media-club wall, react, comment, and list it
// all back. Same boot pattern as scripts/smoke-media.js.
//
// Run after `npm test`: node scripts/smoke-walls.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-walls-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3095';
process.env.ADMIN_PASSWORD = 'smoke-walls-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-walls-brandon-pw';
process.env.SESSION_SECRET = 'smoke-walls-secret';
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
    app.listen(3095, '127.0.0.1', () => { console.log('[smoke-walls] homestead on :3095'); resolve(); });
    process.on('uncaughtException', reject);
  });

  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3095/api/health');
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots');

  // Grant brandon the media-club group directly (boot-time seed only
  // puts seeded users in 'household'; group membership is otherwise
  // reconciled from the authentik header, which this LAN-login smoke
  // test doesn't carry).
  const db = new Database(path.join(tmpDir, 'life.db'));
  const brandon = db.prepare("SELECT id FROM users WHERE username = 'brandon'").get();
  const mediaClub = db.prepare("SELECT id FROM groups WHERE name = 'media-club'").get();
  db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(brandon.id, mediaClub.id);
  db.close();

  const loginRes = await fetch('http://127.0.0.1:3095/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'brandon', password: 'smoke-walls-brandon-pw' }),
  });
  assertEq(loginRes.status, 200, 'login returns 200');
  const cookie = loginRes.headers.get('set-cookie').split(';')[0];

  const listRes = await fetch('http://127.0.0.1:3095/api/walls', { headers: { Cookie: cookie } });
  assertEq(listRes.status, 200, 'GET /api/walls returns 200');
  const wallsList = await listRes.json();
  assert(wallsList.walls.some((w) => w.slug === 'media-club'), 'media-club is visible after group grant');

  const boundary = '----homestead-smoke-walls-boundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="smoke.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG_1X1,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const uploadRes = await fetch('http://127.0.0.1:3095/api/media', {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Cookie: cookie },
    body,
  });
  assertEq(uploadRes.status, 200, 'media upload returns 200');
  const uploaded = await uploadRes.json();

  const postRes = await fetch('http://127.0.0.1:3095/api/walls/media-club/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ kind: 'image', media_id: uploaded.id }),
  });
  assertEq(postRes.status, 200, 'POST /api/walls/media-club/posts returns 200');
  const post = await postRes.json();
  assertEq(post.mediaId, uploaded.id, 'post carries the media id');

  const reactRes = await fetch(`http://127.0.0.1:3095/api/walls/media-club/posts/${post.id}/reactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ emoji: 'fire' }),
  });
  assertEq(reactRes.status, 200, 'react returns 200');
  const reacted = await reactRes.json();
  assertEq(reacted.reacted, true, 'reaction toggled on');

  const commentRes = await fetch(`http://127.0.0.1:3095/api/walls/posts/${post.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ body: 'nice pic' }),
  });
  assertEq(commentRes.status, 200, 'comment returns 200');

  const postsRes = await fetch('http://127.0.0.1:3095/api/walls/media-club/posts', { headers: { Cookie: cookie } });
  assertEq(postsRes.status, 200, 'GET posts returns 200');
  const postsList = await postsRes.json();
  const listed = postsList.posts.find((p) => p.id === post.id);
  assert(!!listed, 'posted item shows up in the wall listing');
  assertEq(listed.reactionSummary.fire, 1, 'reaction summary reflects the react');
  assertEq(listed.commentCount, 1, 'comment count reflects the comment');

  const unauthWallRes = await fetch('http://127.0.0.1:3095/api/walls/media-club/posts');
  assertEq(unauthWallRes.status, 401, 'unauthenticated wall fetch returns 401');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
