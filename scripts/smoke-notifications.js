#!/usr/bin/env node
// PHA-2218 smoke test: boot server.js on an ephemeral port, exercise the
// new HTTP surface end-to-end — members autocomplete, per-wall level
// GET/PUT, an @-mentioned post, thread mute/unmute, the badge feed, and
// seen-clearing. Same boot pattern as scripts/smoke-walls.js.
//
// Run after `npm test`: node scripts/smoke-notifications.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-notif-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3096';
process.env.ADMIN_PASSWORD = 'smoke-notif-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-notif-brandon-pw';
process.env.EMILY_PASSWORD = 'smoke-notif-emily-pw';
process.env.SESSION_SECRET = 'smoke-notif-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) ok(label);
  else ng(label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const BASE = 'http://127.0.0.1:3096';
async function login(username, password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
  return res.headers.get('set-cookie').split(';')[0];
}

(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3096, '127.0.0.1', () => { console.log('[smoke-notifications] homestead on :3096'); resolve(); });
    process.on('uncaughtException', reject);
  });
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { ready = true; break; }
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error('homestead did not become ready');
  ok('server boots');

  // Both brandon and emily into media-club (household seed alone doesn't
  // cover it), and disable quiet hours for both so this smoke test's
  // pass/fail doesn't depend on the wall-clock hour it runs at.
  const db = new Database(path.join(tmpDir, 'life.db'));
  const brandon = db.prepare("SELECT id FROM users WHERE username = 'brandon'").get();
  const emily = db.prepare("SELECT id FROM users WHERE username = 'emily'").get();
  const mediaClub = db.prepare("SELECT id FROM groups WHERE name = 'media-club'").get();
  db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(brandon.id, mediaClub.id);
  db.prepare('INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)').run(emily.id, mediaClub.id);
  db.prepare('INSERT OR REPLACE INTO notification_prefs (user_id, quiet_start_hour, quiet_end_hour) VALUES (?, 0, 0)').run(brandon.id);
  db.prepare('INSERT OR REPLACE INTO notification_prefs (user_id, quiet_start_hour, quiet_end_hour) VALUES (?, 0, 0)').run(emily.id);
  db.close();

  const brandonCookie = await login('brandon', 'smoke-notif-brandon-pw');
  const emilyCookie = await login('emily', 'smoke-notif-emily-pw');

  // ---- members autocomplete ----
  const membersRes = await fetch(`${BASE}/api/walls/media-club/members`, { headers: { Cookie: brandonCookie } });
  assertEq(membersRes.status, 200, 'GET members returns 200');
  const membersBody = await membersRes.json();
  assert(membersBody.members.some((m) => m.username === 'emily'), 'emily appears in media-club members list');

  // ---- level GET default + PUT ----
  const levelRes = await fetch(`${BASE}/api/walls/media-club/notifications`, { headers: { Cookie: emilyCookie } });
  assertEq(levelRes.status, 200, 'GET notifications level returns 200');
  const levelBody = await levelRes.json();
  assertEq(levelBody.level, 'mentions', 'default level is mentions before any explicit set');

  const putRes = await fetch(`${BASE}/api/walls/media-club/notifications`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: emilyCookie },
    body: JSON.stringify({ level: 'all' }),
  });
  assertEq(putRes.status, 200, 'PUT notifications level returns 200');
  const afterPut = await (await fetch(`${BASE}/api/walls/media-club/notifications`, { headers: { Cookie: emilyCookie } })).json();
  assertEq(afterPut.level, 'all', 'level persists as all after PUT');

  const badLevelRes = await fetch(`${BASE}/api/walls/media-club/notifications`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: emilyCookie },
    body: JSON.stringify({ level: 'nonsense' }),
  });
  assertEq(badLevelRes.status, 400, 'invalid level is rejected with 400');

  // ---- plain post -> emily (level=all) gets a delivered notification ----
  const plainPostRes = await fetch(`${BASE}/api/walls/media-club/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
    body: JSON.stringify({ kind: 'text', text_body: 'no mention here' }),
  });
  assertEq(plainPostRes.status, 200, 'plain post returns 200');
  const plainPost = await plainPostRes.json();

  const emilyFeed1 = await (await fetch(`${BASE}/api/me/notifications`, { headers: { Cookie: emilyCookie } })).json();
  const plainRow = emilyFeed1.notifications.find((n) => n.url.includes(plainPost.id));
  assert(!!plainRow, 'plain post lands in emily\'s feed (level=all)');
  assertEq(plainRow && plainRow.delivered, true, 'plain post is delivered under level=all');

  // ---- mentioned post -> mention row, distinct category ----
  const mentionPostRes = await fetch(`${BASE}/api/walls/media-club/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
    body: JSON.stringify({ kind: 'text', text_body: 'hey @emily check this out' }),
  });
  const mentionPost = await mentionPostRes.json();
  const emilyFeed2 = await (await fetch(`${BASE}/api/me/notifications`, { headers: { Cookie: emilyCookie } })).json();
  const mentionRow = emilyFeed2.notifications.find((n) => n.url.includes(mentionPost.id));
  assert(!!mentionRow, 'mentioned post lands in emily\'s feed');
  assertEq(mentionRow && mentionRow.category, 'mention', 'mention row category is mention');
  assert(mentionRow && mentionRow.title.includes('mentioning you'), 'mention title calls out "mentioning you"');

  // ---- thread mute ----
  const muteRes = await fetch(`${BASE}/api/walls/media-club/posts/${plainPost.id}/mute`, {
    method: 'POST', headers: { Cookie: emilyCookie },
  });
  assertEq(muteRes.status, 200, 'mute returns 200');
  const muteBody = await muteRes.json();
  assertEq(muteBody.muted, true, 'mute response reports muted:true');

  const commentOnMutedRes = await fetch(`${BASE}/api/walls/posts/${plainPost.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: brandonCookie },
    body: JSON.stringify({ body: 'still talking about it, @emily' }),
  });
  assertEq(commentOnMutedRes.status, 200, 'comment on muted post still succeeds (mute only affects the muter\'s notifications)');
  const emilyFeed3 = await (await fetch(`${BASE}/api/me/notifications`, { headers: { Cookie: emilyCookie } })).json();
  const mutedMentionRow = emilyFeed3.notifications.find((n) => n.url.includes(plainPost.id) && n.category === 'mention');
  assert(!!mutedMentionRow, 'a row still lands for the muted-thread mention (audit trail)');
  assertEq(mutedMentionRow && mutedMentionRow.delivered, false, 'muted-thread mention is not delivered');

  const unmuteRes = await fetch(`${BASE}/api/walls/media-club/posts/${plainPost.id}/mute`, {
    method: 'DELETE', headers: { Cookie: emilyCookie },
  });
  assertEq(unmuteRes.status, 200, 'unmute returns 200');
  assertEq((await unmuteRes.json()).muted, false, 'unmute response reports muted:false');

  // ---- badge clearing ----
  const unseenBefore = await (await fetch(`${BASE}/api/me/notifications?unseen=1`, { headers: { Cookie: emilyCookie } })).json();
  assert(unseenBefore.notifications.length > 0, 'emily has unseen notifications before clearing');
  const seenRes = await fetch(`${BASE}/api/me/notifications/seen`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: emilyCookie },
    body: JSON.stringify({ clearAll: true }),
  });
  assertEq(seenRes.status, 200, 'mark-seen returns 200');
  const unseenAfter = await (await fetch(`${BASE}/api/me/notifications?unseen=1`, { headers: { Cookie: emilyCookie } })).json();
  assertEq(unseenAfter.notifications.length, 0, 'badge is clearable — unseen count drops to 0 after clearAll');

  // ---- non-member cannot see members or set level ----
  const stranger = await fetch(`${BASE}/api/walls/media-club/members`);
  assertEq(stranger.status, 401, 'unauthenticated members fetch returns 401');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
