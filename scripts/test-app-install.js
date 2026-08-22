#!/usr/bin/env node
// PHA-2201.1 (PHA-2229) acceptance tests for lib/app-install.js + the
// six /api/apps/* routes in server.js.
//
// Two layers, no mocking of Homestead's own code — only the outbound
// `fetch` used to retrieve a third-party manifest is stubbed (or, for
// the HTTP integration test, pointed at a real local manifest server):
//   * direct calls against lib/app-install.js over a temp SQLite file
//     (fast, exercises every branch of the state machine)
//   * one end-to-end HTTP round trip against a live server.js instance
//     (resolve -> consent -> install -> list -> get -> revoke -> 401)

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const agentTokens = require('../lib/agent-tokens');
const appApiLog = require('../lib/app-api-log');
const appInstall = require('../lib/app-install');

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
async function assertThrowsCode(fn, expectedCode, label) {
  try {
    await fn();
    ng(label, 'did not throw');
  } catch (err) {
    if (err.code === expectedCode) ok(label);
    else ng(label, `expected code ${expectedCode}, got ${err.code || err.message}`);
  }
}

function freshDb() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-app-install-test-'));
  const db = new Database(path.join(tmpDir, 'life.db'));
  userModel.migrate(db);
  agentTokens.migrate(db);
  appApiLog.migrate(db);
  appInstall.migrate(db);
  return { db, tmpDir };
}

function fixtureManifest(overrides) {
  return Object.assign({
    key: 'popcorn_vote',
    name: 'Popcorn Vote',
    description: 'Family movie night voting.',
    icon: '🍿',
    room: null,
    requires: [],
    tier: 'advanced',
    version: '0.1.0',
    author: 'homestead-external',
    url: 'https://popcorn.example.test/app',
    open_mode: 'tab',
    scopes: ['read:walls:media_club'],
    mcp: true,
    webhooks: [],
    entity_kinds: [],
    default_enabled: false,
  }, overrides || {});
}

function stubFetch(manifestOrFn, opts) {
  opts = opts || {};
  return async () => {
    if (opts.reject) throw new Error(opts.reject);
    if (opts.status && opts.status >= 400) {
      return { ok: false, status: opts.status, headers: { get: () => null }, json: async () => ({}) };
    }
    const manifest = typeof manifestOrFn === 'function' ? manifestOrFn() : manifestOrFn;
    if (opts.badJson) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => { throw new Error('bad json'); } };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'etag' ? 'W/"fixture-etag"' : null) },
      json: async () => manifest,
    };
  };
}

function tableCounts(db) {
  return {
    installed_apps: db.prepare('SELECT COUNT(*) c FROM installed_apps').get().c,
    agent_tokens: db.prepare('SELECT COUNT(*) c FROM agent_tokens').get().c,
    user_modules_enabled: db.prepare("SELECT COUNT(*) c FROM user_modules WHERE enabled_at IS NOT NULL").get().c,
    app_consent_tokens: db.prepare('SELECT COUNT(*) c FROM app_consent_tokens').get().c,
  };
}

console.log('PHA-2201.1 (PHA-2229) app install flow tests\n');

