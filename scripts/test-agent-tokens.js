#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-1617.1/.2 acceptance tests for lib/agent-tokens.js.
//
// Drives `lib/agent-tokens.js` directly against a temp SQLite file (plus
// a supertest-free HTTP smoke test of the Bearer-PAT middleware branch
// against a live server.js instance on an ephemeral port). No mocking.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const agentTokens = require('../lib/agent-tokens');

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-pat-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  agentTokens.migrate(db);
  return { db, tmpDir };
}

console.log('PHA-1617.1/.2 agent-tokens tests\n');

// ---- Test 1: issue returns plaintext once, schema fields present ----
{
  console.log('Test 1: issue() returns plaintext + metadata');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const issued = agentTokens.issue(db, brandon.id, { label: 'test-agent' });
  assert(!!issued.token_plaintext, 'token_plaintext present');
  assert(issued.token_plaintext.startsWith('homestead_pat_'), 'plaintext carries homestead_pat_ prefix');
  assertEq(issued.token_plaintext.length, 'homestead_pat_'.length + 43, 'plaintext is 56 chars total');
  assertEq(issued.label, 'test-agent', 'label round-trips');
  assertEq(issued.token_prefix, issued.token_plaintext.slice(0, 16), 'token_prefix matches first 16 chars');
  assert(!('token_hash' in issued), 'token_hash never exposed to caller');

  const row = db.prepare('SELECT * FROM agent_tokens WHERE id = ?').get(issued.id);
  assert(row.token_hash !== issued.token_plaintext, 'stored hash is not the plaintext');
  assert(row.token_hash.startsWith('$2'), 'stored hash looks like a bcrypt hash');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: list() returns metadata only, scoped to user ----
{
  console.log('\nTest 2: list() scopes to user, never leaks hash');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  agentTokens.issue(db, brandon.id, { label: 'brandon-a' });
  agentTokens.issue(db, brandon.id, { label: 'brandon-b' });
  agentTokens.issue(db, emily.id, { label: 'emily-a' });

  const brandonTokens = agentTokens.list(db, brandon.id);
  assertEq(brandonTokens.length, 2, 'brandon has 2 tokens');
  assert(brandonTokens.every(t => !('token_hash' in t) && !('token_plaintext' in t)), 'list() never exposes secrets');

  const emilyTokens = agentTokens.list(db, emily.id);
  assertEq(emilyTokens.length, 1, 'emily has 1 token');

  const allTokens = agentTokens.list(db, null);
  assertEq(allTokens.length, 3, 'admin list (userId=null) sees all tokens');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 3: revoke ----
{
  console.log('\nTest 3: revoke() soft-deletes, is idempotent, honors ownership');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  const issued = agentTokens.issue(db, brandon.id, { label: 'to-revoke' });

  const wrongOwner = agentTokens.revoke(db, issued.id, { ownerUserId: emily.id });
  assertEq(wrongOwner, false, 'revoke() refuses when ownerUserId does not match');

  const revoked = agentTokens.revoke(db, issued.id, { ownerUserId: brandon.id });
  assertEq(revoked, true, 'revoke() succeeds for the owning user');

  const row = db.prepare('SELECT revoked_at FROM agent_tokens WHERE id = ?').get(issued.id);
  assert(!!row.revoked_at, 'revoked_at populated');

  const revokedAgain = agentTokens.revoke(db, issued.id, { ownerUserId: brandon.id });
  assertEq(revokedAgain, true, 'revoke() is idempotent on an already-revoked token');

  const verifyResult = agentTokens.verify(db, issued.token_plaintext);
  assertEq(verifyResult, null, 'verify() rejects a revoked token');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 4: prefix collision resistance ----
{
  console.log('\nTest 4: prefix collisions are structurally avoided (retry-safe issue)');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const issuedTokens = [];
  for (let i = 0; i < 25; i++) issuedTokens.push(agentTokens.issue(db, brandon.id, { label: `t${i}` }));
  const prefixes = issuedTokens.map(t => t.token_prefix);
  const uniquePrefixes = new Set(prefixes);
  assertEq(uniquePrefixes.size, prefixes.length, '25 issued tokens all have distinct prefixes');

  // The DB-level partial unique index enforces this even outside issue():
  // a manual INSERT reusing a live prefix must fail.
  let threw = false;
  try {
    db.prepare(`INSERT INTO agent_tokens (user_id, label, token_hash, token_prefix) VALUES (?, ?, ?, ?)`)
      .run(brandon.id, 'collider', 'fake-hash', prefixes[0]);
  } catch (e) {
    threw = true;
  }
  assert(threw, 'DB-level unique index rejects a duplicate live token_prefix');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 5: expired token rejection ----
{
  console.log('\nTest 5: verify() rejects an expired token');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  const issued = agentTokens.issue(db, brandon.id, { label: 'expired', expiresAt: past });
  const verifyResult = agentTokens.verify(db, issued.token_plaintext);
  assertEq(verifyResult, null, 'verify() rejects an expired token');

  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const issuedFuture = agentTokens.issue(db, brandon.id, { label: 'not-yet-expired', expiresAt: future });
  const verifyFuture = agentTokens.verify(db, issuedFuture.token_plaintext);
  assert(!!verifyFuture, 'verify() accepts a token whose expiry is in the future');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 6: verify() rejects garbage / wrong-prefix / tampered tokens ----
{
  console.log('\nTest 6: verify() rejects malformed or tampered tokens');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const issued = agentTokens.issue(db, brandon.id, { label: 'tamper-test' });

  assertEq(agentTokens.verify(db, 'not-a-real-token'), null, 'rejects non-PAT-shaped string');
  assertEq(agentTokens.verify(db, 'homestead_pat_totallybogus'), null, 'rejects unknown prefix');

  const tampered = issued.token_plaintext.slice(0, -1) + (issued.token_plaintext.slice(-1) === 'a' ? 'b' : 'a');
  assertEq(agentTokens.verify(db, tampered), null, 'rejects a tampered suffix (same prefix, wrong hash)');

  // last_used_at only updates on a *successful* verify.
  const before = db.prepare('SELECT last_used_at FROM agent_tokens WHERE id = ?').get(issued.id).last_used_at;
  assertEq(before, null, 'last_used_at starts null');
  const good = agentTokens.verify(db, issued.token_plaintext);
  assert(!!good, 'verify() accepts the real token');
  const after = db.prepare('SELECT last_used_at FROM agent_tokens WHERE id = ?').get(issued.id).last_used_at;
  assert(!!after, 'last_used_at populated after a successful verify');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 7: HTTP integration — Bearer PAT through authenticate() ----
{
  console.log('\nTest 7: server.js authenticate() accepts a valid Bearer PAT end-to-end');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-pat-http-'));
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
        try { json = JSON.parse(data); } catch (_) { /* non-JSON */ }
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

    // Log in as brandon over a session to issue a token.
    const loginRes = await request({
      ...base, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { username: 'brandon', password: process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme' });
    const cookie = (loginRes.headers['set-cookie'] || [])[0];
    assert(loginRes.status === 200, 'login as brandon succeeds', JSON.stringify(loginRes.body));

    const issueRes = await request({
      ...base, path: '/api/agent-tokens', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { label: 'http-test-agent' });
    assert(issueRes.status === 200, 'POST /api/agent-tokens issues a token', JSON.stringify(issueRes.body));
    const plaintext = issueRes.body && issueRes.body.token_plaintext;
    assert(!!plaintext, 'response carries token_plaintext');

    // Use the PAT (no cookie) to hit an authenticated route.
    const meRes = await request({
      ...base, path: '/api/users', method: 'GET',
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    assert(meRes.status === 200, 'Bearer PAT authenticates against /api/users', JSON.stringify(meRes.body));

    // Bad token is rejected with 401 invalid_token.
    const badRes = await request({
      ...base, path: '/api/users', method: 'GET',
      headers: { Authorization: 'Bearer homestead_pat_' + 'x'.repeat(43) },
    });
    assertEq(badRes.status, 401, 'invalid Bearer PAT gets 401');
    assertEq(badRes.body && badRes.body.error, 'invalid_token', 'invalid Bearer PAT gets {error: invalid_token}');

    // Revoke, then the same PAT should be rejected.
    const listRes = await request({
      ...base, path: '/api/agent-tokens', method: 'GET',
      headers: { Cookie: cookie },
    });
    const tokenId = listRes.body[0].id;
    const revokeRes = await request({
      ...base, path: `/api/agent-tokens/${tokenId}`, method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assertEq(revokeRes.status, 200, 'DELETE /api/agent-tokens/:id revokes');

    const revokedUseRes = await request({
      ...base, path: '/api/users', method: 'GET',
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    assertEq(revokedUseRes.status, 401, 'revoked Bearer PAT gets 401 after revocation');

    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    finish();
  }).catch(err => {
    ng('HTTP integration test crashed', err.stack || err.message);
    try { server.close(); } catch (_) {}
    finish();
  });
}

// ---- Test 8: PHA-2228 — agent_tokens.app_id + installed_apps migration ----
{
  console.log('\nTest 8: app_id column + installed_apps table (PHA-2228)');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');

  const tokenCols = db.prepare('PRAGMA table_info(agent_tokens)').all().map(c => c.name);
  assert(tokenCols.includes('app_id'), 'agent_tokens gains an app_id column');

  const appsCols = db.prepare('PRAGMA table_info(installed_apps)').all().map(c => c.name);
  assertEq(
    appsCols,
    ['key', 'name', 'manifest_url', 'manifest_json', 'installed_by_user_id', 'installed_at', 'revoked_at'],
    'installed_apps has the columns from the PHA-2201 §5 design note'
  );

  // Existing user-level PATs (PHA-1617 behavior) are untouched: app_id
  // defaults NULL, no data loss on re-running migrate() over live data.
  const existing = agentTokens.issue(db, brandon.id, { label: 'user-level' });
  const existingRow = db.prepare('SELECT app_id FROM agent_tokens WHERE id = ?').get(existing.id);
  assertEq(existingRow.app_id, null, 'user-level PAT defaults app_id to NULL');

  let rerunThrew = false;
  try { agentTokens.migrate(db); } catch (_) { rerunThrew = true; }
  assert(!rerunThrew, 're-running migrate() over live data is a no-op');
  const stillThere = db.prepare('SELECT app_id FROM agent_tokens WHERE id = ?').get(existing.id);
  assertEq(stillThere.app_id, null, 'app_id still NULL after re-running migrate()');

  // App-scoped PAT: one row per (user, app), FK'd to installed_apps.key.
  db.prepare(`
    INSERT INTO installed_apps (key, name, manifest_url, installed_by_user_id)
    VALUES ('dune-tracker', 'Dune Tracker', 'https://example.test/manifest.json', ?)
  `).run(brandon.id);
  const scopedInfo = db.prepare(`
    INSERT INTO agent_tokens (user_id, label, token_hash, token_prefix, app_id)
    VALUES (?, 'app-scoped', 'fake-hash', 'homestead_pat_scoped', 'dune-tracker')
  `).run(brandon.id);
  const scopedRow = db.prepare('SELECT app_id FROM agent_tokens WHERE id = ?').get(scopedInfo.lastInsertRowid);
  assertEq(scopedRow.app_id, 'dune-tracker', 'app-scoped PAT stores app_id = installed_apps.key');

  // The partial index must be the one the planner picks for app-scoped
  // token lookups (the acceptance criterion from PHA-2228).
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM agent_tokens
    WHERE user_id = ? AND app_id = ? AND revoked_at IS NULL
  `).all(brandon.id, 'dune-tracker');
  const usesIndex = plan.some(p => String(p.detail).includes('idx_agent_tokens_app'));
  assert(usesIndex, 'app-scoped token lookup uses idx_agent_tokens_app', JSON.stringify(plan));

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function finish() {
  console.log(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}
