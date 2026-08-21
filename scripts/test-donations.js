#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 PHATT Tech LLC

// PHA-2223 acceptance tests for the donation surface.
//
// The donation surface is a deliberately small set of invariants that
// must remain true forever. Brandon's policy (recorded on PHA-2223)
// says: money stays potential, no analytics beyond a plain count,
// never attributed to a user, no payment handling in Homestead itself.
// These tests are the mechanical checks that enforce the policy in code:
//
//   1. The link URL is a config value, not a hardcoded constant — and
//      it MUST be a fully-qualified https/http/mailto URL. javascript:
//      and data: URLs are rejected so a misconfigured env var cannot
//      become a phishing redirect. `_validateUrl` is the gate.
//
//   2. The counter table literally cannot answer "who clicked?" —
//      there is no user_id, no IP, no user-agent, no referer column.
//      This test reads the schema and asserts the only columns are
//      `id` (PRIMARY KEY) and `day`. By schema, not by promises.
//
//   3. The click endpoint is unauthenticated public, returns 204 No
//      Content, and never echoes a body the operator could see in
//      logs. A body would leak timing info about which user clicked
//      relative to which session — we want zero body, always.
//
//   4. The avatar-menu About sheet is the single SPA surface for the
//      donation link, and it opens external links with the
//      `noopener,noreferrer` window-features so the provider site
//      can't touch Homestead's window. The test reads `public/index.html`
//      directly and confirms the markup + JS are wired.
//
//   5. The link must also appear in `README.md` so self-hosters who
//      don't have an account can still support the project.
//
// Out of scope (handled by sibling PHAs):
//   * Module enable/disable / admin auth — PHA-2204 / test-modules-api.
//   * Sheet UI layout / shell — PHA-2200.4 / general SPA work.
//   * GitHub Sponsors provider config — operator-side, not code.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const Database = require('better-sqlite3');

let pass = 0;
let fail = 0;
function ok(label) { pass++; console.log(`  ✓ ${label}`); }
function ng(label, detail) { fail++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) ok(label); else ng(label, `expected ${e}, got ${a}`);
}
function assert(cond, label, detail) {
  if (cond) ok(label); else ng(label, detail);
}

// `lib/donations` reads `process.env.DONATION_URL` at call time and
// memoizes. We require it lazily so we can reset the cache between
// tests by clearing require.cache + env.
function freshDonations(envUrl, envLabel) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/lib/donations.js')) delete require.cache[k];
  }
  if (envUrl === null) delete process.env.DONATION_URL;
  else if (envUrl === undefined) { /* leave alone */ }
  else process.env.DONATION_URL = envUrl;
  if (envLabel === null) delete process.env.DONATION_LABEL;
  else if (envLabel === undefined) { /* leave alone */ }
  else process.env.DONATION_LABEL = envLabel;
  return require('../lib/donations');
}

