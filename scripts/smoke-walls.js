#!/usr/bin/env node
// PHA-2150 / PHA-2556 smoke test: boot server.js on an ephemeral port
// and exercise the wall feed against the seeded wall.
//
// PHA-2556 rewrote this test to match the new DoD rule (see
// docs/DEFINITION-OF-DONE.md "fresh-install user outcome"): the test
// must NOT perform any manual DB writes that the product itself
// cannot perform. The previous version open-coded an `INSERT INTO
// user_groups` to grant brandon media-club membership — exactly the
// bug the test was supposed to catch. Now the seeded wall is
// `household` (visibility=group, group_name=household) and brandon is
// already in `household` per lib/user-model.js's seed, so the wall
// is visible on a fresh boot with no DB edits.
//
// Two cases:
//   1. Default path — log in as brandon, no DB writes; the seeded
//      'household' wall shows up. (This is the user-visible outcome
//      PHA-2556 acceptance criterion.)
//   2. Group-grant path — when a NEW user (not in `household`) gets
//      added to media-club via the new admin POST /api/walls/:slug/
//      members route, the membership machinery works the same way.
//      This is the explicit assertion the spec asked to "keep" so the
//      group-derived path isn't dropped from coverage.
//
// Same boot pattern as scripts/smoke-media.js.
//
// Run after `npm test`: node scripts/smoke-walls.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-walls-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3095';
process.env.ADMIN_PASSWORD = 'smoke-walls-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-walls-brandon-pw';
process.env.EMILY_PASSWORD = 'smoke-walls-emily-pw';
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

  // ---- Case 1: DEFAULT — fresh install, no DB writes ----
  // brandon is seeded in `household`; the seeded wall is
  // visibility=group, group_name=household. The wall is visible
  // immediately. This is the user-visible acceptance criterion from
  // PHA-2556: "fresh DB → boot → log in as brandon → tap Porch → wall
  // opens with composer → post lands."
  console.log('\nCase 1: fresh install, no DB writes');
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
  assert(wallsList.walls.some((w) => w.slug === 'household'),
    'household wall is visible after a fresh boot (no DB writes)');
  assertEq(wallsList.walls.length, 1,
    'no extra walls leak through on a fresh install');

  const wAllRes = await fetch('http://127.0.0.1:3095/api/walls/all', { headers: { Cookie: cookie } });
  assertEq(wAllRes.status, 403, 'GET /api/walls/all requires admin');

  // Upload a small PNG and post to the household wall.
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

  const postRes = await fetch('http://127.0.0.1:3095/api/walls/household/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ kind: 'image', media_id: uploaded.id }),
  });
  assertEq(postRes.status, 200, 'POST /api/walls/household/posts returns 200');
  const post = await postRes.json();
  assertEq(post.mediaId, uploaded.id, 'post carries the media id');

  const reactRes = await fetch(`http://127.0.0.1:3095/api/walls/household/posts/${post.id}/reactions`, {
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

  const postsRes = await fetch('http://127.0.0.1:3095/api/walls/household/posts', { headers: { Cookie: cookie } });
  assertEq(postsRes.status, 200, 'GET posts returns 200');
  const postsList = await postsRes.json();
  const listed = postsList.posts.find((p) => p.id === post.id);
  assert(!!listed, 'posted item shows up in the wall listing');
  assertEq(listed.reactionSummary.fire, 1, 'reaction summary reflects the react');
  assertEq(listed.commentCount, 1, 'comment count reflects the comment');

  const unauthWallRes = await fetch('http://127.0.0.1:3095/api/walls/household/posts');
  assertEq(unauthWallRes.status, 401, 'unauthenticated wall fetch returns 401');

  // ---- Case 2: GROUP-GRANT PATH (admin route) ----
  // Verify the admin POST /api/walls/:slug/members route grants a
  // brand-new user access to a non-household group wall via the API
  // alone. The seed includes an `emily` user already in `household`,
  // but emily is NOT in `media-club`. Here we create a fresh media-club
  // wall via POST /api/walls (admin) and grant emily via the new
  // member-management route — no DB writes anywhere in the test.
  console.log('\nCase 2: admin route grants access without DB writes');
  const adminLoginRes = await fetch('http://127.0.0.1:3095/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'smoke-walls-admin-pw' }),
  });
  assertEq(adminLoginRes.status, 200, 'admin login returns 200');
  const adminCookie = adminLoginRes.headers.get('set-cookie').split(';')[0];

  const createRes = await fetch('http://127.0.0.1:3095/api/walls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ slug: 'media-club', name: 'Media Club', visibility: 'group', group_name: 'media-club' }),
  });
  assertEq(createRes.status, 201, 'POST /api/walls creates media-club');
  const created = await createRes.json();
  assertEq(created.wall.slug, 'media-club', 'created wall slug roundtrips');

  // smoke-walls sets EMILY_PASSWORD above so emily's seeded pass_hash
  // is independent of admin/brandon.
  const emilyLoginRes = await fetch('http://127.0.0.1:3095/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'emily', password: 'smoke-walls-emily-pw' }),
  });
  assertEq(emilyLoginRes.status, 200, 'emily login returns 200');
  const emilyCookie2 = emilyLoginRes.headers.get('set-cookie').split(';')[0];

  // emily is NOT in media-club yet — wall list should not include it.
  const emilyListRes = await fetch('http://127.0.0.1:3095/api/walls', { headers: { Cookie: emilyCookie2 } });
  const emilyWalls = await emilyListRes.json();
  assert(!emilyWalls.walls.some((w) => w.slug === 'media-club'),
    'emily cannot see media-club before grant');

  const grantRes = await fetch('http://127.0.0.1:3095/api/walls/media-club/members', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ username: 'emily' }),
  });
  assertEq(grantRes.status, 200, 'admin grants emily access via POST /api/walls/:slug/members');

  const emilyListAfterRes = await fetch('http://127.0.0.1:3095/api/walls', { headers: { Cookie: emilyCookie2 } });
  const emilyWallsAfter = await emilyListAfterRes.json();
  assert(emilyWallsAfter.walls.some((w) => w.slug === 'media-club'),
    'emily now sees media-club after admin grant (no DB writes)');

  const membersRes = await fetch('http://127.0.0.1:3095/api/walls/media-club/members', { headers: { Cookie: emilyCookie2 } });
  assertEq(membersRes.status, 200, 'emily can list members of media-club');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});