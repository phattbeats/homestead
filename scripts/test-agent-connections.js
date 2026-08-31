#!/usr/bin/env node
// PHA-2880 (PHA-2855 phase 1) acceptance tests for lib/agent-connections.js.
//
// Drives `lib/agent-connections.js` directly against a temp SQLite file
// (plus an HTTP integration test of the /api/agent-connections routes
// against a live server.js instance on an ephemeral port). No mocking.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const agentConnections = require('../lib/agent-connections');

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-conn-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  agentConnections.migrate(db);
  return { db, tmpDir };
}

console.log('PHA-2880 agent-connections tests\n');

// ---- Test 1: mintPairingCode() creates a pending row + code ----
{
  console.log('Test 1: mintPairingCode() mints a pending connection + code');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const minted = agentConnections.mintPairingCode(db, brandon.id, {
    provider: 'claude_code',
    label: "Brandon's Claude Code — office laptop",
    scopes: ['read:me', 'agent:invoke'],
  });
  assertEq(minted.status, 'pending', 'status is pending');
  assertEq(minted.provider, 'claude_code', 'provider round-trips');
  assertEq(minted.scopes, ['read:me', 'agent:invoke'], 'scopes round-trip');
  assert(!!minted.pairing_code, 'pairing_code present');
  assertEq(minted.pairing_code.length, 6, 'pairing_code is 6 chars');
  assert(!('secret_plaintext' in minted), 'no secret minted yet — pairing not redeemed');
  assert(!!minted.pairing_code_expires_at, 'pairing_code_expires_at present');

  const row = db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(minted.id);
  assertEq(row.pairing_code, minted.pairing_code, 'DB persisted the pairing code');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: redeemPairingCode() success path ----
{
  console.log('\nTest 2: redeemPairingCode() mints a secret, single-use');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const minted = agentConnections.mintPairingCode(db, brandon.id, { provider: 'openclaw', label: 'Home rig' });

  const redeemed = agentConnections.redeemPairingCode(db, minted.pairing_code, { userId: brandon.id });
  assert(!!redeemed, 'redeem succeeds');
  assertEq(redeemed.status, 'active', 'status flips to active');
  assert(!!redeemed.secret_plaintext, 'secret_plaintext present on redemption');
  assert(redeemed.secret_plaintext.startsWith('homestead_conn_'), 'secret carries homestead_conn_ prefix');

  const row = db.prepare('SELECT * FROM agent_connections WHERE id = ?').get(minted.id);
  assertEq(row.secret, redeemed.secret_plaintext, 'DB persisted the secret plaintext');
  assertEq(row.pairing_code, null, 'pairing_code cleared after redemption');

  // Re-redeeming the same (now-cleared) code fails.
  const reRedeem = agentConnections.redeemPairingCode(db, minted.pairing_code, { userId: brandon.id });
  assertEq(reRedeem, null, 'redeeming an already-redeemed code fails (single-use)');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 3: redeemPairingCode() rejects wrong user ----
{
  console.log('\nTest 3: redeemPairingCode() is bound to the initiating user_id');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  const minted = agentConnections.mintPairingCode(db, brandon.id, { provider: 'codex', label: 'X' });

  const wrongUser = agentConnections.redeemPairingCode(db, minted.pairing_code, { userId: emily.id });
  assertEq(wrongUser, null, "a different user cannot redeem brandon's code");

  const row = db.prepare('SELECT status, pairing_code FROM agent_connections WHERE id = ?').get(minted.id);
  assertEq(row.status, 'pending', 'row stays pending after a rejected redeem attempt');
  assertEq(row.pairing_code, minted.pairing_code, 'pairing_code is untouched by a rejected attempt');

  const rightUser = agentConnections.redeemPairingCode(db, minted.pairing_code, { userId: brandon.id });
  assert(!!rightUser, 'the correct user can still redeem afterward');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 4: redeemPairingCode() rejects expired codes ----
{
  console.log('\nTest 4: redeemPairingCode() rejects an expired code');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const minted = agentConnections.mintPairingCode(db, brandon.id, { provider: 'openclaw', label: 'X' });
  // Force expiry into the past.
  db.prepare(`UPDATE agent_connections SET pairing_code_expires_at = datetime('now', '-1 minute') WHERE id = ?`).run(minted.id);

  const expired = agentConnections.redeemPairingCode(db, minted.pairing_code, { userId: brandon.id });
  assertEq(expired, null, 'expired code is rejected');

  const row = db.prepare('SELECT pairing_code, status FROM agent_connections WHERE id = ?').get(minted.id);
  assertEq(row.pairing_code, null, 'expired code is cleared so it cannot be retried');
  assertEq(row.status, 'pending', 'row stays pending (never redeemed) after expiry');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 5: redeemPairingCode() rejects unknown code ----
{
  console.log('\nTest 5: redeemPairingCode() rejects an unknown code');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const unknown = agentConnections.redeemPairingCode(db, 'ZZZZZZ', { userId: brandon.id });
  assertEq(unknown, null, 'unknown code returns null');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 6: list() never leaks the secret ----
{
  console.log('\nTest 6: list() is metadata-only, never leaks the secret');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  const a = agentConnections.mintPairingCode(db, brandon.id, { provider: 'openclaw', label: 'A' });
  agentConnections.redeemPairingCode(db, a.pairing_code, { userId: brandon.id });
  agentConnections.mintPairingCode(db, brandon.id, { provider: 'codex', label: 'B' });
  agentConnections.mintPairingCode(db, emily.id, { provider: 'claude_code', label: 'C' });

  const brandonList = agentConnections.list(db, brandon.id);
  assertEq(brandonList.length, 2, 'brandon has 2 connections');
  assert(brandonList.every(c => !('secret_plaintext' in c)), 'list() never exposes secret_plaintext');
  assert(brandonList.every(c => !('secret' in c)), 'list() never exposes the raw secret column');
  assert(brandonList.every(c => !('pairing_code' in c)), 'list() never exposes a live pairing_code');

  const emilyList = agentConnections.list(db, emily.id);
  assertEq(emilyList.length, 1, 'emily has 1 connection');

  const allList = agentConnections.list(db, null);
  assertEq(allList.length, 3, 'admin list (userId=null) sees all connections');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 7: rename(), rotateSecret(), revoke() ----
{
  console.log('\nTest 7: rename(), rotateSecret(), revoke() with owner scoping');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  const minted = agentConnections.mintPairingCode(db, brandon.id, { provider: 'openclaw', label: 'old' });
  const active = agentConnections.redeemPairingCode(db, minted.pairing_code, { userId: brandon.id });

  const renamed = agentConnections.rename(db, active.id, 'new label', { ownerUserId: brandon.id });
  assertEq(renamed.label, 'new label', 'rename updates the label');

  const wrongOwnerRename = agentConnections.rename(db, active.id, 'hijack', { ownerUserId: emily.id });
  assertEq(wrongOwnerRename, null, 'rename refuses a non-owner');

  const rotated = agentConnections.rotateSecret(db, active.id, { ownerUserId: brandon.id });
  assert(!!rotated.secret_plaintext, 'rotateSecret returns a fresh secret_plaintext');
  assert(rotated.secret_plaintext !== active.secret_plaintext, 'fresh secret differs from the prior one');

  const wrongOwnerRotate = agentConnections.rotateSecret(db, active.id, { ownerUserId: emily.id });
  assertEq(wrongOwnerRotate, null, 'rotateSecret refuses a non-owner');

  const revoked = agentConnections.revoke(db, active.id, { ownerUserId: brandon.id });
  assertEq(revoked.status, 'revoked', 'revoke flips status');
  const row = db.prepare('SELECT secret FROM agent_connections WHERE id = ?').get(active.id);
  assertEq(row.secret, null, 'revoke clears the stored secret');

  const rotateAfterRevoke = agentConnections.rotateSecret(db, active.id, { ownerUserId: brandon.id });
  assertEq(rotateAfterRevoke, null, 'rotateSecret refuses a revoked connection');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 8: validation — provider, label, scopes ----
{
  console.log('\nTest 8: input validation rejects malformed inputs');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');

  let threw = false;
  try { agentConnections.mintPairingCode(db, brandon.id, { provider: 'discord_bot', label: 'X' }); }
  catch (e) { threw = /provider must be/.test(e.message); }
  assert(threw, 'invalid provider is rejected');

  threw = false;
  try { agentConnections.mintPairingCode(db, brandon.id, { provider: 'openclaw', label: 'x'.repeat(129) }); }
  catch (e) { threw = /too long/i.test(e.message); }
  assert(threw, 'oversized label is rejected');

  threw = false;
  try { agentConnections.mintPairingCode(db, brandon.id, { provider: 'openclaw', label: 'X', scopes: ['read:not_a_real_scope'] }); }
  catch (e) { threw = /unmapped scope/i.test(e.message); }
  assert(threw, 'unmapped scope is rejected (PHA-2201 §3 vocabulary)');

  threw = false;
  try { agentConnections.mintPairingCode(db, brandon.id, { provider: 'openclaw', label: 'X', scopes: 'agent:invoke' }); }
  catch (e) { threw = /scopes must be an array/i.test(e.message); }
  assert(threw, 'non-array scopes is rejected');

  const okConn = agentConnections.mintPairingCode(db, brandon.id, { provider: 'openclaw', label: 'X', scopes: ['agent:invoke'] });
  assertEq(okConn.scopes, ['agent:invoke'], 'valid scope is accepted');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 9: verifySignature() reuses agent-endpoints' signPayload ----
{
  console.log('\nTest 9: verifySignature() validates HMAC + replay window');
  const agentEndpoints = require('../lib/agent-endpoints');
  const secret = 'homestead_conn_' + 'x'.repeat(43);
  const ts = Math.floor(Date.now() / 1000);
  const body = '{"hello":"world"}';
  const sig = agentEndpoints.signPayload(secret, ts, body);

  assert(agentConnections.verifySignature(secret, ts, body, sig), 'valid signature + fresh timestamp passes');
  assert(!agentConnections.verifySignature(secret, ts, body, 'sha256=deadbeef'), 'tampered signature fails');
  assert(!agentConnections.verifySignature(secret, ts - 3600, body, agentEndpoints.signPayload(secret, ts - 3600, body)), 'stale timestamp (1hr old) fails replay guard');
  assert(!agentConnections.verifySignature('wrong_secret', ts, body, sig), 'wrong secret fails');
}

// ---- Test 10: HTTP integration — pairing + management via /api/agent-connections ----
{
  console.log('\nTest 10: server.js routes for /api/agent-connections');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-conn-http-'));
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

    const loginRes = await request({
      ...base, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { username: 'brandon', password: process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme' });
    const cookie = (loginRes.headers['set-cookie'] || [])[0];
    assert(loginRes.status === 200, 'login as brandon succeeds', JSON.stringify(loginRes.body));

    // Mint a pairing code.
    const mintRes = await request({
      ...base, path: '/api/agent-connections/pair', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { provider: 'claude_code', label: 'Office laptop', scopes: ['agent:invoke'] });
    assertEq(mintRes.status, 200, 'POST /api/agent-connections/pair mints a code');
    assert(!!mintRes.body.pairing_code, 'response carries a pairing_code');
    const pairingCode = mintRes.body.pairing_code;

    // Second session (a different login as the same user, simulating the
    // companion's session-authenticated redeem) redeems the code.
    const redeemRes = await request({
      ...base, path: '/api/agent-connections/redeem-pairing-code', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { code: pairingCode });
    assertEq(redeemRes.status, 200, 'POST /api/agent-connections/redeem-pairing-code succeeds');
    assert(!!redeemRes.body.secret_plaintext, 'redeem response carries the one-time secret');
    const connectionId = redeemRes.body.id;

    // Re-redeeming fails.
    const reRedeem = await request({
      ...base, path: '/api/agent-connections/redeem-pairing-code', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { code: pairingCode });
    assertEq(reRedeem.status, 400, 're-redeeming the same code returns 400');

    // List.
    const listRes = await request({
      ...base, path: '/api/agent-connections', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(listRes.status, 200, 'GET /api/agent-connections lists own connections');
    assertEq(listRes.body.length, 1, 'one connection in list');
    assert(!('secret_plaintext' in listRes.body[0]), 'list response does not leak secret_plaintext');

    // Rename.
    const renameRes = await request({
      ...base, path: `/api/agent-connections/${connectionId}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { label: 'Renamed laptop' });
    assertEq(renameRes.status, 200, 'PATCH rename succeeds');
    assertEq(renameRes.body.label, 'Renamed laptop', 'label updated');

    // Rotate.
    const rotateRes = await request({
      ...base, path: `/api/agent-connections/${connectionId}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { rotate_secret: true });
    assertEq(rotateRes.status, 200, 'PATCH rotate_secret=true succeeds');
    assert(!!rotateRes.body.secret_plaintext, 'rotate returns a fresh secret_plaintext');
    assert(rotateRes.body.secret_plaintext !== redeemRes.body.secret_plaintext, 'fresh secret differs from the prior one');

    // Revoke.
    const revokeRes = await request({
      ...base, path: `/api/agent-connections/${connectionId}`, method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { revoke: true });
    assertEq(revokeRes.status, 200, 'PATCH revoke=true succeeds');
    assertEq(revokeRes.body.status, 'revoked', 'status is revoked');

    // Unauthenticated mint is rejected with 401.
    const unauth = await request({
      ...base, path: '/api/agent-connections/pair', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { provider: 'openclaw', label: 'X' });
    assertEq(unauth.status, 401, 'unauthenticated mint returns 401');

    // Bad provider returns 400.
    const badProvider = await request({
      ...base, path: '/api/agent-connections/pair', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { provider: 'discord_bot', label: 'X' });
    assertEq(badProvider.status, 400, 'invalid provider returns 400');

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
