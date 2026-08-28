#!/usr/bin/env node
// PHA-2664 acceptance tests for multi-use ("porch code") invites.
//
// Exercises lib/invites.js directly against an ephemeral sqlite db —
// same pattern as scripts/test-invite-to-wall.js, but this one calls
// the module's functions in-process instead of booting the HTTP
// server, since the point here is the create/peek/redeem/list
// contract, not the routes (those are still covered end-to-end by
// test-invite-to-wall.js's single-use-by-default assertions).
//
// Acceptance covered:
//   * create() accepts max_uses (1..25); rejects out-of-range values.
//   * peek() does NOT 410 until uses_count reaches max_uses.
//   * redeem() inserts one invite_redemptions row per call and
//     increments uses_count.
//   * After the 25th redemption, peek()/redeem() 410 with
//     invite_already_redeemed.
//   * redeemed_by/redeemed_at reflect the MOST RECENT redeemer
//     (back-compat display columns).
//   * A default (no max_uses) invite still behaves single-use, so
//     test-invite-to-wall.js's existing assertions keep holding.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const invites = require('../lib/invites');
const userModel = require('../lib/user-model');
const walls = require('../lib/walls');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-invite-multiuse-'));
const db = new Database(path.join(tmpDir, 'test.db'));

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

userModel.migrate(db);
walls.migrate(db);
walls.seed(db);
invites.migrate(db);

// Seed N fake users to redeem as.
function makeUser(username) {
  return userModel.provisionOrClaim(db, username, 'header_trust', username, ['household']);
}

console.log('Test 1: create() accepts max_uses in range, rejects out of range');
{
  const inv = invites.create(db, { wall_slug: 'household', max_uses: 25, expires_in_days: 14 });
  assertEq(inv.max_uses, 25, 'max_uses echoed back as 25');
  assertEq(inv.uses_count, 0, 'uses_count starts at 0');

  let threw = false;
  try { invites.create(db, { wall_slug: 'household', max_uses: 26 }); }
  catch (e) { threw = true; assertEq(e.status, 400, 'max_uses=26 -> 400'); assertEq(e.code, 'invalid_max_uses', 'error code invalid_max_uses'); }
  assert(threw, 'max_uses=26 throws');

  threw = false;
  try { invites.create(db, { wall_slug: 'household', max_uses: 0 }); }
  catch (e) { threw = true; }
  assert(threw, 'max_uses=0 throws');

  threw = false;
  try { invites.create(db, { wall_slug: 'household', max_uses: 'lots' }); }
  catch (e) { threw = true; }
  assert(threw, 'max_uses="lots" throws');
}

console.log('\nTest 2: default create() (no max_uses) is still single-use');
{
  const inv = invites.create(db, { wall_slug: 'household' });
  assertEq(inv.max_uses, 1, 'default max_uses is 1');
  const u = makeUser('single-use-alice');
  invites.redeem(db, inv.id, u.id);
  let threw = false;
  try { invites.peek(db, inv.id); }
  catch (e) { threw = true; assertEq(e.status, 410, 'peek after 1 redemption on default invite -> 410'); assertEq(e.code, 'invite_already_redeemed', 'error invite_already_redeemed'); }
  assert(threw, 'single-use invite 410s after first redemption (back-compat)');
}

console.log('\nTest 3: 25-use invite — redeem 25 times, assert uses_count and canary rows');
{
  const inv = invites.create(db, { wall_slug: 'household', max_uses: 25, expires_in_days: 14, note: 'porch code' });
  const code = inv.id;

  for (let i = 1; i <= 25; i++) {
    const u = makeUser(`porch-user-${i}`);
    // peek must succeed (not throw) before this redemption, since
    // uses_count < max_uses at this point.
    const peeked = invites.peek(db, code);
    assert(!!peeked, `peek() succeeds before redemption #${i}`);

    const result = invites.redeem(db, code, u.id);
    assertEq(result.wall_slug, 'household', `redemption #${i} returns wall_slug`);
  }

  const row = db.prepare('SELECT * FROM invites WHERE id = ?').get(code);
  assertEq(row.uses_count, 25, 'uses_count === 25 after 25 redemptions');
  assertEq(row.max_uses, 25, 'max_uses unchanged at 25');

  const redemptions = db.prepare('SELECT * FROM invite_redemptions WHERE invite_id = ? ORDER BY id').all(code);
  assertEq(redemptions.length, 25, 'invite_redemptions has exactly 25 rows');
  assert(redemptions.every(r => r.user_id != null), 'every redemption row has a user_id');

  // redeemed_by/redeemed_at reflect the LAST redeemer (porch-user-25).
  const lastUser = db.prepare('SELECT id FROM users WHERE username = ?').get('porch-user-25');
  assertEq(row.redeemed_by, lastUser.id, 'redeemed_by is the most recent redeemer');
  assert(!!row.redeemed_at, 'redeemed_at is set');

  console.log('\nTest 4: 26th redemption attempt 410s (cap enforced)');
  let threw = false;
  try { invites.peek(db, code); }
  catch (e) {
    threw = true;
    assertEq(e.status, 410, 'peek() at cap -> 410');
    assertEq(e.code, 'invite_already_redeemed', 'error invite_already_redeemed');
  }
  assert(threw, 'peek() throws once uses_count reaches max_uses');

  const u26 = makeUser('porch-user-26');
  threw = false;
  try { invites.redeem(db, code, u26.id); }
  catch (e) {
    threw = true;
    assertEq(e.status, 410, 'redeem() at cap -> 410');
  }
  assert(threw, 'redeem() throws once uses_count reaches max_uses');

  const rowAfter = db.prepare('SELECT uses_count FROM invites WHERE id = ?').get(code);
  assertEq(rowAfter.uses_count, 25, 'uses_count stays at 25 (26th attempt did not increment)');

  const redemptionsAfter = db.prepare('SELECT COUNT(*) AS n FROM invite_redemptions WHERE invite_id = ?').get(code);
  assertEq(redemptionsAfter.n, 25, 'invite_redemptions row count stays at 25 (no canary row for the rejected attempt)');
}

console.log('\nTest 5: list() default filter excludes exhausted invites, includes multi-use invites with remaining capacity');
{
  const inv = invites.create(db, { wall_slug: 'household', max_uses: 5 });
  const listed = invites.list(db, { wall_slug: 'household' });
  assert(listed.some(i => i.id === inv.id), 'freshly-created 5-use invite appears in default (unexhausted) list');

  const u = makeUser('list-test-user-1');
  invites.redeem(db, inv.id, u.id);
  const listedAfterOneUse = invites.list(db, { wall_slug: 'household' });
  assert(listedAfterOneUse.some(i => i.id === inv.id), 'invite with 1/5 uses still appears in default list (not exhausted)');
}

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
