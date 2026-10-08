#!/usr/bin/env node
// #4098 (parent #4076) acceptance tests for the Shoutbox: post/list,
// /me actions, length cap, banned-phrase filter, rate limit, prune
// (row cap + age), live SSE event, and Hearth's gated chime.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-shout-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3198';
process.env.ADMIN_PASSWORD = 'shout-test-pw';
process.env.BRANDON_PASSWORD = 'shout-test-pw';
process.env.SESSION_SECRET = 'shout-test-secret-padding-to-meet-min-32-chars';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

const BASE = 'http://127.0.0.1:3198';
const asUser = (u) => ({ 'x-authentik-username': u, 'x-authentik-groups': u === 'admin' ? 'household,admins' : 'household' });
const call = (user, method, urlPath, body) => fetch(BASE + urlPath, {
  method,
  headers: { ...(user ? asUser(user) : {}), 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

(async () => {
  const app = require('../server.js');
  await new Promise((resolve) => app.listen(3198, '127.0.0.1', resolve));
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) break; } catch (_) { /* poll */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const db = new Database(path.join(tmpDir, 'life.db'));
  const shoutbox = require('../lib/shoutbox');
  const hearthId = require('../lib/hearth-characters').ensureBuiltinAgentUser(db);
  const userId = (name) => db.prepare('SELECT id FROM users WHERE username = ?').get(name).id;
  await call('brandon', 'GET', '/api/me');
  await call('emily', 'GET', '/api/me');
  const reset = () => db.prepare('DELETE FROM shouts').run();

  console.log('Test 1: post + list');
  {
    assertEq((await call(null, 'GET', '/api/shoutbox')).status, 401, 'unauthenticated list → 401');
    const r = await call('brandon', 'POST', '/api/shoutbox', { body: '  hello house :)  ' });
    assertEq(r.status, 201, 'POST → 201');
    const s = await r.json();
    assertEq(s.body, 'hello house :)', 'body trimmed');
    assertEq(s.kind, 'say', 'kind say');
    assertEq(s.author.username, 'brandon', 'author attached');
    assert(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s.createdAt), 'timestamp present');
    await call('emily', 'POST', '/api/shoutbox', { body: 'hi!' });
    const l = await (await call('emily', 'GET', '/api/shoutbox')).json();
    assertEq(l.shouts.map((x) => x.body), ['hello house :)', 'hi!'], 'list is oldest→newest');
    assertEq(l.smilies[':)'], '🙂', 'smilies map shipped');
    const after = await (await call('emily', 'GET', `/api/shoutbox?after=${l.shouts[0].id}`)).json();
    assertEq(after.shouts.map((x) => x.body), ['hi!'], '?after= returns only newer shouts');
  }

  console.log('\nTest 2: /me actions, validation, banned phrases');
  {
    reset();
    const me = await (await call('brandon', 'POST', '/api/shoutbox', { body: '/me waves' })).json();
    assertEq([me.kind, me.body], ['me', 'waves'], '/me stored as action without the prefix');
    assertEq((await call('brandon', 'POST', '/api/shoutbox', { body: '/me' })).status, 400, 'bare /me → 400');
    assertEq((await call('brandon', 'POST', '/api/shoutbox', { body: '   ' })).status, 400, 'blank → 400');
    assertEq((await call('brandon', 'POST', '/api/shoutbox', {})).status, 400, 'missing body → 400');
    assertEq((await call('brandon', 'POST', '/api/shoutbox', { body: 'x'.repeat(281) })).status, 400, '281 chars → 400');
    assertEq((await call('brandon', 'POST', '/api/shoutbox', { body: 'x'.repeat(280) })).status, 201, '280 chars ok');
    const banned = await call('brandon', 'POST', '/api/shoutbox', { body: 'Great post!!' });
    assertEq(banned.status, 422, 'lexicon phrase → 422');
    assertEq((await banned.json()).error, 'banned_phrase', 'error code banned_phrase');
  }

  console.log('\nTest 3: rate limit');
  {
    reset();
    let last;
    for (let i = 0; i < 6; i++) last = await call('brandon', 'POST', '/api/shoutbox', { body: `m${i}` });
    assertEq(last.status, 429, '6th shout in the window → 429');
    assertEq((await call('emily', 'POST', '/api/shoutbox', { body: 'still fine' })).status, 201, 'limit is per user');
    const later = new Date(Date.now() + 31000);
    assertEq(shoutbox.post(userId('brandon'), 'after window', { now: later }).body, 'after window', 'window expires');
  }

  console.log('\nTest 4: prune');
  {
    reset();
    const ins = db.prepare('INSERT INTO shouts (user_id, body, created_at) VALUES (?, ?, ?)');
    const bid = userId('brandon');
    for (let i = 0; i < 205; i++) ins.run(bid, `n${i}`, `2099-01-01 00:00:${String(i % 60).padStart(2, '0')}`);
    const removed = shoutbox.prune(new Date('2099-01-02T00:00:00Z'));
    assertEq(removed, 5, 'row cap removes the 5 oldest');
    assertEq(db.prepare('SELECT COUNT(*) c FROM shouts').get().c, 200, '200 remain');
    ins.run(bid, 'ancient', '2098-12-01 00:00:00');
    shoutbox.prune(new Date('2099-01-02T00:00:00Z'));
    assertEq(db.prepare("SELECT COUNT(*) c FROM shouts WHERE body = 'ancient'").get().c, 0, '>7-day-old row removed');
    reset();
    shoutbox.post(bid, 'trigger', { now: new Date() });
    ins.run(bid, 'old', '2000-01-01 00:00:00');
    shoutbox.post(userId('emily'), 'posting prunes', { now: new Date() });
    assertEq(db.prepare("SELECT COUNT(*) c FROM shouts WHERE body = 'old'").get().c, 0, 'post() prunes opportunistically');
  }

  console.log('\nTest 5: live SSE event');
  {
    reset();
    const ctrl = new AbortController();
    const res = await fetch(BASE + '/api/shoutbox/events', { headers: asUser('emily'), signal: ctrl.signal });
    assertEq(res.status, 200, 'SSE connects');
    const reader = res.body.getReader();
    await reader.read(); // retry/connected preamble
    await call('brandon', 'POST', '/api/shoutbox', { body: 'live one' });
    let buf = '';
    const dec = new TextDecoder();
    for (let i = 0; i < 5 && !buf.includes('live one'); i++) {
      const { value } = await reader.read();
      buf += dec.decode(value || new Uint8Array());
    }
    assert(buf.includes('event: shout') && buf.includes('live one'), 'subscriber receives the shout');
    ctrl.abort();
  }

  console.log('\nTest 6: Hearth chime gate');
  {
    const now = new Date();
    const always = () => 0;
    const draft = async () => 'the kettle approves of this conversation';
    reset();
    assertEq((await shoutbox.hearthChime({ now, rng: always, draft })).skipped, 'empty_room', 'empty box → silent');
    shoutbox.post(userId('brandon'), 'anyone home?', { now });
    const r = await shoutbox.hearthChime({ now, rng: always, draft });
    assertEq(r.body, 'the kettle approves of this conversation', 'chimes after a human shout');
    assertEq(r.author.isAgent, true, 'author flagged as agent');
    assertEq(db.prepare('SELECT user_id FROM shouts ORDER BY id DESC LIMIT 1').get().user_id, hearthId, 'stored under Hearth');
    assertEq((await shoutbox.hearthChime({ now, rng: always, draft })).skipped, 'already_last_voice', 'never twice in a row');
    shoutbox.post(userId('emily'), 'ha', { now });
    assertEq((await shoutbox.hearthChime({ now, rng: always, draft })).skipped, 'too_soon', 'min gap enforced');
    const later = new Date(now.getTime() + 3 * 3600000);
    assertEq((await shoutbox.hearthChime({ now: later, rng: always, draft })).skipped, 'nobody_talking', 'stale room → silent');
    reset();
    shoutbox.post(userId('brandon'), 'hello', { now });
    assertEq((await shoutbox.hearthChime({ now, rng: () => 0.99, draft })).skipped, 'dice', 'dice can say no');
    reset();
    shoutbox.post(userId('brandon'), 'hello', { now });
    const bad = await shoutbox.hearthChime({ now, rng: always, draft: async () => 'great post' });
    assertEq(bad.skipped, 'draft_rejected', 'banned-phrase draft is dropped');
    const fb = await shoutbox.hearthChime({ now, rng: always, draft: async () => { throw new Error('no key'); } });
    assert(fb.body && fb.author.isAgent, 'draft failure falls back to a canned in-voice line');
    // daily cap
    reset();
    const ins = db.prepare('INSERT INTO shouts (user_id, body, created_at) VALUES (?, ?, ?)');
    const ago = (h) => new Date(now.getTime() - h * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    for (const h of [20, 16, 12, 8]) ins.run(hearthId, 'h', ago(h));
    shoutbox.post(userId('brandon'), 'talking', { now });
    assertEq((await shoutbox.hearthChime({ now, rng: always, draft })).skipped, 'daily_cap', 'daily cap enforced');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
