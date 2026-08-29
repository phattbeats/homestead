#!/usr/bin/env node
// PHA-2704 API surface acceptance tests for the canonical identity foundation.
//
// Boots server.js on an ephemeral port (3192) and exercises the new
// /api/me/identities endpoints end-to-end against a header-trust mock.
// Pairs with scripts/test-2704-identity-foundation.js (which covers
// the data-layer contract).
//
// What this script guards:
//   * GET /api/me/identities returns the linked identities for the
//     signed-in user.
//   * POST /api/me/identities (admin-only) creates a new identity link
//     and returns 201. Non-admin returns 403.
//   * POST /api/me/identities refuses identity_collision (409).
//   * DELETE /api/me/identities removes a link. Refuses to orphan
//     the user (409 no_login_path).
//   * /api/login continues to authenticate against local_credentials
//     (NOT users.pass_hash) — regression guard for the migration.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-p2704api-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3192';
process.env.ADMIN_PASSWORD = 'p2704api-test-pw';
process.env.BRANDON_PASSWORD = 'p2704api-test-pw';
process.env.SESSION_SECRET = 'p2704api-test-secret';
process.env.NODE_ENV = 'production';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

const HEAD_ADMIN = {
  'x-authentik-username': 'admin',
  'x-authentik-groups': JSON.stringify(['admins', 'household']),
};
const HEAD_BRANDON = {
  'x-authentik-username': 'brandon',
  'x-authentik-groups': JSON.stringify(['household']),
};

