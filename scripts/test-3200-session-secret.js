#!/usr/bin/env node
// PHA-3200 acceptance: fail-closed session secret.
//
// Three stacked problems fixed in this PR:
//
//   1. Hardcoded fallback secret
//      (`'life-app-secret-change-me'`). Anyone reading the repo could
//      forge a session cookie for `admin` on any Homestead whose
//      SESSION_SECRET env var wasn't set.
//   2. `secure` flag absent on the session cookie. Production runs
//      behind HTTPS (life.phatt.vip → SWAG → Cloudflare) so the cookie
//      should never be sendable over plain HTTP.
//   3. 90-day cookie TTL. Tightened to 14 days.
//
// This test asserts the code refuses to boot when SESSION_SECRET is
// missing / a placeholder / too short, and that a real 64-char hex
// secret boots cleanly with `/api/health` reporting `sessionSecretReady:
// true`. The cookie flag assertions run over a real HTTP round-trip.
//
// Loaded via `node --require ./scripts/_test-bootstrap.js` from npm test.

'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Helper: assert that requiring server.js with the given env throws
// with an actionable SESSION_SECRET message. The secret-box check runs
// at module-load time (`app.use(session({...}))`), so we have to spawn a
// child process — `require` in this same process is already cached and
// already validated by _test-bootstrap.js.
function assertRefusesToBoot(envOverrides, label) {
  return new Promise((resolve, reject) => {
    const { spawnSync } = require('child_process');
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      HOMESTEAD_INSECURE_TEST_COOKIES: '1',
      ...envOverrides,
    };
    // Strip the bootstrap-injected SESSION_SECRET if the test wants to
    // exercise the missing-secret path.
    if (envOverrides.SESSION_SECRET === null) delete env.SESSION_SECRET;
    const r = spawnSync(process.execPath, ['-e', `
      process.on('uncaughtException', (e) => { console.log('THROWN:' + e.message); process.exit(0); });
      try { require('./server.js'); console.log('BOOTED'); process.exit(1); }
      catch (e) { console.log('THROWN:' + e.message); process.exit(0); }
    `], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' });
    if (r.status !== 0 && r.stdout.indexOf('BOOTED') === -1) {
      // Non-zero exit with no THROWN/BOOTED line is a real failure.
      return reject(new Error(`${label}: spawn failed: ${r.stderr}`));
    }
    const out = (r.stdout || '');
    const line = (out || '').split('\n').find((l) => l.startsWith('THROWN:'));
    assert.ok(
      line && line.includes('SESSION_SECRET'),
      `${label}: expected a SESSION_SECRET rejection, got:\n${out}`
    );
    resolve();
  });
}

async function runFailClosedChecks() {
  await assertRefusesToBoot(
    { SESSION_SECRET: null },
    'missing SESSION_SECRET refuses to boot'
  );
  await assertRefusesToBoot(
    { SESSION_SECRET: 'life-app-secret-change-me' },
    'placeholder "life-app-secret-change-me" refuses to boot'
  );
  await assertRefusesToBoot(
    { SESSION_SECRET: 'change-this-to-something-long-and-random' },
    'placeholder "change-this-to-something-long-and-random" refuses to boot'
  );
  await assertRefusesToBoot(
    { SESSION_SECRET: 'changeme' },
    'placeholder "changeme" refuses to boot'
  );
  await assertRefusesToBoot(
    { SESSION_SECRET: 'a'.repeat(31) },
    '31-char secret refuses to boot (too short)'
  );
}

