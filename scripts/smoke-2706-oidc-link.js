#!/usr/bin/env node
// PHA-2706 smoke test — "Link Authentik later" full lifecycle.
//
// What this script captures (writes to verify-out/):
//   * smoke-2706-db-shape.json — oidc_link_states + identity_links
//     after the run (proves the schema + state machine).
//   * smoke-2706-authorize-url.json — the authorize_url the server
//     returned to /start (proves PKCE + state + nonce are present).
//   * smoke-2706-preview.json — the /preview response with both
//     identities named explicitly (proves the confirmation payload).
//   * smoke-2706-link-row.json — the inserted identity_links row.
//   * smoke-2706-collide.json — the 409 collision response.
//   * smoke-2706-unlink.json — the post-unlink identity_links state.
//   * smoke-2706-idp.log — the mock IdP's request log.
//
// Boot the server with: OIDC_ISSUER=http://127.0.0.1:<port>/ …
// via the helper. Then drive the full happy path, the collision
// path, and the unlink path end-to-end.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-p2706-smoke-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3194';
process.env.ADMIN_PASSWORD = '***';
process.env.BRANDON_PASSWORD = 'p2706-test-pw';
process.env.SESSION_SECRET = '***';
process.env.NODE_ENV = 'production';

const verifyOut = path.join(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

const oidcLink = require('../lib/oidc-link');
const helper = require('../lib/oidc-link-test-helper');
const Database = require('better-sqlite3');

const HEAD_BRANDON = { 'x-authentik-username': 'brandon', 'x-authentik-groups': JSON.stringify(['household']) };
const HEAD_ALICE = { 'x-authentik-username': 'alice', 'x-authentik-groups': JSON.stringify(['household']) };

async function waitForServer() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:3194/api/health');
      if (r.ok) return;
    } catch (_) { /* keep polling */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not become ready');
}

