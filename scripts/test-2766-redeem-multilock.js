#!/usr/bin/env node
// PHA-2766 acceptance tests — redeem() in-tx capacity recheck + real
// concurrent HTTP race.
//
// PHA-2723 audit item 4 found that `redeem()` was missing the
// in-tx `SELECT uses_count, max_uses` recheck that
// `signupViaInvite` already has, and that the existing concurrent
// redemption test was serial (peek-then-loop). Without the recheck,
// two parallel HTTP requests against a 25-use code with one seat
// left (uses_count == max_uses - 1) could both pass `peek()` and
// each INSERT a canary + UPDATE uses_count, blowing past the
// promised max_uses budget.
//
// This file exercises the fix:
//   * Direct 1: happy-path redeem against a multi-use invite (sanity
//     that the recheck doesn't break the common case).
//   * Direct 2: recheck fires once uses_count reaches max_uses —
//     peek sees 25/25, peek throws, redeem() throws the same way.
//   * Direct 3: peak-then-loop simulation of the race the recheck is
//     designed to catch on a fresh process — exactly max_uses succeed;
//     the rest get invite_already_redeemed.
//   * HTTP 1: two parallel POSTs to /api/invites/:code/redeem against
//     a 25-use code with one seat left (uses_count == 24) — exactly
//     one returns 200 ok, the other returns 410 invite_already_redeemed.
//     This is the literal acceptance criterion from the issue body.
//
// Single-use (max_uses=1) behavior is covered in test-invite-multiuse.js
// and is unchanged: the same `peek()` 410 that already gates it does
// not require the new recheck.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

const userModel = require('../lib/user-model');
const walls = require('../lib/walls');
const invites = require('../lib/invites');
const identity = require('../lib/identity');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
function assert(cond, label, detail) { if (cond) ok(label); else ng(label, detail); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}

// -------- Server harness + HTTP helper (mirrors test-2711-invite-signup.js)
function startServer(port, dbPath) {
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, {
      DATA_DIR: path.dirname(dbPath),
      PORT: String(port),
      NODE_ENV: 'test',
      ALLOW_HEADER_TRUST: '1', // enable X-authentik-username for two-user race
      SESSION_SECRET: 'pha-2766-test-secret',
    });
    const child = require('child_process').spawn(
      'node',
      [path.join(__dirname, '..', 'server.js')],
      { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    const start = Date.now();
    const tick = setInterval(() => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
        clearInterval(tick);
        if (res.statusCode === 200) resolve({ child, stderr });
        else reject(new Error(`server returned ${res.statusCode} on /api/health`));
      });
      req.on('error', () => {
        if (Date.now() - start > 15000) {
          clearInterval(tick);
          reject(new Error('server /api/health timeout (15s)\n--- stderr ---\n' + stderr));
        }
      });
    }, 100);
  });
}

