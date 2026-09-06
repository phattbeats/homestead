#!/usr/bin/env node
// PHA-3214 (PHA-1647 / PHA-3198): regression smoke for the second
// server.js router extraction. The /api/health and /api/version routes
// were relocated from server.js to routes/health.js (server.js
// 4846 -> 4825 lines). The miss-risk here is small but non-zero: if
// the mount is wrong, Watchtower's health poll goes red and stops
// auto-rolling — same bug class as PHA-2883 but on the most-probed
// route in the system.
//
// What this test asserts (10 assertions):
//   1. routes/health.js factory throws when db is missing.
//   2. factory throws when secretBox is missing.
//   3. factory throws when version is missing.
//   4. factory returns a function (router) when deps are complete.
//   5. GET /api/health returns 200 with the full health JSON shape
//      (ok, service, version, commit, uptime, db, calendarCredKeyReady,
//      sessionSecretReady) — byte-level regression guard against
//      accidental field removal during the relocation.
//   6. health.service === 'homestead'.
//   7. health.version === package.json version.
//   8. /api/version returns 200 with {version, commit}.
//   9. /api/version.version === package.json version.
//  10. server.js is now < 4846 lines (the count before this PR).
//      This is a structural drift check, not a behavioral one —
//      catches future PRs that re-inflate the file without
//      extracting first.
//
// Behavior must not change relative to the pre-PR server.js. The
// existing scripts/test-2588-health-default.js (PHA-2588) covers
// the default-install readiness contract; this test covers the
// relocation specifically (factory + shape + mount + line count).

'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-3214-'));
const port = 3214;
process.env.DATA_DIR = dataDir;
process.env.PORT = String(port);
process.env.ADMIN_PASSWORD = '3214-admin-pw-padding-to-meet-min-32-chars';
// SESSION_SECRET is handled by scripts/_test-bootstrap.js (loaded
// via `node --require`). Set NODE_ENV here so the production code
// path is exercised (cookie.secure behavior, PHA-3200 fail-closed).
process.env.NODE_ENV = 'production';
// Lock commit SHA so the version assertion is deterministic.
process.env.COMMIT_SHA = '3214-test-sha';
delete process.env.CALENDAR_CRED_KEY;

const healthRouter = require('../routes/health');

(async () => {
  // 1-3: factory rejects missing required deps. The order matters for
  // the diagnostics: db is the first thing the constructor touches
  // when wiring up its handlers, but the explicit checks happen in
  // the order the deps appear in the signature (see routes/health.js).
  assert.throws(() => healthRouter({ secretBox: {}, version: '0', commit: null }), /db is required/, 'missing db throws');
  assert.throws(() => healthRouter({ db: {}, version: '0', commit: null }), /secretBox is required/, 'missing secretBox throws');
  assert.throws(() => healthRouter({ db: {}, secretBox: {}, commit: null }), /version is required/, 'missing version throws');

  // 4: factory returns a function (Express Router) with valid deps.
  const fakeRouter = healthRouter({
    db: { prepare: () => ({ get: () => ({ one: 1 }) }) },
    secretBox: { keyReady: () => true, sessionSecretReady: () => true },
    version: '0.0.0-test',
    commit: 'fake-sha',
  });
  assert.equal(typeof fakeRouter, 'function', 'factory returns a router function');

  // 5-9: boot the real server.js and exercise the live HTTP routes.
  const app = require('../server.js');
  const server = await new Promise((resolve, reject) => {
    const listener = app.listen(port, '127.0.0.1', () => resolve(listener));
    listener.once('error', reject);
  });

  try {
    // 5: GET /api/health returns 200 + full JSON shape.
    const healthResponse = await fetch(`http://127.0.0.1:${port}/api/health`);
    const health = await healthResponse.json();
    assert.equal(healthResponse.status, 200, 'health endpoint returns 200');
    assert.deepEqual(
      Object.keys(health).sort(),
      ['calendarCredKeyReady', 'commit', 'db', 'ok', 'service', 'sessionSecretReady', 'uptime', 'version'],
      'health JSON shape preserved (no fields lost during relocation)'
    );

    // 6: service identity.
    assert.equal(health.service, 'homestead', 'health.service === homestead');

    // 7: version matches package.json.
    const pkg = require('../package.json');
    assert.equal(health.version, pkg.version, 'health.version matches package.json');
    assert.equal(health.commit, '3214-test-sha', 'health.commit matches COMMIT_SHA env');

    // 8-9: /api/version is mounted and returns the same version.
    const versionResponse = await fetch(`http://127.0.0.1:${port}/api/version`);
    const versionJson = await versionResponse.json();
    assert.equal(versionResponse.status, 200, 'version endpoint returns 200');
    assert.equal(versionJson.version, pkg.version, 'version.version matches package.json');
    assert.equal(versionJson.commit, '3214-test-sha', 'version.commit matches COMMIT_SHA env');

    // 10: server.js line count drift check. Pre-PR was 4846 lines.
    // Allow a small upward drift for new comments / reformatting, but
    // a large jump means somebody re-inflated it without extracting.
    const lineCount = Number(execSync(`wc -l < ${path.join(__dirname, '..', 'server.js')}`).toString().trim());
    assert.ok(lineCount < 4846, `server.js line count dropped below the pre-PR baseline (got ${lineCount}, expected < 4846)`);

    console.log('PHA-3214: routes/health.js extraction passes (10/10)');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});