#!/usr/bin/env node
// PHATT ID assertion auth layer (`Authorization: PhattId <assertion>`).
//
// Two layers, same shape as test-agent-tokens.js:
//   * direct calls into lib/phatt-id.js (verifier, key store, route table)
//   * HTTP round trips against a live server.js with a test Ed25519
//     keypair pinned via PHATTID_HUB_KEY.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const phattId = require('../lib/phatt-id');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { privateKey, x: publicKey.export({ format: 'jwk' }).x };
}
const AUD = 'life.phatt.vip';
function mint(privateKey, claims) {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto.sign(null, Buffer.from('pa1.' + body), privateKey).toString('base64url');
  return `pa1.${body}.${sig}`;
}
function claimsFor(username, over) {
  const now = Math.floor(Date.now() / 1000);
  return Object.assign({
    sub: `uuid-${username}`, member: true, username, name: username, aud: AUD, iat: now, exp: now + 300,
  }, over || {});
}

const K = keypair();
const OTHER = keypair();

console.log('PHATT ID assertion tests\n');

// ---- Test 1: verifyAssertion (pure) ----
{
  console.log('Test 1: verifyAssertion()');
  const pk = { x: K.x };
  const good = mint(K.privateKey, claimsFor('brandon'));
  assertEq(phattId.verifyAssertion(good, pk, { aud: AUD }).username, 'brandon', 'valid assertion verifies');
  assertEq(phattId.verifyAssertion(good, pk, { aud: 'other.phatt.vip' }), null, 'wrong aud rejected');
  assertEq(phattId.verifyAssertion(mint(K.privateKey, claimsFor('brandon', { exp: Math.floor(Date.now() / 1000) - 1 })), pk, { aud: AUD }), null, 'expired rejected');
  assertEq(phattId.verifyAssertion(mint(K.privateKey, claimsFor('brandon', { iat: Math.floor(Date.now() / 1000) + 120 })), pk, { aud: AUD }), null, 'iat > now+60 rejected');
  assertEq(phattId.verifyAssertion(mint(OTHER.privateKey, claimsFor('brandon')), pk, { aud: AUD }), null, 'wrong key rejected');
  assertEq(phattId.verifyAssertion(mint(K.privateKey, claimsFor('brandon', { sub: '' })), pk, { aud: AUD }), null, 'missing sub rejected');
  const [, , sig] = good.split('.');
  const tamperedBody = Buffer.from(JSON.stringify(claimsFor('admin'))).toString('base64url');
  assertEq(phattId.verifyAssertion(`pa1.${tamperedBody}.${sig}`, pk, { aud: AUD }), null, 'tampered body rejected');
  assertEq(phattId.verifyAssertion(good.replace(/^pa1/, 'pa2'), pk, { aud: AUD }), null, 'wrong prefix rejected');
  assertEq(phattId.verifyAssertion('pa1.e30.' + 'A'.repeat(10), pk, { aud: AUD }), null, 'garbage signature rejected without throwing');
  assertEq(phattId.verifyAssertion(good, { x: 'not-a-key' }, { aud: AUD }), null, 'malformed key rejected without throwing');
}

// ---- Test 2: config + route table ----
{
  console.log('\nTest 2: config() and requiredScope()');
  assertEq(phattId.config({}), null, 'off when neither PHATTID_HUB_URL nor PHATTID_HUB_KEY set');
  const c = phattId.config({ PHATTID_HUB_KEY: 'x' });
  assertEq(c.aud, 'life.phatt.vip', 'PHATTID_AUD defaults to life.phatt.vip');
  assertEq(c.scopes, ['read:me', 'read:lists', 'write:lists', 'read:tasks', 'write:tasks', 'read:events'], 'default scope list');
  assertEq(phattId.config({ PHATTID_HUB_KEY: 'x', PHATTID_SCOPES: 'read:lists, read:tasks' }).scopes, ['read:lists', 'read:tasks'], 'PHATTID_SCOPES overrides');
  assertEq(phattId.requiredScope('PATCH', '/api/list-items/abc'), 'write:lists', 'PATCH list item -> write:lists');
  assertEq(phattId.requiredScope('POST', '/api/tasks/7/toggle'), 'write:tasks', 'toggle -> write:tasks');
  assertEq(phattId.requiredScope('GET', '/api/events/merged?from=a&to=b'), 'read:events', 'merged -> read:events (query ignored)');
  assertEq(phattId.requiredScope('POST', '/api/events'), null, 'POST /api/events not in table');
  assertEq(phattId.requiredScope('GET', '/api/admin/owner/login-paths'), null, 'admin route not in table');
  assertEq(phattId.requiredScope('GET', '/api/tasks/7/../../admin'), null, 'dot-segment path not in table');
}

