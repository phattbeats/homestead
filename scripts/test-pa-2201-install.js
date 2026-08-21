#!/usr/bin/env node
// PHA-2052 dogfood acceptance suite: Popcorn Vote as the first app
// installed through the PHA-2201 third-party app contract, against a
// fresh test user. HTTP-level, against a live server.js instance —
// mirrors the harness in scripts/test-app-install.js Test 10, but adds
// the checks that test suite doesn't cover: scope ENFORCEMENT (not
// just scope storage/display) and the wall-post/notification path a
// real app would use to "create posts on the feed."
//
// Manifest scope is deliberately smaller than the original PHA-2052
// backlog sketch: no `mcp`, no `webhooks`, no `entity_kinds`. Neither
// an MCP tool host nor an outbound webhook dispatcher exists anywhere
// in this codebase (confirmed by grep before writing this suite) —
// declaring them would validate but do nothing. v0.1 proves the
// contract with capabilities that are real today: read the
// media-club wall, and post an announcement to it, which rides the
// existing wall_posts -> notification_log pipeline for "users get
// notified, click through" — no bespoke poll/vote storage in
// Homestead itself. Popcorn Vote's own movie/poll/vote data model
// lives in its own external service (per lib/app-install.js's "a
// token holder, not code in Homestead's process").

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const registryValidate = require('../lib/registry-validate');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}

// The actual PHA-2052 manifest (mirrors the documented stub in
// lib/modules.js). Hosted URL is a placeholder per the ticket ("TBD
// until Popcorn Vote has a real home") — the acceptance suite never
// dials it, it stubs the fetch like every other manifest test in this
// repo.
const POPCORN_VOTE_MANIFEST = {
  key: 'popcorn_vote',
  name: 'Popcorn Vote',
  description: 'Family movie night voting.',
  icon: '🍿',
  room: null,
  requires: [],
  tier: 'advanced',
  version: '0.1.0',
  author: 'homestead-external',
  url: 'https://popcorn-vote.phatt.tech/manifest.json',
  open_mode: 'tab',
  scopes: ['read:walls:media_club', 'write:walls:post'],
  mcp: false,
  webhooks: [],
  entity_kinds: [],
  default_enabled: false,
};

console.log('PHA-2052 dogfood acceptance: Popcorn Vote through the PHA-2201 app contract\n');

// ---- Check 1: manifest passes lib/registry-validate.js's shape check ----
{
  console.log('Check 1: manifest shape validation');
  const shapeErr = registryValidate.validateEntryShape(POPCORN_VOTE_MANIFEST);
  assert(shapeErr === null, 'popcorn_vote manifest passes validateEntryShape with no warnings', shapeErr && shapeErr.message);
}

async function main() {

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-pa-2052-'));
const manifestServer = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(POPCORN_VOTE_MANIFEST));
});

process.env.DATA_DIR = tmpDir;
process.env.PORT = '0';
delete require.cache[require.resolve('../server.js')];
const app = require('../server.js');
const server = http.createServer(app);

const request = (opts, body) => new Promise((resolve, reject) => {
  const req = http.request(opts, (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      let json = null;
      try { json = JSON.parse(data); } catch (_) { /* non-JSON */ }
      resolve({ status: res.statusCode, body: json, headers: res.headers });
    });
  });
  req.on('error', reject);
  if (body) req.write(JSON.stringify(body));
  req.end();
});

await Promise.all([
  new Promise((r) => manifestServer.listen(0, '127.0.0.1', r)),
  new Promise((r) => server.listen(0, '127.0.0.1', r)),
]);

