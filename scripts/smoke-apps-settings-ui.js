#!/usr/bin/env node
// PHA-2201.4 (PHA-2232) smoke test: Settings → Apps UI — apps list
// (built-in + third-party), per-app detail (scopes + activity),
// revoke, and the paste-a-manifest-URL install flow.
//
// Same two-layer approach as scripts/smoke-consent-ui.js /
// scripts/test-app-install.js: no real browser/DOM here, so this
// checks (1) the SPA source actually wires up the sheets this issue's
// acceptance criteria describe, and (2) a live HTTP round trip against
// server.js exercises the full contract those sheets call —
// resolve -> consent -> install -> GET /api/apps (builtin + 3rd-party,
// same registry read path) -> GET /api/apps/:key (scopes describable
// via lib/scope-display.js) -> an app-token API call -> GET
// /api/apps/:key/activity shows that real app_api_log row -> revoke ->
// 401 on the very next call with that same token, all in one run (the
// acceptance bullet's "verified in the same UI session").
//
// Run after `npm test`: node scripts/smoke-apps-settings-ui.js

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-apps-settings-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3102';
process.env.ADMIN_PASSWORD = 'smoke-apps-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-apps-brandon-pw';
process.env.SESSION_SECRET = 'smoke-apps-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }

function request(opts, body) {
  return new Promise((resolve, reject) => {
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
}

(async () => {
  // ---- 1. Static source: index.html actually wires up the sheets
  //         this issue's acceptance criteria describe. ----
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert(html.includes("id=\"f-apps\""), 'avatar menu has an Apps entry point');
  assert(html.includes('src="/lib/scope-display.js"'), 'index.html loads the shared scope mapping');
  assert(html.includes('src="/consent.js"'), 'index.html loads consent.js to reuse renderConsentScreen');
  assert(html.includes('function openAppsSheet'), 'openAppsSheet() exists');
  assert(html.includes('function openAppDetailSheet'), 'openAppDetailSheet() exists');
  assert(html.includes('function openAppInstallSheet'), 'openAppInstallSheet() exists');
  assert(html.includes('function loadAppActivity'), 'loadAppActivity() exists (paginated activity)');
  assert(html.includes("api('POST', `/api/apps/${encodeURIComponent(app.key)}/revoke`)"), 'detail sheet calls POST /api/apps/:key/revoke');
  assert(html.includes('window.HomesteadConsent.renderConsentScreen'), 'install flow reuses the PHA-2230 consent screen renderer, not a reimplementation');
  assert(html.includes("api('POST', '/api/apps/resolve'"), 'install flow calls POST /api/apps/resolve');
  assert(html.includes("api('POST', '/api/apps/consent'"), 'install flow calls POST /api/apps/consent');
  assert(html.includes("api('POST', '/api/apps/install'"), 'install flow calls POST /api/apps/install');
  assert(html.includes('window.ScopeDisplay.describeScopes'), 'detail sheet renders scopes via the shared mapping, not raw scope strings');
  assert(html.includes("app.builtin?''"), 'detail sheet hides Revoke for built-in apps (no app-scoped token to kill)');

  // ---- 2. Live HTTP round trip. ----
  const app = require('../server.js');
  const server = http.createServer(app);
  const manifestServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      key: 'popcorn_vote', name: 'Popcorn Vote', description: 'Family movie night voting.',
      icon: '🍿', room: null, requires: [], tier: 'advanced', version: '0.1.0',
      author: 'homestead-external', url: 'https://popcorn.example.test/app', open_mode: 'tab',
      scopes: ['read:walls:media_club'], mcp: true, webhooks: [], entity_kinds: [], default_enabled: false,
    }));
  });

  await Promise.all([
    new Promise((r) => manifestServer.listen(0, '127.0.0.1', r)),
    new Promise((r) => server.listen(3102, '127.0.0.1', r)),
  ]);
  try {
    const manifestPort = manifestServer.address().port;
    const manifestUrl = `http://127.0.0.1:${manifestPort}/manifest.json`;
    const base = { hostname: '127.0.0.1', port: 3102 };
    const jsonHeaders = (cookie) => ({ 'Content-Type': 'application/json', Cookie: cookie });

    const loginRes = await request({
      ...base, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json' },
    }, { username: 'brandon', password: process.env.BRANDON_PASSWORD });
    const cookie = (loginRes.headers['set-cookie'] || [])[0];
    assert(loginRes.status === 200, 'login as brandon succeeds', JSON.stringify(loginRes.body));

    // Fresh user already has `wall` enabled (Amendment 2 default) —
    // the Apps list must show it alongside anything third-party,
    // proving the "same registry read path" acceptance bullet.
    const listBefore = await request({ ...base, path: '/api/apps', method: 'GET', headers: { Cookie: cookie } });
    assertBuiltinPresent(listBefore.body);
    function assertBuiltinPresent(list) {
      const wall = (list || []).find((a) => a.key === 'wall');
      assert(!!wall, 'GET /api/apps includes the default-enabled "wall" built-in before any third-party install');
      assert(wall && wall.builtin === true, 'the built-in row is tagged builtin:true');
    }

    const getWallRes = await request({ ...base, path: '/api/apps/wall', method: 'GET', headers: { Cookie: cookie } });
    assert(getWallRes.status === 200, 'GET /api/apps/:key works for a built-in module key');
    assert(getWallRes.body.builtin === true, 'built-in detail response is tagged builtin:true');
    assert(Array.isArray(getWallRes.body.scopes) && getWallRes.body.scopes.length > 0, 'built-in detail reports its registry scopes[]');

    const resolveRes = await request({
      ...base, path: '/api/apps/resolve', method: 'POST', headers: jsonHeaders(cookie),
    }, { url: manifestUrl, dev: true });
    assert(resolveRes.status === 200, 'POST /api/apps/resolve succeeds (paste-URL step)');

    const consentRes = await request({
      ...base, path: '/api/apps/consent', method: 'POST', headers: jsonHeaders(cookie),
    }, { manifest_url: manifestUrl, acknowledged: true, dev: true });
    assert(consentRes.status === 200, 'POST /api/apps/consent succeeds');

    const installRes = await request({
      ...base, path: '/api/apps/install', method: 'POST', headers: jsonHeaders(cookie),
    }, { consent_token: consentRes.body.consent_token });
    assert(installRes.status === 200, 'POST /api/apps/install succeeds — install flow works end-to-end from the UI\'s perspective');
    const tokenPlaintext = installRes.body.token_plaintext;

    const listAfter = await request({ ...base, path: '/api/apps', method: 'GET', headers: { Cookie: cookie } });
    assert(listAfter.body.some((a) => a.key === 'wall' && a.builtin === true), 'built-in still listed after a third-party install');
    const installedRow = listAfter.body.find((a) => a.key === 'popcorn_vote');
    assert(!!installedRow && installedRow.builtin === false, 'freshly installed app appears, tagged builtin:false — both halves from GET /api/apps');

    const getAppRes = await request({ ...base, path: '/api/apps/popcorn_vote', method: 'GET', headers: { Cookie: cookie } });
    const scopeDisplay = require('../lib/scope-display');
    const phrases = scopeDisplay.describeScopes(getAppRes.body.scopes, { entityKinds: getAppRes.body.entity_kinds });
    assert(phrases.length === getAppRes.body.scopes.length, 'every granted scope on the detail view maps to a plain-language phrase (no raw scope leaks to the user)');

    // Drive a real app-scoped API call so app_api_log has a genuine row
    // for the per-app activity view to render.
    const appCallRes = await request({
      ...base, path: '/api/apps/popcorn_vote', method: 'GET', headers: { Authorization: `Bearer ${tokenPlaintext}` },
    });
    assert(appCallRes.status === 200, 'the minted app-scoped token authenticates a real call (generates an activity row)');

    let activityRes;
    for (let i = 0; i < 20; i++) {
      activityRes = await request({ ...base, path: '/api/apps/popcorn_vote/activity?limit=20&offset=0', method: 'GET', headers: { Cookie: cookie } });
      if (activityRes.body && activityRes.body.total > 0) break;
      await new Promise((r) => setTimeout(r, 50)); // the log write happens on res.on('finish'), after that response is already on the wire
    }
    assert(activityRes.status === 200, 'GET /api/apps/:key/activity succeeds');
    assert(activityRes.body.total >= 1, 'per-app activity has at least one real app_api_log row');
    assert(activityRes.body.items.some((it) => it.route === 'GET /api/apps/popcorn_vote'), 'the logged row is the actual call that was just made, not a placeholder');

    const revokeRes = await request({ ...base, path: '/api/apps/popcorn_vote/revoke', method: 'POST', headers: { Cookie: cookie } });
    assert(revokeRes.status === 200, 'POST /api/apps/:key/revoke succeeds (single action — no disable-then-delete)');

    const listAfterRevoke = await request({ ...base, path: '/api/apps', method: 'GET', headers: { Cookie: cookie } });
    assert(!listAfterRevoke.body.some((a) => a.key === 'popcorn_vote'), 'revoke removes the tile from GET /api/apps');

    const postRevokeCall = await request({
      ...base, path: '/api/apps/popcorn_vote', method: 'GET', headers: { Authorization: `Bearer ${tokenPlaintext}` },
    });
    assert(postRevokeCall.status === 401, 'the revoked token gets 401 on its very next call — same run, same session, as the acceptance bullet requires');
  } finally {
    server.close();
    manifestServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
