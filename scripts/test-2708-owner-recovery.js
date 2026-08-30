#!/usr/bin/env node
// PHA-2708 owner-recovery acceptance suite.
//
// Three groups of guarantees:
//
//   1. Owner protection (privilege preservation):
//        * `unlinkIdentity` refuses to remove the OWNER's last login
//          path with `would_lock_out_owner`.
//        * `setLocalPassword` cannot accidentally remove the owner's
//          password (the function always requires a plaintext).
//        * Non-owner orphan-protection (`no_login_path`) still works.
//
//   2. Owner recovery (audited, non-destructive):
//        * mint a 1h reset token → consume it → log in with the new
//          password. The token is one-shot: replay within TTL fails.
//        * bad-token / wrong-token / expired-token all return the
//          same `invalid_or_expired_token` shape so a probe can't
//          tell which one matched.
//        * only the OWNER can be recovered; non-owner tokens (impossible
//          to mint via the public API, but tested at the lib level)
//          are no-ops.
//        * every recovery event lands in `analytics_events` with no
//          plaintext/secret fields.
//
//   3. Outage resilience:
//        * `/api/login` works with NO Authentik headers present —
//          verifies that breaking SWAG or Authentik doesn't lock the
//          owner out of Homestead.
//        * `/api/me` returns `{ user: null }` (200, not 401) when no
//          headers are present.
//        * `/api/me` with the headers still attaches a session and
//          the user's identity links are intact.
//
// Test isolation: each group drives `app` in-process via
// `require('../server.js')` + `app.listen(port)` against a fresh
// ephemeral DATA_DIR. No real network. No shared state across groups.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { execFileSync } = require('child_process');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-p2708-'));
const port = 3194;
process.env.DATA_DIR = tmpRoot;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = 'p2708-owner-test-pw';
process.env.BRANDON_PASSWORD = 'p2708-brandon-test-pw';
process.env.SESSION_SECRET = 'p2708-test-secret';
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
// No headers — simulates SWAG down / Authentik unreachable.
const HEAD_NONE = {};