async function main() {

// ---- Test 1: resolve() never writes to the DB ----
{
  console.log('Test 1: resolveManifest() has zero DB side effects');
  const { db, tmpDir } = freshDb();
  appInstall._manifestCache.clear();
  const before = tableCounts(db);
  const manifest = await appInstall.resolveManifest(db, 'https://apps.example.test/popcorn/manifest.json', {
    fetchImpl: stubFetch(fixtureManifest()),
  });
  assertEq(manifest.key, 'popcorn_vote', 'resolve returns the fetched manifest');
  assertEq(tableCounts(db), before, 'no table row counts changed after resolve()');
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 2: shape + scope vocabulary + URL security rejections ----
// Each case uses its own URL — the manifest cache is keyed by URL, so
// reusing one across differently-stubbed fetches would let an earlier
// case's cached (successfully-fetched) manifest mask a later case's
// stub, which isn't what any of these assertions are testing.
{
  console.log('\nTest 2: resolve() rejects invalid manifests');
  const { db, tmpDir } = freshDb();
  appInstall._manifestCache.clear();

  await assertThrowsCode(
    () => appInstall.resolveManifest(db, 'https://apps.example.test/missing-field.json', {
      fetchImpl: stubFetch(fixtureManifest({ scopes: undefined })), // missing required field -> shape fail
    }),
    'manifest_invalid', 'missing required field fails shape validation'
  );

  try {
    await appInstall.resolveManifest(db, 'https://apps.example.test/rejected-scope.json', {
      fetchImpl: stubFetch(fixtureManifest({ scopes: ['read:secrets'] })),
    });
    ng('rejected scope fails validation');
  } catch (err) {
    assertEq(err.code, 'manifest_invalid', 'rejected scope (read:secrets) fails manifest_invalid');
    assert(Array.isArray(err.extra.valid_scopes) && err.extra.valid_scopes.includes('read:me'),
      'error response lists the valid §3 vocabulary');
  }

  await assertThrowsCode(
    () => appInstall.resolveManifest(db, 'https://apps.example.test/unmapped-scope.json', {
      fetchImpl: stubFetch(fixtureManifest({ scopes: ['read:made_up_thing'] })),
    }),
    'manifest_invalid', 'unmapped scope fails validation'
  );

  await assertThrowsCode(
    () => appInstall.resolveManifest(db, 'http://apps.example.test/plain-http.json', { // http, not https
      fetchImpl: stubFetch(fixtureManifest()),
    }),
    'manifest_invalid', 'plain http:// url rejected outside dev mode'
  );

  await assertThrowsCode(
    () => appInstall.resolveManifest(db, 'https://localhost/loopback.json', {
      fetchImpl: stubFetch(fixtureManifest()),
    }),
    'manifest_invalid', 'loopback host rejected outside dev mode'
  );

  const devManifest = await appInstall.resolveManifest(db, 'http://127.0.0.1:9/dev-bypass.json', {
    dev: true,
    fetchImpl: stubFetch(fixtureManifest()),
  });
  assertEq(devManifest.key, 'popcorn_vote', 'dev:true bypasses the https/loopback check');

  await assertThrowsCode(
    () => appInstall.resolveManifest(db, 'https://apps.example.test/unreachable-503.json', {
      fetchImpl: stubFetch(null, { status: 503 }),
    }),
    'manifest_unreachable', 'non-2xx fetch is manifest_unreachable'
  );
  await assertThrowsCode(
    () => appInstall.resolveManifest(db, 'https://apps.example.test/unreachable-network.json', {
      fetchImpl: stubFetch(null, { reject: 'ECONNREFUSED' }),
    }),
    'manifest_unreachable', 'network error is manifest_unreachable'
  );
  await assertThrowsCode(
    () => appInstall.resolveManifest(db, 'https://apps.example.test/bad-json.json', {
      fetchImpl: stubFetch(null, { badJson: true }),
    }),
    'manifest_invalid', 'non-JSON body is manifest_invalid'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 3: built-in key collision -> 409, never overwrites ----
{
  console.log('\nTest 3: built-in key collision is rejected, not overwritten');
  const { db, tmpDir } = freshDb();
  appInstall._manifestCache.clear();
  await assertThrowsCode(
    () => appInstall.resolveManifest(db, 'https://apps.example.test/m.json', {
      fetchImpl: stubFetch(fixtureManifest({ key: 'wall', open_mode: 'frame', url: 'https://apps.example.test/wall' })),
    }),
    'manifest_key_conflict', 'manifest key "wall" collides with the built-in module'
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 4: consent — 412 without acknowledgement, 60s TTL, single-use, bound to user ----
{
  console.log('\nTest 4: consent token lifecycle');
  const { db, tmpDir } = freshDb();
  appInstall._manifestCache.clear();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  const url = 'https://apps.example.test/popcorn/manifest.json';
  const fetchImpl = stubFetch(fixtureManifest());

  await assertThrowsCode(
    () => appInstall.issueConsent(db, brandon.id, url, { acknowledged: false, fetchImpl }),
    'consent_required', 'consent without acknowledged:true is rejected'
  );

  const { consent_token, manifest } = await appInstall.issueConsent(db, brandon.id, url, { acknowledged: true, fetchImpl });
  assertEq(manifest.key, 'popcorn_vote', 'consent returns the resolved manifest');
  assert(!!consent_token, 'consent token issued');

  await assertThrowsCode(
    () => Promise.resolve().then(() => appInstall.installApp(db, emily.id, consent_token)),
    'consent_expired', 'consent token bound to brandon is rejected for emily'
  );

  // Expire it in place (simulate 60s elapsed) rather than sleeping in
  // the test.
  db.prepare("UPDATE app_consent_tokens SET expires_at = datetime('now', '-1 seconds') WHERE token_hash IS NOT NULL")
    .run();
  await assertThrowsCode(
    () => Promise.resolve().then(() => appInstall.installApp(db, brandon.id, consent_token)),
    'consent_expired', 'expired consent token is rejected (60s TTL)'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 5: full round trip + single-use + already_installed ----
{
  console.log('\nTest 5: resolve -> consent -> install round trip');
  const { db, tmpDir } = freshDb();
  appInstall._manifestCache.clear();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const url = 'https://apps.example.test/popcorn/manifest.json';
  const fetchImpl = stubFetch(fixtureManifest());

  await appInstall.resolveManifest(db, url, { fetchImpl });
  const { consent_token } = await appInstall.issueConsent(db, brandon.id, url, { acknowledged: true, fetchImpl });
  const installed = appInstall.installApp(db, brandon.id, consent_token);

  assertEq(installed.app, { key: 'popcorn_vote', name: 'Popcorn Vote', icon: '🍿' }, 'install returns app metadata');
  assert(!!installed.token_plaintext && installed.token_plaintext.startsWith(agentTokens.TOKEN_PREFIX_LABEL), 'install returns a usable token, once');

  const appRow = db.prepare('SELECT * FROM installed_apps WHERE key = ?').get('popcorn_vote');
  assert(!!appRow && !appRow.revoked_at, 'installed_apps row created, active');
  const tokenRow = db.prepare('SELECT * FROM agent_tokens WHERE app_id = ?').get('popcorn_vote');
  assertEq(tokenRow.user_id, brandon.id, 'agent_tokens row bound to the installing user');
  assertEq(JSON.parse(tokenRow.scopes), ['read:walls:media_club'], 'token scopes match the consented manifest');
  const modules = userModel.getUserModules(db, brandon.id);
  assert(modules.apps.enabled, '"apps" launcher module enabled for the installing user — the tile\'s room');

  assert(!!agentTokens.verify(db, installed.token_plaintext), 'the minted token authenticates');

  // Single-use: the same consent token cannot install twice.
  await assertThrowsCode(
    () => Promise.resolve().then(() => appInstall.installApp(db, brandon.id, consent_token)),
    'consent_expired', 'a used consent token cannot be replayed'
  );

  // already_installed: a fresh consent for the same (user, app) is
  // rejected at install time.
  const second = await appInstall.issueConsent(db, brandon.id, url, { acknowledged: true, fetchImpl });
  await assertThrowsCode(
    () => Promise.resolve().then(() => appInstall.installApp(db, brandon.id, second.consent_token)),
    'already_installed', 'installing an already-active app for the same user is rejected'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 6: a second household member installing the SAME app reuses the shared row ----
{
  console.log('\nTest 6: second user installing the same app key shares the installed_apps row');
  const { db, tmpDir } = freshDb();
  appInstall._manifestCache.clear();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const emily = db.prepare('SELECT id FROM users WHERE username = ?').get('emily');
  const url = 'https://apps.example.test/popcorn/manifest.json';
  const fetchImpl = stubFetch(fixtureManifest());

  const c1 = await appInstall.issueConsent(db, brandon.id, url, { acknowledged: true, fetchImpl });
  appInstall.installApp(db, brandon.id, c1.consent_token);
  const c2 = await appInstall.issueConsent(db, emily.id, url, { acknowledged: true, fetchImpl });
  const installed2 = appInstall.installApp(db, emily.id, c2.consent_token);
  assertEq(installed2.app.key, 'popcorn_vote', 'emily installs the same app key');

  const rows = db.prepare('SELECT COUNT(*) c FROM installed_apps WHERE key = ?').get('popcorn_vote').c;
  assertEq(rows, 1, 'only one installed_apps row exists for the shared key');
  const tokenCount = db.prepare('SELECT COUNT(*) c FROM agent_tokens WHERE app_id = ? AND revoked_at IS NULL').get('popcorn_vote').c;
  assertEq(tokenCount, 2, 'each user holds their own active token');

  // Revoking brandon's install must not disturb emily's.
  appInstall.revokeApp(db, brandon.id, 'popcorn_vote');
  const afterRevoke = db.prepare('SELECT revoked_at FROM installed_apps WHERE key = ?').get('popcorn_vote');
  assert(!afterRevoke.revoked_at, 'installed_apps stays active while emily still holds an active token');
  const emilyModules = userModel.getUserModules(db, emily.id);
  assert(emilyModules.apps.enabled, "emily's apps module is untouched by brandon's revoke");

  appInstall.revokeApp(db, emily.id, 'popcorn_vote');
  const afterBothRevoked = db.prepare('SELECT revoked_at FROM installed_apps WHERE key = ?').get('popcorn_vote');
  assert(!!afterBothRevoked.revoked_at, 'installed_apps archived once no household member has an active token');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 7: revoke kills the token immediately + removes the tile ----
{
  console.log('\nTest 7: revoke() is immediate and removes the tile');
  const { db, tmpDir } = freshDb();
  appInstall._manifestCache.clear();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const url = 'https://apps.example.test/popcorn/manifest.json';
  const fetchImpl = stubFetch(fixtureManifest());
  const c = await appInstall.issueConsent(db, brandon.id, url, { acknowledged: true, fetchImpl });
  const installed = appInstall.installApp(db, brandon.id, c.consent_token);

  assert(!!agentTokens.verify(db, installed.token_plaintext), 'token verifies before revoke');
  const revokeResult = appInstall.revokeApp(db, brandon.id, 'popcorn_vote');
  assertEq(revokeResult, { ok: true }, 'revoke reports ok');
  assertEq(agentTokens.verify(db, installed.token_plaintext), null, 'the revoked token no longer verifies — next call gets 401');

  const modules = userModel.getUserModules(db, brandon.id);
  assert(!modules.apps.enabled, '"apps" module disabled once this was the user\'s last third-party app');

  await assertThrowsCode(
    () => Promise.resolve().then(() => appInstall.revokeApp(db, brandon.id, 'popcorn_vote')),
    'not_installed', 're-revoking an already-revoked app 404s'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 8: reinstall mints a fresh token with the same scopes ----
{
  console.log('\nTest 8: reinstall() after revoke');
  const { db, tmpDir } = freshDb();
  appInstall._manifestCache.clear();
  const brandon = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon');
  const url = 'https://apps.example.test/popcorn/manifest.json';
  const fetchImpl = stubFetch(fixtureManifest());
  const c = await appInstall.issueConsent(db, brandon.id, url, { acknowledged: true, fetchImpl });
  const installed = appInstall.installApp(db, brandon.id, c.consent_token);
  appInstall.revokeApp(db, brandon.id, 'popcorn_vote');

  const reinstalled = appInstall.reinstallApp(db, brandon.id, 'popcorn_vote');
  assert(reinstalled.token_plaintext !== installed.token_plaintext, 'reinstall mints a genuinely fresh token');
  assert(!!agentTokens.verify(db, reinstalled.token_plaintext), 'the fresh token verifies');
  assertEq(agentTokens.verify(db, installed.token_plaintext), null, 'the old token stays revoked');
  const tokenRow = db.prepare('SELECT scopes FROM agent_tokens WHERE app_id = ? AND revoked_at IS NULL').get('popcorn_vote');
  assertEq(JSON.parse(tokenRow.scopes), ['read:walls:media_club'], 'reinstall grants the same scopes as the original manifest');
  const appRow = db.prepare('SELECT revoked_at FROM installed_apps WHERE key = ?').get('popcorn_vote');
  assert(!appRow.revoked_at, 'installed_apps un-archived on reinstall');

  await assertThrowsCode(
    () => Promise.resolve().then(() => appInstall.reinstallApp(db, brandon.id, 'never_installed')),
    'not_installed', 'reinstalling an app with no install history 404s'
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 9: manifest caching (URL + ETag, 5 min TTL) ----
{
  console.log('\nTest 9: manifest fetch is cached by URL, revalidated after TTL');
  const { db, tmpDir } = freshDb();
  appInstall._manifestCache.clear();
  const url = 'https://apps.example.test/caching-test/manifest.json';
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return {
      ok: true, status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'etag' ? 'W/"v1"' : null) },
      json: async () => fixtureManifest(),
    };
  };
  await appInstall.resolveManifest(db, url, { fetchImpl });
  await appInstall.resolveManifest(db, url, { fetchImpl });
  assertEq(calls, 1, 'second resolve within the TTL window is served from cache, not re-fetched');

  const cached = appInstall._manifestCache.get(url);
  cached.fetchedAt = Date.now() - (6 * 60 * 1000); // force past the 5-minute TTL
  await appInstall.resolveManifest(db, url, { fetchImpl });
  assertEq(calls, 2, 'a stale cache entry triggers a re-fetch');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ---- Test 10: HTTP integration — full round trip through the live routes ----
await new Promise((resolveTest) => {
  console.log('\nTest 10: HTTP round trip through the live /api/apps/* routes');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-app-install-http-'));

  // A tiny local manifest host. dev:true lets the routes accept its
  // loopback http:// URL without relaxing the check for anyone else.
  const manifestServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(fixtureManifest({ url: 'https://popcorn.example.test/app' })));
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

  Promise.all([
    new Promise((r) => manifestServer.listen(0, '127.0.0.1', r)),
    new Promise((r) => server.listen(0, '127.0.0.1', r)),
  ]).then(async () => {
    const manifestPort = manifestServer.address().port;
    const manifestUrl = `http://127.0.0.1:${manifestPort}/manifest.json`;
    const port = server.address().port;
    const base = { hostname: '127.0.0.1', port };
    const jsonHeaders = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });

    const loginRes = await request({
      ...base, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, { username: 'brandon', password: process.env.BRANDON_PASSWORD || process.env.ADMIN_PASSWORD || 'changeme' });
    const cookie = (loginRes.headers['set-cookie'] || [])[0];
    assert(loginRes.status === 200, 'login as brandon succeeds', JSON.stringify(loginRes.body));

    const resolveRes = await request({
      ...base, path: '/api/apps/resolve', method: 'POST', headers: jsonHeaders(cookie),
    }, { url: manifestUrl, dev: true });
    assertEq(resolveRes.status, 200, 'POST /api/apps/resolve succeeds');
    assertEq(resolveRes.body.manifest.key, 'popcorn_vote', 'resolve returns the manifest preview');

    const consentRes = await request({
      ...base, path: '/api/apps/consent', method: 'POST', headers: jsonHeaders(cookie),
    }, { manifest_url: manifestUrl, acknowledged: true, dev: true });
    assertEq(consentRes.status, 200, 'POST /api/apps/consent succeeds');
    const consentToken = consentRes.body.consent_token;
    assert(!!consentToken, 'consent_token issued over HTTP');

    const missingAckRes = await request({
      ...base, path: '/api/apps/consent', method: 'POST', headers: jsonHeaders(cookie),
    }, { manifest_url: manifestUrl, acknowledged: false, dev: true });
    assertEq(missingAckRes.status, 412, 'consent without acknowledged:true is 412');

    const installRes = await request({
      ...base, path: '/api/apps/install', method: 'POST', headers: jsonHeaders(cookie),
    }, { consent_token: consentToken });
    assertEq(installRes.status, 200, 'POST /api/apps/install succeeds');
    const tokenPlaintext = installRes.body.token_plaintext;
    assert(!!tokenPlaintext, 'install returns the token exactly once');
    assertEq(installRes.body.app.key, 'popcorn_vote', 'install response names the installed app');

    const listRes = await request({ ...base, path: '/api/apps', method: 'GET', headers: { Cookie: cookie } });
    assertEq(listRes.status, 200, 'GET /api/apps succeeds');
    assert(listRes.body.some((a) => a.key === 'popcorn_vote'), 'the freshly installed app\'s tile appears in GET /api/apps');

    const getRes = await request({ ...base, path: '/api/apps/popcorn_vote', method: 'GET', headers: { Cookie: cookie } });
    assertEq(getRes.status, 200, 'GET /api/apps/:key succeeds');
    assertEq(getRes.body.scopes, ['read:walls:media_club'], 'GET /api/apps/:key reports granted scopes');
    assertEq(getRes.body.activity_summary.call_count, 0, 'activity summary starts at zero calls');

    const appCallRes = await request({
      ...base, path: '/api/apps/popcorn_vote', method: 'GET', headers: { Authorization: `Bearer ${tokenPlaintext}` },
    });
    assertEq(appCallRes.status, 200, 'the minted app-scoped token authenticates a real API call');

    const revokeRes = await request({ ...base, path: '/api/apps/popcorn_vote/revoke', method: 'POST', headers: { Cookie: cookie } });
    assertEq(revokeRes.status, 200, 'POST /api/apps/:key/revoke succeeds');

    const postRevokeRes = await request({
      ...base, path: '/api/apps/popcorn_vote', method: 'GET', headers: { Authorization: `Bearer ${tokenPlaintext}` },
    });
    assertEq(postRevokeRes.status, 401, 'the revoked token gets 401 on its very next call');

    const listAfterRevokeRes = await request({ ...base, path: '/api/apps', method: 'GET', headers: { Cookie: cookie } });
    assert(!listAfterRevokeRes.body.some((a) => a.key === 'popcorn_vote'), 'the revoked app\'s tile is gone from GET /api/apps');

    server.close();
    manifestServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resolveTest();
  }).catch((err) => {
    ng('HTTP integration test crashed', err.stack || err.message);
    try { server.close(); } catch (_) {}
    try { manifestServer.close(); } catch (_) {}
    resolveTest();
  });
});

console.log(`\nResults: ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);

}

main();
