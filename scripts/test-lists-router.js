#!/usr/bin/env node
// relocation guard for the lists router extraction.
//
// The household lists API (lists + their items) moved out of server.js
// into routes/lists.js. This test is the "is it actually wired" half of
// that move: a router module with no production mount is dead code with
// a green checkmark, and the miss-risk here is a household opening the
// lists tab and getting a JSON 404 out of the SPA's fetch.
//
// What this test asserts:
//   1-5. the factory rejects each missing required dep.
//   6.  the factory returns a router function when the deps are complete.
//   7.  GET /api/lists is mounted — 401 unauthenticated, NOT 404.
//   8.  GET /api/lists returns the { lists: [...] } envelope for a
//       signed-in household member.
//   9.  GET /api/lists/stats returns the stats envelope. This also
//       proves the route ORDER survived the move: a /lists/stats
//       registered after /lists/:id would be captured as a list id.
//  10.  POST /api/lists creates a list (201), GET /api/lists/:id/items
//       reads its items and POST /api/lists/:id/items adds one — the item
//       routes are mounted under /api too, with the same byte-identical
//       paths as before the extraction.
//  11.  server.js registers no /api/lists route inline, so the
//       extraction cannot silently regress back into the monolith.
//
// Behavior must not change: scripts/test-lists.js remains the domain's
// own acceptance gate and must stay green with no edits.

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-lists-router-'));
const port = 3262;
process.env.DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = '3262-admin-pw-padding-to-meet-min-32-chars';
process.env.NODE_ENV = 'production';
delete process.env.CALENDAR_CRED_KEY;

const listsRouter = require('../routes/lists');

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
  assert.throws(() => listsRouter({ auth: () => {}, requireScope: () => () => {}, userModel: {}, lists: {} }), /db is required/, 'missing db throws');
  assert.throws(() => listsRouter({ db: {}, requireScope: () => () => {}, userModel: {}, lists: {} }), /auth must be a function/, 'missing auth throws');
  assert.throws(() => listsRouter({ db: {}, auth: () => {}, userModel: {}, lists: {} }), /requireScope must be a function/, 'missing requireScope throws');
  assert.throws(() => listsRouter({ db: {}, auth: () => {}, requireScope: () => () => {}, lists: {} }), /userModel is required/, 'missing userModel throws');
  assert.throws(() => listsRouter({ db: {}, auth: () => {}, requireScope: () => () => {}, userModel: {} }), /lists is required/, 'missing lists throws');

  // 6: factory returns a router function with valid deps.
  const fakeRouter = listsRouter({
    db: {},
    auth: () => {},
    requireScope: () => () => {},
    userModel: {},
    lists: {},
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
    const anon = await call(null, 'GET', '/api/lists');
    assert.equal(anon.status, 401, 'GET /api/lists is mounted (401 unauthenticated, not 404)');

    // provision the seeded household member through the trusted header
    await call('brandon', 'GET', '/api/me');

    // 8: the read envelope.
    const listsResponse = await call('brandon', 'GET', '/api/lists');
    assert.equal(listsResponse.status, 200, 'GET /api/lists returns 200');
    const listsJson = await listsResponse.json();
    assert.ok(Array.isArray(listsJson.lists), 'GET /api/lists returns a { lists: [...] } envelope');

    // 9: the stats route is not swallowed by /lists/:id.
    const statsResponse = await call('brandon', 'GET', '/api/lists/stats');
    assert.equal(statsResponse.status, 200, 'GET /api/lists/stats returns 200');
    const statsJson = await statsResponse.json();
    assert.equal(typeof statsJson.list_count, 'number', 'GET /api/lists/stats returns the stats envelope');
    assert.ok(Array.isArray(statsJson.active_lists), 'stats envelope carries active_lists');

    // 10: create + item routes.
    const createResponse = await call('brandon', 'POST', '/api/lists', { name: 'relocation guard' });
    assert.equal(createResponse.status, 201, 'POST /api/lists returns 201');
    const created = await createResponse.json();
    assert.ok(created.id, 'created list carries an id');

    const itemsResponse = await call('brandon', 'GET', `/api/lists/${created.id}/items`);
    assert.equal(itemsResponse.status, 200, 'GET /api/lists/:id/items returns 200');
    assert.ok(Array.isArray((await itemsResponse.json()).items), 'items envelope carries an array');

    // `label` is the item's text field (lib/lists.js addItem) — `title`
    // would 400 with label_required, so the guard proves the body is
    // passed through to the domain untouched.
    const addItem = await call('brandon', 'POST', `/api/lists/${created.id}/items`, { label: 'milk' });
    assert.equal(addItem.status, 201, 'POST /api/lists/:id/items returns 201');
    const item = await addItem.json();
    assert.ok(item.id, 'created item carries an id');

    const delItem = await call('brandon', 'DELETE', `/api/list-items/${item.id}`);
    assert.equal(delItem.status, 200, 'DELETE /api/list-items/:itemId returns 200');

    // 11: no inline /api/lists registration left in server.js.
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    assert.ok(
      !/app\.(get|post|put|patch|delete)\(\s*'\/api\/lists/.test(serverSrc),
      'server.js registers no /api/lists route inline'
    );

    console.log('routes/lists.js extraction passes (11/11)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
