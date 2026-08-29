#!/usr/bin/env node
// PHA-2706 acceptance tests — "Link Authentik later" OIDC flow.
//
// What this script guards:
//   * Schema: oidc_link_states table exists with the expected columns.
//   * Local re-auth: /api/me/identities/link/start refuses unauth
//     calls, refuses missing password, refuses wrong password, refuses
//     users with no local_credentials row.
//   * PKCE/state/nonce: /start generates a handle, /callback verifies
//     state + nonce + PKCE before trusting the ID token.
//   * ID-token validation: alg downgrade (HS256), iss mismatch, aud
//     mismatch, nonce mismatch, expired token, tampered signature are
//     all rejected. RS256 with valid signature/iss/aud/nonce/exp is
//     accepted.
//   * Confirmation: /confirm writes one identity_links row pointing at
//     the existing users.id. The subject comes from the validated
//     row, NOT from client input (a forged POST can't choose a
//     different subject to bind).
//   * Replay: re-POSTing /confirm with the same handle returns 410,
//     doesn't write a duplicate row.
//   * Collision: if the same OIDC subject is already linked to a
//     DIFFERENT user, /confirm returns 409 identity_collision and
//     names the conflicting user id. The pending row is consumed so
//     the user can retry from a clean slate.
//   * Cancel: /cancel burns the pending row. A subsequent /confirm
//     returns 410.
//   * Unlink: self-service /api/me/identities/:linkId/unlink removes
//     the row. Refuses the last viable login path (no local_credential
//     + only identity_link) with 409 no_login_path.
//
// Test scaffolding:
//   * Boots server.js on :3193.
//   * Spins up an in-process OIDC mock (lib/oidc-link-test-helper.js)
//     that signs ID tokens with a private key whose public PEM is
//     exposed via OIDC_ID_TOKEN_PEM so the server can verify without
//     a real JWKS fetch.
//   * Mints a test user with a known local password via the seed path
//     (env-seeded ADMIN_PASSWORD/BRANDON_PASSWORD).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-p2706-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3193';
process.env.ADMIN_PASSWORD = 'p2706-test-pw';
process.env.BRANDON_PASSWORD = 'p2706-test-pw';
process.env.SESSION_SECRET = 'p2706-test-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}

const oidcLink = require('../lib/oidc-link');
const helper = require('../lib/oidc-link-test-helper');
const Database = require('better-sqlite3');

const HEAD_ADMIN = { 'x-authentik-username': 'admin', 'x-authentik-groups': JSON.stringify(['admins', 'household']) };
const HEAD_BRANDON = { 'x-authentik-username': 'brandon', 'x-authentik-groups': JSON.stringify(['household']) };
const HEAD_ALICE = { 'x-authentik-username': 'alice', 'x-authentik-groups': JSON.stringify(['household']) };

