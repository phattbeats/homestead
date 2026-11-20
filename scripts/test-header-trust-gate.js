#!/usr/bin/env node
// PHA-3207: X-authentik-username is believed only from a peer listed in
// HOMESTEAD_TRUSTED_PROXIES. A spoofed header from anywhere else, including
// a forged X-Forwarded-For, gets no session and no user.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { parseTrustedProxies, parseGroups, createHeaderTrust } = require('../lib/header-trust');

let pass = 0;
function check(label, fn) {
  try { fn(); pass++; console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label} — ${e.message}`); process.exitCode = 1; }
}

// ---- unit: allowlist parsing ----
check('unset spec trusts nobody', () => {
  const t = parseTrustedProxies(undefined);
  assert.strictEqual(t.check('127.0.0.1'), false);
  assert.strictEqual(t.check('172.30.0.32'), false);
});
check('single IP, CIDR, IPv4-mapped IPv6 and loopback alias', () => {
  const t = parseTrustedProxies('172.30.0.32, 10.0.0.0/24, loopback');
  assert.strictEqual(t.check('172.30.0.32'), true);
  assert.strictEqual(t.check('::ffff:172.30.0.32'), true);
  assert.strictEqual(t.check('172.30.0.33'), false);
  assert.strictEqual(t.check('10.0.0.200'), true);
  assert.strictEqual(t.check('10.0.1.1'), false);
  assert.strictEqual(t.check('127.0.0.1'), true);
  assert.strictEqual(t.check('::1'), true);
  assert.strictEqual(t.check(undefined), false);
});
check('invalid entries are rejected, not widened', () => {
  const t = parseTrustedProxies('swag, 10.0.0.0/33, 0.0.0.0/x, ::1');
  assert.deepStrictEqual(t.rejected, ['swag', '10.0.0.0/33', '0.0.0.0/x']);
  assert.strictEqual(t.check('10.0.0.1'), false);
  assert.strictEqual(t.check('::1'), true);
});
check('groups header: CSV, JSON, and junk JSON', () => {
  assert.deepStrictEqual(parseGroups('household, admins'), ['household', 'admins']);
  assert.deepStrictEqual(parseGroups('["a","b"]'), ['a', 'b']);
  assert.deepStrictEqual(parseGroups('[{"x":1}]'), []);
  assert.deepStrictEqual(parseGroups('[oops'), []);
});
check('gate ignores header from untrusted peer and warns once', () => {
  const lines = [];
  const gate = createHeaderTrust('10.9.9.9', (l) => lines.push(l));
  const req = (peer) => ({ socket: { remoteAddress: peer }, get: (h) => ({ 'x-authentik-username': 'admin', 'x-authentik-groups': 'admins' })[h.toLowerCase()] });
  assert.strictEqual(gate.identity(req('127.0.0.1')), null);
  assert.strictEqual(gate.identity(req('127.0.0.1')), null);
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(gate.identity(req('10.9.9.9')), { username: 'admin', groups: ['admins'] });
});

// ---- integration: real server, trusted set excludes loopback ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-header-trust-'));
process.env.DATA_DIR = tmpDir;
process.env.ADMIN_PASSWORD = 'header-trust-test-pw';
process.env.HOMESTEAD_TRUSTED_PROXIES = '203.0.113.7'; // TEST-NET-3: never the test client
const PORT = 3291;
const BASE = `http://127.0.0.1:${PORT}`;
const SPOOF = { 'x-authentik-username': 'admin', 'x-authentik-groups': 'household,admins', 'x-forwarded-for': '203.0.113.7' };

(async () => {
  const app = require('../server.js');
  const server = await new Promise((resolve) => { const s = app.listen(PORT, '127.0.0.1', () => resolve(s)); });
  try {
    const results = {};
    for (const [label, url, method] of [
      ['protected', '/api/me/layout', 'GET'],
      ['me', '/api/me', 'GET'],
      ['redeem', '/api/invites/NOPE/redeem', 'POST'],
    ]) {
      const r = await fetch(BASE + url, { method, headers: SPOOF });
      results[label] = { status: r.status, cookie: r.headers.get('set-cookie'), body: await r.text() };
    }
    check('spoofed header on an auth route → 401, no session cookie', () => {
      assert.strictEqual(results.protected.status, 401, results.protected.body);
      assert.strictEqual(results.protected.cookie, null);
    });
    check('spoofed header on /api/me → user null, no session cookie', () => {
      assert.strictEqual(results.me.status, 200);
      assert.strictEqual(JSON.parse(results.me.body).user, null);
      assert.strictEqual(results.me.cookie, null);
    });
    check('spoofed header on invite redeem → 401', () => {
      assert.strictEqual(results.redeem.status, 401, results.redeem.body);
    });
    const Database = require('better-sqlite3');
    const db = new Database(path.join(tmpDir, 'life.db'), { readonly: true });
    check('spoof did not mark any user as claimed by header_trust', () => {
      const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE auth_provider = 'header_trust'").get();
      assert.strictEqual(row.n, 0);
    });
    db.close();
  } finally {
    server.close();
  }
  console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