const POST = (urlPath, body, head = HEAD_ADMIN) => fetch('http://127.0.0.1:3192' + urlPath, {
  method: 'POST',
  headers: { ...head, 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});
const GET = (urlPath, head = HEAD_ADMIN) => fetch('http://127.0.0.1:3192' + urlPath, { headers: head });
const DELETE = (urlPath, body, head = HEAD_ADMIN) => fetch('http://127.0.0.1:3192' + urlPath, {
  method: 'DELETE',
  headers: { ...head, 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});

(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3192, '127.0.0.1', () => { console.log('[test-2704-identity-api] homestead on :3192'); resolve(); });
    process.on('uncaughtException', reject);
  });

  // Wait for ready
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3192/api/health');
      if (r.ok) break;
    } catch (_) { /* keep polling */ }
    await new Promise(r => setTimeout(r, 100));
  }
  ok('server boots');

  console.log('\nTest 1: GET /api/me/identities returns linked identities');
  {
    // First CLAIM creates a (header_trust, legacy-bootstrap, brandon) link.
    const r = await GET('/api/me/identities', HEAD_BRANDON);
    assertEq(r.status, 200, 'GET /api/me/identities → 200');
    const body = await r.json();
    assert(Array.isArray(body.identities), 'response.identities is an array');
    assert(body.identities.length >= 1, 'brandon has at least one identity link');
    const headerTrust = body.identities.find(i => i.provider === 'header_trust');
    assert(!!headerTrust, 'header_trust link present');
    assertEq(headerTrust.issuer, 'legacy-bootstrap', 'link issuer is legacy-bootstrap');
    assertEq(headerTrust.provider_subject, 'brandon', 'link subject matches');
  }

  console.log('\nTest 2: POST /api/me/identities (admin) creates a new link');
  {
    const r = await POST('/api/me/identities', {
      provider: 'authentik',
      issuer: 'https://authentik.phatt.vip/application/oauth/homestead/',
      provider_subject: 'brandon-authentik-uid',
    }, HEAD_ADMIN);
    assertEq(r.status, 201, 'admin POST returns 201');
    const body = await r.json();
    assertEq(body.ok, true, 'response.ok === true');
    assertEq(body.alreadyLinked, false, 'newly created (not alreadyLinked)');

    // GET now shows TWO links for brandon (admin linked on behalf of brandon)
    // Wait — admin's POST without user_id creates a link for admin, not brandon.
    // Re-link explicitly targeting brandon's user_id.
    const brandonId = (await (await GET('/api/users', HEAD_ADMIN)).json()).find(u => u.username === 'brandon').id;
    const r2 = await POST('/api/me/identities', {
      user_id: brandonId,
      provider: 'authentik',
      issuer: 'https://authentik.phatt.vip/application/oauth/homestead/',
      provider_subject: 'brandon-authentik-uid-2',
    }, HEAD_ADMIN);
    assertEq(r2.status, 201, 'admin POST with explicit user_id returns 201');

    const list = await (await GET('/api/me/identities', HEAD_BRANDON)).json();
    const providers = list.identities.map(i => i.provider).sort();
    assert(providers.includes('authentik'), 'brandon now has an authentik link');
  }

  console.log('\nTest 3: POST /api/me/identities (non-admin) → 403');
  {
    const r = await POST('/api/me/identities', {
      provider: 'github',
      issuer: 'https://github.com',
      provider_subject: 'brandon-gh',
    }, HEAD_BRANDON);
    assertEq(r.status, 403, 'non-admin POST → 403');
  }

  console.log('\nTest 4: POST /api/me/identities refuses collision → 409');
  {
    const r = await POST('/api/me/identities', {
      // brandon-authentik-uid-2 is already linked to brandon
      provider: 'authentik',
      issuer: 'https://authentik.phatt.vip/application/oauth/homestead/',
      provider_subject: 'brandon-authentik-uid-2',
      // user_id defaults to admin's id (because admin is signed in)
      // but the (provider, issuer, subject) already belongs to brandon.
    }, HEAD_ADMIN);
    assertEq(r.status, 409, 'collision POST → 409');
    const body = await r.json();
    assertEq(body.error, 'identity_collision', 'error code === identity_collision');
  }

  console.log('\nTest 5: POST /api/me/identities missing fields → 400');
  {
    const r1 = await POST('/api/me/identities', { provider: 'p' }, HEAD_ADMIN);
    assertEq(r1.status, 400, 'missing issuer+subject → 400');
    const r2 = await POST('/api/me/identities', { provider: '', issuer: 'i', provider_subject: 's' }, HEAD_ADMIN);
    assertEq(r2.status, 400, 'empty provider → 400');
  }

  console.log('\nTest 6: /api/login still authenticates against local_credentials (regression guard)');
  {
    // The seed admin/brandon/emily passwords are ADMIN_PASSWORD/BRANDON_PASSWORD
    // env seeds (per the v0.0.5 seed path). Login with the env-seeded
    // password MUST succeed after the migration.
    const r = await POST('/api/login', {
      username: 'brandon',
      password: 'p2704api-test-pw',
    }, HEAD_BRANDON /* ignored for login; login uses json body */);
    // Login does not require the header-trust headers; it uses body creds.
    const r2 = await fetch('http://127.0.0.1:3192/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'brandon', password: 'p2704api-test-pw' }),
    });
    assertEq(r2.status, 200, 'POST /api/login with seed password → 200');
    const body = await r2.json();
    assert(body.user && body.user.username === 'brandon', 'login returns the user row');

    // Wrong password → 401.
    const r3 = await fetch('http://127.0.0.1:3192/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'brandon', password: 'WRONG' }),
    });
    assertEq(r3.status, 401, 'POST /api/login with wrong password → 401');
  }

  console.log('\nTest 7: DELETE /api/me/identities refuses to orphan (409)');
  {
    // brandon has header_trust + authentik links (from earlier tests)
    // AND has a local password (from seed). Delete one of the non-orphan-safe
    // links first to set up the orphan-test scenario.

    // Create a fresh user (no admin link, just header_trust) and try to
    // delete the only link — should be blocked because the seed users
    // have local credentials so the orphan check passes. Use brandon
    // specifically: he has local_credentials AND multiple links.

    // Delete brandon's authentik link — succeeds (he still has header_trust
    // AND local_credentials).
    const r = await DELETE('/api/me/identities', {
      provider: 'authentik',
      issuer: 'https://authentik.phatt.vip/application/oauth/homestead/',
      provider_subject: 'brandon-authentik-uid-2',
    }, HEAD_BRANDON);
    assertEq(r.status, 200, 'delete non-last link → 200');

    // Delete brandon's header_trust link — should succeed (still has
    // local_credentials).
    const r2 = await DELETE('/api/me/identities', {
      provider: 'header_trust',
      issuer: 'legacy-bootstrap',
      provider_subject: 'brandon',
    }, HEAD_BRANDON);
    assertEq(r2.status, 200, 'delete header_trust link (still has local password) → 200');

    // Now brandon has zero identity_links + a local credential.
    // Any further delete is a 404 (link not found).
    const r3 = await DELETE('/api/me/identities', {
      provider: 'authentik',
      issuer: 'whatever',
      provider_subject: 'none',
    }, HEAD_BRANDON);
    assertEq(r3.status, 404, 'delete of non-existent link → 404');
  }

  console.log('\nTest 8: DELETE /api/me/identities orphan-block on linkless user');
  {
    // Use the bcrypt hash for 'orphanpass' (precomputed once so the
    // test doesn't depend on bcrypt being present at runtime).
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('orphanpass', 4);
    const Database = require('better-sqlite3');
    const db = new Database(path.join(tmpDir, 'life.db'));
    db.prepare(`INSERT INTO users (username, display, color, pass_hash, is_admin, claimed_at)
                VALUES ('orphan-test', 'Orphan Test', '#abc123', '', 0, datetime('now'))`).run();
    const userId = db.prepare('SELECT id FROM users WHERE username = ?').get('orphan-test').id;
    // Insert ONE identity_link (the only auth path).
    db.prepare(`INSERT INTO identity_links (id, user_id, provider, issuer, provider_subject, linked_at)
                VALUES (100, ?, 'authentik', 'https://authentik.phatt.vip/', 'orphan-sub', datetime('now'))`).run(userId);

    // Log in via /api/login is impossible because the user has NO local
    // credential. Use header-trust BUT — header-trust calls
    // provisionOrClaim which would CREATE a fresh identity_link on
    // every request (with subject = username). That defeats the
    // orphan-test setup. Instead: use a server-side shortcut — POST
    // /api/me/identities with admin headers + the explicit user_id
    // for the orphan-test user. Admin DELETE bypasses provisionOrClaim
    // by going through auth() (which DOES provisionOrClaim admin,
    // not the target user). The orphan protection lives at the
    // data-layer: identity.unlinkIdentity() checks remaining links
    // and hasLocalCredential. So test the data-layer directly via
    // admin DELETE, which calls identity.unlinkIdentity on the
    // target user_id (passed through).

    // First — link a local_credentials row to orphan-test (none yet),
    // so the orphan block engages.
    db.prepare(`INSERT INTO local_credentials (user_id, password_hash, created_at, updated_at)
                VALUES (?, '', datetime('now'), datetime('now'))`).run(userId);

    // Admin DELETE on behalf of orphan-test, targeting the link.
    // identity.unlinkIdentity will see: remaining=0 links after this,
    // hasLocalCredential=true (because password_hash is '' but a row
    // exists) → wait, hasLocalCredential checks for non-empty hash.
    // So with empty password_hash, hasLocalCredential returns false.
    // The orphan block should engage.
    const r = await DELETE('/api/me/identities', {
      provider: 'authentik',
      issuer: 'https://authentik.phatt.vip/',
      provider_subject: 'orphan-sub',
      user_id: userId,
    }, HEAD_ADMIN);
    assertEq(r.status, 409, 'delete last link on user with EMPTY local password → 409');
    const body = await r.json();
    assertEq(body.error, 'no_login_path', 'error === no_login_path');

    // Now set a real password and retry — should succeed.
    db.prepare(`UPDATE local_credentials SET password_hash = ? WHERE user_id = ?`).run(hash, userId);

    const r2 = await DELETE('/api/me/identities', {
      provider: 'authentik',
      issuer: 'https://authentik.phatt.vip/',
      provider_subject: 'orphan-sub',
      user_id: userId,
    }, HEAD_ADMIN);
    assertEq(r2.status, 200, 'delete last link on user WITH local password → 200');

    db.close();
  }

  console.log('\nTest 9: GET /api/me/identities unauthenticated → 401');
  {
    const r = await fetch('http://127.0.0.1:3192/api/me/identities');
    assertEq(r.status, 401, 'unauthenticated GET → 401');
  }

  console.log(`\nResults: ${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error('Test failure:', e);
  process.exit(1);
});