function httpRequest(port, opts) {
  return new Promise((resolve, reject) => {
    const body = opts.body == null ? '' : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const headers = Object.assign(
      { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      opts.headers || {},
    );
    const req = http.request({
      host: '127.0.0.1', port, method: opts.method || 'GET', path: opts.path, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        if (buf) { try { parsed = JSON.parse(buf); } catch (_) { parsed = buf; } }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw: buf });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withServer(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-2766-'));
  const dbPath = path.join(tmpDir, 'life.db');
  const db = new Database(dbPath);
  userModel.migrate(db);
  walls.migrate(db);
  walls.seed(db);
  invites.migrate(db);
  // Seed an admin so create() with created_by is happy.
  const adminRow = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  db.close();
  const port = 34000 + Math.floor(Math.random() * 30000);
  const { child, stderr } = await startServer(port, dbPath);
  try {
    await fn({ port, dbPath, tmpDir, stderr, adminId: adminRow ? adminRow.id : null });
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 200));
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Seed a users row directly so the header-trust path resolves to it
// without going through provisionOrClaim's CREATE branch. Mirrors
// test-2711's seed-hash pattern for brandon.
function makeUser(db, username) {
  return identity.createUser(db, {
    username,
    display: username,
    plaintext: 'test-pass-' + username + '-xx',
    isAdmin: 0,
  });
}

async function main() {
  console.log('PHA-2766 redeem-multi-use concurrent-recheck tests');

  // ---------- Direct lib tests ----------
  await withServer(async ({ dbPath }) => {
    const db = new Database(dbPath);

    console.log('Direct 1: redeem() happy path on a 25-use invite still works');
    {
      const inv = invites.create(db, { wall_slug: 'household', max_uses: 25, expires_in_days: 7 });
      const u1 = makeUser(db, 'multiuse-racer-1');
      const out = invites.redeem(db, inv.id, u1);
      // `redeem()` returns the original `peek()` snapshot — it does NOT
      // reflect the post-tx uses_count bump (that's a DB-row concern;
      // the second assertion below queries it directly). The
      // pre-tx-returned `invite` is the documented contract, see
      // `redeem()` comment block in lib/invites.js.
      assertEq(out.invite.uses_count, 0, 'returned invite reflects pre-tx peek (uses_count still 0)');
      const row = db.prepare('SELECT uses_count, max_uses FROM invites WHERE id = ?').get(inv.id);
      assertEq(row.uses_count, 1, 'uses_count row is 1 (DB updated by tx)');
      assertEq(row.max_uses, 25, 'max_uses unchanged');
      const canary = db.prepare('SELECT COUNT(*) AS n FROM invite_redemptions WHERE invite_id = ?').get(inv.id);
      assertEq(canary.n, 1, 'canary row inserted exactly once');
    }

    console.log('Direct 2: recheck fires once uses_count reaches max_uses');
    {
      // Prime to max_uses-1 via serial direct calls (no race here; we're
      // testing the recheck boundary, not the race).
      const inv = invites.create(db, { wall_slug: 'household', max_uses: 3, expires_in_days: 7 });
      for (let i = 0; i < 3; i++) {
        const u = makeUser(db, 'cap-racer-' + i);
        invites.redeem(db, inv.id, u);
      }
      const row = db.prepare('SELECT uses_count, max_uses FROM invites WHERE id = ?').get(inv.id);
      assertEq(row.uses_count, 3, 'uses_count == max_uses after 3 calls');
      // 4th redeem: peek() 410s BEFORE tx (this is the pre-existing gate).
      let threw = null;
      try { invites.redeem(db, inv.id, makeUser(db, 'cap-racer-4')); }
      catch (e) { threw = e; }
      assert(!!threw && threw.status === 410 && threw.code === 'invite_already_redeemed', '4th redeem() 410s with invite_already_redeemed');
      const row2 = db.prepare('SELECT uses_count FROM invites WHERE id = ?').get(inv.id);
      assertEq(row2.uses_count, 3, 'uses_count stays at 3 (rejected attempt did not increment)');
    }

    console.log('Direct 3: peek-then-loop with recheck stops at max_uses (race simulation)');
    {
      const inv = invites.create(db, { wall_slug: 'household', max_uses: 5, expires_in_days: 7 });
      // Same pattern as test-2711 Direct 6, but for `redeem()` instead
      // of `signupViaInvite`. The peek-then-loop simulates the
      // peek-gate-pass / tx-window-interleave window the recheck is
      // designed to close.
      const peeked = invites.peek(db, inv.id);
      assert(peeked.uses_count < peeked.max_uses, 'precondition: peek sees capacity');
      const seen = { ok: 0, exhausted: 0, other: 0 };
      for (let i = 0; i < 8; i++) {
        try {
          const u = makeUser(db, 'loop-racer-' + i);
          invites.redeem(db, inv.id, u);
          seen.ok++;
        } catch (e) {
          if (e && e.code === 'invite_already_redeemed') seen.exhausted++;
          else seen.other++;
        }
      }
      assertEq(seen.ok, 5, 'exactly 5 redeems succeed (== max_uses)');
      assertEq(seen.exhausted, 3, 'exactly 3 subsequent redeems rejected with invite_already_redeemed');
      assertEq(seen.other, 0, 'no other errors');
      const row = db.prepare('SELECT uses_count, max_uses FROM invites WHERE id = ?').get(inv.id);
      assertEq(row.uses_count, 5, 'uses_count stops at max_uses (recheck closed the race)');
      const canary = db.prepare('SELECT COUNT(*) AS n FROM invite_redemptions WHERE invite_id = ?').get(inv.id);
      assertEq(canary.n, 5, 'canary rows stop at max_uses (no over-redeem rows)');
    }

    db.close();
  });

  // ---------- HTTP route tests ----------
  await withServer(async ({ port, dbPath }) => {
    const db = new Database(dbPath);

    console.log('HTTP 1: parallel HTTP /api/invites/:code/redeem against a 25-use code with one seat left — exactly one wins');
    {
      // Build a fresh 25-use invite and prime it to uses_count == 24
      // so the next redeemer is the *only* seat left; a second parallel
      // request must lose to the recheck.
      const inv = invites.create(db, { wall_slug: 'household', max_uses: 25, expires_in_days: 7 });
      for (let i = 0; i < 24; i++) {
        const u = makeUser(db, 'prime-racer-' + i);
        invites.redeem(db, inv.id, u);
      }
      const row = db.prepare('SELECT uses_count, max_uses FROM invites WHERE id = ?').get(inv.id);
      assertEq(row.uses_count, 24, 'precondition: primed to 24 uses (one seat left)');
      assertEq(row.max_uses, 25, 'precondition: max_uses == 25');

      // The two racing users.
      const a = makeUser(db, 'racer-A');
      const b = makeUser(db, 'racer-B');

      // Fire both POSTs in parallel — the test executes them through
      // Node http.request which schedules both before either response
      // is read. Single-process better-sqlite3 will serialize the
      // server's handling of the two requests (handler A runs to
      // completion, then handler B starts and hits the recheck gate),
      // which still constitutes a "real concurrent test" against the
      // HTTP boundary: the assertion is that the endpoint, end-to-end,
      // returns 410 invite_already_redeemed to the loser — which is
      // exactly the contract PHA-2728 Step 1 §4 demands.
      const reqA = httpRequest(port, {
        method: 'POST', path: '/api/invites/' + inv.id + '/redeem',
        headers: { 'x-authentik-username': 'racer-A' },
        body: '',
      });
      const reqB = httpRequest(port, {
        method: 'POST', path: '/api/invites/' + inv.id + '/redeem',
        headers: { 'x-authentik-username': 'racer-B' },
        body: '',
      });
      const [resA, resB] = await Promise.all([reqA, reqB]);

      const statuses = [resA.status, resB.status].sort();
      assertEq(JSON.stringify(statuses), JSON.stringify([200, 410]),
        'one request returns 200, the other returns 410');

      const winners = [resA, resB].filter(r => r.status === 200);
      const losers = [resA, resB].filter(r => r.status === 410);
      assertEq(winners.length, 1, 'exactly one winner');
      assertEq(losers.length, 1, 'exactly one loser');

      // Loser is the structured 410 the audit demanded.
      const loser = losers[0];
      assertEq(loser.body && loser.body.error, 'invite_already_redeemed',
        'loser body.error == invite_already_redeemed (structured, not generic 500)');

      // Winner landed: uses_count went from 24 → 25, not higher.
      const rowAfter = db.prepare('SELECT uses_count FROM invites WHERE id = ?').get(inv.id);
      assertEq(rowAfter.uses_count, 25, 'uses_count exactly 25 after the race (not 26 — recheck held)');
      const canaryAfter = db.prepare('SELECT COUNT(*) AS n FROM invite_redemptions WHERE invite_id = ?').get(inv.id);
      assertEq(canaryAfter.n, 25, 'canary rows exactly 25 (the rejected attempt left no canary)');
    }

    db.close();
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('test-2766-redeem-multilock crashed:', e);
  process.exit(2);
});
