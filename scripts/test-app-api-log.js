#!/usr/bin/env node
// PHA-2201.3 (PHA-2231) acceptance tests for lib/app-api-log.js +
// server.js's write-path hook and GET /api/apps/:key/activity.
//
// Drives lib/app-api-log.js directly against a temp SQLite file, plus
// an HTTP integration test of the authenticate() write path and the
// activity endpoint against a live server.js instance. No mocking.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const agentTokens = require('../lib/agent-tokens');
const appApiLog = require('../lib/app-api-log');

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-app-api-log-test-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  agentTokens.migrate(db);
  appApiLog.migrate(db);
  return { db, tmpDir };
}

function installApp(db, key, userId) {
  db.prepare(`INSERT INTO installed_apps (key, name, manifest_url, installed_by_user_id)
              VALUES (?, ?, 'https://example.test/manifest.json', ?)`)
    .run(key, key, userId);
}

console.log('PHA-2201.3 (PHA-2231) app-api-log tests\n');

// ---- Test 1: schema ----
{
  console.log('Test 1: app_api_log schema');
  const { db, tmpDir } = freshDb();
  const cols = db.prepare('PRAGMA table_info(app_api_log)').all().map(c => c.name);
  assertEq(cols, ['id', 'user_id', 'app_id', 'route', 'scopes_used', 'status', 'created_at'],
    'app_api_log has the columns from the PHA-2201 §5 design note');
  let rerunThrew = false;
  try { appApiLog.migrate(db); } catch (_) { rerunThrew = true; }
  assert(!rerunThrew, 're-running migrate() over live data is a no-op');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: log() writes a row ----
{
  console.log('\nTest 2: log() writes a row with the full field set');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  installApp(db, 'dune-tracker', brandon.id);
  appApiLog.log(db, {
    userId: brandon.id, appId: 'dune-tracker', route: 'GET /api/lists',
    scopesUsed: 'read:lists', status: 200,
  });
  const row = db.prepare('SELECT * FROM app_api_log').get();
  assertEq(row.user_id, brandon.id, 'user_id recorded');
  assertEq(row.app_id, 'dune-tracker', 'app_id recorded');
  assertEq(row.route, 'GET /api/lists', 'route recorded');
  assertEq(row.scopes_used, 'read:lists', 'scopes_used recorded');
  assertEq(row.status, 200, 'status recorded');
  assert(!!row.created_at, 'created_at defaulted');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 3: list() paginates and scopes to (user, app) ----
{
  console.log('\nTest 3: list() paginates and never leaks another user\'s rows');
  const { db, tmpDir } = freshDb();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  installApp(db, 'dune-tracker', brandon.id);

  for (let i = 0; i < 5; i++) {
    appApiLog.log(db, { userId: brandon.id, appId: 'dune-tracker', route: `GET /api/x/${i}`, scopesUsed: 'read:lists', status: 200 });
  }
  appApiLog.log(db, { userId: emily.id, appId: 'dune-tracker', route: 'GET /api/y', scopesUsed: 'read:lists', status: 200 });

  const page1 = appApiLog.list(db, brandon.id, 'dune-tracker', { limit: 2, offset: 0 });
  assertEq(page1.items.length, 2, 'page 1 respects limit');
  assertEq(page1.total, 5, 'total counts only brandon+dune-tracker rows');
  assertEq(page1.nextOffset, 2, 'nextOffset advances');

  const page3 = appApiLog.list(db, brandon.id, 'dune-tracker', { limit: 2, offset: 4 });
  assertEq(page3.items.length, 1, 'final page has the remainder');
  assertEq(page3.nextOffset, null, 'nextOffset is null on the last page');

  const emilyView = appApiLog.list(db, emily.id, 'dune-tracker', {});
  assertEq(emilyView.total, 1, 'emily only sees her own row for the same app');
  assert(emilyView.items.every(r => r.user_id === emily.id), 'no cross-user leakage in item rows');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 4: HTTP integration — write path + activity endpoint ----
{
  console.log('\nTest 4: authenticate() logs app-scoped PAT calls; user PATs are not logged');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-app-api-log-http-'));
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

    const loginRes = await request({
      ...base, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { username: 'brandon', password: process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme' });
    const cookie = (loginRes.headers['set-cookie'] || [])[0];
    assert(loginRes.status === 200, 'login as brandon succeeds', JSON.stringify(loginRes.body));

    // A plain user-level PAT (app_id NULL) — its calls must NOT be logged.
    const issueRes = await request({
      ...base, path: '/api/agent-tokens', method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
    }, { label: 'user-level-pat' });
    const userPlaintext = issueRes.body && issueRes.body.token_plaintext;
    assert(!!userPlaintext, 'user-level PAT issued');

    await request({
      ...base, path: '/api/users', method: 'GET',
      headers: { Authorization: `Bearer ${userPlaintext}` },
    });

    // An app-scoped PAT, minted directly against the DB (PHA-2229's
    // mint-on-install flow isn't built yet) — its calls MUST be logged.
    const dbPath = path.join(tmpDir, 'life.db');
    const rawDb = new Database(dbPath);
    const brandon = rawDb.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
    rawDb.prepare(`INSERT INTO installed_apps (key, name, manifest_url, installed_by_user_id)
                   VALUES ('dune-tracker', 'Dune Tracker', 'https://example.test/manifest.json', ?)`)
      .run(brandon.id);
    const issued = agentTokens.issue(rawDb, brandon.id, { label: 'app-scoped' });
    rawDb.prepare(`UPDATE agent_tokens SET app_id = 'dune-tracker', scopes = 'read:lists' WHERE id = ?`)
      .run(issued.id);
    rawDb.close();

    const appRes = await request({
      ...base, path: '/api/users', method: 'GET',
      headers: { Authorization: `Bearer ${issued.token_plaintext}` },
    });
    assertEq(appRes.status, 200, 'app-scoped PAT authenticates');

    // Give the 'finish' listener a tick to run (it fires after the
    // response is flushed, i.e. right after our client sees it).
    await new Promise(r => setTimeout(r, 50));

    const activityRes = await request({
      ...base, path: '/api/apps/dune-tracker/activity', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(activityRes.status, 200, 'GET /api/apps/:key/activity succeeds for the owning user');
    assertEq(activityRes.body.total, 1, 'only the app-scoped call is logged — the user-level PAT call is absent');
    assertEq(activityRes.body.items[0].route, 'GET /api/users', 'route recorded');
    assertEq(activityRes.body.items[0].status, 200, 'status recorded');
    assertEq(activityRes.body.items[0].scopes_used, 'read:lists', 'scopes_used recorded from the token');

    // Unknown app key -> 404.
    const missingRes = await request({
      ...base, path: '/api/apps/nonexistent/activity', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(missingRes.status, 404, 'unknown app key gets 404');

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