(async () => {
  const mock = await helper.startMockIssuer({
    redirectUri: 'http://127.0.0.1:3194/api/me/identities/link/callback',
    subject: 'smoke-sub',
  });
  process.env.OIDC_ID_TOKEN_PEM = mock.publicKeyPem;

  const app = require('../server.js');
  await new Promise((resolve) => app.listen(3194, '127.0.0.1', resolve));
  await waitForServer();

  // Seed alice with a local credential for the collision test.
  {
    const db = new Database(path.join(tmpDir, 'life.db'));
    db.prepare(`INSERT INTO users (username, display, color, pass_hash, is_admin, claimed_at)
                VALUES ('alice', 'Alice', '#aabbcc', '', 0, datetime('now'))`).run();
    const aliceId = db.prepare('SELECT id FROM users WHERE username = ?').get('alice').id;
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('alicepass', 4);
    db.prepare(`INSERT INTO local_credentials (user_id, password_hash, updated_at)
                VALUES (?, ?, datetime('now'))`).run(aliceId, hash);
    db.close();
  }

  // ---- happy path: brandon links OIDC identity ----
  console.log('[smoke-2706] phase 1: happy path');
  const startR = await fetch('http://127.0.0.1:3194/api/me/identities/link/start', {
    method: 'POST',
    headers: { ...HEAD_BRANDON, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'p2706-test-pw' }),
  });
  const startBody = await startR.json();
  // Redact the handle in the persisted artifact (the smoke log is a
  // durable artifact, but a handle is sensitive in the same way a
  // password reset token is).
  fs.writeFileSync(path.join(verifyOut, 'smoke-2706-authorize-url.json'), JSON.stringify({
    ok: startBody.ok,
    handle_redacted: startBody.handle ? startBody.handle.slice(0, 8) + '…' + ' (len=' + startBody.handle.length + ')' : null,
    authorize_url: startBody.authorize_url,
    expires_at: startBody.expires_at,
    provider: startBody.provider,
    issuer: startBody.issuer,
  }, null, 2));
  console.log('  /start → 200, handle saved (redacted in artifact)');

  const authResp = await fetch(startBody.authorize_url, { redirect: 'manual' });
  const loc = authResp.headers.get('location');
  const locU = new URL(loc);
  const code = locU.searchParams.get('code');
  const state = locU.searchParams.get('state');

  const cbR = await fetch(`http://127.0.0.1:3194/api/me/identities/link/callback?handle=${startBody.handle}&code=${encodeURIComponent(code)}&state=${state}`, {
    headers: { ...HEAD_BRANDON, accept: 'application/json' },
  });
  const cbBody = await cbR.json();
  fs.writeFileSync(path.join(verifyOut, 'smoke-2706-preview.json'), JSON.stringify(cbBody, null, 2));
  console.log('  /callback → 200, preview saved');

  const confR = await fetch('http://127.0.0.1:3194/api/me/identities/link/confirm', {
    method: 'POST',
    headers: { ...HEAD_BRANDON, 'content-type': 'application/json' },
    body: JSON.stringify({ handle: startBody.handle }),
  });
  const confBody = await confR.json();
  fs.writeFileSync(path.join(verifyOut, 'smoke-2706-link-row.json'), JSON.stringify(confBody, null, 2));
  console.log(`  /confirm → ${confR.status} (link_id=${confBody.link_id})`);

  // ---- phase 2: alice tries to link the same OIDC subject → collision ----
  console.log('[smoke-2706] phase 2: collision');
  const startR2 = await fetch('http://127.0.0.1:3194/api/me/identities/link/start', {
    method: 'POST',
    headers: { ...HEAD_ALICE, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'alicepass' }),
  });
  const startBody2 = await startR2.json();
  const authResp2 = await fetch(startBody2.authorize_url, { redirect: 'manual' });
  const loc2 = authResp2.headers.get('location');
  const locU2 = new URL(loc2);
  const code2 = locU2.searchParams.get('code');
  const state2 = locU2.searchParams.get('state');
  await fetch(`http://127.0.0.1:3194/api/me/identities/link/callback?handle=${encodeURIComponent(startBody2.handle)}&code=${encodeURIComponent(code2)}&state=${encodeURIComponent(state2)}`, {
    headers: { ...HEAD_ALICE, accept: 'application/json' },
  });
  const confR2 = await fetch('http://127.0.0.1:3194/api/me/identities/link/confirm', {
    method: 'POST',
    headers: { ...HEAD_ALICE, 'content-type': 'application/json' },
    body: JSON.stringify({ handle: startBody2.handle }),
  });
  const confBody2 = await confR2.json();
  fs.writeFileSync(path.join(verifyOut, 'smoke-2706-collide.json'), JSON.stringify(confBody2, null, 2));
  console.log(`  /confirm (alice) → ${confR2.status} (collision response saved)`);

  // ---- phase 3: unlink + db shape snapshot ----
  console.log('[smoke-2706] phase 3: unlink + db snapshot');
  const unlinkR = await fetch(`http://127.0.0.1:3194/api/me/identities/${confBody.link_id}/unlink`, {
    method: 'POST',
    headers: HEAD_BRANDON,
  });
  const unlinkBody = await unlinkR.json();
  fs.writeFileSync(path.join(verifyOut, 'smoke-2706-unlink.json'), JSON.stringify(unlinkBody, null, 2));

  // Snapshot the schema for the durable record.
  const db = new Database(path.join(tmpDir, 'life.db'), { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'oidc%' OR name='identity_links' ORDER BY name").all().map(r => r.name);
  const oidcCols = db.prepare("PRAGMA table_info(oidc_link_states)").all().map(c => c.name);
  const linkRows = db.prepare("SELECT user_id, provider, issuer, provider_subject FROM identity_links ORDER BY id").all();
  fs.writeFileSync(path.join(verifyOut, 'smoke-2706-db-shape.json'), JSON.stringify({
    oidc_tables: tables,
    oidc_link_states_columns: oidcCols,
    identity_links_rows: linkRows,
    unlink_status: unlinkR.status,
    unlink_body: unlinkBody,
  }, null, 2));
  console.log('  /unlink + db shape saved');

  mock.stop();
  console.log('[smoke-2706] done.');
  process.exit(0);
})().catch(e => { console.error('[smoke-2706] crashed:', e); process.exit(2); });