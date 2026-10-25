#!/usr/bin/env node
// relocation guard for the shoutbox router extraction.
//
// The Shoutbox's HTTP surface (read, write, live SSE feed) moved out of
// server.js into routes/shoutbox.js, and the Hearth chime's timer moved
// into lib/shoutbox.js. This test is the "is it actually wired" half of
// that move: a router module with no production mount is dead code with
// a green checkmark, and the miss-risk here is a household opening the
// shoutbox strip and getting a JSON 404 out of the SPA's fetch.
//
// What this test asserts:
//   1-5. the factory rejects each missing required dep.
//   6.  the factory returns a router function when the deps are complete.
//   7.  GET /api/shoutbox is mounted — 401 unauthenticated, NOT 404.
//   8.  GET /api/shoutbox returns the { shouts, smilies } envelope for a
//       signed-in household member.
//   9.  POST /api/shoutbox returns 201 with the stored shout.
//  10.  GET /api/shoutbox/events streams the SSE preamble and a live
//       shout event — the feed rides the reserved channel.
//  11.  the SSE handler releases its keepalive interval and its
//       wall-events subscription when the request closes (a reconnecting
//       client must not leak one interval per disconnect).
//  12.  the router reads the channel off lib/shoutbox.js (CHANNEL) rather
//       than hardcoding it, so the publish side and the subscribe side
//       cannot drift apart.
//  13.  server.js registers no /api/shoutbox route inline, so the
//       extraction cannot silently regress back into the monolith.
//
// Behavior must not change: scripts/test-shoutbox.js remains the domain's
// own acceptance gate and must stay green with no edits.

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-shoutbox-router-'));
const port = 3263;
process.env.DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = '3263-admin-pw-padding-to-meet-min-32-chars';
process.env.NODE_ENV = 'production';
delete process.env.CALENDAR_CRED_KEY;

const shoutboxRouter = require('../routes/shoutbox');
const shoutbox = require('../lib/shoutbox');

const BASE = `http://127.0.0.1:${port}`;
const asUser = (u) => ({
  'x-authentik-username': u,
  'x-authentik-groups': u === 'admin' ? 'household,admins' : 'household',
});
const call = (user, method, urlPath, body) => fetch(BASE + urlPath, {
  method,
  headers: { ...(user ? asUser(user) : {}), 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

(async () => {
  // 1-5: factory rejects missing required deps.
  assert.throws(() => shoutboxRouter({ auth: () => {}, tokenScopes: () => null, userModel: {}, wallsErr: () => {} }), /db is required/, 'missing db throws');
  assert.throws(() => shoutboxRouter({ db: {}, tokenScopes: () => null, userModel: {}, wallsErr: () => {} }), /auth must be a function/, 'missing auth throws');
  assert.throws(() => shoutboxRouter({ db: {}, auth: () => {}, userModel: {}, wallsErr: () => {} }), /tokenScopes must be a function/, 'missing tokenScopes throws');
  assert.throws(() => shoutboxRouter({ db: {}, auth: () => {}, tokenScopes: () => null, wallsErr: () => {} }), /userModel is required/, 'missing userModel throws');
  assert.throws(() => shoutboxRouter({ db: {}, auth: () => {}, tokenScopes: () => null, userModel: {} }), /wallsErr must be a function/, 'missing wallsErr throws');

  // 6: factory returns a router function with valid deps.
  const fakeRouter = shoutboxRouter({
    db: {},
    auth: () => {},
    tokenScopes: () => null,
    userModel: {},
    wallsErr: () => {},
  });
  assert.equal(typeof fakeRouter, 'function', 'factory returns a router function');

  // 7-10: the real mount, against a booted server.js.
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  try {
    // 7: the route exists (401), it is not a 404 from the catch-all.
    const anon = await call(null, 'GET', '/api/shoutbox');
    assert.equal(anon.status, 401, 'GET /api/shoutbox is mounted (401 unauthenticated, not 404)');

    await call('brandon', 'GET', '/api/me'); // provision the seeded member

    // 8: the read envelope.
    const listResponse = await call('brandon', 'GET', '/api/shoutbox');
    assert.equal(listResponse.status, 200, 'GET /api/shoutbox returns 200');
    const listJson = await listResponse.json();
    assert.ok(Array.isArray(listJson.shouts), 'GET /api/shoutbox returns a { shouts: [...] } envelope');
    assert.ok(listJson.smilies && listJson.smilies[':)'], 'the smilies map still ships');

    // 9: the write path.
    const postResponse = await call('brandon', 'POST', '/api/shoutbox', { body: 'relocation guard' });
    assert.equal(postResponse.status, 201, 'POST /api/shoutbox returns 201');
    const posted = await postResponse.json();
    assert.equal(posted.body, 'relocation guard', 'the shout is stored verbatim');
    assert.equal(posted.author.username, 'brandon', 'the shout is spoken as the human');

    // 10: the live feed — preamble plus a real event.
    const ctrl = new AbortController();
    const sse = await fetch(`${BASE}/api/shoutbox/events`, { headers: asUser('emily'), signal: ctrl.signal });
    assert.equal(sse.status, 200, 'GET /api/shoutbox/events returns 200');
    const reader = sse.body.getReader();
    const dec = new TextDecoder();
    const preamble = dec.decode((await reader.read()).value || new Uint8Array());
    assert.ok(preamble.includes('retry: 3000'), 'the SSE stream opens with the retry preamble');

    await call('brandon', 'POST', '/api/shoutbox', { body: 'live one' });
    let buf = '';
    for (let i = 0; i < 5 && !buf.includes('live one'); i++) {
      const { value } = await reader.read();
      buf += dec.decode(value || new Uint8Array());
    }
    assert.ok(buf.includes('event: shout') && buf.includes('live one'), 'the feed carries the live shout event');
    ctrl.abort();

    // 11: the SSE handler releases its interval and its subscription.
    const routerSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'shoutbox.js'), 'utf8');
    assert.ok(/req\.on\('close'/.test(routerSrc), 'the SSE handler cleans up on request close');
    assert.ok(/clearInterval\(heartbeat\)/.test(routerSrc), 'the keepalive interval is cleared on close');
    assert.ok(/unsubscribe\(\)/.test(routerSrc), 'the wall-events subscription is released on close');

    // 12: one channel, one source of truth.
    assert.equal(shoutbox.CHANNEL, 'shoutbox:household', 'lib/shoutbox.js owns the channel constant');
    assert.ok(!/shoutbox:household/.test(routerSrc), 'the router does not hardcode the channel');
    assert.ok(/shoutbox\.CHANNEL/.test(routerSrc), 'the router subscribes via shoutbox.CHANNEL');

    // 13: no inline registration left in server.js.
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(
      !/app\.(get|post|put|patch|delete)\(\s*'\/api\/shoutbox/.test(serverSrc),
      'server.js registers no /api/shoutbox route inline'
    );

    console.log('routes/shoutbox.js extraction passes (13/13)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
