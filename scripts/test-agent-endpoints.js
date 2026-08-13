#!/usr/bin/env node
// PHA-1617.4 acceptance tests for lib/agent-endpoints.js.
//
// Drives `lib/agent-endpoints.js` directly against a temp SQLite file
// (plus a supertest-free HTTP integration test of the /api/agent-endpoints
// routes against a live server.js instance on an ephemeral port).
// No mocking.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const agentEndpoints = require('../lib/agent-endpoints');

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

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-eps-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  agentEndpoints.migrate(db);
  return { db, tmpDir };
}

console.log('PHA-1617.4 agent-endpoints tests\n');

// ---- Test 1: create() returns HMAC secret plaintext once ----
{
  console.log('Test 1: create() returns HMAC secret plaintext + schema fields');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const created = agentEndpoints.create(db, brandon.id, {
    harnessLabel: 'Laptop OpenClaw',
    kind: 'drawer',
    url: 'http://phattvip.lan:18789/webhook/homestead-drawer',
  });
  assert(!!created.secret_plaintext, 'secret_plaintext present on insert');
  assert(created.secret_plaintext.startsWith('homestead_aes_'), 'secret carries homestead_aes_ prefix');
  assertEq(created.secret_plaintext.length, agentEndpoints.SECRET_PLAINTEXT_LEN, `secret is ${agentEndpoints.SECRET_PLAINTEXT_LEN} chars`);
  assertEq(created.harness_label, 'Laptop OpenClaw', 'harness_label round-trips');
  assertEq(created.kind, 'drawer', 'kind round-trips');
  assertEq(created.url, 'http://phattvip.lan:18789/webhook/homestead-drawer', 'url round-trips');
  assertEq(created.enabled, true, 'enabled defaults to true');
  assertEq(created.event_filter, {}, 'event_filter defaults to {}');
  assert(!!created.secret_prefix, 'secret_prefix chip present');
  assert(!created.secret_prefix.includes('homestead_aes_'.slice(0, -1)) || created.secret_prefix.endsWith('…'), 'secret_prefix is a redacted chip');

  const row = db.prepare('SELECT * FROM agent_endpoints WHERE id = ?').get(created.id);
  assertEq(row.secret, created.secret_plaintext, 'DB persisted the secret plaintext');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: list() never leaks the secret plaintext ----
{
  console.log('\nTest 2: list() is metadata-only, never leaks the secret');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  agentEndpoints.create(db, brandon.id, { harnessLabel: 'A', kind: 'drawer', url: 'http://a.example/x' });
  agentEndpoints.create(db, brandon.id, { harnessLabel: 'B', kind: 'events', url: 'https://b.example/hook' });
  agentEndpoints.create(db, emily.id, { harnessLabel: 'C', kind: 'drawer', url: 'http://c.example/d' });

  const brandonList = agentEndpoints.list(db, brandon.id);
  assertEq(brandonList.length, 2, 'brandon has 2 endpoints');
  assert(brandonList.every(e => !('secret_plaintext' in e)), 'list() never exposes secret_plaintext');
  assert(brandonList.every(e => !('secret' in e)), 'list() never exposes the raw secret column');

  const emilyList = agentEndpoints.list(db, emily.id);
  assertEq(emilyList.length, 1, 'emily has 1 endpoint');

  const allList = agentEndpoints.list(db, null);
  assertEq(allList.length, 3, 'admin list (userId=null) sees all endpoints');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 3: get() with includeSecretPlaintext is owner-scoped ----
{
  console.log('\nTest 3: get() includes secret only on owner-scoped request');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  const created = agentEndpoints.create(db, brandon.id, { harnessLabel: 'G', kind: 'drawer', url: 'http://g.example/x' });

  const ownerGet = agentEndpoints.get(db, created.id, { ownerUserId: brandon.id, includeSecretPlaintext: true });
  assert(!!ownerGet, 'owner get returns the row');
  assertEq(ownerGet.secret_plaintext, created.secret_plaintext, 'owner get includes the secret plaintext');

  const ownerGetMeta = agentEndpoints.get(db, created.id, { ownerUserId: brandon.id });
  assert(!('secret_plaintext' in ownerGetMeta), 'owner get without includeSecretPlaintext has no secret_plaintext');

  const wrongOwnerGet = agentEndpoints.get(db, created.id, { ownerUserId: emily.id, includeSecretPlaintext: true });
  assertEq(wrongOwnerGet, null, 'non-owner get returns null even with includeSecretPlaintext');

  const adminGet = agentEndpoints.get(db, created.id, { includeSecretPlaintext: true });
  assert(!('secret_plaintext' in adminGet), 'admin get (no ownerUserId) never exposes secret_plaintext');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 4: update() patches fields, rotate_secret returns new plaintext ----
{
  console.log('\nTest 4: update() patches fields and rotates the secret');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  const created = agentEndpoints.create(db, brandon.id, {
    harnessLabel: 'old-label',
    kind: 'drawer',
    url: 'http://old.example/x',
    eventFilter: {},
  });

  const updated = agentEndpoints.update(db, created.id, {
    harnessLabel: 'new-label',
    url: 'https://new.example/hook',
    enabled: false,
    eventFilter: { task_created: true },
  }, { ownerUserId: brandon.id });
  assertEq(updated.harness_label, 'new-label', 'harness_label updated');
  assertEq(updated.url, 'https://new.example/hook', 'url updated');
  assertEq(updated.enabled, false, 'enabled flipped to false');
  assertEq(updated.event_filter, { task_created: true }, 'event_filter updated');
  assert(!('secret_plaintext' in updated), 'non-rotate update does not return a fresh secret');

  const noOwnerUpdate = agentEndpoints.update(db, created.id, { harnessLabel: 'hijack' }, { ownerUserId: emily.id });
  assertEq(noOwnerUpdate, null, 'update() refuses when ownerUserId does not match');

  const rotated = agentEndpoints.update(db, created.id, {}, { ownerUserId: brandon.id, rotateSecret: true });
  assert(!!rotated.secret_plaintext, 'rotate returns a fresh secret_plaintext');
  assert(rotated.secret_plaintext !== created.secret_plaintext, 'fresh secret differs from the prior one');
  assertEq(rotated.harness_label, 'new-label', 'rotate preserves the prior harness_label');
  assertEq(rotated.event_filter, { task_created: true }, 'rotate preserves the prior event_filter');

  const row = db.prepare('SELECT secret FROM agent_endpoints WHERE id = ?').get(created.id);
  assertEq(row.secret, rotated.secret_plaintext, 'DB now holds the rotated secret');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 5: remove() deletes (owner-scoped) ----
{
  console.log('\nTest 5: remove() deletes with owner scoping');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  const created = agentEndpoints.create(db, brandon.id, { harnessLabel: 'R', kind: 'drawer', url: 'http://r.example/x' });

  const wrongOwner = agentEndpoints.remove(db, created.id, { ownerUserId: emily.id });
  assertEq(wrongOwner, false, 'remove() refuses when ownerUserId does not match');

  const removed = agentEndpoints.remove(db, created.id, { ownerUserId: brandon.id });
  assertEq(removed, true, 'remove() succeeds for the owning user');

  const after = db.prepare('SELECT id FROM agent_endpoints WHERE id = ?').get(created.id);
  assertEq(after, undefined, 'row is gone after remove()');

  const reRemove = agentEndpoints.remove(db, created.id, { ownerUserId: brandon.id });
  assertEq(reRemove, false, 'remove() is idempotent: returns false on missing');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 6: validation — label, kind, url, event_filter ----
{
  console.log('\nTest 6: input validation rejects malformed inputs');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');

  // Empty label
  let threw = false;
  try { agentEndpoints.create(db, brandon.id, { harnessLabel: '', kind: 'drawer', url: 'http://x.example/x' }); }
  catch (e) { threw = /label required/i.test(e.message); }
  assert(threw, 'empty harness_label is rejected');

  // Whitespace-only label
  threw = false;
  try { agentEndpoints.create(db, brandon.id, { harnessLabel: '   ', kind: 'drawer', url: 'http://x.example/x' }); }
  catch (e) { threw = /label required/i.test(e.message); }
  assert(threw, 'whitespace-only harness_label is rejected');

  // Oversized label
  threw = false;
  try { agentEndpoints.create(db, brandon.id, { harnessLabel: 'x'.repeat(129), kind: 'drawer', url: 'http://x.example/x' }); }
  catch (e) { threw = /too long/i.test(e.message); }
  assert(threw, 'oversized harness_label is rejected');

  // Bad kind
  threw = false;
  try { agentEndpoints.create(db, brandon.id, { harnessLabel: 'L', kind: 'websocket', url: 'http://x.example/x' }); }
  catch (e) { threw = /kind must be/.test(e.message); }
  assert(threw, 'invalid kind is rejected');

  // Bad URL
  threw = false;
  try { agentEndpoints.create(db, brandon.id, { harnessLabel: 'L', kind: 'drawer', url: 'not-a-url' }); }
  catch (e) { threw = /url must be/.test(e.message); }
  assert(threw, 'non-URL is rejected');

  // Empty URL
  threw = false;
  try { agentEndpoints.create(db, brandon.id, { harnessLabel: 'L', kind: 'drawer', url: '' }); }
  catch (e) { threw = /url must be/.test(e.message); }
  assert(threw, 'empty URL is rejected');

  // Non-string URL
  threw = false;
  try { agentEndpoints.create(db, brandon.id, { harnessLabel: 'L', kind: 'drawer', url: 42 }); }
  catch (e) { threw = /url must be/.test(e.message); }
  assert(threw, 'numeric URL is rejected');

  // Bad event_filter (array)
  threw = false;
  try { agentEndpoints.create(db, brandon.id, { harnessLabel: 'L', kind: 'events', url: 'http://x.example/x', eventFilter: [1,2,3] }); }
  catch (e) { threw = /event_filter must be/.test(e.message); }
  assert(threw, 'array event_filter is rejected');

  // Bad event_filter (string that's not JSON)
  threw = false;
  try { agentEndpoints.create(db, brandon.id, { harnessLabel: 'L', kind: 'events', url: 'http://x.example/x', eventFilter: 'not-json' }); }
  catch (e) { threw = /event_filter must be/.test(e.message); }
  assert(threw, 'non-JSON string event_filter is rejected');

  // Canonical event_filter forms
  const objOk = agentEndpoints.create(db, brandon.id, { harnessLabel: 'L', kind: 'events', url: 'http://x.example/x', eventFilter: { task_created: true } });
  assertEq(objOk.event_filter, { task_created: true }, 'object event_filter is accepted');
  const jsonOk = agentEndpoints.create(db, brandon.id, { harnessLabel: 'L2', kind: 'events', url: 'http://y.example/x', eventFilter: '{"chore_rotated":true}' });
  assertEq(jsonOk.event_filter, { chore_rotated: true }, 'JSON-string event_filter is accepted');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 7: HMAC signing matches design doc §6.4 spec ----
{
  console.log('\nTest 7: signPayload() implements doc §6.4 HMAC contract');
  const secret = 'homestead_aes_' + 'x'.repeat(43);
  const ts = '2026-08-12T01:00:00.000Z';
  const body = '{"hello":"world"}';
  const ours = agentEndpoints.signPayload(secret, ts, body);

  // Independently compute the expected digest.
  const h = crypto.createHmac('sha256', secret);
  h.update(ts);
  h.update('.');
  h.update(body);
  const expected = 'sha256=' + h.digest('hex');
  assertEq(ours, expected, 'signPayload matches an independent HMAC-SHA256 computation');

  // Running with a different body must produce a different signature.
  const other = agentEndpoints.signPayload(secret, ts, '{"different":true}');
  assert(ours !== other, 'signing a different body produces a different signature');

  // A different timestamp also changes the signature (the spec signs `ts.body`).
  const otherTs = agentEndpoints.signPayload(secret, '2026-08-12T01:00:01.000Z', body);
  assert(ours !== otherTs, 'signing with a different timestamp produces a different signature');

  // Empty body is treated as the empty string (not null).
  const empty = agentEndpoints.signPayload(secret, ts, '');
  const nullBody = agentEndpoints.signPayload(secret, ts, null);
  assertEq(empty, nullBody, 'signPayload treats empty body and null body identically');
}

// ---- Test 8: listEnabledForDispatch + recordDispatch bookkeeping ----
{
  console.log('\nTest 8: listEnabledForDispatch + recordDispatch bookkeeping');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const enabled = agentEndpoints.create(db, brandon.id, { harnessLabel: 'on', kind: 'drawer', url: 'http://on.example/x', enabled: true });
  const off = agentEndpoints.create(db, brandon.id, { harnessLabel: 'off', kind: 'drawer', url: 'http://off.example/x', enabled: false });

  const dispatch = agentEndpoints.listEnabledForDispatch(db, brandon.id, 'drawer');
  assertEq(dispatch.length, 1, 'only the enabled row is returned to the dispatcher');
  assertEq(dispatch[0].id, enabled.id, 'the enabled row is the one returned');
  assert(!!dispatch[0].secret, 'dispatch rows include the secret (the dispatcher needs it to HMAC-sign)');

  agentEndpoints.recordDispatch(db, enabled.id, { statusCode: 200, error: null });
  const after = db.prepare('SELECT last_used_at, last_status_code, last_error FROM agent_endpoints WHERE id = ?').get(enabled.id);
  assert(!!after.last_used_at, 'last_used_at populated');
  assertEq(after.last_status_code, 200, 'last_status_code recorded');
  assertEq(after.last_error, null, 'last_error null on success');

  agentEndpoints.recordDispatch(db, enabled.id, { statusCode: 502, error: 'connection refused' });
  const afterFail = db.prepare('SELECT last_status_code, last_error FROM agent_endpoints WHERE id = ?').get(enabled.id);
  assertEq(afterFail.last_status_code, 502, 'last_status_code retains the most recent value');
  assertEq(afterFail.last_error, 'connection refused', 'last_error recorded on failure');

  const wrongKind = agentEndpoints.listEnabledForDispatch(db, brandon.id, 'events');
  assertEq(wrongKind.length, 0, 'kind filter is respected');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 9: HTTP integration — full CRUD via /api/agent-endpoints ----
{
  console.log('\nTest 9: server.js CRUD routes for /api/agent-endpoints');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-eps-http-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '0';
  delete require.cache[require.resolve('../server.js')];
  const app = require('../server.js');

  const server = http.createServer(app);
  const startPromise = new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const request = (opts, body) => new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* */ }
        resolve({ status: res.statusCode, body: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

  startPromise.then(async () => {
    const port = server.address().port;
    const base = { hostname: '127.0.0.1', port };

    // Log in as brandon over a session.
    const loginRes = await request({
      ...base, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { username: 'brandon', password: process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme' });
    const cookie = (loginRes.headers['set-cookie'] || [])[0];
    assert(loginRes.status === 200, 'login as brandon succeeds', JSON.stringify(loginRes.body));

    // Create an endpoint.
    const createRes = await request({
      ...base, path: '/api/agent-endpoints', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { harness_label: 'Laptop OpenClaw', kind: 'drawer', url: 'http://phattvip.lan:18789/webhook/homestead-drawer' });
    assertEq(createRes.status, 200, 'POST /api/agent-endpoints creates a row');
    assert(!!createRes.body && !!createRes.body.secret_plaintext, 'response carries secret_plaintext once');
    const created = createRes.body;
    const endpointId = created.id;

    // List own endpoints.
    const listRes = await request({
      ...base, path: '/api/agent-endpoints', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(listRes.status, 200, 'GET /api/agent-endpoints lists own endpoints');
    assertEq(listRes.body.length, 1, 'one endpoint in list');
    assert(!('secret_plaintext' in listRes.body[0]), 'list response does not leak secret_plaintext');

    // PATCH — flip enabled, then re-rotate the secret.
    const patchRes = await request({
      ...base, path: `/api/agent-endpoints/${endpointId}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { enabled: false });
    assertEq(patchRes.status, 200, 'PATCH /api/agent-endpoints/:id updates');
    assertEq(patchRes.body.enabled, false, 'enabled flipped to false');

    const rotateRes = await request({
      ...base, path: `/api/agent-endpoints/${endpointId}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { rotate_secret: true });
    assertEq(rotateRes.status, 200, 'PATCH rotate_secret=true succeeds');
    assert(!!rotateRes.body.secret_plaintext, 'rotate returns a fresh secret_plaintext');
    assert(rotateRes.body.secret_plaintext !== created.secret_plaintext, 'fresh secret differs from the prior one');

    // Cross-user PATCH refused.
    const otherPatch = await request({
      ...base, path: `/api/agent-endpoints/${endpointId}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { harness_label: 'hijack' });
    assertEq(otherPatch.status, 200, 'owner can still update their own row');
    assertEq(otherPatch.body.harness_label, 'hijack', 'harness_label updated');

    // DELETE.
    const delRes = await request({
      ...base, path: `/api/agent-endpoints/${endpointId}`, method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assertEq(delRes.status, 200, 'DELETE /api/agent-endpoints/:id removes the row');

    const listAfter = await request({
      ...base, path: '/api/agent-endpoints', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(listAfter.body.length, 0, 'list is empty after delete');

    // Bad inputs return 400.
    const badKind = await request({
      ...base, path: '/api/agent-endpoints', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { harness_label: 'X', kind: 'websocket', url: 'http://x.example/x' });
    assertEq(badKind.status, 400, 'invalid kind returns 400');

    const badUrl = await request({
      ...base, path: '/api/agent-endpoints', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { harness_label: 'X', kind: 'drawer', url: 'not-a-url' });
    assertEq(badUrl.status, 400, 'bad URL returns 400');

    const missingLabel = await request({
      ...base, path: '/api/agent-endpoints', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { harness_label: '', kind: 'drawer', url: 'http://x.example/x' });
    assertEq(missingLabel.status, 400, 'empty label returns 400');

    // Unauthenticated POST is rejected with 401.
    const unauth = await request({
      ...base, path: '/api/agent-endpoints', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { harness_label: 'X', kind: 'drawer', url: 'http://x.example/x' });
    assertEq(unauth.status, 401, 'unauthenticated POST returns 401');

    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    finish();
  }).catch(err => {
    ng('HTTP integration test crashed', err.stack || err.message);
    try { server.close(); } catch (_) {}
    finish();
  });
}

function finish() {
  console.log(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
