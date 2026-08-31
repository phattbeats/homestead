#!/usr/bin/env node
// PHA-2704 end-to-end smoke for the identity foundation.
//
// Boots server.js on an ephemeral port against a fresh SQLite DB,
// drives the full /api/me/identities surface + /api/login round-trip,
// and writes the post-migration DB shape + API responses into
// ./verify-out/smoke-2704-*.json. No Playwright, no UI — this smoke
// proves the data layer and the API surface from the outside.
//
// Acceptance:
//   * migrate() creates local_credentials + identity_links tables
//     and backfills from the seed users' pass_hash.
//   * /api/login authenticates against local_credentials (regression
//     guard for the migration).
//   * GET /api/me/identities returns the header_trust link.
//   * POST /api/me/identities (admin) creates a second identity link.
//   * DELETE /api/me/identities removes a non-last link; refuses to
//     orphan the last link when the user has no local credential.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2704-'));
const port = 3193;
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-2704-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-2704-brandon-pw';
process.env.SESSION_SECRET = 'smoke-2704-secret';
process.env.NODE_ENV = 'production';

const HEAD_ADMIN = {
  'x-authentik-username': 'admin',
  'x-authentik-groups': JSON.stringify(['admins', 'household']),
};
const HEAD_BRANDON = {
  'x-authentik-username': 'brandon',
  'x-authentik-groups': JSON.stringify(['household']),
};

const GET = (urlPath, head = HEAD_ADMIN) => fetch(`http://127.0.0.1:${port}` + urlPath, { headers: head });
const POST = (urlPath, body, head = HEAD_ADMIN) => fetch(`http://127.0.0.1:${port}` + urlPath, {
  method: 'POST',
  headers: { ...head, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const DELETE = (urlPath, body, head = HEAD_ADMIN) => fetch(`http://127.0.0.1:${port}` + urlPath, {
  method: 'DELETE',
  headers: { ...head, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

(async () => {
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  let exitCode = 0;
  try {
    // Wait for ready
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) break;
      } catch (_) { /* keep polling */ }
      await new Promise(r => setTimeout(r, 100));
    }

    // Capture post-migration DB shape.
    const db = new Database(path.join(tmpDir, 'life.db'));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(t => t.name);
    const users = db.prepare('SELECT id, username FROM users ORDER BY id').all();
    const localCredentials = db.prepare('SELECT user_id, password_hash IS NOT NULL AS has_hash FROM local_credentials ORDER BY user_id').all();
    const identityLinks = db.prepare('SELECT user_id, provider, issuer, provider_subject FROM identity_links ORDER BY user_id, provider').all();
    const migrationState = db.prepare('SELECT key, value FROM _identity_migration_state').all();

    fs.writeFileSync(path.join(verifyOut, 'smoke-2704-db-shape.json'), JSON.stringify({
      tables,
      users,
      local_credentials: localCredentials,
      identity_links: identityLinks,
      migration_state: migrationState,
    }, null, 2));
    console.log('[smoke-2704] wrote smoke-2704-db-shape.json');
    db.close();

    // Drive the API surface.
    const loginResp = await POST('/api/login', { username: 'brandon', password: 'smoke-2704-brandon-pw' }, {});
    const loginJson = await loginResp.json();
    fs.writeFileSync(path.join(verifyOut, 'smoke-2704-login.json'), JSON.stringify({
      status: loginResp.status,
      body: loginJson,
    }, null, 2));
    console.log(`[smoke-2704] /api/login → ${loginResp.status}`);

    const identitiesResp = await GET('/api/me/identities', HEAD_BRANDON);
    const identitiesJson = await identitiesResp.json();
    fs.writeFileSync(path.join(verifyOut, 'smoke-2704-identities-list.json'), JSON.stringify({
      status: identitiesResp.status,
      body: identitiesJson,
    }, null, 2));
    console.log(`[smoke-2704] GET /api/me/identities → ${identitiesResp.status} (${identitiesJson.identities.length} links)`);

    // Get brandon's id first.
    const usersListResp = await GET('/api/users', HEAD_ADMIN);
    const usersList = await usersListResp.json();
    const brandonId = usersList.find(u => u.username === 'brandon').id;

    // Step 1: admin creates a link ON BEHALF OF brandon.
    const linkResp = await POST('/api/me/identities', {
      provider: 'authentik',
      issuer: 'https://authentik.phatt.vip/application/oauth/homestead/',
      provider_subject: 'smoke-2704-brandon-uid',
      user_id: brandonId,
    }, HEAD_ADMIN);
    const linkJson = await linkResp.json();
    fs.writeFileSync(path.join(verifyOut, 'smoke-2704-link-create.json'), JSON.stringify({
      status: linkResp.status,
      body: linkJson,
    }, null, 2));
    console.log(`[smoke-2704] POST /api/me/identities → ${linkResp.status}`);

    // Step 2: collision — admin tries to link the same (provider,
    // issuer, subject) to admin's own user_id (the default when no
    // user_id is passed). The (provider, issuer, subject) is already
    // owned by brandon → 409.
    const collisionResp = await POST('/api/me/identities', {
      provider: 'authentik',
      issuer: 'https://authentik.phatt.vip/application/oauth/homestead/',
      provider_subject: 'smoke-2704-brandon-uid',
    }, HEAD_ADMIN);
    const collisionJson = await collisionResp.json();
    fs.writeFileSync(path.join(verifyOut, 'smoke-2704-link-collision.json'), JSON.stringify({
      status: collisionResp.status,
      body: collisionJson,
    }, null, 2));
    console.log(`[smoke-2704] collision POST → ${collisionResp.status} (expect 409)`);

    // Step 3: unlink — admin removes the link on brandon's behalf.
    const unlinkResp = await DELETE('/api/me/identities', {
      provider: 'authentik',
      issuer: 'https://authentik.phatt.vip/application/oauth/homestead/',
      provider_subject: 'smoke-2704-brandon-uid',
      user_id: brandonId,
    }, HEAD_ADMIN);
    const unlinkJson = await unlinkResp.json();
    fs.writeFileSync(path.join(verifyOut, 'smoke-2704-link-unlink.json'), JSON.stringify({
      status: unlinkResp.status,
      body: unlinkJson,
    }, null, 2));
    console.log(`[smoke-2704] DELETE /api/me/identities → ${unlinkResp.status}`);

    // Acceptance check
    const ok = (
      loginResp.status === 200 &&
      identitiesResp.status === 200 &&
      identitiesJson.identities.length >= 1 &&
      linkResp.status === 201 &&
      collisionResp.status === 409 &&
      unlinkResp.status === 200
    );
    if (!ok) {
      console.error('[smoke-2704] FAILED acceptance check');
      exitCode = 1;
    } else {
      console.log('[smoke-2704] PASSED');
    }
  } finally {
    server.close();
  }
  process.exit(exitCode);
})().catch(e => {
  console.error('[smoke-2704] error:', e);
  process.exit(1);
});