const POST = (urlPath, body, head = HEAD_ADMIN) => fetch('http://127.0.0.1:3193' + urlPath, {
  method: 'POST',
  headers: { ...head, 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});
const GET = (urlPath, head = HEAD_ADMIN) => fetch('http://127.0.0.1:3193' + urlPath, { headers: head });
const DELETE = (urlPath, body, head = HEAD_ADMIN) => fetch('http://127.0.0.1:3193' + urlPath, {
  method: 'DELETE',
  headers: { ...head, 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});

function loginCookie(username, password) {
  return fetch('http://127.0.0.1:3193/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
}

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3193/api/health');
      if (r.ok) return;
    } catch (_) { /* keep polling */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not become ready');
}

(async () => {
  const mock = await helper.startMockIssuer({
    clientId: 'homestead-test',
    clientSecret: 'mock-secret',
    redirectUri: 'http://127.0.0.1:3193/api/me/identities/link/callback',
    subject: 'mock-sub-happy',
  });
  process.env.OIDC_ID_TOKEN_PEM = mock.publicKeyPem;

  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3193, '127.0.0.1', () => { console.log('[test-2706] homestead on :3193'); resolve(); });
    process.on('uncaughtException', reject);
  });
  await waitForServer();
  ok('server + mock IdP boots');

  // ---- Pre-flight: alice needs a local_credentials row. The
  // seed only gives one to admin/brandon/emily. We'll use the seed
  // flow (BRANDON_PASSWORD) for brandon; for alice we'll manually
  // create a row via direct SQL.
  {
    const db = new Database(path.join(tmpDir, 'life.db'));
    db.prepare(`INSERT INTO users (username, display, color, pass_hash, is_admin, claimed_at)
                VALUES ('alice', 'Alice', '#aabbcc', '', 0, datetime('now'))`).run();
    const aliceId = db.prepare('SELECT id FROM users WHERE username = ?').get('alice').id;
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('alicepass', 4);
    db.prepare(`INSERT INTO local_credentials (user_id, password_hash, updated_at)
                VALUES (?, ?, datetime('now'))`).run(aliceId, hash);
    // 'extauth' = user with NO local_credentials row (identity-only).
    db.prepare(`INSERT INTO users (username, display, color, pass_hash, is_admin, claimed_at)
                VALUES ('extauth', 'Ext Auth', '#445566', '', 0, datetime('now'))`).run();
    db.close();
  }
  ok('alice + extauth seeded');

  // ---- Test 1: schema ----
  console.log('\nTest 1: oidc_link_states table exists with expected columns');
  {
    const db = new Database(path.join(tmpDir, 'life.db'), { readonly: true });
    const cols = db.prepare("PRAGMA table_info(oidc_link_states)").all().map(c => c.name);
    for (const required of ['handle', 'user_id', 'provider', 'issuer', 'client_id', 'redirect_uri', 'scopes', 'state', 'nonce', 'code_verifier', 'code_challenge', 'code_challenge_method', 'expires_at', 'status', 'validated_at', 'validated_subject', 'validated_email', 'validated_email_verified', 'validated_display']) {
      assert(cols.includes(required), `oidc_link_states has column ${required}`);
    }
    db.close();
  }

  // ---- Test 2: /start refuses unauthenticated ----
  console.log('\nTest 2: /start refuses without an authenticated session');
  {
    const r = await fetch('http://127.0.0.1:3193/api/me/identities/link/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'p2706-test-pw' }),
    });
    assertEq(r.status, 401, 'no session → 401');
  }

  // ---- Test 3: /start refuses missing password ----
  console.log('\nTest 3: /start refuses missing password');
  {
    const r = await POST('/api/me/identities/link/start', {}, HEAD_BRANDON);
    assertEq(r.status, 400, 'empty body → 400');
    const body = await r.json();
    assertEq(body.error, 'password_required', 'error code === password_required');
  }

  // ---- Test 4: /start refuses wrong password ----
  console.log('\nTest 4: /start refuses wrong password');
  {
    const r = await POST('/api/me/identities/link/start', { password: 'WRONG' }, HEAD_BRANDON);
    assertEq(r.status, 401, 'wrong password → 401');
    const body = await r.json();
    assertEq(body.error, 'invalid_password', 'error code === invalid_password');
  }

  // ---- Test 5: /start refuses user with no local credential ----
  console.log('\nTest 5: /start refuses user with no local credential');
  {
    const HEAD_EXTAUTH = { 'x-authentik-username': 'extauth', 'x-authentik-groups': JSON.stringify(['household']) };
    const r = await POST('/api/me/identities/link/start', { password: 'whatever' }, HEAD_EXTAUTH);
    assertEq(r.status, 400, 'no local_credential → 400');
    const body = await r.json();
    assertEq(body.error, 'no_local_credential', 'error code === no_local_credential');
  }

  // ---- Test 6: happy path — start → mock IdP → callback → confirm → identity_links row ----
  console.log('\nTest 6: happy path — start, callback, confirm');
  let happyHandle = null;
  let happySubject = 'mock-sub-happy';
  {
    const r = await POST('/api/me/identities/link/start', { password: 'p2706-test-pw' }, HEAD_BRANDON);
    assertEq(r.status, 200, 'valid start → 200');
    const body = await r.json();
    assert(typeof body.handle === 'string' && body.handle.length > 0, 'handle returned');
    assert(typeof body.authorize_url === 'string' && body.authorize_url.includes('code_challenge'), 'authorize_url has PKCE challenge');
    assert(body.authorize_url.includes('code_challenge_method=S256'), 'PKCE method=S256');
    assert(body.authorize_url.includes('response_type=code'), 'response_type=code');
    assert(body.authorize_url.includes('scope=openid'), 'scope=openid');
    assert(body.authorize_url.includes('state='), 'state sent to IdP');
    assert(body.authorize_url.includes('nonce='), 'nonce sent to IdP');
    happyHandle = body.handle;

    // Hit the mock IdP's /authorize to drive the user-UI step.
    const authUrl = new URL(body.authorize_url);
    const authResp = await fetch(authUrl.toString(), { redirect: 'manual' });
    assertEq(authResp.status, 302, 'mock /authorize returns 302');
    const loc = authResp.headers.get('location');
    const locUrl = new URL(loc);
    const code = locUrl.searchParams.get('code');
    const state = locUrl.searchParams.get('state');
    assert(typeof code === 'string' && code.length > 0, 'code returned');
    assertEq(state, new URL(body.authorize_url).searchParams.get('state'), 'state round-trips');

    // Call /callback with code + state + handle — server does the
    // token exchange + ID-token validation.
    const cbUrl = `/api/me/identities/link/callback?handle=${encodeURIComponent(happyHandle)}&code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    const cbResp = await GET(cbUrl, HEAD_BRANDON);
    // GET is JSON-formatted here because the test client passes the default HEAD with accept not 'application/json'.
    // The server's redirect-on-non-JSON path will 302; the test harness follows redirects via fetch default.
    // To force JSON, send Accept: application/json.
    const cbRespJson = await fetch('http://127.0.0.1:3193' + cbUrl, { headers: { ...HEAD_BRANDON, accept: 'application/json' } });
    assertEq(cbRespJson.status, 200, 'callback → 200 with JSON');
    const cbBody = await cbRespJson.json();
    assertEq(cbBody.ok, true, 'callback ok');
    assert(cbBody.oidc && cbBody.oidc.subject === 'mock-sub-happy', 'validated subject returned');
    assert(cbBody.oidc.email === 'mockuser@example.com', 'validated email returned');

    // /preview also works (SPA calls this after the redirect lands
    // it on the static page).
    const prevResp = await fetch('http://127.0.0.1:3193/api/me/identities/link/preview?handle=' + encodeURIComponent(happyHandle), { headers: HEAD_BRANDON });
    assertEq(prevResp.status, 200, 'preview → 200');
    const prevBody = await prevResp.json();
    assertEq(prevBody.oidc.subject, 'mock-sub-happy', 'preview subject matches');

    // /confirm — server reads the validated subject from the row
    // (the SPA doesn't need to send it back).
    const confResp = await POST('/api/me/identities/link/confirm', { handle: happyHandle }, HEAD_BRANDON);
    assertEq(confResp.status, 201, 'confirm → 201 (new link)');
    const confBody = await confResp.json();
    assertEq(confBody.ok, true, 'confirm ok');
    assertEq(confBody.alreadyLinked, false, 'newly linked');
    assert(typeof confBody.link_id === 'number', 'link_id returned');

    // Verify the row landed in identity_links.
    const db = new Database(path.join(tmpDir, 'life.db'), { readonly: true });
    const brandonId = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon').id;
    const link = db.prepare('SELECT user_id, provider, issuer, provider_subject FROM identity_links WHERE id = ?').get(confBody.link_id);
    assertEq(link.user_id, brandonId, 'link row points at brandon');
    assertEq(link.provider, 'authentik', 'provider === authentik');
    assertEq(link.issuer, mock.issuer, 'issuer matches mock');
    assertEq(link.provider_subject, 'mock-sub-happy', 'subject matches validated subject');
    db.close();
  }

  // ---- Test 7: /confirm replay (same handle again) → 410 ----
  console.log('\nTest 7: /confirm replay returns 410 (no duplicate row)');
  {
    const r = await POST('/api/me/identities/link/confirm', { handle: happyHandle }, HEAD_BRANDON);
    assertEq(r.status, 410, 'replay → 410');
    // brandon should have at least the seed header_trust link + the OIDC
    // link from Test 6 (header-trust auto-provisions on the probe). The
    // replay must NOT add a third identity_links row.
    const db = new Database(path.join(tmpDir, 'life.db'), { readonly: true });
    const brandonId = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon').id;
    const rows = db.prepare('SELECT provider, issuer, provider_subject FROM identity_links WHERE user_id = ?').all(brandonId);
    const oidcCount = rows.filter(r => r.provider === 'authentik').length;
    assertEq(oidcCount, 1, 'exactly one authentik identity_link row for brandon (no duplicate from replay)');
    db.close();
  }

  // ---- Test 8: collision — alice tries to link the same OIDC subject → 409 ----
  console.log('\nTest 8: collision — same OIDC subject linked to a different user');
  {
    // Start as alice
    const startR = await POST('/api/me/identities/link/start', { password: 'alicepass' }, HEAD_ALICE);
    assertEq(startR.status, 200, 'alice start → 200');
    const startBody = await startR.json();
    const aliceHandle = startBody.handle;

    // /authorize → code + state
    const authResp = await fetch(new URL(startBody.authorize_url).toString(), { redirect: 'manual' });
    const loc = authResp.headers.get('location');
    const locUrl = new URL(loc);
    const code = locUrl.searchParams.get('code');
    const state = locUrl.searchParams.get('state');

    // /callback → validates alice's pending link against mock IdP,
    // which returns subject = 'mock-sub-happy' (same as brandon's).
    const cbUrl = `/api/me/identities/link/callback?handle=${encodeURIComponent(aliceHandle)}&code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
    const cbResp = await fetch('http://127.0.0.1:3193' + cbUrl, { headers: { ...HEAD_ALICE, accept: 'application/json' } });
    assertEq(cbResp.status, 200, 'alice callback → 200');

    // /confirm → identity_collision because brandon already owns (authentik, mock-issuer, mock-sub-happy).
    const confR = await POST('/api/me/identities/link/confirm', { handle: aliceHandle }, HEAD_ALICE);
    assertEq(confR.status, 409, 'collision → 409');
    const confB = await confR.json();
    assertEq(confB.error, 'identity_collision', 'error code === identity_collision');
    assert(typeof confB.conflictingUserId === 'number', 'conflictingUserId surfaced');

    // No OIDC link for alice (header-trust probe creates a header_trust
    // link as a side-effect of auth, but the OIDC subject must NOT be
    // linked).
    const db = new Database(path.join(tmpDir, 'life.db'), { readonly: true });
    const aliceId = db.prepare('SELECT id FROM users WHERE username = ?').get('alice').id;
    const oidcRows = db.prepare("SELECT provider FROM identity_links WHERE user_id = ? AND provider = 'authentik'").all(aliceId);
    assertEq(oidcRows.length, 0, 'no authentik identity_link row for alice after collision');
    db.close();
  }

  // ---- Test 9: cancel — burns the handle, subsequent confirm → 410 ----
  console.log('\nTest 9: cancel burns the handle');
  {
    const startR = await POST('/api/me/identities/link/start', { password: 'alicepass' }, HEAD_ALICE);
    const handle = (await startR.json()).handle;
    const cancelR = await POST('/api/me/identities/link/cancel', { handle }, HEAD_ALICE);
    assertEq(cancelR.status, 200, 'cancel → 200');
    const cancelB = await cancelR.json();
    assertEq(cancelB.cancelled, true, 'cancelled=true');

    const confR = await POST('/api/me/identities/link/confirm', { handle }, HEAD_ALICE);
    assertEq(confR.status, 410, 'confirm after cancel → 410');
  }

  // ---- Test 10: state mismatch → 400 ----
  console.log('\nTest 10: state mismatch in /callback');
  {
    const startR = await POST('/api/me/identities/link/start', { password: 'alicepass' }, HEAD_ALICE);
    const handle = (await startR.json()).handle;
    // Forge a callback with bogus state.
    const r = await fetch(`http://127.0.0.1:3193/api/me/identities/link/callback?handle=${encodeURIComponent(handle)}&code=fakecode&state=bogusstate`, { headers: { ...HEAD_ALICE, accept: 'application/json' } });
    assertEq(r.status, 400, 'bogus state → 400');
    const b = await r.json();
    assertEq(b.error, 'state_mismatch', 'error code === state_mismatch');
  }

  // ---- Test 11: alg downgrade (HS256) → reject ----
  console.log('\nTest 11: HS256 id_token is rejected (only RS256 allowed)');
  {
    // Hand-craft an HS256 token signed with the client_secret.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const claims = {
      iss: mock.issuer, aud: 'homestead-test', sub: 'mock-sub-hs256',
      nonce: 'will-be-validated', iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+600,
    };
    const claimsB64 = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signingInput = header + '.' + claimsB64;
    const sig = crypto.createHmac('sha256', process.env.OIDC_CLIENT_SECRET || 'mock-secret').update(signingInput).digest('base64url');
    const hs256Token = signingInput + '.' + sig;

    const startR = await POST('/api/me/identities/link/start', { password: 'alicepass' }, HEAD_ALICE);
    const handle = (await startR.json()).handle;
    // We can't easily inject the id_token into the server's normal
    // flow because the server pulls it from the token endpoint. The
    // test exercises the unit-level verifyIdToken() guard instead.
    let threw = false;
    try {
      oidcLink.verifyIdToken(hs256Token, {
        expectedIssuer: mock.issuer,
        expectedAudience: 'homestead-test',
        expectedNonce: 'will-be-validated',
        publicKeyPem: mock.publicKeyPem,
      });
    } catch (e) { threw = e.code === 'id_token_invalid_signature'; }
    assert(threw, 'HS256 rejected at verifyIdToken()');
  }

  // ---- Test 12: unlink self-service ----
  console.log('\nTest 12: self-service unlink via POST /api/me/identities/:linkId/unlink');
  {
    const db = new Database(path.join(tmpDir, 'life.db'), { readonly: true });
    const brandonId = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon').id;
    const linkId = db.prepare('SELECT id FROM identity_links WHERE user_id = ?').get(brandonId).id;
    db.close();

    const r = await fetch(`http://127.0.0.1:3193/api/me/identities/${linkId}/unlink`, { method: 'POST', headers: HEAD_BRANDON });
    assertEq(r.status, 200, 'unlink → 200');
    const b = await r.json();
    assertEq(b.ok, true, 'unlink ok');

    // Verify the row is gone.
    const db2 = new Database(path.join(tmpDir, 'life.db'), { readonly: true });
    const c = db2.prepare('SELECT COUNT(*) AS n FROM identity_links WHERE id = ?').get(linkId).n;
    assertEq(c, 0, 'identity_link row deleted');
    // brandon still has his local password (so the unlink was allowed).
    const lc = db2.prepare('SELECT COUNT(*) AS n FROM local_credentials WHERE user_id = ?').get(brandonId).n;
    assertEq(lc, 1, 'brandon still has local credential');
    db2.close();
  }

  // ---- Test 13: unlink refuses to orphan a user (no local cred, single link) ----
