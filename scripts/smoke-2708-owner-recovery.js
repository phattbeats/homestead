#!/usr/bin/env node
// PHA-2708 end-to-end smoke for owner recovery.
//
// Boots server.js on an ephemeral port against a fresh SQLite DB,
// exercises the full owner-recovery surface end-to-end, and writes
// verify-out artifacts that PHA-2501 expects from any done-state
// change. Captures:
//
//   smoke-2708-db-shape.json          — post-migration local_credentials
//                                      and identity_links rows for admin.
//   smoke-2708-login-paths.json       — GET /api/admin/owner/login-paths
//                                      response + status.
//   smoke-2708-mint.json              — CLI mint stdout (no plaintext
//                                      token persisted; only length + first 8 chars).
//   smoke-2708-recover-success.json   — POST /api/admin/owner/recover
//                                      200 response (correct token).
//   smoke-2708-recover-replay.json    — POST /api/admin/owner/recover
//                                      401 response (replayed token).
//   smoke-2708-recover-badtoken.json  — POST /api/admin/owner/recover
//                                      401 response (wrong token).
//   smoke-2708-audit-events.json      — analytics_events rows tagged
//                                      subject_type='owner_recovery'.
//
// The smoke PROVES the contract: CLI mints → HTTP consumes → password
// rotated → owner can log in with the new password via /api/login
// with NO Authentik headers. Every step writes a verify-out artifact.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-smoke-2708-'));
const port = 3195;
const verifyOut = process.env.VERIFY_OUT
  ? path.resolve(process.env.VERIFY_OUT)
  : path.resolve(__dirname, '..', 'verify-out');
fs.mkdirSync(verifyOut, { recursive: true });

process.env.DATA_DIR = tmpDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'smoke-2708-admin-pw';
process.env.BRANDON_PASSWORD = 'smoke-2708-brandon-pw';
process.env.SESSION_SECRET = 'smoke-2708-secret';
process.env.NODE_ENV = 'production';

const HEAD_ADMIN = {
  'x-authentik-username': 'admin',
  'x-authentik-groups': JSON.stringify(['admins', 'household']),
};
const HEAD_NONE = {};

const GET = (urlPath, head = HEAD_ADMIN) => fetch(`http://127.0.0.1:${port}` + urlPath, { headers: head });
const POST = (urlPath, body, head = HEAD_ADMIN) => fetch(`http://127.0.0.1:${port}` + urlPath, {
  method: 'POST',
  headers: { ...head, 'content-type': 'application/json' },
  body: body ? JSON.stringify(body) : '{}',
});