async function main() {
  const REPO = path.resolve(__dirname, '..');

  // ---------- Test 1: URL validation ----------
  console.log('Test 1: lib/donations._validateUrl rejects javascript:/data:/empty');
  try {
    const d = freshDonations(null, null);
    assertEq(d._validateUrl('https://github.com/sponsors/phattbeats'),
      'https://github.com/sponsors/phattbeats', 'https URL passes');
    assertEq(d._validateUrl('http://example.com/donate'),
      'http://example.com/donate', 'http URL passes');
    assertEq(d._validateUrl('mailto:brandon@example.com'),
      'mailto:brandon@example.com', 'mailto URL passes');
    assertEq(d._validateUrl('javascript:alert(1)'), null,
      'javascript: rejected');
    assertEq(d._validateUrl('data:text/html,foo'), null,
      'data: rejected');
    assertEq(d._validateUrl('file:///etc/passwd'), null,
      'file: rejected');
    assertEq(d._validateUrl(''), null, 'empty string rejected');
    assertEq(d._validateUrl(null), null, 'null rejected');
    assertEq(d._validateUrl(undefined), null, 'undefined rejected');
    assertEq(d._validateUrl('https://'), null,
      'https: with no hostname rejected');
    assertEq(d._validateUrl('   https://example.com   '),
      'https://example.com', 'leading/trailing whitespace trimmed');
    assertEq(d._validateUrl('not a url at all'), null,
      'garbage rejected');
  } catch (err) {
    ng('Test 1 crashed', err.stack || err.message);
  }

  // ---------- Test 2: env-link memoization + label truncation ----------
  console.log('\nTest 2: env-link reads DONATION_URL + caps label at 80 chars');
  try {
    const d1 = freshDonations('https://github.com/sponsors/phattbeats', null);
    assertEq(d1.getLink(),
      { url: 'https://github.com/sponsors/phattbeats', label: 'Support Homestead' },
      'default label "Support Homestead"');
    assertEq(d1.getStatus(),
      { configured: true, url: 'https://github.com/sponsors/phattbeats', label: 'Support Homestead' },
      'getStatus echoes configured state');

    const d2 = freshDonations('https://example.com/donate', 'Buy me a coffee');
    assertEq(d2.getLink(),
      { url: 'https://example.com/donate', label: 'Buy me a coffee' },
      'custom label honored');

    // Label cap: a 1000-char label should be sliced to 80.
    const long = 'x'.repeat(1000);
    const d3 = freshDonations('https://example.com/donate', long);
    assert(d3.getLink().label.length === 80, 'oversized label truncated to 80 chars',
      `got len=${d3.getLink().label.length}`);

    // Unset env => getLink returns null and getStatus says not configured.
    const d4 = freshDonations(null, null);
    assertEq(d4.getLink(), null, 'unset DONATION_URL => null link');
    assertEq(d4.getStatus(),
      { configured: false, url: null, label: null },
      'getStatus says not configured when env unset');

    // A bad URL env value => also null (not an exception).
    const d5 = freshDonations('javascript:alert(1)', null);
    assertEq(d5.getLink(), null,
      'bad URL (javascript:) => null link, not exception');
  } catch (err) {
    ng('Test 2 crashed', err.stack || err.message);
  }

  // ---------- Test 3: schema is "plain count, no attribution" ----------
  console.log('\nTest 3: donation_clicks table has NO per-user attribution columns');
  try {
    const d = freshDonations('https://github.com/sponsors/phattbeats', null);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-donations-schema-'));
    const db = new Database(path.join(tmpDir, 'life.db'));
    d.migrate(db);
    const cols = db.prepare("PRAGMA table_info('donation_clicks')").all().map(c => c.name);
    const allowed = new Set(['id', 'day']);
    const unexpected = cols.filter(c => !allowed.has(c));
    assertEq(unexpected, [], 'schema columns are exactly {id, day} — no user_id, IP, UA, or referer');
    const pk = db.prepare("PRAGMA table_info('donation_clicks')").all().find(c => c.pk === 1);
    assert(pk && pk.name === 'id', 'id is PRIMARY KEY');
    const dayCol = db.prepare("PRAGMA table_info('donation_clicks')").all().find(c => c.name === 'day');
    assert(dayCol && dayCol.notnull === 1, 'day is NOT NULL');
    const idx = db.prepare("PRAGMA index_list('donation_clicks')").all().map(i => i.name);
    assert(idx.some(n => /day/i.test(n)), 'index on day exists');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  } catch (err) {
    ng('Test 3 crashed', err.stack || err.message);
  }

  // ---------- Test 4: recordClick + getStats ----------
  console.log('\nTest 4: recordClick increments a counter; getStats sums by day');
  try {
    const d = freshDonations('https://github.com/sponsors/phattbeats', null);
    // getStats without migrate: should error because _db is null.
    // We freshly require here so the memoized _db from test 3's tmp
    // doesn't leak in.
    const fresh = freshDonations('https://github.com/sponsors/phattbeats', null);
    assertEq(fresh.getStats(), { ok: false, error: 'no_db' },
      'precondition: getStats without _db => no_db (fresh require)');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-donations-stats-'));
    const db = new Database(path.join(tmpDir, 'life.db'));
    d.migrate(db);
    // recordClick requires _db (set by migrate). Confirm:
    const r1 = d.recordClick();
    assertEq(r1, { ok: true }, 'first recordClick returns ok:true');
    const r2 = d.recordClick();
    assertEq(r2, { ok: true }, 'second recordClick returns ok:true');
    const stats = d.getStats();
    assert(stats.ok === true, 'getStats ok:true');
    assert(stats.total === 2, `total === 2 (got ${stats.total})`);
    assert(Array.isArray(stats.byDay) && stats.byDay.length === 1,
      'single day bucket today');
    const today = new Date().toISOString().slice(0, 10);
    assertEq(stats.byDay[0].day, today, `byDay[0].day === ${today}`);
    assertEq(stats.byDay[0].n, 2, 'byDay[0].n === 2');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  } catch (err) {
    ng('Test 4 crashed', err.stack || err.message);
  }

  // ---------- Test 5: live boot — /api/donation-link + /api/donation-click ----------
  console.log('\nTest 5: live boot — donation-link discovery + 204 click');
  let server = null;
  let tmpDir5 = null;
  try {
    const d = freshDonations('https://github.com/sponsors/phattbeats', 'Tip jar');
    tmpDir5 = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-donations-live-'));
    process.env.DATA_DIR = tmpDir5;
    process.env.PORT = '0';
    process.env.ADMIN_PASSWORD = 'donations-admin-pw';
    process.env.BRANDON_PASSWORD = 'donations-brandon-pw';
    process.env.SESSION_SECRET = 'donations-test-secret';
    process.env.NODE_ENV = 'production';
    for (const k of Object.keys(require.cache)) {
      if (k.includes('/server.js')) delete require.cache[k];
    }
    const app = require('../server.js');
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = server.address().port;
    const base = { hostname: '127.0.0.1', port, headers: {} };
    const request = (opts, body) => new Promise((resolve, reject) => {
      const req = http.request(opts, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(data); } catch (_) { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });

    // /api/donation-link — configured case.
    const linkRes = await request({ ...base, path: '/api/donation-link', method: 'GET' });
    assertEq(linkRes.status, 200, 'GET /api/donation-link => 200 when configured');
    assertEq(linkRes.body, { url: 'https://github.com/sponsors/phattbeats', label: 'Tip jar' },
      'GET /api/donation-link body matches env');

    // /api/donation-click — 204 No Content, no body.
    const clickRes = await request({ ...base, path: '/api/donation-click', method: 'POST' });
    assertEq(clickRes.status, 204, 'POST /api/donation-click => 204');
    assertEq(clickRes.raw, '', 'POST /api/donation-click has empty body');

    // Click again to confirm idempotent increment.
    await request({ ...base, path: '/api/donation-click', method: 'POST' });
    await request({ ...base, path: '/api/donation-click', method: 'POST' });

    // Admin stats — first login as admin (only `admin` is_admin per the
    // user-model seed), then GET. brandon is household-only by seed design.
    const loginRes = await request({
      ...base, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { username: 'admin', password: 'donations-admin-pw' });
    assertEq(loginRes.status, 200, 'login as admin => 200');
    const cookie = (loginRes.headers['set-cookie'] || [])[0];
    assert(!!cookie, 'login sets a session cookie');
    const statsRes = await request({
      ...base, path: '/api/admin/donation-stats', method: 'GET',
      headers: { Cookie: cookie },
    });
    assertEq(statsRes.status, 200, 'GET /api/admin/donation-stats as admin => 200');
    assert(statsRes.body && statsRes.body.total === 3, `admin stats total === 3 (got ${statsRes.body && statsRes.body.total})`);
    assertEq(statsRes.body.configured, true, 'admin stats say configured:true');

    // And 403 for a non-admin caller (brandon).
    const brandonLogin = await request({
      ...base, path: '/api/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { username: 'brandon', password: 'donations-brandon-pw' });
    assertEq(brandonLogin.status, 200, 'login as brandon => 200');
    const brandonCookie = (brandonLogin.headers['set-cookie'] || [])[0];
    const brandonStats = await request({
      ...base, path: '/api/admin/donation-stats', method: 'GET',
      headers: { Cookie: brandonCookie },
    });
    assertEq(brandonStats.status, 403, 'GET /api/admin/donation-stats as non-admin => 403');
  } catch (err) {
    ng('Test 5 crashed', err.stack || err.message);
  } finally {
    if (server) { try { server.close(); } catch (_) {} }
    if (tmpDir5) { try { fs.rmSync(tmpDir5, { recursive: true, force: true }); } catch (_) {} }
  }

  // ---------- Test 6: /api/donation-link returns 404 when unconfigured ----------
  console.log('\nTest 6: /api/donation-link returns 404 when DONATION_URL unset');
  let server6 = null;
  let tmpDir6 = null;
  try {
    // Critical: reload donations module with env cleared so getLink() returns null.
    freshDonations(null, null);
    tmpDir6 = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-donations-unset-'));
    process.env.DATA_DIR = tmpDir6;
    process.env.PORT = '0';
    process.env.ADMIN_PASSWORD = 'donations-admin-pw';
    process.env.BRANDON_PASSWORD = 'donations-brandon-pw';
    process.env.SESSION_SECRET = 'donations-unset-secret';
    process.env.NODE_ENV = 'production';
    for (const k of Object.keys(require.cache)) {
      if (k.includes('/server.js')) delete require.cache[k];
    }
    const app = require('../server.js');
    server6 = http.createServer(app);
    await new Promise((resolve, reject) => {
      server6.once('error', reject);
      server6.listen(0, '127.0.0.1', () => resolve());
    });
    const port = server6.address().port;
    const base = { hostname: '127.0.0.1', port, headers: {} };
    const res = await new Promise((resolve, reject) => {
      const req = http.request({ ...base, path: '/api/donation-link', method: 'GET' }, r => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(data); } catch (_) {}
          resolve({ status: r.statusCode, body: json });
        });
      });
      req.on('error', reject);
      req.end();
    });
    assertEq(res.status, 404, 'GET /api/donation-link => 404 when unset');
    assertEq(res.body, { error: 'not_configured' }, '404 body is {error: "not_configured"}');
  } catch (err) {
    ng('Test 6 crashed', err.stack || err.message);
  } finally {
    if (server6) { try { server6.close(); } catch (_) {} }
    if (tmpDir6) { try { fs.rmSync(tmpDir6, { recursive: true, force: true }); } catch (_) {} }
  }

  // ---------- Test 7: SPA wires the donation surface ----------
  console.log('\nTest 7: public/index.html wires f-about + openAboutSheet + noopener,noreferrer');
  try {
    const html = fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8');
    assert(/id="f-about"/.test(html), 'avatar menu has f-about button');
    assert(/onclick=.*openAboutSheet/.test(html),
      'f-about onclick calls openAboutSheet');
    assert(/async function openAboutSheet\(\)/.test(html),
      'openAboutSheet helper is defined');
    assert(/\/api\/donation-link/.test(html),
      'openAboutSheet fetches /api/donation-link');
    assert(/\/api\/donation-click/.test(html),
      'openAboutSheet fires /api/donation-click');
    assert(/window\.open\(link\.url,\s*'_blank',\s*'noopener,noreferrer'\)/.test(html),
      'link opens with noopener,noreferrer features');
    // The donation surface must NOT appear in onboarding, wall, or push UI.
    // We grep the surface landmarks to enforce the policy: the link lives
    // ONLY in the avatar-menu About sheet. We can't grep for absence of
    // 'donation' across the whole file because the helper code uses the
    // word. Instead, check that `openAboutSheet` is the ONLY function
    // that fetches `/api/donation-link`. Strip // comments before
    // counting so the policy comment above openAboutSheet doesn't
    // double-count.
    const stripped = html.replace(/^\s*\/\/.*$/gm, '');
    const linkFetchCount = (stripped.match(/\/api\/donation-link/g) || []).length;
    assert(linkFetchCount === 1,
      `donation-link fetched exactly once outside comments (got ${linkFetchCount})`);
  } catch (err) {
    ng('Test 7 crashed', err.stack || err.message);
  }

  // ---------- Test 8: README has a Support section with the link ----------
  console.log('\nTest 8: README.md has a Support section with the same link');
  try {
    const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
    assert(/^## Support/m.test(readme),
      'README has a top-level "## Support" section');
    assert(/github\.com\/sponsors\/phattbeats/.test(readme),
      'README Support section links to github.com/sponsors/phattbeats');
    // Policy language: no telemetry, no per-user attribution, no payment
    // handling in Homestead itself.
    assert(/no payment|no card|no webhook/i.test(readme),
      'README Support section explains Homestead does not handle payment');
    assert(/no analytics|plain count|never attributed|not per-user|not attributed|attribution/i.test(readme),
      'README Support section explains the no-attribution policy');
  } catch (err) {
    ng('Test 8 crashed', err.stack || err.message);
  }

  // ---------- Test 9: hardcoded-keys audit does NOT flag donation literals ----------
  console.log('\nTest 9: hardcoded-keys audit still passes (donation code does not introduce module-key literals)');
  // The audit greps for `wall|lists|calendar|chores|apps|agent` literals.
  // Our donation code uses "donation"/"donate"/"sponsor"/"about" only.
  // We don't run the full audit here (it's in test-registry-no-hardcoded-keys),
  // but we sanity-check that none of our new files contain those literals.
  const newFiles = [
    path.join(REPO, 'lib/donations.js'),
    path.join(REPO, 'scripts/test-donations.js'),
  ];
  let bad = [];
  for (const f of newFiles) {
    const src = fs.readFileSync(f, 'utf8');
    if (/(['"\`])(wall|lists|calendar|chores|apps|agent)\1/.test(src)) {
      bad.push(f);
    }
  }
  assertEq(bad, [], 'no module-key literals introduced in donation code');
  // Also check the index.html patch path: the new About button is
  // added between f-calendar-sources and f-connected-agents — those
  // existing buttons reference module names that ARE in the audit's
  // benign allow-list (they were already in the codebase before this
  // PR). We only flag NEW violations.

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('Test crashed:', err.stack || err.message);
  process.exit(1);
});