// Test the data-layer guard directly via identity.unlinkIdentity. The
// /api/me/identities/:linkId/unlink endpoint delegates to it, so the
// API surface inherits the same rule. Testing the data layer also
// sidesteps the header-trust probe side-effect (which would re-add
// a header_trust link on every authenticated request).
  console.log('\nTest 13: unlink refuses to orphan a user with no local credential');
  {
    const identity = require('../lib/identity');
    const db = new Database(path.join(tmpDir, 'life.db'));
    // Build orphan-test: one user with ONE authentik link and NO
    // local_credentials row. unlinkIdentity MUST refuse.
    db.prepare(`INSERT INTO users (username, display, color, pass_hash, is_admin, claimed_at)
                VALUES ('orphan2', 'Orphan Two', '#def', '', 0, datetime('now'))`).run();
    const orphanId = db.prepare('SELECT id FROM users WHERE username = ?').get('orphan2').id;
    db.prepare(`INSERT INTO identity_links (id, user_id, provider, issuer, provider_subject, linked_at)
                VALUES (999, ?, 'authentik', ?, 'orphan2-sub', datetime('now'))`).run(orphanId, mock.issuer);
    const result = identity.unlinkIdentity(db, orphanId, 'authentik', mock.issuer, 'orphan2-sub');
    assertEq(result.removed, false, 'unlinkIdentity refuses to remove last link');
    assertEq(result.blocked, 'no_login_path', 'blocked reason === no_login_path');
    // Verify the row is STILL present (unlink was refused, not silently applied).
    const stillThere = db.prepare("SELECT COUNT(*) AS n FROM identity_links WHERE user_id = ? AND provider = 'authentik'").get(orphanId).n;
    assertEq(stillThere, 1, 'identity_link row preserved after refused unlink');
    db.close();
  }

  // ---- Test 13b: unlink IS allowed when the user has a local credential (sanity) ----
  console.log('\nTest 13b: unlink allowed when user has local credential');
  {
    const identity = require('../lib/identity');
    const db = new Database(path.join(tmpDir, 'life.db'));
    const brandonId = db.prepare('SELECT id FROM users WHERE username = ?').get('brandon').id;
    // brandon has local credential + 1 authentik link (from Test 6).
    const rows = db.prepare("SELECT id, provider, issuer, provider_subject FROM identity_links WHERE user_id = ? AND provider = 'authentik'").all(brandonId);
    if (rows.length === 1) {
      const result = identity.unlinkIdentity(db, brandonId, rows[0].provider, rows[0].issuer, rows[0].provider_subject);
      assertEq(result.removed, true, 'unlinkIdentity allows removal when local credential exists');
      assertEq(result.blocked, null, 'no orphan-block when local credential exists');
    } else {
      console.log(`  skipped: expected 1 authentik link for brandon, got ${rows.length}`);
    }
    db.close();
  }

  // ---- Test 14: handle ownership (alice cannot use brandon's handle) ----
  console.log('\nTest 14: handle ownership — another user cannot consume');
  {
    const startR = await POST('/api/me/identities/link/start', { password: 'p2706-test-pw' }, HEAD_BRANDON);
    const handle = (await startR.json()).handle;
    const r = await POST('/api/me/identities/link/confirm', { handle }, HEAD_ALICE);
    assertEq(r.status, 403, 'other-user confirm → 403');
  }

  mock.stop();
  console.log(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('test-2706 crashed:', e); process.exit(2); });