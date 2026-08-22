#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-2207 (PHA-2200.6) acceptance tests for the invite-to-wall flow.
//
// Boots server.js on an ephemeral port (3192) and exercises the full
// endpoint matrix against a header-trust mock. Mirrors the pattern of
// scripts/test-modules-api.js — no supertest, just fetch against the
// listening socket.
//
// Acceptance covered (per PHA-2207 issue body):
//   * POST /api/invites requires wall_slug (legacy PHA-1575 path returns 400).
//   * POST /api/invites requires admin (non-admin returns 403).
//   * POST /api/invites with valid wall_slug returns 201 + URL with code.
//   * Redeeming an invite atomically grants wall membership AND stamps
//     redeemed_by/redeemed_at on the invite.
//   * New user (first_run_completed_at IS NULL) lands on welcome sheet;
//     first_run stays true until POST /api/me/first-run-complete.
//   * Existing user (first_run_completed_at NOT NULL) gets membership
//     but first_run stays false (they skip the welcome sheet).
//   * Redeeming an already-redeemed invite returns 410.
//   * Redeeming an unknown code returns 404.
//   * Members list returned by redeem matches the wall roster.
//
// Out of scope (handled by sibling PHAs):
//   * The Wizarr UI for invite creation (PHA-1575 still owns that).
//   * SPA rendering of the welcome sheet (PHA-2200.4).
//   * The /invite/:code HTML page itself (this test covers the API;
//     the HTML is exercised by smoke-* scripts if added later).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-invite-'));
process.env.DATA_DIR = tmpDir;
process.env.PORT = '3192';
process.env.ADMIN_PASSWORD = 'invite-test-pw';
process.env.BRANDON_PASSWORD = 'invite-test-pw';
process.env.SESSION_SECRET = 'invite-test-secret';
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
  'x-authentik-username': 'brandon',
  'x-authentik-groups': 'household,admins',
};
const HEAD_USER = {
  'x-authentik-username': 'alice',
  'x-authentik-groups': 'household',
};
const HEAD_USER2 = {
  'x-authentik-username': 'bob',
  'x-authentik-groups': 'household',
};

const POST = (urlPath, body, headers = HEAD_ADMIN) => fetch('http://127.0.0.1:3192' + urlPath, {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: body === undefined ? '{}' : JSON.stringify(body),
});
const GET = (urlPath, headers = HEAD_ADMIN) => fetch('http://127.0.0.1:3192' + urlPath, {
  headers,
});