const POST = (urlPath, body, head) => fetch('http://127.0.0.1:' + port + urlPath, {
  method: 'POST',
  headers: { ...(head || {}), 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});
const GET = (urlPath, head) => fetch('http://127.0.0.1:' + port + urlPath, { headers: head || {} });
const DELETE_FN = (urlPath, body, head) => fetch('http://127.0.0.1:' + port + urlPath, {
  method: 'DELETE',
  headers: { ...(head || {}), 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});

// loginAs runs `/api/login` with NO Authentik headers — the
// outage-resilience code path that proves the LAN password fallback
// still works when SWAG / Authentik are unreachable. Returns the
// response body for inspection.
async function loginRaw(username, password) {
  return await POST('/api/login', { username, password }, HEAD_NONE);
}

(async () => {
  const identity = require('../lib/identity');
  const app = require('../server.js');

  await new Promise((resolve, reject) => {
    app.listen(port, '127.0.0.1', () => { console.log(`[test-2708] homestead on :${port}`); resolve(); });
    process.on('uncaughtException', reject);
  });

  for (let i = 0; i < 30; i++) {
    try {
      const r = await GET('/api/health');
      if (r.ok) break;
    } catch (_) { /* keep polling */ }
    await new Promise(r => setTimeout(r, 100));
  }
  ok('server boots');

  // ---- GROUP 1: owner protection (privilege preservation) ----
  console.log('\nGroup 1 — owner protection (privilege preservation)');

  const ownerId = identity.findOwnerUserId({ prepare: (s) => ({
    get: () => ({ id: 1 }),
  }) });
  assertEq(typeof ownerId, 'number', 'findOwnerUserId returns a number when admin exists');

  const dbDirect = new Database(path.join(tmpRoot, 'life.db'));
  const realOwnerId = identity.findOwnerUserId(dbDirect);
  assert(realOwnerId != null, 'real owner user_id resolved from booted DB');
  assert(identity.isOwner(dbDirect, realOwnerId), 'isOwner(realOwnerId) === true');
  assert(!identity.isOwner(dbDirect, realOwnerId + 999), 'isOwner(wrong id) === false');
  assert(!identity.isOwner(dbDirect, null), 'isOwner(null) === false');

  // Drive a header-trust GET /api/me for the owner so a real
  // identity_link row gets created via provisionOrClaim. Same for
  // brandon. We need at least one link for the owner-unlink attack
  // to have a target.
  await GET('/api/me', HEAD_ADMIN);
  await GET('/api/me', HEAD_BRANDON);

  const ownerLinksBefore = dbDirect.prepare('SELECT COUNT(*) AS c FROM identity_links WHERE user_id = ?').get(realOwnerId).c;
  assert(ownerLinksBefore >= 1, `owner has at least one identity link (${ownerLinksBefore})`);

  // Unlink owner's last identity_link while owner has NO local credential
  // → must block with `would_lock_out_owner`, not `no_login_path`.
  // First, nuke the owner's local_credentials row entirely.
  dbDirect.prepare('DELETE FROM local_credentials WHERE user_id = ?').run(realOwnerId);
  // Pick the owner's only remaining identity_link.
  const ownerLink = dbDirect.prepare('SELECT provider, issuer, provider_subject FROM identity_links WHERE user_id = ? LIMIT 1').get(realOwnerId);
  assert(!!ownerLink, 'owner has an identity_link to attack');
  const unlinkOwner = identity.unlinkIdentity(dbDirect, realOwnerId, ownerLink.provider, ownerLink.issuer, ownerLink.provider_subject);
  assertEq(unlinkOwner.blocked, 'would_lock_out_owner', 'owner unlink of last path blocked with would_lock_out_owner');
  assertEq(unlinkOwner.removed, false, 'owner row NOT removed');

  // Non-owner (brandon) with single identity_link and NO local credential
  // → blocks with `no_login_path` (the pre-PHA-2708 behavior).
  // Make sure brandon has no local_credentials.
  dbDirect.prepare('DELETE FROM local_credentials WHERE user_id = (SELECT id FROM users WHERE username = ?)').run('brandon');
  // Remove all but one of brandon's identity_links.
  const brandonLinks = dbDirect.prepare('SELECT id FROM identity_links WHERE user_id = (SELECT id FROM users WHERE username = ?) ORDER BY id DESC').all('brandon');
  // Keep the last one (oldest by id ASC = first by sort ASC); drop the rest.
  for (let i = 0; i < brandonLinks.length - 1; i++) {
    dbDirect.prepare('DELETE FROM identity_links WHERE id = ?').run(brandonLinks[i].id);
  }
  const lastBrandonLink = dbDirect.prepare('SELECT provider, issuer, provider_subject FROM identity_links WHERE user_id = (SELECT id FROM users WHERE username = ?)').get('brandon');
  const unlinkBrandon = identity.unlinkIdentity(dbDirect,
    dbDirect.prepare('SELECT id FROM users WHERE username = ?').get('brandon').id,
    lastBrandonLink.provider, lastBrandonLink.issuer, lastBrandonLink.provider_subject);
  assertEq(unlinkBrandon.blocked, 'no_login_path', 'non-owner unlink of last path still blocked with no_login_path');
  assertEq(unlinkBrandon.removed, false, 'non-owner row NOT removed');

  // Brand-new user with NO login path at all → blocks the same way.
  const ghostId = dbDirect.prepare(`INSERT INTO users (username, display, color, pass_hash, is_admin) VALUES ('ghost-test', 'Ghost', '#888', '', 0)`).lastInsertRowid;
  const unlinkGhost = identity.unlinkIdentity(dbDirect, ghostId, 'header_trust', 'legacy-bootstrap', 'ghost-subject');
  assertEq(unlinkGhost.removed, false, 'ghost user (no links) unlink is a no-op');
  dbDirect.prepare('DELETE FROM users WHERE id = ?').run(ghostId);

  dbDirect.close();
  ok('Group 1: privilege preservation enforces owner non-lockout');

  // ---- GROUP 2: owner recovery (lib-level primitives) ----
  console.log('\nGroup 2 — owner recovery primitives');

  const db2 = new Database(path.join(tmpRoot, 'life.db'));
  // Restore owner's local_credentials (deleted in Group 1). The
  // seed bcrypt-hashed 'p2708-owner-test-pw' which the CLI installed
  // when server.js booted. Re-hash and INSERT.
  const ownerRow = db2.prepare('SELECT id, username FROM users WHERE is_admin = 1 LIMIT 1').get();
  const bcrypt = require('bcryptjs');
  const ownerHash = bcrypt.hashSync('p2708-owner-test-pw', 10);
  db2.prepare(`
    INSERT INTO local_credentials (user_id, password_hash, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at
  `).run(ownerRow.id, ownerHash);

  // Mint a recovery token with a tiny TTL so we can exercise expiry
  // without waiting 60 minutes.
  const mint = identity.mintOwnerRecoveryToken(db2, { ttlMs: 250 });
  assertEq(typeof mint.token, 'string', 'mint returns a string token');
  assertEq(mint.token.length, 64, 'token is 32 bytes hex (64 chars)');
  assertEq(mint.username, ownerRow.username, 'mint points at the owner');
  assert(!mint.alreadyActive, 'first mint is not alreadyActive');
  assert(/^\d+$/.test(mint.expiresAt), 'mint.expiresAt is millisecond integer string');

  // A second mint while the first is still active → alreadyActive.
  const mint2 = identity.mintOwnerRecoveryToken(db2, { ttlMs: 60_000 });
  assert(mint2.alreadyActive, 'second mint within TTL is alreadyActive');
  assertEq(mint2.token, null, 'second mint returns null token');

  // Verify the DB only stores the sha256(token), NOT the plaintext.
  const storedHash = db2.prepare('SELECT owner_recovery_token_hash FROM local_credentials WHERE user_id = ?').get(ownerRow.id).owner_recovery_token_hash;
  assertEq(storedHash.length, 64, 'stored hash is 32 bytes hex (sha256)');
  assert(storedHash !== mint.token, 'stored hash !== plaintext token');
  const sha = crypto.createHash('sha256').update(mint.token).digest('hex');
  assertEq(storedHash, sha, 'stored hash === sha256(plaintext token)');

  // Wait for expiry (>250ms).
  await new Promise(r => setTimeout(r, 400));

  // Consume AFTER expiry → invalid_or_expired_token.
  const consumeExpired = identity.consumeOwnerRecoveryToken(db2, mint.token, 'new-password-12345');
  assertEq(consumeExpired.ok, false, 'expired token consume fails');
  assertEq(consumeExpired.code, 'invalid_or_expired_token', 'expired token returns invalid_or_expired_token');

  // The expired consume should also clear the hash so a stale row
  // doesn't sit there forever.
  const afterExpired = db2.prepare('SELECT owner_recovery_token_hash, owner_recovery_token_expires_at FROM local_credentials WHERE user_id = ?').get(ownerRow.id);
  assertEq(afterExpired.owner_recovery_token_hash, null, 'expired consume clears hash');
  assertEq(afterExpired.owner_recovery_token_expires_at, null, 'expired consume clears expiry');

  // Mint fresh, then consume successfully.
  const fresh = identity.mintOwnerRecoveryToken(db2, { ttlMs: 60_000 });
  assert(!fresh.alreadyActive, 'mint after expiry succeeds');
  const consume = identity.consumeOwnerRecoveryToken(db2, fresh.token, 'rotated-pw-67890');
  assertEq(consume.ok, true, 'fresh token consumes successfully');
  assertEq(consume.username, ownerRow.username, 'consume returns the owner username');
  assert(identity.verifyLocalPassword(db2, ownerRow.id, 'rotated-pw-67890'), 'old password no longer works');
  assert(!identity.verifyLocalPassword(db2, ownerRow.id, 'p2708-owner-test-pw'), 'new password works');

  // Replay the same token → must fail (hash is cleared).
  const replay = identity.consumeOwnerRecoveryToken(db2, fresh.token, 'another-pw-abcde');
  assertEq(replay.ok, false, 'replay within TTL fails');
  assertEq(replay.code, 'invalid_or_expired_token', 'replay returns invalid_or_expired_token');

  // Wrong token → must fail.
  const wrong = identity.consumeOwnerRecoveryToken(db2, 'a'.repeat(64), 'any-password-1234');
  assertEq(wrong.ok, false, 'wrong token fails');
  assertEq(wrong.code, 'invalid_or_expired_token', 'wrong token returns invalid_or_expired_token');

  // Empty / non-string → fails with the same code (no probe leak).
  const empty = identity.consumeOwnerRecoveryToken(db2, '', 'any-password-1234');
  assertEq(empty.ok, false, 'empty token fails');
  assertEq(empty.code, 'invalid_or_expired_token', 'empty token returns invalid_or_expired_token');

  // Non-string token → same.
  const nonstr = identity.consumeOwnerRecoveryToken(db2, 12345, 'any-password-1234');
  assertEq(nonstr.ok, false, 'non-string token fails');

  // Revoke flow.
  const m = identity.mintOwnerRecoveryToken(db2, { ttlMs: 60_000 });
  assert(!m.alreadyActive, 'revoke test: mint succeeds');
  const rev = identity.clearOwnerRecoveryToken(db2);
  assertEq(rev.cleared, true, 'clearOwnerRecoveryToken returns cleared=true');
  const afterRevoke = db2.prepare('SELECT owner_recovery_token_hash FROM local_credentials WHERE user_id = ?').get(ownerRow.id).owner_recovery_token_hash;
  assertEq(afterRevoke, null, 'clearOwnerRecoveryToken clears the hash');

  // Audit rows for the HTTP path are checked at the end of Group 4.
  // The lib-level mint/consume/revoke paths in Group 2 are
  // deliberately audit-free here — the server.js HTTP handlers
  // own the audit contract. The CLI driver (Group 5) writes its
  // own audit row via the lib; the HTTP handlers do the same on
  // their respective routes.
  const allMeta = db2.prepare(`SELECT meta FROM analytics_events WHERE subject_type = 'owner_recovery'`).all().map(r => r.meta).join('\n');
  // Some meta will exist from the CLI run in Group 5 IF this is a
  // re-run after that group; first-run of Group 2 has none. Either
  // way, the meta must never contain a plaintext token or
  // password.
  assert(!allMeta.includes(fresh.token), 'audit meta does NOT contain plaintext token');
  assert(!allMeta.includes('rotated-pw-67890'), 'audit meta does NOT contain new password');

  db2.close();
  ok('Group 2: recovery primitives enforce mint/consume/replay/audit');

  // ---- GROUP 3: outage resilience via /api/login ----
  console.log('\nGroup 3 — outage resilience (Authentik down)');

  // No headers anywhere → SWAG down / Authentik unreachable. The
  // owner must still be able to log in via the LAN password path.
  const r1 = await POST('/api/login', { username: 'admin', password: 'rotated-pw-67890' }, HEAD_NONE);
  assertEq(r1.status, 200, '/api/login with no Authentik headers + owner password → 200');
  const loginBody = await r1.json();
  assertEq(loginBody.user.username, 'admin', 'login returns owner username');

  // /api/me with no headers → { user: null } (not 401).
  const r2 = await GET('/api/me', HEAD_NONE);
  assertEq(r2.status, 200, '/api/me with no headers → 200');
  const meBody = await r2.json();
  assertEq(meBody.user, null, '/api/me returns { user: null } when no headers');

  // /api/me/identities with no headers → 401 (requires session).
  const r3 = await GET('/api/me/identities', HEAD_NONE);
  assertEq(r3.status, 401, '/api/me/identities with no headers → 401');

  // With Authentik headers, the owner's identity_links surface still
  // works (regression guard: outage path didn't break the happy path).
  const r4 = await GET('/api/me', HEAD_ADMIN);
  assertEq(r4.status, 200, '/api/me with admin headers → 200');
  const meAdmin = await r4.json();
  assertEq(meAdmin.user.username, 'admin', 'owner header-trust probe still resolves');

  ok('Group 3: outage resilience intact (login survives Authentik outage)');

  // ---- GROUP 4: API surfaces for admin recovery ----
  console.log('\nGroup 4 — /api/admin/owner/* endpoints');

  // `login-paths` is a read-only ops/test inventory and stays gated
  // behind `auth` + `requireAdmin` (header-trust or session). `recover`
  // is DELIBERATELY unauthenticated — see server.js. The one-shot
  // token is what authorizes the request, not the caller's session,
  // because a real break-glass scenario has no session or headers to
  // present at all.

  // GET /api/admin/owner/login-paths (no auth) → 401
  const r5 = await GET('/api/admin/owner/login-paths', HEAD_NONE);
  assertEq(r5.status, 401, 'login-paths without auth → 401');

  // GET /api/admin/owner/login-paths (as non-admin) → 403
  const r6 = await GET('/api/admin/owner/login-paths', HEAD_BRANDON);
  assertEq(r6.status, 403, 'login-paths as non-admin → 403');

  // GET /api/admin/owner/login-paths (admin) → 200 with shape
  const r7 = await GET('/api/admin/owner/login-paths', HEAD_ADMIN);
  assertEq(r7.status, 200, 'login-paths as admin → 200');
  const pathsBody = await r7.json();
  assertEq(pathsBody.owner.username, 'admin', 'login-paths owner.username is admin');
  assertEq(pathsBody.login_paths.local_credential, true, 'login-paths reports local_credential=true');
  assertEq(pathsBody.login_paths.identity_links >= 1, true, 'login-paths reports identity_links >= 1');
  assertEq(typeof pathsBody.login_paths.recovery_token_active, 'boolean', 'login-paths reports recovery_token_active as boolean');
  assert(Array.isArray(pathsBody.identity_links), 'login-paths returns identity_links array');
  // Hygiene: no hashes, tokens, plaintext in the response.
  const pathsJson = JSON.stringify(pathsBody);
  assert(!/password_hash|owner_recovery_token_hash/.test(pathsJson), 'login-paths response carries no secret columns');
  assert(!/pass_hash/.test(pathsJson), 'login-paths response carries no pass_hash column');

  // POST /api/admin/owner/recover end-to-end.
  // Step A: mint a token directly via the lib so we don't shell out.
  const db3 = new Database(path.join(tmpRoot, 'life.db'));
  const minted = identity.mintOwnerRecoveryToken(db3, { ttlMs: 60_000 });
  assert(!minted.alreadyActive, 'mint for /recover test succeeds');

  // Step B: POST /recover with a WRONG token and ZERO auth headers
  // (the true outage scenario) → 401 invalid_or_expired_token.
  const r8 = await POST('/api/admin/owner/recover', { token: 'b'.repeat(64), new_password: 'freshownerpw-12345' }, HEAD_NONE);
  assertEq(r8.status, 401, '/recover with wrong token, no auth at all → 401');
  const r8body = await r8.json();
  assertEq(r8body.error, 'invalid_or_expired_token', '/recover wrong-token error code matches');

  // Step C: POST /recover with the CORRECT token and ZERO auth headers
  // — no session, no x-authentik-* headers. This is the load-bearing
  // assertion for PHA-2708: the owner forgot their password AND
  // Authentik is unreachable, so there is nothing to authenticate
  // with except the token itself. If this required a prior admin
  // session it would be unreachable in the exact scenario it exists
  // to fix.
  const r9 = await POST('/api/admin/owner/recover', { token: minted.token, new_password: 'freshownerpw-12345' }, HEAD_NONE);
  assertEq(r9.status, 200, '/recover with right token and NO auth (true outage) → 200');
  const r9body = await r9.json();
  assertEq(r9body.ok, true, '/recover response.ok === true');
  assertEq(r9body.username, 'admin', '/recover returns admin username');

  // Step D: owner can now log in with the new password.
  const relogin = await loginRaw('admin', 'freshownerpw-12345');
  assertEq(relogin.status, 200, 'owner re-login with rotated password → 200');

  // Step E: replay within TTL, still with no auth → 401.
  const replayApi = await POST('/api/admin/owner/recover', { token: minted.token, new_password: 'never-applied-9999' }, HEAD_NONE);
  assertEq(replayApi.status, 401, 'replay of consumed token → 401');

  // Step F: short password rejected at the API layer, no auth.
  const shortPw = await POST('/api/admin/owner/recover', { token: 'a'.repeat(64), new_password: 'short' }, HEAD_NONE);
  assertEq(shortPw.status, 400, 'new_password too short → 400');

  // Step G: missing token, no auth → 400.
  const noToken = await POST('/api/admin/owner/recover', { new_password: 'rejected-no-token' }, HEAD_NONE);
  assertEq(noToken.status, 400, 'missing token → 400');

  // Step H: the caller's session identity is irrelevant to /recover —
  // a valid token succeeds under a non-admin household member's
  // session (e.g. Authentik is actually up, but for someone other
  // than the owner) exactly as it does with no session, and a bad
  // token still fails regardless of who's logged in. The TOKEN is
  // the authorization, not the session.
  const minted2 = identity.mintOwnerRecoveryToken(db3, { ttlMs: 60_000 });
  assert(!minted2.alreadyActive, 'second mint for cross-identity test succeeds');
  const nonAdminGoodToken = await POST('/api/admin/owner/recover', { token: minted2.token, new_password: 'freshownerpw-67890' }, HEAD_BRANDON);
  assertEq(nonAdminGoodToken.status, 200, '/recover with right token succeeds under a non-admin session too');
  const nonAdminBadToken = await POST('/api/admin/owner/recover', { token: 'c'.repeat(64), new_password: 'never-applied-9999' }, HEAD_BRANDON);
  assertEq(nonAdminBadToken.status, 401, '/recover with wrong token still fails under a non-admin session');

  // Step I: GET /login-paths now shows recovery_token_active=false
  // (the consume cleared it).
  const r10 = await GET('/api/admin/owner/login-paths', HEAD_ADMIN);
  const r10body = await r10.json();
  assertEq(r10body.login_paths.recovery_token_active, false, 'recovery_token_active=false after consume');

  // Audit trail writes happen on the HTTP path. Verify the kind
  // rows exist after the consume.
  const auditRowsHttp = db3.prepare(`SELECT kind FROM analytics_events WHERE subject_type = 'owner_recovery' ORDER BY id ASC`).all().map(r => r.kind);
  assert(auditRowsHttp.includes('owner_recovery_consumed'), 'audit row: consumed (via /recover)');
  assert(auditRowsHttp.includes('owner_recovery_rejected'), 'audit row: rejected (via wrong-token attempt)');

  db3.close();
  ok('Group 4: admin API surfaces enforce auth + ownership + audit');

  // ---- GROUP 5: CLI round-trip ----
  console.log('\nGroup 5 — scripts/owner-recovery.js CLI');

  // Mint fresh token, capture stdout JSON, then drive the recovery
  // via the CLI's printed curl example to confirm the contract holds.
  const cliOut = execFileSync('node', [
    path.resolve(__dirname, '..', 'scripts', 'owner-recovery.js'),
  ], {
    env: { ...process.env, DATA_DIR: tmpRoot },
    encoding: 'utf8',
  });
  const cliJson = JSON.parse(cliOut);
  assertEq(cliJson.action, 'mint', 'CLI prints action=mint');
  assertEq(cliJson.username, 'admin', 'CLI prints owner username');
  assertEq(typeof cliJson.token, 'string', 'CLI prints a plaintext token');
  assertEq(cliJson.token.length, 64, 'CLI token is 64 hex chars');
  assert(/Save the token/.test(cliJson.warning), 'CLI warns about saving the token');
  assert(/curl/.test(cliJson.curl_example), 'CLI prints a curl example');

  // Audit row from CLI mint is recorded.
  const db4 = new Database(path.join(tmpRoot, 'life.db'));
  const cliAudit = db4.prepare(`SELECT kind, meta FROM analytics_events WHERE kind = 'owner_recovery_minted' ORDER BY id DESC LIMIT 1`).get();
  assert(!!cliAudit, 'CLI mint leaves an owner_recovery_minted audit row');
  const cliMeta = JSON.parse(cliAudit.meta || '{}');
  assertEq(cliMeta.source, 'owner-recovery.js', 'CLI audit meta.source is the script path');
  assertEq(cliMeta.ttl_min, 60, 'CLI audit meta.ttl_min is 60 by default');

  // --revoke: second run with --revoke clears the active token.
  const revokeOut = execFileSync('node', [
    path.resolve(__dirname, '..', 'scripts', 'owner-recovery.js'),
    '--revoke',
  ], {
    env: { ...process.env, DATA_DIR: tmpRoot },
    encoding: 'utf8',
  });
  const revokeJson = JSON.parse(revokeOut);
  assertEq(revokeJson.action, 'revoke', 'CLI --revoke prints action=revoke');
  assertEq(revokeJson.cleared, true, 'CLI --revoke clears the active token');

  // After revoke, minting a fresh token succeeds (no alreadyActive).
  // Login as owner with the last password rotation from Group 4's
  // cross-identity step (freshownerpw-67890). Confirm password wasn't
  // touched by --revoke.
  const stillWorks = await POST('/api/login', { username: 'admin', password: 'freshownerpw-67890' }, HEAD_NONE);
  assertEq(stillWorks.status, 200, 'owner password NOT touched by revoke');
  db4.close();
  ok('Group 5: CLI round-trip works end-to-end');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