// ---- Test 3: key store fetch + cache ----
async function keyStoreTest() {
  console.log('\nTest 3: createKeyStore() fetches, caches, and rate-limits refetch');
  let calls = 0;
  const store = phattId.createKeyStore({
    fetchImpl: async (url) => {
      calls++;
      assertEq(url, 'https://hub.example.test/auth/phatt-id/key', 'fetches <hub>/auth/phatt-id/key');
      return { ok: true, json: async () => ({ alg: 'Ed25519', kid: 'k1', x: K.x }) };
    },
  });
  const cfg = phattId.config({ PHATTID_HUB_URL: 'https://hub.example.test/' });
  const c1 = await store.verify(mint(K.privateKey, claimsFor('brandon')), cfg);
  assertEq(c1 && c1.username, 'brandon', 'verifies with fetched key');
  await store.verify(mint(K.privateKey, claimsFor('emily')), cfg);
  assertEq(calls, 1, 'second verify uses the cached key');
  const bad = await store.verify(mint(OTHER.privateKey, claimsFor('brandon')), cfg);
  assertEq(bad, null, 'unknown-key assertion rejected');
  assertEq(calls, 1, 'verify failure does not refetch within a minute of the last fetch');
}

// ---- Test 4: HTTP integration ----
async function httpTest() {
  console.log('\nTest 4: server.js authenticate() PhattId layer end-to-end');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-phattid-http-'));
  process.env.DATA_DIR = tmpDir;
  process.env.PORT = '0';
  process.env.PHATTID_HUB_KEY = K.x;
  delete process.env.PHATTID_HUB_URL;
  delete process.env.PHATTID_AUD;
  delete process.env.PHATTID_SCOPES;
  delete process.env.HUB_PHATTID_ISSUER;
  delete require.cache[require.resolve('../server.js')];
  const app = require('../server.js');
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const db = new Database(path.join(tmpDir, 'life.db'));

  const request = (method, p, { token, headers, body } = {}) => new Promise((resolve, reject) => {
    const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
    if (token) h.Authorization = `PhattId ${token}`;
    const req = http.request({ hostname: '127.0.0.1', port, path: p, method, headers: h }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
  const noCookie = (r, label) => assert(!r.headers['set-cookie'], `${label}: no Set-Cookie`, JSON.stringify(r.headers['set-cookie']));

  try {
    const tok = mint(K.privateKey, claimsFor('brandon'));

    // read:me
    const snap = await request('GET', '/api/me/snapshot', { token: tok });
    assertEq(snap.status, 200, 'GET /api/me/snapshot 200');
    noCookie(snap, 'snapshot');

    // lists
    const created = await request('POST', '/api/lists', { token: tok, body: { name: 'Groceries', kind: 'groceries' } });
    assertEq(created.status, 201, 'POST /api/lists 201');
    const listId = created.body && created.body.id;
    const item = await request('POST', `/api/lists/${listId}/items`, { token: tok, body: { label: 'Milk' } });
    assertEq(item.status, 201, 'POST /api/lists/:id/items 201');
    const lists = await request('GET', '/api/lists', { token: tok });
    assertEq(lists.status, 200, 'GET /api/lists 200');
    const items = await request('GET', `/api/lists/${listId}/items`, { token: tok });
    assertEq(items.status, 200, 'GET /api/lists/:id/items 200');
    const patched = await request('PATCH', `/api/list-items/${item.body.id}`, { token: tok, body: { checked: true } });
    assertEq(patched.status, 200, 'PATCH /api/list-items/:id 200');
    const brandonId = db.prepare("SELECT id FROM users WHERE username = 'brandon'").get().id;
    assertEq(db.prepare('SELECT checked, checked_by FROM list_items WHERE id = ?').get(item.body.id), { checked: 1, checked_by: brandonId }, 'item checked as brandon');
    noCookie(patched, 'list item PATCH');

    // tasks
    const taskId = db.prepare("INSERT INTO tasks (title, assignee, created_by) VALUES ('Dishes', 'brandon', 'admin')").run().lastInsertRowid;
    const tasks = await request('GET', '/api/tasks', { token: tok });
    assertEq(tasks.status, 200, 'GET /api/tasks 200');
    const toggled = await request('POST', `/api/tasks/${taskId}/toggle`, { token: tok });
    assertEq(toggled.status, 200, 'POST /api/tasks/:id/toggle 200');
    assertEq(toggled.body && [toggled.body.done, toggled.body.done_by], [1, 'brandon'], 'task done_by brandon');

    // events
    const ev = await request('GET', '/api/events/merged?from=2026-01-01&to=2026-12-31', { token: tok });
    assertEq(ev.status, 200, 'GET /api/events/merged 200');
    noCookie(ev, 'events merged');

    // verification failures
    const now = Math.floor(Date.now() / 1000);
    const bad = {
      'wrong aud': mint(K.privateKey, claimsFor('brandon', { aud: 'arcade.phatt.vip' })),
      'expired': mint(K.privateKey, claimsFor('brandon', { iat: now - 600, exp: now - 300 })),
      'iat in future': mint(K.privateKey, claimsFor('brandon', { iat: now + 600, exp: now + 900 })),
      'wrong key': mint(OTHER.privateKey, claimsFor('brandon')),
      'missing sub': mint(K.privateKey, claimsFor('brandon', { sub: undefined })),
      'bad signature': tok.slice(0, -4) + (tok.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'),
      'tampered body': `pa1.${Buffer.from(JSON.stringify(claimsFor('admin'))).toString('base64url')}.${tok.split('.')[2]}`,
      'not a pa1 token': 'garbage',
    };
    for (const [label, t] of Object.entries(bad)) {
      const r = await request('GET', '/api/tasks', { token: t });
      assertEq([r.status, r.body && r.body.error], [401, 'invalid_assertion'], `${label} -> 401`);
      noCookie(r, label);
    }

    // unknown user: 401, nothing provisioned
    const usersBefore = db.prepare('SELECT COUNT(*) c FROM users').get().c;
    const unk = await request('GET', '/api/tasks', { token: mint(K.privateKey, claimsFor('mallory')) });
    assertEq([unk.status, unk.body && unk.body.error], [401, 'unknown_user'], 'unknown username -> 401 unknown_user');
    assertEq(db.prepare('SELECT COUNT(*) c FROM users').get().c, usersBefore, 'no user row created');
    assertEq(db.prepare("SELECT COUNT(*) c FROM users WHERE username = 'mallory'").get().c, 0, 'mallory does not exist');

    // username match is case-insensitive like the rest of Homestead
    const upper = await request('GET', '/api/tasks', { token: mint(K.privateKey, claimsFor('Brandon')) });
    assertEq(upper.status, 200, 'username claim matches case-insensitively');

    // identity_links by sub wins over username
    const emilyId = db.prepare("SELECT id FROM users WHERE username = 'emily'").get().id;
    db.prepare("INSERT INTO identity_links (user_id, provider, issuer, provider_subject) VALUES (?, 'authentik', 'https://auth.example.test/', 'sub-emily-1')").run(emilyId);
    const linked = await request('POST', `/api/tasks/${taskId}/toggle`, { token: mint(K.privateKey, claimsFor('not-emily', { sub: 'sub-emily-1' })) });
    assertEq([linked.status, linked.body && linked.body.done_by], [200, 'emily'], 'identity_links sub maps to emily');
    process.env.HUB_PHATTID_ISSUER = 'https://other-issuer.test/';
    const wrongIss = await request('GET', '/api/tasks', { token: mint(K.privateKey, claimsFor('not-emily', { sub: 'sub-emily-1' })) });
    assertEq(wrongIss.status, 401, 'HUB_PHATTID_ISSUER restricts the identity_links lookup');
    process.env.HUB_PHATTID_ISSUER = 'https://auth.example.test/';
    const hijack = await request('GET', '/api/tasks', { token: mint(K.privateKey, claimsFor('emily', { sub: 'sub-someone-else' })) });
    assertEq(hijack.status, 401, 'username fallback refused when the user is linked to a different subject under the issuer');
    delete process.env.HUB_PHATTID_ISSUER;

    // out-of-scope routes: denied even for the admin user
    const adminTok = mint(K.privateKey, claimsFor('admin'));
    const denied = [
      ['GET', '/api/admin/owner/login-paths'],
      ['GET', '/api/agent-tokens'],
      ['POST', '/api/agent-tokens', { label: 'x' }],
      ['GET', '/api/apps'],
      ['POST', '/api/apps/install', {}],
      ['GET', '/api/mailbox/threads'],
      ['POST', '/api/events', { title: 'x', date: '2026-01-01' }],
      ['GET', '/api/calendar-sources'],
      ['GET', '/api/users'],
      ['GET', '/api/me/identities'],
      ['POST', '/api/me/modules/chores/enable'],
      ['GET', '/API/ADMIN/owner/login-paths'],
    ];
    for (const [method, p, body] of denied) {
      const r = await request(method, p, { token: adminTok, body });
      assert(r.status === 403 || r.status === 401, `${method} ${p} denied (${r.status})`, JSON.stringify(r.body));
      noCookie(r, `${method} ${p}`);
    }
    const scoped = await request('GET', '/api/agent-tokens', { token: adminTok });
    assertEq(scoped.body && scoped.body.error, 'insufficient_scope', 'denial is insufficient_scope');
    const before = db.prepare('SELECT COUNT(*) c FROM agent_tokens').get().c;
    await request('POST', '/api/agent-tokens', { token: adminTok, body: { label: 'y' } });
    assertEq(db.prepare('SELECT COUNT(*) c FROM agent_tokens').get().c, before, 'no token minted via PhattId');

    // narrowing PHATTID_SCOPES takes effect
    process.env.PHATTID_SCOPES = 'read:lists';
    const narrowed = await request('GET', '/api/tasks', { token: tok });
    assertEq(narrowed.status, 403, 'PHATTID_SCOPES=read:lists denies GET /api/tasks');
    const stillLists = await request('GET', '/api/lists', { token: tok });
    assertEq(stillLists.status, 200, 'PHATTID_SCOPES=read:lists still allows GET /api/lists');
    const noWrite = await request('PATCH', `/api/list-items/${item.body.id}`, { token: tok, body: { checked: false } });
    assertEq(noWrite.status, 403, 'PHATTID_SCOPES=read:lists denies PATCH list item');
    delete process.env.PHATTID_SCOPES;

    // the PhattId header does not fall through to other layers
    const viaHeader = await request('GET', '/api/tasks', { token: 'garbage', headers: { 'X-authentik-username': 'brandon', 'X-authentik-groups': 'household' } });
    assertEq(viaHeader.status, 401, 'bad PhattId + header-trust headers still 401');

    // feature off
    delete process.env.PHATTID_HUB_KEY;
    const off = await request('GET', '/api/tasks', { token: tok });
    assertEq([off.status, off.body && off.body.error], [401, 'phatt_id_disabled'], 'feature off -> 401');
    noCookie(off, 'feature off');
    const plain = await request('GET', '/api/tasks');
    assertEq(plain.status, 401, 'no auth at all still 401');
    const login = await request('POST', '/api/login', { body: { username: 'brandon', password: process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme' } });
    assertEq(login.status, 200, 'password login unaffected');
  } catch (err) {
    ng('HTTP integration test crashed', err.stack || err.message);
  } finally {
    db.close();
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

(async () => {
  await keyStoreTest();
  await httpTest();
  console.log(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