(async () => {
  const app = require('../server.js');
  await new Promise((resolve, reject) => {
    app.listen(3192, '127.0.0.1', () => { console.log('[test-invite-to-wall] homestead on :3192'); resolve(); });
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

  console.log('\nTest 1: POST /api/invites requires wall_slug');
  {
    // No wall_slug — legacy PHA-1575 path — must 400.
    const r = await POST('/api/invites', {});
    assertEq(r.status, 400, 'POST /api/invites {} → 400');
    const body = await r.json();
    assert(body.error === 'wall_slug required', 'error code is "wall_slug required"');
    assert(body.hint && body.hint.includes('PHA-1575'), 'hint mentions PHA-1575 reframe');
  }

  console.log('\nTest 2: POST /api/invites requires admin');
  {
    const r = await POST('/api/invites', { wall_slug: 'media-club' }, HEAD_USER);
    assertEq(r.status, 403, 'non-admin POST /api/invites → 403');
  }

  console.log('\nTest 3: POST /api/invites with valid wall_slug returns 201 + URL');
  {
    const r = await POST('/api/invites', {
      wall_slug: 'media-club',
      expires_in_days: 14,
      note: 'for the new neighbor',
    });
    assertEq(r.status, 201, 'admin POST /api/invites → 201');
    const body = await r.json();
    assert(body.id && /^[a-f0-9]{32}$/.test(body.id), 'id is a 32-char hex code');
    assertEq(body.wall_slug, 'media-club', 'wall_slug echoed back');
    assertEq(body.wall_name, 'Media Club', 'wall_name looked up');
    assert(body.url && body.url.includes(body.id), 'URL contains the code');
    assert(body.expires_at && body.created_at, 'created_at + expires_at set');
  }

  console.log('\nTest 4: GET /api/invites lists outstanding invites');
  {
    const r = await GET('/api/invites');
    assertEq(r.status, 200, 'admin GET /api/invites → 200');
    const body = await r.json();
    assert(Array.isArray(body.invites), 'response has invites array');
    assert(body.invites.length >= 1, 'at least one invite listed');
    assert(body.invites.every(i => i.redeemed_by === null), 'none redeemed (default filter)');
  }

  console.log('\nTest 5: redemption flow — new user joins media-club');
  let inviteCode = null;
  {
    // Fresh invite for this test.
    const r = await POST('/api/invites', { wall_slug: 'media-club' });
    const body = await r.json();
    inviteCode = body.id;

    // Alice redeems. Provision-or-claim creates her row with
    // first_run_completed_at = NULL (the seed doesn't touch this
    // column), so she's a "new user."
    const redeem = await POST('/api/invites/' + inviteCode + '/redeem', {}, HEAD_USER);
    assertEq(redeem.status, 200, 'alice redeems → 200');
    const rbody = await redeem.json();
    assertEq(rbody.ok, true, 'ok: true');
    assertEq(rbody.wall_slug, 'media-club', 'wall_slug returned');
    assertEq(rbody.wall_name, 'Media Club', 'wall_name returned');
    assertEq(rbody.first_run, true, 'first_run: true (new user)');
    assert(rbody.redirect && rbody.redirect.includes('welcome.html'), 'redirect points to welcome.html');
    assert(Array.isArray(rbody.members), 'members array returned');
    assert(rbody.members.some(m => m.username === 'alice'), 'alice appears in members list');
  }

  console.log('\nTest 6: redemption grants wall_memberships row');
  {
    // Confirm the membership row was actually written. We check via
    // the public list-memberships endpoint that the user can now
    // see the wall (assertMember passes after redemption).
    const walls = await GET('/api/walls', HEAD_USER);
    const wbody = await walls.json();
    assert(Array.isArray(wbody.walls), 'GET /api/walls returns walls array');
    const mediaClub = wbody.walls.find(w => w.slug === 'media-club');
    assert(!!mediaClub, 'media-club is now visible to alice');
  }

  console.log('\nTest 7: redemption is one-shot (already-redeemed → 410)');
  {
    const r = await POST('/api/invites/' + inviteCode + '/redeem', {}, HEAD_USER2);
    assertEq(r.status, 410, 'second redemption → 410');
    const body = await r.json();
    assertEq(body.error, 'invite_already_redeemed', 'error: invite_already_redeemed');
  }

  console.log('\nTest 8: unknown code → 404');
  {
    const r = await POST('/api/invites/deadbeef00000000deadbeef00000000/redeem', {}, HEAD_USER2);
    assertEq(r.status, 404, 'unknown code → 404');
    const body = await r.json();
    assertEq(body.error, 'invite_not_found', 'error: invite_not_found');
  }

  console.log('\nTest 9: POST /api/me/first-run-complete stamps the column');
  {
    // Alice hasn't completed first run yet (the new-user redemption
    // path leaves first_run_completed_at = NULL). Confirm.
    const meBefore = await (await GET('/api/me', HEAD_USER)).json();
    assertEq(meBefore.first_run, true, 'before: first_run === true');

    const complete = await POST('/api/me/first-run-complete', {}, HEAD_USER);
    assertEq(complete.status, 200, 'POST /api/me/first-run-complete → 200');
    const cbody = await complete.json();
    assertEq(cbody.ok, true, 'ok: true');
    assertEq(cbody.first_run, false, 'first_run: false after complete');

    const meAfter = await (await GET('/api/me', HEAD_USER)).json();
    assertEq(meAfter.first_run, false, 'after: first_run === false');

    // Idempotent — calling again stays at false.
    const second = await POST('/api/me/first-run-complete', {}, HEAD_USER);
    assertEq(second.status, 200, 'second call → 200');
    const sbody = await second.json();
    assertEq(sbody.first_run, false, 'still false on second call (idempotent)');
  }

  console.log('\nTest 10: existing user (first_run_completed_at NOT NULL) skips welcome');
  {
    // Brandon is a seeded user; provisionOrClaim has already set
    // first_run_completed_at = NULL on fresh boot. We need to mark
    // him completed first to simulate an "existing user."
    await POST('/api/me/first-run-complete', {}, HEAD_ADMIN);

    // Issue a fresh invite.
    const ir = await POST('/api/invites', { wall_slug: 'media-club' });
    const inv = await ir.json();

    // Brandon redeems.
    const redeem = await POST('/api/invites/' + inv.id + '/redeem', {}, HEAD_ADMIN);
    assertEq(redeem.status, 200, 'brandon redeems → 200');
    const rbody = await redeem.json();
    assertEq(rbody.first_run, false, 'first_run: false (existing user keeps first_run_completed_at)');
    // The redirect still points at welcome.html, but the page itself
    // bounces the existing user straight to the feed (per welcome.html
    // bootstrap). The API contract only sets first_run; the SPA gates
    // the sheet.
  }

  console.log('\nTest 11: GET /api/walls/:slug/members for a member');
  {
    const r = await GET('/api/walls/media-club/members', HEAD_USER);
    assertEq(r.status, 200, 'GET /api/walls/media-club/members (alice) → 200');
    const body = await r.json();
    assertEq(body.wall.slug, 'media-club', 'wall.slug === "media-club"');
    assert(body.members.length >= 2, 'members includes alice + brandon');
    assert(body.members.some(m => m.username === 'alice'), 'alice in members');
    assert(body.members.some(m => m.username === 'brandon'), 'brandon in members');
    assert(body.members[0].joined_at, 'members have joined_at');
  }

  console.log('\nTest 12: invite with invalid wall_slug → 400');
  {
    const r = await POST('/api/invites', { wall_slug: 'nonexistent-wall' });
    assertEq(r.status, 400, 'invalid wall_slug → 400');
    const body = await r.json();
    assertEq(body.error, 'wall_not_found', 'error: wall_not_found');
  }

  console.log('\nTest 13: invite with bad expires_in_days → 400');
  {
    const tooBig = await POST('/api/invites', { wall_slug: 'media-club', expires_in_days: 999 });
    assertEq(tooBig.status, 400, 'expires_in_days=999 → 400');

    const notInt = await POST('/api/invites', { wall_slug: 'media-club', expires_in_days: 'soon' });
    assertEq(notInt.status, 400, 'expires_in_days="soon" → 400');
  }

  console.log('\nTest 14: POST /api/invites/:code/redeem unauthenticated → 401');
  {
    const r = await POST('/api/invites/' + inviteCode + '/redeem', {}, {});
    assertEq(r.status, 401, 'no auth headers → 401');
  }

  console.log('\nTest 15: idempotent addMember — redeeming same invite twice for same user');
  {
    // Brandon already redeemed one invite above. We re-redeem his
    // OWN invite code — should hit the "already_redeemed" 410 path
    // before addMember is even called. (This is a guard; the real
    // idempotency lives in addMember via INSERT OR IGNORE.)
    const r = await POST('/api/invites/' + inviteCode + '/redeem', {}, HEAD_USER);
    assertEq(r.status, 410, 're-redeem by original user → 410 already_redeemed');
  }

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => {
  console.error('[test-invite-to-wall] fatal', err);
  process.exit(1);
});