async function runHappyPath() {
  // Boot the real server on an ephemeral port with a 64-char hex secret
  // and exercise /api/health + /api/login to verify the cookie flags.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-3200-'));
  const port = 3200;
  const realSecret = crypto.randomBytes(32).toString('hex');
  const adminPw = 'pha-3200-admin-pw';

  // Start server.js in a child so we get a clean module load (the
  // parent process has already required it via _test-bootstrap's
  // SECRET — we want a fresh one for the cookie flag check).
  const { spawn } = require('child_process');
  const serverProc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: adminPw,
      BRANDON_PASSWORD: adminPw,
      SESSION_SECRET: realSecret,
      NODE_ENV: 'production', // exercise the secure-cookie branch
      HOMESTEAD_INSECURE_TEST_COOKIES: '1', // allow http:// round-trip
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});

  const cleanup = () => {
    try { serverProc.kill('SIGTERM'); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  };

  try {
    // Wait for boot.
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 150));
    }

    // 1. /api/health reports sessionSecretReady=true and 200.
    const healthRes = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(healthRes.status, 200, 'health endpoint returns 200');
    const health = await healthRes.json();
    assert.equal(health.ok, true, 'health.ok');
    assert.equal(health.sessionSecretReady, true, 'sessionSecretReady=true on healthy boot');

    // 2. /api/login sets the session cookie with HttpOnly + SameSite=Lax.
    //    `Secure` is intentionally absent because the test harness runs
    //    over http://127.0.0.1 (HOMESTEAD_INSECURE_TEST_COOKIES=1). The
    //    same code path with NODE_ENV=production and no insecure flag
    //    emits `Secure; HttpOnly; SameSite=Lax` — covered by runSecureBranch.
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: adminPw }),
    });
    assert.equal(loginRes.status, 200, 'admin login succeeds');
    const setCookies = loginRes.headers.getSetCookie();
    assert.ok(setCookies.length >= 1, 'login sets at least one cookie');
    const sid = setCookies.find((c) => c.startsWith('connect.sid='));
    assert.ok(sid, 'cookie is named connect.sid (express-session default)');
    assert.ok(/HttpOnly/i.test(sid), 'cookie has HttpOnly flag');
    assert.ok(/SameSite=Lax/i.test(sid), 'cookie has SameSite=Lax flag');
    // 14 days = 1_209_600_000 ms. express-session emits `Expires=` in
    // GMT, not `Max-Age=`. Accept either form, but assert the parsed
    // expiry is within a 2-minute tolerance of (now + 14d).
    const expectedSec = 14 * 24 * 60 * 60;
    const maxAgeMatch = sid.match(/Max-Age=(\d+)/i);
    const expiresMatch = sid.match(/Expires=([^;]+)/i);
    let actualSec = null;
    if (maxAgeMatch) {
      actualSec = Number(maxAgeMatch[1]);
    } else if (expiresMatch) {
      const expiresAtMs = Date.parse(expiresMatch[1]);
      assert.ok(!Number.isNaN(expiresAtMs), 'cookie Expires parses as a date');
      const diffMs = expiresAtMs - Date.now();
      actualSec = Math.round(diffMs / 1000);
    } else {
      assert.fail('cookie has neither Max-Age nor Expires: ' + sid);
    }
    assert.ok(
      Math.abs(actualSec - expectedSec) < 120,
      `cookie lifetime is ~14d (${expectedSec}s), got ${actualSec}s (delta ${actualSec - expectedSec})`
    );

    // 3. Authenticated follow-up request works using the cookie.
    const cookieHeader = sid.split(';')[0];
    const meRes = await fetch(`http://127.0.0.1:${port}/api/version`, {
      headers: { Cookie: cookieHeader },
    });
    assert.equal(meRes.status, 200, 'authenticated /api/version returns 200');

    console.log('PHA-3200: happy-path cookie contract passes');
  } finally {
    cleanup();
  }
}

async function runSecureBranch() {
  // Boot with NODE_ENV=production AND without the insecure-test-cookies
  // opt-out, but over plain HTTP — assert the Set-Cookie line carries
  // `Secure`. We can't actually send the cookie back over http, so this
  // check stops at the Set-Cookie header.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'homestead-3200-secure-'));
  const port = 3201;
  const realSecret = crypto.randomBytes(32).toString('hex');
  const adminPw = 'pha-3200-secure-pw';

  const { spawn } = require('child_process');
  const env = { ...process.env };
  // Deliberately unset the bootstrap-injected insecure-cookie opt-out
  // so the production branch (Secure cookies) is exercised end-to-end.
  delete env.HOMESTEAD_INSECURE_TEST_COOKIES;
  const serverProc = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_PASSWORD: adminPw,
      BRANDON_PASSWORD: adminPw,
      SESSION_SECRET: realSecret,
      NODE_ENV: 'production',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', () => {});
  serverProc.stderr.on('data', () => {});

  try {
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) break;
      } catch (_) {}
      await new Promise((r) => setTimeout(r, 150));
    }

    const loginRes = await fetch(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      // SWAG sets X-Forwarded-Proto: https for every external request
      // hitting Homestead behind the reverse proxy. With trust proxy=1
      // and cookie.secure=true, Express only emits the Secure flag when
      // it believes the original request was HTTPS — so we forward the
      // same header in the test to mirror production.
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ username: 'admin', password: adminPw }),
    });
    assert.equal(loginRes.status, 200, 'login still returns 200 with Secure cookies');
    const setCookies = loginRes.headers.getSetCookie();
    const sid = setCookies.find((c) => c.startsWith('connect.sid='));
    assert.ok(sid, 'session cookie is set');
    assert.ok(/Secure/i.test(sid), 'production cookie carries Secure flag');
    assert.ok(/HttpOnly/i.test(sid), 'production cookie carries HttpOnly flag');
    assert.ok(/SameSite=Lax/i.test(sid), 'production cookie carries SameSite=Lax flag');

    console.log('PHA-3200: production-cookie Secure/HttpOnly/SameSite flags pass');
  } finally {
    try { serverProc.kill('SIGTERM'); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
  }
}

(async () => {
  await runFailClosedChecks();
  await runHappyPath();
  await runSecureBranch();
  console.log('PHA-3200: all session-secret checks pass');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