(async () => {
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  let exitCode = 0;
  try {
    // Boot wait
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) break;
      } catch (_) { /* keep polling */ }
      await new Promise(r => setTimeout(r, 100));
    }

    // 1) Post-migration DB shape for the owner. We capture this
    //    AFTER triggering an admin header-trust login so the
    //    identity_links row created by `provisionOrClaim` is
    //    reflected. Use a HEAD_ADMIN probe to seed it.
    await GET('/api/me', HEAD_ADMIN);
    const db = new Database(path.join(tmpDir, 'life.db'));
    const ownerLocal = db.prepare(`
      SELECT user_id, password_hash IS NOT NULL AS has_password,
             recovery_token_hash AS rt_hash_present,
             recovery_token_expires_at AS rt_expires_at,
             created_at, updated_at
        FROM local_credentials WHERE user_id = (SELECT id FROM users WHERE is_admin = 1 LIMIT 1)
    `).get();
    const ownerLinks = db.prepare(`
      SELECT provider, issuer, provider_subject, linked_at
        FROM identity_links
       WHERE user_id = (SELECT id FROM users WHERE is_admin = 1 LIMIT 1)
    `).all();
    fs.writeFileSync(path.join(verifyOut, 'smoke-2708-db-shape.json'), JSON.stringify({
      owner_local_credential: ownerLocal ? {
        has_password: !!ownerLocal.has_password,
        recovery_token_hash_present: !!ownerLocal.rt_hash_present,
        recovery_token_expires_at: ownerLocal.rt_expires_at,
      } : null,
      owner_identity_links_count: ownerLinks.length,
      owner_identity_link_providers: ownerLinks.map(l => l.provider),
    }, null, 2));
    console.log(`[smoke-2708] wrote smoke-2708-db-shape.json (admin has ${ownerLinks.length} identity link(s))`);

    // 2) GET /api/admin/owner/login-paths (admin header-trust).
    const lp1 = await GET('/api/admin/owner/login-paths', HEAD_ADMIN);
    const lp1body = await lp1.json();
    fs.writeFileSync(path.join(verifyOut, 'smoke-2708-login-paths.json'), JSON.stringify({
      status: lp1.status,
      body: lp1body,
    }, null, 2));
    console.log(`[smoke-2708] GET /api/admin/owner/login-paths → ${lp1.status}`);
    if (lp1.status !== 200) throw new Error('login-paths returned non-200');
    if (!lp1body.login_paths.local_credential) throw new Error('login-paths: local_credential must be true');
    if (lp1body.login_paths.identity_links < 1) throw new Error('login-paths: identity_links must be >= 1');

    // 3) Mint a recovery token via the CLI. We capture the JSON
    //    but persist a redacted copy (length + first 8 chars only)
    //    so the verify-out artifact never carries the plaintext.
    const cliRaw = execFileSync('node', [
      path.resolve(__dirname, 'reset-owner-password.js'),
    ], {
      env: { ...process.env, DATA_DIR: tmpDir },
      encoding: 'utf8',
    });
    const cliJson = JSON.parse(cliRaw);
    fs.writeFileSync(path.join(verifyOut, 'smoke-2708-mint.json'), JSON.stringify({
      action: cliJson.action,
      userId: cliJson.userId,
      username: cliJson.username,
      display: cliJson.display,
      expires_at: cliJson.expires_at,
      ttl_min: cliJson.ttl_min,
      actor: cliJson.actor,
      // Redacted token — capture only first 8 chars + length so the
      // verify-out artifact proves the shape without leaking the
      // plaintext.
      token_redacted: { first8: cliJson.token.slice(0, 8), length: cliJson.token.length },
      has_warning: !!cliJson.warning,
      has_curl_example: !!cliJson.curl_example,
    }, null, 2));
    console.log(`[smoke-2708] wrote smoke-2708-mint.json (owner=${cliJson.username}, actor=${cliJson.actor})`);

    // 4) POST /api/admin/owner/recover with the FRESH token, and NO
    //    Authentik headers / session at all — this is the true
    //    break-glass scenario the whole feature exists for (owner
    //    forgot the password AND Authentik is unreachable, so there
    //    is nothing else to authenticate with). The token alone must
    //    be sufficient → 200, password rotated.
    const recoverResp = await POST('/api/admin/owner/recover', {
      token: cliJson.token,
      new_password: 'rotated-via-recovery-pw-12345',
    }, HEAD_NONE);
    const recoverBody = await recoverResp.json();
    fs.writeFileSync(path.join(verifyOut, 'smoke-2708-recover-success.json'), JSON.stringify({
      status: recoverResp.status,
      body: recoverBody,
    }, null, 2));
    console.log(`[smoke-2708] POST /api/admin/owner/recover (fresh token) → ${recoverResp.status}`);
    if (recoverResp.status !== 200) throw new Error('recover: fresh token must return 200');

    // 5) Owner can now log in with the new password, NO Authentik
    //    headers. This is the outage-survival proof: SWAG / Authentik
    //    are down, the owner is still able to authenticate.
    const relogin = await POST('/api/login', {
      username: 'admin',
      password: 'rotated-via-recovery-pw-12345',
    }, HEAD_NONE);
    const reloginBody = await relogin.json();
    console.log(`[smoke-2708] POST /api/login (new pw, no headers) → ${relogin.status}`);
    if (relogin.status !== 200) throw new Error('relogin: owner must be able to log in with new password');
    if (!reloginBody.user || reloginBody.user.username !== 'admin') throw new Error('relogin: response.user.username must be admin');

    // 6) Replay of the consumed token, still no auth → 401.
    const replay = await POST('/api/admin/owner/recover', {
      token: cliJson.token,
      new_password: 'replay-attempt-pw-9999',
    }, HEAD_NONE);
    const replayBody = await replay.json();
    fs.writeFileSync(path.join(verifyOut, 'smoke-2708-recover-replay.json'), JSON.stringify({
      status: replay.status,
      body: replayBody,
    }, null, 2));
    console.log(`[smoke-2708] POST /api/admin/owner/recover (replay) → ${replay.status}`);
    if (replay.status !== 401) throw new Error('replay must return 401');

    // 7) Wrong token, no auth → 401.
    const wrong = await POST('/api/admin/owner/recover', {
      token: 'a'.repeat(64),
      new_password: 'wrong-token-pw-1234',
    }, HEAD_NONE);
    const wrongBody = await wrong.json();
    fs.writeFileSync(path.join(verifyOut, 'smoke-2708-recover-badtoken.json'), JSON.stringify({
      status: wrong.status,
      body: wrongBody,
    }, null, 2));
    console.log(`[smoke-2708] POST /api/admin/owner/recover (wrong token) → ${wrong.status}`);
    if (wrong.status !== 401) throw new Error('wrong token must return 401');

    // 8) Mint a fresh CLI token, then --revoke it before consume.
    //    Confirms revoke works and clears the active row.
    const cli2Raw = execFileSync('node', [
      path.resolve(__dirname, 'reset-owner-password.js'),
    ], {
      env: { ...process.env, DATA_DIR: tmpDir },
      encoding: 'utf8',
    });
    const cli2Json = JSON.parse(cli2Raw);
    if (cli2Json.action !== 'mint') throw new Error('second mint must succeed (prior token was consumed)');
    if (!cli2Json.token) throw new Error('second mint must produce a new plaintext token');

    const revokeOut = execFileSync('node', [
      path.resolve(__dirname, 'reset-owner-password.js'),
      '--revoke',
    ], {
      env: { ...process.env, DATA_DIR: tmpDir },
      encoding: 'utf8',
    });
    const revokeJson = JSON.parse(revokeOut);
    if (revokeJson.action !== 'revoke' || !revokeJson.cleared) throw new Error('--revoke must clear the active token');
    console.log(`[smoke-2708] CLI --revoke cleared ${revokeJson.cleared}`);

    // 9) Audit trail capture.
    const auditRows = db.prepare(`
      SELECT kind, subject_id, meta, ts
        FROM analytics_events WHERE subject_type = 'owner_recovery' ORDER BY id ASC
    `).all().map(r => {
      // Keep the row but parse + filter meta so plaintext / hashes
      // never leak into the verify-out artifact.
      const meta = JSON.parse(r.meta || '{}');
      return {
        kind: r.kind,
        subject_id: r.subject_id,
        has_route: !!meta.route,
        has_source: !!meta.source,
        ttl_min: meta.ttl_min || null,
        created_at: r.created_at,
      };
    });
    fs.writeFileSync(path.join(verifyOut, 'smoke-2708-audit-events.json'), JSON.stringify({
      rows: auditRows,
      kinds: [...new Set(auditRows.map(r => r.kind))],
    }, null, 2));
    console.log(`[smoke-2708] wrote smoke-2708-audit-events.json (${auditRows.length} audit rows)`);

    // 10) Confirm the database does NOT contain a plaintext token
    //     and the operational recovery state — a hygiene guard that
    //     protects the verify-out artifact policy from accidental
    //     drift in future refactors.
    const db2 = new Database(path.join(tmpDir, 'life.db'), { readonly: true });
    const storedRows = db2.prepare(`SELECT recovery_token_hash, recovery_token_expires_at FROM local_credentials WHERE user_id = (SELECT id FROM users WHERE is_admin = 1 LIMIT 1)`).get();
    if (storedRows.recovery_token_hash !== null) throw new Error('recovery_token_hash must be NULL after consume + revoke');
    if (storedRows.recovery_token_expires_at !== null) throw new Error('recovery_token_expires_at must be NULL after consume + revoke');
    db2.close();

    console.log('[smoke-2708] ALL ASSERTIONS PASSED');
  } catch (err) {
    console.error('[smoke-2708] FATAL:', err.stack || err.message);
    exitCode = 1;
  } finally {
    server.close(() => process.exit(exitCode));
  }
})();