try {
  const manifestPort = manifestServer.address().port;
  const manifestUrl = `http://127.0.0.1:${manifestPort}/manifest.json`;
  const port = server.address().port;
  const base = { hostname: '127.0.0.1', port };
  const jsonHeaders = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });
  const pass_ = process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme';

  // "Fresh test user": brandon is the seeded profile the household
  // actually uses (PHA-2052 §"authored by Brandon"), but membership is
  // reset here rather than assumed — the default seed puts brandon in
  // 'household' only (scripts/test-walls.js confirms this), and this
  // suite needs brandon IN media-club (to prove the positive read
  // case) plus a second wall the app must NOT be able to read (to
  // prove the negative case) that brandon nonetheless belongs to as a
  // human.
  const loginRes = await request({
    ...base, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json' },
  }, { username: 'brandon', password: pass_ });
  const cookie = (loginRes.headers['set-cookie'] || [])[0];
  assert(loginRes.status === 200, 'login as brandon (the fresh test user) succeeds', JSON.stringify(loginRes.body));

  // ---- Check 2: install flow end-to-end (resolve -> consent -> install -> tile) ----
  console.log('\nCheck 2: install flow end-to-end');
  const resolveRes = await request({
    ...base, path: '/api/apps/resolve', method: 'POST', headers: jsonHeaders(cookie),
  }, { url: manifestUrl, dev: true });
  assertEq(resolveRes.status, 200, 'resolve succeeds');
  assertEq(resolveRes.body.manifest.key, 'popcorn_vote', 'resolve returns the popcorn_vote manifest preview');

  const consentRes = await request({
    ...base, path: '/api/apps/consent', method: 'POST', headers: jsonHeaders(cookie),
  }, { manifest_url: manifestUrl, acknowledged: true, dev: true });
  assertEq(consentRes.status, 200, 'consent succeeds');
  const consentToken = consentRes.body.consent_token;
  assert(!!consentToken, 'consent_token issued');

  const installRes = await request({
    ...base, path: '/api/apps/install', method: 'POST', headers: jsonHeaders(cookie),
  }, { consent_token: consentToken });
  assertEq(installRes.status, 200, 'install succeeds');
  const token = installRes.body.token_plaintext;
  assert(!!token, 'install returns the app-scoped token exactly once');

  const listRes = await request({ ...base, path: '/api/apps', method: 'GET', headers: { Cookie: cookie } });
  assert(listRes.body.some((a) => a.key === 'popcorn_vote'), 'popcorn_vote tile appears in GET /api/apps');

  const appAuth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // ---- Check 3: scope enforcement is REAL, not decorative ----
  // Before this suite, no route checked tokenRow.scopes at all — an
  // app-scoped token authorized as the full underlying user. Seed a
  // second wall ('family') that brandon (the human) genuinely belongs
  // to, so a pass on the negative case proves the *token's* scope is
  // gating it, not a membership check that would 404 for anyone.
  console.log('\nCheck 3: scope enforcement (positive + negative)');
  const Database = require('better-sqlite3');
  const dbPath = path.join(tmpDir, 'life.db');
  const rawDb = new Database(dbPath);
  const crypto = require('crypto');
  const brandonId = rawDb.prepare('SELECT id FROM users WHERE username = ?').get('brandon').id;
  const emilyId = rawDb.prepare('SELECT id FROM users WHERE username = ?').get('emily').id;

  // brandon + emily into media-club (positive case needs real
  // membership; emily is the "other member" who should get notified
  // in Check 4 below).
  const mediaClubGroup = rawDb.prepare('SELECT id FROM groups WHERE name = ?').get('media-club');
  rawDb.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(brandonId, mediaClubGroup.id);
  rawDb.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(emilyId, mediaClubGroup.id);

  // A second wall brandon belongs to as a human, that the app's token
  // (scoped only to read:walls:media_club) must NOT be able to read.
  let familyGroup = rawDb.prepare('SELECT id FROM groups WHERE name = ?').get('family');
  if (!familyGroup) {
    rawDb.prepare("INSERT INTO groups (name, display_name, source_provider) VALUES ('family','Family','authentik')").run();
    familyGroup = rawDb.prepare('SELECT id FROM groups WHERE name = ?').get('family');
  }
  rawDb.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(brandonId, familyGroup.id);
  const familyWallId = crypto.randomUUID();
  rawDb.prepare(`INSERT INTO walls (id, slug, name, visibility, group_name) VALUES (?, 'family', 'Family', 'group', 'family')`).run(familyWallId);
  rawDb.close();

  const mediaClubRead = await request({ ...base, path: '/api/walls/media-club/posts', method: 'GET', headers: appAuth });
  assertEq(mediaClubRead.status, 200, 'the app token CAN read media-club (its granted scope) — positive enforcement');

  const familyRead = await request({ ...base, path: '/api/walls/family/posts', method: 'GET', headers: appAuth });
  assertEq(familyRead.status, 403, 'the app token CANNOT read the family wall, though brandon (the human) belongs to it — scope enforcement is real, not decorative');
  assertEq(familyRead.body && familyRead.body.error, 'insufficient_scope', 'family-wall rejection is insufficient_scope, not a membership 404');

  // Sanity: brandon himself (session auth, unscoped) CAN read it.
  const familyReadAsHuman = await request({ ...base, path: '/api/walls/family/posts', method: 'GET', headers: { Cookie: cookie } });
  assertEq(familyReadAsHuman.status, 200, 'brandon the human (session auth) can read the family wall — confirms the 403 above is scope-specific, not a broken route');

  // ---- Check 4: write:walls:post works and the post lands on the feed ----
  console.log('\nCheck 4: app posts an announcement; it appears on the wall and notifies members');
  const postRes = await request({
    ...base, path: '/api/walls/media-club/posts', method: 'POST', headers: appAuth,
  }, {
    kind: 'link',
    link_url: 'https://popcorn-vote.phatt.tech/poll/42',
    link_title: '🍿 New movie poll: vote by Friday',
    link_description: 'Popcorn Vote posted a new movie-night poll. Cast your vote!',
  });
  assertEq(postRes.status, 200, 'POST via the app token succeeds (write:walls:post)');
  assertEq(postRes.body.link && postRes.body.link.title, '🍿 New movie poll: vote by Friday', 'the created post carries the poll announcement');

  const postsAfter = await request({ ...base, path: '/api/walls/media-club/posts', method: 'GET', headers: { Cookie: cookie } });
  assert(postsAfter.body.posts.some((p) => p.id === postRes.body.id), 'the announcement appears on the media-club wall feed');

  const db2 = new Database(dbPath);
  const notifRows = db2.prepare(
    `SELECT * FROM notification_log WHERE tag = ?`
  ).all(`wall_post:media-club:${postRes.body.id}`);
  assert(notifRows.length > 0, 'a notification_log row was created for media-club members other than the poster (feed notification path)');
  assert(notifRows.some((r) => r.user_id === emilyId), 'emily (a media-club member, not the poster) is notified');
  db2.close();

  // ---- Check 5: a token that was never granted write:walls:post is rejected ----
  // write:walls:post is a generic "post to walls you belong to" scope
  // in the existing §3 vocabulary (matches the built-in wall module's
  // own scope, lib/modules.js:45) — not per-wall like the read side.
  // So the meaningful negative test for the write path isn't "can it
  // post to a DIFFERENT wall" (it legitimately can, same as the read
  // scope's coarser sibling `read:walls` would) — it's "does a token
  // that was never granted this scope at all get rejected." Mint one
  // directly (same technique lib/agent-tokens.js's own tests use) to
  // exercise requireScope('write:walls:post') in isolation.
  console.log('\nCheck 5: a token without write:walls:post is rejected on POST');
  const agentTokens = require('../lib/agent-tokens');
  const db3 = new Database(dbPath);
  const readOnlyIssue = agentTokens.issue(db3, emilyId, {
    label: 'App: Popcorn Vote (read-only test token)',
    scopes: JSON.stringify(['read:walls:media_club']),
    appId: 'popcorn_vote',
  });
  db3.close();
  const readOnlyAuth = { Authorization: `Bearer ${readOnlyIssue.token_plaintext}`, 'Content-Type': 'application/json' };
  const readOnlyPostRes = await request({
    ...base, path: '/api/walls/media-club/posts', method: 'POST', headers: readOnlyAuth,
  }, { kind: 'text', text_body: 'should never land' });
  assertEq(readOnlyPostRes.status, 403, 'a token scoped read-only is rejected on POST (insufficient_scope)');
  assertEq(readOnlyPostRes.body && readOnlyPostRes.body.error, 'insufficient_scope', 'rejection reason is insufficient_scope');
  const readOnlyReadRes = await request({
    ...base, path: '/api/walls/media-club/posts', method: 'GET', headers: readOnlyAuth,
  });
  assertEq(readOnlyReadRes.status, 200, 'the SAME token can still read (its granted scope) — the 403 above is write-specific');

  // ---- Check 6: activity log reflects real app-token-authenticated calls ----
  // app_api_log (PHA-2231) only logs calls authenticated by the app's
  // OWN bearer token (server.js's authenticate(), Bearer branch) —
  // by design it does NOT log the human's consent-screen click or the
  // install call itself (those are session-authenticated, made by
  // brandon, not by Popcorn Vote). This check verifies what the
  // system actually records: the app's own calls.
  console.log('\nCheck 6: GET /api/apps/popcorn_vote/activity reflects the app\'s own calls');
  const activityRes = await request({ ...base, path: '/api/apps/popcorn_vote/activity', method: 'GET', headers: { Cookie: cookie } });
  assertEq(activityRes.status, 200, 'activity endpoint responds');
  const routes = (activityRes.body.items || []).map((r) => r.route);
  assert(routes.includes('GET /api/walls/media-club/posts'), 'activity log includes the app\'s successful media-club read');
  assert(routes.includes('POST /api/walls/media-club/posts'), 'activity log includes the app\'s wall post');
  assert(routes.includes('GET /api/walls/family/posts'), 'activity log includes the app\'s REJECTED family-wall attempt too (accountability trail, not just successes)');

  // ---- Check 7: revoke kills the token within 5s (immediate, next call) ----
  console.log('\nCheck 7: revoke kills the token immediately');
  const revokeStart = Date.now();
  const revokeRes = await request({ ...base, path: '/api/apps/popcorn_vote/revoke', method: 'POST', headers: { Cookie: cookie } });
  assertEq(revokeRes.status, 200, 'revoke succeeds');
  const postRevokeRes = await request({ ...base, path: '/api/walls/media-club/posts', method: 'GET', headers: appAuth });
  const elapsedMs = Date.now() - revokeStart;
  assertEq(postRevokeRes.status, 401, 'the revoked token gets 401 on its very next call');
  assert(elapsedMs < 5000, `revoke-to-401 round trip is well under 5s (${elapsedMs}ms)`);
  const zombieRes = await request({ ...base, path: '/api/apps/popcorn_vote', method: 'GET', headers: appAuth });
  assertEq(zombieRes.status, 401, 'no zombie requests: any further call with the revoked token also 401s');

} finally {
  server.close();
  manifestServer.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\nResults: ${pass} pass, ${fail} fail`);
console.log('\nDescoped for v0.1 (documented, not silently dropped):');
console.log('  - mcp: false — no MCP tool host exists anywhere in this codebase yet.');
console.log('  - webhooks: [] — no outbound webhook dispatcher exists; manifest.webhooks[] is validated/displayed but never delivered to.');
console.log('  - entity_kinds: [] — movie/poll/vote data lives in Popcorn Vote\'s own external service, not modeled in Homestead.');
process.exit(fail === 0 ? 0 : 1);

}

main().catch((err) => {
  console.error('acceptance suite crashed:', err.stack || err.message);
  process.exit(1);
});
